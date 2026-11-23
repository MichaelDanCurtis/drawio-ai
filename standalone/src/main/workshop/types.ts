/**
 * The Shape Workshop's galleries as they are saved. Nothing here imports Electron: the VS Code
 * extension uses the Workshop as it is (src/features/workshop there).
 */

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
export function cleanGalleries(list: unknown): GalleryConfig[] {
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
