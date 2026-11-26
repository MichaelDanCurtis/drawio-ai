import { loadYaml } from "../common";
import { MapperError } from "../../types";
import type { ApiSpec } from "./api";

/**
 * Finding an API's description by asking the API itself. Given the address of a running API
 * (or of its OpenAPI document, or of its docs page), this looks for the OpenAPI / Swagger
 * document the way a person would: the address itself, what its docs page links to, then the
 * places frameworks usually serve it from. For GraphQL it asks the endpoint for its schema.
 *
 * It only reads: GET requests, plus one POST per GraphQL endpoint that carries the standard
 * introspection query (a question about the schema; it runs nothing of the API's). It stays on
 * the host it was given (redirects elsewhere are not followed, and the Authorization header is
 * never sent to another host), asks a bounded number of addresses, and reads a bounded amount.
 * Not every API publishes a description: when none is found it says what it asked and what
 * answered, so the next step is clear.
 */

export interface Asked {
	url: string;
	/** The HTTP status, or what went wrong ("timeout", "refused", "redirect elsewhere"…). */
	status: number | string;
	found?: "openapi" | "graphql";
}

export interface ProbeResult {
	/** The API's address as it was understood (scheme and host). */
	origin: string;
	specs: ApiSpec[];
	/** A GraphQL schema as SDL text, and the endpoint that gave it. */
	graphql?: { sdl: string; url: string };
	asked: Asked[];
}

export interface ProbeOptions {
	/** An Authorization header value ("Bearer …"), sent to the API's own host only. Never logged. */
	authorization?: string;
	signal?: AbortSignal;
	progress?: (text: string) => void;
	/** Tests: another fetch. */
	fetch?: typeof fetch;
	timeoutMs?: number;
	deadlineMs?: number;
}

/** Where frameworks serve an OpenAPI document by default, the commonest first. */
export const USUAL_PLACES = [
	"openapi.json", "swagger.json", "v3/api-docs", "openapi.yaml", "swagger/v1/swagger.json", "api-docs", "v2/api-docs",
	"openapi/v1.json", "api-json", "docs-json", "swagger.yaml", "openapi.yml", "api/openapi.json", "api/swagger.json", "api/schema/",
	"docs/openapi.json", "swagger/doc.json", "q/openapi", ".well-known/openapi.json", "api/v1/openapi.json", "api/docs/openapi.json", "specification.json",
];
const GRAPHQL_PLACES = ["graphql", "api/graphql", "query"];
const MAX_REQUESTS = 40;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SPECS = 4;

/** The standard introspection query, without descriptions (they can be megabytes). */
const INTROSPECTION = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { kind name fields(includeDeprecated: true) { name args { name } type { ...T } } inputFields { name type { ...T } } interfaces { name } enumValues(includeDeprecated: true) { name } possibleTypes { name } } } } fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

/** The address as typed, as a URL: https unless it names this computer or a private network, where http is usual. */
export function apiAddress(typed: string): URL {
	const t = typed.trim();
	if (!t) throw new MapperError("Give the API's address.");
	const notOne = new MapperError(`${t.slice(0, 120)} is not an address. It looks like https://api.example.com or http://localhost:8080.`);
	if (/\s/.test(t) || t.length > 2000) throw notOne;
	let url: URL;
	try {
		const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|[^/:.]+(:\d+)?(\/|$))/i.test(t);
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${local ? "http" : "https"}://${t}`);
	} catch {
		throw notOne;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new MapperError("An API's address starts with http:// or https://.");
	if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i.test(url.hostname)) throw notOne;
	if (url.username || url.password) throw new MapperError("Leave the user name and password out of the address: what the API needs goes into the Authorization field.");
	// (where cloud machines keep their own credentials: never an API to map)
	if (/^169\.254\.|^\[?fd00:ec2:|^metadata\.google\.internal$|^metadata$/i.test(url.hostname)) throw new MapperError("That address is a cloud machine's own metadata service, not an API to map.");
	url.hash = "";
	return url;
}

