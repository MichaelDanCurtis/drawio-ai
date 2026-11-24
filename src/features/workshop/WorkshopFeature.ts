import * as vscode from "vscode";
import * as nodePath from "path";
import { promises as fsp } from "fs";
import * as os from "os";
import { randomBytes } from "crypto";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import { cleanShapeSets, ShapeSetGroup } from "../../../standalone/src/main/shapeSets";
import type { WorkshopCore, WorkshopHost } from "../../../standalone/src/main/workshop/core";
import type { GalleryService } from "../../../standalone/src/main/workshop/galleries";
import { cleanGalleries, GalleryConfig } from "../../../standalone/src/main/workshop/types";
import { fileNameOf, isOnDisk } from "../diskUri";
import { cleanLook, OMNI_DIR } from "../editorLook";
import { pageNonce } from "../omniPage";
import { anyGalleryOn, GALLERIES_KEY, storedGalleries } from "./galleryStore";
import { WORKSHOP_PAGE, workshopPageHtml } from "./workshopPage";

type Runtime = typeof import("./runtime");

export interface WorkshopDeps {
	context: vscode.ExtensionContext;
	editorService: DrawioEditorService;
	/** Hands a request about a diagram's selection to the Draw.AI agent in VS Code's chat (the Shape Shifter's "Ask the agent"). */
	askAgent?(text: string, editor: DrawioEditor): Promise<unknown>;
}

/**
 * The Shape Workshop in VS Code: the desktop app's Workshop page in a webview panel (the
 * Shape Gallery: galleries on and off, add, sync, collections, search, insert, and draw.io's
 * own shape sets), the galleries that are on as palettes in every diagram's shapes sidebar,
 * and their shapes in draw.io's own search.
 *
 * Nothing is downloaded until the user turns a gallery on (see galleryStore.ts).
 */
export class WorkshopFeature {
	public readonly dispose = Disposable.fn();

	private runtimePromise: Promise<Runtime> | undefined;
	private service: GalleryService | undefined;
	private core: WorkshopCore | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private opening = false;
	/** What the panel's page reported (tests): that it started, and what the webview could load. */
	private page: { ready: boolean; loaded?: unknown } = { ready: false };
	/** draw.io's own shape sets, as each editor reported them last. */
	private readonly sets = new WeakMap<DrawioEditor, ShapeSetGroup[]>();
	/** Per editor: the newest read of the galleries' palettes (an older one that finishes later is dropped). */
	private readonly shapesSeq = new WeakMap<DrawioEditor, number>();
	/** Per editor: the palettes its page was given last (the same ones are not sent again: that would rebuild its sidebar). */
	private readonly sentPalettes = new WeakMap<DrawioEditor, string>();
	private palettesTimer: NodeJS.Timeout | undefined;
	/** What the page's other half posted last (tests read it; the panel gets it when it is open), and how many messages there were in all. */
	private posted: unknown[] = [];
	private postedTotal = 0;
	/** What the page was last told of the diagram's selection, and how often it was told (tests). */
	private selectionPosts = 0;
	private lastSelection: unknown;

	constructor(private readonly deps: WorkshopDeps) {
		const track = (d: vscode.Disposable | vscode.Disposable[]) => (Array.isArray(d) ? d : [d]).forEach((x) => this.dispose.track(x));
		this.dispose.track(deps.editorService.onEditorOpened.sub(({ editor }) => this.hookEditor(editor)));
		for (const editor of deps.editorService.openedEditors) this.hookEditor(editor);
		// The Workshop shows the diagram used last and its shape sets.
		this.dispose.track({
			dispose: autorun(() => {
				void this.deps.editorService.targetDrawioEditor;
				this.core?.postState();
				// (another diagram is the one used last: the Shape Shifter shows its selection)
				this.core?.postSelection();
			}),
		});
		this.dispose.track({
			dispose: () => {
				clearTimeout(this.palettesTimer);
				this.panel?.dispose();
				this.core?.dispose();
			},
		});
		// galleries switched in another VS Code window are taken over when this one is used again
		this.dispose.track(vscode.window.onDidChangeWindowState((w) => w.focused && this.reload()));

		const command = (id: string, run: (...args: any[]) => unknown) =>
			vscode.commands.registerCommand(id, async (...args: any[]) => {
				try {
					return await run(...args);
				} catch (e: any) {
					void vscode.window.showErrorMessage(`Draw.AI Shape Workshop: ${String(e?.message ?? e)}`);
					return { error: String(e?.message ?? e) };
				}
			});
		track([
			command("drawio-ai.shapeWorkshop", (mode?: unknown) => this.open(mode === "sets" ? "sets" : "gallery")),
			// Not in the command palette: for tests and automation.
			vscode.commands.registerCommand("drawio-ai.workshop.state", () => this.state()),
			vscode.commands.registerCommand("drawio-ai.workshop.message", (msg: unknown) => this.message(msg)),
			// (only a list: cleanGalleries gives the desktop app's defaults, switched on, for anything else)
			vscode.commands.registerCommand("drawio-ai.workshop.setGalleries", (list: unknown) => (Array.isArray(list) ? this.save(cleanGalleries(list)) : undefined)),
		]);
	}

