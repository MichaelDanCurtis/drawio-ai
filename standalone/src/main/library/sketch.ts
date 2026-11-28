// A quick picture of a document for its card on the home screen, drawn from the file alone.
// Nothing of Electron here, and neither editor: the tests load this file as it is.
//
// The real picture of a document is the one its editor makes, and the app keeps one each time
// a document is saved here. A file that came into the library another way (copied in, pulled
// from a repository, changed by another program) has none, and opening an editor behind the
// scenes for every such card is too much. So its card gets a sketch: the shapes where they are,
// in their colours, with their words, the lines between them. Not the hand-drawn strokes, not
// every kind of shape; enough to know one's own document by.
//
// The sketch is an SVG that is shown as a picture (an <img>), where nothing in it runs or
// loads. Even so, only numbers, a few known words and checked colours go into it, and all text
// is escaped: nothing from a file is written into it as it stands.
import * as zlib from "zlib";
import { absolutePoints, boxOf, type El, type Point } from "../../excalidraw/geometry";

/** How many shapes a sketch draws: a card is small, and a picture of ten thousand boxes says no more than one of a thousand. */
const MAX_SHAPES = 1200;
const MAX_TEXT = 80;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : fallback);

/** A colour from a file, when it is one this code knows to be only a colour; else the fallback. */
export function safeColour(v: unknown, fallback: string): string {
	if (typeof v !== "string") return fallback;
	const c = v.trim().toLowerCase();
	if (c === "transparent" || c === "none") return "none";
	return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(c) ? c : fallback;
}

interface Shape {
	kind: "rect" | "ellipse" | "diamond" | "line" | "text";
	x: number;
	y: number;
	width: number;
	height: number;
	/** In degrees, about the shape's middle. */
	turn?: number;
	stroke: string;
	fill: string;
	strokeWidth: number;
	dashed?: boolean;
	rounded?: boolean;
	opacity?: number;
	/** A line's points on the drawing, and whether it ends in an arrowhead. */
	points?: Point[];
	arrow?: boolean;
	/** Words, in the shape's middle (or, for text, from its top left). */
	text?: string;
	fontSize?: number;
	textColour?: string;
	align?: "left" | "center" | "right";
}

