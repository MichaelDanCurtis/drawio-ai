import type { CustomizedDrawioClient } from "../../../../src/DrawioClient/CustomizedDrawioClient";
import { escapeXml, mapCellId, MAX_ROUTED_EDGES, renderGraph } from "./render";
import type { MapGraph } from "./types";

export { MAX_ROUTED_EDGES };

/** How the last map's connectors were routed (the end-to-end run reads it). */
export let lastRouting: { edges: number; ms: number; error?: string; /** A map too large to route as one: how many of its boxes were routed. */ groups?: number } | undefined;

/** How long the box-by-box routing of a very large map may take before the rest is left as drawn. */
export const ROUTE_BUDGET_MS = 6000;

/**
 * The top-level boxes of a map with connectors of their own (both ends inside the box, or on
 * it), the ones with the fewest first; a box with more than can be routed as one is left out.
 */
export function routeGroups(graph: MapGraph): { id: string; edges: number }[] {
	const parent = new Map(graph.nodes.map((n) => [n.id, n.parent]));
	const top = (id: string): string | undefined => {
		let at: string | undefined = id;
		for (let i = 0; i < 50 && at !== undefined && parent.has(at); i++) {
			const up: string | undefined = parent.get(at);
			if (up === undefined || !parent.has(up)) return at;
			at = up;
		}
		return undefined;
	};
	const inside = new Map<string, number>();
	for (const e of graph.edges) {
		const a = top(e.from);
		// (counted as the router takes them: every connector with both ends in the box or on the box itself.
		// One between two shapes that are themselves at the top is between boxes.)
		if (a !== undefined && a === top(e.to)) inside.set(a, (inside.get(a) ?? 0) + 1);
	}
	return [...inside].map(([id, edges]) => ({ id, edges })).filter((g) => g.edges <= MAX_ROUTED_EDGES).sort((a, b) => a.edges - b.edges || a.id.localeCompare(b.id));
}

export interface DrawResult {
	/** Name of the page the map is on. */
	page: string;
	/** Whether a page was added for it. */
	newPage: boolean;
	cells: number;
}

/**
 * Draws a map into the open diagram as one pending AI change the user keeps or
 * reverts: on the current page when it is empty, otherwise on a new page.
 */