	// ----- the galleries -----

	/**
	 * The galleries in use: read once from the extension's global state, changed here, written
	 * behind. (Right after a write, VS Code's state can still give an older value for a moment,
	 * so what was just saved is not read back from it.)
	 */
	private galleries: GalleryConfig[] | undefined;
	private savesPending = 0;

	private configs(): GalleryConfig[] {
		this.galleries ??= storedGalleries(this.deps.context.globalState.get(GALLERIES_KEY));
		return this.galleries;
	}

	private save(list: GalleryConfig[]): void {
		this.galleries = list;
		this.savesPending++;
		const done = () => void this.savesPending--;
		void this.deps.context.globalState.update(GALLERIES_KEY, list).then(done, done);
		this.galleriesChanged();
	}

	/** Takes over what another VS Code window saved, once nothing of this window's is still being written. */
	private reload(): void {
		if (this.savesPending) return;
		const stored = storedGalleries(this.deps.context.globalState.get(GALLERIES_KEY));
		if (JSON.stringify(stored) === JSON.stringify(this.configs())) return;
		this.galleries = stored;
		this.galleriesChanged();
	}

	/** Sends every open diagram its palettes again once the galleries have settled (a sync or a download reports often). */
	private palettesSoon(): void {
		clearTimeout(this.palettesTimer);
		this.palettesTimer = setTimeout(() => {
			for (const editor of this.deps.editorService.openedEditors) void this.sendShapes(editor);
		}, 500);
	}

	private galleriesChanged(): void {
		// every open diagram shows the galleries that are on
		for (const editor of this.deps.editorService.openedEditors) void this.sendShapes(editor);
		this.core?.postState();
	}

