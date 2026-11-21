/** Draws a SystemScan: services as containers, stores / queues / external APIs around them, labelled connections. */
import type { MapEdge, MapGraph, MapNode, MapRow } from "../../types";
import { STYLE } from "./shared";
import type { EntryPoint, ScanLink, ScanResource, ScanService, SystemScan } from "./systemScan";

export interface SystemGraphOptions {
	title: string;
	/** Data flow: entry points as tables inside the services. */
	entries?: boolean;
	/** Entry points mentioning this come first and are marked. */
	focus?: string;
	direction?: "down" | "right";
}

const RESOURCE_STYLE: Record<string, string> = {
	database: STYLE.database,
	cache: STYLE.cache,
	search: STYLE.search,
	storage: STYLE.storage,
	queue: STYLE.queue,
	topic: STYLE.queue,
	external: STYLE.external,
	gateway: STYLE.gateway,
	auth: STYLE.gateway,
	mail: STYLE.external,
	observability: STYLE.other,
	other: STYLE.other,
};

export function edgeLabel(l: ScanLink): string {
	if (l.style === "weak") return "depends_on";
	const base = l.verb ?? l.protocol ?? "";
	return `${base}${l.port && l.style !== "async" ? ` :${l.port}` : ""}`.trim();
}

function focusTerms(focus?: string): string[] {
	return (focus ?? "")
		.toLowerCase()
		.split(/[\s,;/]+/)
		.map((t) => t.replace(/[^a-z0-9_-]/g, ""))
		.filter((t) => t.length >= 3)
		.flatMap((t) => (t.endsWith("s") ? [t, t.slice(0, -1)] : [t]));
}

export function matchesFocus(text: string, terms: string[]): boolean {
	const t = text.toLowerCase();
	return terms.some((x) => t.includes(x));
}

const ENTRY_TITLE: Record<EntryPoint["kind"], string> = { http: "HTTP routes", consumer: "Consumes", schedule: "Scheduled", grpc: "gRPC", cli: "Commands / IPC" };

