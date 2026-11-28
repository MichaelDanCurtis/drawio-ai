import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { AgentId } from "./agents";
import type { ShapeLocation } from "./shapeLocations";
import { cleanGalleries, DEFAULT_GALLERIES, type GalleryConfig, type GallerySource } from "./workshop/types";

// (kept where the rest of the app looks for them; they live in files without Electron, which
// the VS Code extension uses too)
export type { ShapeLocation } from "./shapeLocations";
export { DEFAULT_GALLERIES, type GalleryConfig, type GallerySource } from "./workshop/types";

export type ThemeChoice = "system" | "light" | "dark";
/** The app's icons: draw.io's own flat ones, or one of three 3D styles drawn by ui/icons.js. */
export type IconStyle = "classic" | "dots2d" | "dots" | "real";
export const ICON_STYLES: IconStyle[] = ["classic", "dots2d", "dots", "real"];
/** Styles of earlier versions, and what took their place. */
const OLD_ICON_STYLES: Record<string, IconStyle> = { isometric: "dots2d", extruded: "real" };
/** The dot field over every surface: in its own grey, tinted green, or none. */
export type MatrixStyle = "grey" | "green" | "off";
export const MATRIX_STYLES: MatrixStyle[] = ["grey", "green", "off"];

/** Where draw.io's toolbar sits in the editor. */
export type ToolbarSide = "top" | "left" | "right" | "bottom";

/** Who answers a chat: an agent program, or a provider's models used with an API key ("api:anthropic"). */
export type ChatAgent = AgentId | `api:${string}`;

/** A model or mode an agent offered, remembered so Settings can list it while the agent is not running. */
export interface KnownModel {
	/** The value the agent uses for it (an ACP config option value, or `mode:<id>`). */
	value: string;
	name: string;
	description?: string;
	/** false: a model used with an API key that takes no pictures (the provider said so). */
	images?: false;
}

/**
 * User settings, in <userData>/settings.json, edited in OmniDraw → Settings….
 * Everything has a default; the file only holds what the user changed.
 */
export interface Settings {
	/** Who answered the chat last: an agent, or a provider used with an API key. */
	agent: ChatAgent;
	/** Override how an agent is launched, e.g. { "codex": { "command": "/opt/bin/codex-acp", "args": [] } }. */
	agents: Partial<Record<AgentId, { command: string; args?: string[]; env?: Record<string, string> }>>;
	/** Width of the chat panel in pixels. */
	chatWidth: number;
	/** OmniDraw editor settings, with the same keys as the VS Code extension's `drawio-ai.*` settings. */
	editor: Record<string, unknown>;
	appearance: { theme: ThemeChoice; iconStyle: IconStyle; toolbar: ToolbarSide; matrix: MatrixStyle };
	chat: {
		/** Which side of the window the chat docks on. */
		side: "right" | "left";
		/** New windows open with the chat tucked away. */
		startCollapsed: boolean;
		/** New chats start with "Allow all" on (every agent request approved without asking). */
		allowAllByDefault: boolean;
	};
	/** Per agent (and per provider used with an API key): models hidden from the chat's picker, and the model a new session switches to. */
	models: Partial<Record<ChatAgent, { hidden?: string[]; preferred?: string }>>;
	/** The models each agent offered when it last ran, and each provider listed for its key (filled in automatically). */
	modelCatalog: Partial<Record<ChatAgent, KnownModel[]>>;
	shapes: { locations: ShapeLocation[] };
	workshop: { galleries: GalleryConfig[] };
	/** Go live: the OmniPad server diagrams are shared through (its origin), and the name others see. */
	sharing: { server: string; name: string };
	/** The home screen's library: the folder it is ("" for OmniDraw in the user's Documents). */
	library: { folder: string };
}

