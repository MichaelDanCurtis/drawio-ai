import * as fs from "fs";
import * as path from "path";
import type { GalleryHit, GalleryService, Insertable } from "./galleries";
import { withDefaultGalleries } from "./palette";
import { builtInInsertable, builtInPreview, colourOf, restyleRequest, selectionInfo, styleEdits, type BuiltInShape, type SelectedCell, type SelectionInfo, type ShapeChange, type StyleEdit } from "./shifter";
import { parseGithubUrl, parseMxLibrary, type GalleryItem } from "./sources";
import type { GalleryConfig } from "./types";

/**
 * What the Shape Shifter needs of the diagram used last: its editor searches draw.io's own
 * shapes and converts Visio stencils, and its selection is what "change a shape" changes.
 */
export interface ShifterHost {
	/** draw.io's own shapes that match, with their thumbnails. */
	searchBuiltIn(query: string, limit: number): Promise<BuiltInShape[]>;
	selectedCells(): Promise<SelectedCell[]>;
	/** Changes the styles in one undo step (the user's own change: not held for review). */
	applyStyles(edits: StyleEdit[]): Promise<void>;
	/** Hands a request about the selection to the agent; `shown` is the short line a transcript shows for it. */
	askAgent(request: string, shown: string): Promise<void>;
	/** A Visio stencil (.vssx, .vss) as a draw.io library, converted by the editor. */
	convertStencil(file: string): Promise<{ library: string; warnings: string[] }>;
}

/** Where the Workshop puts shapes, and whose shape sets it shows: the diagram used last. */
export interface WorkshopHost {
	insert(shape: Insertable): Promise<string | undefined>;
	diagramName(): string | undefined;
	/** draw.io's own shape sets (what its "More Shapes" dialog chose between), or undefined with no diagram open. */
	shapeSets(): { title: string; entries: { id: string; title: string; on: boolean }[] }[] | undefined;
	setShapeSet(id: string, on: boolean): void;
	/** Asks the editor to report its shape sets again. */
	refreshShapeSets(): void;
	/** The Shape Shifter's side (a program that has it: see WorkshopPorts.shifter). */
	shifter?: ShifterHost;
}

/**
 * What the Shape Workshop page (renderer/workshop.html) needs from the program showing it: the
 * desktop app shows it in a window of its own, the VS Code extension in a webview panel.
 */
export interface WorkshopPorts {
	/** Sends a message to the page. */
	post(msg: unknown): void;
	service(): GalleryService;
	configs(): GalleryConfig[];
	save(list: GalleryConfig[]): void;
	host(): WorkshopHost | undefined;
	look(): { iconStyle: string; matrix: string };
	version(): string;
	/** Asks before something is removed; true when the user said yes. */
	confirm(message: string, detail: string, yes: string): Promise<boolean>;
	/** Lets the user choose a folder of shapes or a draw.io library file. */
	pickLocal(kind: "folder" | "library"): Promise<string | undefined>;
	/** Lets the user choose where to save a file; `name` is the suggested file name. */
	pickExport(name: string): Promise<string | undefined>;
	/** Shows a saved file where it is. */
	reveal(file: string): void;
	openExternal(url: string): void;
	/** This program has the Shape Shifter: its WorkshopHost gives `shifter`, and `pickStencil` lets the user choose a stencil. */
	shifter?: boolean;
	/** Lets the user choose a Visio stencil file. */
	pickStencil?(): Promise<string | undefined>;
	/**
	 * A gallery that is off downloads nothing: until it is switched on it cannot be browsed,
	 * synced or made offline, and the default galleries come back switched off. (The VS Code
	 * extension, which sends nothing anywhere unasked. The desktop app lets a gallery that is
	 * off be browsed.)
	 */
	offStaysOff?: boolean;
}

/** Whether using this gallery can download: one of its sources is on the internet. */
export function downloads(g: GalleryConfig): boolean {
	return g.sources.some((s) => s.kind !== "folder" && s.kind !== "library" && s.kind !== "collection");
}

/**
 * The Shape Workshop page's other half: answers its messages. This first version is the Shape
 * Gallery (galleries on and off, add, sync, offline, collections, search, insert); Shape Shifter
 * and Shape Creator join it later.
 */
/** How long the Shifter's search waits for draw.io's own shapes before the galleries answer alone. */
const OWN_SEARCH_MS = 8000;

