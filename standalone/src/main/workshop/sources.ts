import { createHash } from "crypto";
import * as zlib from "zlib";
import type { GallerySource } from "./types";
import { decodeForCheck, safeImageData } from "./svgSanitize";
import { escapeXml, mapAttributes, mapXml, tagInfo, unescapeXml } from "./xmlScan";

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

/** A file in a GitHub repository, read directly (for an index too big a repository holds for jsDelivr). */
export function raw(pathname: string): string {
	const mirror = process.env.OMNIDRAW_GALLERY_MIRROR;
	return mirror ? `${mirror}/raw${pathname}` : `https://raw.githubusercontent.com${pathname}`;
}

/** The only hosts the Workshop downloads from (and the test mirror). */
export function allowedUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const mirror = process.env.OMNIDRAW_GALLERY_MIRROR;
		if (mirror && url.startsWith(mirror + "/")) return true;
		return u.protocol === "https:" && (u.hostname === "cdn.jsdelivr.net" || u.hostname === "data.jsdelivr.com" || u.hostname === "raw.githubusercontent.com");
	} catch {
		return false;
	}
}

export const SOURCE_INFO: Record<Exclude<GallerySource["kind"], "github" | "folder" | "library" | "collection">, { label: string; index: () => string; homepage: string; note: string }> = {
	// The licences are only in the repository's data file; the SVGs come from its npm package
	// (the repository is over jsDelivr's 50 MB limit for GitHub, so files it has not cached fail).
	thesvg: { label: "theSVG", index: () => raw("/glincker/thesvg/main/src/data/icons.json"), homepage: "https://thesvg.org", note: "Only icons whose own licence is CC0, MIT or Apache-2.0, and not the AWS, Azure or Google Cloud sets (their real terms differ). Brand logos stay their owners' trademarks." },
	devicon: { label: "devicon", index: () => cdn("/npm/devicon@latest/devicon.json"), homepage: "https://devicon.dev", note: "MIT. Logos stay their owners' trademarks." },
	simpleicons: { label: "Simple Icons", index: () => cdn("/npm/simple-icons@latest/data/simple-icons.json"), homepage: "https://simpleicons.org", note: "CC0, except logos with their own licence (kept only when open). Logos stay their owners' trademarks." },
	lucide: { label: "Lucide", index: () => cdn("/npm/lucide-static@latest/tags.json"), homepage: "https://lucide.dev", note: "ISC." },
	tabler: { label: "Tabler", index: () => cdn("/npm/@tabler/icons@latest/icons.json"), homepage: "https://tabler.io/icons", note: "MIT." },
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const uniq = (a: string[]) => [...new Set(a.map((x) => x.toLowerCase().trim()).filter(Boolean))];

const VENDOR_COLLECTIONS = new Set(["aws", "azure", "gcp"]);

/** Where one of theSVG's SVGs is published: country flags in @thesvg/flags (4:3), the rest in @thesvg/static. */
function theSvgUrl(slug: string, collection: unknown, file: string): string {
	const flag = collection === "flags" ? /^flag-([a-z0-9-]+)$/.exec(slug) : null;
	if (flag) return cdn(`/npm/@thesvg/flags@latest/dist/svg/4x3/${flag[1]}.svg`);
	return cdn(`/npm/@thesvg/static@latest/dist/svg${file.slice("/icons".length)}`);
}

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
			url: theSvgUrl(e.slug, e.collection, file),
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
			// from npm: devicon's GitHub repository is over jsDelivr's size limit, so files it has not cached fail
			url: cdn(`/npm/devicon@latest/icons/${name}/${name}-${v}.svg`),
			licence: "MIT · trademark",
			source: "devicon",
		});
	}
	return out;
}

/**
 * Simple Icons' slug for a title, when its data has none (their own rule: "+" plus, "." dot,
 * "&" and, accents dropped, anything else that is not a letter or digit removed).
 */
export function simpleIconsSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/\+/g, "plus")
		.replace(/\./g, "dot")
		.replace(/&/g, "and")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]/g, "");
}

