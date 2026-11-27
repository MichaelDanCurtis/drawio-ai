import { sendEvent } from "./vscode";
import { liveState } from "./liveState";
import * as m from "mithril";

Draw.loadPlugin((ui) => {
	setTimeout(() => {
		sendEvent({ event: "pluginLoaded", pluginId: "LiveShare" });

		const graph = ui.editor.graph;
		const selectionModel = graph.getSelectionModel();

		selectionModel.addListener(mxEvent.CHANGE, () => {
			const cells = selectionModel.cells;
			sendEvent({
				event: "selectedCellsChanged",
				selectedCellIds: cells.map((c) => c.id),
			});
		});

		const theme = graph.defaultThemeName === "darkTheme" ? "dark" : "light";

		/*
		new Cursor(graph.view.canvas, "test", {
			color: "#2965CC",
			name: "Henning Dieterichs",
			theme,
		}).setPosition({
			x: 1200,
			y: 800,
		});

		const r = new SelectionRectangle(graph.view.canvas, "test", {
			color: "blue",
		});
		
		r.setPositions(
			{
				x: 1250,
				y: 850,
			},
			{
				x: 1400,
				y: 1000,
			}
		);
		*/

		// Which page is shown: other people's pointers and selections are of a page, and are only drawn
		// for the one this person is on.
		const reportPage = () => sendEvent({ event: "livePage", page: String((ui as any).currentPage?.getId?.() ?? "") });
		(ui.editor as any).addListener("pageSelected", reportPage);

		/** While the diagram is locked for a shared one to go in: whether it could be changed before. */
		let enabledBeforeLock: boolean | undefined;

		const cursors = new Set<Cursor>();
		const rectangles = new Set<SelectionRectangle>();
		const hightlights = new Highlights(graph);

		// A shape someone else on the shared diagram holds cannot be selected here: what cannot be
		// selected is not moved, restyled or deleted by hand. (The server is what enforces it: it
		// refuses a change that touches one. This keeps people from making such a change.)
		const selectable = (graph as any).isCellSelectable;
		(graph as any).isCellSelectable = function (cell: any) {
			return !(cell && liveState.locked.has(cell.id)) && selectable.apply(this, arguments);
		};

		let notice: HTMLElement | undefined;
		let noticeTimer: ReturnType<typeof setTimeout> | undefined;
		/** A line for the person at the bottom of the editor, gone after a few seconds. */
		const showNotice = (text: string) => {
			notice?.remove();
			if (noticeTimer) clearTimeout(noticeTimer);
			notice = document.createElement("div");
			notice.id = "omnidraw-live-notice";
			notice.setAttribute("role", "status");
			notice.textContent = text;
			notice.style.cssText =
				"position:fixed;right:24px;bottom:24px;z-index:10000;max-width:380px;padding:12px 16px;border-radius:12px;" +
				"background:var(--ink,#141414);color:var(--bg,#f3f2ef);font:14px/1.4 var(--font-ui,system-ui,sans-serif);" +
				"box-shadow:0 18px 48px rgb(20 20 20 / 12%),0 2px 6px rgb(20 20 20 / 6%);pointer-events:none;";
			document.body.appendChild(notice);
			noticeTimer = setTimeout(() => notice?.remove(), 6000);
		};

		window.addEventListener("message", (evt) => {
			if (evt.source !== window.opener) {
				return;
			}
			let data: CustomDrawioAction;
			try {
				data = JSON.parse(evt.data);
			} catch {
				// e.g. the empty setImmediate probe, re-dispatched by webview-content.html
				return;
			}
			if (!data || typeof data.action !== "string") {
				return;
			}

			switch (data.action) {
				case "liveNotice": {
					showNotice(String(data.text ?? ""));
					break;
				}
				case "liveCompose": {
					const u = ui as any;
					try {
						const pages = u.applyPatches(u.getPagesForXml(data.xml), data.patches);
						sendEvent({ event: "liveCompose", xml: u.getXmlForPages(pages), checksum: String(u.getHashValueForPages(pages)), message: data });
					} catch (e: any) {
						sendEvent({ event: "liveCompose", error: String(e?.message ?? e).slice(0, 300), message: data });
					}
					break;
				}
				case "liveLoading": {
					liveState.loading = !!data.on;
					if (!data.on) for (const f of liveState.loaded) f();
					break;
				}
				case "liveLock": {
					if (data.on) {
						if (enabledBeforeLock === undefined) enabledBeforeLock = !!(graph as any).isEnabled();
						(graph as any).setEnabled(false);
						// The diagram that comes next is to take this one's place, not to be merged with it.
						// draw.io merges what differs between the diagram it last took in and the new one, so
						// anything changed since by other means would stay. Telling it that the diagram it
						// last took in is this one, as it is now, makes the merge the whole difference: only
						// what differs changes, and the result is the new diagram.
						try {
							const file = (ui as any).getCurrentFile?.();
							if (file?.setShadowPages && (ui as any).pages) file.setShadowPages((ui as any).clonePages((ui as any).pages));
						} catch {
							// (then the app notices by the checksum, and loads the diagram from scratch)
						}
					} else if (enabledBeforeLock !== undefined) {
						(graph as any).setEnabled(enabledBeforeLock);
						enabledBeforeLock = undefined;
					}
					sendEvent({ event: "liveLock", on: !!data.on, message: data });
					break;
				}
				case "setDiffSync": {
					// draw.io's embed handler reads these each time the diagram changes
					(ui as any).embedDiffSync = !!data.on;
					(ui as any).embedDiffSyncPatchOnly = false;
					if (data.on) reportPage();
					break;
				}
				case "updateLiveshareViewState": {
					liveState.locked = new Set(data.lockedCells ?? []);
					// (two people selected the same shape at the same moment and the other one got it)
					const lost = selectionModel.cells.filter((c: any) => liveState.locked.has(c.id));
					if (lost.length) (graph as any).removeSelectionCells(lost);
					// (someone who left, or took their pointer off the diagram, is no longer listed)
					for (const c of [...cursors]) {
						if (!data.cursors.some((listed) => listed.id === c.id)) {
							cursors.delete(c);
							c.dispose();
						}
					}
					for (const c of data.cursors) {
						const existing =
							[...cursors].find(
								(existingCursor) => existingCursor.id === c.id
							) ||
							new Cursor(graph.view.canvas, c.id, {
								color: c.color,
								name: c.label || "",
								theme,
							});
						cursors.add(existing);
						existing.setPosition(transform(c.position));
					}

					const highlightInfos = new Array<HighlightInfo>();
					for (const s of data.selectedCells) {
						for (const selectedCellId of s.selectedCellIds) {
							const cell = graph.model.cells[selectedCellId];
							// (a cell of another page, or one that is gone, is not on this page to outline)
							if (cell) highlightInfos.push({ cell, color: s.color });
						}
					}
					hightlights.updateHighlights(highlightInfos);

					for (const c of [...rectangles]) {
						if (
							!data.selectedRectangles.some((listed) => listed.id === c.id)
						) {
							rectangles.delete(c);
							c.dispose();
						}
					}
					for (const c of data.selectedRectangles) {
						const existing =
							[...rectangles].find(
								(existingRectangle) =>
									existingRectangle.id === c.id
							) ||
							new SelectionRectangle(graph.view.canvas, c.id, {
								color: c.color,
							});
						rectangles.add(existing);
						existing.setPositions(
							transform(c.rectangle.start),
							transform(c.rectangle.end)
						);
					}

					break;
				}
			}
		});

		function transform({ x, y }: { x: number; y: number }) {
			const { scale, translate } = graph.view as any;
			return {
				x: (x + translate.x) * scale,
				y: (y + translate.y) * scale,
			};
		}

		function transformBack({ x, y }: { x: number; y: number }) {
			const { scale, translate } = graph.view as any;
			return { x: x / scale - translate.x, y: y / scale - translate.y };
		}

		graph.addMouseListener({
			mouseMove: (graph: DrawioGraph, event: mxMouseEvent) => {
				const pos = { x: event.graphX, y: event.graphY };
				const graphPos = transformBack(pos);
				sendEvent({ event: "cursorChanged", position: graphPos });
			},
			mouseDown: () => { },
			mouseUp: () => { },
		});

		// Listen for rubberband events
		const rubberband = graph.getRubberband();

		if (rubberband != null) {
			rubberband.addListener(mxEvent.UPDATE, (sender: any, evt: any) => {
				const x = evt.getProperty("x");
				const y = evt.getProperty("y");
				const w = evt.getProperty("width");
				const h = evt.getProperty("height");

				sendEvent({
					event: "selectedRectangleChanged",
					rect: {
						start: transformBack({ x: x, y: y }),
						end: transformBack({ x: x + w, y: y + h }),
					},
				});
			});

			rubberband.addListener(mxEvent.RESET, () => {
				sendEvent({
					event: "selectedRectangleChanged",
					rect: undefined,
				});
			});
		}
	});
});

