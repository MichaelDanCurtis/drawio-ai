import { app, BaseWindow, dialog, ipcMain, nativeTheme, shell, WebContentsView } from "electron";
import * as fs from "fs";
import * as path from "path";
import { ChatDock, documentWindows, windowPlacement, type DocumentWindow } from "./documentShell";
import { baseName, EXCALIDRAW_MIME, ExcalidrawFileError, formatForPath, pictureToWrite, readScene, sceneTextToWrite, type ExcalidrawFormat } from "./excalidrawFile";
import { paths } from "./paths";
import { documentKey } from "./shortcuts";
import { onSettingsChanged, settings, type Settings } from "./settings";
import type { StaticServer } from "./staticServer";

/** What the chat says in a window with an Excalidraw drawing: the agents' drawing tools are draw.io's. */
export const NO_AI_YET = "AI editing of Excalidraw drawings is not there yet: the agents' drawing tools work on draw.io diagrams.";

let nextId = 1;

/**
 * One Excalidraw drawing: a window with the Excalidraw editor on one side and the chat on the
 * other, in the same shell as a diagram window (documentShell.ts). The editor is the real
 * Excalidraw (src/renderer/excalidraw/app.tsx); this class is the document around it: the file,
 * unsaved changes, Save and Save As, export, and the question asked before the window closes.
 *
 * A drawing is a `.excalidraw` file (Excalidraw's JSON), or a PNG or SVG with the drawing inside
 * it: those are saved back as the pictures they are.
 */
export class ExcalidrawWindow implements DocumentWindow {
	public readonly kind = "excalidraw" as const;
	public static readonly all = new Set<ExcalidrawWindow>();
	private static byEditor = new Map<number, ExcalidrawWindow>();
	private static byChat = new Map<number, ExcalidrawWindow>();
	/** App-level commands the window's bar and Excalidraw's menu can run. Set by main.ts. */
	public static appCommands: { newDrawing(): void; open(): void; openPath(file: string): void; settings(section?: string): void } = { newDrawing: () => undefined, open: () => undefined, openPath: () => undefined, settings: () => undefined };
	/** Called when a window comes to the front (it got the focus, or its drawing has just loaded), and after one closes: main.ts rebuilds the menu bar. */
	public static onFront: (() => void) | undefined;
	public static onClosed: (() => void) | undefined;
	/** How a failure is shown (the end-to-end run records it instead of stopping at a dialog). */
	public static showError: (title: string, message: string) => void = (title, message) => dialog.showErrorBox(title, message);

