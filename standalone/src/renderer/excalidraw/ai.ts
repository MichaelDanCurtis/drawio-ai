// OmniDraw: what an agent's tools do to an Excalidraw drawing, in the editor page.
//
// The app (src/main/excalidrawTools.ts) checks what a model sent and hands the tool call over;
// this file carries it out against the real editor through Excalidraw's own API, and keeps the
// review of what was changed (src/excalidraw/review.ts): every change is in the drawing at
// once, undoable, and pending until the user keeps or reverts it.
//
// Elements are made by Excalidraw itself (`convertToExcalidrawElements`: it measures text,
// fits a label into its shape and attaches a line to what it ends at), never by hand. What
// this file adds is what that function leaves to its caller: where a line between two elements
// runs, and keeping labels and attached lines in place when something is moved or resized.
import { describeScene, FONT_CODES } from "../../excalidraw/describe";
import { absolutePoints, boxAround, boxOf, freePlace, isLine, routeBetween, routeThrough, round, type El, type Point } from "../../excalidraw/geometry";
import { boundTo, ReviewLedger, type Change, type Summary } from "../../excalidraw/review";
import type { AddOp, Operation, SceneQuery, Style, UpdateOp } from "../../excalidraw/tools";

/** What this file needs of the editor (Excalidraw's API and three of its functions; app.tsx hands them over). */
export interface Editor {
	api: {
		getSceneElementsIncludingDeleted(): readonly any[];
		getAppState(): any;
		getFiles(): any;
		updateScene(scene: { elements?: readonly any[]; appState?: any; captureUpdate?: any }): void;
		scrollToContent(target?: any, opts?: any): void;
		addFiles(files: any[]): void;
	};
	convert(skeletons: any[], opts?: { regenerateIds?: boolean }): any[];
	exportToBlob(opts: any): Promise<Blob>;
	/** How a change is entered in the editor's undo history: as one step of the user's. */
	captureNow: unknown;
	captureNever: unknown;
}

/** An operation that cannot be carried out; the message is for the model. */
export class OperationError extends Error {}

const DEFAULT_WIDTH = 160, DEFAULT_HEIGHT = 80;
const TEXT_STYLE = ["fontSize", "fontFamily", "textAlign", "verticalAlign"] as const;

let nonce = Date.now() % 1_000_000;
/** The element with these changes, as a new version of it (Excalidraw takes the higher version for the newer). */
function next(el: El, changes: Record<string, unknown> = {}, over = 0): El {
	return { ...el, ...changes, version: Math.max(el.version ?? 0, over) + 1, versionNonce: (nonce = (nonce * 1103515245 + 12345) % 2147483647), updated: Date.now() };
}

/** Excalidraw's names for the settings the tools call by friendlier ones. */
function elementStyle(style: Style, type: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "locked", "link", "groupIds", "fontSize", "textAlign", "verticalAlign"] as const) {
		if (style[key] !== undefined) out[key] = style[key];
	}
	if (style.fontFamily !== undefined) out.fontFamily = FONT_CODES[style.fontFamily];
	if (style.angle !== undefined) out.angle = (style.angle * Math.PI) / 180;
	// (Excalidraw rounds a rectangle's corners by a fixed radius, and everything else in proportion)
	if (style.corners !== undefined) out.roundness = style.corners === "sharp" ? null : { type: type === "rectangle" ? 3 : 2 };
	if (style.startArrowhead !== undefined) out.startArrowhead = style.startArrowhead === "none" ? null : style.startArrowhead;
	if (style.endArrowhead !== undefined) out.endArrowhead = style.endArrowhead === "none" ? null : style.endArrowhead;
	return out;
}

/** The drawing while a list of operations is applied to it: nothing reaches the editor until all of them worked. */
class Draft {
	private readonly order: string[];
	private readonly elements: Map<string, El>;
	private readonly original: Map<string, El>;
	public readonly created: string[] = [];

	constructor(scene: readonly El[]) {
		this.order = scene.map((e) => e.id);
		this.elements = new Map(scene.map((e) => [e.id, e]));
		this.original = new Map(this.elements);
	}

	/** The element, deleted or not. */
	public any(id: string): El | undefined {
		return this.elements.get(id);
	}

