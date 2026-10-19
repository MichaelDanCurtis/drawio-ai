import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { drawioAiHome } from "../../agent-bridge/discovery";
import type { McpService } from "./McpService";

// "Draw.AI: Connect Claude Code / Codex…": installs the agent plugin that ships
// in the extension (skills + the stdio bridge) into each agent's plugin system,
// after showing the user exactly which commands will run.

const MARKETPLACE = "draw-ai";
const PLUGIN = "draw-ai@draw-ai";

export type AgentId = "claude-code" | "codex";

interface AgentCli {
	id: AgentId;
	label: string;
	cli: string;
}

interface Step {
	args: string[];
	/** Failures that only mean "already done" (disconnecting something that is not there). */
	tolerate?: RegExp;
}

export interface ConnectArgs {
	agents?: AgentId[];
	/** false skips the confirmation dialog (tests). */
	confirm?: boolean;
}

export interface ConnectResult {
	done: AgentId[];
	failed: AgentId[];
	commands: string[];
}

export class AgentConnector {
	private readonly output = vscode.window.createOutputChannel("Draw.AI Agents");

	constructor(private readonly context: vscode.ExtensionContext, private readonly mcp: McpService) {}

	public dispose(): void {
		this.output.dispose();
	}

	/** `Draw.AI: Connect Claude Code / Codex…` */
	public async connect(args: ConnectArgs = {}): Promise<ConnectResult> {
		const empty: ConnectResult = { done: [], failed: [], commands: [] };
		const agents = await this.chooseAgents(args, "Connect to Draw.AI");
		if (!agents) return empty;

		const info = await this.mcp.setupCommand({ show: false, enable: args.confirm === false ? true : undefined });
		if (!info.running) {
			void vscode.window.showWarningMessage("Draw.AI's MCP server is off, so agents could not reach your diagrams. Nothing was connected.");
			return empty;
		}
		const pluginDir = this.installPluginFiles();
		if (!this.mcp.writeBridgeLauncher()) {
			void vscode.window.showErrorMessage("Draw.AI: the agent bridge is missing from this build of the extension.");
			return empty;
		}

		const plans = await Promise.all(agents.map(async (a) => ({ agent: a, steps: await this.connectSteps(a, pluginDir) })));
		const commands = plans.flatMap((p) => p.steps.map((s) => shown(p.agent, s)));
		if (args.confirm !== false) {
			const ok = await vscode.window.showInformationMessage(
				`Connect ${agents.map((a) => a.label).join(" and ")} to Draw.AI?`,
				{
					modal: true,
					detail: `Draw.AI will run:\n\n${commands.join("\n")}\n\nThe plugin adds Draw.AI's skills and a local bridge to the diagram tools in VS Code. Nothing leaves your machine.`,
				},
				"Connect"
			);
			if (ok !== "Connect") return { ...empty, commands };
		}
		const result = await this.runPlans(plans, "Connecting");
		if (result.done.length) {
			const names = result.done.map((id) => agents.find((a) => a.id === id)!.label).join(" and ");
			void vscode.window.showInformationMessage(
				`Connected ${names} to Draw.AI. Start a new session there to load it; edits appear live in the Draw.AI editor here.`
			);
		}
		return { ...result, commands };
	}

	/** `Draw.AI: Disconnect Claude Code / Codex…` */
	public async disconnect(args: ConnectArgs = {}): Promise<ConnectResult> {
		const empty: ConnectResult = { done: [], failed: [], commands: [] };
		const agents = await this.chooseAgents(args, "Disconnect from Draw.AI");
		if (!agents) return empty;
		const plans = agents.map((a) => ({ agent: a, steps: disconnectSteps(a) }));
		const commands = plans.flatMap((p) => p.steps.map((s) => shown(p.agent, s)));
		if (args.confirm !== false) {
			const ok = await vscode.window.showWarningMessage(
				`Remove the Draw.AI plugin from ${agents.map((a) => a.label).join(" and ")}?`,
				{ modal: true, detail: `Draw.AI will run:\n\n${commands.join("\n")}` },
				"Disconnect"
			);
			if (ok !== "Disconnect") return { ...empty, commands };
		}
		const result = await this.runPlans(plans, "Disconnecting");
		if (result.done.length) void vscode.window.showInformationMessage("Removed the Draw.AI plugin. The MCP server keeps running until you turn it off.");
		return { ...result, commands };
	}

	private async chooseAgents(args: ConnectArgs, title: string): Promise<AgentCli[] | undefined> {
		const found = findAgentClis();
		if (args.agents) {
			const picked = found.filter((a) => args.agents!.includes(a.id));
			return picked.length ? picked : undefined;
		}
		if (found.length === 0) {
			const copy = await vscode.window.showWarningMessage(
				"Neither Claude Code nor Codex was found on this computer. Install one, or add the Draw.AI plugin yourself.",
				"Copy Commands"
			);
			if (copy) {
				const dir = this.installPluginFiles();
				this.mcp.writeBridgeLauncher();
				await vscode.env.clipboard.writeText(
					[`claude plugin marketplace add "${dir}"`, `claude plugin install ${PLUGIN}`, "", `codex plugin marketplace add "${dir}"`, `codex plugin add ${PLUGIN}`].join("\n")
				);
			}
			return undefined;
		}
		const picks = await vscode.window.showQuickPick(
			found.map((a) => ({ label: a.label, description: a.cli, picked: true, agent: a })),
			{ title, canPickMany: true, placeHolder: "Choose the agents" }
		);
		return picks?.length ? picks.map((p) => p.agent) : undefined;
	}

