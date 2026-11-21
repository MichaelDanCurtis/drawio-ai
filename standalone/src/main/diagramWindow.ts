import { app, BaseWindow, dialog, ipcMain, nativeTheme, shell, WebContentsView } from "electron";
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
import { WindowMcpServer } from "./mcpServer";
import { paths } from "./paths";
import { settings, updateSettings } from "./settings";
import type { StaticServer } from "./staticServer";

const DIAGRAM_EXTS = ["drawio", "dio", "drawio.svg", "drawio.png", "dio.svg", "dio.png", "xml", "svg", "png"];
let nextId = 1;

// draw.io's preferences (recent colours, panels, ...) are kept across windows and runs.
const localStorageFile = () => path.join(app.getPath("userData"), "drawio-local-storage.json");
let localStorage: Record<string, string> | undefined;
let saveTimer: NodeJS.Timeout | undefined;
function drawioLocalStorage(): Record<string, string> {
	if (!localStorage) {
		try {
			localStorage = JSON.parse(fs.readFileSync(localStorageFile(), "utf8"));
		} catch {
			localStorage = {};
		}
	}
	return localStorage!;
}

/** One diagram: a window with the draw.io editor on the left and the agent chat on the right. */
export class DiagramWindow {
	public static readonly all = new Set<DiagramWindow>();
	private static byEditor = new Map<number, DiagramWindow>();
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
	private chatVisible = true;
	/** Presentation mode: only the diagram, read-only, full screen. */
	public presenting = false;
	/** The diagram's content when presenting started: view-only changes while presenting are not edits. */
	private presentBaseline: string | undefined;
	private enteredFullScreen = false;
	private closing = false;
	public readonly mapper: MapperDialog;
	/** The Mapper's maps of this diagram: runs, lookups, findings, descriptions, tours. */
	public readonly maps: MapperService;
	/** Mapped shapes in the selection (for Dig Deeper), refreshed when the selection changes. */
	private mapped: { recipe: string; label: string; data: Record<string, string> }[] = [];
	private mappedTimer: NodeJS.Timeout | undefined;
	/** Content for a new, unsaved window (an imported diagram), and the name to suggest when saving it. */
	private initial: { xml: string; name: string } | undefined;
	/** App-level commands the in-editor File menu can run. Set by main.ts. */
	public static appCommands: { newDiagram(): void; open(): void } = { newDiagram: () => undefined, open: () => undefined };

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
		return [...DiagramWindow.all].find((w) => w.win === win) ?? [...DiagramWindow.all].pop();
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
			width: 1500,
			height: 950,
			minWidth: 800,
			minHeight: 500,
			title: "Draw.AI",
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
		this.chat.attach(this.chatView.webContents);
		this.wireEditorEvents();

		this.win.on("resize", () => this.layout());
		this.win.on("close", (e) => this.onClose(e));
		this.win.on("closed", () => this.dispose());
		this.win.on("focus", () => this.chat.postState());
		this.layout();
		this.updateTitle();
	}

	private async start(server: StaticServer): Promise<void> {
		await this.mcp.start();
		const dark = nativeTheme.shouldUseDarkColors;
		this.win.show();
		this.editorView.webContents.focus();
		void this.editorView.webContents.loadURL(server.editorUrl(this.id, { dark: "auto", localStorage: drawioLocalStorage() }));
		void this.chatView.webContents.loadURL(`${server.base}/chat.html`);
		void dark;
	}

	/** What DiagramToolbox calls a DrawioEditor: the client and the document's URI. */
	private editorHandle(): any {
		if (!this.loaded) return undefined;
		const p = this.file ?? path.join(app.getPath("documents"), "Untitled.drawio");
		return { drawioClient: this.client, uri: { path: p, fsPath: p, scheme: "file", toString: () => `file://${encodeURI(p)}` } };
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
			this.setDirty(!!this.initial && !this.file);
			this.loadedWaiters.splice(0).forEach((r) => r());
			this.chat.postState();
		});
		// Presenting only views the diagram, but draw.io still auto-saves page view state when pages
		// change: that is not an edit. Anything else (an agent or the Mapper still working) is.
		c.onChange.sub(({ newXml }) => {
			if (this.presenting && this.presentBaseline !== undefined && diagramContent(newXml) === this.presentBaseline) return;
			this.setDirty(true);
		});
		c.onSave.sub(() => void this.save());
		c.onSelectedCellsChanged.sub(() => {
			this.chat.postState();
			this.refreshMapped();
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
				localStorage = m.newLocalStorage;
				clearTimeout(saveTimer);
				saveTimer = setTimeout(() => fs.writeFile(localStorageFile(), JSON.stringify(localStorage), () => undefined), 500);
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

	private layout(): void {
		const { width, height } = this.win.getContentBounds();
		const chatWidth = this.chatVisible && !this.presenting ? Math.min(Math.max(280, settings().chatWidth), Math.floor(width * 0.6)) : 0;
		this.editorView.setBounds({ x: 0, y: 0, width: width - chatWidth, height });
		this.chatView.setBounds({ x: width - chatWidth, y: 0, width: chatWidth, height });
		this.chatView.setVisible(this.chatVisible && !this.presenting);
	}

	/** Shows only the diagram, read-only and full screen, with page dots; Esc leaves. */
	public setPresenting(on: boolean): void {
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
			if (on) this.editorView.webContents.focus();
		}
	}

	public togglePresentation(): void {
		this.setPresenting(!this.presenting);
	}

	public toggleChat(): void {
		this.chatVisible = !this.chatVisible;
		this.layout();
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
		this.win.setTitle(`${this.fileName() ?? "Untitled"}${this.dirty ? " •" : ""} — Draw.AI`);
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
			this.file = r.filePath;
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
		clearTimeout(this.mappedTimer);
		this.mapper.close();
		this.chat.dispose();
		this.mcp.dispose();
		this.client.dispose();
		DiagramWindow.all.delete(this);
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