	public get(id: string): El | undefined {
		const el = this.elements.get(id);
		return el && !el.isDeleted ? el : undefined;
	}

	public live(): El[] {
		return this.order.map((id) => this.elements.get(id)!).filter((e) => !e.isDeleted);
	}

	/** Puts a new state of an element that is in the drawing. */
	public set(el: El): void {
		this.elements.set(el.id, el);
	}

	public change(id: string, changes: Record<string, unknown>): El {
		const el = next(this.elements.get(id)!, changes);
		this.elements.set(id, el);
		return el;
	}

	/** Adds an element Excalidraw has just made (its place in the stacking order is Excalidraw's to give). */
	public add(el: El): void {
		this.order.push(el.id);
		this.elements.set(el.id, { ...el, index: null });
		this.created.push(el.id);
	}

	public all(): El[] {
		return this.order.map((id) => this.elements.get(id)!);
	}

	/** The elements that are not what they were, each with what it was (undefined: it is new). */
	public touched(): { id: string; before: El | undefined }[] {
		return this.order.filter((id) => this.elements.get(id) !== this.original.get(id)).map((id) => ({ id, before: this.original.get(id) }));
	}

	/** The label of a shape or line: the text element bound to it. */
	public labelOf(el: El): El | undefined {
		for (const bound of Array.isArray(el.boundElements) ? el.boundElements : []) {
			const text = bound?.type === "text" ? this.get(bound.id) : undefined;
			if (text) return text;
		}
		return undefined;
	}

	/** The lines attached to an element. */
	public linesAt(el: El): El[] {
		const lines: El[] = [];
		for (const bound of Array.isArray(el.boundElements) ? el.boundElements : []) {
			const line = bound?.type === "arrow" ? this.get(bound.id) : undefined;
			if (line && (line.startBinding?.elementId === el.id || line.endBinding?.elementId === el.id)) lines.push(line);
		}
		return lines;
	}

	/** Takes `id` out of the list of what is attached to `of` (a line that let go, a label that went). */
	public unbind(of: string | undefined, id: string): void {
		const el = of ? this.get(of) : undefined;
		if (!el || !Array.isArray(el.boundElements) || !el.boundElements.some((b: any) => b.id === id)) return;
		this.change(el.id, { boundElements: el.boundElements.filter((b: any) => b.id !== id) });
	}
}

export class DrawingAi {
	private readonly ledger = new ReviewLedger();
	private lastReview = "";

	constructor(private readonly editor: Editor, private readonly onReview: (pending: boolean, summary: Summary, changes: Change[]) => void) {}

	private scene(): El[] {
		return this.editor.api.getSceneElementsIncludingDeleted() as El[];
	}

	private current(): (id: string) => El | undefined {
		const byId = new Map(this.scene().map((e) => [e.id, e]));
		return (id) => byId.get(id);
	}

	// ----- reading -----

	public getScene(query: SceneQuery): unknown {
		const state = this.editor.api.getAppState();
		const selected = Object.keys(state.selectedElementIds ?? {}).filter((id) => state.selectedElementIds[id]);
		const scene = describeScene(this.scene(), query, selected, state.viewBackgroundColor);
		const pending = this.ledger.summary(this.current());
		return { ...scene, ...(pending.added + pending.changed + pending.removed > 0 ? { pendingReview: pending } : {}) };
	}

	public selection(): string[] {
		const state = this.editor.api.getAppState();
		const live = new Set(this.scene().filter((e) => !e.isDeleted).map((e) => e.id));
		return Object.keys(state.selectedElementIds ?? {}).filter((id) => state.selectedElementIds[id] && live.has(id));
	}

	public select(ids: string[]): unknown {
		const live = new Map(this.scene().filter((e) => !e.isDeleted).map((e) => [e.id, e]));
		const found = ids.filter((id) => live.has(id));
		this.editor.api.updateScene({ appState: { selectedElementIds: Object.fromEntries(found.map((id) => [id, true])) }, captureUpdate: this.editor.captureNever });
		if (found.length) this.editor.api.scrollToContent(found.map((id) => live.get(id)), { animate: true, fitToViewport: false });
		return { selected: found, ...(found.length < ids.length ? { notFound: ids.filter((id) => !live.has(id)) } : {}) };
	}