export function systemGraph(scan: SystemScan, opts: SystemGraphOptions): MapGraph {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const terms = focusTerms(opts.focus);
	const ids = new Set<string>();
	const push = (n: MapNode) => {
		if (ids.has(n.id)) return;
		ids.add(n.id);
		nodes.push(n);
	};

	// Who reaches the system from outside.
	if (scan.exposed.size || scan.ingresses.length) {
		push({ id: "clients", label: "Users / clients", kind: "software:clients", shape: "icon", style: STYLE.actor, width: 36, height: 56 });
		for (const ing of scan.ingresses) {
			push({ id: ing.id, label: ing.label, kind: "software:ingress", style: STYLE.gateway, height: ing.label.includes("\n") ? 52 : 40, data: { file: ing.file }, files: [ing.file] });
			edges.push({ from: "clients", to: ing.id, label: "HTTPS", style: STYLE.edge });
			const byService = new Map<string, string[]>();
			for (const r of ing.routes) byService.set(r.service, [...(byService.get(r.service) ?? []), r.path]);
			for (const [svc, paths] of byService) edges.push({ from: ing.id, to: svc, label: paths.slice(0, 3).join(", ") + (paths.length > 3 ? " …" : ""), style: STYLE.edge });
		}
		const viaIngress = new Set(scan.ingresses.flatMap((i) => i.routes.map((r) => r.service)));
		for (const [id, how] of scan.exposed) if (!viaIngress.has(id)) edges.push({ from: "clients", to: id, label: how.startsWith(":") ? `HTTP ${how}` : how, style: STYLE.edge });
	}

	for (const s of scan.services) serviceNodes(s).forEach(push);

	function serviceNodes(s: ScanService): MapNode[] {
		const out: MapNode[] = [];
		const label = `${s.name}${s.runtime ? `  · ${s.runtime}` : ""}`;
		out.push({
			id: s.id,
			label,
			kind: "software:service",
			container: true,
			style: STYLE.service,
			data: compact({
				dir: s.dir,
				runtime: s.runtime,
				images: [...s.images].slice(0, 4).join(", "),
				ports: [...s.ports].slice(0, 6).join(", "),
				envKeys: [...s.envKeys].slice(0, 30).join(", "),
				files: s.facets.map((f) => f.file).slice(0, 6).join(", "),
			}),
			...(s.files.size ? { files: fileList(s.files) } : {}),
		});
		if (opts.entries && s.entries.length) {
			for (const kind of ["http", "consumer", "schedule", "grpc", "cli"] as const) {
				const list = s.entries.filter((e) => e.kind === kind);
				if (!list.length) continue;
				const ordered = terms.length ? [...list.filter((e) => matchesFocus(`${e.label} ${e.file}`, terms)), ...list.filter((e) => !matchesFocus(`${e.label} ${e.file}`, terms))] : list;
				const rows: MapRow[] = dedupe(ordered.map((e) => `${e.label}\u0000${e.file}`)).map((k) => {
					const [text, file] = k.split("\u0000");
					return { text: `${terms.length && matchesFocus(`${text} ${file}`, terms) ? "★ " : ""}${text}`, detail: file.split("/").pop() };
				});
				out.push({
					id: `${s.id}#${kind}`,
					label: `${ENTRY_TITLE[kind]} (${list.length})`,
					kind: `software:entry:${kind}`,
					parent: s.id,
					shape: "table",
					style: STYLE.table(kind === "http" ? "#dae8fc" : kind === "consumer" ? "#e1d5e7" : "#fff2cc", kind === "http" ? "#6c8ebf" : kind === "consumer" ? "#9673a6" : "#d6b656"),
					rows,
					data: { service: s.name, files: dedupe(list.map((e) => `${e.file}:${e.line}`)).slice(0, 12).join(", ") },
					files: fileList(list.map((e) => e.file)),
				});
			}
		} else {
			for (const [i, f] of s.facets.slice(0, 4).entries()) {
				out.push({ id: `${s.id}#f${i}`, label: f.label, kind: `software:${f.source}`, parent: s.id, style: STYLE.facet, height: 30, width: Math.max(130, Math.min(240, f.label.length * 6.5 + 20)), data: { file: f.file }, files: [f.file] });
			}
		}
		return out;
	}

	// Stores, brokers, topics and external services.
	const parents = new Set(scan.resources.map((r) => r.parent).filter(Boolean) as string[]);
	const externals = scan.resources.filter((r) => r.kind === "external" && !r.parent);
	const groupExternal = externals.length >= 2;
	if (groupExternal) push({ id: "group:external", label: "External services", kind: "software:group", container: true, style: STYLE.group });
	for (const r of scan.resources) push(resourceNode(r, parents.has(r.id), groupExternal && r.kind === "external" && !r.parent ? "group:external" : undefined));

	function resourceNode(r: ScanResource, isBroker: boolean, group?: string): MapNode {
		const tech = r.tech?.label;
		const lines = [r.name, tech && tech.toLowerCase() !== r.name.toLowerCase() && r.kind !== "external" ? tech : "", r.database ? `db: ${r.database}` : ""].filter(Boolean);
		const data = compact({ tech: r.tech?.id, address: r.address, database: r.database, evidence: r.evidence.slice(0, 4).join(", ") });
		const files = fileList(r.files);
		if (isBroker) return { id: r.id, label: lines.join(" · "), kind: `software:${r.kind}`, container: true, style: STYLE.broker, data, ...(files.length ? { files } : {}) };
		const cyl = ["database", "cache", "search", "storage"].includes(r.kind);
		return {
			id: r.id,
			label: lines.join("\n"),
			kind: `software:${r.kind}`,
			parent: r.parent ?? group,
			style: RESOURCE_STYLE[r.kind] ?? STYLE.other,
			width: cyl ? 130 : r.kind === "external" ? 150 : undefined,
			height: cyl ? 64 + Math.max(0, lines.length - 2) * 14 : r.kind === "external" ? 70 : lines.length > 2 ? 64 : 48,
			data,
			...(files.length ? { files } : {}),
		};
	}

	for (const l of scan.links) {
		edges.push({
			from: l.from,
			to: l.to,
			label: edgeLabel(l),
			kind: l.style === "async" ? "dataflow" : l.style === "weak" ? "depends" : "network",
			style: l.style === "async" ? STYLE.edgeAsync : l.style === "weak" ? STYLE.edgeWeak : STYLE.edge,
		});
	}
	const known = new Set(nodes.map((n) => n.id));
	return {
		title: opts.title,
		nodes,
		edges: edges.filter((e) => known.has(e.from) && known.has(e.to)),
		direction: opts.direction ?? "down",
	};
}

