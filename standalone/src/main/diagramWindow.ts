import { DrawioStorage } from "./drawioStorage";
import { cleanShapeSets, type ShapeSetGroup } from "./shapeSets";
import { app, BaseWindow, dialog, ipcMain, nativeTheme, screen, shell, WebContentsView } from "electron";
import * as fs from "fs";
import * as path from "path";
import { CustomizedDrawioClient } from "../../../src/DrawioClient/CustomizedDrawioClient";
import type { DrawioConfig } from "../../../src/DrawioClient/DrawioTypes";
import { DiagramToolbox } from "../../../src/features/ai/DiagramToolbox";
import { ChatController } from "./chatController";
import { exportDiagram, EXPORT_FORMATS, ExportFormat, printDiagram } from "./exporter";
import { detectImportFormat, IMPORT_FILTERS } from "./importFormats";
import { mappedSelection } from "./mapper/draw";
import { diagramContent } from "./xmlContent";
import { digDeeperRequest } from "./mapper/recipes/common";
import { recipeById } from "./mapper/registry";
import { MapperDialog } from "./mapperDialog";
import { agentEnv } from "./agents";
import { createContext } from "./mapper/context";
import { MapperService } from "./mapper/service";
import { MapActions } from "./mapActions";
import { WindowMcpServer } from "./mcpServer";
import { paths } from "./paths";
import { onSettingsChanged, settings, updateSettings, type Settings } from "./settings";
import { shapeLibraries } from "./shapeLocations";
import { galleries, galleryConfigs, searchForEditor } from "./workshop";
import { galleryPalette } from "./workshop/palette";
import { styleValue } from "./workshop/shifter";
import type { Insertable } from "./workshop/galleries";
import type { StaticServer } from "./staticServer";

/** One of draw.io's own picture files (a style's `image=img/lib/…`) as SVG text for a preview, or undefined. */
function webappPicture(image: string | undefined): string | undefined {
	const m = image ? /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/webapp\/)?((?:img|images|stencils)\/[\w./ -]+\.(svg|png|jpe?g|gif))$/i.exec(image) : undefined;
	if (!m || m[1].includes("..")) return undefined;
	const file = path.join(paths.webapp, m[1]);
	try {
		if (!file.startsWith(paths.webapp + path.sep) || fs.statSync(file).size > 512 * 1024) return undefined;
		if (m[2].toLowerCase() === "svg") return fs.readFileSync(file, "utf8");
		const mime = m[2].toLowerCase() === "png" ? "image/png" : m[2].toLowerCase() === "gif" ? "image/gif" : "image/jpeg";
		return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image width="64" height="64" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${fs.readFileSync(file).toString("base64")}"/></svg>`;
	} catch {
		return undefined;
	}
}

const DIAGRAM_EXTS = ["drawio", "dio", "drawio.svg", "drawio.png", "dio.svg", "dio.png", "xml", "svg", "png"];
let nextId = 1;

// draw.io's settings (recent colours, panels, shape sets) and its Scratchpad are kept across windows and runs.
const storage = new DrawioStorage(() => path.join(app.getPath("userData"), "drawio-local-storage.json"));
export function drawioLocalStorage(): Record<string, string> {
	return storage.all();
}
/** Writes draw.io's storage now (before the app quits). */
export function flushDrawioStorage(): void {
	storage.flush();
}

/** One diagram: a window with the draw.io editor on the left and the agent chat on the right. */
export class DiagramWindow {
	public static readonly all = new Set<DiagramWindow>();
	/** draw.io's own shape sets and which are shown, as the editor used last reported them (for the Shape Workshop). */
	public static shapeSets: ShapeSetGroup[] | undefined;
	public static onShapeSets: (() => void) | undefined;
	/** The selection of the diagram used last changed (for the Shape Workshop's Shifter). */
	public static onSelection: (() => void) | undefined;

	/** Asks the editor in front to say again which shape sets show (they can change in the sidebar itself). */
	public static requestShapeSets(): void {
		DiagramWindow.focused()?.sendToEditor({ action: "desktopReportShapeSets" });
	}

	/** Shows or hides one of draw.io's shape sets in every open diagram (they share draw.io's settings). */
	public static setShapeSet(id: string, on: boolean): void {
		for (const w of DiagramWindow.all) w.sendToEditor({ action: "desktopSetShapeSet", id, on });
	}
	private static byEditor = new Map<number, DiagramWindow>();
	/** The diagram window used last, even while another app (a terminal) has focus. */
	private static lastFocused: DiagramWindow | undefined;
	private static byChat = new Map<number, DiagramWindow>();