/** An OpenAPI / Swagger document, from JSON or YAML text; undefined when the text is none. */
export function asSpec(text: string): any {
	const t = text.trimStart();
	if (!t || t.length > MAX_BYTES) return undefined;
	let doc: any;
	try {
		doc = t.startsWith("{") ? JSON.parse(t) : /^\s*["']?(openapi|swagger)["']?\s*:/m.test(t.slice(0, 4000)) ? loadYaml(t) : undefined;
	} catch {
		return undefined;
	}
	return doc && typeof doc === "object" && !Array.isArray(doc) && (doc.openapi || doc.swagger) && doc.paths && typeof doc.paths === "object" ? doc : undefined;
}

/** Addresses of API descriptions that a docs page, its start-up script or a list of documents names. */
export function specLinks(text: string, base: URL): string[] {
	const found: string[] = [];
	const add = (ref: string | undefined) => {
		if (!ref || ref.length > 500 || /[\s<>{}]/.test(ref) || /^(data|javascript|mailto):/i.test(ref)) return;
		try {
			const u = new URL(ref.replace(/&amp;/g, "&"), base);
			if (u.origin === base.origin && !found.includes(u.toString())) found.push(u.toString());
		} catch {
			// not an address
		}
	};
	const body = text.slice(0, 600_000);
	// Swagger UI (`url: "…"`, `urls: [{ url: "…" }]`), its config document, Redoc / RapiDoc / Scalar (`spec-url`, `data-url`)
	for (const m of body.matchAll(/["']?\burl["']?\s*[:=]\s*["']([^"']+)["']/g)) add(m[1]);
	for (const m of body.matchAll(/\b(?:spec-url|data-url|data-spec-url|apiDescriptionUrl|specUrl|configUrl)\s*[:=]\s*["']([^"']+)["']/gi)) add(m[1]);
	for (const m of body.matchAll(/<link\b[^>]*\brel=["'](?:service-desc|openapi)["'][^>]*>/gi)) add(/\bhref=["']([^"']+)["']/i.exec(m[0])?.[1]);
	// anything named like one, however the page writes it down (quoted, in a list, in a template)
	for (const m of body.matchAll(/(?:^|["'`(=,\s])((?:https?:\/\/|\.{0,2}\/)?[^"'`()=,\s<>]*(?:openapi|swagger|api-docs)[^"'`()=,\s<>]*\.(?:json|ya?ml)(?:\?[^"'`()=,\s<>]*)?)(?=$|["'`),\s<])/gim)) add(m[1]);
	// the page's own start-up scripts, where Swagger UI keeps the address
	for (const m of body.matchAll(/<script\b[^>]*\bsrc=["']([^"']*(?:swagger-initializer|swagger-ui-init|swagger-config)[^"']*)["']/gi)) add(m[1]);
	return found.filter((u) => !/\.(css|png|svg|ico|map|woff2?)(\?|$)/i.test(u) && !/swagger-ui(-bundle|-standalone-preset)?(\.min)?\.js/i.test(u)).slice(0, 12);
}

/** A GraphQL schema from an introspection answer, as SDL text (what parseGraphQL reads). */
export function introspectionToSdl(answer: any): string | undefined {
	const schema = answer?.data?.__schema ?? answer?.__schema;
	if (!schema || !Array.isArray(schema.types)) return undefined;
	const ref = (t: any): string => (!t ? "Unknown" : t.kind === "NON_NULL" ? `${ref(t.ofType)}!` : t.kind === "LIST" ? `[${ref(t.ofType)}]` : String(t.name ?? "Unknown"));
	const word = (s: unknown) => (typeof s === "string" && /^[_A-Za-z]\w*$/.test(s) ? s : undefined);
	const roots: Record<string, string> = {};
	for (const [key, usual] of [["queryType", "Query"], ["mutationType", "Mutation"], ["subscriptionType", "Subscription"]] as const) if (word(schema[key]?.name)) roots[schema[key].name] = usual;
	const out: string[] = [];
	for (const t of schema.types.slice(0, 5000)) {
		const name = word(t?.name);
		if (!name || name.startsWith("__")) continue;
		// (the roots go by their usual names, whatever the API calls them: that is what the map looks for)
		const shown = roots[name] ?? name;
		const fields = (list: any[]) =>
			(list ?? [])
				.filter((f) => word(f?.name))
				.map((f) => `  ${f.name}${Array.isArray(f.args) && f.args.length ? `(${f.args.filter((a: any) => word(a?.name)).map((a: any) => `${a.name}: String`).join(", ")})` : ""}: ${ref(f.type)}`)
				.join("\n");
		const impl = (t.interfaces ?? []).map((i: any) => word(i?.name)).filter(Boolean);
		if (t.kind === "OBJECT") out.push(`type ${shown}${impl.length ? ` implements ${impl.join(" & ")}` : ""} {\n${fields(t.fields)}\n}`);
		else if (t.kind === "INTERFACE") out.push(`interface ${shown} {\n${fields(t.fields)}\n}`);
		else if (t.kind === "INPUT_OBJECT") out.push(`input ${shown} {\n${fields(t.inputFields)}\n}`);
		else if (t.kind === "ENUM") out.push(`enum ${shown} {\n${(t.enumValues ?? []).map((v: any) => word(v?.name)).filter(Boolean).map((v: string) => `  ${v}`).join("\n")}\n}`);
		else if (t.kind === "UNION") out.push(`union ${shown} = ${(t.possibleTypes ?? []).map((p: any) => word(p?.name)).filter(Boolean).join(" | ")}`);
		else if (t.kind === "SCALAR" && !["String", "Int", "Float", "Boolean", "ID"].includes(name)) out.push(`scalar ${shown}`);
	}
	return out.length ? out.join("\n\n") : undefined;
}

/** Asks the API for its description. Never throws for an API that has none: the result says what was asked. */
export async function probeApi(typed: string, o: ProbeOptions = {}): Promise<ProbeResult> {
	const start = apiAddress(typed);
	const doFetch = o.fetch ?? fetch;
	const deadline = Date.now() + (o.deadlineMs ?? 45_000);
	const asked: Asked[] = [];
	const seen = new Set<string>();
	const docs = new Set<string>();
	const specs: ApiSpec[] = [];
	const auth = o.authorization?.trim();
	const cancelled = () => {
		if (o.signal?.aborted) throw new MapperError("Cancelled");
	};
	const room = () => asked.length < MAX_REQUESTS && Date.now() < deadline;
	/**
	 * Whether an address is the API's own place: the scheme, host and port that were given, or
	 * that host over https when http was given. Everything that is asked passes this, wherever
	 * the address came from (a redirect, a link on a page, a Link header), because the
	 * Authorization header goes with every request: another host, another port, or plain http
	 * where https was given, is asked nothing and told nothing.
	 */
	const own = (u: URL) => (u.protocol === start.protocol && u.host === start.host) || (start.protocol === "http:" && u.protocol === "https:" && u.hostname === start.hostname);

	/** One request, on the API's own host: a redirect is followed only when it stays there. */
	async function ask(url: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; text: string; type: string; link: string; url: URL } | undefined> {
		let at = new URL(url);
		const entry: Asked = { url: display(at), status: "no answer" };
		asked.push(entry);
		for (let hop = 0; hop < 4; hop++) {
			cancelled();
			if (!own(at)) {
				entry.status = "sent elsewhere";
				return undefined;
			}
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), Math.max(500, Math.min(o.timeoutMs ?? 8000, deadline - Date.now())));
			const onAbort = () => ctrl.abort();
			o.signal?.addEventListener("abort", onAbort);
			try {
				const res = await doFetch(at, {
					method: init.method ?? "GET",
					redirect: "manual",
					signal: ctrl.signal,
					headers: {
						Accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5",
						...(init.body ? { "Content-Type": "application/json" } : {}),
						...(auth ? { Authorization: auth } : {}),
					},
					...(init.body ? { body: init.body } : {}),
				});
				if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
					const to = new URL(res.headers.get("location")!, at);
					// (the same place, also when it only moves from http to https: nothing is asked of, or told to, another one)
					// (a question, the one POST there is, goes on to where it was sent only as a question: 307 / 308,
					// and 301 / 302 as servers use them for a missing slash; "see other" would make it a plain read)
					if (!own(to) || (init.method === "POST" && res.status === 303)) {
						entry.status = to.hostname !== start.hostname ? "sent elsewhere" : res.status;
						return undefined;
					}
					at = to;
					continue;
				}
				entry.status = res.status;
				if (!res.ok) return { status: res.status, text: "", type: "", link: "", url: at };
				return { status: res.status, text: await limited(res), type: res.headers.get("content-type") ?? "", link: res.headers.get("link") ?? "", url: at };
			} catch (e: any) {
				cancelled();
				entry.status = ctrl.signal.aborted ? "no answer in time" : String(e?.cause?.code ?? e?.code ?? "could not connect").slice(0, 40);
				return undefined;
			} finally {
				clearTimeout(timer);
				o.signal?.removeEventListener("abort", onAbort);
			}
		}
		entry.status = "too many redirects";
		return undefined;
	}

	/** Looks at one address: a description, or a page or list that names some. */
	async function look(url: string, depth = 0): Promise<void> {
		const key = url.replace(/\/+$/, "");
		if (seen.has(key) || !room() || specs.length >= MAX_SPECS) return;
		seen.add(key);
		const r = await ask(url);
		if (!r || r.status >= 400) return;
		const doc = asSpec(r.text);
		if (doc) {
			asked[asked.length - 1].found = "openapi";
			// (two addresses can hand out the same document; and two documents can be at one address,
			// told apart only by its query, which is not shown: each is then numbered, to be its own)
			const text = JSON.stringify(doc);
			if (docs.has(text)) return;
			docs.add(text);
			const name = display(r.url);
			const others = specs.filter((s) => s.file === name || s.file.startsWith(`${name} #`)).length;
			specs.push({ file: others ? `${name} #${others + 1}` : name, doc });
			return;
		}
		if (depth >= 2) return;
		const links = specLinks(r.text, r.url);
		for (const m of r.link.matchAll(/<([^>]+)>\s*;[^,]*\brel="?(?:service-desc|openapi)"?/gi)) {
			try {
				links.unshift(new URL(m[1], r.url).toString());
			} catch {
				// not an address
			}
		}
		// (a description that is said to be somewhere else is not fetched: see `own`)
		for (const l of links) if (own(new URL(l))) await look(l, depth + 1);
	}

	/** Asks GraphQL endpoints for their schema, until one answers with it. */
	let graphql: ProbeResult["graphql"];
	async function askGraphql(ends: string[]): Promise<void> {
		for (const end of ends) {
			if (graphql || !room()) break;
			const r = await ask(end, { method: "POST", body: JSON.stringify({ query: INTROSPECTION, operationName: "IntrospectionQuery" }) });
			if (!r || !r.text) continue;
			let sdl: string | undefined;
			try {
				sdl = introspectionToSdl(JSON.parse(r.text));
			} catch {
				// not a GraphQL answer
			}
			if (sdl) {
				asked[asked.length - 1].found = "graphql";
				graphql = { sdl, url: display(r.url) };
			}
		}
	}

	o.progress?.(`Asking ${start.host} for its API description…`);
	await look(start.toString());
	// an address that names a GraphQL endpoint: that is what it is asked about
	if (!specs.length && /graphql|gql/i.test(start.pathname)) await askGraphql([start.toString()]);
	// the usual places: under the address that was given (the commonest ones), then at the top of the host
	if (!specs.length && !graphql) {
		const under = new URL(start.pathname.endsWith("/") ? start.pathname : `${start.pathname}/`, start).toString();
		const top = `${start.origin}/`;
		const places = [...(under === top ? [] : USUAL_PLACES.slice(0, 10).map((p) => new URL(p, under).toString())), ...USUAL_PLACES.map((p) => new URL(p, top).toString())].filter((u, i, all) => all.indexOf(u) === i);
		// (a few at a time: quick on an API that has none, and gentle on it; room is kept for the GraphQL question)
		for (let i = 0; i < places.length && !specs.length && asked.length < MAX_REQUESTS - GRAPHQL_PLACES.length - 4 && room(); i += 4) await Promise.all(places.slice(i, i + 4).map((u) => look(u, 1)));
	}
	// nothing yet: the usual GraphQL endpoints
	if (!specs.length && !graphql) await askGraphql(GRAPHQL_PLACES.map((p) => new URL(p, `${start.origin}/`).toString()));
	return { origin: start.origin, specs, ...(graphql ? { graphql } : {}), asked };
}

/** What a failed look for an API's description tells the user: what was asked, what answered, and what to try. */
export function nothingFound(r: ProbeResult): string {
	const statuses = r.asked.map((a) => a.status);
	const count = (s: number | string) => statuses.filter((x) => x === s).length;
	const host = r.origin.replace(/^https?:\/\//, "");
	if (statuses.length && statuses.every((s) => typeof s === "string")) return `${host} could not be reached (${[...new Set(statuses)].slice(0, 3).join(", ")}). Check the address, and that this computer can reach it.`;
	const denied = count(401) + count(403);
	const most = denied > statuses.length / 2 ? `it asked for a sign-in at ${denied} of them (put what it needs into the Authorization field)` : count(404) > statuses.length / 2 ? "most are not there (404)" : `the answers were ${[...new Set(statuses)].slice(0, 5).join(", ")}`;
	return `No OpenAPI / Swagger document or GraphQL schema was found on ${host}: ${statuses.length} addresses were asked and ${most}. Not every API publishes one. If this one does, give the address of the document itself (it often ends in /openapi.json, /swagger.json or /v3/api-docs), or map its repository.`;
}

/** An address as it is shown: without what could be a secret (a query, a sign-in). */
function display(u: URL): string {
	return `${u.origin}${u.pathname}`;
}

async function limited(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return (await res.text()).slice(0, MAX_BYTES);
	const chunks: Buffer[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel().catch(() => undefined);
			return "";
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks).toString("utf8");
}