export function compact(o: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
}

/** A node's source files: sorted, de-duplicated, capped. */
function fileList(files: Iterable<string>, max = 60): string[] {
	return [...new Set(files)].filter(Boolean).sort().slice(0, max);
}

function dedupe(xs: string[]): string[] {
	return [...new Set(xs)];
}

/** The scan as Markdown for the agent: what was found, where, and how it connects. Never values of settings. */
export function scanFacts(scan: SystemScan, opts: { entries?: boolean; maxEntries?: number } = {}): string {
	const name = (id: string) => scan.services.find((s) => s.id === id)?.name ?? scan.resources.find((r) => r.id === id)?.name ?? id;
	const out: string[] = [`# System scan of ${scan.name}`, `Read ${scan.stats.files} files (${scan.stats.codeFiles} code, ${scan.stats.composeFiles} compose, ${scan.stats.k8sObjects} Kubernetes objects, ${scan.stats.envFiles} env, ${scan.stats.configFiles} config).`, ""];
	out.push("## Services");
	for (const s of scan.services) {
		out.push(`### ${s.name} (mapperId ${s.id})`);
		if (s.dir !== undefined) out.push(`- folder: ${s.dir || "."}${s.runtime ? ` (${s.runtime})` : ""}`);
		for (const f of s.facets) out.push(`- ${f.source}: ${f.label} — ${f.file}`);
		if (s.images.size) out.push(`- images: ${[...s.images].join(", ")}`);
		if (s.envKeys.size) out.push(`- settings it reads / gets (names only): ${[...s.envKeys].slice(0, 40).join(", ")}`);
		if (opts.entries && s.entries.length) {
			out.push(`- entry points:`);
			for (const e of s.entries.slice(0, opts.maxEntries ?? 80)) out.push(`  - ${e.kind} ${e.label} — ${e.file}:${e.line}${e.framework ? ` (${e.framework})` : ""}`);
			if (s.entries.length > (opts.maxEntries ?? 80)) out.push(`  - … ${s.entries.length - (opts.maxEntries ?? 80)} more`);
		}
	}
	out.push("", "## Data stores, queues and external services");
	for (const r of scan.resources) out.push(`- ${r.name} (mapperId ${r.id}): ${r.kind}${r.tech ? `, ${r.tech.label}` : ""}${r.address ? `, ${r.address}` : ""}${r.database ? `, database ${r.database}` : ""}${r.parent ? `, in ${name(r.parent)}` : ""}${r.declared ? ", declared in deployment files" : ", inferred from config / code"} — ${r.evidence.slice(0, 3).join("; ")}`);
	out.push("", "## Connections");
	for (const l of scan.links) out.push(`- ${name(l.from)} → ${name(l.to)}: ${edgeLabel(l) || "uses"} (${[...l.how].slice(0, 4).join(", ")}) — ${[...l.evidence].slice(0, 3).join("; ")}`);
	if (scan.ingresses.length) {
		out.push("", "## Ingress");
		for (const i of scan.ingresses) out.push(`- ${i.label.replace(/\n/g, " ")} (${i.file}): ${i.routes.map((r) => `${r.path} → ${name(r.service)}`).join(", ")}`);
	}
	if (scan.secretKeys.size) out.push("", `Secret settings exist (values were not read): ${[...scan.secretKeys].slice(0, 30).join(", ")}`);
	if (scan.libraries.length) out.push("", `Other packages (no deployment or connections found): ${scan.libraries.slice(0, 30).join(", ")}`);
	if (scan.warnings.length) out.push("", "## Warnings", ...scan.warnings.map((w) => `- ${w}`));
	return out.join("\n");
}
