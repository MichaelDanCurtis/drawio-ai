/**
 * API surface: OpenAPI / Swagger specs (v2, v3, YAML or JSON) and GraphQL SDL.
 * Endpoints grouped by tag (or first path segment) with parameters, request and
 * response types; schemas as tables, with arrows from endpoints to the schemas
 * they take and return.
 */
import * as path from "path";
import { agentRequest, digDeeperRequest, FOLDER_FIELD, folderInput, readFiles, slug, type FoundFile, loadYaml } from "../common";
import type { CheckCoverage, CollectResult, MapEdge, MapFinding, MapGraph, MapNode, MapRow, Recipe } from "../../types";
import { keepOnMap } from "./health";
import { nothingFound, probeApi } from "./apiProbe";
import { isLocalHost, scrub, STYLE } from "./shared";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const METHOD_COLORS: Record<string, [string, string]> = {
	GET: ["#dae8fc", "#6c8ebf"],
	POST: ["#d5e8d4", "#82b366"],
	PUT: ["#ffe6cc", "#d79b00"],
	PATCH: ["#ffe6cc", "#d79b00"],
	DELETE: ["#f8cecc", "#b85450"],
};
const SCHEMA_STYLE = STYLE.table("#f5f5f5", "#666666");
const GROUP_STYLE = STYLE.folder;
const SPEC_STYLE = STYLE.service;
const REF_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;endFill=0;strokeColor=#9ca3af;fontSize=9;";
const MAX_ENDPOINT_NODES = 60;
const MAX_SCHEMAS = 80;
const MAX_GQL_TYPES = 150;

export interface ApiSpec {
	file: string;
	doc: any;
}

const refName = (ref: string) => decodeURIComponent(String(ref).split("/").pop() ?? ref).replace(/~1/g, "/").replace(/~0/g, "~");

/** "Order", "Order[]", "string (date-time)", "OrderA | OrderB". */
export function typeName(schema: any, depth = 0): string {
	if (!schema || typeof schema !== "object" || depth > 4) return "";
	if (schema.$ref) return refName(schema.$ref);
	for (const k of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(schema[k])) return schema[k].map((s: any) => typeName(s, depth + 1)).filter(Boolean).join(k === "allOf" ? " & " : " | ");
	if (schema.type === "array" || schema.items) return `${typeName(schema.items, depth + 1) || "any"}[]`;
	if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") return `map<${typeName(schema.additionalProperties, depth + 1) || "any"}>`;
	const t = Array.isArray(schema.type) ? schema.type.filter((x: string) => x !== "null").join("|") : schema.type;
	if (schema.enum && Array.isArray(schema.enum)) return `${t ?? "enum"} (${schema.enum.slice(0, 4).join("|")}${schema.enum.length > 4 ? "|…" : ""})`;
	return `${t ?? (schema.properties ? "object" : "any")}${schema.format ? ` (${schema.format})` : ""}`;
}

/** Schema names a schema refers to (for edges). */
function refsOf(schema: any, out = new Set<string>(), depth = 0): Set<string> {
	if (!schema || typeof schema !== "object" || depth > 6) return out;
	if (schema.$ref) {
		out.add(refName(schema.$ref));
		return out;
	}
	for (const k of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(schema[k])) schema[k].forEach((s: any) => refsOf(s, out, depth + 1));
	if (schema.items) refsOf(schema.items, out, depth + 1);
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") refsOf(schema.additionalProperties, out, depth + 1);
	return out;
}

interface Operation {
	method: string;
	path: string;
	group: string;
	summary: string;
	operationId?: string;
	rows: MapRow[];
	refs: { name: string; label: string }[];
	deprecated: boolean;
	security: string[];
	/** `security: []` on the operation: deliberately public. */
	explicitlyPublic: boolean;
}

function resolve(doc: any, obj: any): any {
	if (obj && typeof obj === "object" && typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
		let cur = doc;
		for (const part of obj.$ref.slice(2).split("/")) cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
		return cur ?? obj;
	}
	return obj;
}