export async function drawMap(
	client: CustomizedDrawioClient,
	graph: MapGraph,
	recipe: string,
	opts: { mapId?: string; descriptions?: Record<string, string>; forceNewPage?: boolean; /** Show the map being built (Settings → Editor). */ animate?: boolean } = {}
): Promise<DrawResult> {
	const current = await client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 1 });
	let page = current.page.name;
	let newPage = false;
	if (current.totalCells > 0 || opts.forceNewPage) {
		const names = new Set((await client.aiPages({ op: "list" })).pages.map((p) => p.name));
		let name = graph.title.slice(0, 80);
		for (let i = 2; names.has(name); i++) name = `${graph.title.slice(0, 74)} (${i})`;
		const added = await client.aiPages({ op: "add", name, select: true, review: true });
		if (added.error) throw new Error(`Could not add a page for the map: ${added.error}`);
		page = name;
		newPage = true;
	}
	const { xml, cells } = renderGraph(graph, { recipe, mapId: opts.mapId, descriptions: opts.descriptions });
	// Shown being built, the map is drawn and its connectors routed as one edit: a second edit would end
	// the showing of the first as it begins, and the map would be built with lines that then jump. The
	// page holds nothing but the map (it was empty, or is new), so the routing needs no ids. Not all or
	// nothing: a router that fails leaves the map drawn.
	const routable = graph.edges.length > 0 && graph.edges.length <= MAX_ROUTED_EDGES;
	const together = !!opts.animate && routable;
	const began = Date.now();
	const r = await client.aiApplyOps(together ? [{ op: "insertXml", xml }, { op: "layout", type: "route" }] : [{ op: "insertXml", xml }], {
		selectResult: false,
		flash: true,
		atomic: !together,
		review: true,
		...(opts.animate ? { animate: true } : {}),
	});
	const failed = together ? (r.results[0]?.ok ? undefined : r.results[0] ?? { error: "nothing was drawn" }) : r.results.find((x) => !x.ok);
	if (failed || r.rolledBack) throw new Error(`Drawing the map failed: ${failed?.error ?? "the change was rolled back"}`);
	if (together) lastRouting = { edges: r.results[1]?.ok ? r.results[1].ids?.length ?? 0 : 0, ms: Date.now() - began, ...(r.results[1]?.ok ? {} : { error: r.results[1]?.error ?? "not routed" }) };
	// The Mapper places the shapes; draw.io's connector would then run each line straight through
	// whatever lies between its ends, and stack the ones that leave a shape on the same side. Its
	// router takes them around the shapes and apart. (A step of its own, and one that may fail: a
	// map with plain connectors is still a map. Very large maps are left as they are: routing every
	// connector around every shape takes too long there.) Only what was just drawn is routed: by
	// its ids, and on the page it was drawn on. Should the user have turned to another page
	// meanwhile, the step does nothing there, also when that page is a map with the same ids.
	const drawn = (together ? r.results.slice(0, 1) : r.results).flatMap((x) => x.ids ?? []);
	if (together) {
		// routed with the drawing
	} else if (r.page && drawn.length > 0 && routable) {
		try {
			const started = Date.now();
			const routed = await client.aiApplyOps([{ op: "layout", type: "route", ids: drawn }], { selectResult: false, flash: false, atomic: true, review: true, page: r.page });
			lastRouting = { edges: routed.results[0]?.ids?.length ?? 0, ms: Date.now() - started, error: routed.results.find((x) => !x.ok)?.error };
		} catch (e: any) {
			// as drawn
			lastRouting = { edges: 0, ms: 0, error: String(e?.message ?? e) };
		}
	} else if (r.page && drawn.length > 0 && graph.edges.length > MAX_ROUTED_EDGES) {
		// Too many connectors to route as one: the ones inside each top-level box are routed, box by
		// box, the smallest first, for as long as it stays quick. What runs between the boxes is left
		// as drawn. (A box's connectors are its own affair; the long ones between boxes are what costs.)
		const started = Date.now();
		let edges = 0;
		let groups = 0;
		let error: string | undefined;
		for (const group of routeGroups(graph)) {
			if (Date.now() - started > ROUTE_BUDGET_MS) break;
			const id = mapCellId(graph, group.id);
			if (!id || !drawn.includes(id)) continue;
			try {
				const routed = await client.aiApplyOps([{ op: "layout", type: "route", ids: [id] }], { selectResult: false, flash: false, atomic: true, review: true, page: r.page });
				const failedStep = routed.results.find((x) => !x.ok)?.error;
				if (failedStep) {
					// (the page was left, or the router is not there: the rest would fail the same way)
					error = failedStep;
					break;
				}
				edges += routed.results[0]?.ids?.length ?? 0;
				groups++;
			} catch (e: any) {
				error = String(e?.message ?? e);
				break;
			}
		}
		lastRouting = { edges, ms: Date.now() - started, groups, ...(error ? { error } : {}) };
	}
	return { page, newPage, cells };
}

/** The mapped shapes among the selection (shapes the Mapper drew carry `mapper`). */
export async function mappedSelection(client: CustomizedDrawioClient): Promise<{ recipe: string; label: string; data: Record<string, string> }[]> {
	if (client.currentSelection.length === 0) return [];
	const model = await client.aiGetModel({ scope: "selection", includeStyles: false, maxCells: 300 });
	return model.cells
		.filter((c) => c.selected !== false && !c.context && c.data?.mapper && c.data.mapperKind !== "legend" && !OVERLAY_KINDS.has(c.data.mapperKind))
		.map((c) => ({ recipe: c.data!.mapper, label: c.label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), data: c.data! }));
}

// ----- the maps on a page, and overlays on them -----

/** Badges the app adds on top of a map; they live on a layer of their own. */
export const OVERLAY_KINDS = new Set(["finding-badge", "change-badge"]);

export interface PlacedCell {
	cellId: string;
	nodeId: string;
	mapId: string;
	/** Absolute position on the page. */
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Every shape of the maps on the shown page, by map, with absolute positions. */
export async function mapsOnPage(client: CustomizedDrawioClient): Promise<{ pageName: string; maps: Map<string, Map<string, PlacedCell>>; overlayCells: { id: string; mapId: string; kind: string }[]; layers: { id: string; name: string }[] }> {
	const model = await client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 20000 });
	const byId = new Map(model.cells.map((c) => [c.id, c]));
	const abs = (id: string, guard = 0): { x: number; y: number } => {
		const c = byId.get(id);
		if (!c?.geometry) return { x: 0, y: 0 };
		const p = c.parent && guard < 40 ? abs(c.parent, guard + 1) : { x: 0, y: 0 };
		return { x: p.x + c.geometry.x, y: p.y + c.geometry.y };
	};
	const maps = new Map<string, Map<string, PlacedCell>>();
	const overlayCells: { id: string; mapId: string; kind: string }[] = [];
	for (const c of model.cells) {
		const d = c.data;
		if (!d?.mapId) continue;
		if (OVERLAY_KINDS.has(d.mapperKind)) {
			overlayCells.push({ id: c.id, mapId: d.mapId, kind: d.mapperKind });
			continue;
		}
		if (!d.mapperId || !c.geometry || c.kind === "edge") continue;
		const { x, y } = abs(c.id);
		if (!maps.has(d.mapId)) maps.set(d.mapId, new Map());
		maps.get(d.mapId)!.set(d.mapperId, { cellId: c.id, nodeId: d.mapperId, mapId: d.mapId, x, y, width: c.geometry.width, height: c.geometry.height });
	}
	return { pageName: model.page.name, maps, overlayCells, layers: model.layers };
}

