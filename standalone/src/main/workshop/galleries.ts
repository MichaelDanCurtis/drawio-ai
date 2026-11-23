import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { GalleryConfig, GallerySource } from "./types";
import { shapeLibraries } from "../shapeLocations";
import {
	allowedUrl,
	cdnData,
	GalleryItem,
	parseDevicon,
	parseGithubListing,
	parseLucide,
	parseMxLibrary,
	parseSimpleIcons,
	parseTabler,
	parseTheSvg,
	SOURCE_INFO,
	toMxLibrary,
} from "./sources";
import { MAX_SVG_BYTES, safeImageData, sanitizeSvg, svgImgUri, svgSize, svgStyleUri } from "./svgSanitize";
import type { FetchOptions, FetchResult } from "./fetch";

/** An index is refreshed from its source after a week (in the background), or when the user syncs. */
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** After a failed refresh, the next try waits this long (searches keep the older index meanwhile). */
const RETRY_AFTER_MS = 10 * 60 * 1000;
/** Folders and libraries on this computer are read again at most this often (or when synced). */
const LOCAL_TTL_MS = 15 * 1000;
const FETCH_CONCURRENCY = 8;
const MAX_INDEX_BYTES = 12 * 1024 * 1024;
/** Bumped when items in a cached index change shape or address (an older cache is read again from its sources). */
const INDEX_FORMAT = 3;

export interface GalleryStatus {
	id: string;
	title: string;
	enabled: boolean;
	builtin: boolean;
	kinds: GallerySource["kind"][];
	/** Where it comes from, in words ("Lucide + Tabler", "owner/repo/icons", a folder path). */
	from: string;
	note?: string;
	count?: number;
	cached?: number;
	syncedAt?: string;
	busy?: string;
	error?: string;
	homepage?: string;
}

/** A search hit: the item and the gallery it is in. */
export interface GalleryHit {
	galleryId: string;
	galleryTitle: string;
	item: GalleryItem;
	score: number;
}

/** What draw.io needs to put the shape in a diagram. */
export type Insertable = { style: string; w: number; h: number; title: string } | { xml: string; w: number; h: number; title: string };

type Fetcher = (url: string, opts: FetchOptions) => Promise<FetchResult>;

/** Galleries: their indexes (cached in the app's data folder), their SVGs (fetched when shown), search, collections. */
export class GalleryService {
	private indexes = new Map<string, { items: GalleryItem[]; syncedAt: string }>();
	private loading = new Map<string, Promise<GalleryItem[]>>();
	/** When a local gallery was last read, and when a failed refresh may be tried again. */
	private readAt = new Map<string, number>();
	private retryAt = new Map<string, number>();
	private svgLoading = new Map<string, Promise<string | undefined>>();
	private offline = new Map<string, { ctrl: AbortController; run: Promise<{ done: number; failed: number }> }>();
	private busy = new Map<string, string>();
	private errors = new Map<string, string>();
	private listeners = new Set<() => void>();

	constructor(
		private readonly root: string,
		private readonly fetcher: Fetcher
	) {}

