import type { MapGraph, MapNode } from "./types";

/** A node's box, relative to its parent container (draw.io child geometry). */
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Layout {
	boxes: Map<string, Box>;
	width: number;
	height: number;
}

export const SIZES = {
	icon: 56,
	/** Room under an icon for its label. */
	iconLabel: 36,
	iconSlot: 120,
	boxW: 150,
	boxH: 56,
	tableMinW: 200,
	tableHeader: 30,
	tableRow: 22,
	/** Rows drawn per table; the rest is summarized in one row. */
	tableMaxRows: 40,
	noteW: 280,
	pad: 24,
	containerHeader: 34,
	gap: 40,
	layerGap: 70,
	/** A layer with more nodes than this wraps into several rows. */
	maxPerLayerRow: 10,
};

interface Size {
	w: number;
	h: number;
}

/** Width of a text in pixels at draw.io's default 12px font, roughly. */
const textWidth = (s: string, px = 7) => Math.ceil(s.length * px);

export function tableRows(n: MapNode): number {
	const rows = n.rows?.length ?? 0;
	return rows > SIZES.tableMaxRows ? SIZES.tableMaxRows + 1 : rows;
}

/** The cell's own size (what is drawn). */
export function cellSize(n: MapNode): Size {
	switch (n.shape) {
		case "icon":
			return { w: n.width ?? SIZES.icon, h: n.height ?? SIZES.icon };
		case "table": {
			const longest = Math.max(textWidth(n.label, 8), ...(n.rows ?? []).slice(0, SIZES.tableMaxRows).map((r) => textWidth(`${r.key ? r.key + " " : ""}${r.text} ${r.detail ?? ""}`)));
			return { w: n.width ?? Math.min(420, Math.max(SIZES.tableMinW, longest + 30)), h: n.height ?? SIZES.tableHeader + Math.max(1, tableRows(n)) * SIZES.tableRow };
		}
		case "note": {
			const lines = Math.max(1, Math.ceil(textWidth(n.label) / (SIZES.noteW - 20)) + (n.label.match(/\n/g)?.length ?? 0));
			return { w: n.width ?? SIZES.noteW, h: n.height ?? 20 + lines * 18 };
		}
		default:
			return { w: n.width ?? Math.max(SIZES.boxW, Math.min(260, textWidth(n.label) + 30)), h: n.height ?? SIZES.boxH };
	}
}

/** The room a leaf takes in the layout (icons need space for the label below). */
function footprint(n: MapNode): Size {
	const s = cellSize(n);
	return n.shape === "icon" ? { w: Math.max(s.w, SIZES.iconSlot, Math.min(200, textWidth(n.label) + 10)), h: s.h + SIZES.iconLabel } : s;
}

/**
 * Lays out a map: containers are sized to hold their children; inside each
 * container (and at the top level) connected children get a layered layout in
 * the graph's direction, unconnected ones are packed in rows.
 */
