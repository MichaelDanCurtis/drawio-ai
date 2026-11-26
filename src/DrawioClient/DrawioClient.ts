import { EventEmitter } from "@hediet/std/events";
import { Disposable } from "@hediet/std/disposable";
import {
	DrawioConfig,
	DrawioEvent,
	DrawioAction,
	DrawioExportTheme,
} from "./DrawioTypes";
import { BufferImpl } from "../utils/buffer";

/** draw.io's checksum of a diagram (a number, from its hash of the pages), as text. */
function checksumText(value: unknown): string | undefined {
	return typeof value === "number" || (typeof value === "string" && value !== "")
		? String(value)
		: undefined;
}

/**
 * Represents a connection to an drawio iframe.
 */
export class DrawioClient<
	TCustomAction extends {} = never,
	TCustomEvent extends {} = never
> {
	public readonly dispose = Disposable.fn();

	private readonly onInitEmitter = new EventEmitter();
	public readonly onInit = this.onInitEmitter.asEvent();

	protected readonly onChangeEmitter =
		new EventEmitter<DrawioDocumentChange>();
	public readonly onChange = this.onChangeEmitter.asEvent();

	private readonly onSaveEmitter = new EventEmitter();
	public readonly onSave = this.onSaveEmitter.asEvent();

	/**
	 * With diff sync on (see resetDiff): each change the user makes, as draw.io's own patch
	 * (cells added, changed, removed, keyed by id) and the checksum of the diagram after it.
	 * Changes applied with applyPatch are not reported back here.
	 */
	private readonly onPatchEmitter = new EventEmitter<{
		patch: Record<string, unknown>;
		checksum: string;
	}>();
	public readonly onPatch = this.onPatchEmitter.asEvent();

	private readonly onUnknownMessageEmitter = new EventEmitter<{
		message: TCustomEvent;
	}>();
	public readonly onUnknownMessage = this.onUnknownMessageEmitter.asEvent();

	// This is always up to date, except directly after calling load.
	private currentXml: string | undefined = undefined;

	private isMerging = false;

	constructor(
		private readonly messageStream: MessageStream,
		private readonly getConfig: () => Promise<DrawioConfig>,
		public readonly reloadWebview: () => void,
		private readonly getSvgTheme: () => DrawioExportTheme
	) {
		this.dispose.track(
			messageStream.registerMessageHandler((msg) =>
				this.handleEvent(JSON.parse(msg as string) as DrawioEvent)
			)
		);
	}

	private currentActionId = 0;
	private responseHandlers = new Map<
		string,
		{ resolve: (response: DrawioEvent) => void; reject: () => void }
	>();

	protected sendCustomAction(action: TCustomAction): void {
		this.sendAction(action);
	}

	protected sendCustomActionExpectResponse(
		action: TCustomAction
	): Promise<TCustomEvent> {
		return this.sendActionWaitForResponse(action);
	}

	private sendAction(action: DrawioAction | TCustomAction) {
		this.messageStream.sendMessage(JSON.stringify(action));
	}

	private sendActionWaitForResponse(
		action: DrawioAction
	): Promise<DrawioEvent>;
	private sendActionWaitForResponse(
		action: TCustomAction
	): Promise<TCustomEvent>;
	private sendActionWaitForResponse(
		action: DrawioAction | TCustomAction
	): Promise<DrawioEvent | TCustomEvent> {
		return new Promise((resolve, reject) => {
			const actionId = (this.currentActionId++).toString();

			this.responseHandlers.set(actionId, {
				resolve: (response) => {
					this.responseHandlers.delete(actionId);
					resolve(response);
				},
				reject,
			});

			this.messageStream.sendMessage(
				JSON.stringify(Object.assign(action, { actionId }))
			);
		});
	}

	protected async handleEvent(evt: { event: string }): Promise<void> {
		const drawioEvt = evt as DrawioEvent;

		// A message can be an action *response* (identified by a `message` field
		// carrying the actionId of a still-pending request) OR a regular *event*
		// that merely echoes its originating request in a `message` field —
		// draw.io's autosave/save events do the latter (msg.message = message,
		// see EditorUi.js). Only treat it as a response when it actually resolves
		// a pending action; otherwise fall through to event handling below.
		// Without this, autosave/save events get swallowed here (their echoed
		// message has no matching pending actionId) and the document is never
		// marked dirty.
		const responseActionId =
			"message" in drawioEvt
				? ((drawioEvt.message as any)?.actionId as string | undefined)
				: undefined;
		const responseHandler =
			responseActionId != null
				? this.responseHandlers.get(responseActionId)
				: undefined;

		if (responseHandler) {
			this.responseHandlers.delete(responseActionId!);
			responseHandler.resolve(drawioEvt);
		} else if (drawioEvt.event === "init") {
			this.onInitEmitter.emit();
		} else if (drawioEvt.event === "autosave") {
			const patched = drawioEvt as { patch?: unknown; checksum?: unknown };
			const sum = checksumText(patched.checksum);
			if (patched.patch && typeof patched.patch === "object" && sum !== undefined) {
				this.onPatchEmitter.emit({
					patch: patched.patch as Record<string, unknown>,
					checksum: sum,
				});
			}
			const oldXml = this.currentXml;
			if (oldXml !== drawioEvt.xml) {
				this.currentXml = drawioEvt.xml;

				// Don't emit a change event if we're merging some changes in.
				if (!this.isMerging) {
					this.onChangeEmitter.emit({
						newXml: this.currentXml,
						oldXml,
					});
				}
			}
		} else if (drawioEvt.event === "save") {
			const oldXml = this.currentXml;
			this.currentXml = drawioEvt.xml;
			// A save may carry an edit that autosave hasn't reported yet. Apply
			// that edit first (via onChange) so the document is up to date, then
			// always save — so a single Save click both updates and persists the
			// file in one step (the provider's onSave waits for the onChange edit
			// to land before calling document.save()).
			if (oldXml != this.currentXml) {
				this.onChangeEmitter.emit({ newXml: this.currentXml, oldXml });
			}
			this.onSaveEmitter.emit();
		} else if (drawioEvt.event === "export") {
			// sometimes, message is not included :(
			// this is a hack to find the request to resolve
			const vals = [...this.responseHandlers.values()];
			this.responseHandlers.clear();
			if (vals.length !== 1) {
				for (const val of vals) {
					val.reject();
				}
			} else {
				vals[0].resolve(drawioEvt);
			}
		} else if (drawioEvt.event === "configure") {
			const config = await this.getConfig();
			this.sendAction({
				action: "configure",
				config,
			});
		} else {
			// Not a pending-action response and not a known event: forward to
			// custom handlers. (Previously this was unreachable because the
			// `"message" in drawioEvt` check above consumed every message-bearing
			// event, which is exactly what swallowed autosave/save.)
			this.onUnknownMessageEmitter.emit({
				message: drawioEvt as unknown as TCustomEvent,
			});
		}
	}

	public async mergeXmlLike(xmlLike: string): Promise<void> {
		const promise = this.sendActionWaitForResponse({
			action: "merge",
			xml: xmlLike,
		});
		this.isMerging = true;
		try {
			const evt = await promise;
			if (evt.event !== "merge") {
				throw new Error("Invalid response");
			}
			if (evt.error) {
				throw new Error(evt.error);
			}
		} finally {
			this.isMerging = false;
		}
	}

	/**
	 * Diff sync (draw.io's embed protocol): makes the diagram as it is now, or `xml` if given,
	 * the state that changes are counted from, and answers with its checksum. Only when diff
	 * sync is on in the editor (CustomizedDrawioClient.setDiffSync): otherwise draw.io does not
	 * answer, and this rejects after `timeoutMs`.
	 *
	 * With `xml`, draw.io merges it into the open diagram: compare the checksum with the one
	 * expected to know whether the result is that diagram.
	 */
	public async resetDiff(xml?: string, timeoutMs = 15000): Promise<string> {
		const evt = (await this.answered(
			this.sendActionWaitForResponse({
				action: "resetDiff",
				...(xml !== undefined ? { xml } : {}),
			} as any),
			timeoutMs,
			"resetDiff"
		)) as { event: string; checksum?: unknown; error?: unknown };
		// (the diagram is no longer the one whose XML is remembered)
		this.currentXml = undefined;
		const sum = checksumText(evt.checksum);
		if (evt.event !== "resetDiff" || evt.error || sum === undefined) {
			throw new Error(
				`The diagram could not be made the starting point: ${String(evt.error ?? "no checksum")}`
			);
		}
		return sum;
	}

	/**
	 * Diff sync: applies someone else's change. It is not reported back as a change of the
	 * user's (no onPatch, no onChange) and is not in their undo history. Resolves with the
	 * checksum of the diagram after it.
	 */
	public async applyPatch(patch: Record<string, unknown>, timeoutMs = 15000): Promise<string> {
		const evt = (await this.answered(
			this.sendActionWaitForResponse({ action: "patch", patch } as any),
			timeoutMs,
			"patch"
		)) as { event: string; checksum?: unknown; error?: unknown };
		this.currentXml = undefined;
		const sum = checksumText(evt.checksum);
		if (evt.event !== "patch" || evt.error || sum === undefined) {
			throw new Error(`A change could not be applied: ${String(evt.error ?? "no checksum")}`);
		}
		return sum;
	}

	/** Diff sync: the checksum of the diagram as it is now. */
	public async diffChecksum(timeoutMs = 15000): Promise<string> {
		const evt = (await this.answered(
			this.sendActionWaitForResponse({ action: "getDiff" } as any),
			timeoutMs,
			"getDiff"
		)) as { event: string; checksum?: unknown };
		const sum = checksumText(evt.checksum);
		if (evt.event !== "getDiff" || sum === undefined) {
			throw new Error("Diff sync is not on in this editor.");
		}
		return sum;
	}

	private answered<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`draw.io did not answer "${what}" within ${timeoutMs / 1000}s.`)),
				timeoutMs
			);
			promise.then(
				(v) => (clearTimeout(timer), resolve(v)),
				(e) => (clearTimeout(timer), reject(e))
			);
		});
	}

	/**
	 * This loads an xml or svg+xml Draw.io diagram.
	 */
	public async loadXmlLike(xmlLike: string): Promise<void> {
		this.currentXml = undefined;
		this.sendAction({
			action: "load",
			xml: xmlLike,
			autosave: 1,
		});
		// We request the xml to detect if an autosave is a real change.
		await this.getXml();
	}

	public async loadPngWithEmbeddedXml(png: Uint8Array): Promise<void> {
		let str = BufferImpl.from(png).toString("base64");
		this.loadXmlLike("data:image/png;base64," + str);
	}

	/**
	 * Exports the diagram for the given file extension. With currentPage, the
	 * png image shows the page that is visible in the editor instead of the
	 * first page (svg exports always show the visible page).
	 */
	public async export(
		extension: string,
		currentPage: boolean = false
	): Promise<BufferImpl> {
		if (extension.endsWith(".png")) {
			return await this.exportAsPngWithEmbeddedXml(currentPage);
		} else if (
			extension.endsWith(".drawio") ||
			extension.endsWith(".dio")
		) {
			const xml = await this.getXml();
			return BufferImpl.from(xml, "utf-8");
		} else if (extension.endsWith(".svg")) {
			return await this.exportAsSvgWithEmbeddedXml();
		} else {
			throw new Error(
				`Invalid file extension "${extension}"! Only ".png", ".svg" and ".drawio" are supported.`
			);
		}
	}

	private async getXmlUncached(): Promise<string> {
		const response = await this.sendActionWaitForResponse({
			action: "export",
			format: "xml",
		});
		if (response.event !== "export") {
			throw new Error("Unexpected response");
		}
		return response.xml;
	}

	public async getXml(): Promise<string> {
		if (!this.currentXml) {
			const xml = await this.getXmlUncached();
			if (!this.currentXml) {
				// It might have been changed in the meantime.
				// Always trust autosave.
				this.currentXml = xml;
			}
		}
		return this.currentXml;
	}

	public async exportAsPngWithEmbeddedXml(
		currentPage: boolean = false
	): Promise<BufferImpl> {
		const response = await this.sendActionWaitForResponse({
			action: "export",
			format: "xmlpng",
			currentPage,
		});
		if (response.event !== "export") {
			throw new Error("Unexpected response");
		}
		const start = "data:image/png;base64,";
		if (!response.data.startsWith(start)) {
			throw new Error("Invalid data");
		}
		const base64Data = response.data.substr(start.length);
		return BufferImpl.from(base64Data, "base64");
	}

	public async exportAsSvgWithEmbeddedXml(): Promise<BufferImpl> {
		const response = await this.sendActionWaitForResponse({
			action: "export",
			format: "xmlsvg",
			theme: this.getSvgTheme(),
		});
		if (response.event !== "export") {
			throw new Error("Unexpected response");
		}
		const start = "data:image/svg+xml;base64,";
		if (!response.data.startsWith(start)) {
			throw new Error("Invalid data");
		}
		const base64Data = response.data.substr(start.length);
		return BufferImpl.from(base64Data, "base64");
	}

	public triggerOnSave(): void {
		this.onSaveEmitter.emit();
	}
}

export interface DrawioDocumentChange {
	oldXml: string | undefined;
	newXml: string;
}

export interface MessageStream {
	registerMessageHandler(handler: (message: unknown) => void): Disposable;
	sendMessage(message: unknown): void;
}
