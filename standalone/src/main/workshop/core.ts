import * as fs from "fs";
import * as path from "path";
import type { GalleryService, Insertable } from "./galleries";
import { withDefaultGalleries } from "./palette";
import { parseGithubUrl } from "./sources";
import type { GalleryConfig } from "./types";

/** Where the Workshop puts shapes, and whose shape sets it shows: the diagram used last. */
export interface WorkshopHost {
	insert(shape: Insertable): Promise<string | undefined>;
	diagramName(): string | undefined;
	/** draw.io's own shape sets (what its "More Shapes" dialog chose between), or undefined with no diagram open. */
	shapeSets(): { title: string; entries: { id: string; title: string; on: boolean }[] }[] | undefined;
	setShapeSet(id: string, on: boolean): void;
	/** Asks the editor to report its shape sets again. */
	refreshShapeSets(): void;
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
export class WorkshopCore {
	private searchSeq = 0;
	private offlineRuns = new Set<string>();
	private stateTimer: NodeJS.Timeout | undefined;

	constructor(private readonly ports: WorkshopPorts) {}

	public dispose(): void {
		clearTimeout(this.stateTimer);
		this.searchSeq++;
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
		let next = 0;
		const batch: { galleryId: string; id: string; src: string }[] = [];
		const flush = () => {
			if (batch.length && seq === this.searchSeq) this.ports.post({ type: "previews", reqId: msg.reqId, previews: batch.splice(0) });
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
}
