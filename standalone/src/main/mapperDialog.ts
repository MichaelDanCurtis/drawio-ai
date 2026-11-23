import { app, BaseWindow, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { agentEnv } from "./agents";
import { createContext } from "./mapper/context";
import { MapperDialogCore, MapRunOutcome, visible } from "./mapper/dialog";
import type { MapperService } from "./mapper/service";
import type { MapInput } from "./mapper/types";
import { paths } from "./paths";
import { settings } from "./settings";
import type { StaticServer } from "./staticServer";

export { visible };

/** What the Mapper needs from the diagram window it maps into. */
export interface MapperHost {
	win: BaseWindow;
	client: import("../../../src/DrawioClient/CustomizedDrawioClient").CustomizedDrawioClient;
	/** The diagram's folder: default for folder and file fields. */
	cwd(): string;
	ready(): boolean;
	service: MapperService;
	/** Sends a request to the agent in the chat; `shown` is what the transcript shows. */
	askAgent(text: string, shown: string): void;
	showChat(): void;
}

const inputsFile = () => path.join(app.getPath("userData"), "mapper-inputs.json");

function loadSavedInputs(): Record<string, MapInput> {
	try {
		return JSON.parse(fs.readFileSync(inputsFile(), "utf8"));
	} catch {
		return {};
	}
}

function writeSavedInputs(all: Record<string, MapInput>): void {
	try {
		fs.writeFileSync(inputsFile(), JSON.stringify(all, null, 1), { mode: 0o600 });
	} catch {
		// not important
	}
}

/** The Mapper dialog of one diagram window. */
export class MapperDialog {
	private static byView = new Map<number, MapperDialog>();
	private static installed = false;

	private win: BrowserWindow | undefined;
	/** The page's other half (shared with the VS Code extension's panel). */
	private readonly core: MapperDialogCore;

	constructor(private readonly host: MapperHost, private readonly server: StaticServer) {
		MapperDialog.installIpc();
		this.core = new MapperDialogCore({
			post: (msg) => this.post(msg),
			cwd: () => this.host.cwd(),
			ready: () => this.host.ready(),
			service: () => this.host.service,
			context: (signal, progress) => createContext({ cwd: this.host.cwd(), env: agentEnv(), signal, progress }),
			askAgent: (text, shown) => this.host.askAgent(text, shown),
			showChat: () => this.host.showChat(),
			loadInputs: loadSavedInputs,
			saveInputs: writeSavedInputs,
			pick: async (kind, current) => {
				if (!this.win) return undefined;
				const r = await dialog.showOpenDialog(this.win, { defaultPath: current || this.host.cwd(), properties: kind === "folder" ? ["openDirectory"] : ["openFile"] });
				return r.canceled ? undefined : r.filePaths[0];
			},
			look: () => ({ iconStyle: settings().appearance.iconStyle, matrix: settings().appearance.matrix }),
			close: () => this.close(),
		});
	}

	private static installIpc(): void {
		if (MapperDialog.installed) return;
		MapperDialog.installed = true;
		ipcMain.on("mapper:toHost", (e, msg) => void MapperDialog.byView.get(e.sender.id)?.core.onMessage(msg));
	}

	public open(category?: string): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.focus();
			if (category) this.post({ type: "selectCategory", category });
			return;
		}
		const win = new BrowserWindow({
			parent: this.host.win,
			modal: process.platform !== "darwin",
			width: 880,
			height: 680,
			minWidth: 640,
			minHeight: 480,
			title: "Map Something",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e22" : "#ffffff",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-mapper.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		this.win = win;
		MapperDialog.byView.set(win.webContents.id, this);
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => {
			this.core.abort();
			for (const [k, v] of MapperDialog.byView) if (v === this) MapperDialog.byView.delete(k);
			this.win = undefined;
		});
		void win.loadURL(`${this.server.base}/mapper.html${category ? `#${encodeURIComponent(category)}` : ""}`);
	}

	/** The dialog's window while it is open (tests screenshot it). */
	public get window(): BrowserWindow | undefined {
		return this.win && !this.win.isDestroyed() ? this.win : undefined;
	}

	public close(): void {
		if (this.win && !this.win.isDestroyed()) this.win.close();
	}

	private post(msg: unknown): void {
		if (this.win && !this.win.isDestroyed()) this.win.webContents.send("mapper:toWebview", msg);
	}

	/** Collect → draw → (optionally) hand to the agent. */
	public run(recipeId: string, input: MapInput, askAgent: boolean, describe = false): Promise<MapRunOutcome> {
		return this.core.run(recipeId, input, askAgent, describe);
	}
}
