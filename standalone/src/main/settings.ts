import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { AgentId } from "./agents";

export type ThemeChoice = "system" | "light" | "dark";
/** The app's icons: draw.io's own flat ones, or one of three 3D styles drawn by ui/icons.js. */
export type IconStyle = "classic" | "isometric" | "dots" | "extruded";
export const ICON_STYLES: IconStyle[] = ["classic", "isometric", "dots", "extruded"];

/** A model or mode an agent offered, remembered so Settings can list it while the agent is not running. */
export interface KnownModel {
	/** The value the agent uses for it (an ACP config option value, or `mode:<id>`). */
	value: string;
	name: string;
	description?: string;
}

/** A folder of SVG/PNG shapes, or a draw.io library file (.xml), shown in the shapes sidebar. */
export interface ShapeLocation {
	path: string;
	/** Shown as the palette's title; defaults to the folder or file name. */
	name?: string;
	enabled: boolean;
}

/**
 * User settings, in <userData>/settings.json, edited in Draw.AI → Settings….
 * Everything has a default; the file only holds what the user changed.
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
	appearance: { theme: ThemeChoice; iconStyle: IconStyle };
	chat: {
		/** Which side of the window the chat docks on. */
		side: "right" | "left";
		/** New windows open with the chat tucked away. */
		startCollapsed: boolean;
		/** New chats start with "Allow all" on (every agent request approved without asking). */
		allowAllByDefault: boolean;
	};
	/** Per agent: models hidden from the chat's picker, and the model a new session switches to. */
	models: Partial<Record<AgentId, { hidden?: string[]; preferred?: string }>>;
	/** The models each agent offered when it last ran (filled in automatically). */
	modelCatalog: Partial<Record<AgentId, KnownModel[]>>;
	shapes: { locations: ShapeLocation[] };
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
	appearance: { theme: "system", iconStyle: "isometric" },
	chat: { side: "right", startCollapsed: false, allowAllByDefault: false },
	models: {},
	modelCatalog: {},
	shapes: { locations: [] },
};

let cached: Settings | undefined;
const listeners = new Set<(s: Settings, patch: Partial<Settings>) => void>();

export function settingsPath(): string {
	return path.join(app.getPath("userData"), "settings.json");
}

/** Keeps only values of the right kind: a hand-edited file must not break the app. */
function merge(user: any): Settings {
	const obj = (v: any) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
	const appearance = { ...DEFAULTS.appearance, ...obj(user.appearance) };
	if (!["system", "light", "dark"].includes(appearance.theme)) appearance.theme = DEFAULTS.appearance.theme;
	if (!ICON_STYLES.includes(appearance.iconStyle)) appearance.iconStyle = DEFAULTS.appearance.iconStyle;
	const chat = { ...DEFAULTS.chat, ...obj(user.chat) };
	if (chat.side !== "left") chat.side = "right";
	chat.startCollapsed = !!chat.startCollapsed;
	chat.allowAllByDefault = !!chat.allowAllByDefault;
	const locations = Array.isArray(obj(user.shapes).locations)
		? (user.shapes.locations as any[])
				.filter((l) => l && typeof l.path === "string" && l.path)
				.map((l) => ({ path: l.path, name: typeof l.name === "string" ? l.name : undefined, enabled: l.enabled !== false }))
		: [];
	return {
		...DEFAULTS,
		...obj(user),
		chatWidth: typeof user.chatWidth === "number" && isFinite(user.chatWidth) ? user.chatWidth : DEFAULTS.chatWidth,
		editor: { ...DEFAULTS.editor, ...obj(user.editor) },
		agents: { ...obj(user.agents) },
		appearance,
		chat,
		models: { ...obj(user.models) },
		modelCatalog: { ...obj(user.modelCatalog) },
		shapes: { locations },
	};
}

export function settings(): Settings {
	if (!cached) {
		let user: any = {};
		try {
			user = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
		} catch {
			// no file yet, or unreadable: defaults
		}
		cached = merge(user);
	}
	return cached;
}

/** Saves top-level keys (nested objects are replaced whole) and tells the open windows. */
export function updateSettings(patch: Partial<Settings>): void {
	let onDisk: Record<string, unknown> = {};
	try {
		onDisk = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
	} catch {
		// start a new file
	}
	const next = { ...onDisk, ...patch };
	cached = merge(next);
	fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
	fs.writeFileSync(settingsPath(), JSON.stringify(next, null, "\t"));
	for (const l of listeners) {
		try {
			l(cached, patch);
		} catch (e) {
			console.warn("settings listener failed:", e);
		}
	}
}

/** Called after every change, with the new settings and the keys that changed. */
export function onSettingsChanged(listener: (s: Settings, patch: Partial<Settings>) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function reloadSettings(): void {
	cached = undefined;
}
