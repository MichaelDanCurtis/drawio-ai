import { EventEmitter } from "@hediet/std/events";
import { BufferImpl } from "../utils/buffer";
import { DrawioClient } from "./DrawioClient";

export interface VsdxExport {
	data: BufferImpl;
	pages: number;
	shapes: number;
	connectors: number;
	images: number;
	/** Things that did not carry over (hidden layers, images that could not be loaded). */
	warnings: string[];
}

export interface PdfExport {
	data: BufferImpl;
	pages: number;
	/** Pages that were left out because they are empty. */
	warnings: string[];
}

export type DiagramImportFormat = AiImportDiagramAction["format"];

export interface DiagramImport {
	/** An uncompressed <mxfile>. */
	xml: string;
	/** "stencil" when a Visio stencil's shapes were laid out on a page. */
	kind: "diagram" | "stencil";
	/** A stencil as a draw.io library (`<mxlibrary>[…]</mxlibrary>`). */
	library?: string;
	pages: number;
	shapes: number;
	connectors: number;
	/** What did not carry over (unmapped shapes, unreadable parts, linked images). */
	warnings: string[];
}

/**
 * Enhances the drawio client with custom events and methods.
 * They require modifications of the official drawio source or plugins.
 */
export class CustomizedDrawioClient extends DrawioClient<
	CustomDrawioAction,
	CustomDrawioEvent
