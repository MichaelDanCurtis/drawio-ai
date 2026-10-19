import * as http from "http";
import { fileURLToPath } from "url";
import { CLIENT_HEADER, handleMcpMessage, McpHandlerDeps } from "../features/ai/mcp";
import { mcpInstructions } from "../features/ai/systemPrompt";
import { toMcpTools } from "../features/ai/toolSchemas";
import { AgentInstance, pickInstance, readInstances } from "./discovery";

// The agent bridge: a stdio MCP server that Claude Code, Codex and other agents
// start through the Draw.AI agent plugin. It lists the tools itself (so they are
// there even before VS Code runs) and forwards every tool call to the VS Code
// window that has the diagram, over that window's loopback MCP endpoint.
// It never edits a diagram itself.

export const NOT_RUNNING =
	"Draw.AI is not reachable: no VS Code window with the Draw.AI extension is serving MCP. Ask the user to open the project in VS Code with Draw.AI and run \"Draw.AI: Connect Claude Code / Codex…\" (or turn on the setting drawio-ai.mcp.enabled), then try again.";

export interface BridgeOptions {
	/** `~/.drawio-ai` */
	home: string;
	env: NodeJS.ProcessEnv;
	version: string;
	/** Sends one JSON-RPC message to the agent. */
	write(message: object): void;
	log?(text: string): void;
	/** How long to wait for a window when fetching instructions. */
	initializeTimeoutMs?: number;
}

type JsonRpcId = string | number;

export class AgentBridge {
	private clientName: string | undefined;
	private clientRoots = false;
	private roots: string[] = [];
	private nextRequest = 1;
	private readonly pending = new Map<JsonRpcId, (message: any) => void>();

	private readonly deps: McpHandlerDeps = {
		serverVersion: this.options.version,
		tools: toMcpTools,
		// tools/call never reaches handleMcpMessage: receive() forwards it as is.
		callTool: async () => ({ text: NOT_RUNNING, isError: true }),
		instructions: () => this.instructions(),
	};

	constructor(private readonly options: BridgeOptions) {}

	/** Handles one message from the agent. */
	public async receive(msg: any): Promise<void> {
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
			const res = await handleMcpMessage(msg, this.deps);
			if (res) this.options.write(res);
			return;
		}
		// The agent's answer to a request of ours (roots/list).
		if (!("method" in msg) && "id" in msg) {
			const resolve = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			resolve?.(msg);
			return;
		}
		switch (msg.method) {
			case "initialize":
				this.clientName = typeof msg.params?.clientInfo?.name === "string" ? msg.params.clientInfo.name : undefined;
				this.clientRoots = !!msg.params?.capabilities?.roots;
				break;
			case "notifications/initialized":
			case "notifications/roots/list_changed":
				if (this.clientRoots) void this.refreshRoots();
				return;
			case "tools/call":
				if ("id" in msg) {
					this.options.write(await this.forward(msg));
					return;
				}
				break;
		}
		const res = await handleMcpMessage(msg, this.deps);
		if (res) this.options.write(res);
	}

	/** Folders the agent works in: its MCP roots, else hints from the environment. */
	private hintRoots(): string[] {
		const env = this.options.env;
		// Claude Code starts MCP servers in the project folder and sets CLAUDE_PROJECT_DIR (and PWD).
		return [...this.roots, env.DRAWIO_AI_WORKSPACE, env.CLAUDE_PROJECT_DIR, env.PWD].filter((r): r is string => !!r);
	}

	private route(file: string | undefined, skip: Set<number>): AgentInstance | undefined {
		const instances = readInstances(this.options.home).filter((i) => !skip.has(i.pid));
		return pickInstance(instances, { file, roots: this.hintRoots() })?.instance;
	}

	/** Forwards a tools/call; retries another window if one is gone, and re-reads the token once on 401. */
	private async forward(msg: any): Promise<object> {
		const args = msg.params?.arguments ?? {};
		const file =
			typeof args.file === "string" ? args.file : msg.params?.name === "drawio_create" && typeof args.path === "string" ? args.path : undefined;
		const skip = new Set<number>();
		let unauthorized = 0;
		for (let attempt = 0; attempt < 4; attempt++) {
			const instance = this.route(file, skip);
			if (!instance) break;
			try {
				const reply = await this.post(instance, { jsonrpc: "2.0", id: msg.id, method: "tools/call", params: msg.params });
				if (reply.status === 401 && unauthorized++ === 0) continue; // the token was regenerated; read it again
				if (reply.status === 200 && reply.body?.id === msg.id) return reply.body;
				const reason = typeof reply.body?.error?.message === "string" ? `: ${reply.body.error.message}` : "";
				return toolError(msg.id, `Draw.AI in VS Code refused the call (HTTP ${reply.status}${reason}).`);
			} catch (e: any) {
				this.options.log?.(`window ${instance.pid} (port ${instance.port}) did not answer: ${e?.code ?? e?.message ?? e}`);
				skip.add(instance.pid);
			}
		}
		return toolError(msg.id, NOT_RUNNING);
	}

	private post(instance: AgentInstance, body: object, timeoutMs?: number): Promise<{ status: number; body: any }> {
		const data = Buffer.from(JSON.stringify(body));
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					host: "127.0.0.1",
					port: instance.port,
					path: "/mcp",
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
						"content-length": data.length,
						authorization: `Bearer ${instance.token}`,
						...(this.clientName ? { [CLIENT_HEADER]: this.clientName } : {}),
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let parsed: any;
						try {
							parsed = text ? JSON.parse(text) : undefined;
						} catch {
							parsed = undefined;
						}
						resolve({ status: res.statusCode ?? 0, body: parsed });
					});
					res.on("error", reject);
				}
			);
			req.on("error", reject);
			if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
			req.end(data);
		});
	}

	/** The window's own instructions (they include the repository's design template), else the generic ones. */
	private async instructions(): Promise<string> {
		const instance = this.route(undefined, new Set());
		if (instance) {
			try {
				const reply = await this.post(
					instance,
					{ jsonrpc: "2.0", id: "bridge-initialize", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "draw-ai-bridge", version: this.options.version } } },
					this.options.initializeTimeoutMs ?? 2000
				);
				const text = reply.body?.result?.instructions;
				if (typeof text === "string" && text) return text;
			} catch {
				// Fall back to the generic instructions.
			}
		}
		return mcpInstructions();
	}

	private async refreshRoots(): Promise<void> {
		const id = `draw-ai-roots-${this.nextRequest++}`;
		const answer = new Promise<any>((resolve) => {
			this.pending.set(id, resolve);
			setTimeout(() => {
				if (this.pending.delete(id)) resolve(undefined);
			}, 5000);
		});
		this.options.write({ jsonrpc: "2.0", id, method: "roots/list" });
		const reply = await answer;
		const roots = Array.isArray(reply?.result?.roots) ? reply.result.roots : [];
		this.roots = roots
			.map((r: any) => {
				try {
					return typeof r?.uri === "string" && r.uri.startsWith("file:") ? fileURLToPath(r.uri) : undefined;
				} catch {
					return undefined;
				}
			})
			.filter((p: string | undefined): p is string => !!p);
	}
}

function toolError(id: JsonRpcId, text: string): object {
	return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}