	private async runtime(): Promise<Runtime> {
		this.runtimePromise ??= import("./runtime");
		const rt = await this.runtimePromise;
		if (!this.service) {
			// indexes and downloaded shapes are cached in the extension's own storage folder
			this.service = new rt.GalleryService(this.deps.context.globalStorageUri.fsPath, rt.workshopFetch);
			this.service.onChange(() => {
				this.core?.postState();
				// what a gallery holds changed (a collection filled or emptied, a gallery synced): the diagrams' palettes follow
				this.palettesSoon();
			});
		}
		if (!this.core) {
			this.core = new rt.WorkshopCore({
				post: (msg) => this.post(msg),
				service: () => this.service!,
				configs: () => this.configs(),
				save: (list) => this.save(list),
				host: () => this.host(),
				look: () => {
					const look = this.deps.editorService.targetDrawioEditor?.config.look ?? cleanLook(vscode.workspace.getConfiguration("drawio-ai").get("look"));
					return { iconStyle: look.icons, matrix: look.matrix };
				},
				version: () => String(this.deps.context.extension.packageJSON.version ?? ""),
				confirm: async (message, detail, yes) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, yes)) === yes,
				pickLocal: async (kind) => {
					const folder = kind === "folder";
					const picked = await vscode.window.showOpenDialog({
						title: folder ? "Add a folder of SVG or PNG shapes" : "Add a draw.io library",
						canSelectFolders: folder,
						canSelectFiles: !folder,
						canSelectMany: false,
						filters: folder ? undefined : { "draw.io library": ["xml", "drawiolib"] },
						openLabel: "Add",
					});
					return picked?.[0] ? this.onDisk(picked[0], folder ? "That folder" : "That library") : undefined;
				},
				pickExport: async (name) => {
					// (a workspace folder's own address: in a remote workspace that is a remote one)
					const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
					const to = await vscode.window.showSaveDialog({
						title: "Export as a draw.io library",
						defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(nodePath.join(os.homedir(), name)),
						filters: { "draw.io library": ["xml"] },
					});
					return to ? this.onDisk(to, "That place") : undefined;
				},
				reveal: (file) => void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file)),
				openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
				// The Shape Shifter: find a shape by words (draw.io's own, and the galleries that are on), change the
				// selected shapes, import a Visio stencil. All of it works on the diagram used last, in its editor.
				shifter: true,
				pickStencil: async () => {
					const picked = await vscode.window.showOpenDialog({
						title: "Import a Visio stencil",
						canSelectFiles: true,
						canSelectFolders: false,
						canSelectMany: false,
						filters: { "Visio stencil": ["vssx", "vss", "vstx", "vsx"] },
						openLabel: "Import",
					});
					return picked?.[0] ? this.onDisk(picked[0], "That stencil") : undefined;
				},
				// Draw.AI sends nothing anywhere unasked: a gallery downloads only once the user has switched it on
				offStaysOff: true,
			});
		}
		return rt;
	}

	/**
	 * The path of a file or folder the user chose, when the extension can use it with Node's fs:
	 * on this computer, or on the remote machine when the extension runs there. Says so when not.
	 */
	private onDisk(uri: vscode.Uri, what: string): string | undefined {
		if (isOnDisk(uri, this.deps.context.extension.extensionKind === vscode.ExtensionKind.Workspace)) return uri.fsPath;
		void vscode.window.showWarningMessage(`Draw.AI Shape Workshop: ${what} is not on the machine Draw.AI runs on, so it cannot be used here.`);
		return undefined;
	}

	/** Where the Workshop puts shapes, and whose shape sets it shows: the diagram used last. */
	private host(): WorkshopHost | undefined {
		const editor = this.deps.editorService.targetDrawioEditor;
		if (!editor) return undefined;
		return {
			insert: async (shape) => {
				if (!editor.drawioClient.editorToolsLoaded) {
					throw new Error(`${fileName(editor)} cannot take shapes from the Workshop: it only shows the diagram, or the editor tools are off (setting Draw.AI › Look: Editor Tools).`);
				}
				editor.drawioClient.insertShape(shape);
				editor.webviewPanel.reveal(undefined, true);
				return fileName(editor);
			},
			diagramName: () => fileName(editor),
			shapeSets: () => this.sets.get(editor),
			// (draw.io keeps its shape sets in storage all diagrams share: every open one follows)
			setShapeSet: (id, on) => {
				for (const e of this.deps.editorService.openedEditors) e.drawioClient.setShapeSet(id, on);
			},
			refreshShapeSets: () => editor.drawioClient.reportShapeSets(),
			shifter: this.shifter(editor),
		};
	}

	/** The Shape Shifter's side (see ShifterHost in the Workshop's core): what it does in this diagram's editor. */
	private shifter(editor: DrawioEditor): NonNullable<WorkshopHost["shifter"]> {
		const client = editor.drawioClient;
		const tools = () => {
			if (!client.editorToolsLoaded) throw new Error(`${fileName(editor)} cannot be used by the Shape Shifter: it only shows the diagram, or the editor tools are off (setting Draw.AI › Look: Editor Tools).`);
		};
		return {
			searchBuiltIn: async (query, limit) => {
				tools();
				const rt = await this.runtime();
				const shapes = (await client.aiSearchShapes(query, limit, { previews: true, ownOnly: true })).shapes;
				// (a shape that is a picture names a file of draw.io's: the picture itself is its preview, read from the extension's own files)
				const webapp = vscode.Uri.joinPath(this.deps.context.extensionUri, "drawio/src/main/webapp").fsPath;
				for (const shape of shapes) {
					const picture = rt.webappPicture(rt.styleValue(shape.style, "image"), webapp);
					if (picture) shape.preview = picture;
				}
				return shapes;
			},
			// (the selected cells themselves, not what is inside a selected container or group)
			selectedCells: async () => {
				if (!client.editorToolsLoaded || client.currentSelection.length === 0) return [];
				const model = await client.aiGetModel({ scope: "selection", selectedOnly: true, includeStyles: true, maxCells: 2000 });
				return model.cells.filter((c) => c.selected === true).map((c) => ({ id: c.id, style: c.style ?? "", edge: c.kind === "edge" }));
			},
			// (one undo step, the user's own change: a pending AI review takes it as an edit made in the editor)
			applyStyles: async (edits) => {
				tools();
				const r = await client.aiApplyOps(
					edits.map((e) => ({ op: "update", id: e.id, styleProps: e.props })),
					{ selectResult: false, flash: false, atomic: true, review: false, user: true }
				);
				const failed = r.results.find((x) => !x.ok);
				if (failed || r.rolledBack) throw new Error(`The shapes could not be changed: ${failed?.error ?? "the change was rolled back"}`);
			},
			askAgent: async (request) => {
				if (!this.deps.askAgent) throw new Error("The Draw.AI agent is not available here.");
				await this.deps.askAgent(request, editor);
			},
			// (converted by the diagram's editor; the open diagram is not touched)
			convertStencil: async (file) => {
				tools();
				const stat = await fsp.stat(file);
				if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`${nodePath.basename(file)} is not a file, or is larger than 64 MB.`);
				const result = await client.importDiagram("visio", nodePath.basename(file), await fsp.readFile(file));
				if (!result.library) throw new Error(`${nodePath.basename(file)} is a Visio drawing, not a stencil. Open it with "Draw.io: Open Visio File as Draw.io…" to get its pages.`);
				return { library: result.library, warnings: result.warnings };
			},
		};
	}

	// ----- the editor's side -----

	private hookEditor(editor: DrawioEditor): void {
		const client = editor.drawioClient;
		const subs = [
			// the Shape Shifter shows what is selected in the diagram used last, as it changes
			client.onSelectedCellsChanged.sub(() => {
				if (this.panel && this.deps.editorService.targetDrawioEditor === editor) this.core?.postSelection();
			}),
			// the Workshop button in the toolbar, and "+ More Shapes" under the shapes sidebar
			client.onEditorCommand.sub(({ command }) => {
				if (command === "workshop") void vscode.commands.executeCommand("drawio-ai.shapeWorkshop");
				else if (command === "shapeSets") void vscode.commands.executeCommand("drawio-ai.shapeWorkshop", "sets");
			}),
			client.onShapeSets.sub(({ groups }) => {
				this.sets.set(editor, cleanShapeSets(groups));
				if (editor === this.deps.editorService.targetDrawioEditor) this.core?.postState();
			}),
			client.onGallerySearch.sub(({ reqId, query, limit }) => void this.gallerySearch(editor, reqId, query, limit)),
			// a page that has just loaded has no palettes yet
			client.onEditorToolsLoaded.sub(() => {
				this.sentPalettes.delete(editor);
				void this.sendShapes(editor);
			}),
		];
		editor.webviewPanel.onDidDispose(() => subs.forEach((s) => s.dispose()));
		if (client.editorToolsLoaded) void this.sendShapes(editor);
	}

	/** draw.io's own search in the shapes sidebar also finds the shapes of the galleries that are on. */
	private async gallerySearch(editor: DrawioEditor, reqId: number, query: string, limit: number): Promise<void> {
		let shapes: DesktopShape[] = [];
		try {
			if (anyGalleryOn(this.configs())) {
				const rt = await this.runtime();
				shapes = await rt.searchForEditor(this.service!, this.configs(), query.slice(0, 200), Math.max(1, Math.min(48, limit)));
			}
		} catch {
			shapes = []; // draw.io's own results show either way
		}
		if (this.deps.editorService.openedEditors.has(editor)) editor.drawioClient.galleryResults(reqId, shapes);
	}

	/** Each gallery that is on: a first page as a palette in the shapes sidebar (the rest is found by search). */
	private async sendShapes(editor: DrawioEditor): Promise<void> {
		const seq = (this.shapesSeq.get(editor) ?? 0) + 1;
		this.shapesSeq.set(editor, seq);
		const libraries: unknown[] = [];
		if (anyGalleryOn(this.configs())) {
			const rt = await this.runtime();
			for (const g of this.configs().filter((x) => x.enabled)) {
				try {
					const palette = await rt.galleryPalette(this.service!, g);
					if (palette) libraries.push(palette);
				} catch {
					// a gallery that cannot be read now is left out; the Workshop says why
				}
			}
		}
		if (seq !== this.shapesSeq.get(editor) || !this.deps.editorService.openedEditors.has(editor) || !editor.drawioClient.editorToolsLoaded) return;
		// (a page that has just loaded has none: nothing to tell it while there are none to show)
		const next = JSON.stringify(libraries);
		if ((this.sentPalettes.get(editor) ?? "[]") === next) return;
		this.sentPalettes.set(editor, next);
		editor.drawioClient.setShapes(libraries);
	}

	// ----- the Workshop panel -----

	private post(msg: unknown): void {
		this.posted.push(msg);
		this.postedTotal++;
		if ((msg as { type?: unknown })?.type === "selection") {
			this.selectionPosts++;
			this.lastSelection = msg;
		}
		if (this.posted.length > 60) this.posted.splice(0, this.posted.length - 60);
		// (a closed panel has no webview to post to)
		if (this.panel) void this.panel.webview.postMessage(msg);
	}

	private async open(mode: "gallery" | "sets"): Promise<void> {
		this.reload();
		if (this.panel) {
			this.panel.reveal();
			this.post({ type: "mode", mode });
			return;
		}
		// (the Workshop loads on first use: a second click meanwhile must not open a second panel)
		if (this.opening) return;
		this.opening = true;
		try {
			await this.runtime();
			const core = this.core!;
			const omni = vscode.Uri.joinPath(this.deps.context.extensionUri, OMNI_DIR);
			const template = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(omni, WORKSHOP_PAGE))).toString("utf8");
			const panel = vscode.window.createWebviewPanel("drawio-ai.workshop", "Shape Workshop", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [omni] });
			this.panel = panel;
			this.page = { ready: false };
			const page = this.page;
			const received = panel.webview.onDidReceiveMessage((msg) => {
				if (msg?.type === "pageLoaded") {
					page.loaded = msg;
					return;
				}
				if (msg?.type === "ready") page.ready = true;
				void core.onMessage(msg).then(
					() => {
						if (msg?.type === "ready" && mode === "sets") this.post({ type: "mode", mode });
					},
					(e) => this.post({ type: "error", message: String(e?.message ?? e) })
				);
			});
			// the sidebar can change in the editor itself (the Scratchpad's ✕, a set enabled from a search): ask again
			const focused = panel.onDidChangeViewState(() => {
				if (!panel.active) return;
				this.host()?.refreshShapeSets();
				this.core?.postSelection();
			});
			panel.onDidDispose(() => {
				received.dispose();
				focused.dispose();
				if (this.panel === panel) this.panel = undefined;
			});
			panel.webview.html = workshopPageHtml(template, {
				nonce: pageNonce((n) => randomBytes(n)),
				cspSource: panel.webview.cspSource,
				base: panel.webview.asWebviewUri(omni).toString(),
			});
		} finally {
			this.opening = false;
		}
	}

	// ----- for tests and automation -----

	/** A message as the Workshop's page would send it; answers with what the page was told meanwhile. */
	private async message(msg: unknown): Promise<{ posted: unknown[]; error?: string }> {
		await this.runtime();
		const from = this.postedTotal;
		// (only the last messages are kept: what came since is at the end of them)
		const since = () => this.posted.slice(Math.max(0, this.posted.length - (this.postedTotal - from)));
		try {
			await this.core!.onMessage(msg);
			return { posted: since() };
		} catch (e: any) {
			return { posted: since(), error: String(e?.message ?? e) };
		}
	}

	private async state() {
		await this.runtime();
		const editor = this.deps.editorService.targetDrawioEditor;
		return {
			galleries: this.service!.status(this.configs()),
			dataDir: this.deps.context.globalStorageUri.fsPath,
			target: editor?.uri.fsPath,
			sets: editor ? this.sets.get(editor) : undefined,
			panelOpen: !!this.panel,
			panelPage: this.panel ? this.page : undefined,
			shifter: !!this.host()?.shifter,
			selectionPosts: this.selectionPosts,
			lastSelection: this.lastSelection,
		};
	}
}

function fileName(editor: DrawioEditor): string {
	return fileNameOf(editor.uri);
}
