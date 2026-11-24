import { cellSize, Layout, layoutGraph, SIZES } from "./layout";
import type { MapGraph, MapNode } from "./types";

/** Default draw.io styles per shape. Collectors pass their own (vendor icons, group boxes). */
export const STYLES = {
	container:
		"rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=none;strokeColor=#8b95a1;",
	box: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
	icon: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;",
	table:
		"swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;rounded=1;arcSize=4;",
	tableRow:
		"text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=6;spacingRight=4;overflow=hidden;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;rotatable=0;whiteSpace=wrap;html=1;fontSize=11;",
	note: "shape=note;whiteSpace=wrap;html=1;size=14;fillColor=#fff2cc;strokeColor=#d6b656;align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fontSize=11;",
	edge: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#6b7280;fontSize=10;",
};

/**
 * Above this many connectors a map's lines are left plain: neither routed around the shapes
 * (see drawMap) nor drawn hopping over each other. Both compare every connector with the others,
 * which a very large map pays for on every redraw.
 */
export const MAX_ROUTED_EDGES = 600;
/** Where two connectors cross, one hops over the other: a crossing is not read as a junction. */
const EDGE_CROSSINGS = "jumpStyle=arc;jumpSize=6;";
const ICON_LABEL = "verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;";

export const escapeXml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** draw.io stores shape data as XML attributes: keep names valid and clear of its own. */
export function dataAttributeName(key: string): string {
	let name = key.replace(/[^A-Za-z0-9_.-]/g, "_");
	if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
	if (["id", "label", "placeholders", "tooltip", "link"].includes(name)) name = `${name}_`;
	return name;
}

function withStyle(style: string, extra: string): string {
	const s = style.endsWith(";") || !style ? style : style + ";";
	return extra
		.split(";")
		.filter(Boolean)
		.reduce((acc, kv) => (new RegExp(`(^|;)${kv.split("=")[0]}=`).test(acc) ? acc : acc + kv + ";"), s);
}

function nodeStyle(n: MapNode, isContainer: boolean): string {
	if (n.shape === "table") return n.style ?? STYLES.table;
	if (isContainer) return withStyle(n.style ?? STYLES.container, "container=1;collapsible=0;");
	if (n.shape === "icon") return withStyle(n.style ?? STYLES.icon, ICON_LABEL);
	if (n.shape === "note") return n.style ?? STYLES.note;
	return n.style ?? STYLES.box;
}

export interface RenderOptions {
	/** Recipe that drew the map; stored on every shape. */
	recipe: string;
	/** The map's id (its record in .drawai/maps); stored on every shape. */
	mapId?: string;
	/** Plain-English descriptions by node id, shown as the shapes' tooltips. */
	descriptions?: Record<string, string>;
	/** Top-left of the map on the page. */
	origin?: { x: number; y: number };
	layout?: Layout;
}

/**
 * Draws a laid-out map as a draw.io model fragment for the `insertXml` operation:
 * one undoable, reviewable edit. Every shape carries `mapper`, `mapperKind` and
 * `mapperId` plus the node's data, which "dig deeper" hands to the agent.
 */