	onChange(l: () => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	private changed(): void {
		for (const l of this.listeners) {
			try {
				l();
			} catch {
				// a closed window
			}
		}
	}

	private dir(id: string): string {
		return path.join(this.root, "galleries", id);
	}
	collectionFile(id: string): string {
		return path.join(this.root, "collections", `${id}.xml`);
	}

	status(configs: GalleryConfig[]): GalleryStatus[] {
		return configs.map((g) => {
			const idx = this.indexes.get(g.id) ?? this.readCachedIndex(g.id);
			let cached: number | undefined;
			try {
				cached = fs.readdirSync(path.join(this.dir(g.id), "svg")).length;
			} catch {
				cached = undefined;
			}
			const net = g.sources.filter((s) => s.kind in SOURCE_INFO) as { kind: keyof typeof SOURCE_INFO }[];
			return {
				id: g.id,
				title: g.title,
				enabled: g.enabled,
				builtin: !!g.builtin,
				kinds: g.sources.map((s) => s.kind),
				from: g.sources.map(describeSource).join(" + "),
				note: net.map((s) => SOURCE_INFO[s.kind].note).join(" ") || (g.sources[0]?.kind === "github" ? "Check the repository's licence before you share diagrams with its icons." : undefined),
				homepage: net[0] ? SOURCE_INFO[net[0].kind].homepage : g.sources[0]?.kind === "github" ? `https://github.com/${(g.sources[0] as any).repo}` : undefined,
				count: idx?.items.length,
				cached,
				syncedAt: idx?.syncedAt,
				busy: this.busy.get(g.id),
				error: this.errors.get(g.id),
			};
		});
	}

	private readCachedIndex(id: string): { items: GalleryItem[]; syncedAt: string } | undefined {
		try {
			const j = JSON.parse(fs.readFileSync(path.join(this.dir(id), "index.json"), "utf8"));
			if (j.format === INDEX_FORMAT && Array.isArray(j.items) && typeof j.syncedAt === "string") {
				const idx = { items: j.items, syncedAt: j.syncedAt };
				this.indexes.set(id, idx);
				return idx;
			}
		} catch {
			// not synced yet
		}
		return undefined;
	}

	/**
	 * The gallery's items. Internet galleries answer from memory or the cache at once; a week-old
	 * index is refreshed in the background (and after a failure, not again for ten minutes).
	 * Folders and libraries are read again after a few seconds. `force` reads the sources now.
	 */
	async items(g: GalleryConfig, force = false): Promise<GalleryItem[]> {
		const local = isLocal(g);
		const idx = this.indexes.get(g.id) ?? (local ? undefined : this.readCachedIndex(g.id));
		if (!force && idx) {
			if (local) {
				if (Date.now() - (this.readAt.get(g.id) ?? 0) < LOCAL_TTL_MS) return idx.items;
			} else {
				const stale = Date.now() - Date.parse(idx.syncedAt) >= INDEX_MAX_AGE_MS;
				if (stale && Date.now() >= (this.retryAt.get(g.id) ?? 0)) void this.load(g);
				return idx.items;
			}
		}
		if (!force && !idx && Date.now() < (this.retryAt.get(g.id) ?? 0)) return [];
		return this.load(g);
	}

	/** Reads a gallery's sources (one read at a time per gallery). */
	private load(g: GalleryConfig): Promise<GalleryItem[]> {
		const running = this.loading.get(g.id);
		if (running) return running;
		const local = isLocal(g);
		const p = (async () => {
			this.busy.set(g.id, "Reading the index…");
			this.errors.delete(g.id);
			this.changed();
			try {
				const items: GalleryItem[] = [];
				for (const s of g.sources) items.push(...(await this.readSource(g, s)));
				const idx = { items, syncedAt: new Date().toISOString() };
				this.indexes.set(g.id, idx);
				this.readAt.set(g.id, Date.now());
				this.retryAt.delete(g.id);
				if (!local) {
					fs.mkdirSync(this.dir(g.id), { recursive: true });
					fs.writeFileSync(path.join(this.dir(g.id), "index.json"), JSON.stringify({ format: INDEX_FORMAT, ...idx }));
				}
				return items;
			} catch (e: any) {
				this.errors.set(g.id, String(e?.message ?? e));
				this.retryAt.set(g.id, Date.now() + (local ? LOCAL_TTL_MS : RETRY_AFTER_MS));
				// an older index is better than none
				return this.indexes.get(g.id)?.items ?? [];
			} finally {
				this.busy.delete(g.id);
				this.loading.delete(g.id);
				this.changed();
			}
		})();
		this.loading.set(g.id, p);
		return p;
	}

	private async getJson(url: string): Promise<any> {
		if (!allowedUrl(url)) throw new Error(`Downloads only come from jsDelivr and GitHub (cdn.jsdelivr.net, data.jsdelivr.com, raw.githubusercontent.com), not ${new URL(url).host}.`);
		const r = await this.fetcher(url, { timeoutMs: 60_000, maxBytes: MAX_INDEX_BYTES });
		if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status} for ${new URL(url).pathname}.`);
		if (r.json === undefined) throw new Error(`${new URL(url).pathname} is not JSON.`);
		return r.json;
	}

	private async readSource(g: GalleryConfig, s: GallerySource): Promise<GalleryItem[]> {
		switch (s.kind) {
			case "thesvg":
				return parseTheSvg(await this.getJson(SOURCE_INFO.thesvg.index()));
			case "devicon":
				return parseDevicon(await this.getJson(SOURCE_INFO.devicon.index()));
			case "simpleicons":
				return parseSimpleIcons(await this.getJson(SOURCE_INFO.simpleicons.index()));
			case "lucide":
				return parseLucide(await this.getJson(SOURCE_INFO.lucide.index()));
			case "tabler":
				return parseTabler(await this.getJson(SOURCE_INFO.tabler.index()));
			case "github": {
				if (s.ref) return parseGithubListing(await this.getJson(cdnData(`/v1/package/gh/${s.repo}@${encodeURIComponent(s.ref)}/flat`)), s.repo, s.ref, s.path);
				const { ref, listing } = await this.defaultListing(s.repo);
				return parseGithubListing(listing, s.repo, ref, s.path);
			}
			case "folder": {
				const [lib] = await shapeLibraries([{ path: s.path, enabled: true }]);
				if (!lib || lib.kind === "missing") throw new Error(lib && lib.kind === "missing" ? `${s.path}: ${lib.error}` : `${s.path} could not be read.`);
				if (lib.kind !== "images") throw new Error(`${s.path} is not a folder.`);
				const out: GalleryItem[] = [];
				for (const img of lib.images) {
					// SVGs from a folder are cleaned like any other (a folder can hold anything)
					const safe = safeImageData(img.data);
					if (safe) out.push({ id: `folder:${img.title}:${out.length}`, title: img.title, tags: img.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), data: safe.img, w: img.w, h: img.h, source: path.basename(s.path) });
				}
				return out;
			}
			case "library":
				return parseMxLibrary(fs.readFileSync(s.path, "utf8"), path.basename(s.path));
			case "collection":
				return this.readCollection(g);
		}
	}

	/** A repository's file list when no branch was named: "main", then "master", then its newest tag. */
	private async defaultListing(repo: string): Promise<{ ref: string; listing: unknown }> {
		const tryRef = async (ref: string) => ({ ref, listing: await this.getJson(cdnData(`/v1/package/gh/${repo}@${encodeURIComponent(ref)}/flat`)) });
		let first: unknown;
		for (const ref of ["main", "master"]) {
			try {
				return await tryRef(ref);
			} catch (e) {
				first ??= e;
			}
		}
		const j = await this.getJson(cdnData(`/v1/package/gh/${repo}`)).catch(() => undefined);
		const tag = Array.isArray(j?.versions) ? j.versions.find((v: unknown) => typeof v === "string" && /^[\w.-]+$/.test(v)) : undefined;
		if (tag) return tryRef(tag);
		throw first instanceof Error ? new Error(`${repo} has no "main" or "master" branch on jsDelivr, and no tags. Add it with its branch (github.com/${repo}/tree/<branch>).`) : first;
	}

	/** A collection's shapes, read from its file. Throws when the file is there but cannot be read, so nothing overwrites it. */
	private readCollection(g: GalleryConfig): GalleryItem[] {
		const file = this.collectionFile(g.id);
		if (!fs.existsSync(file)) return [];
		return parseMxLibrary(fs.readFileSync(file, "utf8"), g.title);
	}

	/** An item's SVG: from the cache, or downloaded, cleaned and cached. Undefined when it cannot be had. */
	async svg(g: GalleryConfig, item: GalleryItem, signal?: AbortSignal): Promise<string | undefined> {
		if (!item.url) return undefined;
		const file = path.join(this.dir(g.id), "svg", `${createHash("sha1").update(item.id + "|" + item.url).digest("hex").slice(0, 20)}.svg`);
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			// not cached
		}
		if (!allowedUrl(item.url)) return undefined;
		// one download per file, however many ask for it at once
		const running = this.svgLoading.get(file);
		if (running) return running;
		const url = item.url;
		const p = (async () => {
			const r = await this.fetcher(url, { timeoutMs: 20_000, maxBytes: MAX_SVG_BYTES, signal }).catch(() => undefined);
			if (!r?.ok) return undefined;
			const clean = sanitizeSvg(r.text, { fill: item.fill });
			if (!clean) return undefined;
			// a gallery removed while this downloaded keeps no files
			if (signal?.aborted) return clean;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, clean);
			return clean;
		})().finally(() => this.svgLoading.delete(file));
		this.svgLoading.set(file, p);
		return p;
	}

	/** A preview the Workshop page can show (<img src>), or undefined for shapes that are draw.io XML. */
	async preview(g: GalleryConfig, item: GalleryItem): Promise<string | undefined> {
		if (item.data) return safeImageData(item.data)?.img;
		const svg = await this.svg(g, item);
		return svg ? svgImgUri(svg) : undefined;
	}

	/** What the editor inserts for an item. */
	async insertable(g: GalleryConfig, item: GalleryItem): Promise<Insertable | undefined> {
		if (item.xml) return { xml: item.xml, w: item.w ?? 48, h: item.h ?? 48, title: item.title };
		let uri: string | undefined;
		let size = { w: item.w ?? 48, h: item.h ?? 48 };
		if (item.data) {
			uri = safeImageData(item.data)?.style;
			if (!uri) return undefined;
		} else {
			const svg = await this.svg(g, item);
			if (!svg) return undefined;
			uri = svgStyleUri(svg);
			size = svgSize(svg);
		}
		const meta = [`galleryItem=${encodeStyle(item.id)}`, item.licence ? `licence=${encodeStyle(item.licence)}` : ""].filter(Boolean).join(";");
		return { style: `shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;${meta};image=${uri};`, ...size, title: item.title };
	}

	/**
	 * Downloads every SVG of a gallery, `FETCH_CONCURRENCY` at a time, reporting progress. A second
	 * call while it runs gets the same run; `stopOffline` (and removing the gallery) stops it.
	 */
	makeOffline(g: GalleryConfig): Promise<{ done: number; failed: number }> {
		const running = this.offline.get(g.id);
		if (running) return running.run;
		const ctrl = new AbortController();
		const run = (async () => {
			const items = (await this.items(g)).filter((i) => i.url);
			let next = 0, done = 0, failed = 0;
			const work = async () => {
				while (next < items.length && !ctrl.signal.aborted) {
					const item = items[next++];
					if (await this.svg(g, item, ctrl.signal)) done++;
					else if (!ctrl.signal.aborted) failed++;
					if ((done + failed) % 25 === 0 && !ctrl.signal.aborted) {
						this.busy.set(g.id, `Downloading ${done + failed} of ${items.length}…`);
						this.changed();
					}
				}
			};
			this.busy.set(g.id, `Downloading 0 of ${items.length}…`);
			this.changed();
			try {
				await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, work));
			} finally {
				this.busy.delete(g.id);
				this.offline.delete(g.id);
				this.changed();
			}
			return { done, failed };
		})();
		this.offline.set(g.id, { ctrl, run });
		return run;
	}

	stopOffline(id: string): void {
		this.offline.get(id)?.ctrl.abort();
	}

	/** Ranked hits across galleries (AND over the words; title before tags; exact before word start before substring). */
	async search(configs: GalleryConfig[], query: string, opts: { galleryId?: string; limit?: number } = {}): Promise<GalleryHit[]> {
		const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
		const hits: GalleryHit[] = [];
		for (const g of configs) {
			if (opts.galleryId ? g.id !== opts.galleryId : !g.enabled) continue;
			const items = await this.items(g);
			for (const item of items) {
				const score = terms.length ? rank(item, terms) : 0.01;
				if (score > 0) hits.push({ galleryId: g.id, galleryTitle: g.title, item, score });
			}
		}
		hits.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
		return hits.slice(0, opts.limit ?? 120);
	}

	/** A new, empty collection file. */
	createCollection(id: string): void {
		const file = this.collectionFile(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (!fs.existsSync(file)) fs.writeFileSync(file, toMxLibrary([]));
	}

	/** Adds a shape to a collection (stored as an image or shape XML in a draw.io library file). */
	async addToCollection(collection: GalleryConfig, from: GalleryConfig, item: GalleryItem): Promise<void> {
		const ins = await this.insertable(from, item);
		if (!ins) throw new Error(`${item.title} could not be downloaded.`);
		const current = this.readCollection(collection);
		const entry = "xml" in ins ? { title: ins.title, xml: ins.xml, w: ins.w, h: ins.h } : { title: ins.title, data: dataFromStyle(ins.style), w: ins.w, h: ins.h };
		this.writeCollection(collection.id, [...current.map((c) => ({ title: c.title, xml: c.xml, data: c.data, w: c.w, h: c.h })), entry]);
		await this.items(collection, true);
	}

	/** Takes a shape out of a collection by its id (ids come from the shape itself, so a stale list cannot remove the wrong one). */
	async removeFromCollection(collection: GalleryConfig, itemId: string): Promise<boolean> {
		const current = this.readCollection(collection);
		const keep = current.filter((c) => c.id !== itemId);
		if (keep.length === current.length) return false;
		this.writeCollection(collection.id, keep.map((c) => ({ title: c.title, xml: c.xml, data: c.data, w: c.w, h: c.h })));
		await this.items(collection, true);
		return true;
	}

	/** A new collection filled in one go (an imported stencil): its file, written whole. */
	importCollection(id: string, items: GalleryItem[]): void {
		this.writeCollection(id, items.map((c) => ({ title: c.title, xml: c.xml, data: c.data, w: c.w, h: c.h })));
	}

	private writeCollection(id: string, items: { title: string; xml?: string; data?: string; w?: number; h?: number }[]): void {
		const file = this.collectionFile(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, toMxLibrary(items));
	}

	/** Forgets a gallery's cache (and a collection's file). */
	remove(g: GalleryConfig): void {
		this.stopOffline(g.id);
		this.indexes.delete(g.id);
		this.readAt.delete(g.id);
		this.retryAt.delete(g.id);
		this.errors.delete(g.id);
		fs.rmSync(this.dir(g.id), { recursive: true, force: true });
		if (g.sources.some((s) => s.kind === "collection")) fs.rmSync(this.collectionFile(g.id), { force: true });
		this.changed();
	}
}

/** How well an item matches every term (0 when one term matches nothing). */
export function rank(item: GalleryItem, terms: string[]): number {
	const title = item.title.toLowerCase();
	const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean);
	let total = 0;
	for (const t of terms) {
		let best = 0;
		if (title === t) best = 1;
		else if (titleWords.includes(t)) best = 0.9;
		else if (titleWords.some((w) => w.startsWith(t))) best = 0.75;
		else if (title.includes(t)) best = 0.6;
		for (const tag of item.tags) {
			if (best >= 0.7) break;
			if (tag === t) best = Math.max(best, 0.7);
			else if (tag.startsWith(t)) best = Math.max(best, 0.5);
			else if (t.length > 3 && tag.includes(t)) best = Math.max(best, 0.35);
		}
		if (best === 0) return 0;
		total += best;
	}
	// shorter titles first when equally good: "aws" before "aws-amplify"
	return total / terms.length - Math.min(title.length, 60) / 6000;
}

function isLocal(g: GalleryConfig): boolean {
	return g.sources.every((s) => s.kind === "folder" || s.kind === "library" || s.kind === "collection");
}

function describeSource(s: GallerySource): string {
	switch (s.kind) {
		case "github":
			return `${s.repo}${s.path ? `/${s.path}` : ""}`;
		case "folder":
		case "library":
			return s.path;
		case "collection":
			return "Your collection";
		default:
			return SOURCE_INFO[s.kind].label;
	}
}

/** Keeps a value from ending a draw.io style key early. */
function encodeStyle(v: string): string {
	return encodeURIComponent(v).replace(/%2F/g, "/").replace(/%3A/g, ":").replace(/%20/g, " ");
}

/** The image of an "image=data:…" style, as a library data URI (with ";base64"). */
function dataFromStyle(style: string): string {
	const m = /image=(data:[^,;]+),([^;]*)/.exec(style);
	return m ? `${m[1]};base64,${m[2]}` : "";
}
