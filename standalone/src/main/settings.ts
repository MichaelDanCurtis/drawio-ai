import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { AgentId } from "./agents";

/**
 * Optional user settings, in <userData>/settings.json (Draw.AI → Settings… opens it).
 * Everything has a default; the file only needs what the user wants to change.
 */
export interface Settings {
	/** The agent picked last. */
	agent: AgentId;
	/** Override how an agent is launched, e.g. { "codex": { "command": "/opt/bin/codex-acp", "args": [] } }. */
	agents: Partial<Record<AgentId, { command: string; args?: string[]; env?: Record<string, string> }>>;
	/** Width of the chat panel in pixels. */
	chatWidth: number;
	/** Draw.AI editor settings, with the same keys as the VS Code extension's `drawio-ai.*` settings. */
	editor: Record<string, unknown>;
}

const DEFAULTS: Settings = {
	agent: "claude",
	agents: {},
	chatWidth: 400,
	editor: {
		"drawio-ai.reviewChanges": true,
		"drawio-ai.flashChanges": true,
		"drawio-ai.selectChangedCells": false,
		"drawio-ai.maxCellsInContext": 400,
	},
};

let cached: Settings | undefined;

export function settingsPath(): string {
	return path.join(app.getPath("userData"), "settings.json");
}

export function settings(): Settings {
	if (!cached) {
		let user: Partial<Settings> = {};
		try {
			user = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
		} catch {
			// no file yet, or unreadable: defaults
		}
		cached = { ...DEFAULTS, ...user, editor: { ...DEFAULTS.editor, ...(user.editor ?? {}) }, agents: { ...(user.agents ?? {}) } };
	}
	return cached;
}

export function updateSettings(patch: Partial<Settings>): void {
	const next = { ...settings(), ...patch };
	cached = next;
	let onDisk: Record<string, unknown> = {};
	try {
		onDisk = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
	} catch {
		// start a new file
	}
	fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
	fs.writeFileSync(settingsPath(), JSON.stringify({ ...onDisk, ...patch }, null, "\t"));
}

export function reloadSettings(): void {
	cached = undefined;
}