> {
	private readonly onNodeSelectedEmitter = new EventEmitter<{
		label: string;
		linkedData: unknown;
	}>();
	public readonly onNodeSelected = this.onNodeSelectedEmitter.asEvent();

	private readonly onCustomPluginLoadedEmitter = new EventEmitter<{
		pluginId: string;
	}>();
	public readonly onCustomPluginLoaded =
		this.onCustomPluginLoadedEmitter.asEvent();

	private readonly onCursorChangeEmitter = new EventEmitter<{
		newPosition: Point | undefined;
	}>();
	public readonly onCursorChanged = this.onCursorChangeEmitter.asEvent();

	private readonly onSelectedCellsChangedEmitter = new EventEmitter<{
		selectedCellIds: string[];
	}>();
	public readonly onSelectedCellsChanged =
		this.onSelectedCellsChangedEmitter.asEvent();

	private readonly onSelectedRectangleChangedEmitter = new EventEmitter<{
		rectangle: { start: Point; end: Point } | undefined;
	}>();
	public readonly onSelectedRectangleChanged =
		this.onSelectedRectangleChangedEmitter.asEvent();

	/** The page that is shown (its id), reported while diff sync is on: at once, and when another page is shown. */
	private readonly onLivePageEmitter = new EventEmitter<{ page: string }>();
	public readonly onLivePage = this.onLivePageEmitter.asEvent();

	private readonly onFocusChangedEmitter = new EventEmitter<{
		hasFocus: boolean;
	}>();
	public readonly onFocusChanged = this.onFocusChangedEmitter.asEvent();

	private readonly onInvokeCommandEmitter = new EventEmitter<{
		command: InvokeCommandEvent["command"];
	}>();
	public readonly onInvokeCommand = this.onInvokeCommandEmitter.asEvent();

	private readonly onAiAskEmitter = new EventEmitter<AiAskEvent>();
	/** The user submitted a prompt from inside the diagram. */
	public readonly onAiAsk = this.onAiAskEmitter.asEvent();

	private readonly onAiLassoEmitter = new EventEmitter<AiLassoEvent>();
	public readonly onAiLasso = this.onAiLassoEmitter.asEvent();

	private readonly onAiBadgeClickEmitter = new EventEmitter<AiBadgeClickEvent>();
	public readonly onAiBadgeClick = this.onAiBadgeClickEmitter.asEvent();

	private readonly onAiMarkupEmitter = new EventEmitter<AiMarkupEvent>();
	public readonly onAiMarkup = this.onAiMarkupEmitter.asEvent();

	private readonly onAiReviewEmitter = new EventEmitter<AiReviewEvent>();
	/** The set of pending AI changes awaiting the user's review changed. */
	public readonly onAiReview = this.onAiReviewEmitter.asEvent();

	private latestReview: AiReviewEvent | undefined;
	public get pendingReview(): AiReviewEvent | undefined {
		return this.latestReview?.pending ? this.latestReview : undefined;
	}

	public aiResolveReview(decision: "accept" | "reject", cellIds?: string[]): void {
		this.sendCustomAction({ action: "aiResolveReview", decision, cellIds });
	}

	private readonly onEditorCommandEmitter = new EventEmitter<{ command: string }>();
	/** A button or key of the editor tools shared with the desktop app ("present", "exitPresentation", "settings"). */
	public readonly onEditorCommand = this.onEditorCommandEmitter.asEvent();

	/** Changes icons, the matrix or the toolbar's place in the open editor. */
	public setEditorPrefs(prefs: { iconStyle?: string; toolbar?: string; matrix?: string }): void {
		this.sendCustomAction({ action: "desktopPrefs", ...prefs });
	}

	public setPresenting(enabled: boolean): void {
		this.sendCustomAction({ action: "desktopPresentation", enabled });
	}

	/** Gives presentation mode the diagram's map tours; `start` plays the first one on the page shown. */
	public setPresentationTours(tours: DesktopPresentationToursAction["tours"], start: boolean): void {
		this.sendCustomAction({ action: "desktopPresentationTours", tours, start });
	}

	// ----- the Shape Workshop's side of the editor -----

	private readonly onShapeSetsEmitter = new EventEmitter<{ groups: unknown[] }>();
	/** draw.io's own shape sets and which are shown, as the page reports them (when it loads, and when they change). */
	public readonly onShapeSets = this.onShapeSetsEmitter.asEvent();

	private readonly onGallerySearchEmitter = new EventEmitter<{ reqId: number; query: string; limit: number }>();
	/** draw.io's sidebar search asks for gallery shapes: answer with galleryResults (it waits 2.5 s at most). */
	public readonly onGallerySearch = this.onGallerySearchEmitter.asEvent();

	/** The palettes the host adds to the shapes sidebar (each call replaces the last). */
	public setShapes(libraries: unknown[]): void {
		this.sendCustomAction({ action: "desktopShapes", libraries });
	}

	private insertSeq = 0;
	/** Puts a shape in the middle of the view, selected. */
	public insertShape(shape: DesktopShape): void {
		// (the page can see a message twice; the sequence number makes it insert once)
		this.sendCustomAction({ action: "desktopInsertShape", shape, seq: ++this.insertSeq });
	}

	public reportShapeSets(): void {
		this.sendCustomAction({ action: "desktopReportShapeSets" });
	}

	public setShapeSet(id: string, on: boolean): void {
		this.sendCustomAction({ action: "desktopSetShapeSet", id, on });
	}

	public galleryResults(reqId: number, shapes: DesktopShape[]): void {
		this.sendCustomAction({ action: "desktopGalleryResults", reqId, shapes });
	}

	private lookState: DesktopLookState | undefined;
	private lookStateRequest = 0;
	private readonly lookStateWaiters = new Map<number, (state: DesktopLookState) => void>();

	private readonly onEditorToolsLoadedEmitter = new EventEmitter<{ state: DesktopLookState }>();
	/** The editor tools have loaded in the editor's page (again after each time the page loads). */
	public readonly onEditorToolsLoaded = this.onEditorToolsLoadedEmitter.asEvent();

	/** True once the editor tools have loaded in this editor's page. */
	public get editorToolsLoaded(): boolean {
		return this.lookState !== undefined;
	}

	/**
	 * What the editor tools show now; undefined when they are not loaded (turned off, a
	 * read-only editor, a page still loading) or do not answer in time.
	 */
	public async editorLookState(timeoutMs = 3000): Promise<DesktopLookState | undefined> {
		if (!this.editorToolsLoaded) {
			return undefined;
		}
		// (the page gets every message twice and answers twice: the answer names its request)
		const reqId = ++this.lookStateRequest;
		const answer = new Promise<DesktopLookState>((resolve) => this.lookStateWaiters.set(reqId, resolve));
		this.sendCustomAction({ action: "desktopReportState", reqId });
		try {
			return await withTimeout(answer, timeoutMs, "The editor tools did not answer.");
		} catch {
			return undefined;
		} finally {
			this.lookStateWaiters.delete(reqId);
		}
	}

	private selectedCellIds: string[] = [];
	public get currentSelection(): readonly string[] {
		return this.selectedCellIds;
	}

	private aiPluginLoaded = false;
	private readonly aiPluginWaiters: (() => void)[] = [];

	private whenAiPluginLoaded(): Promise<void> {
		if (this.aiPluginLoaded) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.aiPluginWaiters.push(resolve));
	}

	/** Resolves true once draw.io and the AI plugin have loaded, false after the timeout. */
	public whenLoaded(timeoutMs: number): Promise<boolean> {
		return withTimeout(this.whenAiPluginLoaded().then(() => true), timeoutMs, "").catch(() => false);
	}

	/** A lost message (e.g. the webview reloaded) must fail the tool call instead of hanging the agent. */
	private async aiRequest(
		action: CustomDrawioAction,
		timeoutMs = 30_000
	): Promise<CustomDrawioEvent> {
		await withTimeout(
			this.whenAiPluginLoaded(),
			30_000,
			"The draw.io editor is still loading. Try again in a moment."
		);
		return withTimeout(
			this.sendCustomActionExpectResponse(action),
			timeoutMs,
			`draw.io did not answer "${action.action}" within ${timeoutMs / 1000}s. The editor may have been reloaded; try again.`
		);
	}

	public async aiGetModel(options: {
		scope: "page" | "selection";
		includeStyles: boolean;
		maxCells: number;
		/** Id or name of another page to read; the editor stays on its page. */
		page?: string;
		/** With scope "selection": only the selected cells themselves. */
		selectedOnly?: boolean;
	}): Promise<AiDiagramModel> {
		const response = await this.aiRequest({
			action: "aiGetModel",
			...options,
		});
		if (response.event !== "aiModel") {
			throw new Error("Invalid Response");
		}
		if (response.error) {
			throw new Error(response.error);
		}
		return response.model;
	}

	/** Lists or changes the diagram's pages (drawio_pages). */
	public async aiPages(request: Omit<AiPagesAction, "action">): Promise<AiPagesEvent> {
		const response = await this.aiRequest({ action: "aiPages", ...request });
		if (response.event !== "aiPages") {
			throw new Error("Invalid Response");
		}
		return response;
	}

	public async aiApplyOps(
		ops: AiOp[],
		/**
		 * `user`: the user's own change through the host's UI, not an AI change (see AiApplyOpsAction).
		 * `page`: only while this page (its id) is the one shown; every operation fails on another.
		 */
		options: { selectResult: boolean; flash: boolean; atomic: boolean; review: boolean; user?: boolean; animate?: boolean; page?: string }
	): Promise<{
		results: AiOpResult[];
		idMap: Record<string, string>;
		rolledBack: boolean;
		/** The id of the page the batch was applied on. */
		page?: string;
	}> {
		const response = await this.aiRequest(
			{ action: "aiApplyOps", ops, ...options },
			120_000
		);
		if (response.event !== "aiApplyOpsResult") {
			throw new Error("Invalid Response");
		}
		return response;
	}

	public async aiSetSelection(cellIds: string[], reveal: boolean): Promise<void> {
		await this.aiRequest({
			action: "aiSetSelection",
			cellIds,
			reveal,
		});
	}

	public aiSetLassoMode(enabled: boolean): void {
		this.sendCustomAction({ action: "aiSetLassoMode", enabled });
	}

	public aiSetBadges(group: string, badges: AiBadge[]): void {
		this.sendCustomAction({ action: "aiSetBadges", group, badges });
	}

	public get isAiPluginLoaded(): boolean {
		return this.aiPluginLoaded;
	}

	public aiSetMarkupMode(enabled: boolean): void {
		this.sendCustomAction({ action: "aiSetMarkupMode", enabled });
	}

	public aiSetStatus(busy: boolean, text?: string): void {
		this.sendCustomAction({ action: "aiSetStatus", busy, text });
	}

	public aiOpenPrompt(): void {
		this.sendCustomAction({ action: "aiOpenPrompt" });
	}

	/** Returns a PNG data URL, or undefined if the diagram cannot be rendered. */
	public async aiExportImage(
		cellIds: string[],
		maxSize: number
	): Promise<string | undefined> {
		const response = await this.aiRequest({
			action: "aiExportImage",
			cellIds,
			maxSize,
		});
		if (response.event !== "aiExportImage") {
			throw new Error("Invalid Response");
		}
		return response.dataUrl || undefined;
	}

	/** Exports the diagram as a PDF, one PDF page per draw.io page (or only the visible one). */
	public async exportPdf(options: { currentPageOnly?: boolean; title?: string } = {}): Promise<PdfExport> {
		const response = await this.aiRequest(
			{ action: "aiExportPdf", currentPageOnly: !!options.currentPageOnly, title: options.title },
			120_000
		);
		if (response.event !== "aiExportPdf") {
			throw new Error("Invalid Response");
		}
		if (response.error || !response.data) {
			throw new Error(`PDF export failed: ${response.error ?? "no data"}`);
		}
		return { data: BufferImpl.from(response.data, "base64"), pages: response.pages, warnings: response.warnings };
	}

	/** Exports the diagram as a Microsoft Visio (.vsdx) file. */
	public async exportVsdx(options: { currentPageOnly?: boolean } = {}): Promise<VsdxExport> {
		const response = await this.aiRequest(
			{ action: "aiExportVsdx", currentPageOnly: !!options.currentPageOnly },
			120_000
		);
		if (response.event !== "aiExportVsdx") {
			throw new Error("Invalid Response");
		}
		if (response.error || !response.data) {
			throw new Error(`Visio export failed: ${response.error ?? "no data"}`);
		}
		const { pages, shapes, connectors, images, warnings } = response;
		return { data: BufferImpl.from(response.data, "base64"), pages, shapes, connectors, images, warnings };
	}

	/**
	 * Converts a file from another tool (Visio, Gliffy, GraphML, Lucidchart) with
	 * draw.io's own importers, inside this webview. The open diagram is not touched.
	 */
	public async importDiagram(format: DiagramImportFormat, fileName: string, data: Uint8Array): Promise<DiagramImport> {
		const response = await this.aiRequest(
			{ action: "aiImportDiagram", format, fileName, data: BufferImpl.from(data).toString("base64") },
			120_000
		);
		if (response.event !== "aiImportDiagram") {
			throw new Error("Invalid Response");
		}
		if (response.error || !response.xml) {
			throw new Error(response.error ?? "draw.io returned no diagram.");
		}
		const { xml, kind, library, pages, shapes, connectors, warnings } = response;
		return { xml, kind, library, pages, shapes, connectors, warnings };
	}

	public async aiSearchShapes(
		query: string,
		limit: number,
		/** `previews`: each shape with its thumbnail; `ownOnly`: only draw.io's own shapes (see AiSearchShapesAction). */
		options: { previews?: boolean; ownOnly?: boolean } = {}
	): Promise<{ shapes: AiShapeTemplate[]; error?: string }> {
		const response = await this.aiRequest({
			action: "aiSearchShapes",
			query,
			limit,
			...(options.previews ? { previews: true } : {}),
			...(options.ownOnly ? { ownOnly: true } : {}),
		});
		if (response.event !== "aiSearchShapes") {
			throw new Error("Invalid Response");
		}
		return { shapes: response.shapes, error: response.error };
	}

	public linkSelectedNodeWithData(linkedData: unknown) {
		this.sendCustomAction({
			action: "linkSelectedNodeWithData",
			linkedData,
		});
	}

	public async getVertices(): Promise<{ id: string; label: string }[]> {
		const response = await this.sendCustomActionExpectResponse({
			action: "getVertices",
		});
		if (response.event !== "getVertices") {
			throw new Error("Invalid Response");
		}

		return response.vertices;
	}

	/**
	 * Turns draw.io's diff sync on or off for the open diagram (see DrawioClient.resetDiff, to
	 * be called next when turning it on). While it is on, changes arrive on onPatch.
	 */
	public setDiffSync(on: boolean): void {
		this.sendCustomAction({ action: "setDiffSync", on });
	}

	/**
	 * Stops the user from changing the diagram, or lets them again, for the moment a shared
	 * diagram is put in place of the open one. Resolves when the editor says the lock has taken
	 * hold (or been lifted): changes reported on onPatch before that were the user's. An editor
	 * that does not answer (an old page) is not waited for beyond `timeoutMs`.
	 */
	public async liveLock(on: boolean, timeoutMs = 3000): Promise<void> {
		await withTimeout(this.sendCustomActionExpectResponse({ action: "liveLock", on }), timeoutMs, "").catch(() => undefined);
	}

	public setNodeSelectionEnabled(enabled: boolean): void {
		this.sendCustomAction({
			action: "setNodeSelectionEnabled",
			enabled,
		});
	}

	public updateVertices(verticesToUpdate: { id: string; label: string }[]) {
		this.sendCustomAction({
			action: "updateVertices",
			verticesToUpdate,
		});
	}

	public addVertices(vertices: { label: string }[]) {
		this.sendCustomAction({
			action: "addVertices",
			vertices,
		});
	}

	public updateLiveshareViewState(update: {
		cursors: ParticipantCursorInfo[];
		selectedCells: ParticipantSelectedCellsInfo[];
		selectedRectangles: ParticipantSelectedRectangleInfo[];
	}) {
		this.sendCustomAction({
			action: "updateLiveshareViewState",
			...update,
		});
	}

	protected async handleEvent(evt: CustomDrawioEvent): Promise<void> {
		// The shared editor tools' messages. They are not consumed here: the desktop app,
		// which uses this client too, takes them from onUnknownMessage (see the end).
		if (evt.event === "desktopCommand") {
			if (typeof evt.command === "string") {
				this.onEditorCommandEmitter.emit({ command: evt.command });
			}
		} else if (evt.event === "desktopShapeSets") {
			if (Array.isArray(evt.groups)) {
				this.onShapeSetsEmitter.emit({ groups: evt.groups });
			}
		} else if (evt.event === "desktopGallerySearch") {
			if (typeof evt.query === "string" && typeof evt.reqId === "number") {
				this.onGallerySearchEmitter.emit({ reqId: evt.reqId, query: evt.query, limit: Number(evt.limit) || 24 });
			}
		} else if (evt.event === "desktopState") {
			if (evt.state && typeof evt.state === "object") {
				this.lookState = evt.state;
				if (evt.loaded) {
					this.onEditorToolsLoadedEmitter.emit({ state: evt.state });
				} else if (typeof evt.reqId === "number") {
					this.lookStateWaiters.get(evt.reqId)?.(evt.state);
				}
			}
		}

		if (evt.event === "nodeSelected") {
			this.onNodeSelectedEmitter.emit({
				label: evt.label,
				linkedData: evt.linkedData,
			});
		} else if (evt.event === "pluginLoaded") {
			if (evt.pluginId === "ai") {
				// A page has loaded. The editor tools load after this plugin and report
				// themselves then: until they do, this page has none.
				this.lookState = undefined;
				this.aiPluginLoaded = true;
				this.latestReview = undefined;
				this.aiPluginWaiters.splice(0).forEach((resolve) => resolve());
			}
			this.onCustomPluginLoadedEmitter.emit({ pluginId: evt.pluginId });
		} else if (evt.event === "focusChanged") {
			this.onFocusChangedEmitter.emit({ hasFocus: evt.hasFocus });
		} else if (evt.event === "cursorChanged") {
			this.onCursorChangeEmitter.emit({ newPosition: evt.position });
		} else if (evt.event === "selectedCellsChanged") {
			this.selectedCellIds = evt.selectedCellIds;
			this.onSelectedCellsChangedEmitter.emit({
				selectedCellIds: evt.selectedCellIds,
			});
		} else if (evt.event === "aiAsk") {
			this.onAiAskEmitter.emit(evt);
		} else if (evt.event === "aiLasso") {
			this.onAiLassoEmitter.emit(evt);
		} else if (evt.event === "aiBadgeClick") {
			this.onAiBadgeClickEmitter.emit(evt);
		} else if (evt.event === "aiMarkup") {
			this.onAiMarkupEmitter.emit(evt);
		} else if (evt.event === "aiReview") {
			this.latestReview = evt;
			this.onAiReviewEmitter.emit(evt);
		} else if (evt.event === "invokeCommand") {
			this.onInvokeCommandEmitter.emit({ command: evt.command });

		} else if (evt.event === "livePage") {
			this.onLivePageEmitter.emit({ page: String(evt.page ?? "") });
		} else if (evt.event === "selectedRectangleChanged") {
			this.onSelectedRectangleChangedEmitter.emit({
				rectangle: evt.rect,
			});
		} else {
			await super.handleEvent(evt);
		}
	}
}

interface Point {
	x: number;
	y: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
