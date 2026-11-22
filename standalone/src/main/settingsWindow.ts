import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AgentId, agentStatuses } from "./agents";
import { paths } from "./paths";
import { onSettingsChanged, settings, settingsPath, ShapeLocation, updateSettings, type Settings } from "./settings";
import type { StaticServer } from "./staticServer";

/** Top-level settings keys the window may change (the rest are the app's own bookkeeping). */
const EDITABLE: (keyof Settings)[] = ["appearance", "chat", "chatWidth", "models", "editor", "agents", "shapes"];

/** OmniDraw → Settings…: one window for the whole app. */
export class SettingsWindow {
	private static win: BrowserWindow | undefined;
	private static installed = false;

	public static open(server: StaticServer, section?: string): void {
		SettingsWindow.install();
		const existing = SettingsWindow.win;
		if (existing && !existing.isDestroyed()) {
			existing.focus();
			if (section) existing.webContents.send("settings:toWebview", { type: "section", section });
			return;
		}
		const win = new BrowserWindow({
			width: 760,
			height: 640,
			minWidth: 600,
			minHeight: 440,
			title: "Settings",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#f3f2ef",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-settings.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		SettingsWindow.win = win;
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => (SettingsWindow.win = undefined));
		void win.loadURL(`${server.base}/settings.html${section ? `#${encodeURIComponent(section)}` : ""}`);
	}

	/** The window while it is open (tests screenshot it). */
	public static get window(): BrowserWindow | undefined {
		return SettingsWindow.win && !SettingsWindow.win.isDestroyed() ? SettingsWindow.win : undefined;
	}

	private static install(): void {
		if (SettingsWindow.installed) return;
		SettingsWindow.installed = true;
		ipcMain.on("settings:toHost", (e, msg) => {
			if (!SettingsWindow.win || e.sender !== SettingsWindow.win.webContents) return;
			void SettingsWindow.onMessage(msg);
		});
		onSettingsChanged(() => SettingsWindow.postState());
	}

	private static post(msg: unknown): void {
		const w = SettingsWindow.win;
		if (w && !w.isDestroyed()) w.webContents.send("settings:toWebview", msg);
	}

	private static postState(): void {
		const s = settings();
		SettingsWindow.post({
			type: "state",
			settings: s,
			agents: agentStatuses().map((a) => ({ id: a.id, label: a.label, installed: a.installed, signedIn: a.signedIn, launch: a.launch, problem: a.problem })),
			file: settingsPath(),
			version: app.getVersion(),
		});
	}

	private static async onMessage(msg: any): Promise<void> {
		switch (msg?.type) {
			case "ready":
				SettingsWindow.postState();
				break;
			case "set": {
				const patch: Partial<Settings> = {};
				for (const [k, v] of Object.entries(msg.patch ?? {})) if (EDITABLE.includes(k as keyof Settings)) (patch as any)[k] = v;
				if (Object.keys(patch).length) updateSettings(patch);
				break;
			}
			case "setModelVisible": {
				const agent = String(msg.agent) as AgentId;
				const value = String(msg.value);
				const cur = settings().models[agent] ?? {};
				const hidden = new Set(cur.hidden ?? []);
				if (msg.visible) hidden.delete(value);
				else hidden.add(value);
				const next = { ...cur, hidden: [...hidden] };
				if (next.preferred === value && !msg.visible) delete next.preferred;
				updateSettings({ models: { ...settings().models, [agent]: next } });
				break;
			}
			case "setPreferredModel": {
				const agent = String(msg.agent) as AgentId;
				const cur = settings().models[agent] ?? {};
				const next = { ...cur, preferred: msg.value ? String(msg.value) : undefined };
				if (!next.preferred) delete next.preferred;
				else next.hidden = (next.hidden ?? []).filter((v) => v !== next.preferred);
				updateSettings({ models: { ...settings().models, [agent]: next } });
				break;
			}
			case "addShapeLocation": {
				const w = SettingsWindow.win;
				if (!w) return;
				const r = await dialog.showOpenDialog(w, {
					title: msg.kind === "file" ? "Add a draw.io library" : "Add a folder of shapes",
					properties: msg.kind === "file" ? ["openFile", "multiSelections"] : ["openDirectory", "multiSelections"],
					filters: msg.kind === "file" ? [{ name: "draw.io library", extensions: ["xml", "drawiolib"] }] : undefined,
				});
				if (r.canceled || !r.filePaths.length) return;
				const known = settings().shapes.locations;
				const added: ShapeLocation[] = r.filePaths.filter((p) => !known.some((l) => l.path === p)).map((p) => ({ path: p, enabled: true }));
				if (added.length) updateSettings({ shapes: { locations: [...known, ...added] } });
				break;
			}
			case "revealShapeLocation":
				if (typeof msg.path === "string" && fs.existsSync(msg.path)) shell.showItemInFolder(msg.path);
				break;
			case "openSettingsFile":
				if (!fs.existsSync(settingsPath())) updateSettings({});
				void shell.openPath(settingsPath());
				break;
		}
	}
}
