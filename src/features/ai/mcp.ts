import type { IncomingMessage, ServerResponse } from "http";

// Model Context Protocol (Streamable HTTP, JSON responses only) for the diagram tools.
// No vscode import, so it can be unit-tested with a plain Node HTTP server.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface McpTool {
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
}

export interface McpToolResult {
	text: string;
	image?: { mimeType: string; base64: string };
	isError?: boolean;
}

export interface McpHandlerDeps {
	serverVersion: string;
	tools(): McpTool[];
	callTool(name: string, args: unknown): Promise<McpToolResult>;
	instructions(): Promise<string>;
}

type JsonRpcId = string | number | null;

const error = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Handles one JSON-RPC message; returns undefined for notifications. */
export async function handleMcpMessage(msg: any, deps: McpHandlerDeps): Promise<object | undefined> {
	if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
		return msg && typeof msg === "object" && "result" in msg ? undefined : error(msg?.id ?? null, -32600, "Invalid JSON-RPC request");
	}
	const isNotification = !("id" in msg);
	if (isNotification) return undefined;
	const id: JsonRpcId = msg.id;
	const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			return ok({
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "draw-ai", title: "Draw.AI", version: deps.serverVersion },
				instructions: await deps.instructions(),
			});
		}
		case "ping":
			return ok({});
		case "tools/list":
			return ok({
				tools: deps.tools().map((t) => ({
					name: t.name,
					title: t.title,
					description: t.description,
					inputSchema: t.inputSchema,
					annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, openWorldHint: false },
				})),
			});
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string" || !deps.tools().some((t) => t.name === name)) {
				return error(id, -32602, `Unknown tool: ${String(name)}`);
			}
			try {
				const r = await deps.callTool(name, msg.params?.arguments ?? {});
				const content: object[] = [{ type: "text", text: r.text }];
				if (r.image) content.push({ type: "image", data: r.image.base64, mimeType: r.image.mimeType });
				return ok({ content, isError: !!r.isError });
			} catch (e: any) {
				return ok({ content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
			}
		}
		default:
			return error(id, -32601, `Method not found: ${msg.method}`);
	}
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostOk(value: string | undefined, port: number): boolean {
	if (!value) return false;
	const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value.trim().toLowerCase());
	return !!m && LOCAL_HOSTS.has(m[1]) && (!m[2] || Number(m[2]) === port);
}

function originOk(origin: string | undefined, port: number): boolean {
	if (origin === undefined) return true; // non-browser clients
	try {
		const u = new URL(origin);
		return (u.protocol === "http:" || u.protocol === "https:") && hostOk(u.host, port);
	} catch {
		return false;
	}
}

/**
 * Request listener for the MCP endpoint. Only answers on POST /mcp with the bearer
 * token; rejects foreign Host/Origin headers (DNS rebinding) and oversized bodies.
 */
export function createMcpListener(options: {
	token: () => string;
	port: () => number;
	deps: McpHandlerDeps;
	onCall?: (name: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => void {
	const send = (res: ServerResponse, status: number, body?: object, headers: Record<string, string> = {}) => {
		const text = body ? JSON.stringify(body) : "";
		res.writeHead(status, { ...(body ? { "content-type": "application/json" } : {}), "cache-control": "no-store", ...headers });
		res.end(text);
	};
	return (req, res) => {
		const port = options.port();
		const url = (req.url ?? "").split("?")[0];
		if (!hostOk(req.headers.host, port) || !originOk(req.headers.origin as string | undefined, port)) {
			req.resume();
			return send(res, 403, error(null, -32000, "Forbidden origin"));
		}
		if (url !== "/mcp") {
			req.resume();
			return send(res, 404, error(null, -32000, "Not found; the endpoint is /mcp"));
		}
		const auth = req.headers.authorization ?? "";
		const token = options.token();
		if (!token || !auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7).trim(), token)) {
			req.resume();
			return send(res, 401, error(null, -32001, "Missing or invalid bearer token"), { "www-authenticate": 'Bearer realm="drawio-ai"' });
		}
		if (req.method !== "POST") {
			req.resume();
			return send(res, 405, error(null, -32000, "Only POST is supported (no server-initiated streams)"), { allow: "POST" });
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				send(res, 413, error(null, -32600, "Request too large"));
				req.destroy();
			} else if (!aborted) {
				chunks.push(c);
			}
		});
		req.on("end", async () => {
			if (aborted) return;
			let msg: any;
			try {
				msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return send(res, 400, error(null, -32700, "Parse error"));
			}
			try {
				if (Array.isArray(msg)) {
					const results = (await Promise.all(msg.map((m) => handleMcpMessage(m, options.deps)))).filter(Boolean) as object[];
					return results.length ? send(res, 200, results) : send(res, 202);
				}
				if (msg?.method === "tools/call" && typeof msg.params?.name === "string") options.onCall?.(msg.params.name);
				const result = await handleMcpMessage(msg, options.deps);
				return result ? send(res, 200, result) : send(res, 202);
			} catch (e: any) {
				return send(res, 500, error(msg?.id ?? null, -32603, String(e?.message ?? e)));
			}
		});
	};
}
