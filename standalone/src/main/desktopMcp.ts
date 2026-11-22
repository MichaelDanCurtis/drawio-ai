import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { app } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createMcpListener, McpTool } from "../../../src/features/ai/mcp";
import { agentEnv, which } from "./agents";
import type { DiagramWindow } from "./diagramWindow";
import { MAPPER_TOOLS } from "./mapper/mcpTools";
import { paths } from "./paths";
import { standaloneInstructions, standaloneTools } from "./mcpServer";

/**
 * One MCP endpoint for the whole desktop app, for Claude Code and Codex running
 * anywhere on this computer: the diagram tools and the Mapper tools, routed to
 * the window of the diagram named by `file` (opened when needed), else to the
 * window used last. The app writes its address and a per-launch token to
 * ~/.drawio-ai/desktop.json (user-only), and a launcher that the agents start as
 * a stdio MCP server; it reads that file on every request, so agents keep
 * working across app restarts.
 */

export const SERVER_NAME = "omnidraw";
/** The name used before the rename to OmniDraw: removed on Connect and Disconnect so no one keeps two. */
export const LEGACY_SERVER_NAME = "draw-ai-desktop";

const home = () => process.env.DRAWIO_AI_HOME || path.join(os.homedir(), ".drawio-ai");
export const desktopFile = () => path.join(home(), "desktop.json");
export const launcherPath = () => path.join(home(), "bin", process.platform === "win32" ? "omnidraw-mcp.cmd" : "omnidraw-mcp");

function writePrivate(file: string, text: string, mode = 0o600): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, { mode });
	fs.renameSync(tmp, file);
}

export interface DesktopHost {
	windows(): DiagramWindow[];
	focused(): DiagramWindow | undefined;
	open(file: string): Promise<DiagramWindow>;
}

export class DesktopMcp {
	private readonly token = randomBytes(24).toString("hex");
	private server: http.Server | undefined;
	private port = 0;

	constructor(private readonly host: DesktopHost) {}

	private tools(): McpTool[] {
		const file = { type: "string", description: "Absolute path of the diagram (.drawio, .drawio.svg, .drawio.png) to work on; it is opened in OmniDraw if needed. Default: the diagram used last." };
		const withFile = (t: McpTool): McpTool => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...((t.inputSchema as any).properties ?? {}), file } } });
		return [
			{
				name: "drawio_list_diagrams",
				readOnly: true,
				description: "List the diagrams open in OmniDraw (absolute paths; which one is in front).",
				inputSchema: { type: "object", properties: {} },
			},
			...standaloneTools().map(withFile),
			...MAPPER_TOOLS.map(({ run, ...t }) => withFile(t)),
		];
	}

	private async windowFor(file: unknown): Promise<DiagramWindow> {
		if (typeof file === "string" && file.trim()) {
			const p = path.resolve(file.trim());
			const open = this.host.windows().find((w) => w.file && path.resolve(w.file) === p);
			if (open) return open;
			if (!fs.existsSync(p)) throw new Error(`${p} does not exist. Create it with drawio_create in VS Code, or open an existing diagram.`);
			if (!/\.(drawio|dio)(\.(svg|png))?$|\.xml$/i.test(p)) throw new Error(`${p} is not a draw.io diagram.`);
			const w = await this.host.open(p);
			await w.whenLoaded();
			return w;
		}
		const w = this.host.focused();
		if (!w) throw new Error("No diagram is open in OmniDraw. Pass `file` with a diagram's absolute path to open it.");
		await w.whenLoaded();
		return w;
	}

	public async start(): Promise<void> {
		const listener = createMcpListener({
			token: () => this.token,
			port: () => this.port,
			deps: {
				serverVersion: app.getVersion(),
				tools: () => this.tools(),
				instructions: async () =>
					[
						"You are connected to the OmniDraw app. Every tool takes an optional `file`: the absolute path of the diagram to work on (opened if needed); without it, the diagram the user used last. drawio_list_diagrams lists the open ones.",
						"mapper_* tools work with the maps the Mapper drew (software, databases, clouds, ML): look things up with mapper_maps / mapper_find / mapper_show / mapper_path before reading code, and use mapper_run to map something new (read-only).",
						standaloneInstructions(undefined),
					].join("\n\n"),
				callTool: async (name, args: any) => {
					if (name === "drawio_list_diagrams") {
						const front = this.host.focused();
						return { text: JSON.stringify(this.host.windows().map((w) => ({ file: w.file ?? "(not saved yet)", front: w === front })), null, 1), summary: "Listed diagrams" };
					}
					const { file, ...rest } = args ?? {};
					try {
						const w = await this.windowFor(file);
						return await w.callTool(name, rest);
					} catch (e: any) {
						return { text: String(e?.message ?? e), summary: `${name} failed`, isError: true };
					}
				},
			},
		});
		this.server = http.createServer(listener);
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		this.port = (this.server.address() as any).port;
		writePrivate(desktopFile(), JSON.stringify({ version: 1, pid: process.pid, url: `http://127.0.0.1:${this.port}/mcp`, token: this.token, app: "OmniDraw", startedAt: new Date().toISOString() }, null, "\t"));
		writeLauncher();
	}

	public dispose(): void {
		this.server?.close();
		try {
			const f = JSON.parse(fs.readFileSync(desktopFile(), "utf8"));
			if (f?.pid === process.pid) fs.rmSync(desktopFile(), { force: true });
		} catch {
			// already gone
		}
	}
}