export function operationsOf(doc: any): Operation[] {
	const ops: Operation[] = [];
	const v2 = !!doc.swagger;
	for (const [p, rawItem] of Object.entries<any>(doc.paths ?? {})) {
		const item = resolve(doc, rawItem) ?? {};
		for (const method of METHODS) {
			const op = item[method];
			if (!op || typeof op !== "object") continue;
			const rows: MapRow[] = [];
			const refs: { name: string; label: string }[] = [];
			const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x) => resolve(doc, x)).filter(Boolean);
			for (const prm of params) {
				if (prm.in === "body") {
					const t = typeName(prm.schema);
					rows.push({ text: "body", detail: t });
					refsOf(prm.schema).forEach((n) => refs.push({ name: n, label: "body" }));
				} else if (prm.in !== "header" || !/^(authorization|accept|content-type)$/i.test(prm.name)) {
					rows.push({ text: `${prm.name}${prm.required ? "" : "?"}`, detail: `${prm.in}${prm.schema || prm.type ? ` · ${typeName(prm.schema ?? prm)}` : ""}` });
				}
			}
			if (!v2 && op.requestBody) {
				const body = resolve(doc, op.requestBody);
				const [media, content] = Object.entries<any>(body?.content ?? {})[0] ?? [];
				if (content) {
					rows.push({ text: `body${body.required ? "" : "?"}`, detail: `${typeName(content.schema) || "any"}${media && media !== "application/json" ? ` (${media})` : ""}` });
					refsOf(content.schema).forEach((n) => refs.push({ name: n, label: "body" }));
				}
			}
			for (const [code, rawResp] of Object.entries<any>(op.responses ?? {})) {
				const resp = resolve(doc, rawResp) ?? {};
				const schema = v2 ? resp.schema : (Object.values<any>(resp.content ?? {})[0] as any)?.schema;
				const t = typeName(schema);
				rows.push({ text: `→ ${code}`, detail: t || String(resp.description ?? "").split("\n")[0].slice(0, 40) });
				refsOf(schema).forEach((n) => refs.push({ name: n, label: code }));
			}
			const segment = p.split("/").filter((s) => s && !s.startsWith("{") && !/^v\d+$|^api$/i.test(s))[0];
			ops.push({
				method: method.toUpperCase(),
				path: p,
				group: String(op.tags?.[0] ?? (segment ? `/${segment}` : "/")),
				summary: String(op.summary ?? op.operationId ?? "").split("\n")[0].slice(0, 80),
				operationId: op.operationId,
				rows,
				refs,
				deprecated: !!op.deprecated,
				security: (op.security ?? doc.security ?? []).flatMap((s: any) => Object.keys(s ?? {})),
				explicitlyPublic: Array.isArray(op.security) && (op.security.length === 0 || op.security.some((s: any) => s && typeof s === "object" && Object.keys(s).length === 0)),
			});
		}
	}
	return ops;
}

function schemaRows(doc: any, schema: any): MapRow[] {
	const s = resolve(doc, schema) ?? {};
	const rows: MapRow[] = [];
	const required = new Set<string>(s.required ?? []);
	const parts = [s, ...(Array.isArray(s.allOf) ? s.allOf.map((x: any) => resolve(doc, x)) : [])];
	for (const part of parts) {
		if (part !== s && part?.$ref) continue;
		for (const r of part?.required ?? []) required.add(r);
		for (const [name, prop] of Object.entries<any>(part?.properties ?? {})) rows.push({ text: `${name}${required.has(name) ? "" : "?"}`, detail: typeName(prop), key: /^(id|_id|uuid)$/i.test(name) ? "PK" : undefined });
	}
	if (Array.isArray(s.allOf)) for (const x of s.allOf) if (x?.$ref) rows.unshift({ text: `extends ${refName(x.$ref)}` });
	if (!rows.length && s.enum) rows.push(...s.enum.slice(0, 20).map((v: any) => ({ text: String(v) })));
	if (!rows.length && (s.oneOf || s.anyOf)) rows.push({ text: typeName(s) });
	return rows;
}

