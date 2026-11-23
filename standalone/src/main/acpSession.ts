import * as acp from "@agentclientprotocol/sdk";
import { ChildProcess, spawn } from "child_process";
import { Readable, Writable } from "stream";
import type { AgentDef, LaunchSpec } from "./agents";

export interface McpEndpoint {
	url: string;
	token: string;
	/** Script that bridges stdio to `url`, for agents without HTTP MCP support. */
	stdioProxy: string;
}

export interface SessionHandlers {
	onUpdate(update: acp.SessionUpdate): void;
	requestPermission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionOutcome>;
	/** The agent process ended (or could not start). */
	onExit(message: string): void;
	/** Something the user should know that is not an answer (a conversation that had to start over). */
	onNote?(text: string): void;
}

export interface SessionInfo {
	sessionId: string;
	agentName: string;
	modes?: acp.SessionModeState | null;
	configOptions?: acp.SessionConfigOption[] | null;
	authMethods: acp.AuthMethod[];
	images: boolean;
	/** How an agent program reaches the app's tools. Not set for a model used through its API: the app runs them itself. */
	mcpTransport?: "http" | "stdio";
}

/**
 * Whoever answers the chat: an agent program over ACP (AcpAgentSession, below), or a provider's
 * model over its API (api/chatSession.ts). The chat talks to both the same way.
 */
export interface ChatSession {
	/** Set once the session is ready for a request. */
	readonly info: SessionInfo | undefined;
	readonly label: string;
	start(): Promise<SessionInfo>;
	authenticate(methodId: string): Promise<SessionInfo>;
	prompt(blocks: acp.ContentBlock[]): Promise<acp.StopReason>;
	cancel(): void;
	setConfigOption(configId: string, value: string): Promise<acp.SessionConfigOption[] | undefined>;
	setMode(modeId: string): Promise<void>;
	dispose(): void;
}

export class AuthRequiredError extends Error {
	constructor(message: string, public readonly methods: acp.AuthMethod[]) {
		super(message);
	}
}

/**
 * One coding agent, started in ACP mode, with one session whose cwd is the
 * diagram's folder and whose MCP servers include this window's OmniDraw tools.
 */
export class AcpAgentSession implements ChatSession {
	private child: ChildProcess | undefined;
	private connection: acp.ClientConnection | undefined;
	private stderr: string[] = [];
	private exited = false;
	public info: SessionInfo | undefined;
	private init: acp.InitializeResponse | undefined;

	constructor(
		private readonly def: AgentDef,
		private readonly launch: LaunchSpec,
		private readonly cwd: string,
		/** This window's OmniDraw tools; undefined for a session that only asks what the agent offers. */
		private readonly mcp: McpEndpoint | undefined,
		private readonly handlers: SessionHandlers
	) {}

	public get label(): string {
		return this.info?.agentName ?? this.launch.label ?? this.def.label;
	}

	public async start(): Promise<SessionInfo> {
		const child = spawn(this.launch.command, this.launch.args, {
			cwd: this.cwd,
			env: this.launch.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (d: string) => {
			this.stderr.push(...d.split("\n").filter((l) => l.trim()));
			if (this.stderr.length > 40) this.stderr.splice(0, this.stderr.length - 40);
		});
		const spawned = new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.connection?.close();
			this.handlers.onExit(
				`${this.def.label} stopped (${signal ?? `exit code ${code}`}).${this.stderrTail() ? `\n${this.stderrTail()}` : ""}`
			);
		});
		await spawned;

		const stream = acp.ndJsonStream(
			Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>
		);
		const app = acp
			.client({ name: "OmniDraw" })
			.onNotification("session/update", ({ params }) => {
				if (params.sessionId === this.info?.sessionId) this.handlers.onUpdate(params.update);
			})
			.onRequest("session/request_permission", async ({ params, signal }) => ({
				outcome: await this.handlers.requestPermission(params, signal),
			}));
		this.connection = app.connect(stream);
		const agent = this.connection.agent;

