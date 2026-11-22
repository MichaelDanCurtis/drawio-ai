import type { GallerySource } from "../settings";

/** One shape in a gallery's index. SVGs from the internet are fetched (and cached) when shown. */
export interface GalleryItem {
	/** Unique in its gallery: "<source>:<name>". */
	id: string;
	title: string;
	tags: string[];
	/** Where the SVG is downloaded from (internet sources). */
	url?: string;
	/** A data URI (local images) or draw.io shape XML (libraries, collections). */
	data?: string;
	xml?: string;
	w?: number;
	h?: number;
	/** SPDX id or a short note ("trademark"), shown with the shape. */
	licence?: string;
	/** A brand colour for a one-colour logo (Simple Icons). */
	fill?: string;
	/** Which source it came from, shown with the shape ("Lucide", "devicon"…). */
	source: string;
}

/** Licences shapes may have to be offered: free to use, change and share, no share-alike. */
export const OPEN_LICENCES = new Set(["CC0-1.0", "MIT", "Apache-2.0", "ISC"]);

/**
 * Internet sources go through jsDelivr (the CDN of npm and GitHub). Tests point
 * OMNIDRAW_GALLERY_MIRROR at a local server holding the same paths.
 */
export function cdn(pathname: string): string {
	const mirror = process.env.OMNIDRAW_GALLERY_MIRROR;
	return mirror ? `${mirror}/cdn${pathname}` : `https://cdn.jsdelivr.net${pathname}`;
}
export function cdnData(pathname: string): string {
	const mirror = process.env.OMNIDRAW_GALLERY_MIRROR;
	return mirror ? `${mirror}/data${pathname}` : `https://data.jsdelivr.com${pathname}`;
}

/** The only hosts the Workshop downloads from (and the test mirror). */
export function allowedUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const mirror = process.env.OMNIDRAW_GALLERY_MIRROR;
		if (mirror && url.startsWith(mirror + "/")) return true;
		return u.protocol === "https:" && (u.hostname === "cdn.jsdelivr.net" || u.hostname === "data.jsdelivr.com");
	} catch {
		return false;
	}
}