	public readonly id = `w${nextId++}`;
	/**
	 * A BaseWindow, not a BrowserWindow: a BrowserWindow's own (here empty) page sits in
	 * front of its child views on macOS and gets in the way of mouse events, e.g. hover.
	 */
	public readonly win: BaseWindow;
	public readonly editorView: WebContentsView;
	public readonly chatView: WebContentsView;
	public readonly client: CustomizedDrawioClient;
	public readonly chat: ChatController;
	public readonly toolbox: DiagramToolbox;
	private readonly mcp: WindowMcpServer;
	private messageHandler: ((msg: unknown) => void) | undefined;
	/** Diagnostics: messages from the editor, counted by event. */
	public traffic: Map<string, number> | undefined;
	public file: string | undefined;
	private dirty = false;
	private loaded = false;
	private loadedWaiters: (() => void)[] = [];
	private chatVisible = !settings().chat.startCollapsed;
	/** 0 = chat tucked away, 1 = shown; in between while it slides. */
	private chatShown = this.chatVisible ? 1 : 0;
	private chatAnim: NodeJS.Timeout | undefined;
	/** The chat width while its edge is dragged (saved when the drag ends). */
	private dragWidth: number | undefined;
	private offSettings: (() => void) | undefined;
	/** Presentation mode: only the diagram, read-only, full screen. */
	public presenting = false;
	/** The diagram's content when presenting started: view-only changes while presenting are not edits. */
	private presentBaseline: string | undefined;
	private enteredFullScreen = false;
	private closing = false;
	public readonly mapper: MapperDialog;
	/** The Mapper's maps of this diagram: runs, lookups, findings, descriptions, tours. */
	public readonly maps: MapperService;
	private mapActions!: MapActions;
	/** Mapped shapes in the selection (for Dig Deeper), refreshed when the selection changes. */
	private mapped: { recipe: string; label: string; data: Record<string, string> }[] = [];
	private mappedTimer: NodeJS.Timeout | undefined;
	/** Content for a new, unsaved window (an imported diagram), and the name to suggest when saving it. */
	private initial: { xml: string; name: string } | undefined;
	/** draw.io's menus as the editor last reported them (for the system menu bar). */
	public drawioMenus: Record<string, DrawioMenuItem[] | null> | undefined;
	private drawioMenusJson: string | undefined;
	/** Called after a window closes (main.ts rebuilds the menu bar for the next one). */
	public static onClosed: (() => void) | undefined;
	/** Called when a window's draw.io menus change (main.ts rebuilds the menu bar). */
	public static onMenus: ((w: DiagramWindow) => void) | undefined;

	/** Runs a draw.io menu item from the system menu bar. */
	private menuSeq = 0;
	public invokeDrawioMenu(id: string): void {
		// (the page can see a message twice; the sequence number makes a toggle run once)
		this.sendToEditor({ action: "desktopMenuInvoke", id, seq: ++this.menuSeq });
	}

	/**
	 * A draw.io item's shortcut was pressed somewhere the page did not handle it (on macOS a
	 * menu shortcut is always live): run it only for the diagram itself, never for keys typed
	 * in the chat, Settings, a dialog or one of draw.io's own fields.
	 */
	public async invokeDrawioMenuFromKey(id: string, focused: Electron.WebContents | null): Promise<void> {
		if (focused !== this.editorView.webContents) return;
		try {
			if (await this.editorView.webContents.executeJavaScript("!!(window.drawaiMenubar && window.drawaiMenubar.isTextFocus())")) return;
		} catch {
			return;
		}
		this.invokeDrawioMenu(id);
	}

	/** Runs a draw.io action by name (undo, copy, …) unless text is being typed; says whether it did. */
	public async runDrawioAction(key: string): Promise<boolean> {
		if (this.editorView.webContents.isDestroyed() || !this.loaded) return false;
		try {
			return !!(await this.editorView.webContents.executeJavaScript(`(() => { const m = window.drawaiMenubar; if (!m || m.isTextFocus()) return false; return m.run(${JSON.stringify(key)}); })()`));
		} catch {
			return false;
		}
	}

	/** App-level commands the in-editor File menu can run. Set by main.ts. */
	public static appCommands: { newDiagram(): void; open(): void; settings(section?: string): void; workshop?(mode?: string): void } = { newDiagram: () => undefined, open: () => undefined, settings: () => undefined };

	public static async open(server: StaticServer, file?: string, initial?: { xml: string; name: string }): Promise<DiagramWindow> {
		if (file) {
			const existing = [...DiagramWindow.all].find((w) => w.file === file);
			if (existing) {
				existing.win.focus();
				return existing;
			}
		}
		const w = new DiagramWindow(server, file);
		w.initial = initial;
		await w.start(server);
		return w;
	}

	public static focused(): DiagramWindow | undefined {
		const win = BaseWindow.getFocusedWindow();
		const front = [...DiagramWindow.all].find((w) => w.win === win);
		if (front) return front;
		const last = DiagramWindow.lastFocused;
		return last && DiagramWindow.all.has(last) ? last : [...DiagramWindow.all].pop();
	}