export function openApiToGraph(specs: ApiSpec[], name: string): { graph: MapGraph; endpoints: number; schemas: number; notes: string[] } {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const notes: string[] = [];
	let endpoints = 0;
	let schemaCount = 0;
	for (const spec of specs) {
		const doc = spec.doc;
		const sid = `spec:${slug(spec.file)}`;
		const version = doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`;
		const servers: string[] = doc.servers ? doc.servers.map((s: any) => scrub(String(s.url ?? ""))) : doc.host ? [`${(doc.schemes ?? ["https"])[0]}://${doc.host}${doc.basePath ?? ""}`] : [];
		nodes.push({
			id: sid,
			label: `${doc.info?.title ?? path.basename(spec.file)}  ${doc.info?.version ? `v${doc.info.version}` : ""}  (${version})`,
			kind: "api:spec",
			container: true,
			style: SPEC_STYLE,
			data: { file: spec.file, ...(servers.length ? { servers: servers.slice(0, 4).join(", ") } : {}) },
			files: [spec.file],
		});
		const ops = operationsOf(doc);
		endpoints += ops.length;
		const schemas: Record<string, any> = doc.components?.schemas ?? doc.definitions ?? {};
		// The most referenced schemas, with the ones they refer to.
		const refCount = new Map<string, number>();
		for (const op of ops) for (const r of op.refs) refCount.set(r.name, (refCount.get(r.name) ?? 0) + 1);
		for (const [n, s] of Object.entries<any>(schemas)) for (const r of propertyRefs(doc, s)) refCount.set(r.name, (refCount.get(r.name) ?? 0) + (n === r.name ? 0 : 1));
		const schemaNames = Object.keys(schemas).sort((a, b) => (refCount.get(b) ?? 0) - (refCount.get(a) ?? 0)).slice(0, MAX_SCHEMAS);
		if (Object.keys(schemas).length > MAX_SCHEMAS) notes.push(`${spec.file}: ${Object.keys(schemas).length} schemas, the ${MAX_SCHEMAS} most referenced are drawn.`);
		const shownSchemas = new Set(schemaNames);
		const schemaId = (n: string) => `${sid}#schema:${slug(n)}`;
		const groups = new Map<string, Operation[]>();
		for (const op of ops) groups.set(op.group, [...(groups.get(op.group) ?? []), op]);
		const compact = ops.length > MAX_ENDPOINT_NODES;
		if (compact) notes.push(`${spec.file}: ${ops.length} endpoints, drawn as one table per group.`);
		for (const [g, list] of groups) {
			const gid = `${sid}#group:${slug(g)}`;
			if (compact) {
				nodes.push({
					id: gid,
					label: `${g}  (${list.length})`,
					kind: "api:group",
					parent: sid,
					shape: "table",
					style: STYLE.table("#dae8fc", "#6c8ebf"),
					rows: list.map((o) => ({ text: `${o.method} ${o.path}${o.deprecated ? " (deprecated)" : ""}`, detail: o.summary.slice(0, 40) || undefined })),
					data: { group: g, file: spec.file },
					files: [spec.file],
				});
				const seen = new Set<string>();
				for (const o of list) for (const r of o.refs) if (shownSchemas.has(r.name) && !seen.has(r.name)) {
					seen.add(r.name);
					edges.push({ from: gid, to: schemaId(r.name), kind: "uses", style: REF_EDGE });
				}
				continue;
			}
			nodes.push({ id: gid, label: g, kind: "api:group", parent: sid, container: true, style: GROUP_STYLE, data: { group: g } });
			for (const o of list) {
				const oid = `${sid}#op:${o.method}:${slug(o.path)}`;
				const [fill, stroke] = METHOD_COLORS[o.method] ?? ["#f5f5f5", "#666666"];
				nodes.push({
					id: oid,
					label: `${o.method} ${o.path}${o.deprecated ? "  (deprecated)" : ""}`,
					kind: "api:endpoint",
					parent: gid,
					shape: "table",
					style: STYLE.table(fill, stroke),
					rows: [...(o.summary ? [{ text: o.summary }] : []), ...o.rows],
					data: { method: o.method, path: o.path, file: spec.file, ...(o.operationId ? { operationId: o.operationId } : {}), ...(o.security.length ? { security: o.security.join(", ") } : {}) },
					files: [spec.file],
				});
				const seen = new Set<string>();
				for (const r of o.refs) {
					if (!shownSchemas.has(r.name) || seen.has(r.name)) continue;
					seen.add(r.name);
					edges.push({ from: oid, to: schemaId(r.name), label: o.refs.filter((x) => x.name === r.name).map((x) => x.label).slice(0, 3).join(", "), kind: "uses", style: REF_EDGE });
				}
			}
		}
		if (schemaNames.length) {
			const cid = `${sid}#schemas`;
			nodes.push({ id: cid, label: `Schemas (${Object.keys(schemas).length})`, kind: "api:schemas", parent: sid, container: true, style: GROUP_STYLE });
			for (const n of schemaNames) {
				schemaCount++;
				nodes.push({ id: schemaId(n), label: n, kind: "api:schema", parent: cid, shape: "table", style: SCHEMA_STYLE, rows: schemaRows(doc, schemas[n]), data: { schema: n, file: spec.file }, files: [spec.file] });
				const seen = new Set<string>();
				for (const r of propertyRefs(doc, schemas[n])) {
					if (r.name === n || !shownSchemas.has(r.name) || seen.has(r.name)) continue;
					seen.add(r.name);
					edges.push({ from: schemaId(n), to: schemaId(r.name), label: r.label, kind: "references", style: REF_EDGE });
				}
			}
		}
	}
	return { graph: { title: `API · ${name}`, nodes, edges, direction: "right" }, endpoints, schemas: schemaCount, notes };
}

