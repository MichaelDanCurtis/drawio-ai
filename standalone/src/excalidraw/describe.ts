// An Excalidraw drawing as a model reads it: each element with what matters for changing it,
// in the same words the tools take them back in (see tools.ts). No Excalidraw, no page.
import { absolutePoints, boxAround, boxOf, type Box, type El } from "./geometry";
import type { SceneQuery } from "./tools";

const FONT_NAMES: Record<number, string> = { 5: "hand", 1: "hand", 6: "normal", 2: "normal", 9: "normal", 8: "code", 3: "code" };
/** Excalidraw's numbers for the three fonts its own panel offers. */
export const FONT_CODES: Record<string, number> = { hand: 5, normal: 6, code: 8 };
const DEFAULT_STROKE = "#1e1e1e";

export interface DescribedElement {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	[key: string]: unknown;
}

export interface DescribedScene {
	/** Elements in the drawing (a label counts with its shape). */
	total: number;
	returned: number;
	truncated: boolean;
	/** The box around everything in the drawing; absent when it is empty. */
	bounds?: Box;
	background?: string;
	selected: string[];
	elements: DescribedElement[];
}

const n = (v: number) => Math.round(v);

/** A shape's or line's label: the text element that is bound to it. */
function labelOf(el: El, byId: Map<string, El>): El | undefined {
	for (const bound of Array.isArray(el.boundElements) ? el.boundElements : []) {
		const text = bound?.type === "text" ? byId.get(bound.id) : undefined;
		if (text && !text.isDeleted && text.type === "text") return text;
	}
	return undefined;
}

/** Whether a text element is somebody's label (and so is described with them, not on its own). */
function isLabel(el: El, byId: Map<string, El>): boolean {
	if (el.type !== "text" || !el.containerId) return false;
	const container = byId.get(el.containerId);
	return !!container && !container.isDeleted;
}

export function describeElement(el: El, byId: Map<string, El>, includeStyles: boolean): DescribedElement {
	const box = boxOf(el);
	const out: DescribedElement = { id: el.id, type: el.type, x: n(box.x), y: n(box.y), width: n(box.width), height: n(box.height) };
	const label = labelOf(el, byId);
	if (el.type === "text") out.text = String(el.originalText ?? el.text ?? "");
	else if (label) out.label = String(label.originalText ?? label.text ?? "");
	if (el.type === "arrow" || el.type === "line") {
		const start = el.startBinding?.elementId, end = el.endBinding?.elementId;
		if (start && byId.get(start) && !byId.get(start)!.isDeleted) out.start = start;
		if (end && byId.get(end) && !byId.get(end)!.isDeleted) out.end = end;
		const points = absolutePoints(el);
		// (a straight line between two elements is said by its ends alone)
		if (!(out.start && out.end) || points.length > 2) out.points = points.map((p) => [n(p[0]), n(p[1])]);
	}
	if (el.angle) out.angle = n((el.angle * 180) / Math.PI);
	if (Array.isArray(el.groupIds) && el.groupIds.length) out.groupIds = [...el.groupIds];
	if (el.frameId) out.frameId = el.frameId;
	if (el.locked) out.locked = true;
	if (el.link) out.link = el.link;
	if (el.type === "image") out.note = "a picture";
	const text = el.type === "text" ? el : label;
	if (includeStyles) {
		out.strokeColor = el.strokeColor;
		out.backgroundColor = el.backgroundColor;
		out.fillStyle = el.fillStyle;
		out.strokeWidth = el.strokeWidth;
		out.strokeStyle = el.strokeStyle;
		out.roughness = el.roughness;
		out.opacity = el.opacity;
		if (el.type !== "text" && el.type !== "ellipse") out.corners = el.roundness ? "round" : "sharp";
		if (text) {
			out.fontSize = text.fontSize;
			out.fontFamily = FONT_NAMES[text.fontFamily] ?? "hand";
			out.textAlign = text.textAlign;
		}
		if (el.type === "arrow" || el.type === "line") {
			out.startArrowhead = el.startArrowhead ?? "none";
			out.endArrowhead = el.endArrowhead ?? "none";
		}
	} else {
		// (only what is not the default, so that a plain drawing reads short)
		if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) out.strokeColor = el.strokeColor;
		if (el.backgroundColor && el.backgroundColor !== "transparent") out.backgroundColor = el.backgroundColor;
	}
	return out;
}

/** The drawing's elements (deleted ones left out), read the way the query asks. */
export function describeScene(all: El[], query: SceneQuery, selected: readonly string[], background?: string): DescribedScene {
	const live = all.filter((e) => !e.isDeleted);
	const byId = new Map(live.map((e) => [e.id, e]));
	const own = live.filter((e) => !isLabel(e, byId));
	let wanted = own;
	const pick = new Set<string>(query.ids ?? []);
	if (query.scope === "selection") for (const id of selected) pick.add(id);
	if (query.ids || query.scope === "selection") {
		// (a label that is selected, or asked for by its id, means the shape it is in)
		for (const id of [...pick]) {
			const el = byId.get(id);
			if (el && isLabel(el, byId)) pick.add(el.containerId);
		}
		wanted = wanted.filter((e) => pick.has(e.id));
	}
	const described = wanted.map((e) => describeElement(e, byId, query.includeStyles));
	const needle = query.query?.toLowerCase();
	const matching = needle ? described.filter((d) => [d.id, d.type, d.text, d.label].some((v) => typeof v === "string" && v.toLowerCase().includes(needle))) : described;
	const elements = matching.slice(0, query.maxElements);
	const box = boxAround(live);
	return {
		total: own.length,
		returned: elements.length,
		truncated: matching.length > elements.length,
		...(box ? { bounds: { x: n(box.x), y: n(box.y), width: n(box.width), height: n(box.height) } } : {}),
		...(background ? { background } : {}),
		selected: selected.filter((id) => byId.has(id)),
		elements,
	};
}