/** The SVG of some shapes, in a view that holds them all with a margin. `background`: the page's colour. */
function draw(shapes: Shape[], background: string): string {
	const boxes = shapes.map((s) => (s.points && s.points.length ? { x: Math.min(...s.points.map((p) => p[0])), y: Math.min(...s.points.map((p) => p[1])), x2: Math.max(...s.points.map((p) => p[0])), y2: Math.max(...s.points.map((p) => p[1])) } : { x: s.x, y: s.y, x2: s.x + s.width, y2: s.y + s.height }));
	const x = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0, y = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
	const w = Math.max((boxes.length ? Math.max(...boxes.map((b) => b.x2)) : 320) - x, 40), h = Math.max((boxes.length ? Math.max(...boxes.map((b) => b.y2)) : 200) - y, 40);
	const pad = Math.max(w, h) * 0.06 + 8;
	const out: string[] = [];
	for (const s of shapes) {
		const common = `stroke="${s.stroke}" fill="${s.kind === "line" ? "none" : s.fill}" stroke-width="${num(s.strokeWidth, 1)}"${s.dashed ? ' stroke-dasharray="8 6"' : ""}${s.opacity !== undefined && s.opacity < 1 ? ` opacity="${num(s.opacity, 1)}"` : ""}`;
		const turn = s.turn ? ` transform="rotate(${num(s.turn)} ${num(s.x + s.width / 2)} ${num(s.y + s.height / 2)})"` : "";
		if (s.kind === "rect") out.push(`<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}"${s.rounded ? ` rx="${num(Math.min(s.width, s.height) * 0.12, 4)}"` : ""} ${common}${turn}/>`);
		else if (s.kind === "ellipse") out.push(`<ellipse cx="${num(s.x + s.width / 2)}" cy="${num(s.y + s.height / 2)}" rx="${num(s.width / 2)}" ry="${num(s.height / 2)}" ${common}${turn}/>`);
		else if (s.kind === "diamond") out.push(`<polygon points="${num(s.x + s.width / 2)},${num(s.y)} ${num(s.x + s.width)},${num(s.y + s.height / 2)} ${num(s.x + s.width / 2)},${num(s.y + s.height)} ${num(s.x)},${num(s.y + s.height / 2)}" ${common}${turn}/>`);
		else if (s.kind === "line" && s.points && s.points.length > 1) {
			out.push(`<polyline points="${s.points.map((p) => `${num(p[0])},${num(p[1])}`).join(" ")}" stroke-linejoin="round" stroke-linecap="round" ${common}/>`);
			if (s.arrow) {
				// (a small open head at the last point, turned the way the line arrives)
				const [a, b] = [s.points[s.points.length - 2], s.points[s.points.length - 1]];
				const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), size = Math.max(8, s.strokeWidth * 5);
				const wing = (d: number): string => `${num(b[0] - size * Math.cos(angle + d))},${num(b[1] - size * Math.sin(angle + d))}`;
				out.push(`<polyline points="${wing(0.45)} ${num(b[0])},${num(b[1])} ${wing(-0.45)}" stroke-linejoin="round" stroke-linecap="round" ${common}/>`);
			}
		}
		if (s.text) {
			const size = Math.max(6, Math.min(num(s.fontSize, 16), 200));
			const lines = s.text.split("\n").slice(0, 12).map((l) => (l.length > MAX_TEXT ? `${l.slice(0, MAX_TEXT)}…` : l));
			const align = s.kind === "text" ? s.align ?? "left" : "center";
			const tx = align === "left" ? s.x : align === "right" ? s.x + s.width : s.x + s.width / 2;
			// (in a shape the words sit in its middle; a text starts at its top)
			const first = s.kind === "text" ? s.y + size : s.y + s.height / 2 - ((lines.length - 1) * size * 1.25) / 2 + size * 0.35;
			out.push(`<text x="${num(tx)}" y="${num(first)}" font-size="${size}" text-anchor="${align === "left" ? "start" : align === "right" ? "end" : "middle"}" fill="${s.textColour ?? "#1e1e1e"}"${turn}>${lines.map((l, i) => `<tspan x="${num(tx)}"${i ? ` dy="${num(size * 1.25)}"` : ""}>${esc(l)}</tspan>`).join("")}</text>`);
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x - pad)} ${num(y - pad)} ${num(w + 2 * pad)} ${num(h + 2 * pad)}" font-family="system-ui, sans-serif">${background === "none" ? "" : `<rect x="${num(x - pad)}" y="${num(y - pad)}" width="${num(w + 2 * pad)}" height="${num(h + 2 * pad)}" fill="${background}"/>`}${out.join("")}</svg>`;
}

// ----- an Excalidraw drawing -----

/** A sketch of an Excalidraw scene (what a .excalidraw file holds, as read by excalidrawFile.ts). */
export function sketchExcalidraw(scene: { elements?: unknown; appState?: any }): string {
	const all: El[] = (Array.isArray(scene.elements) ? scene.elements : []).filter((e: any): e is El => e && typeof e === "object" && !e.isDeleted && typeof e.type === "string" && [e.x, e.y].every((n) => typeof n === "number" && isFinite(n)));
	const shapes: Shape[] = [];
	for (const e of all.slice(0, MAX_SHAPES)) {
		const stroke = safeColour(e.strokeColor, "#1e1e1e");
		const base = {
			...boxOf({ ...e, width: num(e.width), height: num(e.height) }),
			stroke,
			fill: safeColour(e.backgroundColor, "none"),
			strokeWidth: Math.max(1, Math.min(num(e.strokeWidth, 2), 12)),
			dashed: e.strokeStyle === "dashed" || e.strokeStyle === "dotted",
			opacity: typeof e.opacity === "number" ? Math.max(0, Math.min(e.opacity, 100)) / 100 : undefined,
			turn: typeof e.angle === "number" && isFinite(e.angle) && e.angle ? (e.angle * 180) / Math.PI : undefined,
		};
		if (e.type === "rectangle" || e.type === "image" || e.type === "embeddable" || e.type === "iframe") shapes.push({ kind: "rect", ...base, rounded: !!e.roundness, ...(e.type === "image" ? { fill: "#e9ecef", stroke: "#adb5bd", strokeWidth: 1 } : {}) });
		else if (e.type === "frame" || e.type === "magicframe") shapes.push({ kind: "rect", ...base, fill: "none", stroke: "#adb5bd", strokeWidth: 1, rounded: true });
		else if (e.type === "ellipse") shapes.push({ kind: "ellipse", ...base });
		else if (e.type === "diamond") shapes.push({ kind: "diamond", ...base });
		else if (e.type === "arrow" || e.type === "line" || e.type === "freedraw") {
			const points = absolutePoints(e).filter((p) => p.every((n) => typeof n === "number" && isFinite(n))).slice(0, 400);
			if (points.length > 1) shapes.push({ kind: "line", ...base, points, arrow: e.type === "arrow" && e.endArrowhead !== null, turn: undefined });
		} else if (e.type === "text") {
			const text = String(e.text ?? "").slice(0, 2000);
			if (text.trim()) shapes.push({ kind: "text", ...base, fill: "none", stroke: "none", text, fontSize: num(e.fontSize, 20), textColour: stroke === "none" ? "#1e1e1e" : stroke, align: e.textAlign === "center" || e.textAlign === "right" ? e.textAlign : "left" });
		}
	}
	return draw(shapes, safeColour(scene.appState?.viewBackgroundColor, "#ffffff"));
}

