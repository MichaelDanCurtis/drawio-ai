import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { AgentId } from "./agents";

export type ThemeChoice = "system" | "light" | "dark";
/** The app's icons: draw.io's own flat ones, or one of three 3D styles drawn by ui/icons.js. */
export type IconStyle = "classic" | "dots2d" | "dots" | "real";
export const ICON_STYLES: IconStyle[] = ["classic", "dots2d", "dots", "real"];
/** Styles of earlier versions, and what took their place. */
const OLD_ICON_STYLES: Record<string, IconStyle> = { isometric: "dots2d", extruded: "real" };
/** Where draw.io's toolbar sits in the editor. */
export type ToolbarSide = "top" | "left" | "right" | "bottom";

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

/** Where a gallery's shapes come from (see workshop/sources.ts). */
export type GallerySource =
	| { kind: "thesvg" }
	| { kind: "devicon" }
	| { kind: "simpleicons" }
	| { kind: "lucide" }
	| { kind: "tabler" }
	/** A public GitHub repository (or one folder of it) with SVG files. */
	| { kind: "github"; repo: string; ref?: string; path?: string }
	/** A folder of SVG/PNG files on this computer. */
	| { kind: "folder"; path: string }
	/** A draw.io library file (.xml) on this computer. */
	| { kind: "library"; path: string }
	/** A collection you fill yourself (kept in the app's data folder). */
	| { kind: "collection" };

/** A Shape Gallery: shown in the Workshop, as a palette in the shapes sidebar, and in draw.io's search. */
export interface GalleryConfig {
	id: string;
	title: string;
	sources: GallerySource[];
	enabled: boolean;
	/** One of the galleries the app starts with (they can be removed and restored). */
	builtin?: boolean;
}

/** The galleries a new install starts with. */
export const DEFAULT_GALLERIES: GalleryConfig[] = [
	{ id: "thesvg", title: "theSVG (open licences)", sources: [{ kind: "thesvg" }], enabled: true, builtin: true },
	{ id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }, { kind: "simpleicons" }], enabled: true, builtin: true },
	{ id: "ui-icons", title: "UI icons", sources: [{ kind: "lucide" }, { kind: "tabler" }], enabled: true, builtin: true },
];

/**
 * User settings, in <userData>/settings.json, edited in OmniDraw → Settings….
 * Everything has a default; the file only holds what the user changed.
 */
export interface Settings {
	/** The agent picked last. */
	agent: AgentId;
	/** Override how an agent is launched, e.g. { "codex": { "command": "/opt/bin/codex-acp", "args": [] } }. */
	agents: Partial<Record<AgentId, { command: string; args?: string[]; env?: Record<string, string> }>>;
	/** Width of the chat panel in pixels. */
	chatWidth: number;
	/** OmniDraw editor settings, with the same keys as the VS Code extension's `drawio-ai.*` settings. */
	editor: Record<string, unknown>;
	appearance: { theme: ThemeChoice; iconStyle: IconStyle; toolbar: ToolbarSide };
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
	workshop: { galleries: GalleryConfig[] };
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
	appearance: { theme: "system", iconStyle: "dots2d", toolbar: "top" },
	chat: { side: "right", startCollapsed: false, allowAllByDefault: false },
	models: {},
	modelCatalog: {},
	shapes: { locations: [] },
	workshop: { galleries: DEFAULT_GALLERIES },
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
	if (!ICON_STYLES.includes(appearance.iconStyle)) appearance.iconStyle = OLD_ICON_STYLES[String(appearance.iconStyle)] ?? DEFAULTS.appearance.iconStyle;
	if (!["top", "left", "right", "bottom"].includes(appearance.toolbar)) appearance.toolbar = DEFAULTS.appearance.toolbar;
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
		models: cleanModels(obj(user.models)),
		modelCatalog: cleanCatalog(obj(user.modelCatalog)),
		shapes: { locations },
		workshop: { galleries: cleanGalleries(obj(user.workshop).galleries) },
	};
}

function cleanSource(s: any): GallerySource | undefined {
	if (!s || typeof s !== "object") return undefined;
	switch (s.kind) {
		case "thesvg":
		case "devicon":
		case "simpleicons":
		case "lucide":
		case "tabler":
		case "collection":
			return { kind: s.kind };
		case "github":
			return typeof s.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(s.repo)
				? { kind: "github", repo: s.repo, ...(typeof s.ref === "string" && s.ref ? { ref: s.ref } : {}), ...(typeof s.path === "string" && s.path ? { path: s.path.replace(/^\/+|\/+$/g, "") } : {}) }
				: undefined;
		case "folder":
		case "library":
			return typeof s.path === "string" && s.path ? { kind: s.kind, path: s.path } : undefined;
	}
	return undefined;
}

/** Galleries as saved; a file without the key gets the defaults. */
function cleanGalleries(list: unknown): GalleryConfig[] {
	if (!Array.isArray(list)) return DEFAULT_GALLERIES.map((g) => ({ ...g }));
	const seen = new Set<string>();
	const out: GalleryConfig[] = [];
	for (const g of list as any[]) {
		if (!g || typeof g.id !== "string" || !/^[\w-]{1,64}$/.test(g.id) || seen.has(g.id)) continue;
		const sources = Array.isArray(g.sources) ? (g.sources.map(cleanSource).filter(Boolean) as GallerySource[]) : [];
		if (!sources.length) continue;
		seen.add(g.id);
		out.push({ id: g.id, title: typeof g.title === "string" && g.title.trim() ? g.title.trim().slice(0, 80) : g.id, sources, enabled: g.enabled !== false, ...(g.builtin ? { builtin: true } : {}) });
	}
	return out;
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
			.map((m) => ({ value: m.value, name: m.name, ...(typeof m.description === "string" ? { description: m.description } : {}) }));
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
