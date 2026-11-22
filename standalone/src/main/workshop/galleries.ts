import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { GalleryConfig, GallerySource } from "../settings";
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
import { sanitizeSvg, svgImgUri, svgSize, svgStyleUri } from "./svgSanitize";

/** An index is refreshed from its source after a week, or when the user syncs. */
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FETCH_CONCURRENCY = 8;

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

type Fetcher = (url: string, opts: { binary?: boolean; timeoutMs?: number }) => Promise<{ ok: boolean; status: number; text: string; json?: any }>;

/** Galleries: their indexes (cached in the app's data folder), their SVGs (fetched when shown), search, collections. */
export class GalleryService {
	private indexes = new Map<string, { items: GalleryItem[]; syncedAt: string }>();
	private loading = new Map<string, Promise<GalleryItem[]>>();
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
			if (Array.isArray(j.items) && typeof j.syncedAt === "string") {
				this.indexes.set(id, j);
				return j;
			}
		} catch {
			// not synced yet
		}
		return undefined;
	}

	/** The gallery's items: from memory, the cache, or its sources (fetched again after a week, or when `force`). */
	async items(g: GalleryConfig, force = false): Promise<GalleryItem[]> {
		const local = g.sources.every((s) => s.kind === "folder" || s.kind === "library" || s.kind === "collection");
		if (!force && !local) {
			const idx = this.indexes.get(g.id) ?? this.readCachedIndex(g.id);
			if (idx && Date.now() - Date.parse(idx.syncedAt) < INDEX_MAX_AGE_MS) return idx.items;
		}
		const running = this.loading.get(g.id);
		if (running) return running;
		const p = (async () => {
			this.busy.set(g.id, "Reading the index…");
			this.errors.delete(g.id);
			this.changed();
			try {
				const items: GalleryItem[] = [];
				for (const s of g.sources) items.push(...(await this.readSource(g, s)));
				const idx = { items, syncedAt: new Date().toISOString() };
				this.indexes.set(g.id, idx);
				if (!local) {
					fs.mkdirSync(this.dir(g.id), { recursive: true });
					fs.writeFileSync(path.join(this.dir(g.id), "index.json"), JSON.stringify(idx));
				}
				return items;
			} catch (e: any) {
				this.errors.set(g.id, String(e?.message ?? e));
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
		if (!allowedUrl(url)) throw new Error(`Downloads only come from jsDelivr (cdn.jsdelivr.net, data.jsdelivr.com), not ${new URL(url).host}.`);
		const r = await this.fetcher(url, { timeoutMs: 60_000 });
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
				const ref = s.ref ?? (await this.defaultBranch(s.repo));
				return parseGithubListing(await this.getJson(cdnData(`/v1/package/gh/${s.repo}@${encodeURIComponent(ref)}/flat`)), s.repo, ref, s.path);
			}
			case "folder": {
				const [lib] = await shapeLibraries([{ path: s.path, enabled: true }]);
				if (!lib || lib.kind === "missing") throw new Error(lib && lib.kind === "missing" ? `${s.path}: ${lib.error}` : `${s.path} could not be read.`);
				if (lib.kind !== "images") throw new Error(`${s.path} is not a folder.`);
				return lib.images.map((img, i) => ({ id: `folder:${i}:${img.title}`, title: img.title, tags: img.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), data: img.data, w: img.w, h: img.h, source: path.basename(s.path) }));
			}
			case "library":
				return parseMxLibrary(fs.readFileSync(s.path, "utf8"), path.basename(s.path));
			case "collection": {
				const file = this.collectionFile(g.id);
				return fs.existsSync(file) ? parseMxLibrary(fs.readFileSync(file, "utf8"), g.title) : [];
			}
		}
	}

	/** jsDelivr's default branch for a repository ("main", "master"…). */
	private async defaultBranch(repo: string): Promise<string> {
		const j = await this.getJson(cdnData(`/v1/package/gh/${repo}`)).catch(() => undefined);
		const versions: string[] = Array.isArray(j?.versions) ? j.versions : [];
		return versions[0] ?? "main";
	}

	/** An item's SVG: from the cache, or downloaded, cleaned and cached. Undefined when it cannot be had. */
	async svg(g: GalleryConfig, item: GalleryItem): Promise<string | undefined> {
		if (!item.url) return undefined;
		const file = path.join(this.dir(g.id), "svg", `${createHash("sha1").update(item.id + "|" + item.url).digest("hex").slice(0, 20)}.svg`);
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			// not cached
		}
		if (!allowedUrl(item.url)) return undefined;
		const r = await this.fetcher(item.url, { timeoutMs: 20_000 }).catch(() => undefined);
		if (!r?.ok) return undefined;
		const clean = sanitizeSvg(r.text, { fill: item.fill });
		if (!clean) return undefined;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, clean);
		return clean;
	}

	/** A preview the Workshop page can show (<img src>), or undefined for shapes that are draw.io XML. */
	async preview(g: GalleryConfig, item: GalleryItem): Promise<string | undefined> {
		if (item.data) return /^data:image\//.test(item.data) ? item.data : undefined;
		const svg = await this.svg(g, item);
		return svg ? svgImgUri(svg) : undefined;
	}

	/** What the editor inserts for an item. */
	async insertable(g: GalleryConfig, item: GalleryItem): Promise<Insertable | undefined> {
		if (item.xml) return { xml: item.xml, w: item.w ?? 48, h: item.h ?? 48, title: item.title };
		let uri: string | undefined;
		let size = { w: item.w ?? 48, h: item.h ?? 48 };
		if (item.data) uri = item.data.replace(/^data:([^;,]+);base64,/, "data:$1,");
		else {
			const svg = await this.svg(g, item);
			if (!svg) return undefined;
			uri = svgStyleUri(svg);
			size = svgSize(svg);
		}
		const meta = [`galleryItem=${encodeStyle(item.id)}`, item.licence ? `licence=${encodeStyle(item.licence)}` : ""].filter(Boolean).join(";");
		return { style: `shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;${meta};image=${uri};`, ...size, title: item.title };
	}

	/** Downloads every SVG of a gallery, `FETCH_CONCURRENCY` at a time, reporting progress. */
	async makeOffline(g: GalleryConfig, signal?: AbortSignal): Promise<{ done: number; failed: number }> {
		const items = (await this.items(g)).filter((i) => i.url);
		let next = 0, done = 0, failed = 0;
		const work = async () => {
			while (next < items.length && !signal?.aborted) {
				const item = items[next++];
				if (await this.svg(g, item)) done++;
				else failed++;
				if ((done + failed) % 25 === 0) {
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
			this.changed();
		}
		return { done, failed };
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
		const current = await this.items(collection, true);
		const entry = "xml" in ins ? { title: ins.title, xml: ins.xml, w: ins.w, h: ins.h } : { title: ins.title, data: dataFromStyle(ins.style), w: ins.w, h: ins.h };
		this.writeCollection(collection.id, [...current.map((c) => ({ title: c.title, xml: c.xml, data: c.data, w: c.w, h: c.h })), entry]);
		this.indexes.delete(collection.id);
		await this.items(collection, true);
	}

	removeFromCollection(collection: GalleryConfig, itemId: string): void {
		const current = this.indexes.get(collection.id)?.items ?? [];
		this.writeCollection(collection.id, current.filter((c) => c.id !== itemId).map((c) => ({ title: c.title, xml: c.xml, data: c.data, w: c.w, h: c.h })));
		this.indexes.delete(collection.id);
	}

	private writeCollection(id: string, items: { title: string; xml?: string; data?: string; w?: number; h?: number }[]): void {
		const file = this.collectionFile(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, toMxLibrary(items));
	}

	/** Forgets a gallery's cache (and a collection's file). */
	remove(g: GalleryConfig): void {
		this.indexes.delete(g.id);
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