export const SOURCE_INFO: Record<Exclude<GallerySource["kind"], "github" | "folder" | "library" | "collection">, { label: string; index: () => string; homepage: string; note: string }> = {
	thesvg: { label: "theSVG", index: () => cdn("/gh/glincker/thesvg@main/src/data/icons.json"), homepage: "https://thesvg.org", note: "Only icons whose own licence is CC0, MIT or Apache-2.0, and not the AWS, Azure or Google Cloud sets (their real terms differ). Brand logos stay their owners' trademarks." },
	devicon: { label: "devicon", index: () => cdn("/gh/devicons/devicon@latest/devicon.json"), homepage: "https://devicon.dev", note: "MIT. Logos stay their owners' trademarks." },
	simpleicons: { label: "Simple Icons", index: () => cdn("/npm/simple-icons@latest/data/simple-icons.json"), homepage: "https://simpleicons.org", note: "CC0, except logos with their own licence (kept only when open). Logos stay their owners' trademarks." },
	lucide: { label: "Lucide", index: () => cdn("/npm/lucide-static@latest/tags.json"), homepage: "https://lucide.dev", note: "ISC." },
	tabler: { label: "Tabler", index: () => cdn("/npm/@tabler/icons@latest/icons.json"), homepage: "https://tabler.io/icons", note: "MIT." },
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const uniq = (a: string[]) => [...new Set(a.map((x) => x.toLowerCase().trim()).filter(Boolean))];

const VENDOR_COLLECTIONS = new Set(["aws", "azure", "gcp"]);

/** theSVG's src/data/icons.json → open-licence items (its default variant), without the cloud vendors' sets. */
export function parseTheSvg(json: unknown): GalleryItem[] {
	if (!Array.isArray(json)) throw new Error("theSVG's index is not a list.");
	const out: GalleryItem[] = [];
	for (const e of json as any[]) {
		if (!e || typeof e.slug !== "string" || !OPEN_LICENCES.has(String(e.license))) continue;
		// theSVG's labels for the cloud vendors' sets do not match the vendors' own terms (Azure is
		// labelled MIT, but Microsoft allows its icons only in diagrams and documentation): those
		// come as vendor sets, with their terms, never from here.
		if (VENDOR_COLLECTIONS.has(String(e.collection))) continue;
		const file = e.variants?.default ?? e.variants?.color ?? e.variants?.mono;
		if (typeof file !== "string" || !/^\/icons\/[\w.-]+\/[\w.-]+\.svg$/.test(file)) continue;
		out.push({
			id: `thesvg:${e.slug}`,
			title: String(e.title ?? e.slug),
			tags: uniq([...(e.aliases ?? []), ...(e.categories ?? []), e.collection ?? "", ...words(String(e.slug))]),
			url: cdn(`/gh/glincker/thesvg@main/public${file}`),
			licence: String(e.license),
			source: "theSVG",
		});
	}
	return out;
}

/** devicon.json → one item per technology (its "original" SVG, or the first one). */
export function parseDevicon(json: unknown): GalleryItem[] {
	if (!Array.isArray(json)) throw new Error("devicon's index is not a list.");
	const out: GalleryItem[] = [];
	for (const e of json as any[]) {
		const name = e?.name;
		const versions: string[] = Array.isArray(e?.versions?.svg) ? e.versions.svg : [];
		if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || !versions.length) continue;
		const v = versions.includes("original") ? "original" : versions.includes("plain") ? "plain" : versions[0];
		if (!/^[\w-]+$/.test(v)) continue;
		out.push({
			id: `devicon:${name}`,
			title: name,
			tags: uniq([...(e.altnames ?? []), ...(e.tags ?? []), ...words(name)]),
			url: cdn(`/gh/devicons/devicon@latest/icons/${name}/${name}-${v}.svg`),
			licence: "MIT · trademark",
			source: "devicon",
		});
	}
	return out;
}

/** Simple Icons' data → logos in their brand colour; logos with a non-open licence of their own are left out. */
export function parseSimpleIcons(json: unknown): GalleryItem[] {
	const list = Array.isArray(json) ? json : (json as any)?.icons;
	if (!Array.isArray(list)) throw new Error("Simple Icons' index is not a list.");
	const out: GalleryItem[] = [];
	for (const e of list as any[]) {
		if (!e || typeof e.slug !== "string" || !/^[\w.-]+$/.test(e.slug)) continue;
		const lic = e.license?.type;
		if (lic && !OPEN_LICENCES.has(lic) && lic !== "CC-BY-4.0") continue;
		out.push({
			id: `simpleicons:${e.slug}`,
			title: String(e.title ?? e.slug),
			tags: uniq([...(e.aliases?.aka ?? []), ...words(String(e.slug))]),
			url: cdn(`/npm/simple-icons@latest/icons/${e.slug}.svg`),
			licence: `${lic ?? "CC0-1.0"} · trademark`,
			fill: typeof e.hex === "string" && /^[0-9a-f]{6}$/i.test(e.hex) ? `#${e.hex}` : undefined,
			source: "Simple Icons",
		});
	}
	return out;
}

/** lucide-static's tags.json ({ name: [tags] }) → line icons. */
export function parseLucide(json: unknown): GalleryItem[] {
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Lucide's index is not an object.");
	return Object.entries(json as Record<string, unknown>)
		.filter(([name]) => /^[\w-]+$/.test(name))
		.map(([name, tags]) => ({
			id: `lucide:${name}`,
			title: name.replace(/-/g, " "),
			tags: uniq([...(Array.isArray(tags) ? (tags as string[]) : []), ...words(name)]),
			url: cdn(`/npm/lucide-static@latest/icons/${name}.svg`),
			licence: "ISC",
			source: "Lucide",
		}));
}

