/**
 * Health findings of the software mappers: what the read-only scan shows
 * precisely (hard-coded credentials, plain-text calls to external hosts,
 * missing health checks, privileged containers, write endpoints without any
 * auth in the code). Evidence is file:line and setting names, never values:
 * a secret is shown as a masked hint at most.
 */
import type { CheckCoverage, MapFinding, MapGraph } from "../../types";
import { isSecretKey } from "./shared";
import type { SystemScan } from "./systemScan";

const SEVERITY_ORDER: Record<MapFinding["severity"], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Findings whose shapes exist on the map (others are dropped), one per id, most severe first. */
export function keepOnMap(findings: MapFinding[], graph: MapGraph | undefined): MapFinding[] {
	if (!graph) return [];
	const ids = new Set(graph.nodes.map((n) => n.id));
	const seen = new Set<string>();
	const out: MapFinding[] = [];
	for (const f of findings) {
		const nodeIds = [...new Set(f.nodeIds.filter((id) => ids.has(id)))];
		if (!nodeIds.length || seen.has(f.id)) continue;
		seen.add(f.id);
		out.push({ ...f, nodeIds });
	}
	return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}

/** A masked hint of a secret value: its first two characters (long values only) and its length. */
export function maskHint(value: string): string {
	const v = value.trim();
	return v.length >= 12 ? `${v.slice(0, 2)}… (${v.length} chars)` : `*** (${v.length} chars)`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 1-based number of the first line at or after `from` that matches. */
export function lineMatching(text: string, re: RegExp, from = 1): number | undefined {
	const lines = text.split("\n");
	for (let i = Math.max(0, from - 1); i < lines.length; i++) if (re.test(lines[i])) return i + 1;
	return undefined;
}

/** The line that sets `key` (YAML `key:`, list `- KEY=`, properties `key=`), at or after `from`. */
export function keyLine(text: string, key: string, from = 1): number | undefined {
	return lineMatching(text, new RegExp(`^\\s*(?:-\\s*)?["']?${esc(key)}["']?\\s*[:=]`, "i"), from);
}

/** The line of a Kubernetes object (`kind: X` of the document named `name`). */
export function k8sObjectLine(text: string, kind: string, name: string): number | undefined {
	const lines = text.split("\n");
	let start = 0;
	for (let i = 0; i <= lines.length; i++) {
		if (i === lines.length || /^---/.test(lines[i])) {
			const doc = lines.slice(start, i);
			const kindAt = doc.findIndex((l) => new RegExp(`^kind:\\s*${esc(kind)}\\s*$`).test(l.trimEnd()));
			if (kindAt >= 0 && doc.some((l) => new RegExp(`^\\s+name:\\s*["']?${esc(name)}["']?\\s*$`).test(l.trimEnd()))) return start + kindAt + 1;
			start = i + 1;
		}
	}
	return undefined;
}

/** Settings whose names say they are not the secret itself (ids, lengths, file paths, switches). */
const NOT_A_SECRET = /(_ID|_NAME|HEADER|LENGTH|EXPIR\w*|TTL|TIMEOUT|ALGORITHM|ALG|TYPE|ENABLED|DISABLED|MODE|PATH|FILE|DIR|REGION|ISSUER|AUDIENCE|ROTATION|PREFIX|SUFFIX|VERSION)$/i;

/** A value that is a reference or placeholder rather than a literal secret. */
function isPlaceholder(v: string): boolean {
	return (
		v.length < 4 ||
		/\$\{|\{\{|\$\(|%\(|^\$[A-Za-z_]|^<.*>$|^\[.*\]$/.test(v) ||
		/^(.)\1+$/.test(v) ||
		/^(true|false|yes|no|on|off|null|none|nil|undefined|empty|required|optional)$/i.test(v) ||
		/^your[-_ ]|^(change|replace|insert|put|enter)[-_ ]?(me|this|here|your)/i.test(v) ||
		/^\d+$/.test(v) ||
		/^(\.{0,2}\/|[A-Za-z]:\\)/.test(v) ||
		/^(env|secret|vault|ssm|arn|projects\/[^/]+\/secrets|azurekeyvault|keyvault|sm):/i.test(v)
	);
}

/**
 * Whether `key = value` puts a credential in the file: a secret-named setting with a
 * literal value, or a URL / connection string with a literal password. Returns a
 * masked hint; `needle` is the raw secret, only for finding its line, never to be kept.
 */
export function hardcodedSecret(key: string, value: string): { hint: string; what: "value" | "url-password"; needle: string } | undefined {
	const v = String(value ?? "").trim().replace(/^["']|["']$/g, "");
	if (!v) return undefined;
	const url = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^@\s/]+)@/i.exec(v);
	if (url) {
		const pw = decodeURIComponentSafe(url[1]);
		return isPlaceholder(pw) ? undefined : { hint: maskHint(pw), what: "url-password", needle: url[1] };
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return undefined;
	const kv = /(?:^|;)\s*(?:password|pwd)\s*=\s*([^;]+)/i.exec(v);
	if (kv && /;/.test(v)) {
		const pw = kv[1].trim();
		return isPlaceholder(pw) ? undefined : { hint: maskHint(pw), what: "url-password", needle: pw };
	}
	if (!isSecretKey(key) || NOT_A_SECRET.test(key.replace(/[.\-:]/g, "_")) || isPlaceholder(v)) return undefined;
	return { hint: maskHint(v), what: "value", needle: v };
}

/** The line holding `needle` (a secret being located, never shown), else the line of `key`. */
export function secretLine(text: string, needle: string, key: string, from = 1): number | undefined {
	const lines = text.split("\n");
	for (let i = Math.max(0, from - 1); i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
	return keyLine(text, key, from) ?? keyLine(text, key.split(/[_.:]/).pop() ?? key, from);
}

function decodeURIComponentSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Frameworks whose routes the auth check looks at (it knows their middleware and decorators). */
const AUTH_FRAMEWORKS = /^(Express\/Fastify|Fastify|NestJS|Flask\/FastAPI|Spring|JAX-RS|ASP\.NET|ASP\.NET minimal API|Next\.js|Go net\/http)$/;
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)\b/;

/** Findings and check coverage of a system scan, on the nodes of its graph. */
export function systemFindings(scan: SystemScan, graph: MapGraph, opts: { entries?: boolean } = {}): { findings: MapFinding[]; checked: CheckCoverage[] } {
	const h = scan.health;
	const ids = new Set(graph.nodes.map((n) => n.id));
	const name = (id: string) => scan.services.find((s) => s.id === id)?.name ?? scan.resources.find((r) => r.id === id)?.name ?? id;
	const where = (file: string, line?: number) => `${file}${line ? `:${line}` : ""}`;
	const findings: MapFinding[] = [];

	// Hard-coded credentials, one finding per file and setting.
	const creds = new Map<string, typeof h.credentials>();
	for (const c of h.credentials) {
		const k = `${c.file}\u0000${c.key}`;
		creds.set(k, [...(creds.get(k) ?? []), c]);
	}
	for (const list of creds.values()) {
		const c = list[0];
		const owners = [...new Set(list.map((x) => x.owner))].filter((o) => ids.has(o));
		if (!owners.length) continue;
		findings.push({
			id: `hardcoded-credential:${c.file}:${c.key}`,
			kind: "hardcoded-credential",
			severity: c.source === "compose" ? "medium" : "high",
			title: `${c.key} is hard-coded in ${c.file}${owners.length === 1 ? ` (${name(owners[0])})` : ""}`,
			detail: `${where(c.file, c.line)} ${c.what === "url-password" ? `puts a literal password in ${c.key}` : `sets ${c.key} to a literal value`} (${c.hint}).`,
			nodeIds: owners,
			fix: `Remove the value of ${c.key} from ${c.file}: read it from an uncommitted .env file, a secret store or a Kubernetes Secret (e.g. \${${c.key}}), then rotate the credential, since it is in the repository history.`,
		});
	}

	// Plain-text HTTP to hosts outside the system.
	for (const p of h.plaintext) {
		if (!ids.has(p.owner)) continue;
		findings.push({
			id: `plaintext-http:${p.owner}:${p.host}`,
			kind: "plaintext-http",
			severity: "medium",
			title: `${name(p.owner)} calls ${p.host} over plain HTTP`,
			detail: `http:// address of an external host in ${p.evidence}.`,
			nodeIds: [p.owner, p.target],
			fix: `Use https://${p.host} (and verify certificates) so requests and credentials are encrypted in transit.`,
		});
	}

	// Missing health checks / readiness probes.
	for (const m of h.noHealthcheck) {
		if (!ids.has(m.owner)) continue;
		const awaited = !!m.awaitedBy;
		findings.push({
			id: `missing-healthcheck:${m.owner}:${m.source}`,
			kind: "missing-healthcheck",
			severity: awaited ? "medium" : "low",
			title: awaited ? `${m.awaitedBy} waits for ${m.name} to be healthy, but ${m.name} has no healthcheck` : m.source === "k8s" ? `${m.name} has no readiness probe` : `${m.name} has no healthcheck`,
			detail: awaited
				? `${where(m.file, m.line)}: ${m.awaitedBy} depends_on ${m.name} with condition: service_healthy, and ${m.name} defines no healthcheck (compose will not start ${m.awaitedBy}).`
				: m.source === "k8s"
				? `${where(m.file, m.line)}: no container of ${m.name} declares a readinessProbe, so traffic is sent before it is ready.`
				: `${where(m.file, m.line)}: compose service ${m.name} defines no healthcheck (and its Dockerfile has no HEALTHCHECK).`,
			nodeIds: [m.owner],
			fix: m.source === "k8s" ? `Add a readinessProbe (and a livenessProbe) to the ${m.name} containers, e.g. an HTTP GET on its health endpoint.` : `Add a healthcheck to the ${m.name} service in ${m.file} (e.g. a curl / pg_isready / redis-cli ping test with interval and retries).`,
		});
	}

	// Privileged containers and host access.
	for (const p of h.privileged) {
		if (!ids.has(p.owner)) continue;
		findings.push({
			id: `privileged-container:${p.owner}:${p.file}`,
			kind: "privileged-container",
			severity: "high",
			title: `${p.name} runs with ${p.what.join(", ")}`,
			detail: `${where(p.file, p.line)}: ${p.what.join("; ")}. A compromise of this container reaches the host.`,
			nodeIds: [p.owner],
			fix: `Drop ${p.what.join(", ")} from ${p.name} in ${p.file}; grant only the specific capabilities or volumes it needs.`,
		});
	}

	// HTTP write endpoints in services whose code shows no authentication at all.
	let authScanned = 0;
	for (const s of scan.services) {
		const routes = s.entries.filter((e) => e.kind === "http" && e.framework && AUTH_FRAMEWORKS.test(e.framework));
		if (!routes.length) continue;
		authScanned++;
		const writes = routes.filter((e) => WRITE_METHOD.test(e.label));
		if (!writes.length || h.auth.has(s.id)) continue;
		const node = opts.entries && ids.has(`${s.id}#http`) ? `${s.id}#http` : s.id;
		if (!ids.has(node)) continue;
		findings.push({
			id: `no-auth-guard:${s.id}`,
			kind: "no-auth-guard",
			severity: "medium",
			title: `${s.name} has ${writes.length} write endpoint(s) and no authentication in its code`,
			detail: `${writes
				.slice(0, 6)
				.map((e) => `${e.label} (${e.file}:${e.line})`)
				.join(", ")}${writes.length > 6 ? `, … ${writes.length - 6} more` : ""}; no auth middleware, decorator, guard or auth library was found in ${s.dir ? `${s.dir}/` : "the service's code"}.`,
			nodeIds: [node],
			fix: `Protect the write routes of ${s.name} with authentication (middleware, decorator or guard of its framework), or confirm that a gateway in front of it authenticates every request.`,
		});
	}

	const checked: CheckCoverage[] = [
		{ check: "Hard-coded credentials in compose, Kubernetes and config files", scanned: h.settingsScanned, note: "settings examined; .env files are meant to hold local secrets and are not checked" },
		{ check: "Plain-text HTTP to external hosts", scanned: h.externalScanned, note: "external addresses examined" },
		{ check: "Health checks and readiness probes", scanned: h.healthScanned, note: "compose app services and long-running Kubernetes workloads" },
		{ check: "Privileged containers, host network / PID and Docker socket mounts", scanned: h.containersScanned, note: "containers examined" },
		{ check: "HTTP write endpoints without authentication", scanned: authScanned, note: "services with routes; flagged only when their code shows no auth middleware, decorator or library at all" },
	];
	return { findings: keepOnMap(findings, graph), checked };
}