	public static installIpc(): void {
		ipcMain.on("drawio:toHost", (e, msg) => {
			const w = DiagramWindow.byEditor.get(e.sender.id);
			if (w?.traffic) {
				const ev = /"event":"([^"]+)"/.exec(String(msg))?.[1] ?? "?";
				w.traffic.set(ev, (w.traffic.get(ev) ?? 0) + 1);
			}
			w?.messageHandler?.(msg);
		});
		ipcMain.on("chat:toHost", (e, msg) => void DiagramWindow.byChat.get(e.sender.id)?.chat.onMessage(msg));
	}

	private constructor(private readonly server: StaticServer, file: string | undefined) {
		this.file = file;
		this.win = new BaseWindow({
			...DiagramWindow.placement(),
			minWidth: 800,
			minHeight: 500,
			title: "OmniDraw",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e22" : "#ffffff",
			show: false,
		});
		const prefs = (preload: string) => ({
			preload: path.join(paths.out, preload),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		});
		this.editorView = new WebContentsView({ webPreferences: prefs("preload-editor.js") });
		this.chatView = new WebContentsView({ webPreferences: prefs("preload-chat.js") });
		this.win.contentView.addChildView(this.editorView);
		this.win.contentView.addChildView(this.chatView);
		DiagramWindow.byEditor.set(this.editorView.webContents.id, this);
		DiagramWindow.byChat.set(this.chatView.webContents.id, this);
		DiagramWindow.all.add(this);
		DiagramWindow.lastFocused = this;

		for (const wc of [this.editorView.webContents, this.chatView.webContents]) {
			wc.setWindowOpenHandler(({ url }) => {
				if (/^https?:/.test(url)) void shell.openExternal(url);
				return { action: "deny" };
			});
			wc.on("will-navigate", (e, url) => {
				if (!url.startsWith(server.base)) e.preventDefault();
			});
		}

		this.client = new CustomizedDrawioClient(
			{
				sendMessage: (msg) => {
					if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.send("drawio:toWebview", msg);
				},
				registerMessageHandler: (handler) => {
					this.messageHandler = handler;
					return { dispose: () => (this.messageHandler = undefined) } as any;
				},
			},
			async () => drawioConfig(),
			() => this.editorView.webContents.reload(),
			() => "light"
		);

		this.toolbox = new DiagramToolbox(
			() => this.editorHandle(),
			undefined,
			undefined,
			async (_editor, request) => this.exportForTool(request),
			undefined,
			undefined,
			undefined,
			async (message, action) => {
				const r = await dialog.showMessageBox(this.win, { type: "warning", message, buttons: [action, "Cancel"], defaultId: 1, cancelId: 1 });
				return r.response === 0;
			}
		);
		this.maps = new MapperService({
			client: this.client,
			cwd: () => this.cwd(),
			diagram: () => this.file,
			context: (signal, progress) => createContext({ cwd: this.cwd(), env: agentEnv(), signal, progress }),
		});
		this.mcp = new WindowMcpServer(this.toolbox, () => this.fileName(), () => this.maps);
		this.chat = new ChatController(
			{
				client: () => this.client,
				fileName: () => this.fileName(),
				cwd: () => this.cwd(),
				ready: () => this.loaded,
				openMapper: () => this.mapper.open(),
				mappedSelectionCount: () => this.mapped.length,
				digDeeper: (question) => void this.digDeeper(question),
				pageMaps: () => this.mapActions?.pageSummary ?? { maps: 0, findings: 0 },
				mapAction: (action, text) => {
					if (!this.chatVisible) this.toggleChat();
					void this.mapActions.run(action, text);
				},
				reportAction: (action) => void this.mapActions.action(action),
				openSettings: () => DiagramWindow.appCommands.settings(),
				collapseChat: () => this.setChatVisible(false),
				resizeChatTo: (screenX, done) => this.resizeChatTo(screenX, done),
			},
			this.mcp
		);
		this.mapper = new MapperDialog(
			{
				win: this.win,
				client: this.client,
				service: this.maps,
				cwd: () => this.cwd(),
				ready: () => this.loaded,
				askAgent: (text, shown) => void this.chat.send(text, { cellIds: [] }, [], shown),
				showChat: () => {
					if (!this.chatVisible) this.toggleChat();
				},
			},
			server
		);
		this.mapActions = new MapActions(this.client, this.chat, this.maps, () => this.loaded, (category) => this.mapper.open(category));
		this.chat.attach(this.chatView.webContents);
		this.wireEditorEvents();

		this.win.on("resize", () => this.layout());
		this.win.on("close", (e) => this.onClose(e));
		this.win.on("closed", () => this.dispose());
		this.win.on("focus", () => {
			DiagramWindow.lastFocused = this;
			DiagramWindow.onMenus?.(this);
			this.chat.postState();
		});
		this.offSettings = onSettingsChanged((s, patch) => this.applySettings(s, patch));
		this.layout();
		this.updateTitle();
	}

	/**
	 * Where a new window goes: on the display the pointer is on, inside its work area (never
	 * partly off screen), a little down and right of the windows already open there.
	 */
	private static placement(): { x: number; y: number; width: number; height: number } {
		// (test runs use the primary display: another one may be asleep and not capturable)
		const area = (process.env.DRAWAI_E2E ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
		const width = Math.min(1500, Math.max(800, area.width - 48));
		const height = Math.min(950, Math.max(500, area.height - 48));
		const cascade = (DiagramWindow.all.size % 6) * 28;
		const x = Math.min(area.x + Math.round((area.width - width) / 2) + cascade, area.x + area.width - width);
		const y = Math.min(area.y + Math.round((area.height - height) / 2) + cascade, area.y + area.height - height);
		return { x: Math.max(area.x, x), y: Math.max(area.y, y), width, height };
	}

	/** Settings changed (in the Settings window): follow them in this window. */
	private applySettings(_s: Settings, patch: Partial<Settings>): void {
		if (this.win.isDestroyed()) return;
		if ("chat" in patch || "chatWidth" in patch) this.layout();
		if ("appearance" in patch || "chat" in patch) this.sendEditorPrefs();
		if ("shapes" in patch || "workshop" in patch) this.sendShapes();
		// (a catalog-only change is a chat recording what its agent offers: nothing to redraw)
		if ("models" in patch || "agents" in patch || "appearance" in patch || "chat" in patch) this.chat.settingsChanged("agents" in patch);
	}

	private sendToEditor(msg: unknown): void {
		if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.send("drawio:toWebview", JSON.stringify(msg));
	}

	/** Icon style and the chat's state, for the editor's plugins. */
	private sendEditorPrefs(): void {
		const s = settings();
		this.sendToEditor({ action: "desktopPrefs", iconStyle: s.appearance.iconStyle, matrix: s.appearance.matrix, toolbar: s.appearance.toolbar, chatVisible: this.chatVisible, chatSide: s.chat.side });
	}

	private shapesSeq = 0;
	/** The palettes this window's page was given last (the same ones are not sent again: that would rebuild its sidebar). */
	private shapesSent: string | undefined;
	/** The user's shape folders and libraries as palettes (only the newest read is shown). */
	private sendShapes(): void {
		const seq = ++this.shapesSeq;
		void (async () => {
			const libraries: unknown[] = await shapeLibraries(settings().shapes.locations);
			// each enabled gallery: a first page as a palette (the rest is found by search)
			for (const g of galleryConfigs().filter((x) => x.enabled)) {
				try {
					const palette = await galleryPalette(galleries(), g);
					if (palette) libraries.push(palette);
				} catch {
					// a gallery that cannot be read now is left out; the Workshop says why
				}
			}
			if (seq !== this.shapesSeq) return;
			const next = JSON.stringify(libraries);
			if (next === this.shapesSent) return;
			this.shapesSent = next;
			this.sendToEditor({ action: "desktopShapes", libraries });
		})();
	}

	private static shapesTimer: NodeJS.Timeout | undefined;
	/**
	 * What a gallery holds changed (a collection filled or emptied, a gallery synced): every
	 * window's palettes follow, once the galleries have settled (a sync reports often).
	 */
	public static refreshShapesSoon(): void {
		clearTimeout(DiagramWindow.shapesTimer);
		DiagramWindow.shapesTimer = setTimeout(() => {
			for (const w of DiagramWindow.all) if (w.loaded) w.sendShapes();
		}, 500);
	}

	/** What this window's editor page knows of draw.io's storage (given at load, or posted since). */
	private storageSeen: Record<string, string> = {};

	/** Another window changed draw.io's storage (a Scratchpad shape, a setting): this one's page takes it over. */
	private takeStorage(changes: Record<string, string | null>): void {
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) delete this.storageSeen[k];
			else this.storageSeen[k] = v;
		}
		this.sendToEditor({ action: "desktopStorage", changes });
	}

	/** Puts a shape from the Workshop in this diagram (in the middle of the view, selected). */
	public insertShape(shape: Insertable): void {
		// (the page can see a message twice; the sequence number makes it insert once)
		this.sendToEditor({ action: "desktopInsertShape", shape, seq: ++this.menuSeq });
		if (!this.win.isDestroyed()) this.win.focus();
	}

	private async start(server: StaticServer): Promise<void> {
		await this.mcp.start();
		const dark = nativeTheme.shouldUseDarkColors;
		this.win.show();
		this.editorView.webContents.focus();
		void this.editorView.webContents.loadURL(`${server.editorUrl(this.id, { dark: "auto", localStorage: () => (this.storageSeen = storage.snapshot()) })}?icons=${settings().appearance.iconStyle}&toolbar=${settings().appearance.toolbar}&matrix=${settings().appearance.matrix}`);
		void this.chatView.webContents.loadURL(`${server.base}/chat.html`);
		void dark;
	}

	/** What DiagramToolbox calls a DrawioEditor: the client and the document's URI. */
	private editorHandle(): any {
		if (!this.loaded) return undefined;
		const p = this.file ?? path.join(app.getPath("documents"), "Untitled.drawio");
		return { drawioClient: this.client, uri: { path: p, fsPath: p, scheme: "file", toString: () => `file://${encodeURI(p)}` } };
	}

	/** A diagram or Mapper tool call from the desktop-wide MCP endpoint. */
	public callTool(name: string, args: unknown) {
		return this.mcp.call(name, args);
	}

	/** Folder the agent and the Mapper work in: the diagram's folder. */
	public cwd(): string {
		return this.file ? path.dirname(this.file) : app.getPath("documents");
	}

	private refreshMapped(): void {
		clearTimeout(this.mappedTimer);
		this.mappedTimer = setTimeout(async () => {
			const before = this.mapped.length;
			try {
				this.mapped = this.loaded ? await mappedSelection(this.client) : [];
			} catch {
				this.mapped = [];
			}
			if (this.mapped.length !== before) this.chat.postState();
		}, 150);
	}

	// ----- the Shape Shifter's side (see workshop/core.ts, ShifterHost) -----

	/** draw.io's own shapes that match, with the sidebar's thumbnails. */
	public async searchOwnShapes(query: string, limit: number): Promise<AiShapeTemplate[]> {
		await this.ready();
		const shapes = (await this.client.aiSearchShapes(query, limit, { previews: true, ownOnly: true })).shapes;
		// A shape that is a picture names a file of draw.io's (img/lib/…): its thumbnail links to it, and
		// links do not survive the Workshop's cleaning. The picture itself is the preview then.
		for (const shape of shapes) {
			const picture = webappPicture(styleValue(shape.style, "image"));
			if (picture) shape.preview = picture;
		}
		return shapes;
	}

	/** The selected cells themselves (not what is inside a selected container or group) and their styles. */
	public async selectedCells(): Promise<{ id: string; style: string; edge: boolean }[]> {
		if (!this.loaded || this.client.currentSelection.length === 0) return [];
		const model = await this.client.aiGetModel({ scope: "selection", selectedOnly: true, includeStyles: true, maxCells: 2000 });
		return model.cells.filter((c) => c.selected === true).map((c) => ({ id: c.id, style: c.style ?? "", edge: c.kind === "edge" }));
	}

	/** Style changes the user made in the Workshop: one undo step, the user's own (a pending AI review takes them as an edit made in the editor). */
	public async applyStyles(edits: { id: string; props: Record<string, string> }[]): Promise<void> {
		const r = await this.client.aiApplyOps(
			edits.map((e) => ({ op: "update", id: e.id, styleProps: e.props })),
			{ selectResult: false, flash: false, atomic: true, review: false, user: true }
		);
		const failed = r.results.find((x) => !x.ok);
		if (failed || r.rolledBack) throw new Error(`The shapes could not be changed: ${failed?.error ?? "the change was rolled back"}`);
	}

	/** Hands a request about the selection to the agent in this window's chat. */
	public async askAboutSelection(request: string, shown: string): Promise<void> {
		if (!this.chatVisible) this.toggleChat();
		await this.chat.send(request, { cellIds: this.client.currentSelection }, [], shown);
	}

	/** A Visio stencil as a draw.io library, converted by this window's editor (the open diagram is not touched). */
	public async convertStencil(file: string): Promise<{ library: string; warnings: string[] }> {
		await this.ready();
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`${path.basename(file)} is not a file, or is larger than 64 MB.`);
		const result = await this.client.importDiagram("visio", path.basename(file), fs.readFileSync(file));
		if (!result.library) throw new Error(`${path.basename(file)} is a Visio drawing, not a stencil. Open it with File → Import… to get its pages.`);
		return { library: result.library, warnings: result.warnings };
	}

	/** Asks the agent to investigate the selected mapped shapes further (read-only). */
	public async digDeeper(question: string): Promise<void> {
		const shapes = this.loaded ? await mappedSelection(this.client).catch(() => []) : [];
		if (shapes.length === 0) {
			void dialog.showMessageBox(this.win, { type: "info", message: "Select shapes on a map first", detail: "Dig Deeper works on shapes the Mapper drew: select one or more, then ask what you want to know." });
			return;
		}
		// The recipe most of the selection comes from decides how to dig.
		const counts = new Map<string, number>();
		for (const s of shapes) counts.set(s.recipe, (counts.get(s.recipe) ?? 0) + 1);
		const recipeId = [...counts].sort((a, b) => b[1] - a[1])[0][0];
		const recipe = recipeById(recipeId);
		const data = shapes.map((s) => ({ label: s.label, data: Object.fromEntries(Object.entries(s.data).filter(([k]) => k !== "mapper")) }));
		const text = recipe?.digDeeper ? recipe.digDeeper(data, question) : digDeeperRequest("mapped items", data, question);
		if (!this.chatVisible) this.toggleChat();
		await this.chat.send(text, { cellIds: this.client.currentSelection }, [], `🔎 Dig deeper into ${shapes.length} shape${shapes.length === 1 ? "" : "s"}${question.trim() ? `: ${question.trim()}` : ""}`);
	}

	public fileName(): string | undefined {
		return this.file ? path.basename(this.file) : undefined;
	}

	public whenLoaded(): Promise<void> {
		return this.loaded ? Promise.resolve() : new Promise((r) => this.loadedWaiters.push(r));
	}

	/** Loaded, or an error when that takes too long (a window closed before it loaded never does). */
	private async ready(ms = 15_000): Promise<void> {
		if (this.loaded) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.whenLoaded(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("The diagram is still loading. Try again in a moment.")), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private wireEditorEvents(): void {
		const c = this.client;
		c.onInit.sub(async () => {
			this.loaded = false;
			try {
				if (this.file && /\.png$/i.test(this.file)) {
					await c.loadPngWithEmbeddedXml(fs.readFileSync(this.file));
				} else {
					await c.loadXmlLike(this.file ? fs.readFileSync(this.file, "utf8") : this.initial?.xml ?? "");
				}
			} catch (e: any) {
				dialog.showErrorBox("Could not open the diagram", String(e?.message ?? e));
			}
			await c.whenLoaded(30_000);
			this.loaded = true;
			this.sendEditorPrefs();
			// (a page that has just loaded has no palettes)
			this.shapesSent = undefined;
			this.sendShapes();
			this.setDirty(!!this.initial && !this.file);
			this.loadedWaiters.splice(0).forEach((r) => r());
			this.chat.postState();
			this.mapActions.refreshSummary();
		});
		// Presenting only views the diagram, but draw.io still auto-saves page view state when pages
		// change: that is not an edit. Anything else (an agent or the Mapper still working) is.
		c.onChange.sub(({ newXml }) => {
			this.mapActions.refreshSummary();
			if (this.presenting && this.presentBaseline !== undefined && diagramContent(newXml) === this.presentBaseline) return;
			this.setDirty(true);
		});
		c.onSave.sub(() => void this.save());
		c.onSelectedCellsChanged.sub(() => {
			this.chat.postState();
			this.refreshMapped();
			this.mapActions.refreshSummary();
			// (the Shape Shifter shows what is selected in the diagram used last)
			if (this === DiagramWindow.focused()) DiagramWindow.onSelection?.();
		});
		c.onAiReview.sub(() => this.chat.postState());
		let lastLasso: { cellIds: string[] } | undefined;
		c.onAiLasso.sub((evt) => {
			this.chat.setLassoActive(evt.lassoModeEnabled);
			if (!evt.lassoModeEnabled && (evt.cellIds.length > 0 || evt.region)) lastLasso = { cellIds: evt.cellIds };
		});
		c.onAiAsk.sub((evt) => {
			const viaLasso = !evt.source && !!lastLasso && lastLasso.cellIds.length === evt.cellIds.length && lastLasso.cellIds.every((id) => evt.cellIds.includes(id));
			lastLasso = undefined;
			if (!this.chatVisible) this.toggleChat();
			void this.chat.send(
				evt.prompt,
				{ cellIds: evt.cellIds, region: evt.region, viaLasso, source: evt.source === "prompt" ? undefined : evt.source, markCount: evt.markCount },
				evt.images ?? []
			);
		});
		c.onInvokeCommand.sub(({ command }) => {
			if (command === "save") void this.save();
			else if (command === "export") void this.exportAny();
			else if (command === "exportVisio") void this.exportInteractive("vsdx");
			else if (command === "convert") void this.saveAs();
			else if (command === "importDiagram") void this.importFromOtherTool();
		});
		c.onUnknownMessage.sub(({ message }) => {
			const m = message as any;
			if (m?.event === "updateLocalStorage" && m.newLocalStorage && typeof m.newLocalStorage === "object") {
				// only what this page changed is taken over, and the other windows are told
				const changes = storage.apply(m.newLocalStorage, this.storageSeen);
				if (Object.keys(changes).length) for (const other of DiagramWindow.all) if (other !== this) other.takeStorage(changes);
			} else if (m?.event === "desktopShapeSets" && Array.isArray(m.groups)) {
				DiagramWindow.shapeSets = cleanShapeSets(m.groups);
				DiagramWindow.onShapeSets?.();
			} else if (m?.event === "desktopGallerySearch" && typeof m.query === "string") {
				// draw.io's own search asks for gallery shapes too
				const query = m.query.slice(0, 200), reqId = m.reqId;
				void searchForEditor(query, Math.min(48, Number(m.limit) || 24))
					.catch(() => [])
					.then((shapes) => this.sendToEditor({ action: "desktopGalleryResults", reqId, shapes }));
			} else if (m?.event === "desktopMenus" && m.menus && typeof m.menus === "object") {
				const json = JSON.stringify(m.menus);
				if (json === this.drawioMenusJson) return;
				this.drawioMenusJson = json;
				this.drawioMenus = m.menus;
				DiagramWindow.onMenus?.(this);
			} else if (m?.event === "desktopCommand") {
				this.runDesktopCommand(String(m.command));
			} else if (m?.event === "openLink" && typeof m.url === "string" && /^https?:/.test(m.url)) {
				void shell.openExternal(m.url);
			}
		});
	}

	/** Commands from the in-editor File menu (src/renderer/desktop-menu.js). */
	public runDesktopCommand(command: string): void {
		switch (command) {
			case "new": return DiagramWindow.appCommands.newDiagram();
			case "open": return DiagramWindow.appCommands.open();
			case "saveAs": return void this.saveAs();
			case "exportPdf": return void this.exportInteractive("pdf");
			case "export": return void this.exportAny();
			case "importDiagram": return void this.importFromOtherTool();
			case "print": return void this.print();
			case "exitPresentation": return this.setPresenting(false);
			case "present": return this.togglePresentation();
			case "toggleChat": return this.toggleChat();
			case "settings": return DiagramWindow.appCommands.settings();
			case "workshop": return DiagramWindow.appCommands.workshop?.();
			case "shapeSets": return DiagramWindow.appCommands.workshop?.("sets");
		}
	}

	public async print(): Promise<void> {
		try {
			const r = await printDiagram(this.client, this.fileName() ?? "Untitled");
			if (!r.printed && r.error && !/cancel/i.test(r.error)) dialog.showErrorBox("Could not print", r.error);
		} catch (e: any) {
			dialog.showErrorBox("Could not print", String(e?.message ?? e));
		}
	}

	/** Converts a Visio/Gliffy/yEd/Lucidchart/Miro file with draw.io and opens it in a new window. */
	public async importFromOtherTool(): Promise<void> {
		const r = await dialog.showOpenDialog(this.win, { title: "Open from Another Tool", properties: ["openFile"], filters: IMPORT_FILTERS });
		const source = r.filePaths[0];
		if (!source) return;
		try {
			const bytes = fs.readFileSync(source);
			const format = detectImportFormat(path.basename(source), bytes);
			const result = await this.client.importDiagram(format, path.basename(source), bytes);
			const name = path.basename(source).replace(/\.[^.]+$/, "") + ".drawio";
			await DiagramWindow.open(this.server, undefined, { xml: result.xml, name: path.join(path.dirname(source), name) });
			if (result.warnings.length) {
				void dialog.showMessageBox({ type: "info", message: `Imported ${path.basename(source)}`, detail: `Some things did not carry over:\n- ${result.warnings.slice(0, 12).join("\n- ")}` });
			}
		} catch (e: any) {
			dialog.showErrorBox("Could not open the file", String(e?.message ?? e));
		}
	}

	// ----- layout -----

	private chatWidth(total: number): number {
		return Math.min(Math.max(280, this.dragWidth ?? settings().chatWidth), Math.floor(total * 0.6));
	}

	private layout(): void {
		const { width, height } = this.win.getContentBounds();
		const full = this.chatWidth(width);
		const shown = this.presenting ? 0 : Math.round(full * easeOut(this.chatShown));
		const left = settings().chat.side === "left";
		// The chat keeps its full width while it slides, so its contents do not reflow.
		this.editorView.setBounds({ x: left ? shown : 0, y: 0, width: width - shown, height });
		this.chatView.setBounds({ x: left ? shown - full : width - shown, y: 0, width: full, height });
		this.chatView.setVisible(shown > 0);
	}

	/** Shows only the diagram, read-only and full screen, with page dots; Esc leaves. */
	public setPresenting(on: boolean, opts: { startTour?: boolean } = {}): void {
		if (on && this.presenting && opts.startTour) return this.sendTours(true);
		if (on === this.presenting || (on && !this.loaded)) return;
		this.presenting = on;
		this.presentBaseline = undefined;
		if (on) void this.client.getXml().then((xml) => this.presenting && (this.presentBaseline = diagramContent(xml)));
		if (on) {
			this.enteredFullScreen = !this.win.isFullScreen();
			// Test runs stay windowed (full screen moves the window to its own Space).
			if (this.enteredFullScreen && !process.env.DRAWAI_E2E) this.win.setFullScreen(true);
		} else if (this.enteredFullScreen) {
			this.enteredFullScreen = false;
			this.win.setFullScreen(false);
		}
		this.layout();
		if (!this.editorView.webContents.isDestroyed()) {
			this.editorView.webContents.send("drawio:toWebview", JSON.stringify({ action: "desktopPresentation", enabled: on }));
			if (on) {
				this.sendTours(!!opts.startTour);
				this.editorView.webContents.focus();
			}
		}
	}

	/** The diagram's map tours, for presentation mode to play (it finds their shapes on each page). */
	private sendTours(start: boolean): void {
		let tours: { mapId: string; title: string; steps: { title: string; caption: string; nodeIds: string[] }[] }[] = [];
		try {
			tours = this.maps.records().flatMap((r) => r.tours.map((t) => ({ mapId: r.id, title: t.title, steps: t.steps })));
		} catch {
			// no maps
		}
		if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.send("drawio:toWebview", JSON.stringify({ action: "desktopPresentationTours", tours, start }));
	}

	public togglePresentation(): void {
		this.setPresenting(!this.presenting);
	}

	public toggleChat(): void {
		this.setChatVisible(!this.chatVisible);
	}

	/** Slides the chat in or out (about 220 ms; at once in tests). */
	public setChatVisible(visible: boolean): void {
		if (visible === this.chatVisible && !this.chatAnim) return;
		this.chatVisible = visible;
		clearInterval(this.chatAnim);
		this.chatAnim = undefined;
		const target = visible ? 1 : 0;
		if (process.env.DRAWAI_E2E) {
			this.chatShown = target;
			this.layout();
		} else {
			const from = this.chatShown, start = Date.now(), dur = 220;
			this.chatAnim = setInterval(() => {
				const t = Math.min(1, (Date.now() - start) / dur);
				this.chatShown = from + (target - from) * t;
				if (!this.win.isDestroyed()) this.layout();
				if (t >= 1) {
					clearInterval(this.chatAnim);
					this.chatAnim = undefined;
				}
			}, 16);
		}
		this.sendEditorPrefs();
		const focusView = visible ? this.chatView : this.editorView;
		if (!focusView.webContents.isDestroyed()) focusView.webContents.focus();
	}

	/** The chat's edge is being dragged to `screenX`; the width is saved when the drag ends. */
	private resizeChatTo(screenX: number, done: boolean): void {
		if (!isFinite(screenX)) {
			// the drag ended without a position: keep the width it reached
			if (done && this.dragWidth !== undefined) {
				const final = this.dragWidth;
				this.dragWidth = undefined;
				updateSettings({ chatWidth: final });
			}
			return;
		}
		const b = this.win.getContentBounds();
		const left = settings().chat.side === "left";
		const w = Math.round(left ? screenX - b.x : b.x + b.width - screenX);
		this.dragWidth = Math.max(280, Math.min(900, Math.floor(b.width * 0.6), w));
		this.layout();
		if (done) {
			const final = this.dragWidth;
			this.dragWidth = undefined;
			updateSettings({ chatWidth: final });
		}
	}

	public resizeChat(delta: number): void {
		updateSettings({ chatWidth: Math.max(280, Math.min(900, settings().chatWidth + delta)) });
		this.layout();
	}

	// ----- document -----

	private setDirty(dirty: boolean): void {
		this.dirty = dirty;
		this.updateTitle();
	}

	private updateTitle(): void {
		if (this.win.isDestroyed()) return;
		this.win.setTitle(`${this.fileName() ?? "Untitled"}${this.dirty ? " •" : ""} — OmniDraw`);
		this.win.setDocumentEdited(this.dirty);
		if (this.file) this.win.setRepresentedFilename(this.file);
	}

	public async save(): Promise<boolean> {
		if (!this.file) return this.saveAs();
		return this.writeTo(this.file);
	}

	public async saveAs(): Promise<boolean> {
		const r = await dialog.showSaveDialog(this.win, {
			defaultPath: this.file ?? this.initial?.name ?? path.join(app.getPath("documents"), "Untitled.drawio"),
			filters: [
				{ name: "draw.io", extensions: ["drawio"] },
				{ name: "Editable SVG (.drawio.svg)", extensions: ["drawio.svg"] },
				{ name: "Editable PNG (.drawio.png)", extensions: ["drawio.png"] },
			],
		});
		if (r.canceled || !r.filePath) return false;
		const ok = await this.writeTo(r.filePath);
		if (ok) {
			const from = { cwd: this.cwd(), diagram: this.file };
			this.file = r.filePath;
			// The maps' records follow the diagram to its new name and folder.
			try {
				this.maps.adoptRecords(from, { cwd: this.cwd(), diagram: r.filePath });
			} catch (e) {
				console.warn("Could not carry the map records over:", e);
			}
			app.addRecentDocument(r.filePath);
			this.updateTitle();
			this.chat.postState();
		}
		return ok;
	}

	private async writeTo(file: string): Promise<boolean> {
		try {
			const ext = /\.(png|svg)$/i.test(file) ? file : file.replace(/\.(xml|dio)$/i, ".drawio");
			const buffer = await this.client.export(ext.endsWith(".png") || ext.endsWith(".svg") ? ext : ".drawio");
			fs.writeFileSync(file, Buffer.from(buffer.toString("base64"), "base64"));
			this.setDirty(false);
			return true;
		} catch (e: any) {
			dialog.showErrorBox("Could not save", String(e?.message ?? e));
			return false;
		}
	}

	/** One Save dialog with every export format; the chosen extension decides the format. */
	public async exportAny(): Promise<void> {
		const base = (this.file ? path.basename(this.file) : "Untitled.drawio").replace(/\.(drawio|dio)(\.(svg|png))?$|\.(xml|svg|png)$/i, "");
		const dir = this.file ? path.dirname(this.file) : app.getPath("documents");
		const r = await dialog.showSaveDialog(this.win, {
			title: "Export",
			defaultPath: path.join(dir, `${base}.pdf`),
			filters: EXPORT_FORMATS.map((f) => ({ name: f.label, extensions: [f.ext] })),
		});
		if (r.canceled || !r.filePath) return;
		const lower = r.filePath.toLowerCase();
		const f = [...EXPORT_FORMATS].sort((a, b) => b.ext.length - a.ext.length).find((x) => lower.endsWith(`.${x.ext}`)) ?? EXPORT_FORMATS.find((x) => lower.endsWith(`.${x.ext.split(".").pop()}`));
		if (!f) return void dialog.showErrorBox("Export failed", `Pick one of: ${EXPORT_FORMATS.map((x) => `.${x.ext}`).join(", ")}`);
		try {
			await exportDiagram(this.client, f.format, r.filePath);
			shell.showItemInFolder(r.filePath);
		} catch (e: any) {
			dialog.showErrorBox("Export failed", String(e?.message ?? e));
		}
	}

	public async exportInteractive(format: ExportFormat): Promise<void> {
		const f = EXPORT_FORMATS.find((x) => x.format === format)!;
		const base = (this.file ? path.basename(this.file) : "Untitled.drawio").replace(/\.(drawio|dio)(\.(svg|png))?$|\.(xml|svg|png)$/i, "");
		const dir = this.file ? path.dirname(this.file) : app.getPath("documents");
		const r = await dialog.showSaveDialog(this.win, {
			title: `Export as ${f.label}`,
			defaultPath: path.join(dir, `${base}.${f.ext}`),
			filters: [{ name: f.label, extensions: [f.ext] }],
		});
		if (r.canceled || !r.filePath) return;
		try {
			await exportDiagram(this.client, format, r.filePath);
			shell.showItemInFolder(r.filePath);
		} catch (e: any) {
			dialog.showErrorBox("Export failed", String(e?.message ?? e));
		}
	}

	/** drawio_export from an agent: next to the diagram unless a path is given; never silently overwrites. */
	private async exportForTool(request: { format: string; path?: string; currentPageOnly?: boolean; overwrite?: boolean }) {
		const format = request.format as ExportFormat;
		const f = EXPORT_FORMATS.find((x) => x.format === format);
		if (!f) throw new Error(`format must be one of ${EXPORT_FORMATS.map((x) => x.format).join(", ")}`);
		const dir = this.file ? path.dirname(this.file) : app.getPath("documents");
		const base = (this.file ? path.basename(this.file) : "Untitled.drawio").replace(/\.(drawio|dio)(\.(svg|png))?$|\.(xml|svg|png)$/i, "");
		const target = request.path ? path.resolve(dir, request.path) : path.join(dir, `${base}.${f.ext}`);
		if (this.file && path.resolve(target) === path.resolve(this.file)) throw new Error("That would replace the diagram itself.");
		if (fs.existsSync(target)) {
			if (!request.overwrite) throw new Error(`${target} exists. Pass overwrite: true to replace it (the user is asked).`);
			const r = await dialog.showMessageBox(this.win, { type: "warning", message: `Replace ${path.basename(target)} with a new export?`, buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1 });
			if (r.response !== 0) throw new Error("The user chose not to replace the file.");
		}
		const r = await exportDiagram(this.client, format, target, { currentPageOnly: request.currentPageOnly });
		return { text: JSON.stringify({ path: target, bytes: r.bytes, note: r.note }), summary: `Exported ${path.basename(target)}` };
	}

	private async onClose(e: Electron.Event): Promise<void> {
		if (this.closing || !this.dirty) return;
		e.preventDefault();
		const r = await dialog.showMessageBox(this.win, {
			type: "warning",
			message: `Save changes to ${this.fileName() ?? "Untitled"}?`,
			detail: "Your changes will be lost if you don't save them.",
			buttons: ["Save", "Don't Save", "Cancel"],
			defaultId: 0,
			cancelId: 2,
		});
		if (r.response === 2) return;
		if (r.response === 0 && !(await this.save())) return;
		this.closing = true;
		this.win.close();
	}

	private dispose(): void {
		setTimeout(() => DiagramWindow.onClosed?.(), 0);
		clearTimeout(this.mappedTimer);
		clearInterval(this.chatAnim);
		this.offSettings?.();
		this.mapActions.dispose();
		this.mapper.close();
		this.chat.dispose();
		this.mcp.dispose();
		this.client.dispose();
		DiagramWindow.all.delete(this);
		if (DiagramWindow.lastFocused === this) DiagramWindow.lastFocused = undefined;
		for (const [k, v] of DiagramWindow.byEditor) if (v === this) DiagramWindow.byEditor.delete(k);
		for (const [k, v] of DiagramWindow.byChat) if (v === this) DiagramWindow.byChat.delete(k);
		if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.close();
		if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close();
	}

	public static readonly openFilters = [{ name: "Diagrams", extensions: DIAGRAM_EXTS.map((e) => e.split(".").pop()!) }];
}

function drawioConfig(): DrawioConfig {
	return {
		compressXml: false,
		defaultLibraries: "general",
		suppressNewWindows: true,
		compact: true,
		hideMenuItems: ["exportAs", "importFrom", "print", "saveAndExit", "plugins", "exit"],
		hideMenus: ["language", "help"],
	} as DrawioConfig;
}

/** One draw.io menu entry, as desktop-menubar.js records it. */
export interface DrawioMenuItem {
	id?: string;
	label?: string;
	enabled?: boolean;
	checked?: boolean;
	shortcut?: string;
	key?: string;
	separator?: boolean;
	children?: DrawioMenuItem[] | null;
}

function easeOut(t: number): number {
	return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}