export function renderGraph(graph: MapGraph, options: RenderOptions): { xml: string; cells: number } {
	const layout = options.layout ?? layoutGraph(graph);
	const origin = options.origin ?? { x: 40, y: 40 };
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const cellId = new Map<string, string>();
	graph.nodes.forEach((n, i) => cellId.set(n.id, `map${i + 1}`));
	const hasChildren = new Set(graph.nodes.filter((n) => n.parent && byId.has(n.parent)).map((n) => n.parent!));
	const out: string[] = ['<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'];
	let cells = 0;

	// Parents before children: draw.io needs a parent to exist when a child is added.
	const depth = (n: MapNode, guard = 0): number => (n.parent && byId.has(n.parent) && guard < 50 ? 1 + depth(byId.get(n.parent)!, guard + 1) : 0);
	const ordered = [...graph.nodes].sort((a, b) => depth(a) - depth(b));

	for (const n of ordered) {
		const box = layout.boxes.get(n.id);
		if (!box) continue;
		const parent = n.parent && byId.has(n.parent) && layout.boxes.has(n.parent) ? cellId.get(n.parent)! : "1";
		const x = parent === "1" ? box.x + origin.x : box.x;
		const y = parent === "1" ? box.y + origin.y : box.y;
		const isContainer = (!!n.container || hasChildren.has(n.id)) && n.shape !== "table";
		const attrs: Record<string, string> = { mapper: options.recipe, mapperKind: n.kind, mapperId: n.id };
		if (options.mapId) attrs.mapId = options.mapId;
		const description = options.descriptions?.[n.id];
		if (description) attrs.tooltip = description;
		for (const [k, v] of Object.entries(n.data ?? {})) if (v !== undefined && v !== null && v !== "") attrs[dataAttributeName(k)] = String(v);
		// Labels are HTML (html=1): keep line breaks.
		const label = escapeHtml(n.label).replace(/\n/g, "<br>");
		const id = cellId.get(n.id)!;
		out.push(
			`<object id="${id}" label="${escapeXml(label)}"${Object.entries(attrs)
				.map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
				.join("")}><mxCell style="${escapeXml(nodeStyle(n, isContainer))}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${box.width}" height="${box.height}" as="geometry"/></mxCell></object>`
		);
		cells++;
		if (n.shape === "table") {
			const rows = n.rows ?? [];
			const shown = rows.slice(0, SIZES.tableMaxRows);
			const lines = shown.map((r) => {
				const key = r.key ? `<b>${escapeHtml(r.key)}</b>&nbsp;` : "";
				const detail = r.detail ? ` <font color="#6b7280">${escapeHtml(r.detail)}</font>` : "";
				return `${key}${escapeHtml(r.text)}${detail}`;
			});
			if (rows.length > shown.length) lines.push(`<i>… ${rows.length - shown.length} more</i>`);
			if (lines.length === 0) lines.push("<i>no columns</i>");
			lines.forEach((line, i) => {
				out.push(
					`<mxCell id="${id}r${i + 1}" value="${escapeXml(line)}" style="${escapeXml(STYLES.tableRow)}" vertex="1" parent="${id}"><mxGeometry y="${SIZES.tableHeader + i * SIZES.tableRow}" width="${box.width}" height="${SIZES.tableRow}" as="geometry"/></mxCell>`
				);
				cells++;
			});
		}
	}

	const crossings = graph.edges.length <= MAX_ROUTED_EDGES ? EDGE_CROSSINGS : "";
	graph.edges.forEach((e, i) => {
		const source = cellId.get(e.from);
		const target = cellId.get(e.to);
		if (!source || !target || !layout.boxes.has(e.from) || !layout.boxes.has(e.to)) return;
		const value = e.label ? ` value="${escapeXml(escapeHtml(e.label))}"` : "";
		out.push(
			`<mxCell id="mapE${i + 1}"${value} style="${escapeXml(withStyle(e.style ?? STYLES.edge, crossings))}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`
		);
		cells++;
	});

	if (graph.legend?.length) {
		const text = graph.legend.join("\n");
		const size = cellSize({ id: "legend", label: text, kind: "legend", shape: "note" });
		out.push(
			`<object id="mapLegend" label="${escapeXml(escapeHtml(text).replace(/\n/g, "<br>"))}" mapper="${escapeXml(options.recipe)}" mapperKind="legend"${options.mapId ? ` mapId="${escapeXml(options.mapId)}"` : ""}><mxCell style="${escapeXml(STYLES.note)}" vertex="1" parent="1"><mxGeometry x="${origin.x + layout.width + 60}" y="${origin.y}" width="${size.w}" height="${size.h}" as="geometry"/></mxCell></object>`
		);
		cells++;
	}
	out.push("</root></mxGraphModel>");
	return { xml: out.join(""), cells };
}
