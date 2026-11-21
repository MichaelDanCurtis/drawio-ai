/**
 * Turns the Mapper form into connection settings per engine, keeps track of every
 * value that must never be shown (connection string, user, password, host), and
 * scrubs those from driver error messages.
 */
import * as path from "path";
import { MapperError } from "../../types";
import type { CollectContext, MapInput } from "../../types";
import type { EngineId } from "./model";

export type TlsMode = "auto" | "on" | "on-trust" | "off";

export interface ConnSpec {
	engine: EngineId;
	/** The connection string as typed (secret), when the user gave one. */
	url?: string;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	password?: string;
	tls: TlsMode;
	/** SQLite file. */
	file?: string;
	/** Every value that must not appear in anything the Mapper shows or sends. */
	secrets: string[];
}

export const DEFAULT_PORTS: Partial<Record<EngineId, number>> = { postgres: 5432, mysql: 3306, mssql: 1433, oracle: 1521, mongodb: 27017 };

/** Seconds to wait for a connection, and for each catalog query. */
export const CONNECT_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 60_000;

function addSecret(list: string[], v: string | undefined | null) {
	if (!v) return;
	const s = String(v);
	if (s.length < 2) return;
	list.push(s);
	try {
		const enc = encodeURIComponent(s);
		if (enc !== s) list.push(enc);
		const dec = decodeURIComponent(s);
		if (dec !== s) list.push(dec);
	} catch {
		// not URI-encodable: the raw value is enough
	}
}