/** `p`'s value, or `fallback` when it fails or takes longer than `ms`. */
function withFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		p.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			}
		);
	});
}

export class WorkshopCore {
	private searchSeq = 0;
	private offlineRuns = new Set<string>();
	private stateTimer: NodeJS.Timeout | undefined;
	private selectionTimer: NodeJS.Timeout | undefined;
	/** draw.io's own shapes of the Shifter's last search, by the key the page was given for each. */
	private found = new Map<string, Insertable>();
	/** A converted stencil waiting for its name. */
	private stencil: { token: string; items: GalleryItem[] } | undefined;
	private stencilSeq = 0;
	private selectionSeq = 0;
	/** Counts the pages this has served: what was started for a page that is gone is not kept for the next. */
	private pageSeq = 0;

	constructor(private readonly ports: WorkshopPorts) {}

	public dispose(): void {
		clearTimeout(this.stateTimer);
		this.pageGone();
	}

	/** The page was closed: what waited for it (a search, a selection, a converted stencil without a name) is dropped. */
	public pageGone(): void {
		this.pageSeq++;
		clearTimeout(this.selectionTimer);
		this.searchSeq++;
		this.selectionSeq++;
		this.stencil = undefined;
		this.found.clear();
	}

	/** Tells the page what is selected in the diagram used last (the Shifter's "change a shape"). */
	public postSelection(): void {
		clearTimeout(this.selectionTimer);
		this.selectionTimer = setTimeout(() => {
			// (an answer that arrives after a later question's is out of date)
			const seq = ++this.selectionSeq;
			const post = (info: SelectionInfo) => {
				if (seq === this.selectionSeq) this.ports.post({ type: "selection", ...info });
			};
			const shifter = this.ports.host()?.shifter;
			if (!shifter) return post({ count: 0, icons: 0 });
			shifter.selectedCells().then(
				(cells) => post(selectionInfo(cells)),
				() => post({ count: 0, icons: 0 })
			);
		}, 120);
	}

	/** The Shifter's host, or an error that says what is missing. */
	private shifterHost(): ShifterHost {
		const shifter = this.ports.host()?.shifter;
		if (!shifter) throw new Error(this.ports.shifter ? "Open a diagram first." : "The Shape Shifter is not available here yet.");
		return shifter;
	}

	/** Tells the page what it shows: the galleries, the look, the diagram in front and its shape sets. */
	public postState(): void {
		clearTimeout(this.stateTimer);
		this.stateTimer = setTimeout(() => {
			this.ports.post({
				type: "state",
				galleries: this.ports.service().status(this.ports.configs()),
				...this.ports.look(),
				diagram: this.ports.host()?.diagramName() ?? null,
				sets: this.ports.host()?.shapeSets() ?? null,
				version: this.ports.version(),
				shifter: !!this.ports.shifter,
			});
		}, 30);
	}

	private config(id: unknown): GalleryConfig {
		const g = this.ports.configs().find((x) => x.id === id);
		if (!g) throw new Error("That gallery is gone.");
		return g;
	}

	/** With `offStaysOff`: refuses to use a gallery that is off and would download. */
	private allow(g: GalleryConfig): GalleryConfig {
		if (this.ports.offStaysOff && !g.enabled && downloads(g)) {
			throw new Error(`“${g.title}” is off. Switch it on to use it: nothing is downloaded for a gallery that is off.`);
		}
		return g;
	}

	private update(id: string, patch: Partial<GalleryConfig>): void {
		this.ports.save(this.ports.configs().map((g) => (g.id === id ? { ...g, ...patch } : g)));
	}

	private newId(title: string): string {
		const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "gallery";
		let id = base, n = 2;
		while (this.ports.configs().some((g) => g.id === id)) id = `${base}-${n++}`;
		return id;
	}

	private add(g: GalleryConfig): void {
		this.ports.save([...this.ports.configs(), g]);
		void this.ports.service().items(g, true);
	}