	public async render(ids: string[] | undefined): Promise<{ base64: string; mimeType: string; elements: number }> {
		const all = this.scene().filter((e) => !e.isDeleted);
		let elements = all;
		if (ids?.length) {
			const wanted = new Set(ids);
			// (a shape is drawn with its label, a label with its shape)
			for (const e of all) if (wanted.has(e.id)) for (const b of e.boundElements ?? []) if (b.type === "text") wanted.add(b.id);
			elements = all.filter((e) => wanted.has(e.id));
			if (elements.length === 0) throw new OperationError("None of these elements is in the drawing.");
		}
		const blob = await this.editor.exportToBlob({
			elements,
			appState: { ...this.editor.api.getAppState(), exportBackground: true, exportEmbedScene: false, exportWithDarkMode: false },
			files: this.editor.api.getFiles(),
			mimeType: "image/png",
			maxWidthOrHeight: 1400,
		});
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { base64: btoa(binary), mimeType: "image/png", elements: elements.length };
	}

	// ----- changing -----

	/** Applies the operations as one step: all of them, or (when one cannot be carried out) none. */
	public async apply(operations: Operation[], select = false): Promise<unknown> {
		await this.fontsFor(operations);
		const draft = new Draft(this.scene());
		const results: { op: string; id?: string }[] = [];
		const problems: string[] = [];
		operations.forEach((op, i) => {
			try {
				if (op.op === "add") results.push({ op: "add", id: this.add(draft, op) });
				else if (op.op === "update") results.push({ op: "update", id: this.update(draft, op) });
				else results.push({ op: "delete", id: this.remove(draft, op.id) });
			} catch (e: any) {
				if (!(e instanceof OperationError)) throw e;
				problems.push(`operations[${i}] (${op.op}${"id" in op && op.id ? ` ${op.id}` : ""}): ${e.message}`);
			}
		});
		if (problems.length) throw new OperationError(`Nothing was changed. ${problems.join(" ")}`);
		const changed = this.commit(draft);
		if (select) this.select(results.filter((r) => r.op !== "delete" && r.id).map((r) => r.id!));
		return { applied: results.length, results, changedElements: changed, pendingReview: this.ledger.summary(this.current()) };
	}

	/** A Mermaid diagram as Excalidraw elements, beside what is there (or where x and y say). */
	public async fromMermaid(definition: string, at: { x?: number; y?: number }): Promise<unknown> {
		const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
		let parsed: { elements: any[]; files?: Record<string, any> };
		try {
			parsed = await parseMermaidToExcalidraw(definition);
		} catch (e: any) {
			throw new OperationError(`Mermaid could not read the diagram: ${String(e?.message ?? e).slice(0, 600)}`);
		}
		const made = this.editor.convert(parsed.elements) as El[];
		if (made.length === 0) throw new OperationError("The Mermaid diagram is empty.");
		const draft = new Draft(this.scene());
		const box = boxAround(made)!;
		const [x, y] = at.x !== undefined && at.y !== undefined ? [at.x, at.y] : freePlace(draft.live());
		for (const el of made) draft.add({ ...el, x: round(el.x - box.x + x), y: round(el.y - box.y + y) });
		const files = Object.values(parsed.files ?? {});
		if (files.length) this.editor.api.addFiles(files);
		this.commit(draft);
		const own = made.filter((e) => !(e.type === "text" && e.containerId));
		return {
			added: own.length,
			ids: own.map((e) => e.id),
			at: { x, y, width: Math.round(box.width), height: Math.round(box.height) },
			...(files.length ? { note: "This kind of Mermaid diagram is added as one picture, not as shapes." } : {}),
			pendingReview: this.ledger.summary(this.current()),
		};
	}

	/** Writes the draft into the editor as one step the user can undo, and enters what changed in the review. */
	private commit(draft: Draft): number {
		const touched = draft.touched();
		if (touched.length === 0) return 0;
		// (what the user did since the last look is theirs: it is taken in before the AI's change is entered)
		this.ledger.follow(this.current());
		this.editor.api.updateScene({ elements: draft.all(), captureUpdate: this.editor.captureNow });
		for (const t of touched) this.ledger.changed(t.id, t.before, draft.any(t.id));
		this.report();
		return touched.length;
	}