/** The launcher the agents run: this app's runtime (Electron as Node) with the stdio proxy in desktop mode. */
export function writeLauncher(): string {
	const file = launcherPath();
	const proxy = paths.stdioProxy;
	if (process.platform === "win32") {
		writePrivate(file, ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `"${process.execPath}" "${proxy}" --desktop %*`, ""].join("\r\n"), 0o700);
	} else {
		const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		writePrivate(file, ["#!/bin/sh", "# Written by OmniDraw: connects an agent to it over MCP (stdio).", `ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(proxy)} --desktop "$@"`, ""].join("\n"), 0o700);
	}
	return file;
}

/** Registers (or removes) the desktop app as an MCP server in Claude Code and Codex, with their own CLIs. */
export async function connectAgents(connect: boolean): Promise<{ agent: string; ok: boolean; message: string }[]> {
	const env = agentEnv();
	const launcher = writeLauncher();
	const run = (cmd: string, args: string[]) =>
		new Promise<{ code: number; out: string }>((resolve) => {
			const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			child.on("error", (e) => resolve({ code: -1, out: String(e.message) }));
			child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim() }));
		});
	const results: { agent: string; ok: boolean; message: string }[] = [];
	const claude = which("claude", env);
	if (claude) {
		await run(claude, ["mcp", "remove", "--scope", "user", LEGACY_SERVER_NAME]);
		await run(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
		if (connect) {
			const r = await run(claude, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", launcher]);
			results.push({ agent: "Claude Code", ok: r.code === 0, message: r.code === 0 ? `Added MCP server "${SERVER_NAME}" (user scope).` : r.out.split("\n").slice(-2).join(" ") });
		} else results.push({ agent: "Claude Code", ok: true, message: `Removed "${SERVER_NAME}".` });
	} else results.push({ agent: "Claude Code", ok: false, message: "claude is not installed." });
	const codex = which("codex", env);
	if (codex) {
		await run(codex, ["mcp", "remove", LEGACY_SERVER_NAME]);
		await run(codex, ["mcp", "remove", SERVER_NAME]);
		if (connect) {
			const r = await run(codex, ["mcp", "add", SERVER_NAME, "--", launcher]);
			results.push({ agent: "Codex", ok: r.code === 0, message: r.code === 0 ? `Added MCP server "${SERVER_NAME}".` : r.out.split("\n").slice(-2).join(" ") });
		} else results.push({ agent: "Codex", ok: true, message: `Removed "${SERVER_NAME}".` });
	} else results.push({ agent: "Codex", ok: false, message: "codex is not installed." });
	return results;
}
