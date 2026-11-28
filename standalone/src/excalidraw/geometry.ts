// Where things are in an Excalidraw drawing, and how a line gets from one element to another.
// Plain numbers on plain elements: no Excalidraw, no page.

/** An Excalidraw element, as far as this code needs to know it. */
export type El = { id: string; type: string; x: number; y: number; width: number; height: number; [key: string]: any };
export type Point = [number, number];
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

const LINES = new Set(["arrow", "line", "freedraw"]);

export const isLine = (el: { type: string }): boolean => el.type === "arrow" || el.type === "line";

/** The element's points on the drawing (a line keeps them relative to its own x and y). */
export function absolutePoints(el: El): Point[] {
	const points: Point[] = Array.isArray(el.points) ? el.points : [];
	return points.map((p) => [el.x + p[0], el.y + p[1]]);
}

/** The box around an element, not turned (a turned element's box is the one it had before it was turned). */
export function boxOf(el: El): Box {
	if (LINES.has(el.type) && Array.isArray(el.points) && el.points.length > 0) {
		const points = absolutePoints(el);
		const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
		const x = Math.min(...xs), y = Math.min(...ys);
		return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
	}
	// (a shape drawn right to left has a negative width)
	return { x: Math.min(el.x, el.x + el.width), y: Math.min(el.y, el.y + el.height), width: Math.abs(el.width), height: Math.abs(el.height) };
}

/** The box around several elements; undefined for none. */
export function boxAround(elements: El[]): Box | undefined {
	if (elements.length === 0) return undefined;
	const boxes = elements.map(boxOf);
	const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
	return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

export function centerOf(el: El): Point {
	const b = boxOf(el);
	return [b.x + b.width / 2, b.y + b.height / 2];
}

/**
 * Where a line coming from `from` meets the outline of `el`, stepped back by `gap`: on the
 * ellipse of an ellipse, the edges of a diamond, and the box of anything else. When `from` is
 * inside the element (or on its centre) the point is on its right-hand edge. A turned element's
 * outline is turned with it: the line is looked at from the element's own side (turned back
 * about its centre), met with the outline there, and the point turned forth again.
 */
export function edgePoint(el: El, from: Point, gap = 0): Point {
	const b = boxOf(el);
	const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
	const rx = Math.max(b.width / 2, 0.5), ry = Math.max(b.height / 2, 0.5);
	const angle = !isLine(el) && typeof el.angle === "number" && isFinite(el.angle) ? el.angle : 0;
	if (angle) from = turned(from, [cx, cy], -angle);
	let dx = from[0] - cx, dy = from[1] - cy;
	if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
		dx = 1;
		dy = 0;
	}
	// how far along (dx, dy) from the centre the outline is
	let t: number;
	if (el.type === "ellipse") t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
	else if (el.type === "diamond") t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
	else t = Math.min(rx / Math.max(Math.abs(dx), 1e-9), ry / Math.max(Math.abs(dy), 1e-9));
	const length = Math.hypot(dx, dy);
	// (never past the point the line comes from: two elements that touch get a line of no length, not one that turns back)
	const reach = Math.min(t * length + gap, Math.max(t * length, length));
	const point: Point = [cx + (dx / length) * reach, cy + (dy / length) * reach];
	return angle ? turned(point, [cx, cy], angle) : point;
}

/**
 * How far outside an element's box a point is (0 when it is in it), the box turned as the
 * element is. For telling whether a line's end is still at the element it is attached to.
 */
export function distanceOutside(el: El, point: Point): number {
	const b = boxOf(el);
	const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
	const angle = !isLine(el) && typeof el.angle === "number" && isFinite(el.angle) ? el.angle : 0;
	const p = angle ? turned(point, [cx, cy], -angle) : point;
	return Math.hypot(Math.max(Math.abs(p[0] - cx) - b.width / 2, 0), Math.max(Math.abs(p[1] - cy) - b.height / 2, 0));
}

/** A point turned about another by an angle (in radians, clockwise on the drawing, where y grows downwards). */
export function turned(p: Point, about: Point, angle: number): Point {
	const cos = Math.cos(angle), sin = Math.sin(angle);
	const dx = p[0] - about[0], dy = p[1] - about[1];
	return [about[0] + dx * cos - dy * sin, about[1] + dx * sin + dy * cos];
}

/** A line's place, as Excalidraw keeps it: where it starts, its points from there, and the size of the box around them. */
export interface Route {
	x: number;
	y: number;
	points: Point[];
	width: number;
	height: number;
}

/** A line through these points on the drawing. */
export function routeThrough(points: Point[]): Route {
	const [x, y] = points[0];
	const relative = points.map((p) => [round(p[0] - x), round(p[1] - y)] as Point);
	const xs = relative.map((p) => p[0]), ys = relative.map((p) => p[1]);
	return { x: round(x), y: round(y), points: relative, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** How far a line's end stays from the element it is attached to. */
export const LINE_GAP = 6;

/**
 * A line between two ends, each an element (the line stops at its outline) or a point. `via`:
 * the points it passes on the way (a line that bends), which stay where they are.
 */
export function routeBetween(start: El | Point, end: El | Point, via: Point[] = []): Route {
	const isPoint = (v: El | Point): v is Point => Array.isArray(v);
	const aim = (v: El | Point): Point => (isPoint(v) ? v : centerOf(v));
	const first = isPoint(start) ? start : edgePoint(start, via[0] ?? aim(end), LINE_GAP);
	const last = isPoint(end) ? end : edgePoint(end, via[via.length - 1] ?? aim(start), LINE_GAP);
	return routeThrough([first, ...via, last]);
}

/** A free place for something `size` large: to the right of what is there, level with its top; the origin when there is nothing. */
export function freePlace(existing: El[], gap = 80): Point {
	const box = boxAround(existing);
	return box ? [round(box.x + box.width + gap), round(box.y)] : [0, 0];
}

export const round = (n: number): number => Math.round(n * 100) / 100;