	public readonly id = `x${nextId++}`;
	/** A BaseWindow with two views, as a diagram window is (see DiagramWindow.win). */
	public readonly win: BaseWindow;
	public readonly editorView: WebContentsView;
	public readonly chatView: WebContentsView;
	public file: string | undefined;
	private format: ExcalidrawFormat;
	private dirty = false;
	private loaded = false;
	private loadedWaiters: (() => void)[] = [];
	private closing = false;
	/** A Save As, export or close question of this window is open (a second one is not started over it). */
	private asking = false;
	private readonly dock: ChatDock;
	private offSettings: (() => void) | undefined;
	private requestSeq = 0;
	private requests = new Map<number, { resolve: (r: Serialized) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	/** Saves whose file is written and whose page has not yet said whether the drawing changed meanwhile. */
	private confirmations = new Map<number, () => void>();

	/**
	 * Opens a drawing in a window of its own (the window it is already open in comes to the front), or
	 * a new, empty one. A file that is not an Excalidraw drawing is refused with a message, and no window opens.
	 */
	public static async open(server: StaticServer, file?: string): Promise<ExcalidrawWindow | undefined> {
		if (file) {
			const existing = [...ExcalidrawWindow.all].find((w) => w.file === file);
			if (existing) {
				existing.win.focus();
				return existing;
			}
			try {
				ExcalidrawWindow.read(file);
			} catch (e: any) {
				ExcalidrawWindow.showError("Could not open the drawing", String(e?.message ?? e));
				return undefined;
			}
		}
		const w = new ExcalidrawWindow(server, file);
		w.start();
		return w;
	}

	/** The file's bytes, once they are known to hold a drawing. */
	private static read(file: string): { bytes: Buffer; format: ExcalidrawFormat } {
		const format = formatForPath(file);
		if (!format) throw new ExcalidrawFileError(`${path.basename(file)} is not an Excalidraw drawing.`);
		const bytes = fs.readFileSync(file);
		readScene(format, bytes, path.basename(file));
		return { bytes, format };
	}

	public static installIpc(): void {
		ipcMain.on("excalidraw:toHost", (e, msg) => ExcalidrawWindow.byEditor.get(e.sender.id)?.onEditorMessage(msg));
		ipcMain.handle("excalidraw:document", (e) => ExcalidrawWindow.byEditor.get(e.sender.id)?.documentForPage());
		// (the chat page is the diagram windows' too: each kind of window answers its own)
		ipcMain.on("chat:toHost", (e, msg) => ExcalidrawWindow.byChat.get(e.sender.id)?.onChatMessage(msg));
	}

	private constructor(private readonly server: StaticServer, file: string | undefined) {
		this.file = file;
		this.format = (file && formatForPath(file)) || "json";
		this.win = new BaseWindow({
			...windowPlacement(),
			minWidth: 800,
			minHeight: 500,
			title: "OmniDraw",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#f3f2ef",
			show: false,
		});
		const prefs = (preload: string) => ({
			preload: path.join(paths.out, preload),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		});
		this.editorView = new WebContentsView({ webPreferences: prefs("preload-excalidraw.js") });
		this.chatView = new WebContentsView({ webPreferences: prefs("preload-chat.js") });
		this.win.contentView.addChildView(this.editorView);
		this.win.contentView.addChildView(this.chatView);
		this.dock = new ChatDock(this.win, this.editorView, this.chatView, { changed: () => this.sendLook() });
		ExcalidrawWindow.byEditor.set(this.editorView.webContents.id, this);
		ExcalidrawWindow.byChat.set(this.chatView.webContents.id, this);
		ExcalidrawWindow.all.add(this);
		documentWindows.add(this);

		for (const wc of [this.editorView.webContents, this.chatView.webContents]) {
			wc.setWindowOpenHandler(({ url }) => {
				if (/^https?:/.test(url)) void shell.openExternal(url);
				return { action: "deny" };
			});
			wc.on("will-navigate", (e, url) => {
				if (!url.startsWith(server.base)) e.preventDefault();
			});
		}
		// Keys that are the document's in this window: Save, Save As, Open, Export as PNG. Excalidraw has
		// its own idea of each (a download, a file picker, its export dialog), so the page never sees
		// them: they are taken here, before the page and before the menu bar (which shows the same keys,
		// and answers them when the chat has the focus).
		this.editorView.webContents.on("before-input-event", (e, input) => {
			const command = documentKey(input);
			if (!command) return;
			e.preventDefault();
			this.runCommand(command);
		});
		// (the page starting again, as after View → Reload Editor: it asks for the document anew)
		this.editorView.webContents.on("did-start-navigation", (_e, _url, inPlace, isMainFrame) => {
			if (!isMainFrame || inPlace) return;
			this.loaded = false;
			this.failRequests("The editor was reloaded.");
		});

		this.win.on("resize", () => this.dock.layout());
		this.win.on("close", (e) => void this.onClose(e));
		this.win.on("closed", () => this.dispose());
		this.win.on("focus", () => {
			documentWindows.used(this);
			ExcalidrawWindow.onFront?.();
		});
		this.offSettings = onSettingsChanged((_s, patch) => this.applySettings(patch));
		this.dock.layout();
		this.updateTitle();
	}

	private start(): void {
		this.win.show();
		this.editorView.webContents.focus();
		void this.editorView.webContents.loadURL(`${this.server.base}/excalidraw.html`);
		void this.chatView.webContents.loadURL(`${this.server.base}/chat.html`);
	}

	/** Settings changed (in the Settings window): follow them in this window. */
	private applySettings(patch: Partial<Settings>): void {
		if (this.win.isDestroyed()) return;
		if ("chat" in patch || "chatWidth" in patch) this.dock.layout();
		if ("appearance" in patch || "chat" in patch) {
			this.sendLook();
			this.postChatState();
		}
	}

	// ----- the editor page -----

	private sendToEditor(msg: unknown): void {
		if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.send("excalidraw:toWebview", msg);
	}

	private look(): { chatVisible: boolean; chatSide: "left" | "right"; iconStyle: string } {
		const s = settings();
		return { chatVisible: this.dock.visible, chatSide: s.chat.side, iconStyle: s.appearance.iconStyle };
	}

	/** The document's name and the window's look, for the bar above the canvas. */
	private sendLook(): void {
		this.sendToEditor({ type: "look", name: this.displayName(), saved: !!this.file, look: this.look() });
	}

	/** What the page asks for when it starts: the file's bytes (none for a new drawing). */
	private documentForPage(): { name: string; saved: boolean; bytes?: Uint8Array; mime?: string; error?: string; look: ReturnType<ExcalidrawWindow["look"]> } {
		const base = { name: this.displayName(), saved: !!this.file, look: this.look() };
		if (!this.file) return base;
		try {
			const { bytes, format } = ExcalidrawWindow.read(this.file);
			return { ...base, bytes: new Uint8Array(bytes), mime: EXCALIDRAW_MIME[format] };
		} catch (e: any) {
			return { ...base, error: String(e?.message ?? e) };
		}
	}

	private onEditorMessage(msg: any): void {
		switch (msg?.type) {
			case "loaded":
				this.loaded = true;
				this.setDirty(false);
				this.loadedWaiters.splice(0).forEach((r) => r());
				ExcalidrawWindow.onFront?.();
				break;
			case "loadFailed":
				// (the file was a drawing when the window opened: it changed, or went, since)
				ExcalidrawWindow.showError("Could not open the drawing", String(msg.message ?? ""));
				this.closing = true;
				if (!this.win.isDestroyed()) this.win.close();
				break;
			case "dirty":
				this.setDirty(!!msg.dirty);
				break;
			case "command":
				this.runCommand(String(msg.command));
				break;
			case "openPath":
				if (typeof msg.path === "string" && path.isAbsolute(msg.path)) ExcalidrawWindow.appCommands.openPath(msg.path);
				break;
			case "savedState":
				// (what the page holds now, against what was just written)
				this.setDirty(!!msg.dirty);
				this.confirmations.get(Number(msg.id))?.();
				break;
			case "serialized": {
				const request = this.requests.get(Number(msg.id));
				if (!request) break;
				this.requests.delete(Number(msg.id));
				clearTimeout(request.timer);
				if (msg.ok) request.resolve({ data: msg.data, stamp: String(msg.stamp), elements: Number(msg.elements) });
				else request.reject(new Error(String(msg.error || "The editor could not hand over the drawing.")));
				break;
			}
		}
	}

	/** Commands from the bar above the canvas and from Excalidraw's menu. */
	public runCommand(command: string): void {
		switch (command) {
			case "new": return ExcalidrawWindow.appCommands.newDrawing();
			case "open": return ExcalidrawWindow.appCommands.open();
			case "save": return void this.save();
			case "saveAs": return void this.saveAs();
			case "exportPng": return void this.exportInteractive("png");
			case "exportSvg": return void this.exportInteractive("svg");
			case "toggleChat": return this.toggleChat();
			case "settings": return ExcalidrawWindow.appCommands.settings();
		}
	}

	/**
	 * Undo, redo or select all from the menu bar, for the drawing: they are Excalidraw's own keys.
	 * False when they are not the drawing's to take (text is being typed, or the page is not there).
	 */
	public async runEdit(action: "undo" | "redo" | "selectAll"): Promise<boolean> {
		if (!this.loaded || this.editorView.webContents.isDestroyed()) return false;
		try {
			return !!(await this.editorView.webContents.executeJavaScript(`!!(window.omnidrawExcalidraw && window.omnidrawExcalidraw.edit(${JSON.stringify(action)}))`));
		} catch {
			return false;
		}
	}

	public whenLoaded(): Promise<void> {
		return this.loaded ? Promise.resolve() : new Promise((r) => this.loadedWaiters.push(r));
	}

	public get isDirty(): boolean {
		return this.dirty;
	}

	/** The drawing as the contents of a file of that format, checked (see excalidrawFile.ts), and what it held then. */
	private async contents(format: ExcalidrawFormat): Promise<{ bytes: Buffer; stamp: string }> {
		if (!this.loaded) throw new Error("The drawing is still loading. Try again in a moment.");
		const r = await new Promise<Serialized>((resolve, reject) => {
			const id = ++this.requestSeq;
			const timer = setTimeout(() => {
				this.requests.delete(id);
				reject(new Error("The editor did not hand over the drawing in time."));
			}, 60_000);
			this.requests.set(id, { resolve, reject, timer });
			this.sendToEditor({ type: "serialize", id, format });
		});
		const bytes = format === "json" ? Buffer.from(sceneTextToWrite(r.data), "utf8") : pictureToWrite(format, r.data, r.elements);
		return { bytes, stamp: r.stamp };
	}

	private failRequests(reason: string): void {
		for (const done of [...this.confirmations.values()]) done();
		for (const [id, request] of this.requests) {
			clearTimeout(request.timer);
			request.reject(new Error(reason));
			this.requests.delete(id);
		}
	}

	// ----- the chat -----

	/**
	 * The chat panel is the app's (chat.html), but no agent is started for it here and it is given
	 * no tools: those draw in draw.io. It says so, and still closes, resizes and opens Settings.
	 */
	private onChatMessage(msg: any): void {
		switch (msg?.type) {
			case "ready":
				this.postChatState();
				break;
			case "collapseChat":
				this.dock.setVisible(false);
				break;
			case "resizeChat":
				if (typeof msg.screenX === "number" && isFinite(msg.screenX)) this.dock.resizeTo(msg.screenX, !!msg.done);
				else if (msg.done) this.dock.resizeTo(NaN, true);
				break;
			case "openSettings":
				ExcalidrawWindow.appCommands.settings(msg.section === "agents" || msg.section === "api" ? msg.section : undefined);
				break;
			case "command":
				if (msg.command === "drawai.openSettings") ExcalidrawWindow.appCommands.settings();
				break;
		}
	}

	private postChatState(): void {
		if (this.chatView.webContents.isDestroyed()) return;
		const s = settings();
		this.chatView.webContents.send("chat:toWebview", {
			type: "state",
			state: {
				file: this.displayName(),
				unavailable: NO_AI_YET,
				transcript: [],
				transcriptVersion: 0,
				busy: false,
				providers: [],
				models: [],
				iconStyle: s.appearance.iconStyle,
				matrix: s.appearance.matrix,
				chatSide: s.chat.side,
			},
		});
	}

	public toggleChat(): void {
		this.dock.toggle();
	}

	public resizeChat(delta: number): void {
		this.dock.resize(delta);
	}

	// ----- document -----

	public fileName(): string | undefined {
		return this.file ? path.basename(this.file) : undefined;
	}

	private displayName(): string {
		return this.fileName() ?? "Untitled drawing";
	}

	private setDirty(dirty: boolean): void {
		this.dirty = dirty;
		this.updateTitle();
	}

	private updateTitle(): void {
		if (this.win.isDestroyed()) return;
		this.win.setTitle(`${this.displayName()}${this.dirty ? " •" : ""} — OmniDraw`);
		this.win.setDocumentEdited(this.dirty);
		if (this.file) this.win.setRepresentedFilename(this.file);
	}

	public async save(): Promise<boolean> {
		if (!this.file) return this.saveAs();
		return this.writeTo(this.file, this.format);
	}

	public async saveAs(): Promise<boolean> {
		if (this.asking) return false;
		this.asking = true;
		try {
			const r = await dialog.showSaveDialog(this.win, {
				defaultPath: this.file ?? path.join(app.getPath("documents"), "Untitled.excalidraw"),
				filters: [
					{ name: "Excalidraw", extensions: ["excalidraw"] },
					{ name: "Editable PNG (.excalidraw.png)", extensions: ["excalidraw.png"] },
					{ name: "Editable SVG (.excalidraw.svg)", extensions: ["excalidraw.svg"] },
				],
			});
			if (r.canceled || !r.filePath) return false;
			// (a name without an ending the app knows becomes a .excalidraw file)
			const target = await this.namedFile(r.filePath, !!formatForPath(r.filePath), ".excalidraw");
			return target ? await this.saveTo(target) : false;
		} finally {
			this.asking = false;
		}
	}

	/**
	 * The file a name chosen in a save dialog stands for: the name itself when it `fits`, else the
	 * name with `ending` added. The dialog asked about replacing the name it was given, not the one
	 * made here: when that file exists, the user is asked about it. Undefined when they say no.
	 */
	private async namedFile(chosen: string, fits: boolean, ending: string): Promise<string | undefined> {
		if (fits) return chosen;
		const target = chosen + ending;
		if (fs.existsSync(target)) {
			const replace = await dialog.showMessageBox(this.win, { type: "warning", message: `Replace ${path.basename(target)}?`, detail: `A file with that name is already there (${path.basename(chosen)} became ${path.basename(target)}).`, buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1 });
			if (replace.response !== 0) return undefined;
		}
		return target;
	}

	/** Saves the drawing under a (new) name, in the format the name says, and makes that its file. */
	public async saveTo(target: string): Promise<boolean> {
		const format = formatForPath(target);
		if (!format) {
			ExcalidrawWindow.showError("Could not save", `${path.basename(target)} is not a name for a drawing: use .excalidraw, .excalidraw.png or .excalidraw.svg.`);
			return false;
		}
		const other = [...ExcalidrawWindow.all].find((w) => w !== this && w.file && path.resolve(w.file) === path.resolve(target));
		if (other) {
			ExcalidrawWindow.showError("Could not save", `${path.basename(target)} is open in another window. Close that window first, or pick another name.`);
			return false;
		}
		if (!(await this.writeTo(target, format))) return false;
		this.file = target;
		this.format = format;
		app.addRecentDocument(target);
		this.updateTitle();
		this.sendLook();
		this.postChatState();
		return true;
	}

	private async writeTo(file: string, format: ExcalidrawFormat): Promise<boolean> {
		try {
			const { bytes, stamp } = await this.contents(format);
			fs.writeFileSync(file, bytes);
			await this.confirmSaved(stamp);
			return true;
		} catch (e: any) {
			ExcalidrawWindow.showError("Could not save", String(e?.message ?? e));
			return false;
		}
	}

	/**
	 * Tells the page what was written, and waits for it to say whether the drawing has changed since
	 * it handed that over (the editor stays usable while a picture is made and a file is written).
	 * When this returns, `dirty` is true exactly if there is something the file does not have. A page
	 * that does not answer leaves it as it was: unsaved.
	 */
	private async confirmSaved(stamp: string): Promise<void> {
		const id = ++this.requestSeq;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.confirmations.delete(id);
				resolve();
			};
			const timer = setTimeout(done, 5_000);
			this.confirmations.set(id, done);
			this.sendToEditor({ type: "saved", id, stamp });
		});
	}

	/** Export as a PNG or SVG picture with the drawing inside it: it opens again for editing, here or in Excalidraw. */
	public async exportInteractive(format: "png" | "svg"): Promise<void> {
		if (this.asking) return;
		this.asking = true;
		try {
			const label = format === "png" ? "PNG" : "SVG";
			const dir = this.file ? path.dirname(this.file) : app.getPath("documents");
			const r = await dialog.showSaveDialog(this.win, {
				title: `Export as ${label}`,
				defaultPath: path.join(dir, `${baseName(this.fileName() ?? "Untitled")}.${format}`),
				filters: [{ name: `${label} with the drawing inside`, extensions: [format] }],
			});
			if (r.canceled || !r.filePath) return;
			// (a PNG export named drawing.svg is written as drawing.svg.png)
			const target = await this.namedFile(r.filePath, formatForPath(r.filePath) === format, `.${format}`);
			if (target && (await this.exportTo(format, target))) shell.showItemInFolder(target);
		} finally {
			this.asking = false;
		}
	}

	/** Writes the picture. A drawing that is itself that picture is saved instead (it is the same file). */
	public async exportTo(format: "png" | "svg", target: string): Promise<boolean> {
		if (this.file && path.resolve(target) === path.resolve(this.file)) return this.save();
		if ([...ExcalidrawWindow.all].some((w) => w !== this && w.file && path.resolve(w.file) === path.resolve(target))) {
			ExcalidrawWindow.showError("Export failed", `${path.basename(target)} is open in another window. Close that window first, or pick another name.`);
			return false;
		}
		try {
			const { bytes } = await this.contents(format);
			fs.writeFileSync(target, bytes);
			return true;
		} catch (e: any) {
			ExcalidrawWindow.showError("Export failed", String(e?.message ?? e));
			return false;
		}
	}

	private async onClose(e: Electron.Event): Promise<void> {
		if (this.closing || !this.dirty) return;
		e.preventDefault();
		if (this.asking) return;
		this.asking = true;
		let response: number;
		try {
			response = (
				await dialog.showMessageBox(this.win, {
					type: "warning",
					message: `Save changes to ${this.displayName()}?`,
					detail: "Your changes will be lost if you don't save them.",
					buttons: ["Save", "Don't Save", "Cancel"],
					defaultId: 0,
					cancelId: 2,
				})
			).response;
		} finally {
			this.asking = false;
		}
		if (response === 2) return;
		if (response === 0) {
			if (!(await this.save())) return;
			// Changed while it was being saved (the editor stays usable meanwhile): those changes are not
			// in the file, so the window does not close over them. It asks again.
			if (this.dirty) return void this.win.close();
		}
		this.closing = true;
		this.win.close();
	}

	private dispose(): void {
		setTimeout(() => ExcalidrawWindow.onClosed?.(), 0);
		this.failRequests("The window was closed.");
		this.loadedWaiters.splice(0).forEach((r) => r());
		this.dock.dispose();
		this.offSettings?.();
		documentWindows.remove(this);
		ExcalidrawWindow.all.delete(this);
		for (const [k, v] of ExcalidrawWindow.byEditor) if (v === this) ExcalidrawWindow.byEditor.delete(k);
		for (const [k, v] of ExcalidrawWindow.byChat) if (v === this) ExcalidrawWindow.byChat.delete(k);
		if (!this.editorView.webContents.isDestroyed()) this.editorView.webContents.close();
		if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close();
	}
}

/** What the editor page hands over when asked for the drawing. */
interface Serialized {
	data: unknown;
	stamp: string;
	elements: number;
}