// ----- a draw.io diagram -----

/** What stands between `<` and `>` of a tag, as its name and attributes (entities in the values read). */
function tags(xml: string): { close: boolean; name: string; attrs: Record<string, string>; self: boolean }[] {
	const out: { close: boolean; name: string; attrs: Record<string, string>; self: boolean }[] = [];
	const tag = /<(\/?)([\w:]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
	const entity = (s: string): string =>
		s.replace(/&(#x?[0-9a-f]+|lt|gt|amp|quot|apos);/gi, (_m, e: string) => {
			if (e[0] === "#") {
				const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
			}
			return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
		});
	for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
		const attrs: Record<string, string> = {};
		for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = entity(a[2]);
		out.push({ close: m[1] === "/", name: m[2], attrs, self: m[4] === "/" });
	}
	return out;
}

/** The first page of a draw.io file as its graph model's XML: as it is, or unpacked when the file keeps it packed. */
export function firstPage(xml: string): string | undefined {
	if (xml.length > 12_000_000) return undefined;
	const page = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/.exec(xml);
	if (!page) return /<mxGraphModel\b/.test(xml) ? xml : undefined;
	const inner = page[1].trim();
	if (inner.startsWith("<")) return inner;
	try {
		// (draw.io's packing: the XML, percent-encoded, deflated, in base64)
		const unpacked = decodeURIComponent(zlib.inflateRawSync(Buffer.from(inner, "base64"), { maxOutputLength: 24_000_000 }).toString("latin1"));
		return /<mxGraphModel\b/.test(unpacked) ? unpacked : undefined;
	} catch {
		return undefined;
	}
}

