/**
 * A read-only scan of a repository for the systems it is made of and how they
 * connect: deployables (code packages, compose services, Kubernetes workloads),
 * the data stores, caches, queues and external APIs they talk to, and entry
 * points (HTTP routes, message consumers, scheduled jobs).
 *
 * Sources: docker-compose files, Kubernetes manifests, .env / config files and
 * the code itself (client libraries, URLs, topics, routes). Configuration values
 * are reduced to scheme + host + port: credentials never leave this module.
 */
import * as fs from "fs";
import * as path from "path";
import { readFiles, slug, type FoundFile, loadYaml, loadYamlAll } from "../common";
import { hardcodedSecret, k8sObjectLine, keyLine, lineMatching, secretLine } from "./health";
import {
	type Address,
	imageBase,
	interpolate,
	isAddressKey,
	isLocalHost,
	isNoiseHost,
	isSecretKey,
	libraryTech,
	parseAddress,
	type ResourceKind,
	TECH,
	type Tech,
	techOf,
	techOfImage,
} from "./shared";

export interface Facet {
	/** "code", "compose", "k8s", "dockerfile". */
	source: string;
	label: string;
	file: string;
}

export interface EntryPoint {
	kind: "http" | "consumer" | "schedule" | "grpc" | "cli";
	/** "GET /orders/{id}", "orders.created", "0 3 * * *". */
	label: string;
	file: string;
	line: number;
	framework?: string;
}

export interface ScanService {
	id: string;
	name: string;
	aliases: Set<string>;
	/** Package folder (relative), when the service has code in the repository. */
	dir?: string;
	runtime?: string;
	facets: Facet[];
	images: Set<string>;
	/** Published ports (compose host ports, k8s Service ports). */
	ports: Set<number>;
	/** Environment variables it reads in code or gets in its deployment (names only). */
	envKeys: Set<string>;
	entries: EntryPoint[];
	/** A Dockerfile, compose service or k8s workload: something that runs. */
	deployed: boolean;
	/** Files it comes from (manifests, Dockerfiles, deployment files, code with connections or entry points). */
	files: Set<string>;
	/** Infra deployables that are really resources (compose db...) never become services. */
}

export interface ScanResource {
	id: string;
	name: string;
	kind: ResourceKind;
	tech?: Tech;
	aliases: Set<string>;
	/** host:port when known (never credentials). */
	address?: string;
	database?: string;
	/** Topics and queues sit inside their broker. */
	parent?: string;
	evidence: string[];
	/** Declared in compose / k8s (as opposed to inferred from code or config). */
	declared: boolean;
	/** Files that declare it or connect to it. */
	files: Set<string>;
}

export interface ScanLink {
	from: string;
	to: string;
	protocol?: string;
	port?: number;
	/** How it was found: "env DATABASE_URL", "imports pg", "depends_on", "publishes"... */
	how: Set<string>;
	evidence: Set<string>;
	/** "sync" for calls, "async" for publish / consume, "weak" for start-up ordering only. */
	style: "sync" | "async" | "weak";
	verb?: string;
}

export interface Ingress {
	id: string;
	label: string;
	file: string;
	routes: { path: string; service: string; port?: string }[];
}

export interface SystemScan {
	root: string;
	name: string;
	services: ScanService[];
	resources: ScanResource[];
	links: ScanLink[];
	ingresses: Ingress[];
	/** Services reachable from outside (published ports, ingress, gateways). */
	exposed: Map<string, string>;
	warnings: string[];
	stats: { files: number; codeFiles: number; composeFiles: number; k8sObjects: number; envFiles: number; configFiles: number; ms: number };
	/** Env keys that hold secrets (names only), for the agent to know they exist. */
	secretKeys: Set<string>;
	/** Packages in the repository that did not turn out to be services. */
	libraries: string[];
	/** Raw material of the health findings (see health.ts). */
	health: ScanHealth;
}

/** What the health checks need from the scan: locations and setting names, never values. */
export interface ScanHealth {
	credentials: { owner: string; file: string; line?: number; key: string; hint: string; what: "value" | "url-password"; source: "compose" | "k8s" | "config" }[];
	settingsScanned: number;
	plaintext: { owner: string; target: string; host: string; evidence: string }[];
	externalScanned: number;
	noHealthcheck: { owner: string; file: string; line?: number; name: string; source: "compose" | "k8s"; awaitedBy?: string }[];
	healthScanned: number;
	privileged: { owner: string; file: string; line?: number; name: string; what: string[] }[];
	containersScanned: number;
	/** Service id → where its code or manifest shows authentication. */
	auth: Map<string, string>;
}

/** Signs that a service authenticates requests (middleware, decorators, guards, libraries). Deliberately broad. */
const AUTH_HINT = /auth(?!or)|jwt|passport|login_required|permission_classes|PreAuthorize|@Secured|RolesAllowed|bearer|api[_-]?key|getServerSession|clerk|cognito|keycloak|firebase-admin|verifyIdToken|basicauth|oauth|oidc/i;

/** The file part of an evidence string ("a/b.ts:12", "compose.yml (svc: KEY)"). */
const fileOfEvidence = (evidence: string) => evidence.replace(/ \(.*$/s, "").replace(/:\d+$/, "");

const CODE_RE = /\.(tsx?|jsx?|mjs|cjs|py|go|java|kt|cs|rb|php|rs|scala)$/i;
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|Pipfile|go\.mod|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|Gemfile|Cargo\.toml|composer\.json)$/;
const COMPOSE_RE = /(^|\/)(docker-)?compose(\.[\w-]+)*\.ya?ml$/i;
const ENV_RE = /(^|\/)\.env(\.[\w-]+)*$|(^|\/)[\w-]+\.env$/i;
const CONFIG_RE = /(^|\/)((application|bootstrap)[\w.-]*\.(ya?ml|properties)|appsettings[\w.-]*\.json|local\.settings\.json|database\.ya?ml|(config|settings)\/[\w.-]+\.(ya?ml|json|toml)|config\.(ya?ml|json|toml)|settings\.(ya?ml|json|toml))$/i;
const DOCKERFILE_RE = /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.dockerfile$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|__mocks__|testdata|examples?|samples?|docs?)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const VENDOR_RE = /(^|\/)(vendor|third_party|thirdparty|external|deps|bower_components|jspm_packages|\.yarn)(\/|$)|\.min\.js$|\.bundle\.js$|-bundle\.js$/i;

const RUNTIME: [RegExp, string][] = [
	[/package\.json$/, "Node.js"],
	[/pyproject\.toml$|requirements[\w.-]*\.txt$|setup\.py$|Pipfile$/, "Python"],
	[/go\.mod$/, "Go"],
	[/pom\.xml$|build\.gradle(\.kts)?$/, "JVM"],
	[/\.csproj$/, ".NET"],
	[/Gemfile$/, "Ruby"],
	[/Cargo\.toml$/, "Rust"],
	[/composer\.json$/, "PHP"],
];

const norm = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const lineAt = (text: string, index: number) => {
	let n = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
};
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ScanOptions {
	includeTests?: boolean;
	maxCodeFiles?: number;
	progress?: (text: string) => void;
	/** Called with every code file read (e.g. to search it for the data-flow focus). */
	visit?: (file: FoundFile) => void;
}

/** Candidate connection found in configuration: owner → value of key. */
interface Candidate {
	owner: string;
	key: string;
	value: string;
	evidence: string;
	env: (name: string) => string | undefined;
}