	/** The fonts the new text will be in must be there before Excalidraw measures it. */
	private async fontsFor(operations: Operation[]): Promise<void> {
		const names: Record<string, string> = { hand: "Excalifont", normal: "Nunito", code: "Comic Shanns" };
		const wanted = new Set<string>(["Excalifont"]);
		for (const op of operations) if (op.op !== "delete" && op.fontFamily) wanted.add(names[op.fontFamily]);
		await Promise.race([Promise.all([...wanted].map((f) => document.fonts.load(`20px "${f}"`).catch(() => undefined))), new Promise((r) => setTimeout(r, 3000))]);
	}

	private newId(draft: Draft, wanted: string | undefined): string | undefined {
		if (wanted && draft.any(wanted)) throw new OperationError(`the id "${wanted}" is taken by an element of the drawing${draft.get(wanted) ? "" : " (one that was deleted)"}; leave id out, or pick another.`);
		return wanted;
	}

	private add(draft: Draft, op: AddOp): string {
		const id = this.newId(draft, op.id);
		const style = elementStyle(op, op.type);
		if (op.type === "arrow" || op.type === "line") return this.addLine(draft, op, id, style);
		let made: El[];
		if (op.type === "text") {
			made = this.editor.convert([{ type: "text", ...(id ? { id } : {}), x: op.x, y: op.y, text: op.text, ...style }], { regenerateIds: false });
		} else {
			// (shapes get round corners, as when they are drawn by hand; a labelled shape without a size fits its label)
			const sized = op.label && op.width === undefined && op.height === undefined ? {} : { width: op.width ?? DEFAULT_WIDTH, height: op.height ?? DEFAULT_HEIGHT };
			const { fontSize, fontFamily, textAlign, verticalAlign, ...shape } = style as any;
			const label = op.label ? { label: { text: op.label, ...(fontSize ? { fontSize } : {}), ...(fontFamily ? { fontFamily } : {}), ...(textAlign ? { textAlign } : {}), ...(verticalAlign ? { verticalAlign } : {}), ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}) } } : {};
			made = this.editor.convert([{ type: op.type, ...(id ? { id } : {}), x: op.x, y: op.y, ...sized, roundness: op.type === "ellipse" ? null : { type: op.type === "rectangle" ? 3 : 2 }, ...shape, ...label }], { regenerateIds: false });
		}
		for (const el of made) draft.add(el);
		return made[0].id;
	}

	/** The element a line's end names: something in the drawing that a line can be attached to. */
	private target(draft: Draft, id: string, end: string): El {
		const el = draft.get(id);
		if (!el) throw new OperationError(`${end} "${id}" is not in the drawing.`);
		if (isLine(el) || el.type === "freedraw") throw new OperationError(`${end} "${id}" is a ${el.type}: a line is attached to a shape, a text or a picture.`);
		// (a label stands for its shape)
		const container = el.type === "text" && el.containerId ? draft.get(el.containerId) : undefined;
		return container && !isLine(container) ? container : el;
	}

	/**
	 * A line as Excalidraw makes it: routed between its ends, attached to the elements it names,
	 * with its label. `existing`: the line is in the drawing already and is made anew in place.
	 */
	private buildLine(draft: Draft, spec: { type: string; id?: string; start?: string; end?: string; points?: Point[]; from?: Point; to?: Point; label?: string; props: Record<string, unknown> }, existing?: El): string {
		const start = spec.start ? this.target(draft, spec.start, "start") : undefined;
		const end = spec.end ? this.target(draft, spec.end, "end") : undefined;
		if (start && end && start.id === end.id) throw new OperationError("a line from an element to itself is not supported; give it points instead.");
		const attach = spec.type === "arrow";
		const given = spec.points;
		// (ends that are attached run to the element's outline; the points in between stay where they are)
		const first: El | Point | undefined = start ?? given?.[0] ?? spec.from;
		const last: El | Point | undefined = end ?? given?.[given.length - 1] ?? spec.to;
		if (!first || !last) throw new OperationError("it has no place: attach both ends (start, end), or give points.");
		const via = given ? given.slice(1, -1) : [];
		const route = given && !start && !end ? routeThrough(given) : routeBetween(first, last, via);
		if (route.width === 0 && route.height === 0 && route.points.length === 2) throw new OperationError("its two ends are in the same place.");
		const { fontSize, fontFamily, textAlign, verticalAlign, ...line } = spec.props as any;
		const label = spec.label ? { label: { text: spec.label, ...(fontSize ? { fontSize } : {}), ...(fontFamily ? { fontFamily } : {}), ...(line.strokeColor ? { strokeColor: line.strokeColor } : {}) } } : {};
		const skeleton = {
			type: spec.type,
			...(spec.id ? { id: spec.id } : {}),
			...(spec.type === "line" ? { endArrowhead: null } : {}),
			...line,
			...route,
			// (only an arrow is attached to what it ends at, and follows it; a line is drawn between them and stays)
			...(start && attach ? { start: { id: start.id } } : {}),
			...(end && attach ? { end: { id: end.id } } : {}),
			...label,
		};
		// (the elements it is attached to go through with it: Excalidraw notes the arrow on them)
		const made = this.editor.convert([...(start && attach ? [start] : []), ...(end && attach ? [end] : []), skeleton], { regenerateIds: false }) as El[];
		const lineEl = made.find((e) => e.type === spec.type && e.id !== start?.id && e.id !== end?.id)!;
		const labelEl = made.find((e) => e.type === "text" && e.containerId === lineEl.id);
		for (const t of attach ? [start, end] : []) {
			if (!t) continue;
			const after = made.find((e) => e.id === t.id);
			if (after && JSON.stringify(after.boundElements ?? null) !== JSON.stringify(t.boundElements ?? null)) draft.change(t.id, { boundElements: after.boundElements });
		}
		if (!existing) {
			draft.add(lineEl);
			if (labelEl) draft.add(labelEl);
			return lineEl.id;
		}
		// in place: the line keeps its id, its place in the stacking order and (when it has one) its label's id
		const oldLabel = draft.labelOf(existing);
		const { id: _id, index: _index, version: _version, versionNonce: _nonce, seed: _seed, ...fresh } = lineEl;
		let bound = (lineEl.boundElements ?? []).filter((b: any) => b.type !== "text");
		if (labelEl && oldLabel) {
			const { id: _i, index: _x, version: _v, versionNonce: _n, seed: _s, ...text } = labelEl;
			draft.change(oldLabel.id, { ...text, containerId: existing.id });
			bound = [...bound, { type: "text", id: oldLabel.id }];
		} else if (labelEl) {
			draft.add({ ...labelEl, containerId: existing.id });
			bound = [...bound, { type: "text", id: labelEl.id }];
		} else if (oldLabel) {
			draft.change(oldLabel.id, { isDeleted: true });
		}
		draft.change(existing.id, { ...fresh, seed: existing.seed, boundElements: bound.length ? bound : null });
		// (Excalidraw noted the line on what it is attached to under its own id, which is the same one here)
		return existing.id;
	}

	private addLine(draft: Draft, op: AddOp, id: string | undefined, style: Record<string, unknown>): string {
		const from: Point | undefined = op.x !== undefined && op.y !== undefined ? [op.x, op.y] : undefined;
		const to: Point | undefined = from ? [from[0] + (op.width ?? 120), from[1] + (op.height ?? 0)] : undefined;
		return this.buildLine(draft, { type: op.type, id, start: op.start, end: op.end, points: op.points, from, to, label: op.label, props: { roundness: { type: 2 }, ...style } });
	}

	/** What a line in the drawing is, in the words a line is built from. */
	private lineSpec(draft: Draft, el: El): { start?: string; end?: string; points: Point[]; label?: string; props: Record<string, unknown> } {
		const label = draft.labelOf(el);
		const props: Record<string, unknown> = {};
		for (const key of ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "locked", "link", "groupIds", "angle", "roundness", "startArrowhead", "endArrowhead", "frameId", "elbowed"]) props[key] = el[key];
		if (label) Object.assign(props, { fontSize: label.fontSize, fontFamily: label.fontFamily });
		return {
			...(el.startBinding?.elementId && draft.get(el.startBinding.elementId) ? { start: el.startBinding.elementId } : {}),
			...(el.endBinding?.elementId && draft.get(el.endBinding.elementId) ? { end: el.endBinding.elementId } : {}),
			points: absolutePoints(el),
			...(label ? { label: String(label.originalText ?? label.text ?? "") } : {}),
			props,
		};
	}

	/** Makes a line anew where it is, after something about it (or about what it is attached to) changed. */
	private rebuildLine(draft: Draft, el: El, changes: Partial<{ start: string | null; end: string | null; points: Point[] }> = {}): void {
		const spec = this.lineSpec(draft, el);
		const start = changes.start === undefined ? spec.start : changes.start ?? undefined;
		const end = changes.end === undefined ? spec.end : changes.end ?? undefined;
		// an end that lets go of its element stays where it was; lines it no longer is attached to forget it
		for (const was of [spec.start, spec.end]) if (was && was !== start && was !== end) draft.unbind(was, el.id);
		this.buildLine(draft, { type: el.type, id: el.id, start, end, points: changes.points ?? spec.points, label: spec.label, props: spec.props }, draft.get(el.id)!);
	}

	/** A shape's label, or a text element, laid out anew by Excalidraw (after its words, its font or its shape's size changed). */
	private relabel(draft: Draft, id: string, text: string | undefined, textStyle: Record<string, unknown>): void {
		const el = draft.get(id)!;
		if (el.type === "text") {
			const content = text ?? String(el.originalText ?? el.text ?? "");
			if (!content.trim()) throw new OperationError("a text element cannot be empty; delete it instead.");
			const [made] = this.editor.convert([{ type: "text", x: el.x, y: el.y, text: content, fontSize: el.fontSize, fontFamily: el.fontFamily, textAlign: el.textAlign, strokeColor: el.strokeColor, ...textStyle }], { regenerateIds: false }) as El[];
			draft.change(id, { text: made.text, originalText: made.originalText, width: made.width, height: made.height, fontSize: made.fontSize, fontFamily: made.fontFamily, textAlign: made.textAlign, lineHeight: made.lineHeight, ...(textStyle.verticalAlign ? { verticalAlign: textStyle.verticalAlign } : {}) });
			return;
		}
		const old = draft.labelOf(el);
		const content = text ?? (old ? String(old.originalText ?? old.text ?? "") : "");
		if (!content.trim()) {
			if (old) {
				draft.change(old.id, { isDeleted: true });
				draft.unbind(el.id, old.id);
			}
			return;
		}
		const label = { text: content, fontSize: old?.fontSize, fontFamily: old?.fontFamily, textAlign: old?.textAlign, verticalAlign: old?.verticalAlign, strokeColor: old?.strokeColor ?? el.strokeColor, ...textStyle };
		for (const key of Object.keys(label) as (keyof typeof label)[]) if (label[key] === undefined) delete label[key];
		// (a copy of the shape goes through Excalidraw with the label: it comes back with the label placed in it, taller if the words need it)
		const { boundElements: _bound, ...bare } = el;
		const made = this.editor.convert([{ ...bare, id: "omnidraw-relabel", label }], { regenerateIds: false }) as El[];
		const shape = made.find((e) => e.id === "omnidraw-relabel")!, placed = made.find((e) => e.type === "text")!;
		const { id: _id, index: _index, version: _version, versionNonce: _nonce, seed: _seed, containerId: _container, ...fresh } = placed;
		if (old) draft.change(old.id, fresh);
		else {
			draft.add({ ...placed, containerId: el.id });
			draft.change(el.id, { boundElements: [...(el.boundElements ?? []), { type: "text", id: placed.id }] });
		}
		// (a shape grows when its words need the room; a line's size is the box around its points, which a label does not change)
		if (!isLine(el) && (shape.height !== el.height || shape.width !== el.width)) draft.change(el.id, { width: shape.width, height: shape.height });
	}

	private update(draft: Draft, op: UpdateOp): string {
		let el = draft.get(op.id);
		if (!el) throw new OperationError(draft.any(op.id) ? "it was deleted." : "it is not in the drawing.");
		// (a label is its shape's: what is said of the label is said of the shape's label)
		const container = el.type === "text" && el.containerId ? draft.get(el.containerId) : undefined;
		if (container) {
			const { id: _id, text, label, ...rest } = op;
			const words = text ?? label;
			return this.update(draft, { ...rest, id: container.id, ...(words !== undefined ? { label: words } : {}) });
		}
		if (el.type === "image" || el.type === "freedraw" || el.type === "frame" || el.type === "embeddable" || el.type === "iframe" || el.type === "magicframe") {
			if (op.text !== undefined || op.label !== undefined || op.start !== undefined || op.end !== undefined || op.points !== undefined) throw new OperationError(`a ${el.type} can be moved, resized and restyled, nothing else.`);
		}
		const style = elementStyle(op, el.type);
		const { fontSize, fontFamily, textAlign, verticalAlign, ...look } = style as any;
		const textStyle: Record<string, unknown> = {};
		for (const key of TEXT_STYLE) if (style[key] !== undefined) textStyle[key] = style[key];
		const words = el.type === "text" ? op.text ?? op.label : op.label ?? op.text;

		if (isLine(el)) {
			if (op.width !== undefined || op.height !== undefined) throw new OperationError("a line has no width and height to set: give it points, or move what it is attached to.");
			const rerouted = op.points !== undefined || op.x !== undefined || op.y !== undefined || op.start !== undefined || op.end !== undefined;
			if (rerouted && el.elbowed) throw new OperationError("an elbow arrow keeps the route Excalidraw gave it: it can be restyled and relabelled here, not moved or attached elsewhere. Delete it and add an arrow instead.");
			// how it looks (its label takes its colour and opacity with it, as a shape's does)
			if (Object.keys(look).length) {
				el = draft.change(el.id, look);
				const label = draft.labelOf(el);
				if (label && (look.strokeColor !== undefined || look.opacity !== undefined)) draft.change(label.id, { ...(look.strokeColor !== undefined ? { strokeColor: look.strokeColor } : {}), ...(look.opacity !== undefined ? { opacity: look.opacity } : {}) });
			}
			// where it runs, and what it is attached to: made anew by Excalidraw, in place
			if (rerouted) {
				let points = op.points;
				if (!points && (op.x !== undefined || op.y !== undefined)) {
					// moved as a whole: every point by as much
					const box = boxOf(el);
					const dx = (op.x ?? box.x) - box.x, dy = (op.y ?? box.y) - box.y;
					points = absolutePoints(el).map((p) => [p[0] + dx, p[1] + dy] as Point);
				}
				this.rebuildLine(draft, el, { ...(op.start !== undefined ? { start: op.start } : {}), ...(op.end !== undefined ? { end: op.end } : {}), ...(points ? { points } : {}) });
			}
			// its words
			if (words !== undefined || Object.keys(textStyle).length) this.relabel(draft, el.id, words, textStyle);
			return el.id;
		}
		if (op.start !== undefined || op.end !== undefined || op.points !== undefined) throw new OperationError(`start, end and points are for arrows and lines; this is a ${el.type}.`);

		// how it looks (a shape's label takes its line colour and opacity with it, as in the editor)
		if (Object.keys(look).length) {
			el = draft.change(el.id, look);
			const label = draft.labelOf(el);
			if (label && (look.strokeColor !== undefined || look.opacity !== undefined)) draft.change(label.id, { ...(look.strokeColor !== undefined ? { strokeColor: look.strokeColor } : {}), ...(look.opacity !== undefined ? { opacity: look.opacity } : {}) });
		}
		// where it is, and how large
		const box = boxOf(el);
		const dx = op.x !== undefined ? op.x - box.x : 0, dy = op.y !== undefined ? op.y - box.y : 0;
		const resized = (op.width !== undefined && op.width !== el.width) || (op.height !== undefined && op.height !== el.height);
		if (el.type === "text" && resized) throw new OperationError("a text element is as large as its words: change fontSize or the text.");
		if (dx || dy || resized) {
			el = draft.change(el.id, { x: round(el.x + dx), y: round(el.y + dy), ...(op.width !== undefined ? { width: op.width } : {}), ...(op.height !== undefined ? { height: op.height } : {}) });
			const label = draft.labelOf(el);
			if (label && (dx || dy)) draft.change(label.id, { x: round(label.x + dx), y: round(label.y + dy) });
		}
		// its words
		if (words !== undefined || Object.keys(textStyle).length || (resized && draft.labelOf(el))) this.relabel(draft, el.id, words, textStyle);
		// the lines attached to it follow
		// (an elbow arrow's route is Excalidraw's own to work out: it is left as it is, and Excalidraw puts it right the next time the shape is moved by hand)
		if (dx || dy || resized || draft.get(el.id)!.height !== el.height) for (const line of draft.linesAt(draft.get(el.id)!)) if (!line.elbowed) this.rebuildLine(draft, line);
		return el.id;
	}

	private remove(draft: Draft, id: string): string {
		const el = draft.get(id);
		if (!el) throw new OperationError(draft.any(id) ? "it was deleted already." : "it is not in the drawing.");
		if (el.type === "text" && el.containerId && draft.get(el.containerId)) {
			// a label: only the words go
			draft.unbind(el.containerId, el.id);
			draft.change(el.id, { isDeleted: true });
			return id;
		}
		const label = draft.labelOf(el);
		if (label) draft.change(label.id, { isDeleted: true });
		if (isLine(el)) {
			draft.unbind(el.startBinding?.elementId, el.id);
			draft.unbind(el.endBinding?.elementId, el.id);
		} else {
			// lines attached to it stay, with that end let go
			for (const line of draft.linesAt(el)) {
				draft.change(line.id, { ...(line.startBinding?.elementId === el.id ? { startBinding: null } : {}), ...(line.endBinding?.elementId === el.id ? { endBinding: null } : {}) });
			}
		}
		draft.change(el.id, { isDeleted: true });
		return id;
	}

	// ----- review -----

	/** The pending changes, for the outlines on the canvas. */
	public pending(): Change[] {
		return this.ledger.changes(this.current());
	}

	/** Called when the drawing changed (by anyone): what was undone is no longer pending, and the app is told if the review changed. */
	public sceneChanged(): void {
		if (this.reviewing) this.report();
	}

	/** Whether there is a review to keep up to date (the page then tells this file of every change to the drawing). */
	public get reviewing(): boolean {
		return this.ledger.watching || this.lastReview !== "";
	}

	private report(): void {
		const current = this.current();
		this.ledger.follow(current);
		const changes = this.ledger.changes(current);
		const summary: Summary = { added: 0, changed: 0, removed: 0 };
		for (const c of changes) summary[c.change]++;
		const key = changes.length ? JSON.stringify(changes.map((c) => [c.id, c.change, c.element.version])) : "";
		if (key === this.lastReview) return;
		this.lastReview = key;
		this.onReview(changes.length > 0, summary, changes);
	}

	/** Keep (accept) or revert (reject) everything that is pending. */
	public resolve(decision: "accept" | "reject"): void {
		if (!this.ledger.open) return;
		if (decision === "accept") {
			this.ledger.accept();
			return this.report();
		}
		const { restore, remove } = this.ledger.revert();
		const scene = this.scene();
		const byId = new Map(scene.map((e) => [e.id, e]));
		const back = new Map(restore.map((e) => [e.id, e]));
		const gone = new Set(remove);
		let elements = scene.map((now) => {
			const was = back.get(now.id);
			// (as it was, as a newer version than what is there; its place in the stacking order is today's)
			if (was) return next({ ...was, index: now.index }, {}, now.version);
			if (gone.has(now.id) && !now.isDeleted) return next(now, { isDeleted: true });
			return now;
		});
		// (what was cleared off the canvas altogether since, comes back at the end)
		for (const was of restore) if (!byId.has(was.id)) elements.push(next({ ...was, index: null }));
		// What is attached to what is put right from the lines and labels that are there now: an element
		// the AI attached an arrow to no longer lists it, and one that got its arrow back does. Only the
		// elements this touches: what else the user has in the drawing is left exactly as it is.
		const reverted = new Set([...back.keys(), ...gone]);
		const lists = boundTo(elements);
		elements = elements.map((e) => {
			if (e.isDeleted) return e;
			const have: { id: string }[] = Array.isArray(e.boundElements) ? e.boundElements : [];
			const want = lists.get(e.id) ?? [];
			if (!reverted.has(e.id) && ![...have, ...want].some((b) => reverted.has(b.id))) return e;
			if (JSON.stringify(have.map((b) => b.id)) === JSON.stringify(want.map((b) => b.id))) return e;
			return back.has(e.id) || gone.has(e.id) ? { ...e, boundElements: want.length ? want : null } : next(e, { boundElements: want.length ? want : null });
		});
		this.editor.api.updateScene({ elements, captureUpdate: this.editor.captureNow });
		this.report();
	}
}