function propertyRefs(doc: any, schema: any): { name: string; label: string }[] {
	const s = resolve(doc, schema) ?? {};
	const out: { name: string; label: string }[] = [];
	for (const part of [s, ...(Array.isArray(s.allOf) ? s.allOf : [])]) {
		if (part?.$ref && part !== s) out.push({ name: refName(part.$ref), label: "extends" });
		for (const [prop, ps] of Object.entries<any>(part?.properties ?? {})) refsOf(ps).forEach((n) => out.push({ name: n, label: prop }));
	}
	return out;
}

/** Server URLs of a spec (v3 servers, v2 schemes + host). */
function serverUrls(doc: any): string[] {
	if (Array.isArray(doc.servers)) return doc.servers.map((s: any) => String(s?.url ?? "")).filter(Boolean);
	if (doc.host) return (Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ["https"]).map((sc: string) => `${sc}://${doc.host}${doc.basePath ?? ""}`);
	return [];
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Paths that are public by nature (health, sign-in, docs). */
const PUBLIC_PATH = /^\/?(api\/)?(v\d+\/)?(health\w*|healthz|readyz|livez|ping|status|metrics|version|login|logout|signin|sign-in|signup|sign-up|register|token|oauth\w*|auth\w*|session\w*|password\w*|webhooks?|docs|openapi|swagger)(\/|$)/i;

/** Endpoints without a security requirement in specs that define security, and plain-text servers (exported for tests). */
export function apiFindings(specs: ApiSpec[], graph: MapGraph): { findings: MapFinding[]; checked: CheckCoverage[] } {
	const findings: MapFinding[] = [];
	let examined = 0;
	let serversSeen = 0;
	const ids = new Set(graph.nodes.map((n) => n.id));
	for (const spec of specs) {
		const doc = spec.doc;
		const sid = `spec:${slug(spec.file)}`;
		const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
		if (Object.keys(schemes).length) {
			for (const o of operationsOf(doc)) {
				examined++;
				if (o.security.length || o.explicitlyPublic || PUBLIC_PATH.test(o.path)) continue;
				const opNode = `${sid}#op:${o.method}:${slug(o.path)}`;
				const node = ids.has(opNode) ? opNode : `${sid}#group:${slug(o.group)}`;
				findings.push({
					id: `endpoint-without-security:${spec.file}:${o.method} ${o.path}`,
					kind: "endpoint-without-security",
					severity: WRITE.has(o.method) ? "medium" : "low",
					title: `${o.method} ${o.path} has no security requirement`,
					detail: `${spec.file}: the spec defines ${Object.keys(schemes).join(", ")} but neither this operation nor the spec's global \`security\` requires one, so the endpoint is documented as public.`,
					nodeIds: [node],
					fix: `Add a security requirement to ${o.method} ${o.path} in ${spec.file} (or a global one), or mark it public on purpose with \`security: []\`, and check that the implementation enforces the same.`,
				});
			}
		}
		for (const url of serverUrls(doc)) {
			serversSeen++;
			const host = /^http:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase();
			if (!host || isLocalHost(host) || !host.includes(".") || /\.(local|internal|localhost|test|example)$/.test(host)) continue;
			findings.push({
				id: `plaintext-http:${spec.file}:${host}`,
				kind: "plaintext-http",
				severity: "medium",
				title: `${doc.info?.title ?? spec.file} is served over plain HTTP (${host})`,
				detail: `${spec.file}: server ${scrub(url)} uses http://, so requests and tokens travel unencrypted.`,
				nodeIds: [sid],
				fix: `Serve the API over HTTPS and change the server URL in ${spec.file} to https://${host}.`,
			});
		}
	}
	const checked: CheckCoverage[] = [
		{ check: "Endpoints without a security requirement", scanned: examined, note: "operations of specs that define security schemes" },
		{ check: "Plain-text HTTP server URLs", scanned: serversSeen, note: "server URLs in the specs" },
	];
	return { findings: keepOnMap(findings, graph), checked };
}

// ----- GraphQL -----

interface GqlType {
	kind: string;
	name: string;
	fields: { name: string; args: number; type: string }[];
	members?: string[];
	implements?: string[];
	file: string;
}

export function parseGraphQL(text: string, file: string): GqlType[] {
	const clean = text.replace(/"""[\s\S]*?"""/g, "").replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n]*/g, "");
	const out: GqlType[] = [];
	const re = /\b(extend\s+)?(type|input|interface|enum|union|scalar)\s+([_A-Za-z]\w*)([^{=\n]*)(\{|=)?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(clean))) {
		const [, , kind, name, between, open] = m;
		const impl = /implements\s+([\w&,\s]+)/.exec(between ?? "")?.[1].split(/[&,\s]+/).filter(Boolean);
		if (kind === "scalar") {
			out.push({ kind, name, fields: [], file });
			continue;
		}
		if (open === "=") {
			const rest = clean.slice(re.lastIndex).split(/\n\s*\n|\b(?:type|input|interface|enum|union|scalar|schema|directive|extend)\b/)[0];
			out.push({ kind, name, fields: [], members: rest.split("|").map((s) => s.trim()).filter((s) => /^\w+$/.test(s)), file });
			continue;
		}
		if (open !== "{") continue;
		let depth = 1;
		let i = re.lastIndex;
		for (; i < clean.length && depth; i++) depth += clean[i] === "{" ? 1 : clean[i] === "}" ? -1 : 0;
		let body = clean.slice(re.lastIndex, i - 1);
		re.lastIndex = i;
		let args = 0;
		for (let guard = 0; guard < 5 && /\([^()]*\)/.test(body); guard++) body = body.replace(/\([^()]*\)/g, () => `(${++args})`);
		const fields: GqlType["fields"] = [];
		if (kind === "enum") for (const v of body.split(/[\s,]+/).filter((s) => /^[_A-Za-z]\w*$/.test(s))) fields.push({ name: v, args: 0, type: "" });
		else
			for (const f of body.matchAll(/([_A-Za-z]\w*)\s*(\(\d+\))?\s*:\s*([[\]\w!]+)/g)) fields.push({ name: f[1], args: f[2] ? 1 : 0, type: f[3] });
		const existing = out.find((t) => t.name === name && t.kind === kind);
		if (existing) {
			existing.fields.push(...fields);
			if (impl?.length) existing.implements = [...(existing.implements ?? []), ...impl];
		} else out.push({ kind, name, fields, file, ...(impl?.length ? { implements: impl } : {}) });
	}
	return out;
}

