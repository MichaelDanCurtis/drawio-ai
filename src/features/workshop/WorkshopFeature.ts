import * as vscode from "vscode";
import * as nodePath from "path";
import * as os from "os";
import { randomBytes } from "crypto";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import { cleanShapeSets, ShapeSetGroup } from "../../../standalone/src/main/shapeSets";
import type { WorkshopCore, WorkshopHost } from "../../../standalone/src/main/workshop/core";
import type { GalleryService } from "../../../standalone/src/main/workshop/galleries";
import { cleanGalleries, GalleryConfig } from "../../../standalone/src/main/workshop/types";
import { cleanLook, OMNI_DIR } from "../editorLook";
import { pageNonce } from "../omniPage";
import { anyGalleryOn, GALLERIES_KEY, storedGalleries } from "./galleryStore";
import { WORKSHOP_PAGE, workshopPageHtml } from "./workshopPage";

type Runtime = typeof import("./runtime");

export interface WorkshopDeps {
	context: vscode.ExtensionContext;
	editorService: DrawioEditorService;
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
	/** Editors that were given palettes: they are told when there are none any more. */
	private readonly hasPalettes = new WeakSet<DrawioEditor>();
	/** What the page's other half posted last (tests read it; the panel gets it when it is open). */
	private posted: unknown[] = [];

	constructor(private readonly deps: WorkshopDeps) {
		const track = (d: vscode.Disposable | vscode.Disposable[]) => (Array.isArray(d) ? d : [d]).forEach((x) => this.dispose.track(x));
		this.dispose.track(deps.editorService.onEditorOpened.sub(({ editor }) => this.hookEditor(editor)));
		for (const editor of deps.editorService.openedEditors) this.hookEditor(editor);
		// The Workshop shows the diagram used last and its shape sets.
		this.dispose.track({
			dispose: autorun(() => {
				void this.deps.editorService.targetDrawioEditor;
				this.core?.postState();
			}),
		});
		this.dispose.track({
			dispose: () => {
				this.panel?.dispose();
				this.core?.dispose();
			},
		});

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
			vscode.commands.registerCommand("drawio-ai.workshop.setGalleries", (list: unknown) => this.save(cleanGalleries(list))),
		]);
	}

	// ----- the galleries -----

	private configs(): GalleryConfig[] {
		return storedGalleries(this.deps.context.globalState.get(GALLERIES_KEY));
	}

	private save(list: GalleryConfig[]): void {
		void this.deps.context.globalState.update(GALLERIES_KEY, list).then(() => {
			// every open diagram shows the galleries that are on
			for (const editor of this.deps.editorService.openedEditors) void this.sendShapes(editor);
			this.core?.postState();
		});
	}

	private async runtime(): Promise<Runtime> {
		this.runtimePromise ??= import("./runtime");
		const rt = await this.runtimePromise;
		if (!this.service) {
			// indexes and downloaded shapes are cached in the extension's own storage folder
			this.service = new rt.GalleryService(this.deps.context.globalStorageUri.fsPath, rt.workshopFetch);
			this.service.onChange(() => this.core?.postState());
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
					return picked?.[0]?.scheme === "file" ? picked[0].fsPath : undefined;
				},
				pickExport: async (name) => {
					const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file")?.uri.fsPath ?? os.homedir();
					const to = await vscode.window.showSaveDialog({ title: "Export as a draw.io library", defaultUri: vscode.Uri.file(nodePath.join(folder, name)), filters: { "draw.io library": ["xml"] } });
					return to?.scheme === "file" ? to.fsPath : undefined;
				},
				reveal: (file) => void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file)),
				openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
			});
		}
		return rt;
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
		};
	}

	// ----- the editor's side -----

	private hookEditor(editor: DrawioEditor): void {
		const client = editor.drawioClient;
		const subs = [
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
				this.hasPalettes.delete(editor);
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
			if (anyGalleryOn(this.deps.context.globalState.get(GALLERIES_KEY))) {
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
		if (anyGalleryOn(this.deps.context.globalState.get(GALLERIES_KEY))) {
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
		if (!libraries.length && !this.hasPalettes.has(editor)) return;
		if (libraries.length) this.hasPalettes.add(editor);
		else this.hasPalettes.delete(editor);
		editor.drawioClient.setShapes(libraries);
	}

	// ----- the Workshop panel -----

	private post(msg: unknown): void {
		this.posted.push(msg);
		if (this.posted.length > 60) this.posted.splice(0, this.posted.length - 60);
		// (a closed panel has no webview to post to)
		if (this.panel) void this.panel.webview.postMessage(msg);
	}

	private async open(mode: "gallery" | "sets"): Promise<void> {
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
			const focused = panel.onDidChangeViewState(() => panel.active && this.host()?.refreshShapeSets());
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
		const from = this.posted.length;
		try {
			await this.core!.onMessage(msg);
			return { posted: this.posted.slice(from) };
		} catch (e: any) {
			return { posted: this.posted.slice(from), error: String(e?.message ?? e) };
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
		};
	}
}

function fileName(editor: DrawioEditor): string {
	return decodeURIComponent(editor.uri.path.split("/").pop() ?? "");
}