	public async onMessage(msg: any): Promise<void> {
		const s = this.ports.service();
		switch (msg?.type) {
			case "ready":
				this.ports.host()?.refreshShapeSets();
				this.postState();
				// indexes of enabled galleries load in the background, so search has something to search
				for (const g of this.ports.configs()) if (g.enabled) void s.items(g);
				break;
			case "toggle":
				this.update(String(msg.id), { enabled: !!msg.enabled });
				if (msg.enabled) void s.items(this.config(msg.id));
				break;
			case "rename": {
				const title = String(msg.title ?? "").trim().slice(0, 80);
				if (title) this.update(String(msg.id), { title });
				break;
			}
			case "sync":
				await s.items(this.allow(this.config(msg.id)), true);
				break;
			case "offline": {
				const id = String(msg.id);
				this.allow(this.config(id));
				if (this.offlineRuns.has(id)) return;
				this.offlineRuns.add(id);
				try {
					const r = await s.makeOffline(this.config(id));
					// removed while it ran: nothing to report
					if (!this.ports.configs().some((g) => g.id === id)) return;
					this.ports.post({ type: "notice", message: `${r.done} shapes are on this computer${r.failed ? `; ${r.failed} could not be downloaded` : ""}.` });
				} finally {
					this.offlineRuns.delete(id);
				}
				break;
			}
			case "remove": {
				const g = this.config(msg.id);
				const isCollection = g.sources.some((x) => x.kind === "collection");
				const yes = await this.ports.confirm(
					`Remove “${g.title}”?`,
					isCollection
						? "Its shapes are deleted from this computer. Export it first to keep them. Shapes already in diagrams stay."
						: g.builtin
						? "Its downloaded shapes are deleted from this computer. Restore defaults brings it back."
						: "Its downloaded shapes are deleted from this computer. Shapes already in diagrams stay.",
					"Remove"
				);
				if (!yes) return;
				s.remove(g);
				this.ports.save(this.ports.configs().filter((x) => x.id !== g.id));
				break;
			}
			case "restoreDefaults":
				this.ports.save(withDefaultGalleries(this.ports.configs(), !this.ports.offStaysOff));
				break;
			case "setShapeSet":
				if (typeof msg.id === "string" && /^[\w.-]{1,60}$/.test(msg.id)) this.ports.host()?.setShapeSet(msg.id, !!msg.on);
				break;
			case "addGithub": {
				const parsed = parseGithubUrl(String(msg.url ?? ""));
				if (!parsed) throw new Error("That is not a GitHub repository address (github.com/owner/repo, optionally /tree/branch/folder).");
				this.add({ id: this.newId(parsed.repo.split("/")[1]), title: `${parsed.repo}${parsed.path ? `/${parsed.path}` : ""}`, sources: [{ kind: "github", ...parsed }], enabled: true });
				break;
			}
			case "addLocal": {
				const folder = msg.kind !== "library";
				const p = await this.ports.pickLocal(folder ? "folder" : "library");
				if (!p) return;
				this.add({ id: this.newId(path.basename(p).replace(/\.(xml|drawiolib)$/i, "")), title: path.basename(p).replace(/\.(xml|drawiolib)$/i, ""), sources: [folder ? { kind: "folder", path: p } : { kind: "library", path: p }], enabled: true });
				break;
			}
			case "newCollection": {
				const title = String(msg.title ?? "").trim().slice(0, 80) || "My collection";
				const id = this.newId(title);
				s.createCollection(id);
				this.add({ id, title, sources: [{ kind: "collection" }], enabled: true });
				this.ports.post({ type: "selectGallery", id });
				break;
			}
			case "exportCollection": {
				const g = this.config(msg.id);
				const to = await this.ports.pickExport(`${g.title.replace(/[\\/:*?"<>|]+/g, " ")}.xml`);
				if (!to) return;
				fs.copyFileSync(s.collectionFile(g.id), to);
				this.ports.reveal(to);
				break;
			}
			case "search":
				await this.search(msg);
				break;
			// ----- the Shape Shifter -----
			case "find":
				await this.find(msg);
				break;
			case "insertFound": {
				const shape = this.found.get(String(msg.key));
				if (!shape) throw new Error("Search again: that result is out of date.");
				const host = this.ports.host();
				if (!host) throw new Error("Open a diagram first.");
				const where = await host.insert(shape);
				this.ports.post({ type: "notice", message: where ? `Added ${shape.title} to ${where}.` : "Open a diagram first." });
				break;
			}
			case "selection":
				this.postSelection();
				break;
			case "restyle": {
				const change: ShapeChange = { fill: colourOf(msg.fill), stroke: colourOf(msg.stroke), font: colourOf(msg.font, false), icon: colourOf(msg.icon, false) };
				if (!Object.values(change).some(Boolean)) throw new Error("Pick a colour first.");
				const shifter = this.shifterHost();
				const cells = await shifter.selectedCells();
				if (!cells.length) throw new Error("Select the shapes to change in the diagram first.");
				const edits = styleEdits(cells, change);
				if (!edits.length) throw new Error(change.icon && !change.fill && !change.stroke && !change.font ? "None of the selected shapes is an icon that can be given one colour." : "Nothing to change on what is selected.");
				await shifter.applyStyles(edits);
				this.ports.post({ type: "notice", message: `Changed ${edits.length} shape${edits.length === 1 ? "" : "s"}. Undo in the diagram takes it back.` });
				this.postSelection();
				break;
			}
			case "describeChange": {
				const text = String(msg.text ?? "").trim().slice(0, 2000);
				if (!text) throw new Error("Say what to change first.");
				const shifter = this.shifterHost();
				const cells = await shifter.selectedCells();
				if (!cells.length) throw new Error("Select the shapes to change in the diagram first.");
				await shifter.askAgent(restyleRequest(text, cells.length), `✎ Change ${cells.length} shape${cells.length === 1 ? "" : "s"}: ${text}`);
				this.ports.post({ type: "notice", message: "Handed to the agent in the chat. Its changes wait there for you to keep or revert." });
				break;
			}
			case "importStencil": {
				const page = this.pageSeq;
				const file = await this.ports.pickStencil?.();
				if (!file) return;
				const converted = await this.shifterHost().convertStencil(file);
				if (page !== this.pageSeq) return; // the page was closed meanwhile: nobody is there to name it
				const name = path.basename(file).replace(/\.(vssx|vss|vssm)$/i, "");
				const items = parseMxLibrary(converted.library, name).filter((i) => i.xml || i.data);
				if (!items.length) throw new Error(`${path.basename(file)} has no shapes draw.io could read.`);
				this.stencil = { token: `s${++this.stencilSeq}`, items };
				this.ports.post({ type: "stencil", token: this.stencil.token, name, count: items.length, titles: items.slice(0, 12).map((i) => i.title), warnings: converted.warnings.slice(0, 6) });
				break;
			}
			case "saveStencil": {
				const pending = this.stencil;
				if (!pending || pending.token !== msg.token) throw new Error("Import the stencil again: it is no longer waiting.");
				this.stencil = undefined;
				const title = String(msg.title ?? "").trim().slice(0, 80) || "Stencil";
				const id = this.newId(title);
				s.importCollection(id, pending.items);
				this.add({ id, title, sources: [{ kind: "collection" }], enabled: true });
				this.ports.post({ type: "notice", message: `${pending.items.length} shapes are in the new collection “${title}”.` });
				this.ports.post({ type: "selectGallery", id });
				break;
			}
			case "dropStencil":
				if (this.stencil && this.stencil.token === msg.token) this.stencil = undefined;
				break;
			case "insert": {
				const g = this.allow(this.config(msg.galleryId));
				const item = (await s.items(g)).find((i) => i.id === msg.itemId);
				if (!item) throw new Error("That shape is not in the gallery any more.");
				const shape = await s.insertable(g, item);
				if (!shape) throw new Error(`${item.title} could not be downloaded. Check the connection and try again.`);
				const host = this.ports.host();
				if (!host) throw new Error("Open a diagram first.");
				const where = await host.insert(shape);
				this.ports.post({ type: "notice", message: where ? `Added ${item.title} to ${where}.` : "Open a diagram first." });
				break;
			}
			case "addToCollection": {
				const col = this.config(msg.collectionId);
				const g = this.allow(this.config(msg.galleryId));
				const item = (await s.items(g)).find((i) => i.id === msg.itemId);
				if (!item) throw new Error("That shape is not in the gallery any more.");
				await s.addToCollection(col, g, item);
				this.ports.post({ type: "collectionChanged", id: col.id });
				this.ports.post({ type: "notice", message: `Added ${item.title} to ${col.title}.` });
				break;
			}
			case "removeFromCollection": {
				const col = this.config(msg.collectionId);
				const removed = await s.removeFromCollection(col, String(msg.itemId));
				this.ports.post({ type: "collectionChanged", id: col.id });
				if (!removed) this.ports.post({ type: "notice", message: "That shape was already gone." });
				break;
			}
			case "openHomepage": {
				const st = s.status(this.ports.configs()).find((x) => x.id === msg.id);
				if (st?.homepage && /^https:\/\//.test(st.homepage)) this.ports.openExternal(st.homepage);
				break;
			}
		}
	}

	/** Results first (titles, galleries, licences), then their previews as they download. */
	private async search(msg: any): Promise<void> {
		const s = this.ports.service();
		const seq = ++this.searchSeq;
		const configs = this.ports.configs();
		// (one gallery is browsed whether it is on or off: with `offStaysOff`, only when that downloads nothing)
		const browsed = msg.galleryId ? configs.find((c) => c.id === msg.galleryId) : undefined;
		if (browsed) {
			try {
				this.allow(browsed);
			} catch (e) {
				this.ports.post({ type: "results", reqId: msg.reqId, hits: [] });
				throw e;
			}
		}
		const hits = await s.search(configs, String(msg.query ?? ""), { galleryId: msg.galleryId || undefined, limit: Math.min(600, Number(msg.limit) || 240) });
		if (seq !== this.searchSeq) return;
		this.ports.post({
			type: "results",
			reqId: msg.reqId,
			hits: hits.map((h) => ({ galleryId: h.galleryId, galleryTitle: h.galleryTitle, id: h.item.id, title: h.item.title, source: h.item.source, licence: h.item.licence ?? "", xml: !!h.item.xml })),
		});
		await this.pumpPreviews(seq, msg.reqId, hits, configs);
	}

	/** The previews of gallery hits, sent to the page as they are read or downloaded (while the search is still the newest). */
	private async pumpPreviews(seq: number, reqId: unknown, hits: GalleryHit[], configs: GalleryConfig[]): Promise<void> {
		const s = this.ports.service();
		let next = 0;
		const batch: { galleryId: string; id: string; src: string }[] = [];
		const flush = () => {
			if (batch.length && seq === this.searchSeq) this.ports.post({ type: "previews", reqId, previews: batch.splice(0) });
		};
		const work = async () => {
			while (next < hits.length && seq === this.searchSeq) {
				const h = hits[next++];
				const g = configs.find((c) => c.id === h.galleryId)!;
				const src = await s.preview(g, h.item).catch(() => undefined);
				if (src) batch.push({ galleryId: h.galleryId, id: h.item.id, src });
				if (batch.length >= 24) flush();
			}
		};
		await Promise.all(Array.from({ length: 8 }, work));
		flush();
	}

	/**
	 * The Shape Shifter's "find by words": draw.io's own shapes (from the editor of the diagram
	 * used last) and the shapes of every gallery that is on, in one answer.
	 */
	private async find(msg: any): Promise<void> {
		const s = this.ports.service();
		const seq = ++this.searchSeq;
		const configs = this.ports.configs();
		const query = String(msg.query ?? "").trim().slice(0, 200);
		const shifter = this.ports.host()?.shifter;
		const [own, hits] = await Promise.all([
			// (no diagram open, its editor still loading or not answering: the galleries answer alone)
			query && shifter ? withFallback(shifter.searchBuiltIn(query, 36), OWN_SEARCH_MS, [] as BuiltInShape[]) : Promise.resolve([] as BuiltInShape[]),
			query ? s.search(configs, query, { limit: Math.min(240, Number(msg.limit) || 120) }) : Promise.resolve([] as GalleryHit[]),
		]);
		if (seq !== this.searchSeq) return;
		this.found = new Map();
		const shapes = own.filter((b) => b && typeof b.style === "string" && !b.isEdge).slice(0, 36);
		this.ports.post({
			type: "found",
			reqId: msg.reqId,
			diagram: !!shifter,
			own: shapes.map((b, i) => {
				const key = `own:${seq}:${i}`;
				this.found.set(key, builtInInsertable(b));
				return { key, title: String(b.title || "Shape").slice(0, 80), library: typeof b.library === "string" ? b.library.slice(0, 40) : "", src: builtInPreview(b) };
			}),
			hits: hits.map((h) => ({ galleryId: h.galleryId, galleryTitle: h.galleryTitle, id: h.item.id, title: h.item.title, source: h.item.source, licence: h.item.licence ?? "", xml: !!h.item.xml })),
		});
		await this.pumpPreviews(seq, msg.reqId, hits, configs);
	}
}