/** Simple Icons' data → logos in their brand colour; logos with a non-open licence of their own are left out. */
export function parseSimpleIcons(json: unknown): GalleryItem[] {
	const list = Array.isArray(json) ? json : (json as any)?.icons;
	if (!Array.isArray(list)) throw new Error("Simple Icons' index is not a list.");
	const out: GalleryItem[] = [];
	for (const e of list as any[]) {
		if (!e) continue;
		const slug = typeof e.slug === "string" ? e.slug : typeof e.title === "string" ? simpleIconsSlug(e.title) : "";
		if (!slug || !/^[\w.-]+$/.test(slug)) continue;
		const lic = e.license?.type;
		if (lic && !OPEN_LICENCES.has(lic) && lic !== "CC-BY-4.0") continue;
		out.push({
			id: `simpleicons:${slug}`,
			title: String(e.title ?? slug),
			tags: uniq([...(e.aliases?.aka ?? []), ...words(slug)]),
			url: cdn(`/npm/simple-icons@latest/icons/${slug}.svg`),
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

/**
 * "https://github.com/owner/repo/tree/main/icons" (or "owner/repo") → its parts. A branch whose
 * name has a "/" in it cannot be told apart from a folder in such an address: the first part is
 * taken as the branch.
 */
export function parseGithubUrl(text: string): { repo: string; ref?: string; path?: string } | undefined {
	const t = text.trim().replace(/\.git$/, "");
	const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(t);
	if (!m) return undefined;
	return { repo: `${m[1]}/${m[2]}`, ...(m[3] ? { ref: decodeURIComponent(m[3]) } : {}), ...(m[4] ? { path: decodeURIComponent(m[4]) } : {}) };
}

/** An id for a library entry from what it holds, so it still names the same shape after others are added or removed. */
export function libraryItemId(e: { title?: string; xml?: string; data?: string }): string {
	return `lib:${createHash("sha1").update(`${e.title ?? ""}\u0000${e.xml ?? ""}\u0000${e.data ?? ""}`).digest("hex").slice(0, 16)}`;
}

/** The most a shape's XML (or an inline stencil's) may be once unpacked: draw.io keeps both deflated. */
const MAX_SHAPE_XML = 8 * 1024 * 1024;

/** draw.io's Graph.decompress: base64, inflated, URI-decoded. Undefined when the text is not that, or too large. */
function unpack(data: string): string | undefined {
	try {
		return decodeURIComponent(zlib.inflateRawSync(Buffer.from(data, "base64"), { maxOutputLength: MAX_SHAPE_XML }).toString("utf8"));
	} catch {
		return undefined;
	}
}

/** draw.io's Graph.compress. */
function pack(text: string): string {
	return zlib.deflateRawSync(Buffer.from(encodeURIComponent(text), "utf8")).toString("base64");
}

/** Marks around a picture that was checked, while a shape is cleaned (two characters no text holds). */
const CHECKED = "\uFDD0";
const CHECKED_END = "\uFDD1";

/** An address as the browser reads it: tabs and line breaks anywhere in it are dropped, spaces and control characters at its start too. */
function address(v: string): string {
	return v.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
}

/** Whether text still says "an SVG, embedded" somewhere outside the marks, however it is spelled (entities, also twice; spaces in between). */
function uncheckedSvg(marked: string): boolean {
	const rest = marked.replace(/\uFDD0[^\uFDD1]*\uFDD1/g, "");
	return /data:image\/svg/i.test(decodeForCheck(unescapeXml(unescapeXml(rest))).replace(/[\u0000-\u0020]+/g, ""));
}

/**
 * A library shape's XML with the pictures it embeds checked like every other image: an SVG
 * is cleaned, a bitmap stays, and anything else that claims to be embedded loses its picture.
 * Pictures are looked for where draw.io draws them from:
 * - every key of a cell's style whose value is a `data:` address (`image`, `indicatorImage`…),
 * - the <image> elements of an inline stencil (`shape=stencil(…)`),
 * - and both of those kept once in the model's <defs> (`image=def(0)`).
 * Names of files and web addresses are not embedded content and stay as they are.
 *
 * Returns the XML in the form it came in (deflated or plain), the very same text when there
 * was nothing to change. Returns undefined, so that the shape is left out, for what cannot
 * be checked: XML that cannot be read or is not a graph model (draw.io would unpack a file's
 * pages itself), a DTD (whose entities could stand for anything), an inline stencil that is
 * not written the way draw.io writes it, or an SVG that is embedded anywhere else (the HTML
 * of a label, say).
 */
export function cleanShapeXml(xml: string): string | undefined {
	if (typeof xml !== "string" || !xml) return undefined;
	const plain = xml.trimStart().startsWith("<");
	const text = plain ? xml : unpack(xml);
	if (text === undefined || text.length > MAX_SHAPE_XML || text.includes(CHECKED) || text.includes(CHECKED_END) || /<!DOCTYPE/i.test(text)) return undefined;
	let unreadable = false;
	/** A `data:` address as it may stay (`form`: for a style, or for an attribute of its own), marked when it is an SVG; undefined when it may not. */
	const picture = (uri: string, form: "style" | "img"): string | undefined => {
		const safe = safeImageData(uri)?.[form];
		return safe && /^data:image\/svg/i.test(safe) ? `${CHECKED}${safe}${CHECKED_END}` : safe;
	};
	/** An attribute's value with what `check` makes of it; as it was written when nothing changed, so that only the marks are added. */
	const rewrite = (raw: string, check: (decoded: string) => string | undefined): string | undefined => {
		const decoded = unescapeXml(raw);
		const next = check(decoded);
		if (next === undefined) return undefined;
		if (next.replace(/[\uFDD0\uFDD1]/g, "") !== decoded) return escapeXml(next);
		// unchanged: the checked SVGs are marked where they stand
		let marked = raw;
		for (const m of next.matchAll(/\uFDD0([^\uFDD1]*)\uFDD1/g)) {
			if (!raw.includes(m[1])) return escapeXml(next);
			if (!marked.includes(`${CHECKED}${m[1]}`)) marked = marked.split(m[1]).join(`${CHECKED}${m[1]}${CHECKED_END}`);
		}
		return marked === raw ? undefined : marked;
	};
	/** An inline stencil (packed) with the pictures of its elements checked; undefined when nothing changed. */
	const stencil = (packed: string): string | undefined => {
		const inner = unpack(packed);
		if (inner === undefined || inner.includes(CHECKED) || inner.includes(CHECKED_END) || /<!DOCTYPE/i.test(inner)) return void (unreadable = true);
		const marked = mapXml(inner, {
			tag: (tag) =>
				tagInfo(tag).closing
					? tag
					: mapAttributes(tag, (_name, raw) =>
							rewrite(raw, (decoded) => {
								const a = address(decoded);
								return /^data:/i.test(a) ? picture(a, "img") ?? "" : undefined;
							})
					  ),
		});
		if (marked === undefined || uncheckedSvg(marked)) return void (unreadable = true);
		const cleaned = marked.replace(/[\uFDD0\uFDD1]/g, "");
		return cleaned === inner ? undefined : pack(cleaned);
	};
	/** One value of a style (or of a <def>): a picture, an inline stencil, or something else. Undefined: as it is; null: it goes. */
	const value = (v: string): string | null | undefined => {
		const a = address(v);
		if (/^stencil\(/i.test(a)) {
			// draw.io takes what is between "stencil(" and the last character, whatever that is: only its own form is read here
			const m = /^stencil\(([A-Za-z0-9+/=]*)\)$/.exec(a);
			if (!m) return void (unreadable = true);
			const repacked = stencil(m[1]);
			return repacked === undefined ? undefined : `stencil(${repacked})`;
		}
		if (/^data:/i.test(a)) return picture(a, "style") ?? null;
		return undefined;
	};
	/** A cell's style (decoded, as draw.io reads it: keys end at ";"); undefined when it holds neither a picture nor a stencil. */
	const style = (decoded: string): string | undefined => {
		let found = false;
		const parts = decoded.split(";").flatMap((part) => {
			const eq = part.indexOf("=");
			const next = eq < 0 ? undefined : value(part.slice(eq + 1));
			if (next === undefined) return [part];
			found = true;
			return next === null ? [] : [`${part.slice(0, eq + 1)}${next}`];
		});
		return found ? parts.join(";") : undefined;
	};
	let root: string | undefined;
	const marked = mapXml(text, {
		tag: (tag) => {
			const { name, local, closing } = tagInfo(tag);
			root = root ?? name;
			if (closing) return tag;
			return mapAttributes(tag, (attribute, raw) => {
				if (attribute === "style") return rewrite(raw, style);
				// (a picture or a stencil that several cells share is kept once, in <defs><def data="…"/></defs>)
				if (local === "def" && attribute === "data")
					return rewrite(raw, (decoded) => {
						const next = value(decoded);
						return next === null ? "" : next;
					});
				return undefined;
			});
		},
	});
	if (marked === undefined || unreadable || root !== "mxGraphModel" || uncheckedSvg(marked)) return undefined;
	const cleaned = marked.replace(/[\uFDD0\uFDD1]/g, "");
	if (cleaned === text) return xml;
	return plain ? cleaned : pack(cleaned);
}

/**
 * A draw.io library (<mxlibrary>[…]</mxlibrary>) → items (images or shape XML). Images are
 * checked (and SVGs cleaned), also the pictures inside a shape's XML: an entry whose image is
 * not a plain embedded image is left out. Throws when the file is not a library.
 */
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
	const out: GalleryItem[] = [];
	const seen = new Map<string, number>();
	list.forEach((e, i) => {
		if (!e) return;
		let content: { xml: string } | { data: string };
		if (typeof e.xml === "string") {
			const clean = cleanShapeXml(e.xml);
			if (!clean) return;
			content = { xml: clean };
		}
		else if (typeof e.data === "string") {
			const img = safeImageData(e.data);
			if (!img) return;
			content = { data: img.img };
		} else return;
		// (draw.io's stencil converter writes the word "null" for a shape that has no name)
		const title = typeof e.title === "string" && e.title && !/^\s*(null|undefined)\s*$/i.test(e.title) ? e.title : `Shape ${i + 1}`;
		// the same shape twice in one library still gets two ids
		let id = libraryItemId({ title, ...content });
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		if (n) id += `-${n + 1}`;
		out.push({ id, title, tags: uniq(words(title)), ...content, w: Number(e.w) > 0 ? Number(e.w) : 48, h: Number(e.h) > 0 ? Number(e.h) : 48, source });
	});
	return out;
}

/** Items → a draw.io library file (for collections and Export). */
export function toMxLibrary(items: { title: string; xml?: string; data?: string; w?: number; h?: number }[]): string {
	const list = items.map((i) => ({ ...(i.xml ? { xml: i.xml } : { data: i.data }), w: i.w ?? 48, h: i.h ?? 48, title: i.title, aspect: "fixed" }));
	return `<mxlibrary>${JSON.stringify(list).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</mxlibrary>`;
}