declare class mxRubberband {
	addListener(event: string, handler: (sender: any, evt: any) => void): void;
}

const svgns = "http://www.w3.org/2000/svg";

class SelectionRectangle {
	private readonly g = document.createElementNS(svgns, "g");
	private pos1: { x: number; y: number } = { x: 0, y: 0 };
	private pos2: { x: number; y: number } = { x: 0, y: 0 };

	constructor(
		canvas: SVGElement,
		public readonly id: string,
		private readonly options: { color: string }
	) {
		canvas.appendChild(this.g);
		this.g.setAttribute("pointer-events", "none");
	}

	public setPositions(
		pos1: { x: number; y: number },
		pos2: { x: number; y: number }
	) {
		this.pos1 = pos1;
		this.pos2 = pos2;
		this.render();
	}

	private render() {
		m.render(
			this.g,
			m(
				"rect",
				{
					x: this.pos1.x,
					y: this.pos1.y,
					width: this.pos2.x - this.pos1.x,
					height: this.pos2.y - this.pos1.y,
					style: {
						fill: this.options.color,
						fillOpacity: 0.08,
						stroke: this.options.color,
						strokeOpacity: 0.8,
					},
				},
				[]
			)
		);
	}

	public dispose(): void {
		this.g.remove();
	}
}

