import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { documentWindows, type DocumentWindow } from "./documentShell";
import { EXCALIDRAW_SOURCE, readScene } from "./excalidrawFile";
import { canonicalPath, docType, Library, LibraryError, type DocKind } from "./library/library";
import { readRecent, RecentFileError, Recents } from "./library/recents";
import { sketchDrawio, sketchExcalidraw } from "./library/sketch";
import { adoptRecords, hasRecords, loadRecord, moveRecords, recordIds } from "./mapper/store";
import { paths } from "./paths";
import { onSettingsChanged, settings, updateSettings } from "./settings";
import type { StaticServer } from "./staticServer";

/** What the home screen asks of the rest of the app (main.ts gives it). */
export interface HomeHost {
	openFile(file: string): Promise<void>;
	/** File → Open…, starting in a folder. */
	openDialog(folder: string): void;
}

/** A new document's file, before anything is drawn in it. */
const EMPTY: Record<DocKind, { ending: string; bytes: () => Buffer }> = {
	excalidraw: { ending: ".excalidraw", bytes: () => Buffer.from(JSON.stringify({ type: "excalidraw", version: 2, source: EXCALIDRAW_SOURCE, elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2) + "\n") },
	drawio: { ending: ".drawio", bytes: () => Buffer.from('<mxfile host="OmniDraw"><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>\n') },
};

/** How wide the picture kept of a document is at most: a card is small. */
const PICTURE_WIDTH = 720;
/** Files larger than this are not read for a preview, and files larger than the second are not sketched. */
const PREVIEW_LIMIT = 30 * 1024 * 1024;
const SKETCH_LIMIT = 8 * 1024 * 1024;

const svgUrl = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const pngUrl = (png: Buffer): string => `data:image/png;base64,${png.toString("base64")}`;

/** A picture made small enough for a card (a PNG); undefined when the bytes are no picture. */
function small(image: Electron.NativeImage): Buffer | undefined {
	if (image.isEmpty()) return undefined;
	const { width } = image.getSize();
	return (width > PICTURE_WIDTH ? image.resize({ width: PICTURE_WIDTH, quality: "good" }) : image).toPNG();
}

/**
 * What a card shows of a document, from its file alone: the picture itself when the file is one
 * (an editable PNG or SVG), else a sketch of what is in it (library/sketch.ts). As a data: address
 * for an <img>, where nothing in it runs or loads. Undefined when there is nothing to show.
 */
function previewOf(bytes: Buffer, ending: string): string | undefined {
	const e = ending.toLowerCase();
	try {
		if (e.endsWith(".png")) {
			const png = small(nativeImage.createFromBuffer(bytes));
			return png && pngUrl(png);
		}
		if (e.endsWith(".svg")) return bytes.length <= 3 * 1024 * 1024 ? `data:image/svg+xml;base64,${bytes.toString("base64")}` : undefined;
		// (a sketch is drawn from the whole file, read here: not of a file that would hold the app up)
		if (bytes.length > SKETCH_LIMIT) return undefined;
		if (e === ".excalidraw") return svgUrl(sketchExcalidraw(readScene("json", bytes)));
		const sketch = sketchDrawio(bytes.toString("utf8"));
		return sketch && svgUrl(sketch);
	} catch {
		return undefined;
	}
}

/**
 * The home screen: the library's documents as cards, in collections, with their versions and a
 * trash; and the documents opened lately, wherever they are. One window, the app's front door.
 */
export class HomeWindow {
	private static win: BrowserWindow | undefined;
	private static installed = false;
	public static host: HomeHost | undefined;
	/** The library as it was last opened, and the folder that was. */
	private static lib: { folder: string; library: Library } | undefined;
	private static watcher: fs.FSWatcher | undefined;
	private static refreshTimer: NodeJS.Timeout | undefined;
	private static pictureTimers = new Map<DocumentWindow, NodeJS.Timeout>();
	private static recentList: Recents | undefined;

	/** The library's folder: the one in Settings, or OmniDraw in the user's Documents. */
	public static folder(): string {
		const chosen = settings().library.folder;
		if (chosen) return chosen;
		// (a test run has no business in the user's Documents: its library is with the rest of its data)
		return process.env.DRAWAI_E2E ? path.join(app.getPath("userData"), "library") : path.join(app.getPath("documents"), "OmniDraw");
	}

	/**
	 * The library. Its folder need not be there: it is made when something is first put into it,
	 * not when the home screen is opened. Throws a LibraryError when the folder cannot be one.
	 */
	public static library(): Library {
		const folder = HomeWindow.folder();
		if (HomeWindow.lib?.folder !== folder) {
			try {
				HomeWindow.lib = { folder, library: new Library(folder) };
			} catch (e: any) {
				throw e instanceof LibraryError ? e : new LibraryError(`The library folder ${folder} could not be opened: ${e?.message ?? e}`);
			}
		}
		return HomeWindow.lib.library;
	}

	/** The library when its folder is there already: opening or saving a file elsewhere does not make one. */
	private static libraryIfThere(): Library | undefined {
		try {
			const lib = HomeWindow.library();
			return lib.exists ? lib : undefined;
		} catch {
			return undefined;
		}
	}

	private static recents(): Recents {
		return (HomeWindow.recentList ??= new Recents(path.join(app.getPath("userData"), "recent.json")));
	}

	public static open(server: StaticServer): void {
		HomeWindow.install();
		const existing = HomeWindow.window;
		if (existing) {
			if (existing.isMinimized()) existing.restore();
			existing.show();
			existing.focus();
			return;
		}
		const win = new BrowserWindow({
			width: 1180,
			height: 760,
			minWidth: 760,
			minHeight: 480,
			title: "OmniDraw",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#f3f2ef",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-home.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		HomeWindow.win = win;
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		// (what changed while another window was in front, or another program: the folder is read again)
		win.on("focus", () => HomeWindow.refreshSoon(0));
		win.on("closed", () => {
			HomeWindow.win = undefined;
			HomeWindow.unwatch();
		});
		void win.loadURL(`${server.base}/home.html`);
	}

	/** The window while it is open (tests drive and screenshot it). */
	public static get window(): BrowserWindow | undefined {
		return HomeWindow.win && !HomeWindow.win.isDestroyed() ? HomeWindow.win : undefined;
	}

	private static install(): void {
		if (HomeWindow.installed) return;
		HomeWindow.installed = true;
		ipcMain.on("home:toHost", (e, msg) => {
			if (!HomeWindow.win || e.sender !== HomeWindow.win.webContents) return;
			void HomeWindow.onMessage(msg).catch((err) => HomeWindow.problem(err));
		});
		onSettingsChanged((_s, patch) => {
			if ("library" in patch) {
				HomeWindow.unwatch();
				HomeWindow.refreshSoon(0);
			}
		});
	}

	private static post(msg: unknown): void {
		HomeWindow.window?.webContents.send("home:toWebview", msg);
	}

	/** Says what could not be done, in the page (the library's own words for it, or the system's). */
	private static problem(e: unknown): void {
		HomeWindow.post({ type: "problem", text: e instanceof LibraryError || e instanceof RecentFileError ? e.message : String((e as any)?.message ?? e) });
	}

	// ----- what the rest of the app tells the home screen -----

	/** A document was opened. It is one opened lately; one of the library's with no version yet gets one, as it was opened. */
	public static opened(file: string): void {
		try {
			HomeWindow.recents().add(file);
			const lib = HomeWindow.libraryIfThere();
			const id = lib?.idOf(file);
			if (lib && id && lib.versions(id).length === 0) lib.snapshotNow(id, { kept: true });
		} catch (e) {
			console.warn("OmniDraw: the home screen could not note an opened document:", e);
		}
		HomeWindow.refreshSoon();
	}

	/** A document was saved. In the library that is a version of it, and a new picture for its card. */
	public static saved(w: DocumentWindow, file: string): void {
		try {
			HomeWindow.recents().add(file);
			const lib = HomeWindow.libraryIfThere();
			const id = lib?.idOf(file);
			if (lib && id) {
				lib.snapshotNow(id);
				// (the picture a moment later, and once for a row of saves: it is the editor's work to make)
				clearTimeout(HomeWindow.pictureTimers.get(w));
				HomeWindow.pictureTimers.set(w, setTimeout(() => void HomeWindow.picture(w), 400));
			}
		} catch (e) {
			console.warn("OmniDraw: the home screen could not note a saved document:", e);
		}
		HomeWindow.refreshSoon();
	}

	public static closed(w: DocumentWindow): void {
		clearTimeout(HomeWindow.pictureTimers.get(w));
		HomeWindow.pictureTimers.delete(w);
		HomeWindow.refreshSoon();
	}

	/** Keeps a picture of the document in a window, as its editor draws it, for its card. */
	private static async picture(w: DocumentWindow): Promise<void> {
		HomeWindow.pictureTimers.delete(w);
		try {
			if (w.win.isDestroyed() || !w.file) return;
			const file = w.file;
			// (none when the editor has moved on from what was saved: the card then shows the file as it is, sketched)
			const made = await w.picture();
			const png = made && small(nativeImage.createFromBuffer(made));
			// (the document may have another name by now, or be gone: then this picture is nobody's)
			const lib = HomeWindow.libraryIfThere();
			const id = lib?.idOf(file);
			if (!png || !lib || !id || w.file !== file) return;
			lib.setThumb(id, png);
			HomeWindow.refreshSoon();
		} catch {
			// (the card shows a sketch instead)
		}
	}

	/** Has the page shown what is in the library now, a moment from now (many changes at once are one reading). */
	public static refreshSoon(delay = 250): void {
		if (!HomeWindow.window) return;
		clearTimeout(HomeWindow.refreshTimer);
		HomeWindow.refreshTimer = setTimeout(() => HomeWindow.postState(), delay);
	}

	// ----- the library, as the page sees it -----

	private static watch(root: string): void {
		if (HomeWindow.watcher) return;
		try {
			HomeWindow.watcher = fs.watch(root, { recursive: true }, () => HomeWindow.refreshSoon(400));
			HomeWindow.watcher.on("error", () => HomeWindow.unwatch());
		} catch {
			// (where a folder cannot be watched with all that is in it, the page is as fresh as its last focus)
			HomeWindow.watcher = undefined;
		}
	}

	private static unwatch(): void {
		HomeWindow.watcher?.close();
		HomeWindow.watcher = undefined;
	}

	/** A path as a person would say it: from their home folder. */
	private static shown(file: string): string {
		const home = os.homedir();
		return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
	}

	private static postState(): void {
		if (!HomeWindow.window) return;
		const folder = HomeWindow.folder();
		// (by their real places: a window opened by a path with a link in it is the same file's)
		const open = new Map(documentWindows.all().filter((w) => w.file).map((w) => [canonicalPath(w.file!), w.isDirty]));
		let lib: Library | undefined;
		let problem: string | undefined;
		try {
			lib = HomeWindow.library();
			if (lib.exists) HomeWindow.watch(lib.root);
		} catch (e: any) {
			problem = String(e?.message ?? e);
		}
		const contents = lib ? lib.contents() : { docs: [], collections: [], trash: [], more: false };
		const recents = HomeWindow.recents()
			.list()
			.map((r) => {
				const type = docType(path.basename(r.path));
				return type ? { path: r.path, ...type, at: r.at, where: HomeWindow.shown(path.dirname(r.path)), id: lib?.idOf(r.path), open: open.has(canonicalPath(r.path)) } : undefined;
			})
			.filter((r) => !!r);
		HomeWindow.post({
			type: "state",
			folder: HomeWindow.shown(folder),
			problem,
			docs: contents.docs.map((d) => {
				const file = canonicalPath(lib!.pathOf(d.id));
				return { ...d, open: open.has(file), unsaved: open.get(file) === true };
			}),
			collections: contents.collections,
			trash: contents.trash,
			more: contents.more,
			recents,
			mac: process.platform === "darwin",
			matrix: settings().appearance.matrix,
		});
	}

	// ----- what the page asks for -----

	/** The window a library document is open in, if it is. */
	private static windowOf(lib: Library, id: string): DocumentWindow | undefined {
		return documentWindows.of(lib.pathOf(id));
	}

	/**
	 * Closes the window a document is open in, for something that needs the file to itself (the
	 * trash, going back to a version). Not over unsaved changes: then the person is told, and
	 * nothing is done. True when the document is in no window afterwards.
	 */
	private static async closeWindowOf(lib: Library, id: string, doing: string): Promise<boolean> {
		// (every window that holds it, were there more than one: none is passed over for another's sake)
		const windows = documentWindows.allOf(lib.pathOf(id));
		if (!windows.length) return true;
		const name = path.basename(lib.pathOf(id));
		// (a save under way ends first: whether the window has unsaved changes is known then)
		await HomeWindow.savesDone(windows);
		const unsaved = windows.find((w) => w.isDirty);
		if (unsaved) {
			unsaved.win.focus();
			throw new LibraryError(`${name} has changes that are not saved. Save it or close its window, then ${doing}.`);
		}
		for (const w of windows) {
			const gone = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 5000);
				w.win.once("closed", () => {
					clearTimeout(timer);
					resolve(true);
				});
			});
			w.win.close();
			if (!(await gone)) throw new LibraryError(`${name} is open and its window did not close. Close it, then ${doing}.`);
		}
		return true;
	}

	/**
	 * A copy of a diagram with maps would point at the same maps' records as the original (the ids
	 * are in its cells), and what is done to the maps of either would be done to both. Until a copy
	 * can be given maps of its own, no copy of such a diagram is made here, by any way of making one.
	 */
	private static noCopyWithMaps(lib: Library, id: string, what: string): void {
		const file = lib.pathOf(id);
		if (hasRecords(path.dirname(file), file)) throw new LibraryError(`${path.basename(file)} has maps, and ${what} would share them with it. Open it and draw the maps again in a copy, or copy it without its maps in Finder.`);
	}

	/** Waits until none of these windows has a save under way (a save that starts meanwhile is waited for too). */
	private static async savesDone(windows: DocumentWindow[]): Promise<void> {
		await Promise.all(windows.map((w) => w.whenSaved()));
	}

	/**
	 * Gives documents another name or place (`change` does it, and says where each one went), and
	 * has their windows follow. The windows are looked up before anything moves: afterwards the
	 * path a window holds leads nowhere, and could not be told to be the same file's.
	 */
	private static async moving(lib: Library, ids: string[], change: () => { from: string; to: string }[]): Promise<void> {
		const windows = new Map(ids.map((id) => [id, { all: documentWindows.allOf(lib.pathOf(id)), was: lib.pathOf(id) }]));
		// A save under way writes where the file was when it started: it ends before the file moves.
		// (from here to the windows taking the new name nothing waits, so no save can start in between)
		await HomeWindow.savesDone([...windows.values()].flatMap((x) => x.all));
		for (const { from, to } of change()) {
			if (from === to) continue;
			const now = lib.pathOf(to);
			const open = windows.get(from)?.all ?? [];
			for (const w of open) w.movedTo(now);
			// A diagram's maps are kept in its folder (Mapper's records, in .drawai/maps): an open window
			// takes them along when it follows (movedTo); a closed one has them taken along here.
			if (!open.length) {
				const was = windows.get(from)?.was ?? lib.pathOf(from);
				try {
					moveRecords({ cwd: path.dirname(was), diagram: was }, { cwd: path.dirname(now), diagram: now });
				} catch {
					// (the diagram is where it should be; its maps can be drawn again)
				}
			}
			HomeWindow.recents().moved(windows.get(from)?.was ?? lib.pathOf(from), now);
		}
	}

	private static async onMessage(msg: any): Promise<void> {
		const text = (v: unknown): string => (typeof v === "string" ? v : "");
		if (msg?.type === "ready") return HomeWindow.postState();
		if (msg?.type === "chooseFolder") {
			const w = HomeWindow.window;
			if (!w) return;
			const r = await dialog.showOpenDialog(w, { title: "Choose the library folder", message: "The folder your diagrams and drawings are kept in", defaultPath: fs.existsSync(HomeWindow.folder()) ? HomeWindow.folder() : app.getPath("documents"), properties: ["openDirectory", "createDirectory"] });
			if (!r.canceled && r.filePaths[0]) updateSettings({ library: { folder: r.filePaths[0] } });
			return HomeWindow.postState();
		}
		if (msg?.type === "openRecent") {
			// (only what is in the list is opened: the page names a place there, not a path of its own)
			const recent = HomeWindow.recents().list().find((r) => r.path === msg.path);
			if (recent) await HomeWindow.host?.openFile(recent.path);
			return;
		}
		if (msg?.type === "removeRecent") {
			HomeWindow.recents().remove(text(msg.path));
			return HomeWindow.postState();
		}
		if (msg?.type === "revealRecent") {
			const recent = HomeWindow.recents().list().find((r) => r.path === msg.path);
			if (recent) shell.showItemInFolder(recent.path);
			return;
		}
		const lib = HomeWindow.library();
		try {
			switch (msg?.type) {
				case "open":
					lib.read(text(msg.id));
					await HomeWindow.host?.openFile(lib.pathOf(text(msg.id)));
					return;
				case "openOther":
					HomeWindow.host?.openDialog(lib.exists ? lib.root : app.getPath("documents"));
					return;
				case "new": {
					const kind: DocKind = msg.kind === "drawio" ? "drawio" : "excalidraw";
					const id = lib.create(text(msg.collection), "Untitled", EMPTY[kind].ending, EMPTY[kind].bytes());
					HomeWindow.postState();
					await HomeWindow.host?.openFile(lib.pathOf(id));
					return;
				}
				case "addRecent": {
					// a document from elsewhere, copied into the library (the one elsewhere stays where it is)
					const recent = HomeWindow.recents().list().find((r) => r.path === msg.path);
					const type = recent && docType(path.basename(recent.path));
					if (!recent || !type) break;
					// A diagram's maps are known by ids in its cells, and their records by those ids in the folder.
					// Where the copy goes there are records by one of its ids already (it was copied in before):
					// the two copies would share them, and so it is not copied again.
					const into = text(msg.collection) ? path.join(lib.root, text(msg.collection)) : lib.root;
					const shared = recordIds(path.dirname(recent.path), recent.path).filter((mapId) => !!loadRecord(into, mapId));
					if (shared.length) throw new LibraryError(`${path.basename(recent.path)} has maps that a diagram in ${text(msg.collection) || "the library"} has too (it was copied in before). A second copy would share them with that one. Open the one that is there, or copy this one into another collection.`);
					// (only as the very file that was opened here, never through a link that took its place: see readRecent)
					const copied = lib.pathOf(lib.create(text(msg.collection), type.name, type.ending, readRecent(recent, PREVIEW_LIMIT * 4)));
					// (its maps' records are copied beside it, as Save As to another folder copies them: in a folder
					// of its own, the copy's maps are its own, and the original keeps its records where they are)
					if (canonicalPath(path.dirname(copied)) !== canonicalPath(path.dirname(recent.path))) {
						try {
							adoptRecords({ cwd: path.dirname(recent.path), diagram: recent.path }, { cwd: path.dirname(copied), diagram: copied });
						} catch {
							// (the diagram is copied; its maps can be drawn again)
						}
					}
					break;
				}
				case "rename":
					await HomeWindow.moving(lib, [text(msg.id)], () => [{ from: text(msg.id), to: lib.rename(text(msg.id), text(msg.name)) }]);
					break;
				case "move":
					await HomeWindow.moving(lib, [text(msg.id)], () => [{ from: text(msg.id), to: lib.move(text(msg.id), text(msg.collection)) }]);
					break;
				case "duplicate": {
					// A copy of a diagram with maps would point at the same maps' records as the original, and
					// what is done to the maps of either would be done to both. Until a copy can be given maps
					// of its own, such a diagram is not duplicated here.
					HomeWindow.noCopyWithMaps(lib, text(msg.id), "a copy");
					lib.duplicate(text(msg.id));
					break;
				}
				case "trash": {
					await HomeWindow.closeWindowOf(lib, text(msg.id), "move it to the trash");
					const file = lib.pathOf(text(msg.id));
					HomeWindow.recents().remove(file);
					const trashId = lib.trash(text(msg.id));
					// A diagram's maps go into the trash with it (Mapper keeps them in its folder, by its name):
					// left in the folder, they would be taken for the maps of a new diagram of the same name,
					// and not be the restored diagram's if it came back under another name.
					try {
						const kept = lib.trashFolder(trashId);
						moveRecords({ cwd: path.dirname(file), diagram: file }, { cwd: kept, diagram: path.join(kept, path.basename(file)) });
					} catch {
						// (the document is in the trash; its maps can be drawn again)
					}
					break;
				}
				case "reveal":
					lib.read(text(msg.id));
					shell.showItemInFolder(lib.pathOf(text(msg.id)));
					return;
				case "revealLibrary":
					if (!lib.exists) throw new LibraryError(`The library folder is not there yet. It is made at ${HomeWindow.shown(lib.root)} with the first drawing or diagram you make here.`);
					void shell.openPath(lib.root);
					return;
				case "newCollection":
					lib.createCollection(text(msg.name));
					break;
				case "renameCollection": {
					const from = text(msg.name);
					// (the cards are read up to a number; a document open in a window is in the collection whether or not it got a card)
					const openInside = documentWindows
						.all()
						.map((w) => (w.file ? lib.idOf(w.file) : undefined))
						.filter((id): id is string => !!id && id.split("/")[0] === from);
					const inside = [...new Set([...lib.contents().docs.filter((d) => d.collection === from).map((d) => d.id), ...openInside])];
					let to = from;
					await HomeWindow.moving(lib, inside, () => {
						to = lib.renameCollection(from, text(msg.to));
						return inside.map((id) => ({ from: id, to: [to, ...id.split("/").slice(1)].join("/") }));
					});
					HomeWindow.post({ type: "collectionRenamed", from, to });
					break;
				}
				case "removeCollection": {
					let kept = false;
					let failed: string[] = [];
					await HomeWindow.moving(lib, lib.contents().docs.filter((d) => d.collection === text(msg.name)).map((d) => d.id), () => {
						const r = lib.removeCollection(text(msg.name));
						kept = r.kept;
						failed = r.failed;
						return r.moved;
					});
					if (failed.length) HomeWindow.post({ type: "problem", text: `${failed.map((id) => id.split("/").pop()).join(", ")} could not be moved out of ${text(msg.name)}, so the collection stays. The others are in the library's top now.` });
					else if (kept) HomeWindow.post({ type: "note", text: `The folder ${text(msg.name)} has other files in it and was left in the library. Its diagrams and drawings are in the library's top now.` });
					break;
				}
				case "restore": {
					const item = lib.contents().trash.find((t) => t.id === msg.trashId);
					const kept = item ? lib.trashFolder(item.id) : undefined;
					// (the maps that went with it are taken out of the trash before the trash's folder goes, and given its name now)
					const holding = kept && fs.mkdtempSync(path.join(path.dirname(kept), ".restoring-"));
					if (kept && holding && item) moveRecords({ cwd: kept, diagram: path.join(kept, `${item.name}${item.ending}`) }, { cwd: holding, diagram: path.join(holding, `${item.name}${item.ending}`) });
					let id: string;
					try {
						id = lib.restore(text(msg.trashId));
					} catch (e) {
						// (not put back: its maps go back into the trash with it, and only then is the holding place cleared)
						if (holding && kept && item && fs.existsSync(kept)) {
							moveRecords({ cwd: holding, diagram: path.join(holding, `${item.name}${item.ending}`) }, { cwd: kept, diagram: path.join(kept, `${item.name}${item.ending}`) });
							fs.rmSync(holding, { recursive: true, force: true });
						}
						throw e;
					}
					if (holding && item) {
						const now = lib.pathOf(id);
						try {
							moveRecords({ cwd: holding, diagram: path.join(holding, `${item.name}${item.ending}`) }, { cwd: path.dirname(now), diagram: now });
							fs.rmSync(holding, { recursive: true, force: true });
						} catch (e: any) {
							// The document is back; its maps could not be put beside it. They are not thrown away:
							// the place they were held in stays, and the person is told where it is.
							HomeWindow.post({ type: "problem", text: `${path.basename(now)} is back, but its maps could not be put beside it (${e?.message ?? e}). They are kept in ${HomeWindow.shown(holding)}.` });
						}
					}
					break;
				}
				case "deleteForever": {
					const item = lib.contents().trash.find((t) => t.id === msg.trashId);
					if (!item || !(await HomeWindow.confirm(`Delete ${item.name}${item.ending} for good?`, "It and its earlier versions are removed from the library's trash. This cannot be undone.", "Delete"))) return;
					lib.deleteForever(item.id);
					break;
				}
				case "emptyTrash": {
					const count = lib.contents().trash.length;
					if (!count || !(await HomeWindow.confirm(`Delete the ${count === 1 ? "document" : `${count} documents`} in the trash for good?`, "They and their earlier versions are removed. This cannot be undone.", "Empty Trash"))) return;
					lib.emptyTrash();
					break;
				}
				case "versions":
					HomeWindow.post({ type: "versions", id: text(msg.id), versions: lib.versions(text(msg.id)) });
					return;
				case "restoreVersion": {
					const id = text(msg.id);
					const reopen = !!HomeWindow.windowOf(lib, id);
					await HomeWindow.closeWindowOf(lib, id, "go back to that version");
					lib.restoreVersion(id, text(msg.key));
					HomeWindow.post({ type: "versions", id, versions: lib.versions(id) });
					if (reopen) await HomeWindow.host?.openFile(lib.pathOf(id));
					break;
				}
				case "openVersion": {
					// a version opened beside the document, as a document of its own
					const id = text(msg.id);
					const version = lib.versions(id).find((v) => v.key === msg.key);
					const type = docType(id.split("/").pop()!);
					if (!version || !type) throw new LibraryError("That version is not kept any more.");
					HomeWindow.noCopyWithMaps(lib, id, "a version opened as a copy");
					const when = new Date(version.at);
					const pad = (n: number): string => String(n).padStart(2, "0");
					const copy = lib.create(id.includes("/") ? id.split("/")[0] : "", `${type.name} (${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())})`, type.ending, lib.versionBytes(id, version.key));
					HomeWindow.postState();
					await HomeWindow.host?.openFile(lib.pathOf(copy));
					return;
				}
				case "preview":
					HomeWindow.post({ type: "preview", key: text(msg.key), url: HomeWindow.preview(lib, msg) });
					return;
				default:
					return;
			}
		} catch (e) {
			HomeWindow.problem(e);
		}
		HomeWindow.postState();
	}

	private static async confirm(message: string, detail: string, action: string): Promise<boolean> {
		const w = HomeWindow.window;
		if (!w) return false;
		const r = await dialog.showMessageBox(w, { type: "warning", message, detail, buttons: [action, "Cancel"], defaultId: 1, cancelId: 1 });
		return r.response === 0;
	}

	/** The picture for a card: of a document, of one in the trash, of a version, or of a recent file elsewhere. */
	private static preview(lib: Library, msg: any): string | undefined {
		try {
			if (typeof msg.trashId === "string") {
				const thumb = lib.trashThumb(msg.trashId);
				if (thumb) return pngUrl(thumb);
				const item = lib.trashBytes(msg.trashId, PREVIEW_LIMIT);
				return item && previewOf(item.bytes, item.ending);
			}
			if (typeof msg.path === "string") {
				const recent = HomeWindow.recents().list().find((r) => r.path === msg.path);
				const type = recent && docType(path.basename(recent.path));
				// (as for a copy: only the very file that was opened, never what a link put there since leads to)
				return recent && type ? previewOf(readRecent(recent, PREVIEW_LIMIT), type.ending) : undefined;
			}
			const id = String(msg.id ?? "");
			const type = docType(id.split("/").pop() ?? "");
			if (!type) return undefined;
			if (typeof msg.version === "string") return previewOf(lib.versionBytes(id, msg.version), type.ending);
			const thumb = lib.thumb(id);
			if (thumb) return pngUrl(thumb);
			return previewOf(lib.read(id, PREVIEW_LIMIT), type.ending);
		} catch {
			return undefined;
		}
	}
}