		this.init = await this.withExit(
			agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "omnidraw", title: "OmniDraw", version: "0.1.0" },
			}),
			"initialize"
		);
		return this.newSession();
	}

	private async newSession(): Promise<SessionInfo> {
		const init = this.init!;
		const http = !!init.agentCapabilities?.mcpCapabilities?.http;
		const mcp = this.mcp;
		const mcpServers: acp.McpServer[] = !mcp
			? []
			: http
			? [{ type: "http", name: "omnidraw", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }] }]
			: [
					{
						name: "omnidraw",
						command: process.execPath,
						args: [mcp.stdioProxy, mcp.url],
						env: [
							{ name: "ELECTRON_RUN_AS_NODE", value: "1" },
							{ name: "DRAWAI_MCP_TOKEN", value: mcp.token },
						],
					},
			  ];
		let created: acp.NewSessionResponse;
		try {
			created = await this.withExit(this.connection!.agent.request("session/new", { cwd: this.cwd, mcpServers }), "session/new");
		} catch (e: any) {
			// -32000 is ACP's auth_required. Keep the agent's own words: they say what is wrong
			// (expired sign-in, unsupported account type, missing API key, ...).
			if (e?.code === -32000) {
				const said = String(e?.message ?? "").trim();
				throw new AuthRequiredError(
					`${this.def.label} could not start a session${said && !/^authentication required\.?$/i.test(said) ? `: ${said}` : " because it needs you to sign in"}.\nTo sign in, run \`${this.def.signIn}\` in a terminal${init.authMethods?.length ? " or press Sign In" : ""}, then try again.`,
					init.authMethods ?? []
				);
			}
			throw e;
		}
		this.info = {
			sessionId: created.sessionId,
			agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? this.def.label,
			modes: created.modes,
			configOptions: created.configOptions,
			authMethods: init.authMethods ?? [],
			images: !!init.agentCapabilities?.promptCapabilities?.image,
			mcpTransport: http ? "http" : "stdio",
		};
		return this.info;
	}

	/** Runs the agent's own sign-in (e.g. Gemini's browser OAuth), then opens the session. */
	public async authenticate(methodId: string): Promise<SessionInfo> {
		await this.withExit(this.connection!.agent.request("authenticate", { methodId }), "authenticate");
		return this.newSession();
	}

	public async prompt(blocks: acp.ContentBlock[]): Promise<acp.StopReason> {
		if (!this.info) throw new Error("No session");
		const r = await this.withExit(this.connection!.agent.request("session/prompt", { sessionId: this.info.sessionId, prompt: blocks }), "session/prompt");
		return r.stopReason;
	}

	public cancel(): void {
		if (this.info && this.connection && !this.exited) {
			void this.connection.agent.notify("session/cancel", { sessionId: this.info.sessionId }).catch(() => undefined);
		}
	}

	public async setConfigOption(configId: string, value: string): Promise<acp.SessionConfigOption[] | undefined> {
		if (!this.info) return undefined;
		const r = await this.connection!.agent.request("session/set_config_option", { sessionId: this.info.sessionId, configId, value });
		this.info.configOptions = r.configOptions;
		return r.configOptions;
	}

	public async setMode(modeId: string): Promise<void> {
		if (!this.info) return;
		await this.connection!.agent.request("session/set_mode", { sessionId: this.info.sessionId, modeId });
		if (this.info.modes) this.info.modes = { ...this.info.modes, currentModeId: modeId };
	}

	public dispose(): void {
		this.connection?.close();
		if (this.child && !this.exited) {
			this.child.kill("SIGTERM");
			const c = this.child;
			setTimeout(() => !this.exited && c.kill("SIGKILL"), 3000).unref();
		}
	}

	private stderrTail(): string {
		return this.stderr.slice(-6).join("\n");
	}

	/** A request that fails with a clear message if the agent process dies first. */
	private async withExit<T>(p: Promise<T>, what: string): Promise<T> {
		try {
			return await p;
		} catch (e: any) {
			if (this.exited) throw new Error(`${this.def.label} exited during ${what}.${this.stderrTail() ? `\n${this.stderrTail()}` : ""}`);
			throw e;
		}
	}
}