/** Pulls user / password / hosts out of URL-, ADO- and Easy-Connect-style strings. */
export function secretsOfConnectionString(s: string): string[] {
	const out: string[] = [];
	addSecret(out, s);
	const uri = /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?#]*)/i.exec(s);
	if (uri) {
		addSecret(out, uri[1]);
		addSecret(out, uri[2]);
		for (const h of (uri[3] ?? "").split(",")) {
			addSecret(out, h);
			addSecret(out, h.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
		}
	}
	for (const m of s.matchAll(/(?:^|;)\s*(password|pwd|user id|uid|user|username|server|data source|address|addr|host)\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\}|[^;]*)/gi)) {
		const v = m[2].replace(/^["'{]|["'}]$/g, "").trim();
		addSecret(out, v);
		const host = v.replace(/^tcp:/i, "").replace(/[,:]\d+$/, "").replace(/\\.*$/, "");
		addSecret(out, host);
	}
	// Oracle style user/password@host:port/service
	const ez = /^([^/@\s]+)\/([^@\s]+)@\/*([^:/\s]+)/.exec(s);
	if (ez) [ez[1], ez[2], ez[3]].forEach((v) => addSecret(out, v));
	return out;
}

/**
 * Removes connection details from a message: credentials in URIs, key=value
 * secrets, every known secret value, and IP addresses.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
	let out = String(text ?? "");
	out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, "$1***@");
	out = out.replace(/\b(password|pwd|user id|uid|username|data source)\s*=\s*("[^"]*"|'[^']*'|[^;\s,]*)/gi, "$1=***");
	const sorted = [...new Set(secrets.filter((s) => s && s.length >= 2))].sort((a, b) => b.length - a.length);
	for (const s of sorted) {
		// Short values (a user called "sa") only as whole words, to keep the message readable.
		if (s.length < 4) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g"), "***");
		else out = out.split(s).join("***");
	}
	out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<host>");
	// IPv6 (with "::" or many groups; not times like 10:15:30).
	out = out.replace(/\[?(?<![0-9a-z:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![0-9a-z:])\]?/gi, (m) => (m.includes("::") || (m.match(/:/g)?.length ?? 0) >= 5 ? "<host>" : m));
	return out;
}

const on = (v: string | undefined) => v === "true" || v === "1" || v === "on" || v === "yes";

export function isOn(v: string | undefined, dflt = false): boolean {
	return v === undefined || v === "" ? dflt : on(v);
}

/** Reads the form. Throws a MapperError (without secrets) when something is missing. */
export function connSpecFromInput(input: MapInput, ctx: Pick<CollectContext, "cwd">): ConnSpec {
	const engine = (input.engine || "postgres") as EngineId;
	if (!["postgres", "mysql", "mssql", "oracle", "sqlite", "mongodb"].includes(engine)) throw new MapperError(`Unknown database engine "${engine}".`);
	const tls = (["auto", "on", "on-trust", "off"].includes(input.tls) ? input.tls : "auto") as TlsMode;
	const secrets: string[] = [];
	if (engine === "sqlite") {
		const raw = (input.file || "").trim();
		if (!raw) throw new MapperError("Choose the SQLite database file.");
		return { engine, file: path.resolve(ctx.cwd, raw), tls, secrets };
	}
	const useUrl = (input.connectWith || (input.connectionString ? "url" : "fields")) === "url";
	if (useUrl) {
		const url = (input.connectionString || "").trim();
		if (!url) throw new MapperError("Enter the connection string, or choose \"Host and credentials\".");
		secrets.push(...secretsOfConnectionString(url));
		return { engine, url, tls, secrets, database: (input.database || "").trim() || undefined };
	}
	const host = (input.host || "").trim();
	if (!host) throw new MapperError("Enter the database host.");
	const port = input.port ? Number(input.port) : DEFAULT_PORTS[engine];
	if (!port || !Number.isInteger(port) || port <= 0 || port > 65535) throw new MapperError("The port must be a number between 1 and 65535.");
	const user = (input.user || "").trim() || undefined;
	const password = input.password || undefined;
	addSecret(secrets, host);
	addSecret(secrets, user);
	addSecret(secrets, password);
	addSecret(secrets, `${host}:${port}`);
	return { engine, host, port, database: (input.database || "").trim() || undefined, user, password, tls, secrets };
}

/** A friendlier, secret-free error for anything a driver throws. */
export function connectionError(e: any, spec: ConnSpec): MapperError {
	if (e instanceof MapperError && /^Cancelled/.test(e.message)) return e;
	const code = String(e?.code ?? e?.errno ?? "");
	const raw = [e?.message, ...(Array.isArray(e?.errors) ? e.errors.map((x: any) => x?.message) : [])].filter(Boolean).join(" · ") || String(e);
	const message = scrubSecrets(raw, spec.secrets).slice(0, 600);
	let hint: string | undefined;
	if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|ESOCKET|timed? ?out|Server selection/i.test(code + " " + raw))
		hint = "Is the database running and reachable from this computer (VPN, firewall, allow-listed IP)?";
	else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(code + " " + raw)) hint = "Check the host name.";
	else if (/password|authenticat|login failed|access denied|ORA-01017|28P01|ER_ACCESS_DENIED/i.test(raw)) hint = "Check the user name and password.";
	else if (/self[- ]signed|certificate|SSL|TLS/i.test(raw)) hint = "Try the TLS option \"Required, trust the server certificate\" (or \"Off\" for a local database).";
	else if (/does not exist|Unknown database|Cannot open database|ORA-12514/i.test(raw)) hint = "Check the database (or service) name.";
	else if (/permission denied|insufficient privileges|not authorized|ORA-01031|ORA-00942/i.test(raw)) hint = "The user may lack read access to the catalog; a read-only user with SELECT on the schemas is enough.";
	return new MapperError(`${message}${code && !message.includes(code) ? ` (${scrubSecrets(code, spec.secrets)})` : ""}`, hint);
}

/** Calls `close` when the run is cancelled; returns a function that stops listening. */
export function onAbort(signal: AbortSignal, close: () => unknown): () => void {
	const handler = () => {
		try {
			Promise.resolve(close()).catch(() => undefined);
		} catch {
			// already closed
		}
	};
	if (signal.aborted) handler();
	signal.addEventListener("abort", handler, { once: true });
	return () => signal.removeEventListener("abort", handler);
}

/** Closes a connection without waiting forever or throwing. */
export async function closeQuietly(close: () => unknown, ms = 3000): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([Promise.resolve().then(close), new Promise((r) => (timer = setTimeout(r, ms)))]);
	} catch {
		// already closed or broken
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Settles with the promise, or rejects with "Cancelled" as soon as the run is cancelled (drivers may not settle once closed). */
export function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => undefined);
		return Promise.reject(new MapperError("Cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbortReject = () => reject(new MapperError("Cancelled"));
		signal.addEventListener("abort", onAbortReject, { once: true });
		promise.then(
			(v) => (signal.removeEventListener("abort", onAbortReject), resolve(v)),
			(e) => (signal.removeEventListener("abort", onAbortReject), reject(e))
		);
	});
}

export function checkAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new MapperError("Cancelled");
}

/** Schema filter for SQL: a comma list ("" = all non-system schemas). */
export function schemaParam(schemas: string[]): string {
	return schemas.join(",");
}
