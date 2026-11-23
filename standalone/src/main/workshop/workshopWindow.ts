import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import * as path from "path";
import { paths } from "../paths";
import { onSettingsChanged, settings } from "../settings";
import type { StaticServer } from "../staticServer";
import { apiKeys } from "../api/keys";
import { desktopCreator, standInCreator } from "../creatorRunner";
import { WorkshopCore, type WorkshopHost } from "./core";
import type { CreatorPorts } from "./creator";
import { galleries, galleryConfigs, saveGalleries } from "./index";

export type { WorkshopHost };

let creator: CreatorPorts | undefined;
let standIn: CreatorPorts | undefined;

/**
 * The Shape Workshop: one window for the whole app, with the Shape Gallery, the Shape Shifter
 * and the Shape Creator.
 */
export class WorkshopWindow {
	private static win: BrowserWindow | undefined;
	private static installed = false;
	public static host: WorkshopHost | undefined;
	/** Opens the app's Settings (main.ts sets it). */
	public static openSettings: ((section?: string) => void) | undefined;
	/** The page's other half (shared with the VS Code extension's panel). */
	private static readonly core = new WorkshopCore({
		post: (msg) => WorkshopWindow.post(msg),
		service: galleries,
		configs: galleryConfigs,
		save: saveGalleries,
		host: () => WorkshopWindow.host,
		look: () => ({ iconStyle: settings().appearance.iconStyle, matrix: settings().appearance.matrix }),
		version: () => app.getVersion(),
		confirm: async (message, detail, yes) => (await dialog.showMessageBox(WorkshopWindow.win!, { type: "warning", message, detail, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1 })).response === 0,
		pickLocal: async (kind) => {
			const folder = kind === "folder";
			const r = await dialog.showOpenDialog(WorkshopWindow.win!, {
				title: folder ? "Add a folder of SVG or PNG shapes" : "Add a draw.io library",
				properties: folder ? ["openDirectory"] : ["openFile"],
				filters: folder ? undefined : [{ name: "draw.io library", extensions: ["xml", "drawiolib"] }],
			});
			return r.canceled ? undefined : r.filePaths[0];
		},
		pickExport: async (name) => {
			const r = await dialog.showSaveDialog(WorkshopWindow.win!, { title: "Export as a draw.io library", defaultPath: path.join(app.getPath("documents"), name), filters: [{ name: "draw.io library", extensions: ["xml"] }] });
			return r.canceled ? undefined : r.filePath;
		},
		reveal: (file) => shell.showItemInFolder(file),
		openExternal: (url) => void shell.openExternal(url),
		// (the end-to-end run draws with a stand-in: no agent is started and nothing is sent anywhere)
		get creator() {
			return process.env.DRAWAI_E2E && process.env.DRAWAI_E2E_CREATOR ? (standIn ??= standInCreator()) : (creator ??= desktopCreator((agent) => WorkshopWindow.openSettings?.(agent.startsWith("api:") ? "api" : "agents")));
		},
		shifter: true,
		pickStencil: async () => {
			// (the end-to-end run has nobody to answer a file dialog)
			if (process.env.DRAWAI_E2E && process.env.DRAWAI_E2E_STENCIL) return process.env.DRAWAI_E2E_STENCIL;
			const r = await dialog.showOpenDialog(WorkshopWindow.win!, { title: "Import a Visio stencil", properties: ["openFile"], filters: [{ name: "Visio stencil", extensions: ["vssx", "vss", "vssm"] }] });
			return r.canceled ? undefined : r.filePaths[0];
		},
	});

	public static open(server: StaticServer, mode?: string): void {
		WorkshopWindow.install();
		const existing = WorkshopWindow.win;
		if (existing && !existing.isDestroyed()) {
			// (it may be minimized or hidden behind other windows)
			if (existing.isMinimized()) existing.restore();
			existing.show();
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
		win.on("closed", () => {
			WorkshopWindow.win = undefined;
			WorkshopWindow.core.pageGone();
		});
		// the sidebar can change in the editor itself (the Scratchpad's ✕, a set enabled from a search): ask again
		win.on("focus", () => WorkshopWindow.host?.refreshShapeSets());
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
			void WorkshopWindow.core.onMessage(msg).catch((err) => WorkshopWindow.post({ type: "error", message: String(err?.message ?? err) }));
		});
		onSettingsChanged((_s, patch) => {
			if ("workshop" in patch || "appearance" in patch) WorkshopWindow.core.postState();
			// (the models an agent or an API key offers, and which of them are hidden in Settings)
			if (("models" in patch || "modelCatalog" in patch) && WorkshopWindow.window) WorkshopWindow.core.creatorChanged();
		});
		// an API key was added, replaced or removed: a model of that provider that is drawing with the old one is closed
		apiKeys().onChange((id) => WorkshopWindow.core.creatorChanged((agent) => agent === `api:${id}`));
		galleries().onChange(() => WorkshopWindow.core.postState());
	}

	private static post(msg: unknown): void {
		const w = WorkshopWindow.win;
		if (w && !w.isDestroyed()) w.webContents.send("workshop:toWebview", msg);
	}

	/** Something the Workshop shows changed elsewhere (draw.io's shape sets, the diagram in front). */
	public static refresh(): void {
		if (!WorkshopWindow.window) return;
		WorkshopWindow.core.postState();
		WorkshopWindow.core.postSelection();
	}

	/** The selection of the diagram used last changed: the Shape Shifter shows it. */
	public static selection(): void {
		if (WorkshopWindow.window) WorkshopWindow.core.postSelection();
	}
}