/** @tabler/icons' icons.json → outline icons. */
export function parseTabler(json: unknown): GalleryItem[] {
	if (!json || typeof json !== "object") throw new Error("Tabler's index is not an object.");
	const out: GalleryItem[] = [];
	for (const e of Object.values(json as Record<string, any>)) {
		const name = e?.name;
		if (typeof name !== "string" || !/^[\w-]+$/.test(name) || (e.styles && !e.styles.outline)) continue;
		out.push({
			id: `tabler:${name}`,
			title: name.replace(/-/g, " "),
			tags: uniq([...(Array.isArray(e.tags) ? e.tags.map(String) : []), String(e.category ?? ""), ...words(name)]),
			url: cdn(`/npm/@tabler/icons@latest/icons/outline/${name}.svg`),
			licence: "MIT",
			source: "Tabler",
		});
	}
	return out;
}

/** jsDelivr's flat file list of a GitHub repository → its SVG files (under `path`). */
export function parseGithubListing(json: unknown, repo: string, ref: string, path?: string): GalleryItem[] {
	const files = (json as any)?.files;
	if (!Array.isArray(files)) throw new Error("The repository's file list could not be read.");
	const prefix = path ? `/${path.replace(/^\/+|\/+$/g, "")}/` : "/";
	const out: GalleryItem[] = [];
	for (const f of files as any[]) {
		const name = typeof f?.name === "string" ? f.name : "";
		if (!name.startsWith(prefix) || !/\.svg$/i.test(name) || /(^|\/)\./.test(name) || name.includes("..")) continue;
		const rel = name.slice(prefix.length);
		out.push({
			id: `github:${rel}`,
			title: rel.replace(/\.svg$/i, "").replace(/[-_]+/g, " "),
			tags: uniq(words(rel.replace(/\.svg$/i, ""))),
			url: cdn(`/gh/${repo}@${encodeURIComponent(ref)}${name.split("/").map(encodeURIComponent).join("/")}`),
			source: repo,
		});
		if (out.length >= 5000) break;
	}
	return out;
}

/** "https://github.com/owner/repo/tree/main/icons" (or "owner/repo") → its parts. */
export function parseGithubUrl(text: string): { repo: string; ref?: string; path?: string } | undefined {
	const t = text.trim().replace(/\.git$/, "");
	const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(t);
	if (!m) return undefined;
	return { repo: `${m[1]}/${m[2]}`, ...(m[3] ? { ref: decodeURIComponent(m[3]) } : {}), ...(m[4] ? { path: decodeURIComponent(m[4]) } : {}) };
}

/** A draw.io library (<mxlibrary>[…]</mxlibrary>) → items (images or shape XML). */
export function parseMxLibrary(xml: string, source: string): GalleryItem[] {
	const m = /<mxlibrary[^>]*>([\s\S]*)<\/mxlibrary>/.exec(xml);
	if (!m) throw new Error("Not a draw.io library (no <mxlibrary>).");
	const decoded = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	let list: any[];
	try {
		list = JSON.parse(decoded);
	} catch {
		throw new Error("The library's contents could not be read.");
	}
	if (!Array.isArray(list)) throw new Error("The library's contents are not a list.");
	return list
		.filter((e) => e && (typeof e.xml === "string" || typeof e.data === "string"))
		.map((e, i) => ({
			id: `lib:${i}`,
			title: typeof e.title === "string" && e.title ? e.title : `Shape ${i + 1}`,
			tags: uniq(words(typeof e.title === "string" ? e.title : "")),
			...(typeof e.xml === "string" ? { xml: e.xml } : { data: e.data }),
			w: Number(e.w) > 0 ? Number(e.w) : 48,
			h: Number(e.h) > 0 ? Number(e.h) : 48,
			source,
		}));
}

/** Items → a draw.io library file (for collections and Export). */
export function toMxLibrary(items: { title: string; xml?: string; data?: string; w?: number; h?: number }[]): string {
	const list = items.map((i) => ({ ...(i.xml ? { xml: i.xml } : { data: i.data }), w: i.w ?? 48, h: i.h ?? 48, title: i.title, aspect: "fixed" }));
	return `<mxlibrary>${JSON.stringify(list).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</mxlibrary>`;
}
