import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Shared by the extension (which announces each VS Code window that serves MCP)
// and the agent bridge (which picks the window to forward a tool call to).
// No vscode import: the bridge runs outside VS Code.

export interface AgentInstance {
	version: 1;
	pid: number;
	port: number;
	token: string;
	/** VS Code's app name, e.g. "Visual Studio Code" or "Cursor". */
	app: string;
	extensionVersion: string;
	/** Absolute paths. */
	workspaceFolders: string[];
	/** Absolute paths of the diagrams open in Draw.AI editors. */
	openDiagrams: string[];
	activeDiagram?: string;
	focused: boolean;
	lastFocusedAt: number;
}

/** `~/.drawio-ai`, or `DRAWIO_AI_HOME`. */
export function drawioAiHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.DRAWIO_AI_HOME || path.join(os.homedir(), ".drawio-ai");
}

const instancesDir = (home: string) => path.join(home, "instances");
const instanceFile = (home: string, pid: number) => path.join(instancesDir(home), `${pid}.json`);

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

/** Writes via a temporary file so a reader never sees half a file; user-only permissions. */
function writePrivate(file: string, text: string, mode = 0o600): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, { mode });
	fs.renameSync(tmp, file);
}

export function writeInstance(home: string, instance: AgentInstance): void {
	writePrivate(instanceFile(home, instance.pid), JSON.stringify(instance, null, "\t"));
}

export function removeInstance(home: string, pid: number): void {
	fs.rmSync(instanceFile(home, pid), { force: true });
}

/** Live instances; files left behind by windows that crashed are removed. */
export function readInstances(home: string): AgentInstance[] {
	let names: string[];
	try {
		names = fs.readdirSync(instancesDir(home));
	} catch {
		return [];
	}
	const result: AgentInstance[] = [];
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		const file = path.join(instancesDir(home), name);
		let instance: AgentInstance;
		try {
			instance = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (instance?.version !== 1 || typeof instance.port !== "number" || typeof instance.token !== "string") continue;
		if (!isAlive(instance.pid)) {
			fs.rmSync(file, { force: true });
			continue;
		}
		result.push(instance);
	}
	return result;
}

const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

export function normalizeFsPath(p: string): string {
	let n = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
	if (caseInsensitive) n = n.toLowerCase();
	return n || "/";
}

/** `child` is `parent` or below it. */
export function isWithin(parent: string, child: string): boolean {
	const a = normalizeFsPath(parent);
	const b = normalizeFsPath(child);
	return b === a || b.startsWith(a.endsWith("/") ? a : a + "/");
}

export interface RouteHint {
	/** The `file` argument of the tool call, as the agent passed it. */
	file?: string;
	/** Folders the agent works in (MCP roots, its working directory). */
	roots: string[];
	exists?: (p: string) => boolean;
}

export interface Route {
	instance: AgentInstance;
	reason: "open" | "workspace" | "root" | "focus";
}

/**
 * Picks the VS Code window for a tool call: the one that has the diagram open,
 * else one whose workspace holds it (or the agent's folder), else the window
 * focused most recently.
 */
export function pickInstance(instances: AgentInstance[], hint: RouteHint): Route | undefined {
	if (instances.length === 0) return undefined;
	const exists = hint.exists ?? ((p: string) => fs.existsSync(p));
	const recent = (list: AgentInstance[]) =>
		[...list].sort((a, b) => Number(b.focused) - Number(a.focused) || b.lastFocusedAt - a.lastFocusedAt)[0];

	const file = hint.file?.trim();
	if (file) {
		const candidates = path.isAbsolute(file)
			? [file]
			: [...new Set([...instances.flatMap((i) => i.workspaceFolders), ...hint.roots])].map((f) => path.join(f, file));
		const open = instances.filter((i) => i.openDiagrams.some((d) => candidates.some((c) => normalizeFsPath(c) === normalizeFsPath(d))));
		if (open.length) return { instance: recent(open), reason: "open" };
		const holding = instances.filter((i) =>
			i.workspaceFolders.some((f) =>
				path.isAbsolute(file) ? isWithin(f, file) : exists(path.join(f, file))
			)
		);
		if (holding.length) return { instance: recent(holding), reason: "workspace" };
	}
	const byRoot = instances.filter((i) =>
		i.workspaceFolders.some((f) => hint.roots.some((r) => isWithin(f, r) || isWithin(r, f)))
	);
	if (byRoot.length) return { instance: recent(byRoot), reason: "root" };
	return { instance: recent(instances), reason: "focus" };
}

/** Where the bridge launcher lives; the agent plugin's own launcher execs this one. */
export function launcherPath(home: string, platform: NodeJS.Platform = process.platform): string {
	return path.join(home, "bin", platform === "win32" ? "draw-ai-mcp.cmd" : "draw-ai-mcp");
}

/**
 * Writes the launcher that starts the bridge with this VS Code's own runtime
 * (Electron as Node), so agents need no Node installation. Rewritten on every
 * start, so it follows VS Code and extension updates.
 */
export function writeLauncher(home: string, options: { execPath: string; bridgePath: string; platform?: NodeJS.Platform }): string {
	const platform = options.platform ?? process.platform;
	const file = launcherPath(home, platform);
	let text: string;
	if (platform === "win32") {
		const q = (s: string) => `"${s.replace(/"/g, "")}"`;
		text = ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `${q(options.execPath)} ${q(options.bridgePath)} %*`, ""].join("\r\n");
	} else {
		const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		text = ["#!/bin/sh", "# Written by the Draw.AI VS Code extension; starts the agent bridge.", `ELECTRON_RUN_AS_NODE=1 exec ${q(options.execPath)} ${q(options.bridgePath)} "$@"`, ""].join("\n");
	}
	writePrivate(file, text, 0o700);
	return file;
}