interface CursorOptions {
	color: string;
	///borderColor: string;
	name: string;
	theme: "dark" | "light";
}

class Cursor {
	private readonly g = document.createElementNS(svgns, "g");

	constructor(
		canvas: SVGElement,
		public readonly id: string,
		options: CursorOptions
	) {
		canvas.appendChild(this.g);
		this.g.setAttribute("pointer-events", "none");

		m.render(
			this.g,
			m("g", [
				m("g", { transform: "scale(0.06,0.06)" }, [
					m("path", {
						fill: options.color,
						style: {
							stroke:
								options.theme === "dark" ? "white" : "black",
							strokeWidth: 10,
						},
						d:
							"M302.189 329.126H196.105l55.831 135.993c3.889 9.428-.555 19.999-9.444 23.999l-49.165 21.427c-9.165 4-19.443-.571-23.332-9.714l-53.053-129.136-86.664 89.138C18.729 472.71 0 463.554 0 447.977V18.299C0 1.899 19.921-6.096 30.277 5.443l284.412 292.542c11.472 11.179 3.007 31.141-12.5 31.141z",
					}),
				]),
				m(
					"text",
					{
						x: 10,
						y: 45,
						style: {
							fontSize: 12,
							fill: options.theme === "dark" ? "white" : "gray",
						},
					},
					[options.name]
				),
			])
		);
	}

	public setPosition(pos: { x: number; y: number }) {
		this.g.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);
	}

	public dispose(): void {
		this.g.remove();
	}
}

interface HighlightInfo {
	color: string;
	cell: DrawioCell;
}

class Highlights {
	private readonly highlights = new Map<
		string,
		{ info: HighlightInfo; instance: mxCellHighlight }
	>();

	constructor(private readonly graph: DrawioGraph) { }

	private highlightInfoToStr(info: HighlightInfo): string {
		return JSON.stringify({ color: info.color, cell: info.cell.id });
	}

	public updateHighlights(highlights: HighlightInfo[]): void {
		const set = new Set(highlights.map((h) => this.highlightInfoToStr(h)));

		for (const [key, h] of this.highlights) {
			if (!set.has(key)) {
				h.instance.destroy();
				this.highlights.delete(key);
			}
		}

		for (const h of highlights) {
			const key = this.highlightInfoToStr(h);
			if (!this.highlights.has(key)) {
				const obj = {
					info: h,
					instance: new mxCellHighlight(this.graph, h.color, 8),
				};
				this.highlights.set(key, obj);
				obj.instance.highlight(this.graph.view.getState(h.cell));
			}
		}
	}
}