export function graphqlToGraph(types: GqlType[], name: string): MapGraph {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const ROOTS = new Set(["Query", "Mutation", "Subscription"]);
	const objectish = new Map(types.filter((t) => ["type", "interface", "union", "input"].includes(t.kind)).map((t) => [t.name, t]));
	const base = (t: string) => t.replace(/[[\]!]/g, "");
	// Most connected types first when there are too many.
	const degree = new Map<string, number>();
	for (const t of types) for (const f of t.fields) if (objectish.has(base(f.type))) {
		degree.set(t.name, (degree.get(t.name) ?? 0) + 1);
		degree.set(base(f.type), (degree.get(base(f.type)) ?? 0) + 1);
	}
	const shown = [...types.filter((t) => t.kind !== "scalar")].sort((a, b) => (ROOTS.has(b.name) ? 1e6 : 0) + (degree.get(b.name) ?? 0) - (ROOTS.has(a.name) ? 1e6 : 0) - (degree.get(a.name) ?? 0)).slice(0, MAX_GQL_TYPES);
	const keep = new Set(shown.map((t) => t.name));
	const id = (n: string) => `gql:${slug(n)}`;
	const STYLES: Record<string, string> = { type: STYLE.table("#dae8fc", "#6c8ebf"), input: STYLE.table("#f5f5f5", "#666666"), interface: STYLE.table("#d5e8d4", "#82b366"), enum: STYLE.table("#fff2cc", "#d6b656"), union: STYLE.table("#e1d5e7", "#9673a6") };
	for (const t of shown) {
		const root = ROOTS.has(t.name);
		nodes.push({
			id: id(t.name),
			label: `${root ? "" : t.kind === "type" ? "" : `«${t.kind}» `}${t.name}`,
			kind: `graphql:${root ? t.name.toLowerCase() : t.kind}`,
			shape: "table",
			style: root ? STYLE.table("#ffe6cc", "#d79b00") : STYLES[t.kind] ?? STYLES.type,
			rows: t.members ? t.members.map((mm) => ({ text: mm })) : t.fields.map((f) => ({ text: `${f.name}${f.args ? "(…)" : ""}`, detail: f.type || undefined })),
			data: { type: t.name, kind: t.kind, file: t.file },
			files: [t.file],
		});
	}
	const labels = new Map<string, string[]>();
	for (const t of shown) {
		const targets = t.members ? t.members.map((mm) => ({ to: mm, label: "" })) : t.fields.map((f) => ({ to: base(f.type), label: f.name }));
		for (const { to, label } of targets) {
			if (!keep.has(to) || !objectish.has(to) || to === t.name) continue;
			const k = `${t.name}\u0000${to}`;
			labels.set(k, [...(labels.get(k) ?? []), label]);
		}
		for (const iface of t.implements ?? []) {
			if (keep.has(iface)) edges.push({ from: id(iface), to: id(t.name), kind: "implements", style: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;startArrow=block;startFill=0;startSize=10;endArrow=none;dashed=1;strokeColor=#374151;" });
		}
	}
	for (const [k, ls] of labels) {
		const [from, to] = k.split("\u0000");
		const named = ls.filter(Boolean);
		edges.push({ from: id(from), to: id(to), label: ROOTS.has(from) && named.length ? named.slice(0, 3).join(", ") + (named.length > 3 ? " …" : "") : undefined, kind: "returns", style: REF_EDGE });
	}
	return { title: `GraphQL · ${name}`, nodes, edges, direction: "down" };
}

// ----- recipe -----

const SPEC_HINT = /^\s*["']?(openapi|swagger)["']?\s*:\s*["']?[23]/m;

export function findApiFiles(root: string): { specs: ApiSpec[]; graphql: FoundFile[]; warnings: string[] } {
	const warnings: string[] = [];
	const files = readFiles(root, {
		maxFiles: 400,
		maxBytes: 6_000_000,
		match: (rel) => /\.(ya?ml|json|graphqls?|gql)$/i.test(rel) && !/(^|\/)(package(-lock)?|tsconfig|composer|\.eslintrc|renovate)\.json$|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$|(^|\/)\.github\//i.test(rel),
	});
	const specs: ApiSpec[] = [];
	for (const f of files.filter((x) => /\.(ya?ml|json)$/i.test(x.rel))) {
		if (!SPEC_HINT.test(f.text.slice(0, 4000))) continue;
		try {
			const doc: any = f.rel.toLowerCase().endsWith(".json") ? JSON.parse(f.text) : loadYaml(f.text);
			if (doc && typeof doc === "object" && (doc.openapi || doc.swagger) && doc.paths) specs.push({ file: f.rel, doc });
		} catch (e: any) {
			warnings.push(`${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`);
		}
	}
	const graphql = files.filter((x) => /\.(graphqls?|gql)$/i.test(x.rel) && /\b(type|schema|input|interface|enum)\s+\w*\s*\{/.test(x.text));
	return { specs, graphql, warnings };
}

export const apiRecipe: Recipe = {
	id: "software.api",
	category: "software",
	title: "API surface (OpenAPI / GraphQL)",
	description:
		"Endpoints from OpenAPI / Swagger specs (v2 and v3, YAML or JSON) grouped by tag, with parameters, request and response types and the schemas they use; GraphQL schemas with queries, mutations and types. Read from a repository's files, or asked of a running API at its address.",
	mode: "inventory",
	fields: [
		{ ...FOLDER_FIELD, required: false, help: `Its OpenAPI and GraphQL files are read. Left empty with no address below: the diagram's folder. ${FOLDER_FIELD.help}` },
		{
			id: "url",
			label: "Or a running API's address",
			type: "text",
			placeholder: "https://api.example.com, or the address of its OpenAPI document or docs page",
			help: "The API is asked for its own description: the address itself, what its docs page links to, then the places frameworks usually serve it from; a GraphQL endpoint is asked for its schema. Only reads (GET, and GraphQL's schema question), only on that host, at most 40 addresses. Not every API publishes one: you are told what was asked if none is found.",
		},
		{
			id: "authorization",
			label: "Authorization header, if the API needs one",
			type: "password",
			secret: true,
			placeholder: "Bearer …",
			help: "Sent with those requests to that host only. Not saved, not drawn, not given to the agent.",
		},
	],
	async collect(input, ctx): Promise<CollectResult> {
		const started = Date.now();
		const address = (input.url ?? "").trim();
		const warnings: string[] = [];
		let specs: ApiSpec[] = [];
		let graphql: FoundFile[] = [];
		let name = "";
		let where = "";
		// a repository's files, unless only an address was given
		if (!address || (input.folder ?? "").trim()) {
			const root = folderInput(input, ctx.cwd);
			ctx.progress("Looking for OpenAPI and GraphQL files…");
			const found = findApiFiles(root);
			({ specs, graphql } = found);
			warnings.push(...found.warnings);
			name = path.basename(root);
			where = root;
		}
		// the API itself, at its address
		if (address) {
			const asked = await probeApi(address, { authorization: input.authorization, signal: ctx.signal, progress: (t) => ctx.progress(t) });
			const host = asked.origin.replace(/^https?:\/\//, "");
			if (!asked.specs.length && !asked.graphql) {
				if (!specs.length && !graphql.length) return { summary: nothingFound(asked), warnings };
				warnings.push(nothingFound(asked));
			}
			specs = [...specs, ...asked.specs];
			if (asked.graphql) graphql = [...graphql, { rel: asked.graphql.url, abs: asked.graphql.url, text: asked.graphql.sdl }];
			name = name ? `${name} + ${host}` : host;
			where = where ? `${where} or on ${host}` : host;
		}
		if (!specs.length && !graphql.length) return { summary: `No OpenAPI / Swagger spec or GraphQL schema found in ${where}.`, warnings };
		const graphs: MapGraph[] = [];
		const facts: string[] = [`# API surface of ${name}`];
		const summary: string[] = [];
		if (specs.length) {
			const r = openApiToGraph(specs, name);
			warnings.push(...r.notes);
			graphs.push(r.graph);
			summary.push(`${specs.length} OpenAPI spec(s), ${r.endpoints} endpoint(s), ${r.schemas} schema(s)`);
			for (const s of specs) {
				facts.push(`\n## ${s.doc.info?.title ?? s.file} (${s.file})`);
				for (const o of operationsOf(s.doc).slice(0, 300)) facts.push(`- ${o.method} ${o.path} [${o.group}]${o.summary ? ` — ${o.summary}` : ""}${o.security.length ? ` (auth: ${o.security.join(", ")})` : ""}`);
			}
		}
		if (graphql.length) {
			const types = graphql.flatMap((f) => parseGraphQL(f.text, f.rel));
			const g = graphqlToGraph(types, name);
			graphs.push(g);
			summary.push(`${graphql.length} GraphQL file(s), ${types.length} type(s)`);
			facts.push(`\n## GraphQL (${graphql.map((f) => f.rel).join(", ")})`);
			for (const t of types.slice(0, 300)) facts.push(`- ${t.kind} ${t.name}${t.fields.length ? `: ${t.fields.slice(0, 15).map((f) => `${f.name}${f.type ? `: ${f.type}` : ""}`).join(", ")}` : t.members ? ` = ${t.members.join(" | ")}` : ""}`);
		}
		// One map: OpenAPI specs and the GraphQL schema side by side.
		const graph: MapGraph =
			graphs.length === 1
				? graphs[0]
				: {
						title: `API · ${name}`,
						direction: "right",
						nodes: [
							...graphs[0].nodes,
							{ id: "gql:group", label: "GraphQL schema", kind: "api:graphql", container: true, style: SPEC_STYLE },
							...graphs[1].nodes.map((n) => ({ ...n, parent: n.parent ?? "gql:group" })),
						],
						edges: [...graphs[0].edges, ...graphs[1].edges],
				  };
		const { findings, checked } = specs.length ? apiFindings(specs, graph) : { findings: [], checked: [] };
		graph.legend = [
			`API surface of ${name}: ${summary.join("; ")}.`,
			"Endpoint colours: GET blue, POST green, PUT/PATCH orange, DELETE red. Rows: parameters (? = optional), body, → responses. Grey tables: schemas; arrows: types used.",
		];
		return { graph, summary: `${summary.join("; ")} (${Date.now() - started} ms)`, warnings, facts: facts.join("\n"), findings, checked };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"Review the API map on this page: find the handlers that implement the endpoints in the code and note them next to each group, mark which endpoints need authentication and which are public, and point out inconsistencies (naming, missing error responses, unused schemas, endpoints in code that are missing from the spec).",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("API endpoints / schemas (find their implementation in the code)", shapes, question || "Where is this implemented and what does it do with the data?"),
};