export interface Badge {
	nodeId: string;
	text: string;
	fill: string;
	fontColor?: string;
	tooltip: string;
	data?: Record<string, string>;
}

/**
 * Replaces one kind of overlay badges of a map with new ones, on a layer of their
 * own ("Health", "Changes") that can be hidden from draw.io's Layers panel.
 * Badges sit on the top-right corner of their shape. One pending change.
 */
export async function drawBadges(client: CustomizedDrawioClient, mapId: string, kind: "finding-badge" | "change-badge", layerName: string, badges: Badge[]): Promise<number> {
	const page = await mapsOnPage(client);
	const cells = page.maps.get(mapId);
	const ops: AiOp[] = [];
	const stale = page.overlayCells.filter((o) => o.mapId === mapId && o.kind === kind).map((o) => o.id);
	if (stale.length) ops.push({ op: "delete", ids: stale, includeEdges: false });
	if (!cells || badges.length === 0) {
		if (ops.length) await client.aiApplyOps(ops, { selectResult: false, flash: false, atomic: true, review: true });
		return 0;
	}
	const layer = page.layers.find((l) => l.name === layerName);
	let parent = layer?.id;
	if (!parent) {
		ops.push({ op: "addLayer", tempId: "$overlay", name: layerName, position: "front" });
		parent = "$overlay";
	}
	// Several badges on one shape stack to the left.
	const perNode = new Map<string, number>();
	const parts: string[] = ['<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'];
	let n = 0;
	for (const b of badges) {
		const c = cells.get(b.nodeId);
		if (!c) continue;
		const k = perNode.get(b.nodeId) ?? 0;
		perNode.set(b.nodeId, k + 1);
		const w = Math.max(20, b.text.length * 7 + 10);
		const x = Math.round(c.x + c.width - w / 2 - k * (w + 4));
		const y = Math.round(c.y - 10);
		const attrs: Record<string, string> = { mapper: "overlay", mapperKind: kind, mapId, mapperId: `${kind}:${b.nodeId}:${k}`, forNode: b.nodeId, tooltip: b.tooltip, ...(b.data ?? {}) };
		const style = `rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=${b.fill};strokeColor=#ffffff;strokeWidth=1.5;fontColor=${b.fontColor ?? "#ffffff"};fontStyle=1;fontSize=10;spacing=0;resizable=0;movable=1;`;
		parts.push(
			`<object id="b${++n}" label="${escapeXml(b.text)}"${Object.entries(attrs).map(([key, v]) => ` ${key}="${escapeXml(v)}"`).join("")}><mxCell style="${escapeXml(style)}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="20" as="geometry"/></mxCell></object>`
		);
	}
	parts.push("</root></mxGraphModel>");
	if (n) ops.push({ op: "insertXml", xml: parts.join(""), parent });
	if (!ops.length) return 0;
	const r = await client.aiApplyOps(ops, { selectResult: false, flash: false, atomic: true, review: true });
	const failed = r.results.find((x) => !x.ok);
	if (failed || r.rolledBack) throw new Error(`Drawing the badges failed: ${failed?.error ?? "rolled back"}`);
	return n;
}

/** Sets the shapes' tooltips (plain-English descriptions) of a map on the shown page. */
export async function applyDescriptions(client: CustomizedDrawioClient, mapId: string, items: { nodeId: string; description: string }[]): Promise<number> {
	const page = await mapsOnPage(client);
	const cells = page.maps.get(mapId);
	if (!cells) throw new Error("That map is not on the page shown in the editor. Show its page first.");
	const ops: AiOp[] = [];
	for (const it of items) {
		const c = cells.get(it.nodeId);
		if (c) ops.push({ op: "update", id: c.cellId, data: { tooltip: it.description } });
	}
	if (!ops.length) return 0;
	const r = await client.aiApplyOps(ops, { selectResult: false, flash: false, atomic: false, review: true });
	return r.results.filter((x) => x.ok).length;
}