const DEFAULTS: Settings = {
	agent: "claude",
	agents: {},
	chatWidth: 400,
	editor: {
		"drawio-ai.reviewChanges": true,
		"drawio-ai.flashChanges": true,
		"drawio-ai.animateChanges": true,
		"drawio-ai.selectChangedCells": false,
		"drawio-ai.maxCellsInContext": 400,
	},
	appearance: { theme: "system", iconStyle: "dots2d", toolbar: "top", matrix: "grey" },
	chat: { side: "right", startCollapsed: false, allowAllByDefault: false },
	models: {},
	modelCatalog: {},
	shapes: { locations: [] },
	workshop: { galleries: DEFAULT_GALLERIES },
	sharing: { server: "", name: "" },
	library: { folder: "" },
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
	if (!ICON_STYLES.includes(appearance.iconStyle)) appearance.iconStyle = (Object.hasOwn(OLD_ICON_STYLES, String(appearance.iconStyle)) ? OLD_ICON_STYLES[String(appearance.iconStyle)] : undefined) ?? DEFAULTS.appearance.iconStyle;
	if (!["top", "left", "right", "bottom"].includes(appearance.toolbar)) appearance.toolbar = DEFAULTS.appearance.toolbar;
	if (!MATRIX_STYLES.includes(appearance.matrix)) appearance.matrix = DEFAULTS.appearance.matrix;
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
		agent: typeof user.agent === "string" && user.agent ? user.agent : DEFAULTS.agent,
		chatWidth: typeof user.chatWidth === "number" && isFinite(user.chatWidth) ? user.chatWidth : DEFAULTS.chatWidth,
		editor: { ...DEFAULTS.editor, ...obj(user.editor) },
		agents: { ...obj(user.agents) },
		appearance,
		chat,
		models: cleanModels(obj(user.models)),
		modelCatalog: cleanCatalog(obj(user.modelCatalog)),
		shapes: { locations },
		workshop: { galleries: cleanGalleries(obj(user.workshop).galleries) },
		sharing: {
			server: typeof obj(user.sharing).server === "string" ? user.sharing.server.trim().slice(0, 300) : "",
			name: typeof obj(user.sharing).name === "string" ? user.sharing.name.trim().slice(0, 60) : "",
		},
		// (a folder is kept only as a full path: anything else in a hand-edited file is the default)
		library: { folder: typeof obj(user.library).folder === "string" && path.isAbsolute(user.library.folder) ? user.library.folder : "" },
	};
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function cleanModels(m: Record<string, any>): Settings["models"] {
	const out: Record<string, { hidden?: string[]; preferred?: string }> = {};
	for (const [agent, v] of Object.entries(m)) {
		if (!v || typeof v !== "object") continue;
		out[agent] = { hidden: strings(v.hidden), ...(typeof v.preferred === "string" && v.preferred ? { preferred: v.preferred } : {}) };
	}
	return out as Settings["models"];
}

function cleanCatalog(c: Record<string, any>): Settings["modelCatalog"] {
	const out: Record<string, KnownModel[]> = {};
	for (const [agent, list] of Object.entries(c)) {
		if (!Array.isArray(list)) continue;
		out[agent] = list
			.filter((m) => m && typeof m.value === "string" && typeof m.name === "string")
			.map((m) => ({ value: m.value, name: m.name, ...(typeof m.description === "string" ? { description: m.description } : {}), ...(m.images === false ? { images: false as const } : {}) }));
	}
	return out as Settings["modelCatalog"];
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
	let text: string | undefined;
	try {
		text = fs.readFileSync(settingsPath(), "utf8");
	} catch {
		// no file yet: start one
	}
	if (text !== undefined) {
		try {
			onDisk = JSON.parse(text);
		} catch {
			// A file being edited by hand that does not parse: keep a copy, and build on what was loaded.
			try {
				fs.writeFileSync(settingsPath() + ".broken", text);
			} catch {
				// not important
			}
			onDisk = { ...(cached ?? {}) };
		}
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