/** A label as plain words: draw.io labels may be HTML. */
function words(label: string): string {
	return label
		.replace(/<br\s*\/?>|<\/(?:div|p|li|h\d)>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&(lt|gt|amp|quot);/g, (_m, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"' } as Record<string, string>)[e])
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n")
		.slice(0, 600);
}

function styleOf(style: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of style.split(";")) {
		const at = part.indexOf("=");
		if (at < 0) {
			if (part.trim()) out[part.trim()] = "1";
		} else out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
	}
	return out;
}

/** A sketch of a draw.io file's first page; undefined when the file is not one this code can read. */
export function sketchDrawio(xml: string): string | undefined {
	const page = firstPage(xml);
	if (!page) return undefined;
	interface Cell {
		id: string;
		parent?: string;
		label: string;
		style: Record<string, string>;
		vertex: boolean;
		edge: boolean;
		source?: string;
		target?: string;
		x: number;
		y: number;
		width: number;
		height: number;
		relative: boolean;
		via: Point[];
		from?: Point;
		to?: Point;
	}
	const cells = new Map<string, Cell>();
	let wrapper: { id?: string; label?: string } | undefined;
	let current: Cell | undefined;
	let inPoints = false;
	for (const t of tags(page)) {
		if (cells.size > MAX_SHAPES * 2) break;
		if (t.name === "object" || t.name === "UserObject") {
			wrapper = t.close ? undefined : { id: t.attrs.id, label: t.attrs.label };
		} else if (t.name === "mxCell") {
			if (t.close) {
				current = undefined;
				continue;
			}
			const id = t.attrs.id ?? wrapper?.id;
			if (!id) continue;
			const cell: Cell = { id, parent: t.attrs.parent, label: words(String(t.attrs.value ?? wrapper?.label ?? "")), style: styleOf(String(t.attrs.style ?? "")), vertex: t.attrs.vertex === "1", edge: t.attrs.edge === "1", source: t.attrs.source, target: t.attrs.target, x: 0, y: 0, width: 0, height: 0, relative: false, via: [] };
			cells.set(id, cell);
			current = t.self ? undefined : cell;
		} else if (t.name === "mxGeometry" && current && !t.close) {
			current.x = Number(t.attrs.x) || 0;
			current.y = Number(t.attrs.y) || 0;
			current.width = Number(t.attrs.width) || 0;
			current.height = Number(t.attrs.height) || 0;
			current.relative = t.attrs.relative === "1";
		} else if (t.name === "Array") {
			inPoints = !t.close && t.attrs.as === "points" && !t.self;
		} else if (t.name === "mxPoint" && current && !t.close) {
			const p: Point = [Number(t.attrs.x) || 0, Number(t.attrs.y) || 0];
			if (t.attrs.as === "sourcePoint") current.from = p;
			else if (t.attrs.as === "targetPoint") current.to = p;
			else if (inPoints && current.via.length < 40) current.via.push(p);
		}
	}
	// (a cell in a group or a container is placed from that one's corner)
	const origin = (id: string | undefined, depth = 0): Point => {
		const parent = id ? cells.get(id) : undefined;
		if (!parent || !parent.vertex || depth > 20) return [0, 0];
		const o = origin(parent.parent, depth + 1);
		return [o[0] + parent.x, o[1] + parent.y];
	};
	const placed = new Map<string, { x: number; y: number; width: number; height: number }>();
	for (const c of cells.values()) {
		if (!c.vertex || c.relative || !(c.width > 0 && c.height > 0)) continue;
		const o = origin(c.parent);
		placed.set(c.id, { x: o[0] + c.x, y: o[1] + c.y, width: c.width, height: c.height });
	}
	// (what holds other shapes: a group, a container, a swimlane)
	const holders = new Set<string>();
	for (const c of cells.values()) if (c.vertex && c.parent && placed.has(c.parent)) holders.add(c.parent);
	const backdrop: Shape[] = [];
	const shapes: Shape[] = [];
	const lines: Shape[] = [];
	for (const c of cells.values()) {
		if (backdrop.length + shapes.length + lines.length >= MAX_SHAPES) break;
		const stroke = safeColour(c.style.strokeColor, "#1e1e1e");
		const strokeWidth = Math.max(1, Math.min(Number(c.style.strokeWidth) || 1, 12));
		const textColour = safeColour(c.style.fontColor, "#1e1e1e");
		if (c.edge) {
			const o = origin(c.parent);
			const end = (id: string | undefined, point: Point | undefined): Point | undefined => {
				const box = id ? placed.get(id) : undefined;
				return box ? [box.x + box.width / 2, box.y + box.height / 2] : point ? [o[0] + point[0], o[1] + point[1]] : undefined;
			};
			const from = end(c.source, c.from), to = end(c.target, c.to);
			if (!from || !to) continue;
			const points: Point[] = [from, ...c.via.map((p): Point => [o[0] + p[0], o[1] + p[1]]), to];
			lines.push({ kind: "line", x: 0, y: 0, width: 0, height: 0, stroke: stroke === "none" ? "#1e1e1e" : stroke, fill: "none", strokeWidth, dashed: c.style.dashed === "1", points, arrow: c.style.endArrow !== "none" });
			continue;
		}
		const box = placed.get(c.id);
		if (!box) continue;
		const isText = "text" in c.style || (c.style.strokeColor === "none" && c.style.fillColor === "none");
		const kind: Shape["kind"] = "ellipse" in c.style || c.style.shape === "ellipse" ? "ellipse" : "rhombus" in c.style || c.style.shape === "rhombus" ? "diamond" : "rect";
		(holders.has(c.id) ? backdrop : shapes).push({
			kind,
			...box,
			stroke: isText ? "none" : stroke,
			fill: isText ? "none" : safeColour(c.style.fillColor, "#ffffff"),
			strokeWidth,
			dashed: c.style.dashed === "1",
			rounded: c.style.rounded === "1",
			turn: Number(c.style.rotation) || undefined,
			opacity: c.style.opacity !== undefined && isFinite(Number(c.style.opacity)) ? Math.max(0, Math.min(Number(c.style.opacity), 100)) / 100 : undefined,
			text: c.label || undefined,
			fontSize: Number(c.style.fontSize) || 12,
			textColour: textColour === "none" ? "#1e1e1e" : textColour,
		});
	}
	// Drawn in this order: what holds other shapes, then the lines, then the shapes. A line runs to
	// the middle of the shape it ends at and the shape is drawn over it, which is how it comes to end
	// at the shape's edge; what holds shapes must be under the lines between them.
	return draw([...backdrop, ...lines, ...shapes], "#ffffff");
}