	/** Copies the plugin to ~/.drawio-ai/agent-plugin: a stable path that survives extension updates. */
	private installPluginFiles(): string {
		const source = this.context.asAbsolutePath("agent-plugin");
		const target = path.join(drawioAiHome(), "agent-plugin");
		fs.rmSync(target, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.cpSync(source, target, { recursive: true });
		// A VSIX does not keep file modes.
		fs.chmodSync(path.join(target, "bin", "draw-ai-mcp"), 0o755);
		return target;
	}

	private async connectSteps(agent: AgentCli, pluginDir: string): Promise<Step[]> {
		if (agent.id === "codex") {
			// Both are idempotent; `plugin add` also refreshes Codex's copy and enables it.
			return [{ args: ["plugin", "marketplace", "add", pluginDir] }, { args: ["plugin", "add", PLUGIN] }];
		}
		const installed = await this.run(agent.cli, ["plugin", "list", "--json"])
			.then((out) => JSON.parse(out).some((p: any) => p?.id === PLUGIN))
			.catch(() => false);
		return [{ args: ["plugin", "marketplace", "add", pluginDir] }, { args: installed ? ["plugin", "update", PLUGIN] : ["plugin", "install", PLUGIN] }];
	}

	private async runPlans(plans: { agent: AgentCli; steps: Step[] }[], verb: string): Promise<Omit<ConnectResult, "commands">> {
		const done: AgentId[] = [];
		const failed: AgentId[] = [];
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Draw.AI: ${verb}…` }, async () => {
			for (const { agent, steps } of plans) {
				let ok = true;
				for (const step of steps) {
					this.output.appendLine(`$ ${shown(agent, step)}`);
					try {
						const out = await this.run(agent.cli, step.args);
						if (out.trim()) this.output.appendLine(out.trim());
					} catch (e: any) {
						const message = String(e?.message ?? e).trim();
						this.output.appendLine(message);
						if (step.tolerate?.test(message)) continue;
						ok = false;
						break;
					}
				}
				(ok ? done : failed).push(agent.id);
			}
		});
		if (failed.length) {
			const names = failed.map((id) => plans.find((p) => p.agent.id === id)!.agent.label).join(" and ");
			void vscode.window.showErrorMessage(`Draw.AI: ${verb.toLowerCase()} ${names} failed.`, "Show Output").then((c) => c && this.output.show());
		}
		return { done, failed };
	}

	private run(cli: string, args: string[]): Promise<string> {
		const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
		const argv = shell ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, "")}"` : a)) : args;
		return new Promise((resolve, reject) => {
			execFile(shell ? `"${cli}"` : cli, argv, { cwd: os.homedir(), timeout: 120_000, shell, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new Error(`${stderr || stdout || error.message}`));
				else resolve(`${stdout}${stderr}`);
			});
		});
	}
}

function disconnectSteps(agent: AgentCli): Step[] {
	const missing = /not (installed|found)|no (such|plugin|marketplace)|unknown|does not exist/i;
	return agent.id === "codex"
		? [{ args: ["plugin", "remove", PLUGIN], tolerate: missing }, { args: ["plugin", "marketplace", "remove", MARKETPLACE], tolerate: missing }]
		: [{ args: ["plugin", "uninstall", PLUGIN], tolerate: missing }, { args: ["plugin", "marketplace", "remove", MARKETPLACE], tolerate: missing }];
}

function shown(agent: AgentCli, step: Step): string {
	const home = os.homedir();
	const name = agent.id === "codex" ? "codex" : "claude";
	return [name, ...step.args.map((a) => (a.startsWith(home) ? "~" + a.slice(home.length) : a)).map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
}

/** The agent CLIs on this computer: on PATH, in their usual install folders, or inside their VS Code extensions. */
export function findAgentClis(): AgentCli[] {
	const result: AgentCli[] = [];
	const claude =
		findExecutable("claude", [path.join(os.homedir(), ".claude", "local")]) ??
		inExtension("anthropic.claude-code", (dir) => path.join(dir, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude"));
	if (claude) result.push({ id: "claude-code", label: "Claude Code", cli: claude });
	const codex = findExecutable("codex", []) ?? inExtension("openai.chatgpt", (dir) => findBelow(path.join(dir, "bin"), process.platform === "win32" ? "codex.exe" : "codex"));
	if (codex) result.push({ id: "codex", label: "Codex", cli: codex });
	return result;
}

function findExecutable(name: string, extraDirs: string[]): string | undefined {
	const home = os.homedir();
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter),
		...extraDirs,
		path.join(home, ".local", "bin"),
		path.join(home, ".npm-global", "bin"),
		path.join(home, ".bun", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	].filter(Boolean);
	const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = path.join(dir, name + ext);
			if (isExecutable(p)) return p;
		}
	}
	return undefined;
}

function inExtension(id: string, locate: (dir: string) => string | undefined): string | undefined {
	const dir = vscode.extensions.getExtension(id)?.extensionPath;
	const p = dir && locate(dir);
	return p && isExecutable(p) ? p : undefined;
}

function findBelow(dir: string, name: string, depth = 2): string | undefined {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
	if (depth > 0) for (const e of entries) if (e.isDirectory()) {
		const found = findBelow(path.join(dir, e.name), name, depth - 1);
		if (found) return found;
	}
	return undefined;
}

function isExecutable(p: string): boolean {
	try {
		const stat = fs.statSync(p);
		if (!stat.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
