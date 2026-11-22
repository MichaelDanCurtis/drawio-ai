import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { paths } from "../paths";
import { onSettingsChanged, settings, type GalleryConfig } from "../settings";
import type { StaticServer } from "../staticServer";
import { galleries, galleryConfigs, restoreDefaultGalleries, saveGalleries } from "./index";
import { parseGithubUrl } from "./sources";
import type { Insertable } from "./galleries";

/** Where the Workshop puts shapes: the diagram window used last (main.ts sets this). */
export interface WorkshopHost {
	insert(shape: Insertable): Promise<string | undefined>;
	diagramName(): string | undefined;
}

/**
 * The Shape Workshop: one window for the whole app. This first version is the Shape Gallery
 * (galleries on and off, add, sync, offline, collections, search, insert); Shape Shifter and
 * Shape Creator join it later.
 */
export class WorkshopWindow {
	private static win: BrowserWindow | undefined;
	private static installed = false;
	public static host: WorkshopHost | undefined;
	private static searchSeq = 0;

	public static open(server: StaticServer, mode?: string): void {
		WorkshopWindow.install();
		const existing = WorkshopWindow.win;
		if (existing && !existing.isDestroyed()) {
			existing.focus();
			if (mode) existing.webContents.send("workshop:toWebview", { type: "mode", mode });
			return;
		}
		const win = new BrowserWindow({
			width: 1020,
			height: 720,
			minWidth: 720,
			minHeight: 480,
			title: "Shape Workshop",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#f3f2ef",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-workshop.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		WorkshopWindow.win = win;
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https:/.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => (WorkshopWindow.win = undefined));
		void win.loadURL(`${server.base}/workshop.html${mode ? `#${encodeURIComponent(mode)}` : ""}`);
	}

	/** The window while it is open (tests drive and screenshot it). */
	public static get window(): BrowserWindow | undefined {
		return WorkshopWindow.win && !WorkshopWindow.win.isDestroyed() ? WorkshopWindow.win : undefined;
	}

	private static install(): void {
		if (WorkshopWindow.installed) return;
		WorkshopWindow.installed = true;
		ipcMain.on("workshop:toHost", (e, msg) => {
			if (!WorkshopWindow.win || e.sender !== WorkshopWindow.win.webContents) return;
			void WorkshopWindow.onMessage(msg).catch((err) => WorkshopWindow.post({ type: "error", message: String(err?.message ?? err) }));
		});
		onSettingsChanged((_s, patch) => {
			if ("workshop" in patch || "appearance" in patch) WorkshopWindow.postState();
		});
		galleries().onChange(() => WorkshopWindow.postState());
	}

	private static post(msg: unknown): void {
		const w = WorkshopWindow.win;
		if (w && !w.isDestroyed()) w.webContents.send("workshop:toWebview", msg);
	}

	private static stateTimer: NodeJS.Timeout | undefined;
	private static postState(): void {
		clearTimeout(WorkshopWindow.stateTimer);
		WorkshopWindow.stateTimer = setTimeout(() => {
			WorkshopWindow.post({
				type: "state",
				galleries: galleries().status(galleryConfigs()),
				iconStyle: settings().appearance.iconStyle,
				diagram: WorkshopWindow.host?.diagramName() ?? null,
				version: app.getVersion(),
			});
		}, 30);
	}

	private static config(id: unknown): GalleryConfig {
		const g = galleryConfigs().find((x) => x.id === id);
		if (!g) throw new Error("That gallery is gone.");
		return g;
	}

	private static update(id: string, patch: Partial<GalleryConfig>): void {
		saveGalleries(galleryConfigs().map((g) => (g.id === id ? { ...g, ...patch } : g)));
	}

	private static newId(title: string): string {
		const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "gallery";
		let id = base, n = 2;
		while (galleryConfigs().some((g) => g.id === id)) id = `${base}-${n++}`;
		return id;
	}

	private static add(g: GalleryConfig): void {
		saveGalleries([...galleryConfigs(), g]);
		void galleries().items(g, true);
	}

	private static async onMessage(msg: any): Promise<void> {
		const s = galleries();
		switch (msg?.type) {
			case "ready":
				WorkshopWindow.postState();
				// indexes of enabled galleries load in the background, so search has something to search
				for (const g of galleryConfigs()) if (g.enabled) void s.items(g);
				break;
			case "toggle":
				WorkshopWindow.update(String(msg.id), { enabled: !!msg.enabled });
				if (msg.enabled) void s.items(WorkshopWindow.config(msg.id));
				break;
			case "rename": {
				const title = String(msg.title ?? "").trim().slice(0, 80);
				if (title) WorkshopWindow.update(String(msg.id), { title });
				break;
			}
			case "sync":
				await s.items(WorkshopWindow.config(msg.id), true);
				break;
			case "offline": {
				const r = await s.makeOffline(WorkshopWindow.config(msg.id));
				WorkshopWindow.post({ type: "notice", message: `${r.done} shapes are on this computer${r.failed ? `; ${r.failed} could not be downloaded` : ""}.` });
				break;
			}
			case "remove": {
				const g = WorkshopWindow.config(msg.id);
				const isCollection = g.sources.some((x) => x.kind === "collection");
				const r = await dialog.showMessageBox(WorkshopWindow.win!, {
					type: "warning",
					message: `Remove “${g.title}”?`,
					detail: isCollection
						? "Its shapes are deleted from this computer. Export it first to keep them. Shapes already in diagrams stay."
						: g.builtin
						? "Its downloaded shapes are deleted from this computer. Restore defaults brings it back."
						: "Its downloaded shapes are deleted from this computer. Shapes already in diagrams stay.",
					buttons: ["Remove", "Cancel"],
					defaultId: 1,
					cancelId: 1,
				});
				if (r.response !== 0) return;
				s.remove(g);
				saveGalleries(galleryConfigs().filter((x) => x.id !== g.id));
				break;
			}
			case "restoreDefaults":
				restoreDefaultGalleries();
				break;
			case "addGithub": {
				const parsed = parseGithubUrl(String(msg.url ?? ""));
				if (!parsed) throw new Error("That is not a GitHub repository address (github.com/owner/repo, optionally /tree/branch/folder).");
				WorkshopWindow.add({ id: WorkshopWindow.newId(parsed.repo.split("/")[1]), title: `${parsed.repo}${parsed.path ? `/${parsed.path}` : ""}`, sources: [{ kind: "github", ...parsed }], enabled: true });
				break;
			}
			case "addLocal": {
				const folder = msg.kind !== "library";
				const r = await dialog.showOpenDialog(WorkshopWindow.win!, {
					title: folder ? "Add a folder of SVG or PNG shapes" : "Add a draw.io library",
					properties: folder ? ["openDirectory"] : ["openFile"],
					filters: folder ? undefined : [{ name: "draw.io library", extensions: ["xml", "drawiolib"] }],
				});
				const p = r.filePaths[0];
				if (r.canceled || !p) return;
				WorkshopWindow.add({ id: WorkshopWindow.newId(path.basename(p).replace(/\.(xml|drawiolib)$/i, "")), title: path.basename(p).replace(/\.(xml|drawiolib)$/i, ""), sources: [folder ? { kind: "folder", path: p } : { kind: "library", path: p }], enabled: true });
				break;
			}
			case "newCollection": {
				const title = String(msg.title ?? "").trim().slice(0, 80) || "My collection";
				const id = WorkshopWindow.newId(title);
				s.createCollection(id);
				WorkshopWindow.add({ id, title, sources: [{ kind: "collection" }], enabled: true });
				WorkshopWindow.post({ type: "selectGallery", id });
				break;
			}
			case "exportCollection": {
				const g = WorkshopWindow.config(msg.id);
				const r = await dialog.showSaveDialog(WorkshopWindow.win!, { title: "Export as a draw.io library", defaultPath: path.join(app.getPath("documents"), `${g.title.replace(/[\\/:*?"<>|]+/g, " ")}.xml`), filters: [{ name: "draw.io library", extensions: ["xml"] }] });
				if (r.canceled || !r.filePath) return;
				fs.copyFileSync(s.collectionFile(g.id), r.filePath);
				shell.showItemInFolder(r.filePath);
				break;
			}
			case "search":
				await WorkshopWindow.search(msg);
				break;
			case "insert": {
				const g = WorkshopWindow.config(msg.galleryId);
				const item = (await s.items(g)).find((i) => i.id === msg.itemId);
				if (!item) throw new Error("That shape is not in the gallery any more.");
				const shape = await s.insertable(g, item);
				if (!shape) throw new Error(`${item.title} could not be downloaded. Check the connection and try again.`);
				if (!WorkshopWindow.host) throw new Error("Open a diagram first.");
				const where = await WorkshopWindow.host.insert(shape);
				WorkshopWindow.post({ type: "notice", message: where ? `Added ${item.title} to ${where}.` : "Open a diagram first." });
				break;
			}
			case "addToCollection": {
				const col = WorkshopWindow.config(msg.collectionId);
				const g = WorkshopWindow.config(msg.galleryId);
				const item = (await s.items(g)).find((i) => i.id === msg.itemId);
				if (!item) throw new Error("That shape is not in the gallery any more.");
				await s.addToCollection(col, g, item);
				WorkshopWindow.post({ type: "notice", message: `Added ${item.title} to ${col.title}.` });
				break;
			}
			case "removeFromCollection":
				s.removeFromCollection(WorkshopWindow.config(msg.collectionId), String(msg.itemId));
				await s.items(WorkshopWindow.config(msg.collectionId), true);
				break;
			case "openHomepage": {
				const st = s.status(galleryConfigs()).find((x) => x.id === msg.id);
				if (st?.homepage && /^https:\/\//.test(st.homepage)) void shell.openExternal(st.homepage);
				break;
			}
		}
	}

	/** Results first (titles, galleries, licences), then their previews as they download. */
	private static async search(msg: any): Promise<void> {
		const s = galleries();
		const seq = ++WorkshopWindow.searchSeq;
		const configs = galleryConfigs();
		const hits = await s.search(configs, String(msg.query ?? ""), { galleryId: msg.galleryId || undefined, limit: Math.min(600, Number(msg.limit) || 240) });
		if (seq !== WorkshopWindow.searchSeq) return;
		WorkshopWindow.post({
			type: "results",
			reqId: msg.reqId,
			hits: hits.map((h) => ({ galleryId: h.galleryId, galleryTitle: h.galleryTitle, id: h.item.id, title: h.item.title, source: h.item.source, licence: h.item.licence ?? "", xml: !!h.item.xml })),
		});
		let next = 0;
		const batch: { galleryId: string; id: string; src: string }[] = [];
		const flush = () => {
			if (batch.length && seq === WorkshopWindow.searchSeq) WorkshopWindow.post({ type: "previews", reqId: msg.reqId, previews: batch.splice(0) });
		};
		const work = async () => {
			while (next < hits.length && seq === WorkshopWindow.searchSeq) {
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
