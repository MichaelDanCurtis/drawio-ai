import * as vscode from "vscode";
import * as fs from "fs";
import type { Server } from "http";
import type { DrawioEditor } from "../../DrawioEditorService";
import { AgentInstance, drawioAiHome, readInstances, removeInstance, writeInstance, writeLauncher } from "../../agent-bridge/discovery";
import type { DiagramToolbox } from "./DiagramToolbox";
import { createMcpListener } from "./mcp";
import { mcpInstructions } from "./systemPrompt";
import { toMcpTools } from "./toolSchemas";

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
	private discoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private lastFocusedAt = vscode.window.state.focused ? Date.now() : 0;

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
			}),
			// Keep this window's discovery entry current, so agents reach the window that has their diagram.
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused) this.lastFocusedAt = Date.now();
				this.announceSoon();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.announceSoon()),
			vscode.window.tabGroups.onDidChangeTabs(() => this.announceSoon())
		);
		void this.sync();
	}

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		clearTimeout(this.discoveryTimer);
		void this.stop();
	}

	private get config() {
		const c = vscode.workspace.getConfiguration("drawio-ai.mcp");
		return { enabled: c.get<boolean>("enabled", false), port: c.get<number>("port", 47821), discovery: c.get<boolean>("discovery", true) };
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
			deps: {
				serverVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
				tools: toMcpTools,
				callTool: (name, args, meta) => this.toolbox.invoke(name, args, { onTarget: (editor) => this.markBusy(editor, name, meta.client) }),
				instructions: async () => mcpInstructions(await this.templatePrompt().catch(() => undefined)),
			},
		});
		const server = http.createServer(listener);
		server.keepAliveTimeout = 5000;
		const listen = (p: number) =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(p, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
		try {
			try {
				await listen(port);
			} catch (e: any) {
				// Another window has the port. Agents connected through the bridge find
				// this window by its discovery entry, so any free port will do.
				if (e?.code !== "EADDRINUSE" || !this.config.discovery || port === 0) throw e;
				await listen(0);
			}
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
		this.announce();
	}

	private async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.configuredPort = -1;
		this.updateStatus();
		this.withdraw();
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

	private markBusy(editor: DrawioEditor, tool: string, client: string | undefined): void {
		if (this.busyEditor && this.busyEditor !== editor) this.busyEditor.drawioClient.aiSetStatus(false);
		this.busyEditor = editor;
		const who = client ? agentName(client) : "External agent (MCP)";
		editor.drawioClient.aiSetStatus(true, tool === "drawio_apply_operations" ? `${who} is editing…` : `${who} is reading…`);
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
		this.announce();
	}

	/** The agent bridge's launcher, for agent plugins (Claude Code, Codex). Undefined if the bridge was not built. */
	public writeBridgeLauncher(): string | undefined {
		const bridgePath = this.context.asAbsolutePath("dist/agent-bridge/index.js");
		if (!fs.existsSync(bridgePath)) return undefined;
		return writeLauncher(drawioAiHome(), { execPath: process.execPath, bridgePath });
	}

	private announceSoon(): void {
		if (!this.server) return;
		clearTimeout(this.discoveryTimer);
		this.discoveryTimer = setTimeout(() => this.announce(), 250);
	}

	/**
	 * Writes this window's discovery entry (~/.drawio-ai/instances/<pid>.json, user-only):
	 * its port, token, folders and open diagrams. The agent bridge reads it to forward
	 * tool calls here, so agents need no copied token and every window can serve.
	 */
	private announce(): void {
		if (!this.server || !this.config.discovery) return this.withdraw();
		const viewTypes = new Set(["drawio-ai", "drawio-ai-text"]);
		const openDiagrams = vscode.window.tabGroups.all
			.flatMap((g) => g.tabs)
			.map((t) => t.input)
			.filter((i): i is vscode.TabInputCustom => i instanceof vscode.TabInputCustom && viewTypes.has(i.viewType) && i.uri.scheme === "file")
			.map((i) => i.uri.fsPath);
		const target = this.targetEditor();
		const instance: AgentInstance = {
			version: 1,
			pid: process.pid,
			port: this.actualPort,
			token: this.token,
			app: vscode.env.appName,
			extensionVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath),
			openDiagrams: [...new Set(openDiagrams)],
			activeDiagram: target?.uri.scheme === "file" ? target.uri.fsPath : undefined,
			focused: vscode.window.state.focused,
			lastFocusedAt: this.lastFocusedAt,
		};
		try {
			const home = drawioAiHome();
			readInstances(home); // removes entries of windows that are gone
			writeInstance(home, instance);
			this.writeBridgeLauncher();
		} catch (e) {
			console.error("Draw.AI: could not write the MCP discovery entry", e);
		}
	}

	private withdraw(): void {
		try {
			removeInstance(drawioAiHome(), process.pid);
		} catch {
			// Nothing to remove.
		}
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
			{
				label: "$(plug) Connect Claude Code / Codex…",
				detail: "Installs Draw.AI's plugin (skills and a bridge to every VS Code window); no token to copy",
				run: () => Promise.resolve(vscode.commands.executeCommand("drawio-ai.connectAgents")),
			},
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

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "codex-mcp-client": "Codex", cursor: "Cursor" };

function agentName(client: string): string {
	return AGENT_NAMES[client.toLowerCase()] ?? client;
}
