import { EventEmitter } from "@hediet/std/events";
import { DrawioClient } from "./DrawioClient";

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
	}): Promise<AiDiagramModel> {
		const response = await this.aiRequest({
			action: "aiGetModel",
			...options,
		});
		if (response.event !== "aiModel") {
			throw new Error("Invalid Response");
		}
		return response.model;
	}

	public async aiApplyOps(
		ops: AiOp[],
		options: { selectResult: boolean; flash: boolean; atomic: boolean; review: boolean }
	): Promise<{
		results: AiOpResult[];
		idMap: Record<string, string>;
		rolledBack: boolean;
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

	public async aiSearchShapes(
		query: string,
		limit: number
	): Promise<{ shapes: AiShapeTemplate[]; error?: string }> {
		const response = await this.aiRequest({
			action: "aiSearchShapes",
			query,
			limit,
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
		if (evt.event === "nodeSelected") {
			this.onNodeSelectedEmitter.emit({
				label: evt.label,
				linkedData: evt.linkedData,
			});
		} else if (evt.event === "pluginLoaded") {
			if (evt.pluginId === "ai") {
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
		} else if (evt.event === "aiReview") {
			this.latestReview = evt;
			this.onAiReviewEmitter.emit(evt);
		} else if (evt.event === "invokeCommand") {
			this.onInvokeCommandEmitter.emit({ command: evt.command });
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
