import * as vscode from "vscode";
import type { Server } from "http";
import type { DrawioEditor } from "../../DrawioEditorService";
import type { DiagramToolbox } from "./DiagramToolbox";
import { createMcpListener, McpTool } from "./mcp";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { TOOL_SCHEMAS } from "./toolSchemas";

const TOKEN_KEY = "drawio-ai.mcp.token";

export interface McpConnectionInfo {
	running: boolean;
	url: string;
	token: string;
	claudeCommand: string;
	json: string;
}

/** Serves the diagram tools to external agents (Claude Code, Cursor, ...) over MCP on 127.0.0.1. */
export class McpService {
	private server: Server | undefined;
	private token = "";
	private actualPort = 0;
	private configuredPort = -1;
	private starting: Promise<void> | undefined;
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	private readonly disposables: vscode.Disposable[] = [this.status];
	private busyTimer: ReturnType<typeof setTimeout> | undefined;
	private busyEditor: DrawioEditor | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly toolbox: DiagramToolbox,
		private readonly targetEditor: () => DrawioEditor | undefined,
		private readonly templatePrompt: () => Promise<string | undefined>
	) {
		this.status.command = "drawio-ai.mcpSetup";
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("drawio-ai.mcp")) void this.sync();
			})
		);
		void this.sync();
	}

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		void this.stop();
	}

	private get config() {
		const c = vscode.workspace.getConfiguration("drawio-ai.mcp");
		return { enabled: c.get<boolean>("enabled", false), port: c.get<number>("port", 47821) };
	}

	private async sync(): Promise<void> {
		await this.starting;
		const { enabled, port } = this.config;
		if (!enabled) return this.stop();
		if (this.server && this.configuredPort === port) return;
		await this.stop();
		this.starting = this.start(port).finally(() => (this.starting = undefined));
		await this.starting;
	}

	private async start(port: number): Promise<void> {
		this.token = (await this.context.secrets.get(TOKEN_KEY)) ?? "";
		if (!this.token) await this.regenerateToken();
		let http: typeof import("http");
		try {
			http = require("http");
		} catch {
			void vscode.window.showErrorMessage("Draw.AI: the MCP server needs the desktop version of VS Code.");
			return;
		}
		const listener = createMcpListener({
			token: () => this.token,
			port: () => this.actualPort,
			onCall: (name) => this.markBusy(name),
			deps: {
				serverVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
				tools: () => TOOL_SCHEMAS.map((t): McpTool => ({ name: t.name, title: t.displayName, description: t.description, inputSchema: t.inputSchema, readOnly: !t.mutates && t.name !== "drawio_code_links" })),
				callTool: (name, args) => this.toolbox.invoke(name, args),
				instructions: async () => {
					const template = await this.templatePrompt().catch(() => undefined);
					return [
						"These tools edit the draw.io diagram that is open (or was last focused) in the user's VS Code, live.",
						SYSTEM_PROMPT.split("\n\nAnswering:")[0],
						template,
					]
						.filter(Boolean)
						.join("\n\n");
				},
			},
		});
		const server = http.createServer(listener);
		server.keepAliveTimeout = 5000;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "127.0.0.1", () => resolve());
			});
		} catch (e: any) {
			this.updateStatus();
			void vscode.window.showErrorMessage(
				e?.code === "EADDRINUSE"
					? `Draw.AI MCP server: port ${port} is already in use (another VS Code window may be serving it). Change "drawio-ai.mcp.port".`
					: `Draw.AI MCP server could not start: ${e?.message ?? e}`
			);
			return;
		}
		this.server = server;
		this.configuredPort = port;
		const address = server.address();
		this.actualPort = typeof address === "object" && address ? address.port : port;
		this.updateStatus();
	}

	private async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.configuredPort = -1;
		this.updateStatus();
		if (server) await new Promise<void>((r) => server.close(() => r()));
	}

	private updateStatus(): void {
		if (this.server) {
			this.status.text = "$(plug) Draw.AI MCP";
			this.status.tooltip = `Draw.AI MCP server on http://127.0.0.1:${this.actualPort}/mcp. Click for client setup.`;
			this.status.show();
		} else {
			this.status.hide();
		}
	}

	private markBusy(tool: string): void {
		const editor = this.targetEditor();
		if (!editor) return;
		if (this.busyEditor && this.busyEditor !== editor) this.busyEditor.drawioClient.aiSetStatus(false);
		this.busyEditor = editor;
		editor.drawioClient.aiSetStatus(true, tool === "drawio_apply_operations" ? "External agent (MCP) is editing…" : "External agent (MCP) is reading…");
		clearTimeout(this.busyTimer);
		this.busyTimer = setTimeout(() => {
			this.busyEditor?.drawioClient.aiSetStatus(false);
			this.busyEditor = undefined;
		}, 2500);
	}

	private async regenerateToken(): Promise<void> {
		const bytes = crypto.getRandomValues(new Uint8Array(24));
		this.token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		await this.context.secrets.store(TOKEN_KEY, this.token);
	}

	public info(): McpConnectionInfo {
		const url = `http://127.0.0.1:${this.server ? this.actualPort : this.config.port}/mcp`;
		return {
			running: !!this.server,
			url,
			token: this.token,
			claudeCommand: `claude mcp add --transport http drawio ${url} --header "Authorization: Bearer ${this.token}"`,
			json: JSON.stringify({ mcpServers: { drawio: { type: "http", url, headers: { Authorization: `Bearer ${this.token}` } } } }, null, 2),
		};
	}

	/** `Draw.AI: Set Up MCP Server for External Agents` */
	public async setupCommand(args?: { show?: boolean; enable?: boolean }): Promise<McpConnectionInfo> {
		if (!this.config.enabled) {
			const enable =
				args?.enable ??
				(await vscode.window.showInformationMessage(
					"Let other AI agents (Claude Code, Cursor, …) edit your open diagrams through MCP? The server only listens on 127.0.0.1 and requires a secret token.",
					{ modal: true },
					"Enable"
				)) === "Enable";
			if (!enable) return this.info();
			await vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", true, vscode.ConfigurationTarget.Global);
		}
		await this.sync();
		if (args?.show === false) return this.info();

		type Item = vscode.QuickPickItem & { run: () => Promise<unknown> };
		const copy = (text: string, what: string) => async () => {
			await vscode.env.clipboard.writeText(text);
			void vscode.window.showInformationMessage(`${what} copied to the clipboard. It contains your MCP token; treat it like a password.`);
		};
		const info = this.info();
		const items: Item[] = [
			{ label: "$(copy) Copy Claude Code command", detail: "claude mcp add --transport http drawio …", run: copy(info.claudeCommand, "Claude Code command") },
			{ label: "$(copy) Copy JSON config", detail: "For Cursor (.cursor/mcp.json), Windsurf, Claude Desktop and other clients with HTTP support", run: copy(info.json, "MCP JSON config") },
			{ label: "$(copy) Copy URL", detail: info.url, run: copy(info.url, "URL") },
			{
				label: "$(refresh) Regenerate token",
				detail: "Disconnects every client configured with the old token",
				run: async () => {
					await this.regenerateToken();
					void vscode.window.showInformationMessage("New MCP token created. Update your MCP client configuration.");
				},
			},
			{ label: "$(debug-disconnect) Turn the MCP server off", run: async () => vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", false, vscode.ConfigurationTarget.Global) },
		];
		const pick = await vscode.window.showQuickPick(items, {
			title: info.running ? `Draw.AI MCP server: ${info.url}` : "Draw.AI MCP server is not running",
		});
		await pick?.run();
		return this.info();
	}
}