export function layoutGraph(graph: MapGraph): Layout {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const children = new Map<string | undefined, MapNode[]>();
	for (const n of graph.nodes) {
		const parent = n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : undefined;
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(n);
	}
	// Guard against parent cycles: a node is reachable from the top only once.
	const chain = (id: string): string[] => {
		const out: string[] = [];
		const seen = new Set<string>();
		for (let cur: string | undefined = id; cur && byId.has(cur) && !seen.has(cur); cur = byId.get(cur)!.parent) {
			seen.add(cur);
			out.push(cur);
		}
		return out;
	};
	const ancestors = new Map(graph.nodes.map((n) => [n.id, chain(n.id)]));
	const boxes = new Map<string, Box>();
	const sizes = new Map<string, Size>();
	const direction = graph.direction ?? "down";
	const visiting = new Set<string>();

	const sizeOf = (n: MapNode): Size => {
		const known = sizes.get(n.id);
		if (known) return known;
		const kids = children.get(n.id) ?? [];
		let s: Size;
		if ((n.container || kids.length > 0) && n.shape !== "table" && !visiting.has(n.id)) {
			visiting.add(n.id);
			const inner = arrange(n.id, kids);
			visiting.delete(n.id);
			s = {
				w: Math.max(inner.w + 2 * SIZES.pad, textWidth(n.label, 8) + 40, n.width ?? 0),
				h: Math.max(inner.h + 2 * SIZES.pad + SIZES.containerHeader - SIZES.pad / 2, SIZES.containerHeader + 40, n.height ?? 0),
			};
		} else {
			s = footprint(n);
		}
		sizes.set(n.id, s);
		return s;
	};

	/** Positions `items` (the children of `parentId`) and returns the size they cover. */
	function arrange(parentId: string | undefined, items: MapNode[]): Size {
		if (items.length === 0) return { w: 0, h: 0 };
		const offset = parentId ? { x: SIZES.pad, y: SIZES.containerHeader } : { x: 0, y: 0 };
		const ids = new Set(items.map((i) => i.id));
		// Edges between descendants count as edges between the children that hold them.
		const under = (nodeId: string): string | undefined => {
			const chainIds = ancestors.get(nodeId) ?? [];
			const i = parentId === undefined ? chainIds.length - 1 : chainIds.indexOf(parentId) - 1;
			return i >= 0 && ids.has(chainIds[i]) ? chainIds[i] : undefined;
		};
		const local: [string, string][] = [];
		const seenPairs = new Set<string>();
		for (const e of graph.edges) {
			if (!byId.has(e.from) || !byId.has(e.to)) continue;
			const a = under(e.from);
			const b = under(e.to);
			if (a && b && a !== b && !seenPairs.has(`${a}\u0000${b}`)) {
				seenPairs.add(`${a}\u0000${b}`);
				local.push([a, b]);
			}
		}
		for (const item of items) sizeOf(item);
		const connected = new Set(local.flat());
		const linked = items.filter((i) => connected.has(i.id));
		const loose = items.filter((i) => !connected.has(i.id));
		let w = 0;
		let h = 0;
		if (linked.length > 1) {
			const s = layered(linked, local, offset);
			w = s.w;
			h = s.h;
		}
		if (loose.length) {
			const top = h ? h + SIZES.gap : 0;
			const s = shelf(loose, { x: offset.x, y: offset.y + top });
			w = Math.max(w, s.w);
			h = top + s.h;
		}
		return { w, h };
	}

	function place(n: MapNode, x: number, y: number, slot: Size): void {
		const isLeaf = !(n.container || (children.get(n.id)?.length ?? 0) > 0) || n.shape === "table";
		const cell = isLeaf ? cellSize(n) : slot;
		// Icons sit at the top of their slot, centred; other leaves fill it.
		const dx = n.shape === "icon" ? (slot.w - cell.w) / 2 : 0;
		boxes.set(n.id, { x: Math.round(x + dx), y: Math.round(y), width: Math.round(cell.w), height: Math.round(cell.h) });
	}

	/** Rows of items, wrapping at a width that keeps the block roughly 4:3. Containers come first. */
	function shelf(items: MapNode[], origin: { x: number; y: number }): Size {
		const ordered = [...items.filter((i) => sizes.get(i.id)!.h > SIZES.boxH * 2), ...items.filter((i) => sizes.get(i.id)!.h <= SIZES.boxH * 2)];
		const area = ordered.reduce((a, i) => a + (sizes.get(i.id)!.w + SIZES.gap) * (sizes.get(i.id)!.h + SIZES.gap), 0);
		const widest = Math.max(...ordered.map((i) => sizes.get(i.id)!.w));
		const rowWidth = Math.max(widest, Math.sqrt(area * 1.6));
		let x = 0;
		let y = 0;
		let rowH = 0;
		let w = 0;
		for (const item of ordered) {
			const s = sizes.get(item.id)!;
			if (x > 0 && x + s.w > rowWidth) {
				x = 0;
				y += rowH + SIZES.gap;
				rowH = 0;
			}
			place(item, origin.x + x, origin.y + y, s);
			x += s.w + SIZES.gap;
			rowH = Math.max(rowH, s.h);
			w = Math.max(w, x - SIZES.gap);
		}
		return { w, h: y + rowH };
	}

	/** Longest-path layering with barycentre ordering; cycles are broken in DFS order. */
	function layered(items: MapNode[], edges: [string, string][], origin: { x: number; y: number }): Size {
		const order = new Map(items.map((n, i) => [n.id, i]));
		const out = new Map<string, string[]>(items.map((n) => [n.id, []]));
		for (const [a, b] of edges) if (out.has(a) && out.has(b)) out.get(a)!.push(b);
		// Drop back edges so the rest is a DAG.
		const state = new Map<string, 1 | 2>();
		const forward: [string, string][] = [];
		const visit = (v: string) => {
			state.set(v, 1);
			for (const t of out.get(v)!) {
				if (state.get(t) === 1) continue;
				forward.push([v, t]);
				if (!state.has(t)) visit(t);
			}
			state.set(v, 2);
		};
		for (const n of items) if (!state.has(n.id)) visit(n.id);
		const preds = new Map<string, string[]>(items.map((n) => [n.id, []]));
		for (const [a, b] of forward) preds.get(b)!.push(a);
		const layer = new Map<string, number>();
		const layerOf = (v: string, guard = 0): number => {
			if (layer.has(v)) return layer.get(v)!;
			const l = guard > items.length ? 0 : Math.max(-1, ...preds.get(v)!.map((p) => layerOf(p, guard + 1))) + 1;
			layer.set(v, l);
			return l;
		};
		items.forEach((n) => layerOf(n.id));
		const layers: string[][] = [];
		for (const n of items) (layers[layer.get(n.id)!] ??= []).push(n.id);
		// Barycentre sweeps, down then up.
		const neighbours = (v: string, dir: "up" | "down") => (dir === "up" ? preds.get(v)! : forward.filter(([a]) => a === v).map(([, b]) => b));
		for (let sweep = 0; sweep < 4; sweep++) {
			const down = sweep % 2 === 0;
			const seq = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
			for (const li of seq) {
				const ref = layers[down ? li - 1 : li + 1];
				if (!ref) continue;
				const pos = new Map(ref.map((v, i) => [v, i]));
				const bary = (v: string) => {
					const ns = neighbours(v, down ? "up" : "down").filter((u) => pos.has(u));
					return ns.length ? ns.reduce((a, u) => a + pos.get(u)!, 0) / ns.length : Number.POSITIVE_INFINITY;
				};
				layers[li] = [...layers[li]].sort((a, b) => {
					const d = bary(a) - bary(b);
					return Number.isFinite(d) && d !== 0 ? d : order.get(a)! - order.get(b)!;
				});
			}
		}
		const byIdLocal = new Map(items.map((n) => [n.id, n]));
		// Wrap very wide layers into several rows.
		const rows: string[][] = [];
		for (const l of layers.filter(Boolean)) for (let i = 0; i < l.length; i += SIZES.maxPerLayerRow) rows.push(l.slice(i, i + SIZES.maxPerLayerRow));
		const across = (id: string) => (direction === "down" ? sizes.get(id)!.w : sizes.get(id)!.h);
		const along = (id: string) => (direction === "down" ? sizes.get(id)!.h : sizes.get(id)!.w);
		const rowSpan = rows.map((r) => r.reduce((a, id) => a + across(id), 0) + SIZES.gap * (r.length - 1));
		const maxSpan = Math.max(...rowSpan);
		let pos = 0;
		rows.forEach((r, ri) => {
			let c = (maxSpan - rowSpan[ri]) / 2;
			const depth = Math.max(...r.map(along));
			for (const id of r) {
				const s = sizes.get(id)!;
				const offsetAlong = (depth - along(id)) / 2;
				if (direction === "down") place(byIdLocal.get(id)!, origin.x + c, origin.y + pos + offsetAlong, s);
				else place(byIdLocal.get(id)!, origin.x + pos + offsetAlong, origin.y + c, s);
				c += across(id) + SIZES.gap;
			}
			pos += depth + SIZES.layerGap;
		});
		const total = pos - SIZES.layerGap;
		return direction === "down" ? { w: maxSpan, h: total } : { w: total, h: maxSpan };
	}

	// Bottom-up: sizing a container (sizeOf) arranges its children relative to it, then
	// its parent places it.
	const size = arrange(undefined, children.get(undefined) ?? []);
	return { boxes, width: size.w, height: size.h };
}