export function scanSystem(root: string, options: ScanOptions = {}): SystemScan {
	const started = Date.now();
	const progress = options.progress ?? (() => undefined);
	const name = path.basename(root);
	const warnings: string[] = [];
	const maxCode = options.maxCodeFiles ?? 4000;
	let codeCount = 0;
	let codeSkipped = 0;
	progress("Reading the repository…");
	const files = readFiles(root, {
		maxFiles: 12000,
		maxBytes: 600_000,
		// (`bin` is build output nearly everywhere; below a Rust crate's `src` it is its other programs)
		keepDir: (rel) => /(^|\/)src\/bin$/.test(rel),
		match: (rel) => {
			if (VENDOR_RE.test(rel) || (!options.includeTests && TEST_RE.test(rel))) return false;
			if (/(^|\/)\.git$/.test(rel)) return rel !== ".git"; // a submodule: its own package
			if (MANIFEST_RE.test(rel) || COMPOSE_RE.test(rel) || ENV_RE.test(rel) || CONFIG_RE.test(rel) || DOCKERFILE_RE.test(rel)) return true;
			if (/\.ya?ml$/i.test(rel)) return !rel.startsWith(".github/");
			if (CODE_RE.test(rel) && !/\.d\.ts$/.test(rel)) {
				if (codeCount >= maxCode) {
					codeSkipped++;
					return false;
				}
				codeCount++;
				return true;
			}
			return false;
		},
	});
	if (codeSkipped) warnings.push(`Only the first ${maxCode} code files were read (${codeSkipped} more skipped); map a sub-folder for full detail.`);
	// (hidden folders are skipped, rightly: but where a repository's work goes on in working copies kept in one, say that they are there)
	const copies = hiddenCheckouts(root);
	if (copies) warnings.push(`${copies.names.length} working cop${copies.names.length === 1 ? "y" : "ies"} of this repository in ${copies.folder} ${copies.names.length === 1 ? "was" : "were"} not read, as hidden folders are skipped (${copies.names.slice(0, 3).join(", ")}${copies.names.length > 3 ? ", …" : ""}). To map one, choose it as the folder.`);

	const services = new Map<string, ScanService>();
	const resources = new Map<string, ScanResource>();
	const links = new Map<string, ScanLink>();
	const ingresses: Ingress[] = [];
	const exposed = new Map<string, string>();
	const secretKeys = new Set<string>();
	const candidates: Candidate[] = [];
	/** alias → service or resource id. */
	const aliasOf = new Map<string, string>();
	/** Published host port → service id (for localhost:PORT addresses). */
	const portOwner = new Map<number, string>();
	const health: ScanHealth = { credentials: [], settingsScanned: 0, plaintext: [], externalScanned: 0, noHealthcheck: [], healthScanned: 0, privileged: [], containersScanned: 0, auth: new Map() };
	const externalSeen = new Set<string>();
	/** Units whose Dockerfile declares a HEALTHCHECK. */
	const dockerHealth = new Set<string>();
	const filesOf = (id: string) => services.get(id)?.files ?? resources.get(id)?.files;

	const addAlias = (id: string, alias: string | undefined) => {
		if (!alias) return;
		const a = norm(alias);
		if (!a || aliasOf.has(a)) return;
		aliasOf.set(a, id);
		(services.get(id)?.aliases ?? resources.get(id)?.aliases)?.add(a);
	};
	const findAlias = (...names: (string | undefined)[]) => {
		for (const n of names) {
			const id = n ? aliasOf.get(norm(n)) : undefined;
			if (id) return id;
		}
		return undefined;
	};

	// ----- packages (code units): folders with a manifest or a Dockerfile -----
	const units = new Map<string, ScanService>();
	const manifestLibs: { owner: string; tech: Tech; how: string; evidence: string }[] = [];
	const SUBMODULE_RE = /(^|\/)\.git$/;
	const unitFiles = files.filter((x) => MANIFEST_RE.test(x.rel) || DOCKERFILE_RE.test(x.rel) || SUBMODULE_RE.test(x.rel));
	unitFiles.sort((a, b) => Number(!MANIFEST_RE.test(a.rel)) - Number(!MANIFEST_RE.test(b.rel)));
	for (const f of unitFiles) {
		if ((DOCKERFILE_RE.test(f.rel) || SUBMODULE_RE.test(f.rel)) && units.has(dirOf(f.rel))) continue;
		const dir = dirOf(f.rel);
		const marker = DOCKERFILE_RE.test(f.rel) || SUBMODULE_RE.test(f.rel);
		const runtime = marker ? undefined : RUNTIME.find(([re]) => re.test(f.rel))?.[1];
		let unitName = dir ? dir.split("/").pop()! : name;
		try {
			if (f.rel.endsWith("package.json")) unitName = JSON.parse(f.text).name || unitName;
			else if (f.rel.endsWith("pyproject.toml")) unitName = /^\s*name\s*=\s*["']([^"']+)/m.exec(f.text)?.[1] ?? unitName;
			else if (f.rel.endsWith("go.mod")) unitName = /^module\s+(\S+)/m.exec(f.text)?.[1].split("/").pop() ?? unitName;
			else if (f.rel.endsWith("pom.xml")) unitName = /<artifactId>([^<]+)<\/artifactId>/.exec(f.text.replace(/<parent>[\s\S]*?<\/parent>/, ""))?.[1] ?? unitName;
			else if (f.rel.endsWith(".csproj")) unitName = f.rel.split("/").pop()!.replace(/\.csproj$/, "");
		} catch {
			// keep the folder name
		}
		const existing = units.get(dir);
		if (existing) {
			if (!SUBMODULE_RE.test(f.rel)) existing.files.add(f.rel);
			if (!existing.runtime && runtime) existing.runtime = runtime;
			if (existing.facets[0]?.source === "code" && runtime) existing.facets[0].label = `${dir || "."} (${existing.runtime})`;
			collectLibs(existing.id, f);
			continue;
		}
		const id = `svc:${slug(norm(unitName) || norm(dir) || "app")}`;
		const unit: ScanService = {
			id: services.has(id) ? `svc:${slug(dir || name)}` : id,
			name: unitName.replace(/^@[^/]+\//, ""),
			aliases: new Set(),
			dir,
			runtime,
			facets: DOCKERFILE_RE.test(f.rel) ? [] : [{ source: "code", label: `${dir || "."} (${runtime ?? (SUBMODULE_RE.test(f.rel) ? "submodule" : "code")})`, file: f.rel }],
			images: new Set(),
			ports: new Set(),
			envKeys: new Set(),
			entries: [],
			deployed: false,
			files: new Set(SUBMODULE_RE.test(f.rel) ? [] : [f.rel]),
		};
		units.set(dir, unit);
		services.set(unit.id, unit);
		addAlias(unit.id, unit.name);
		if (dir) addAlias(unit.id, dir.split("/").pop());
		collectLibs(unit.id, f);
	}
	function collectLibs(owner: string, f: FoundFile) {
		// Dependencies declared in the manifest.
		for (const dep of manifestDependencies(f)) {
			const hit = libraryTech(dep);
			if (hit) manifestLibs.push({ owner, tech: hit.tech, how: `depends on ${hit.name}`, evidence: f.rel });
			if (!health.auth.has(owner) && AUTH_HINT.test(dep)) health.auth.set(owner, `${f.rel} (depends on ${dep})`);
		}
	}
	const unitFor = (rel: string): ScanService | undefined => {
		for (let d = dirOf(rel); ; d = dirOf(d)) {
			const u = units.get(d);
			if (u) return u;
			if (!d) return undefined;
		}
	};
	const rootUnit = (): ScanService => {
		let u = units.get("");
		if (!u) {
			u = { id: `svc:${slug(norm(name) || "app")}`, name, aliases: new Set(), dir: "", facets: [], images: new Set(), ports: new Set(), envKeys: new Set(), entries: [], deployed: false, files: new Set() };
			units.set("", u);
			services.set(u.id, u);
			addAlias(u.id, name);
		}
		return u;
	};

	// Dockerfiles mark their package as deployed.
	for (const f of files.filter((x) => DOCKERFILE_RE.test(x.rel))) {
		const unit = units.get(dirOf(f.rel));
		if (!unit) continue;
		unit.deployed = true;
		unit.files.add(f.rel);
		if (/^\s*HEALTHCHECK\s+(?!NONE\b)/im.test(f.text)) dockerHealth.add(unit.id);
		const exposedPorts = [...f.text.matchAll(/^\s*EXPOSE\s+([\d\s/a-z]+)/gim)].flatMap((m) => m[1].split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => p > 0));
		unit.facets.push({ source: "dockerfile", label: `Dockerfile${exposedPorts.length ? ` :${exposedPorts.join(",")}` : ""}`, file: f.rel });
	}

	const newService = (svcName: string, facet: Facet): ScanService => {
		let id = `svc:${slug(norm(svcName) || "service")}`;
		for (let i = 2; services.has(id) || resources.has(id); i++) id = `svc:${slug(norm(svcName))}-${i}`;
		const s: ScanService = { id, name: svcName, aliases: new Set(), facets: [facet], images: new Set(), ports: new Set(), envKeys: new Set(), entries: [], deployed: true, files: new Set([facet.file]) };
		services.set(id, s);
		addAlias(id, svcName);
		return s;
	};
	const newResource = (key: string, label: string, tech: Tech | undefined, kind: ResourceKind, declared: boolean, evidence: string): ScanResource => {
		const id = `res:${slug(key)}`;
		let r = resources.get(id);
		if (!r) {
			r = { id, name: label, kind, tech, aliases: new Set(), evidence: [], declared, files: new Set() };
			resources.set(id, r);
		}
		if (declared) r.declared = true;
		r.files.add(fileOfEvidence(evidence));
		if (!r.evidence.includes(evidence) && r.evidence.length < 8) r.evidence.push(evidence);
		return r;
	};
	const link = (from: string, to: string, how: string, evidence: string, extra: Partial<Pick<ScanLink, "protocol" | "port" | "style" | "verb">> = {}) => {
		if (from === to) return;
		const key = `${from}\u0000${to}`;
		let l = links.get(key);
		if (!l) {
			l = { from, to, how: new Set(), evidence: new Set(), style: extra.style ?? "sync" };
			links.set(key, l);
		}
		l.how.add(how);
		if (l.evidence.size < 6) l.evidence.add(evidence);
		const file = fileOfEvidence(evidence);
		filesOf(from)?.add(file);
		filesOf(to)?.add(file);
		if (extra.protocol && !l.protocol) l.protocol = extra.protocol;
		if (extra.port && !l.port) l.port = extra.port;
		if (extra.verb && !l.verb) l.verb = extra.verb;
		// Real traffic beats start-up ordering.
		if (l.style === "weak" && extra.style !== "weak") l.style = extra.style ?? "sync";
	};

	// ----- docker compose -----
	const composeFiles = files.filter((f) => COMPOSE_RE.test(f.rel));
	const composeDeps: { from: string; dep: string; file: string }[] = [];
	for (const f of composeFiles) {
		let doc: any;
		try {
			doc = loadYaml(f.text);
		} catch (e: any) {
			warnings.push(`${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`);
			continue;
		}
		if (!doc?.services || typeof doc.services !== "object") continue;
		const base = dirOf(f.rel);
		const fileEnv = new Map<string, string>();
		// Compose reads .env next to the file for ${VAR} interpolation.
		for (const envFile of files.filter((x) => dirOf(x.rel) === base && /(^|\/)\.env$/.test(x.rel))) for (const [k, v] of parseEnvFile(envFile.text)) fileEnv.set(k, v);
		const servicesLine = lineMatching(f.text, /^services:\s*(#.*)?$/) ?? 1;
		// Services others wait for with `condition: service_healthy`.
		const awaited = new Map<string, string>();
		for (const [svcName, svc] of Object.entries<any>(doc.services)) {
			const deps = svc?.depends_on;
			if (deps && typeof deps === "object" && !Array.isArray(deps)) for (const [d, cfg] of Object.entries<any>(deps)) if (cfg?.condition === "service_healthy" && !awaited.has(d)) awaited.set(d, svcName);
		}
		for (const [svcName, svc] of Object.entries<any>(doc.services)) {
			const s = svc ?? {};
			const image = typeof s.image === "string" ? s.image : "";
			const tech = image ? techOfImage(image) : undefined;
			const buildCtx = typeof s.build === "string" ? s.build : s.build?.context;
			const svcLine = lineMatching(f.text, new RegExp(`^\\s+["']?${reEsc(svcName)}["']?:\\s*(#.*)?$`), servicesLine);
			const ports = (Array.isArray(s.ports) ? s.ports : []).map(composePort).filter(Boolean) as { published?: number; target?: number }[];
			const evidence = `${f.rel} (${svcName})`;
			const portText = ports.map((p) => (p.published ? `${p.published}→${p.target ?? p.published}` : `${p.target}`)).join(", ");
			let ownerId: string;
			if (tech && !buildCtx) {
				const r = newResource(`compose:${svcName}`, svcName, tech, tech.kind, true, evidence);
				r.files.add(f.rel);
				r.address = `${svcName}${tech.port ? `:${tech.port}` : ""}`;
				addAlias(r.id, svcName);
				addAlias(r.id, s.container_name);
				addAlias(r.id, s.hostname);
				ownerId = r.id;
				if (tech.kind === "gateway") ports.forEach((p) => p.published && exposed.set(r.id, `:${p.published}`));
			} else {
				const unit = buildCtx ? units.get(path.posix.normalize(path.posix.join(base, buildCtx)).replace(/^\.\/?|\/$/g, "").replace(/^\.$/, "")) : undefined;
				const facet: Facet = { source: "compose", label: `compose ${svcName}${portText ? ` :${portText}` : ""}`, file: f.rel };
				const known = findAlias(svcName, s.container_name);
				const s2 = unit ?? (known ? services.get(known) : undefined) ?? newService(svcName, facet);
				if (s2.facets[0] !== facet) s2.facets.push(facet);
				s2.deployed = true;
				s2.files.add(f.rel);
				addAlias(s2.id, svcName);
				addAlias(s2.id, s.container_name);
				addAlias(s2.id, s.hostname);
				if (image) {
					s2.images.add(image);
					addAlias(s2.id, imageBase(image));
				}
				for (const p of ports) {
					if (p.published) {
						s2.ports.add(p.published);
						portOwner.set(p.published, s2.id);
						exposed.set(s2.id, `:${p.published}`);
					}
				}
				ownerId = s2.id;
			}
			// Health: host access, health checks, literal credentials.
			health.containersScanned++;
			const host: string[] = [];
			if (s.privileged === true) host.push("privileged: true");
			if (s.network_mode === "host") host.push("network_mode: host");
			if (s.pid === "host") host.push("pid: host");
			for (const cap of [].concat(s.cap_add ?? []).map(String)) if (/^(CAP_)?(ALL|SYS_ADMIN)$/i.test(cap)) host.push(`cap_add: ${cap}`);
			if ([].concat(s.volumes ?? []).some((v: any) => /\/var\/run\/docker\.sock|\/run\/docker\.sock/.test(typeof v === "string" ? v : String(v?.source ?? "")))) host.push("the Docker socket mounted");
			if (host.length) {
				const firstKey = s.privileged === true ? "privileged" : s.network_mode === "host" ? "network_mode" : s.pid === "host" ? "pid" : host[0].startsWith("cap_add") ? "cap_add" : "volumes";
				health.privileged.push({ owner: ownerId, file: f.rel, line: keyLine(f.text, firstKey, svcLine) ?? svcLine, name: svcName, what: host });
			}
			const isApp = !resources.has(ownerId);
			if (isApp || awaited.has(svcName)) {
				health.healthScanned++;
				const inImage = dockerHealth.has(ownerId);
				const checked = (s.healthcheck && !s.healthcheck.disable && s.healthcheck.test !== "NONE") || inImage;
				if (!checked) health.noHealthcheck.push({ owner: ownerId, file: f.rel, line: svcLine, name: svcName, source: "compose", awaitedBy: awaited.get(svcName) });
			}
			for (const [k, v] of envEntries(s.environment)) {
				health.settingsScanned++;
				const secret = hardcodedSecret(k, v);
				if (secret) health.credentials.push({ owner: ownerId, file: f.rel, line: secretLine(f.text, secret.needle, k, svcLine), key: k, hint: secret.hint, what: secret.what, source: "compose" });
			}
			const deps = Array.isArray(s.depends_on) ? s.depends_on : s.depends_on && typeof s.depends_on === "object" ? Object.keys(s.depends_on) : [];
			for (const d of [...deps, ...(Array.isArray(s.links) ? s.links.map((l: string) => String(l).split(":")[0]) : [])]) composeDeps.push({ from: ownerId, dep: String(d), file: f.rel });
			const env = new Map<string, string>();
			for (const envFile of [].concat(s.env_file ?? []).map((e: any) => (typeof e === "string" ? e : e?.path)).filter(Boolean)) {
				const rel = path.posix.normalize(path.posix.join(base, envFile));
				const found = files.find((x) => x.rel === rel);
				const text = found?.text ?? readInside(root, rel);
				if (text !== undefined) for (const [k, v] of parseEnvFile(text)) env.set(k, v);
			}
			for (const [k, v] of envEntries(s.environment)) env.set(k, v);
			const lookup = (n: string) => env.get(n) ?? fileEnv.get(n);
			for (const [k, v] of env) {
				services.get(ownerId)?.envKeys.add(k);
				candidates.push({ owner: ownerId, key: k, value: v, evidence: `${f.rel} (${svcName}: ${k})`, env: lookup });
			}
		}
	}

	// ----- Kubernetes manifests -----
	let k8sObjects = 0;
	const chartDirs = new Set(files.filter((f) => /(^|\/)Chart\.ya?ml$/.test(f.rel)).map((f) => dirOf(f.rel)));
	const helmSkipped = new Set<string>();
	const k8sDocs: { doc: any; file: string }[] = [];
	for (const f of files.filter((x) => /\.ya?ml$/i.test(x.rel) && !COMPOSE_RE.test(x.rel) && !CONFIG_RE.test(x.rel))) {
		if (!/^\s*kind:\s*\w/m.test(f.text) || !/^\s*apiVersion:/m.test(f.text)) continue;
		const chart = [...chartDirs].find((d) => f.rel.startsWith(d ? `${d}/templates/` : "templates/"));
		if (chart !== undefined || /\{\{/.test(f.text)) {
			helmSkipped.add(chart ?? dirOf(f.rel));
			continue;
		}
		try {
			for (const d of loadYamlAll(f.text)) {
				if (!d || typeof d !== "object") continue;
				const items = (d as any).kind === "List" && Array.isArray((d as any).items) ? (d as any).items : [d];
				for (const it of items) if (it?.kind && it?.metadata?.name) k8sDocs.push({ doc: it, file: f.rel });
			}
		} catch (e: any) {
			warnings.push(`${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`);
		}
	}
	if (helmSkipped.size) warnings.push(`Helm templates were not read (${[...helmSkipped].map((d) => d || ".").join(", ")}): render them with \`helm template\` into a folder to map them.`);
	k8sObjects = k8sDocs.length;
	const nsOf = (d: any) => d.metadata.namespace ?? "default";
	const configMaps = new Map<string, Record<string, string>>();
	for (const { doc } of k8sDocs) if (doc.kind === "ConfigMap") configMaps.set(`${nsOf(doc)}/${doc.metadata.name}`, Object.fromEntries(Object.entries(doc.data ?? {}).map(([k, v]) => [k, String(v)])));
	const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet", "Rollout", "DeploymentConfig"]);
	const LONG_RUNNING = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Rollout", "DeploymentConfig"]);
	const textOf = new Map(files.filter((x) => /\.ya?ml$/i.test(x.rel)).map((x) => [x.rel, x.text]));
	const workloadOwner = new Map<string, string>();
	const podLabels = new Map<string, Record<string, string>>();
	for (const { doc, file } of k8sDocs.filter((x) => WORKLOADS.has(x.doc.kind))) {
		const spec = doc.spec?.template?.spec ?? doc.spec?.jobTemplate?.spec?.template?.spec ?? (doc.kind === "Pod" ? doc.spec : undefined);
		if (!spec) continue;
		const containers: any[] = [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
		const images = containers.map((c) => String(c.image ?? "")).filter(Boolean);
		const tech = images.map(techOfImage).find(Boolean);
		const wName = doc.metadata.name;
		const evidence = `${file} (${doc.kind} ${wName})`;
		const replicas = doc.spec?.replicas;
		let ownerId: string;
		if (tech && (spec.containers ?? []).length === 1) {
			const r = newResource(`k8s:${nsOf(doc)}/${wName}`, wName, tech, tech.kind, true, evidence);
			const existing = findAlias(wName);
			if (existing && resources.has(existing) && existing !== r.id) {
				resources.delete(r.id);
				ownerId = existing;
			} else {
				addAlias(r.id, wName);
				r.address = `${wName}${tech.port ? `:${tech.port}` : ""}`;
				ownerId = r.id;
			}
		} else {
			const facet: Facet = { source: "k8s", label: `${doc.kind} ${wName}${replicas != null ? ` ×${replicas}` : ""}${doc.kind === "CronJob" && doc.spec?.schedule ? ` (${doc.spec.schedule})` : ""}`, file };
			const existingId = findAlias(wName, ...images.map(imageBase));
			const s = (existingId && services.get(existingId)) || newService(wName, facet);
			if (s.facets[0] !== facet) s.facets.push(facet);
			s.deployed = true;
			addAlias(s.id, wName);
			images.forEach((i) => {
				s.images.add(i);
				addAlias(s.id, imageBase(i));
			});
			if (doc.kind === "CronJob" && doc.spec?.schedule) s.entries.push({ kind: "schedule", label: `${doc.spec.schedule} (CronJob ${wName})`, file, line: 1, framework: "Kubernetes CronJob" });
			ownerId = s.id;
		}
		workloadOwner.set(`${nsOf(doc)}/${doc.kind}/${wName}`, ownerId);
		filesOf(ownerId)?.add(file);
		// Health: host access, readiness probes, literal credentials.
		const text = textOf.get(file) ?? "";
		const docLine = k8sObjectLine(text, doc.kind, wName);
		health.containersScanned += containers.length;
		const host: string[] = [];
		if (spec.hostNetwork === true) host.push("hostNetwork: true");
		if (spec.hostPID === true) host.push("hostPID: true");
		if (spec.hostIPC === true) host.push("hostIPC: true");
		for (const c of containers) {
			if (c?.securityContext?.privileged === true) host.push(`privileged: true (container ${c.name ?? "?"})`);
			for (const cap of [].concat(c?.securityContext?.capabilities?.add ?? []).map(String)) if (/^(CAP_)?(ALL|SYS_ADMIN)$/i.test(cap)) host.push(`capabilities.add: ${cap} (container ${c.name ?? "?"})`);
		}
		if ((spec.volumes ?? []).some((v: any) => /docker\.sock$/.test(String(v?.hostPath?.path ?? "")))) host.push("the Docker socket mounted (hostPath)");
		if (host.length) {
			const firstKey = spec.hostNetwork === true ? "hostNetwork" : spec.hostPID === true ? "hostPID" : spec.hostIPC === true ? "hostIPC" : /^privileged/.test(host[0]) ? "privileged" : /^capabilities/.test(host[0]) ? "add" : "path";
			health.privileged.push({ owner: ownerId, file, line: keyLine(text, firstKey, docLine ?? 1) ?? docLine, name: wName, what: host });
		}
		if (LONG_RUNNING.has(doc.kind)) {
			health.healthScanned++;
			if (!(spec.containers ?? []).some((c: any) => c?.readinessProbe)) health.noHealthcheck.push({ owner: ownerId, file, line: docLine, name: wName, source: "k8s" });
		}
		for (const c of containers) {
			for (const e of c.env ?? []) {
				if (!e?.name || typeof e.value !== "string") continue;
				health.settingsScanned++;
				const secret = hardcodedSecret(e.name, e.value);
				if (secret) health.credentials.push({ owner: ownerId, file, line: secretLine(text, secret.needle, e.name, docLine ?? 1), key: e.name, hint: secret.hint, what: secret.what, source: "k8s" });
			}
		}
		podLabels.set(`${nsOf(doc)}/${doc.kind}/${wName}`, doc.spec?.template?.metadata?.labels ?? (doc.kind === "Pod" ? doc.metadata.labels ?? {} : {}));
		for (const c of containers) {
			const env = new Map<string, string>();
			for (const ef of c.envFrom ?? []) {
				if (ef.configMapRef?.name) for (const [k, v] of Object.entries(configMaps.get(`${nsOf(doc)}/${ef.configMapRef.name}`) ?? {})) env.set(`${ef.prefix ?? ""}${k}`, v);
				if (ef.secretRef?.name) secretKeys.add(`secret ${ef.secretRef.name}`);
			}
			for (const e of c.env ?? []) {
				if (!e?.name) continue;
				services.get(ownerId)?.envKeys.add(e.name);
				if (typeof e.value === "string") env.set(e.name, e.value);
				else if (e.valueFrom?.configMapKeyRef) {
					const v = configMaps.get(`${nsOf(doc)}/${e.valueFrom.configMapKeyRef.name}`)?.[e.valueFrom.configMapKeyRef.key];
					if (v !== undefined) env.set(e.name, v);
				} else if (e.valueFrom?.secretKeyRef) secretKeys.add(e.name);
			}
			const lookup = (n: string) => env.get(n);
			for (const [k, v] of env) {
				services.get(ownerId)?.envKeys.add(k);
				candidates.push({ owner: ownerId, key: k, value: v, evidence: `${file} (${wName}: ${k})`, env: lookup });
			}
		}
	}
	// Services name the workloads they select (their DNS names are hosts other services use).
	const k8sServiceTarget = new Map<string, string>();
	for (const { doc, file } of k8sDocs.filter((x) => x.doc.kind === "Service")) {
		const sel = doc.spec?.selector;
		let target: string | undefined;
		if (sel && typeof sel === "object") {
			for (const [key, labels] of podLabels) {
				if (!key.startsWith(`${nsOf(doc)}/`)) continue;
				if (Object.entries<string>(sel).every(([k, v]) => labels[k] === v)) {
					target = workloadOwner.get(key);
					break;
				}
			}
		}
		target ??= findAlias(doc.metadata.name);
		if (!target) continue;
		filesOf(target)?.add(file);
		k8sServiceTarget.set(`${nsOf(doc)}/${doc.metadata.name}`, target);
		addAlias(target, doc.metadata.name);
		const ports = (doc.spec?.ports ?? []).map((p: any) => Number(p.port)).filter((p: number) => p > 0);
		const svc = services.get(target);
		if (svc) {
			ports.forEach((p: number) => svc.ports.add(p));
			if (/LoadBalancer|NodePort/.test(doc.spec?.type ?? "")) exposed.set(target, `${doc.spec.type}`);
		}
	}
	for (const { doc, file } of k8sDocs.filter((x) => x.doc.kind === "Ingress" || x.doc.kind === "HTTPRoute" || x.doc.kind === "IngressRoute")) {
		const routes: Ingress["routes"] = [];
		const hosts = new Set<string>();
		const add = (b: any, p: string) => {
			const svcName = b?.service?.name ?? b?.serviceName ?? b?.name;
			const target = svcName ? k8sServiceTarget.get(`${nsOf(doc)}/${svcName}`) ?? findAlias(svcName) : undefined;
			if (target) routes.push({ path: p, service: target, port: String(b?.service?.port?.number ?? b?.service?.port?.name ?? b?.servicePort ?? b?.port ?? "") || undefined });
		};
		if (doc.kind === "Ingress") {
			add(doc.spec?.defaultBackend ?? doc.spec?.backend, "/*");
			for (const r of doc.spec?.rules ?? []) {
				if (r.host) hosts.add(r.host);
				for (const p of r.http?.paths ?? []) add(p.backend, `${r.host && (doc.spec.rules.length > 1) ? r.host : ""}${p.path ?? "/"}`);
			}
		} else if (doc.kind === "HTTPRoute") {
			(doc.spec?.hostnames ?? []).forEach((h: string) => hosts.add(h));
			for (const r of doc.spec?.rules ?? []) for (const b of r.backendRefs ?? []) add(b, r.matches?.[0]?.path?.value ?? "/");
		}
		if (!routes.length) continue;
		ingresses.push({ id: `ing:${slug(`${nsOf(doc)}/${doc.metadata.name}`)}`, label: `${doc.kind} ${doc.metadata.name}${hosts.size ? `\n${[...hosts].slice(0, 3).join(", ")}` : ""}`, file, routes });
		routes.forEach((r) => exposed.set(r.service, `ingress ${r.path}`));
	}

	// ----- .env and config files -----
	const envFiles = files.filter((f) => ENV_RE.test(f.rel) && !COMPOSE_RE.test(f.rel));
	const configFiles = files.filter((f) => CONFIG_RE.test(f.rel));
	type Cred = { line?: number; hint: string; what: "value" | "url-password" };
	const rootLevel: { key: string; value: string; evidence: string; env: (n: string) => string | undefined; file: string; cred?: Cred }[] = [];
	for (const f of [...envFiles, ...configFiles]) {
		const isEnv = ENV_RE.test(f.rel);
		const entries = isEnv ? [...parseEnvFile(f.text)] : configEntries(f);
		const map = new Map(entries);
		const lookup = (n: string) => map.get(n);
		const unit = unitFor(f.rel);
		if (unit && unit.dir !== "") unit.files.add(f.rel);
		for (const [k, v] of entries) {
			// Config files are committed; .env files are where local secrets belong (not checked).
			let cred: Cred | undefined;
			if (!isEnv) {
				health.settingsScanned++;
				const secret = hardcodedSecret(k, v);
				if (secret) cred = { line: secretLine(f.text, secret.needle, k), hint: secret.hint, what: secret.what };
			}
			if (unit && unit.dir !== "") {
				candidates.push({ owner: unit.id, key: k, value: v, evidence: `${f.rel} (${k})`, env: lookup });
				if (cred) health.credentials.push({ owner: unit.id, file: f.rel, key: k, ...cred, source: "config" });
			} else rootLevel.push({ key: k, value: v, evidence: `${f.rel} (${k})`, env: lookup, file: f.rel, cred });
		}
	}

	// ----- code -----
	progress("Reading the code…");
	const code = files.filter((f) => CODE_RE.test(f.rel) && !/\.d\.ts$/.test(f.rel));
	const codeLinkKeys = new Set<string>();
	const codeLinks: { owner: string; tech: Tech; how: string; evidence: string }[] = [];
	const addCodeLink = (c: { owner: string; tech: Tech; how: string; evidence: string }) => {
		const k = `${c.owner}|${c.tech.id}|${c.how}`;
		if (codeLinkKeys.has(k)) return;
		codeLinkKeys.add(k);
		codeLinks.push(c);
	};
	manifestLibs.forEach(addCodeLink);
	const urlUses: { owner: string; url: string; evidence: string }[] = [];
	const messaging: { owner: string; tech?: Tech; name: string; dir: "publishes" | "consumes"; evidence: string }[] = [];
	for (const f of code) {
		const unit = unitFor(f.rel) ?? rootUnit();
		const lang = langOf(f.rel);
		options.visit?.(f);
		const text = stripComments(f.text, lang);
		const lines = lineIndex(text);
		if (!health.auth.has(unit.id)) {
			const m = AUTH_HINT.exec(text);
			if (m) health.auth.set(unit.id, `${f.rel}:${lines(m.index ?? 0)} (${m[0]})`);
		}
		const before = unit.entries.length;
		for (const imp of importsOf(text, lang)) {
			const hit = libraryTech(imp.name);
			if (hit) addCodeLink({ owner: unit.id, tech: hit.tech, how: `imports ${hit.name}`, evidence: `${f.rel}:${lines(imp.index)}` });
		}
		for (const sdk of sdkClients(text)) addCodeLink({ owner: unit.id, tech: sdk.tech, how: sdk.how, evidence: `${f.rel}:${lines(sdk.index)}` });
		for (const k of envReads(text)) unit.envKeys.add(k);
		for (const u of urlLiterals(text)) urlUses.push({ owner: unit.id, url: u.url, evidence: `${f.rel}:${lines(u.index)}` });
		for (const m of messagingUses(text)) messaging.push({ owner: unit.id, tech: m.tech, name: m.name, dir: m.dir, evidence: `${f.rel}:${lines(m.index)}` });
		for (const e of entryPoints(text, f.rel, lang)) unit.entries.push(e);
		if (unit.entries.length > before) unit.files.add(f.rel);
	}
	for (const m of messaging) {
		if (m.dir === "consumes") services.get(m.owner)?.entries.push({ kind: "consumer", label: `${m.name}${m.tech ? ` (${m.tech.label})` : ""}`, file: m.evidence.replace(/:\d+$/, ""), line: Number(m.evidence.split(":").pop()) || 1 });
	}

	// Root-level env / config: belongs to the packages whose code reads the key, else the root package.
	for (const r of rootLevel) {
		const readers = [...services.values()].filter((s) => s.envKeys.has(r.key) && s.dir !== undefined);
		const owners = readers.length ? readers : [units.get("") ?? ([...services.values()].filter((s) => s.dir !== undefined).length === 1 ? [...services.values()].find((s) => s.dir !== undefined)! : rootUnit())];
		for (const o of owners) {
			candidates.push({ owner: o.id, key: r.key, value: r.value, evidence: r.evidence, env: r.env });
			o.files.add(r.file);
			if (r.cred) health.credentials.push({ owner: o.id, file: r.file, key: r.key, ...r.cred, source: "config" });
		}
	}

	// ----- resolve configuration candidates -----
	progress("Resolving connections…");
	for (const c of candidates) {
		if (isSecretKey(c.key)) {
			secretKeys.add(c.key);
			continue;
		}
		const value = interpolate(c.value, c.env);
		const addr = parseAddress(value, { bare: isAddressKey(c.key) });
		if (!addr) continue;
		resolveAddress(c.owner, addr, c.key, `env ${c.key}`, c.evidence);
	}
	for (const u of urlUses) {
		const addr = parseAddress(u.url);
		if (addr) resolveAddress(u.owner, addr, "", "URL in code", u.evidence, true);
	}
	for (const d of composeDeps) {
		const target = findAlias(d.dep);
		if (target) link(d.from, target, "depends_on", d.file, { style: "weak" });
	}

	function resolveAddress(owner: string, addr: Address, key: string, how: string, evidence: string, fromCode = false) {
		const tech = techOf(addr, key);
		const targets = addr.hosts.length ? addr.hosts : [{ host: "", port: undefined }];
		const seen = new Set<string>();
		for (const hp of targets) {
			const host = hp.host;
			let target: string | undefined;
			if (host && isLocalHost(host)) {
				target = hp.port ? portOwner.get(hp.port) : undefined;
				if (!target) {
					// A local dev address of a store: the one declared store of that kind, else the generic one.
					if (!tech || tech.id === "http" || tech.id === "grpc" || fromCode) continue;
					const declared = [...resources.values()].filter((r) => r.declared && r.tech?.id === tech.id);
					target = declared.length === 1 ? declared[0].id : newResource(`tech:${tech.id}`, tech.label, tech, tech.kind, false, evidence).id;
				}
			} else if (host) {
				target = findAlias(host) ?? (internalHost(host) ? findAlias(host.split(".")[0]) : undefined);
			}
			if (!target) {
				// In code, a single-label host that names nothing we know is a placeholder ("host", "server").
				if (fromCode && (!host || isNoiseHost(host) || isLocalHost(host) || !host.includes("."))) continue;
				if (host && isNoiseHost(host)) continue;
				const t = tech ?? (addr.scheme === "http" || addr.scheme === "https" ? TECH.http : undefined);
				if (!t) continue;
				if (t.id === "http" || t.id === "grpc") {
					if (!host) continue;
					target = newResource(`ext:${host}`, host, t, "external", false, evidence).id;
				} else if (addr.resourceName && (t.kind === "queue" || t.kind === "topic" || t.kind === "storage")) {
					const broker = brokerFor(t, evidence);
					const r = newResource(`${t.id}:${addr.resourceName}`, addr.resourceName, t, t.kind === "storage" ? "storage" : t.kind === "topic" ? "topic" : "queue", false, evidence);
					if (broker && broker.id !== r.id && t.kind !== "storage") r.parent = broker.id;
					target = r.id;
				} else {
					const k = host ? `${t.id}@${host}${hp.port ? `:${hp.port}` : ""}` : `tech:${t.id}`;
					const r = newResource(k, host ? host : t.label, t, t.kind, false, evidence);
					if (host) r.address = `${host}${hp.port ? `:${hp.port}` : ""}`;
					addAlias(r.id, host);
					target = r.id;
				}
			}
			if (target === owner || seen.has(target)) continue;
			seen.add(target);
			if (host && !isLocalHost(host) && !internalHost(host) && !isNoiseHost(host) && !externalSeen.has(`${owner}|${host}`)) {
				externalSeen.add(`${owner}|${host}`);
				health.externalScanned++;
				if (addr.scheme === "http" || addr.scheme === "ws") health.plaintext.push({ owner, target, host, evidence });
			}
			const res = resources.get(target);
			if (res && addr.database && !res.database) res.database = addr.database;
			if (res && !res.tech && tech) res.tech = tech;
			// The target's own technology wins over hints from the key (KAFKA_CFG_ZOOKEEPER_CONNECT → ZooKeeper).
			const eff = res?.tech && res.tech.id !== "http" && res.tech.id !== "sql" ? res.tech : tech;
			const proto = eff && eff.id !== "http" ? eff.protocol : addr.scheme && !/^(aws|azure)-/.test(addr.scheme) ? addr.scheme : eff?.protocol;
			link(owner, target, how, evidence, { protocol: proto, port: hp.port ?? (res?.tech?.port && res.tech.id === tech?.id ? res.tech.port : undefined) });
		}
	}

	function brokerFor(tech: Tech, evidence: string): ScanResource | undefined {
		if (tech.kind !== "queue" && tech.kind !== "topic") return undefined;
		const existing = [...resources.values()].filter((r) => r.tech?.id === tech.id && !r.parent && r.kind !== "topic" && !r.id.startsWith(`res:${tech.id}:`));
		if (existing.length) return existing.find((r) => r.declared) ?? existing[0];
		if (tech.id === "sns" || tech.id === "sqs" || tech.id === "pubsub" || tech.id === "eventbridge") return undefined;
		return newResource(`tech:${tech.id}`, tech.label, tech, tech.kind, false, evidence);
	}

	// ----- messaging: topics and queues named in code -----
	for (const m of messaging) {
		const owner = services.get(m.owner);
		// The broker this service is connected to (by config or library), else by the call's own technology.
		const techs = [m.tech?.id, ...codeLinks.filter((c) => c.owner === m.owner && (c.tech.kind === "queue" || c.tech.kind === "topic")).map((c) => c.tech.id)].filter(Boolean) as string[];
		const tech = TECH[techs[0] ?? ""] ?? m.tech;
		if (!owner || !tech) continue;
		const broker = brokerFor(tech, m.evidence);
		const kind: ResourceKind = tech.kind === "topic" || tech.id === "kafka" || tech.id === "pubsub" ? "topic" : "queue";
		const r = newResource(`${tech.id}:${m.name}`, m.name, tech, kind, false, m.evidence);
		if (broker) r.parent = broker.id;
		if (m.dir === "publishes") link(owner.id, r.id, "publishes", m.evidence, { style: "async", verb: "publishes", protocol: tech.protocol });
		else link(r.id, owner.id, "consumes", m.evidence, { style: "async", verb: "consumed by", protocol: tech.protocol });
	}

	// ----- client libraries: attach to a resource of that technology -----
	for (const c of codeLinks) {
		const already = [...links.values()].some((l) => {
			if (l.from !== c.owner && l.to !== c.owner) return false;
			const other = resources.get(l.from === c.owner ? l.to : l.from);
			if (!other) return false;
			const ot = other.tech?.id;
			const parentTech = other.parent ? resources.get(other.parent)?.tech?.id : undefined;
			return ot === c.tech.id || parentTech === c.tech.id || (c.tech.id === "sql" && other.kind === "database");
		});
		if (already) {
			for (const l of links.values()) {
				const other = resources.get(l.from === c.owner ? l.to : l.from);
				if ((l.from === c.owner || l.to === c.owner) && other && (other.tech?.id === c.tech.id || (c.tech.id === "sql" && other.kind === "database"))) {
					l.how.add(c.how);
					if (l.evidence.size < 6) l.evidence.add(c.evidence);
					filesOf(l.from)?.add(fileOfEvidence(c.evidence));
					filesOf(l.to)?.add(fileOfEvidence(c.evidence));
				}
			}
			continue;
		}
		if (c.tech.id === "grpc" || c.tech.id === "http") continue; // the libraries alone do not say whom they call
		if (c.tech.id === "sql") {
			// An ORM: attach to the one database if there is exactly one.
			const dbs = [...resources.values()].filter((r) => r.kind === "database");
			if (dbs.length === 1) link(c.owner, dbs[0].id, c.how, c.evidence, { protocol: dbs[0].tech?.protocol });
			else link(c.owner, newResource("tech:sql", "SQL database", TECH.sql, "database", false, c.evidence).id, c.how, c.evidence, { protocol: "sql" });
			continue;
		}
		const same = [...resources.values()].filter((r) => r.tech?.id === c.tech.id && !r.parent && r.kind !== "topic");
		const target = same.length === 1 ? same[0] : same.find((r) => r.id === `res:tech:${c.tech.id}`) ?? newResource(`tech:${c.tech.id}`, c.tech.label, c.tech, c.tech.kind, false, c.evidence);
		link(c.owner, target.id, c.how, c.evidence, { protocol: c.tech.protocol, port: target.tech?.port });
	}
	// A service with topic links does not need the plain link to the broker as well.
	for (const [key, l] of links) {
		const r = resources.get(l.to);
		if (!r || l.style !== "sync") continue;
		const viaTopic = [...links.values()].some((o) => o !== l && (o.from === l.from || o.to === l.from) && [o.from, o.to].some((x) => resources.get(x)?.parent === r.id));
		if (viaTopic) links.delete(key);
	}

	// ----- which packages are services -----
	const connected = new Set([...links.values()].flatMap((l) => [l.from, l.to]));
	const libraries: string[] = [];
	for (const s of [...services.values()]) {
		const keep = s.deployed || connected.has(s.id) || s.entries.length > 0 || ingresses.some((i) => i.routes.some((r) => r.service === s.id));
		if (!keep) {
			services.delete(s.id);
			libraries.push(s.dir || s.name);
		}
	}
	const live = new Set([...services.keys(), ...resources.keys()]);
	for (const [k, l] of links) if (!live.has(l.from) || !live.has(l.to)) links.delete(k);
	// Resources nothing uses and nobody declared: drop. Brokers are kept when their topics are used.
	const used = new Set([...links.values()].flatMap((l) => [l.from, l.to]));
	for (const r of resources.values()) if (r.parent && used.has(r.id)) used.add(r.parent);
	for (const r of [...resources.values()]) if (!r.declared && !used.has(r.id)) resources.delete(r.id);

	return {
		root,
		name,
		services: [...services.values()],
		resources: [...resources.values()],
		links: [...links.values()],
		ingresses,
		exposed,
		warnings,
		secretKeys,
		libraries,
		health,
		stats: { files: files.length, codeFiles: code.length, composeFiles: composeFiles.length, k8sObjects, envFiles: envFiles.length, configFiles: configFiles.length, ms: Date.now() - started },
	};
}

/** Blanks out comments (keeping offsets and line breaks) so examples in comments are not read as code. */
export function stripComments(text: string, lang: Lang): string {
	const hash = lang === "py" || lang === "rb";
	const slash = !hash;
	const out: string[] = [];
	let last = 0;
	const blank = (from: number, to: number) => {
		out.push(text.slice(last, from), text.slice(from, to).replace(/[^\n]/g, " "));
		last = to;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === "`") {
			// Python triple-quoted strings are docstrings more often than not: blank them.
			if (hash && text.startsWith(c.repeat(3), i)) {
				const end = text.indexOf(c.repeat(3), i + 3);
				const stop = end < 0 ? text.length : end + 3;
				blank(i, stop);
				i = stop - 1;
				continue;
			}
			for (i++; i < text.length && text[i] !== c && !(text[i] === "\n" && c !== "`"); i++) if (text[i] === "\\") i++;
			continue;
		}
		if (slash && c === "/" && text[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			blank(i, end < 0 ? text.length : end);
			i = (end < 0 ? text.length : end) - 1;
		} else if (slash && c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			blank(i, stop);
			i = stop - 1;
		} else if (hash && c === "#") {
			const end = text.indexOf("\n", i);
			blank(i, end < 0 ? text.length : end);
			i = (end < 0 ? text.length : end) - 1;
		}
	}
	out.push(text.slice(last));
	return out.join("");
}

/** Line numbers by offset, with a precomputed table (files can be large). */
function lineIndex(text: string): (index: number) => number {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return (index) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= index) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

const PUBLIC_TLD = /\.(com|net|org|io|dev|app|cloud|ai|co|uk|de|fr|nl|us|eu|info|biz|me|tech|xyz|gov|edu|ca|au|jp|in|br|ch|se|no|es|it|pl|ru|cn|sh|so|to|tv|gg|ly|run|site|online|page|services|azure|aws|windows|amazonaws)$/i;
/** Cluster / compose-internal names (orders, orders.prod, orders.prod.svc.cluster.local). */
function internalHost(host: string): boolean {
	return !host.includes(".") || /\.svc(\.cluster\.local)?$|\.(local|internal|lan|docker|localdomain|cluster)$/.test(host) || (!PUBLIC_TLD.test(host) && host.split(".").length <= 3 && !/^\d+\.\d+/.test(host));
}

function readInside(root: string, rel: string): string | undefined {
	const abs = path.resolve(root, rel);
	if (!abs.startsWith(path.resolve(root) + path.sep)) return undefined;
	try {
		const st = fs.lstatSync(abs);
		return st.isFile() && st.size < 200_000 ? fs.readFileSync(abs, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

function composePort(p: any): { published?: number; target?: number } | undefined {
	if (p && typeof p === "object") return { published: Number(p.published) || undefined, target: Number(p.target) || undefined };
	const s = String(p).replace(/\/(tcp|udp)$/, "");
	const parts = s.split(":");
	const target = parseInt(parts[parts.length - 1], 10);
	const published = parts.length >= 2 ? parseInt(parts[parts.length - 2], 10) : undefined;
	if (!target) return undefined;
	return { published: published || undefined, target };
}

function envEntries(env: any): [string, string][] {
	if (!env) return [];
	if (Array.isArray(env))
		return env
			.map((e) => String(e))
			.filter((e) => e.includes("="))
			.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]);
	if (typeof env === "object") return Object.entries(env).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object").map(([k, v]) => [k, String(v)]);
	return [];
}

export function parseEnvFile(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
		if (!m) continue;
		let v = m[2].trim();
		if (/^["']/.test(v)) v = v.slice(1, v.indexOf(v[0], 1) > 0 ? v.indexOf(v[0], 1) : undefined);
		else v = v.replace(/\s+#.*$/, "");
		out.set(m[1], v);
	}
	return out;
}

/** Flattens a config file into KEY → value, with keys like SPRING_DATASOURCE_URL. */
function configEntries(f: FoundFile): [string, string][] {
	const out: [string, string][] = [];
	const push = (keyPath: string[], v: unknown) => {
		if (v === null || v === undefined || typeof v === "object") return;
		out.push([keyPath.join("_").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(), String(v)]);
	};
	const walk = (obj: any, keyPath: string[], depth: number) => {
		if (depth > 8 || out.length > 2000) return;
		if (Array.isArray(obj)) obj.slice(0, 50).forEach((x, i) => (x && typeof x === "object" ? walk(x, [...keyPath, String(i)], depth + 1) : push(keyPath, x)));
		else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) v && typeof v === "object" ? walk(v, [...keyPath, k], depth + 1) : push([...keyPath, k], v);
	};
	try {
		if (/\.properties$/i.test(f.rel)) {
			for (const line of f.text.split(/\r?\n/)) {
				const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(line);
				if (m && !line.trim().startsWith("#")) push(m[1].split("."), m[2].trim());
			}
		} else if (/\.json$/i.test(f.rel)) walk(JSON.parse(f.text.replace(/^﻿/, "")), [], 0);
		else if (/\.ya?ml$/i.test(f.rel)) for (const d of loadYamlAll(f.text)) walk(d, [], 0);
		else if (/\.toml$/i.test(f.rel)) {
			let section: string[] = [];
			for (const line of f.text.split(/\r?\n/)) {
				const sec = /^\s*\[+([^\]]+)\]+/.exec(line);
				if (sec) section = sec[1].split(".").map((s) => s.trim().replace(/^"|"$/g, ""));
				const m = /^\s*([\w.-]+)\s*=\s*["']?([^"'#]*)["']?/.exec(line);
				if (m) push([...section, ...m[1].split(".")], m[2].trim());
			}
		}
	} catch {
		// unparsable config: nothing to learn from it
	}
	return out;
}

function manifestDependencies(f: FoundFile): string[] {
	try {
		if (f.rel.endsWith("package.json")) {
			const p = JSON.parse(f.text);
			return Object.keys({ ...(p.dependencies ?? {}), ...(p.optionalDependencies ?? {}) });
		}
		if (/requirements[\w.-]*\.txt$/.test(f.rel)) return f.text.split(/\r?\n/).map((l) => l.trim().split(/[<>=!~;\[\s]/)[0]).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
		if (f.rel.endsWith("pyproject.toml")) {
			const deps = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(f.text)?.[1] ?? "";
			const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(f.text)?.[1] ?? "";
			return [...[...deps.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1]), ...[...poetry.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1])];
		}
		if (f.rel.endsWith("go.mod")) return [...f.text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gm)].map((m) => m[1]);
		if (f.rel.endsWith("pom.xml")) return [...f.text.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)].map((m) => `${m[1]}:${m[2]}`);
		if (/build\.gradle(\.kts)?$/.test(f.rel)) return [...f.text.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)].map((m) => `${m[1]}:${m[2]}`);
		if (f.rel.endsWith(".csproj")) return [...f.text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]);
		if (f.rel.endsWith("Gemfile")) return [...f.text.matchAll(/^\s*gem\s+["']([^"']+)/gm)].map((m) => m[1]);
		if (f.rel.endsWith("Cargo.toml")) return [...(/\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(f.text)?.[1] ?? "").matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
	} catch {
		// unparsable manifest
	}
	return [];
}

export type Lang = "js" | "py" | "go" | "java" | "cs" | "rb" | "php" | "rs" | "other";
export function langOf(rel: string): Lang {
	if (/\.(tsx?|jsx?|mjs|cjs)$/i.test(rel)) return "js";
	if (/\.py$/i.test(rel)) return "py";
	if (/\.go$/i.test(rel)) return "go";
	if (/\.(java|kt|scala)$/i.test(rel)) return "java";
	if (/\.cs$/i.test(rel)) return "cs";
	if (/\.rb$/i.test(rel)) return "rb";
	if (/\.php$/i.test(rel)) return "php";
	if (/\.rs$/i.test(rel)) return "rs";
	return "other";
}

/** Imported module names with their position. */
export function importsOf(text: string, lang: Lang): { name: string; index: number }[] {
	const out: { name: string; index: number }[] = [];
	const add = (re: RegExp, group = 1) => {
		for (const m of text.matchAll(re)) if (m[group]) out.push({ name: m[group], index: m.index ?? 0 });
	};
	switch (lang) {
		case "js":
			add(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?["']([^"'.][^"']*)["']/g);
			add(/\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g);
			add(/\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g);
			break;
		case "py":
			add(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm);
			for (const m of text.matchAll(/^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/gm)) for (const n of m[1].split(",")) out.push({ name: n.trim(), index: m.index ?? 0 });
			break;
		case "go":
			for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)|^import\s+(?:\w+\s+)?"([^"]+)"/gm)) {
				if (m[2]) out.push({ name: m[2], index: m.index ?? 0 });
				else for (const q of m[1].matchAll(/"([^"]+)"/g)) out.push({ name: q[1], index: (m.index ?? 0) + (q.index ?? 0) });
			}
			break;
		case "java":
			add(/^\s*import\s+(?:static\s+)?([\w.]+)/gm);
			break;
		case "cs":
			add(/^\s*using\s+(?:static\s+)?([A-Z][\w.]*)\s*;/gm);
			break;
		case "rb":
			add(/^\s*require\s+["']([^"']+)["']/gm);
			break;
		case "rs":
			add(/^[ \t]*(?:use|extern crate)\s+([a-z_][\w]*)/gm);
			break;
	}
	return out;
}

/** AWS / cloud clients created by name (boto3.client("s3"), new AWS.S3()). */
function sdkClients(text: string): { tech: Tech; how: string; index: number }[] {
	const out: { tech: Tech; how: string; index: number }[] = [];
	const BOTO: Record<string, string> = { s3: "s3", sqs: "sqs", sns: "sns", dynamodb: "dynamodb", kinesis: "kinesis", events: "eventbridge" };
	for (const m of text.matchAll(/\bboto3\.(?:client|resource)\(\s*["'](\w+)["']/g)) if (BOTO[m[1]]) out.push({ tech: TECH[BOTO[m[1]]], how: `boto3 ${m[1]}`, index: m.index ?? 0 });
	const V2: Record<string, string> = { S3: "s3", SQS: "sqs", SNS: "sns", DynamoDB: "dynamodb", Kinesis: "kinesis", EventBridge: "eventbridge" };
	for (const m of text.matchAll(/\bnew\s+(?:AWS\.)(S3|SQS|SNS|DynamoDB|Kinesis|EventBridge)(?:\.DocumentClient)?\s*\(/g)) out.push({ tech: TECH[V2[m[1]]], how: `aws-sdk ${m[1]}`, index: m.index ?? 0 });
	return out;
}

/** Environment variables the code reads (names only). */
export function envReads(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])|import\.meta\.env\.([A-Za-z_]\w*)|os\.(?:environ(?:\.get)?\s*[[(]\s*|getenv\(\s*)["']([A-Za-z_]\w*)["']|os\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_]\w*)"|(?:System\.getenv|Environment\.GetEnvironmentVariable)\(\s*"([A-Za-z_]\w*)"|ENV\[\s*["']([A-Za-z_]\w*)["']\s*\]|ENV\.fetch\(\s*["']([A-Za-z_]\w*)["']/g)) {
		const k = m.slice(1).find(Boolean);
		if (k) out.add(k);
	}
	return out;
}

const CLIENT_CALL = /\b(fetch|axios|got|ky|superagent|request|needle|undici|ofetch|\$fetch|requests|httpx|aiohttp|urllib|urlopen|http\.(?:Get|Post|NewRequest)|NewRequest|HttpClient|WebClient|RestTemplate|RestClient|BaseAddress|baseURL|baseUrl|base_url|BASE_URL|endpoint|Endpoint|URI\.create|new\s+URL|Uri\(|Faraday|Net::HTTP|HTTParty|reqwest|grpc\.(?:Dial|NewClient)|createClient|connect|create_engine|MongoClient|Redis|Pool|Kafka|amqp|connectionString|ConnectionString|url|uri|host)\b/;

/** URL literals passed to clients or configured as base URLs. */
function urlLiterals(text: string): { url: string; index: number }[] {
	const out: { url: string; index: number }[] = [];
	for (const m of text.matchAll(/["'`]([a-z][a-z0-9+.-]*:\/\/[^\s"'`]{3,300})["'`]/gi)) {
		const idx = m.index ?? 0;
		const lineStart = text.lastIndexOf("\n", idx) + 1;
		const lineEnd = text.indexOf("\n", idx);
		const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
		if (/^\s*(\/\/|#|\*|\/\*|<!--|"""|''')/.test(line)) continue;
		if (/xmlns|schema|license|copyright|@see|@link|href=|src=|docs?\b/i.test(line)) continue;
		if (!CLIENT_CALL.test(line)) continue;
		out.push({ url: m[1], index: idx });
	}
	return out;
}

/** Topics and queues published to or consumed from, by common client APIs. */
function messagingUses(text: string): { name: string; dir: "publishes" | "consumes"; tech?: Tech; index: number }[] {
	const out: { name: string; dir: "publishes" | "consumes"; tech?: Tech; index: number }[] = [];
	const Q = `["'\`]([A-Za-z0-9_.:/-]{2,80})["'\`]`;
	const rules: [RegExp, "publishes" | "consumes", string?][] = [
		// kafkajs / node
		[new RegExp(`\\.send\\(\\s*\\{[^}]*?\\btopic\\s*:\\s*${Q}`, "g"), "publishes", "kafka"],
		[new RegExp(`\\.subscribe\\(\\s*\\{[^}]*?\\btopics?\\s*:\\s*\\[?\\s*${Q}`, "g"), "consumes", "kafka"],
		// python kafka / confluent
		[new RegExp(`KafkaConsumer\\(\\s*${Q}`, "g"), "consumes", "kafka"],
		[new RegExp(`\\.subscribe\\(\\s*\\[\\s*${Q}`, "g"), "consumes", "kafka"],
		[new RegExp(`\\b(?:producer|kafka_producer|self\\.producer)\\.(?:send|produce|send_and_wait)\\(\\s*${Q}`, "g"), "publishes", "kafka"],
		[new RegExp(`\\btopic\\s*=\\s*${Q}`, "g"), "publishes"],
		// Spring
		[new RegExp(`@KafkaListener\\([^)]*?topics\\s*=\\s*\\{?\\s*${Q}`, "g"), "consumes", "kafka"],
		[new RegExp(`kafkaTemplate\\.send\\(\\s*${Q}`, "gi"), "publishes", "kafka"],
		[new RegExp(`@RabbitListener\\([^)]*?queues\\s*=\\s*\\{?\\s*${Q}`, "g"), "consumes", "rabbitmq"],
		[new RegExp(`rabbitTemplate\\.convertAndSend\\(\\s*${Q}`, "gi"), "publishes", "rabbitmq"],
		[new RegExp(`@SqsListener\\(\\s*(?:value\\s*=\\s*)?\\{?\\s*${Q}`, "g"), "consumes", "sqs"],
		[new RegExp(`@JmsListener\\([^)]*?destination\\s*=\\s*${Q}`, "g"), "consumes"],
		// amqplib / pika
		[new RegExp(`\\.sendToQueue\\(\\s*${Q}`, "g"), "publishes", "rabbitmq"],
		[new RegExp(`\\.consume\\(\\s*${Q}`, "g"), "consumes", "rabbitmq"],
		[new RegExp(`basic_publish\\([^)]*?routing_key\\s*=\\s*${Q}`, "g"), "publishes", "rabbitmq"],
		[new RegExp(`basic_consume\\([^)]*?queue\\s*=\\s*${Q}`, "g"), "consumes", "rabbitmq"],
		// NATS / Redis pub/sub
		[new RegExp(`\\b(?:nc|nats|natsConn|js)\\.publish\\(\\s*${Q}`, "g"), "publishes", "nats"],
		[new RegExp(`\\b(?:nc|nats|natsConn|js)\\.subscribe\\(\\s*${Q}`, "g"), "consumes", "nats"],
		// Azure Service Bus / Google Pub/Sub
		[new RegExp(`createSender\\(\\s*${Q}`, "g"), "publishes", "servicebus"],
		[new RegExp(`createReceiver\\(\\s*${Q}`, "g"), "consumes", "servicebus"],
		[new RegExp(`\\.topic\\(\\s*${Q}\\s*\\)\\s*\\.publish`, "g"), "publishes", "pubsub"],
		[new RegExp(`\\.subscription\\(\\s*${Q}`, "g"), "consumes", "pubsub"],
		// Celery-style task queues
		[new RegExp(`\\.send_task\\(\\s*${Q}`, "g"), "publishes"],
	];
	for (const [re, dir, tech] of rules) {
		for (const m of text.matchAll(re)) {
			const name = m[1];
			if (/^\$|\$\{|^https?:/.test(name)) continue;
			out.push({ name, dir, tech: tech ? TECH[tech] : undefined, index: m.index ?? 0 });
		}
	}
	return out;
}

/**
 * Working copies of the repository kept in a hidden folder below it (git worktrees, as coding
 * agents make them), which a scan does not read. The main checkout of such a repository can
 * hold next to nothing while the work is all in there.
 */
export function hiddenCheckouts(root: string): { folder: string; names: string[] } | undefined {
	for (const folder of [".claude/worktrees", ".worktrees", ".git-worktrees"]) {
		let entries: fs.Dirent[];
		try {
			// (a link is not followed, as in the scan itself: what it points to is not below this folder)
			const parts = folder.split("/");
			if (parts.some((_, i) => fs.lstatSync(path.join(root, ...parts.slice(0, i + 1))).isSymbolicLink())) continue;
			entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true });
		} catch {
			continue;
		}
		const names = entries
			.slice(0, 2000)
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(root, folder, e.name, ".git")))
			.map((e) => e.name)
			.sort();
		if (names.length) return { folder, names };
	}
	return undefined;
}

const HTTP_METHODS = "get|post|put|patch|delete|head|options|all";

/** HTTP routes, scheduled jobs and other entry points declared in code. */
export function entryPoints(text: string, rel: string, lang: Lang): EntryPoint[] {
	const out: EntryPoint[] = [];
	const lines = lineIndex(text);
	const add = (kind: EntryPoint["kind"], label: string, index: number, framework?: string) => out.length < 400 && out.push({ kind, label, file: rel, line: lines(index), framework });
	const P = `["'\`]([^"'\`\\s]*)["'\`]`;
	if (lang === "js") {
		for (const m of text.matchAll(new RegExp(`\\b(app|router|server|fastify|api|routes|r|hono|instance|route)\\.(${HTTP_METHODS})\\(\\s*${P}`, "gi"))) if (m[3].startsWith("/") || m[3] === "*") add("http", `${m[2].toUpperCase()} ${m[3]}`, m.index ?? 0, "Express/Fastify");
		for (const m of text.matchAll(new RegExp(`\\.route\\(\\s*\\{[^}]*?method\\s*:\\s*\\[?\\s*["'](\\w+)["'][^}]*?url\\s*:\\s*${P}`, "g"))) add("http", `${m[1].toUpperCase()} ${m[2]}`, m.index ?? 0, "Fastify");
		// NestJS
		const ctrl = /@Controller\(\s*(?:["'`]([^"'`]*)["'`])?/.exec(text);
		if (ctrl) {
			const base = ctrl[1] ? `/${ctrl[1].replace(/^\//, "")}` : "";
			for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) add("http", `${m[1].toUpperCase()} ${base}${m[2] ? `/${m[2].replace(/^\//, "")}` : ""}` || "/", m.index ?? 0, "NestJS");
			for (const m of text.matchAll(/@(MessagePattern|EventPattern)\(\s*["'`]([^"'`]+)["'`]/g)) add("consumer", m[2], m.index ?? 0, "NestJS");
		}
		// Next.js route handlers (app/api/**/route.ts) and pages/api
		const next = /(?:^|\/)app\/(.*\/)?route\.(t|j)sx?$/.exec(rel);
		if (next) for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) add("http", `${m[1]} /${(next[1] ?? "").replace(/\/$/, "").replace(/\([^)]*\)\//g, "")}`, m.index ?? 0, "Next.js");
		const pagesApi = /(?:^|\/)pages\/(api\/.*)\.(t|j)sx?$/.exec(rel);
		if (pagesApi && /export\s+default/.test(text)) add("http", `* /${pagesApi[1].replace(/\/index$/, "")}`, 0, "Next.js");
		for (const m of text.matchAll(/\bcommands\.registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) add("cli", `command ${m[1]}`, m.index ?? 0, "VS Code");
		for (const m of text.matchAll(/\bipcMain\.(?:handle|on|handleOnce|once)\(\s*["'`]([^"'`]+)["'`]/g)) add("cli", `IPC ${m[1]}`, m.index ?? 0, "Electron");
		for (const m of text.matchAll(/\b(?:program|cli|yargs)\s*\.command\(\s*["'`]([^"'`\s]+)/g)) add("cli", `CLI ${m[1]}`, m.index ?? 0, "CLI");
		for (const m of text.matchAll(/\bcron\.schedule\(\s*["'`]([^"'`]+)["'`]/g)) add("schedule", m[1], m.index ?? 0, "node-cron");
		for (const m of text.matchAll(/@Cron\(\s*(?:["'`]([^"'`]+)["'`]|CronExpression\.(\w+))/g)) add("schedule", m[1] ?? m[2], m.index ?? 0, "NestJS");
		for (const m of text.matchAll(/new\s+CronJob\(\s*["'`]([^"'`]+)["'`]/g)) add("schedule", m[1], m.index ?? 0, "cron");
	} else if (lang === "py") {
		for (const m of text.matchAll(new RegExp(`@(\\w+)\\.(${HTTP_METHODS}|route|websocket)\\(\\s*${P}([^\\n]*)`, "gi"))) {
			const method = m[2].toLowerCase() === "route" ? (/methods\s*=\s*\[([^\]]*)\]/.exec(m[4])?.[1].replace(/["'\s]/g, "").toUpperCase().replace(/,/g, "|") ?? "GET") : m[2].toUpperCase();
			if (m[3].startsWith("/") || m[3] === "") add("http", `${method} ${m[3] || "/"}`, m.index ?? 0, "Flask/FastAPI");
		}
		if (/(^|\/)urls\.py$/.test(rel)) for (const m of text.matchAll(/\b(?:re_)?path\(\s*r?["']([^"']*)["']/g)) add("http", `* /${m[1]}`, m.index ?? 0, "Django");
		for (const m of text.matchAll(/@(?:click|\w+)\.command\([^)]*\)\s*(?:@[^\n]*\n\s*)*def\s+(\w+)/g)) add("cli", `CLI ${m[1]}`, m.index ?? 0, "click/typer");
		// (a module that runs as a program: `python -m package`)
		if (/(^|\/)__main__\.py$/.test(rel)) add("cli", `python -m ${rel.split("/").slice(-2, -1)[0] ?? "package"}`, 0, "Python");
		for (const m of text.matchAll(/@(?:\w+\.)?(?:task|shared_task)\b/g)) add("consumer", `Celery task (${text.slice((m.index ?? 0) + m[0].length).match(/def\s+(\w+)/)?.[1] ?? "?"})`, m.index ?? 0, "Celery");
		for (const m of text.matchAll(/(?:scheduled_job|add_job)\([^)]*?["']cron["'][^)]*/g)) add("schedule", m[0].slice(0, 60), m.index ?? 0, "APScheduler");
		for (const m of text.matchAll(/schedule\.every\([^)]*\)\.[\w.]+/g)) add("schedule", m[0], m.index ?? 0, "schedule");
	} else if (lang === "java") {
		const base = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"/.exec(text)?.[1] ?? "";
		for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)")?/g)) {
			if (m[1] === "Request" && (m.index ?? 0) === text.indexOf("@RequestMapping")) continue;
			add("http", `${m[1] === "Request" ? "*" : m[1].toUpperCase()} ${base}${m[2] ?? ""}` || "/", m.index ?? 0, "Spring");
		}
		for (const m of text.matchAll(/@Scheduled\(\s*(?:cron\s*=\s*"([^"]+)"|fixed\w*\s*=\s*([\w"]+))/g)) add("schedule", m[1] ?? `every ${m[2]}`, m.index ?? 0, "Spring");
		for (const m of text.matchAll(/@(GET|POST|PUT|PATCH|DELETE)\s*(?:@Path\("([^"]*)"\))?/g)) add("http", `${m[1]} ${m[2] ?? ""}`, m.index ?? 0, "JAX-RS");
	} else if (lang === "cs") {
		const route = /\[Route\("([^"]*)"\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+)?(?:sealed\s+|partial\s+|abstract\s+)*class\s+(\w+?)(?:Controller)?\b/.exec(text);
		const base = route ? route[1].replace(/\[controller\]/i, route[2].toLowerCase()) : "";
		for (const m of text.matchAll(/\[Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?\]/g)) add("http", `${m[1].toUpperCase()} /${[base, m[2]].filter(Boolean).join("/").replace(/^\//, "")}`, m.index ?? 0, "ASP.NET");
		for (const m of text.matchAll(/\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"/g)) add("http", `${m[1].toUpperCase()} ${m[2]}`, m.index ?? 0, "ASP.NET minimal API");
		for (const m of text.matchAll(/\[TimerTrigger\("([^"]+)"/g)) add("schedule", m[1], m.index ?? 0, "Azure Functions");
		for (const m of text.matchAll(/\[(ServiceBusTrigger|QueueTrigger|EventHubTrigger|KafkaTrigger)\("([^"]+)"/g)) add("consumer", `${m[2]} (${m[1]})`, m.index ?? 0, "Azure Functions");
		for (const m of text.matchAll(/\[HttpTrigger\([^\]]*?"(get|post|put|delete|patch)"[^\]]*?Route\s*=\s*"([^"]*)"/gi)) add("http", `${m[1].toUpperCase()} /${m[2]}`, m.index ?? 0, "Azure Functions");
	} else if (lang === "go") {
		for (const m of text.matchAll(/\b(?:http|mux|r|router|e|g|app|api|v\d)\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g)) {
			const method = /^Handle/.test(m[1]) ? (/^"?(GET|POST|PUT|PATCH|DELETE)\s/.exec(m[2])?.[1] ?? "*") : m[1].toUpperCase();
			add("http", `${method} ${m[2].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, "")}`, m.index ?? 0, "Go net/http");
		}
	} else if (lang === "rs") {
		// a binary: src/main.rs, or one of src/bin/
		// (each of these looks at one line or a bounded stretch: a file of 600 KB is read in a few ms, whatever is in it)
		if (/(^|\/)src\/(main\.rs|bin\/[^/]+\.rs|bin\/[^/]+\/main\.rs)$/.test(rel)) {
			const main = /^[ \t]*(?:pub[ \t]+)?(?:async[ \t]+)?fn[ \t]+main[ \t]*\(/m.exec(text);
			if (main) {
				const parts = rel.split("/");
				const at = parts.lastIndexOf("src");
				// (a crate at the root of what is mapped has no folder to be named after: its package's entry says whose it is)
				const name = parts[at + 1] === "bin" ? parts[at + 2].replace(/\.rs$/, "") : parts[at - 1];
				add("cli", name ? `binary ${name}` : "binary", main.index + main[0].search(/\S/), "Rust");
			}
		}
		// (routes a crate's own tests build are not what it serves)
		const served = text.slice(0, /#\[cfg\(test\)\]/.exec(text)?.index ?? text.length);
		// axum / warp-style routers: `.route("/path", get(a).post(b))`, the handlers read up to the call's own end
		for (const m of served.matchAll(/\.route\(\s{0,200}"(\/[^"\n]{0,300})"\s{0,200},/g)) {
			if (out.length >= 400) break;
			const from = m.index + m[0].length;
			let depth = 1;
			let end = from;
			for (; end < served.length && end - from < 2000 && depth > 0; end++) depth += served[end] === "(" ? 1 : served[end] === ")" ? -1 : 0;
			const handlers = served.slice(from, end);
			// (a method is a call at the handlers' own level: `get(...)` or `.post(...)`, not one inside a closure's body)
			let level = 0;
			const seen = new Set<string>();
			for (const part of handlers.matchAll(/[()]|\b(get|post|put|patch|delete|head|options|any)\s{0,20}(?=\()/g)) {
				if (part[0] === "(") level++;
				else if (part[0] === ")") level--;
				else if (level === 0 && !seen.has(part[1])) {
					seen.add(part[1]);
					add("http", `${part[1] === "any" ? "*" : part[1].toUpperCase()} ${m[1]}`, m.index, "axum");
				}
			}
		}
		for (const m of served.matchAll(/#\[[ \t]{0,20}(get|post|put|patch|delete|head|options)[ \t]{0,20}\([ \t]{0,20}"([^"\n]{1,300})"/g)) if (m[2].startsWith("/")) add("http", `${m[1].toUpperCase()} ${m[2]}`, m.index, "actix-web/Rocket");
	} else if (lang === "rb") {
		if (/(^|\/)routes\.rb$/.test(rel)) for (const m of text.matchAll(/^\s*(get|post|put|patch|delete|resources?)\s+["':]([^"',\s]+)/gm)) add("http", `${m[1].toUpperCase()} /${m[2]}`, m.index ?? 0, "Rails");
	}
	if (/\.proto$/.test(rel)) for (const m of text.matchAll(/^\s*rpc\s+(\w+)/gm)) add("grpc", m[1], m.index ?? 0, "gRPC");
	return out.slice(0, 400);
}
