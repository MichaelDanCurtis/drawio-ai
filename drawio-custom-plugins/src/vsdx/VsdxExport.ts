/**
 * draw.io → Microsoft Visio (.vsdx) export.
 *
 * draw.io removed its VSDX exporter after v24.7.17; this is a port of that
 * exporter (js/diagramly/vsdx/VsdxExport.js, Copyright (c) 2006-2024 JGraph Ltd,
 * Apache License 2.0), reworked to:
 * - render every page in a hidden temporary graph instead of switching the
 *   user's editor between pages,
 * - resolve draw.io's light-dark() colors,
 * - keep pages with duplicate names, embed each image once with per-page
 *   relationships, and keep layer indices right when layers are hidden,
 * - export edge labels, nested groups and connectors inside groups at the
 *   right place, and glue connectors only to shapes that were exported,
 * - carry custom data, links and tooltips over as Shape Data, hyperlinks and
 *   screen tips.
 */

import { CONNECTOR_MASTER_ID, STATIC_PARTS } from "./parts";
import { resolveColor } from "./colors";
import { Bitmap, loadBitmap, PLACEHOLDER } from "./images";
import { createVsdxCanvas, Frame, ImageRequest, Paint, RecordedSection, REL_NS, stripInvalidXml, UNITS_PER_INCH, VISIO_NS } from "./VsdxCanvas";
import { createZip, ZipEntry } from "./zip";

export interface VsdxExportOptions {
	/** Only the page that is visible in the editor. Default: all pages. */
	currentPageOnly?: boolean;
}

export interface VsdxExportResult {
	data: Uint8Array;
	pages: number;
	shapes: number;
	connectors: number;
	images: number;
	warnings: string[];
}

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const PAGE_REL = "http://schemas.microsoft.com/visio/2010/relationships/page";
const MASTER_REL = "http://schemas.microsoft.com/visio/2010/relationships/master";
const IMAGE_REL = REL_NS + "/image";
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** draw.io arrow|filled → Visio arrowhead index. */
const ARROWS: Record<string, number> = {
	"none|1": 0, "none|0": 0, "open|1": 1, "open|0": 1, "block|1": 4, "block|0": 14, "classic|1": 5, "classic|0": 17,
	"oval|1": 10, "oval|0": 20, "diamond|1": 11, "diamond|0": 22, "blockThin|1": 2, "blockThin|0": 15, "dash|1": 23, "dash|0": 23,
	"ERone|1": 24, "ERone|0": 24, "ERmandOne|1": 25, "ERmandOne|0": 25, "ERmany|1": 27, "ERmany|0": 27, "ERoneToMany|1": 28,
	"ERoneToMany|0": 28, "ERzeroToMany|1": 29, "ERzeroToMany|0": 29, "ERzeroToOne|1": 30, "ERzeroToOne|0": 30,
	"openAsync|1": 9, "openAsync|0": 9,
};

/** Attributes of draw.io data objects that are not user data. */
const RESERVED_ATTRIBUTES = new Set(["label", "placeholders", "tooltip", "link", "id"]);

/** Where a shape's position is measured from: the page, or the enclosing group. */
interface Container {
	x: number;
	y: number;
	height: number;
	shiftX: number;
	shiftY: number;
}

interface MediaFile {
	index: number;
	bitmap?: Bitmap;
	ready: Promise<void>;
}

interface PageOut {
	name: string;
	doc: XMLDocument;
	width: number;
	height: number;
	scale: number;
	layers: { name: string; locked: boolean }[];
	media: MediaFile[];
}

export async function exportVsdx(ui: any, options: VsdxExportOptions = {}): Promise<VsdxExportResult> {
	const W = window as any;
	const mxUtils = W.mxUtils;
	const graph = ui.editor.graph;
	const warnings: string[] = [];
	const stats = { shapes: 0, connectors: 0 };

	// Images are embedded once per source and referenced from every page that uses them.
	const media = new Map<string, MediaFile>();
	const foreign: { element: Element; file: MediaFile }[] = [];
	let pageMedia: MediaFile[] = [];

	const addImage = (doc: XMLDocument, request: ImageRequest): Element => {
		let file = media.get(request.src);
		if (!file) {
			const created: MediaFile = { index: media.size + 1, ready: Promise.resolve() };
			created.ready = loadBitmap(request.src, request.width, request.height).then(
				(bitmap) => {
					created.bitmap = bitmap;
				},
				(e) => {
					created.bitmap = PLACEHOLDER;
					warnings.push(`An image could not be embedded (${e?.message ?? e}): ${request.src.slice(0, 80)}`);
				}
			);
			media.set(request.src, created);
			file = created;
		}
		if (!pageMedia.includes(file)) {
			pageMedia.push(file);
		}
		const element = doc.createElementNS(VISIO_NS, "ForeignData");
		element.setAttribute("ForeignType", "Bitmap");
		const rel = doc.createElementNS(VISIO_NS, "Rel");
		// rId1 is the connector master.
		rel.setAttributeNS(REL_NS, "r:id", `rId${pageMedia.indexOf(file) + 2}`);
		element.appendChild(rel);
		foreign.push({ element, file });
		return element;
	};

	const canvas = createVsdxCanvas(W, addImage);

	const allPages: any[] = ui.pages && ui.pages.length > 0 ? ui.pages : [null];
	const pages = options.currentPageOnly ? [allPages.includes(ui.currentPage) ? ui.currentPage : allPages[0]] : allPages;
	const usedNames = new Set<string>();
	const out: PageOut[] = [];

	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		pageMedia = [];
		let name = String(page?.getName?.() || `Page-${i + 1}`).trim() || `Page-${i + 1}`;
		// Visio needs unique page names.
		for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
			name = `${page?.getName?.() || "Page"} (${n})`;
		}
		usedNames.add(name.toLowerCase());
		out.push({ ...exportPage(page), name, media: pageMedia });
	}

	function exportPage(page: any): Omit<PageOut, "name" | "media"> {
		let root: any;
		let pageFormat = graph.pageFormat;
		let pageScale = graph.pageScale || 1;
		if (page == null || page === ui.currentPage) {
			// Decode a copy so that nothing here can touch the live model.
			const node = ui.editor.getGraphXml();
			root = new W.mxCodec(node.ownerDocument).decode(node).root;
		} else {
			ui.updatePageRoot(page);
			root = page.root;
			pageFormat = page.viewState?.pageFormat ?? pageFormat;
			pageScale = page.viewState?.pageScale ?? pageScale;
		}

		const tmp = ui.createTemporaryGraph(graph.getStylesheet());
		const container: HTMLElement = tmp.container;
		// Render HTML labels with light colors whatever the editor theme is.
		container.style.colorScheme = "light";
		document.body.appendChild(container);
		try {
			tmp.model.setRoot(root);
			return convertPage(tmp, pageFormat, pageScale);
		} finally {
			tmp.destroy();
			container.parentNode?.removeChild(container);
		}
	}

	function convertPage(tmp: any, pageFormat: any, pageScale: number): Omit<PageOut, "name" | "media"> {
		const model = tmp.model;
		const view = tmp.view;
		const s = view.scale || 1;
		const t = view.translate;
		const doc = document.implementation.createDocument(VISIO_NS, "PageContents", null);
		const rootEl = doc.documentElement;
		rootEl.setAttributeNS(XMLNS_NS, "xmlns:r", REL_NS);
		rootEl.setAttributeNS(XML_NS, "xml:space", "preserve");
		const el = (name: string) => doc.createElementNS(VISIO_NS, name);
		const cell = (name: string, value: string | number, formula?: string) => {
			const c = el("Cell");
			c.setAttribute("N", name);
			c.setAttribute("V", String(value));
			if (formula) c.setAttribute("F", formula);
			return c;
		};
		const scaled = (name: string, value: number, formula?: string) => cell(name, value / UNITS_PER_INCH, formula);

		// Page size: whole draw.io pages covering the content, like draw.io's page view.
		const fw = pageFormat?.width || 850;
		const fh = pageFormat?.height || 1100;
		const gb = tmp.getGraphBounds();
		const bx = gb.x / s - t.x;
		const by = gb.y / s - t.y;
		const shiftX = bx < 0 ? Math.ceil(-bx / fw) * fw : 0;
		const shiftY = by < 0 ? Math.ceil(-by / fh) * fh : 0;
		const pageW = fw * Math.max(1, Math.ceil((bx + gb.width / s + shiftX) / fw));
		const pageH = fh * Math.max(1, Math.ceil((by + gb.height / s + shiftY) / fh));
		const pageContainer: Container = { x: 0, y: 0, height: pageH, shiftX, shiftY };

		// Hidden layers are not exported: their cells have no rendered state to convert.
		const layers: { name: string; locked: boolean }[] = [];
		const layerIndex = new Map<any, number>();
		const hidden: string[] = [];
		for (const layer of model.getChildCells(model.root)) {
			const layerName = plainText(layer.value) || "Background";
			if (model.isVisible(layer)) {
				layerIndex.set(layer, layers.length);
				layers.push({ name: layerName, locked: /(^|;)locked=1/.test(layer.style || "") });
			} else {
				hidden.push(layerName);
			}
		}
		if (hidden.length) {
			warnings.push(`Hidden layers were not exported: ${hidden.join(", ")}`);
		}

		const stateOf = (c: any) => view.getState(c);
		const exportable = (c: any) => c != null && model.isVisible(c) && stateOf(c) != null && (model.isVertex(c) || model.isEdge(c));
		const ids = new Map<any, number>();
		let nextId = 1;
		const idOf = (c: any) => {
			let id = ids.get(c);
			if (id === undefined) {
				id = nextId++;
				ids.set(c, id);
			}
			return id;
		};
		const emitted = new Set<any>();
		const edges: any[] = [];
		const edgeTriggers = new Map<any, { beg: Element; end: Element }>();

		const absFrame = (state: any): Frame => ({
			x: state.x / s - t.x,
			y: state.y / s - t.y,
			width: state.width / s,
			height: state.height / s,
		});
		const toVisio = (c: Container, x: number, y: number) => ({
			x: x - c.x + c.shiftX,
			y: c.height - (y - c.y) - c.shiftY,
		});

		const newShape = (id: number, frame: Frame, layer: number, container: Container): Element => {
			const shape = el("Shape");
			shape.setAttribute("ID", String(id));
			shape.setAttribute("NameU", `Shape${id}`);
			shape.setAttribute("LineStyle", "0");
			shape.setAttribute("FillStyle", "0");
			shape.setAttribute("TextStyle", "0");
			const pin = toVisio(container, frame.x + frame.width / 2, frame.y + frame.height / 2);
			shape.appendChild(scaled("PinX", pin.x));
			shape.appendChild(scaled("PinY", pin.y));
			shape.appendChild(scaled("Width", frame.width));
			shape.appendChild(scaled("Height", frame.height));
			shape.appendChild(scaled("LocPinX", frame.width / 2));
			shape.appendChild(scaled("LocPinY", frame.height / 2));
			shape.appendChild(cell("LayerMember", String(layer)));
			return shape;
		};

		const applyStyle = (state: any, shape: Element, isEdge: boolean) => {
			const st = state.style;
			const fill = isEdge ? undefined : resolveColor(st.fillColor);
			if (!fill || fill === "none") {
				shape.appendChild(cell("FillPattern", 0));
			} else {
				shape.appendChild(cell("FillForegnd", fill));
				const gradient = resolveColor(st.gradientColor);
				if (gradient && gradient !== "none") {
					shape.appendChild(cell("FillBkgnd", gradient));
					const dir = { east: 25, west: 27, north: 30 }[st.gradientDirection as string] ?? 28;
					shape.appendChild(cell("FillPattern", dir));
				} else {
					shape.appendChild(cell("FillPattern", 1));
				}
			}
			const stroke = resolveColor(st.strokeColor);
			if (stroke === "none") {
				shape.appendChild(cell("LinePattern", 0));
			} else {
				shape.appendChild(cell("LineColor", stroke ?? "#000000"));
				shape.appendChild(scaled("LineWeight", parseFloat(st.strokeWidth) || 1));
				if (st.dashed == 1) {
					const pattern = ({ "1 1": 10, "1 2": 3, "1 4": 17 } as Record<string, number>)[st.dashPattern] ?? 9;
					shape.appendChild(cell("LinePattern", pattern));
				} else {
					shape.appendChild(cell("LinePattern", 1));
				}
			}
			const opacity = st.opacity ?? undefined;
			const fillOpacity = opacity ?? st.fillOpacity;
			const strokeOpacity = opacity ?? st.strokeOpacity;
			if (fillOpacity != null && fill && fill !== "none") {
				shape.appendChild(cell("FillForegndTrans", 1 - (parseFloat(fillOpacity) || 0) / 100));
			}
			if (strokeOpacity != null && stroke !== "none") {
				shape.appendChild(cell("LineColorTrans", 1 - (parseFloat(strokeOpacity) || 0) / 100));
			}
			if (st.shadow == 1) {
				shape.appendChild(cell("ShdwPattern", 1));
				shape.appendChild(cell("ShdwForegnd", "#000000"));
				shape.appendChild(cell("ShdwForegndTrans", 0.6));
				shape.appendChild(cell("ShapeShdwType", 1));
				shape.appendChild(cell("ShapeShdwOffsetX", 0.02946278254943948));
				shape.appendChild(cell("ShapeShdwOffsetY", -0.02946278254943948));
				shape.appendChild(cell("ShapeShdwScaleFactor", 1));
				shape.appendChild(cell("ShapeShdwBlur", 0.05555555555555555));
				shape.appendChild(cell("ShapeShdwShow", 2));
			}
			if (st.flipH == 1) shape.appendChild(cell("FlipX", 1));
			if (st.flipV == 1) shape.appendChild(cell("FlipY", 1));
			if (!isEdge && st.rounded == 1) {
				shape.appendChild(scaled("Rounding", Math.min(state.width, state.height) / s * 0.1));
			}
			const labelBg = resolveColor(st.labelBackgroundColor);
			if (labelBg && labelBg !== "none") {
				shape.appendChild(cell("TextBkgnd", labelBg));
				shape.appendChild(cell("TextBkgndTrans", 0));
			}
		};

		/** Custom data → Shape Data, link → hyperlink, tooltip → screen tip. */
		const applyData = (c: any, shape: Element) => {
			const value = c.value;
			if (!value || typeof value !== "object" || typeof value.getAttribute !== "function") {
				return;
			}
			const tooltip = value.getAttribute("tooltip");
			if (tooltip) {
				shape.appendChild(cell("Comment", stripInvalidXml(tooltip)));
			}
			const props = Array.from(value.attributes as NamedNodeMap).filter((a) => !RESERVED_ATTRIBUTES.has(a.name));
			if (props.length) {
				const sec = el("Section");
				sec.setAttribute("N", "Property");
				const rowNames = new Set<string>();
				for (const a of props) {
					const base = a.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "Prop";
					let rowName = base;
					// Visio row names are case-insensitive.
					for (let n = 2; rowNames.has(rowName.toLowerCase()); n++) rowName = `${base}_${n}`;
					rowNames.add(rowName.toLowerCase());
					const row = el("Row");
					row.setAttribute("N", rowName);
					const v = cell("Value", stripInvalidXml(a.value));
					v.setAttribute("U", "STR");
					row.appendChild(v);
					row.appendChild(cell("Label", stripInvalidXml(a.name)));
					row.appendChild(cell("Type", 0));
					sec.appendChild(row);
				}
				shape.appendChild(sec);
			}
			const link = value.getAttribute("link");
			if (link && /^(https?:|mailto:)/i.test(link)) {
				const sec = el("Section");
				sec.setAttribute("N", "Hyperlink");
				const row = el("Row");
				row.setAttribute("N", "Row_1");
				row.appendChild(cell("Address", stripInvalidXml(link)));
				row.appendChild(cell("Default", 1));
				sec.appendChild(row);
				shape.appendChild(sec);
			}
		};

		const paint = (state: any, shape: Element, frame: Frame, withShape: boolean): RecordedSection[] => {
			canvas.beginShape(shape, state, frame, doc);
			if (state.text != null && state.text.checkBounds()) {
				canvas.save();
				state.text.paint(canvas);
				canvas.restore();
			}
			if (withShape && state.shape != null && state.shape.checkBounds()) {
				canvas.save();
				state.shape.paint(canvas);
				canvas.restore();
			}
			return canvas.endShape();
		};

		/** Visio has one fill and line color per shape: a shape painted in several colors becomes a group of one sub-shape per color. */
		const attachGeometry = (shape: Element, sections: RecordedSection[], state: any, frame: Frame, layer: number) => {
			const opaque = (c: string | undefined) => (c === "none" ? undefined : c);
			const fill = opaque(resolveColor(state.style.fillColor));
			const stroke = opaque(resolveColor(state.style.strokeColor));
			const uniform =
				canvas.shapeType === "Foreign" ||
				sections.every(
					({ paint: p }) => !p || ((p.fill === undefined || p.fill === fill) && (p.stroke === undefined || p.stroke === stroke))
				);
			if (uniform) {
				sections.forEach(({ element }, i) => {
					element.setAttribute("IX", String(i));
					shape.appendChild(element);
				});
				shape.setAttribute("Type", canvas.shapeType);
				return;
			}
			const key = (p: Paint | undefined) => (p ? `${p.fill}|${p.stroke}|${p.strokeWidth}|${p.dashed}|${p.alpha}` : "");
			const runs: RecordedSection[][] = [];
			for (const section of sections) {
				const last = runs[runs.length - 1];
				if (last && key(last[0].paint) === key(section.paint)) last.push(section);
				else runs.push([section]);
			}
			const members = el("Shapes");
			const local: Container = { x: frame.x, y: frame.y, height: frame.height, shiftX: 0, shiftY: 0 };
			for (const run of runs) {
				const sub = newShape(nextId++, frame, layer, local);
				sub.setAttribute("Type", "Shape");
				const p = run[0].paint;
				if (p?.fill) {
					sub.appendChild(cell("FillForegnd", p.fill));
					sub.appendChild(cell("FillPattern", 1));
					if (p.alpha < 1) sub.appendChild(cell("FillForegndTrans", 1 - p.alpha));
				} else {
					sub.appendChild(cell("FillPattern", p ? 0 : 1));
				}
				if (p?.stroke) {
					sub.appendChild(cell("LineColor", p.stroke));
					sub.appendChild(scaled("LineWeight", p.strokeWidth));
					sub.appendChild(cell("LinePattern", p.dashed ? 9 : 1));
				} else {
					sub.appendChild(cell("LinePattern", p ? 0 : 1));
				}
				run.forEach(({ element }, i) => {
					element.setAttribute("IX", String(i));
					sub.appendChild(element);
				});
				members.appendChild(sub);
			}
			shape.setAttribute("Type", "Group");
			shape.appendChild(members);
		};

		const convertVertex = (c: any, layer: number, container: Container): Element => {
			const state = stateOf(c);
			let frame = absFrame(state);
			const textBox = state.text?.boundingBox;
			if ((frame.width === 0 || frame.height === 0) && textBox) {
				// Edge labels and other text-only cells have no size of their own.
				frame = { x: textBox.x / s - t.x, y: textBox.y / s - t.y, width: textBox.width / s, height: textBox.height / s };
			} else if (directionOf(state) % 180 === 90) {
				// direction=north/south: draw.io paints the outline (stencils too) in a turned box and
				// rotates it by 90 degrees. That box and rotation become the Visio shape, so its handles fit.
				const d = (frame.width - frame.height) / 2;
				frame = { x: frame.x + d, y: frame.y - d, width: frame.height, height: frame.width };
			}
			const shape = newShape(idOf(c), frame, layer, container);
			applyStyle(state, shape, false);
			applyData(c, shape);
			attachGeometry(shape, paint(state, shape, frame, true), state, frame, layer);
			emitted.add(c);
			stats.shapes++;
			return shape;
		};

		const convertEdge = (c: any, layer: number, container: Container): Element[] => {
			const state = stateOf(c);
			const pts = (state.absolutePoints || [])
				.filter((p: any) => p != null)
				.map((p: any) => ({ x: p.x / s - t.x, y: p.y / s - t.y }));
			if (pts.length < 2) {
				return [];
			}
			const xs = pts.map((p: any) => p.x);
			const ys = pts.map((p: any) => p.y);
			const frame: Frame = {
				x: Math.min(...xs),
				y: Math.min(...ys),
				width: Math.max(...xs) - Math.min(...xs),
				height: Math.max(...ys) - Math.min(...ys),
			};
			const id = idOf(c);
			const shape = el("Shape");
			shape.setAttribute("ID", String(id));
			shape.setAttribute("NameU", `Dynamic connector.${id}`);
			shape.setAttribute("Name", `Dynamic connector.${id}`);
			shape.setAttribute("Type", "Shape");
			shape.setAttribute("Master", CONNECTOR_MASTER_ID);
			const pin = toVisio(container, frame.x + frame.width / 2, frame.y + frame.height / 2);
			shape.appendChild(scaled("PinX", pin.x));
			shape.appendChild(scaled("PinY", pin.y));
			shape.appendChild(scaled("Width", frame.width));
			shape.appendChild(scaled("Height", frame.height));
			shape.appendChild(scaled("LocPinX", frame.width / 2));
			shape.appendChild(scaled("LocPinY", frame.height / 2));
			const begin = toVisio(container, pts[0].x, pts[0].y);
			const end = toVisio(container, pts[pts.length - 1].x, pts[pts.length - 1].y);
			// The formulas keep the connector glued when shapes move in Visio.
			shape.appendChild(scaled("BeginX", begin.x, "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)"));
			shape.appendChild(scaled("BeginY", begin.y, "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)"));
			shape.appendChild(scaled("EndX", end.x, "_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)"));
			shape.appendChild(scaled("EndY", end.y, "_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)"));
			// Formulas are added with the Connects, once the end shapes are known to exist.
			const triggers = { beg: cell("BegTrigger", 2), end: cell("EndTrigger", 2) };
			shape.appendChild(triggers.beg);
			shape.appendChild(triggers.end);
			edgeTriggers.set(c, triggers);
			shape.appendChild(cell("ConFixedCode", 6));
			shape.appendChild(cell("LayerMember", String(layer)));
			applyStyle(state, shape, true);
			const st = state.style;
			shape.appendChild(cell("BeginArrow", ARROWS[`${st.startArrow ?? "none"}|${st.startFill ?? 1}`] ?? 1));
			shape.appendChild(cell("BeginArrowSize", arrowSize(st.startSize)));
			shape.appendChild(cell("EndArrow", ARROWS[`${st.endArrow ?? "classic"}|${st.endFill ?? 1}`] ?? 1));
			shape.appendChild(cell("EndArrowSize", arrowSize(st.endSize)));
			applyData(c, shape);

			paint(state, shape, frame, false);
			const geo = el("Section");
			geo.setAttribute("N", "Geometry");
			geo.setAttribute("IX", "0");
			geo.appendChild(cell("NoFill", 1));
			geo.appendChild(cell("NoLine", 0));
			pts.forEach((p: any, i: number) => {
				const row = el("Row");
				row.setAttribute("T", i === 0 ? "MoveTo" : "LineTo");
				row.setAttribute("IX", String(i + 1));
				row.appendChild(scaled("X", p.x - frame.x));
				row.appendChild(scaled("Y", frame.height - (p.y - frame.y)));
				geo.appendChild(row);
			});
			shape.appendChild(geo);
			emitted.add(c);
			edges.push(c);
			stats.connectors++;

			// Edge labels that are child cells become free text shapes next to the connector.
			const result = [shape];
			for (const child of model.getChildCells(c)) {
				result.push(...convertCell(child, layer, container));
			}
			return result;
		};

		const convertGroup = (c: any, layer: number, container: Container): Element => {
			const state = stateOf(c);
			const frame = absFrame(state);
			const group = newShape(nextId++, frame, layer, container);
			group.setAttribute("Type", "Group");
			const members = el("Shapes");
			const inner: Container = { x: frame.x, y: frame.y, height: frame.height, shiftX: 0, shiftY: 0 };
			// The container's own appearance and label is the first member.
			members.appendChild(convertVertex(c, layer, inner));
			for (const child of model.getChildCells(c)) {
				for (const shape of convertCell(child, layer, inner)) {
					members.appendChild(shape);
				}
			}
			group.appendChild(members);
			return group;
		};

		/** Cells that are neither shapes nor connectors can still hold shapes. */
		const isPlainContainer = (c: any) => c != null && !model.isVertex(c) && !model.isEdge(c) && model.isVisible(c);
		const hasContent = (c: any): boolean =>
			model.getChildCells(c).some((child: any) => exportable(child) || (isPlainContainer(child) && hasContent(child)));

		function convertCell(c: any, layer: number, container: Container): Element[] {
			if (isPlainContainer(c)) {
				return model.getChildCells(c).flatMap((child: any) => convertCell(child, layer, container));
			}
			if (!exportable(c)) {
				return [];
			}
			try {
				if (model.isEdge(c)) {
					return convertEdge(c, layer, container);
				}
				if (hasContent(c)) {
					return [convertGroup(c, layer, container)];
				}
				return [convertVertex(c, layer, container)];
			} catch (e: any) {
				warnings.push(`Skipped a shape that could not be converted (${e?.message ?? e}).`);
				return [];
			}
		}

		canvas.save();
		canvas.translate(-t.x, -t.y);
		canvas.scale(1 / s);
		const shapes = el("Shapes");
		try {
			for (const [layer, ix] of layerIndex) {
				for (const c of model.getChildCells(layer)) {
					for (const shape of convertCell(c, ix, pageContainer)) {
						shapes.appendChild(shape);
					}
				}
			}
		} finally {
			canvas.restore();
		}
		rootEl.appendChild(shapes);

		const connects = el("Connects");
		for (const e of edges) {
			for (const [isSource, fromCell, fromPart] of [[true, "BeginX", "9"], [false, "EndX", "12"]] as const) {
				const term = model.getTerminal(e, isSource);
				// Visio connectors glue to shapes, not to other connectors.
				if (term && emitted.has(term) && !model.isEdge(term)) {
					const trigger = edgeTriggers.get(e)![isSource ? "beg" : "end"];
					trigger.setAttribute("F", `_XFTRIGGER(Sheet.${idOf(term)}!EventXFMod)`);
					const connect = el("Connect");
					connect.setAttribute("FromSheet", String(idOf(e)));
					connect.setAttribute("FromCell", fromCell);
					connect.setAttribute("FromPart", fromPart);
					connect.setAttribute("ToSheet", String(idOf(term)));
					connect.setAttribute("ToCell", "PinX");
					connect.setAttribute("ToPart", "3");
					connects.appendChild(connect);
				}
			}
		}
		rootEl.appendChild(connects);
		normalizeOrder(rootEl);

		return { doc, width: pageW, height: pageH, scale: pageScale, layers };
	}

	await Promise.all([...media.values()].map((m) => m.ready));
	for (const { element, file } of foreign) {
		element.setAttribute("CompressionType", file.bitmap!.type.toUpperCase());
	}

	const entries = buildPackage(out, [...media.values()]);
	const data = await createZip(entries);
	return { data, pages: out.length, shapes: stats.shapes, connectors: stats.connectors, images: media.size, warnings };
}

/** The extra rotation (0, 90, 180, 270) a shape's direction style adds to its outline. */
function directionOf(state: any): number {
	const total = state.shape?.getShapeRotation?.() ?? 0;
	const rotation = state.shape?.getRotation?.() ?? 0;
	return (((total - rotation) % 360) + 360) % 360;
}

function arrowSize(size: unknown): number {
	const n = parseFloat(size as string);
	if (!isFinite(n)) return 2;
	return n <= 2 ? 0 : n <= 3 ? 1 : n <= 5 ? 2 : n <= 7 ? 3 : n <= 9 ? 4 : n <= 22 ? 5 : 6;
}

function plainText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "object" && typeof (value as any).getAttribute === "function") {
		return String((value as any).getAttribute("label") || "");
	}
	return String(value);
}

/** Puts a shape's children in schema order: Cell, Trigger, Section, Text, ForeignData, Shapes. */
function normalizeOrder(root: Element) {
	const rank: Record<string, number> = { Cell: 0, Trigger: 1, Section: 2, Text: 3, Data1: 4, Data2: 5, Data3: 6, ForeignData: 7, Shapes: 8 };
	for (const shape of Array.from(root.getElementsByTagNameNS(VISIO_NS, "Shape"))) {
		const children = Array.from(shape.children).filter((c) => c.localName in rank);
		children.sort((a, b) => rank[a.localName] - rank[b.localName]);
		for (const c of children) shape.appendChild(c);
	}
	for (const section of Array.from(root.getElementsByTagNameNS(VISIO_NS, "Section"))) {
		for (const c of Array.from(section.children).filter((c) => c.localName === "Row")) section.appendChild(c);
	}
}

function serialize(doc: XMLDocument): string {
	return XML_HEADER + new XMLSerializer().serializeToString(doc);
}

function buildPackage(pages: PageOut[], media: MediaFile[]): ZipEntry[] {
	const enc = new TextEncoder();
	const files = new Map<string, string | Uint8Array>();
	const esc = (s: string) => stripInvalidXml(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const num = (v: number) => String(v);

	const overrides = [
		["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
		["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
		["/docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"],
		["/visio/document.xml", "application/vnd.ms-visio.drawing.main+xml"],
		["/visio/masters/masters.xml", "application/vnd.ms-visio.masters+xml"],
		["/visio/masters/master1.xml", "application/vnd.ms-visio.master+xml"],
		["/visio/pages/pages.xml", "application/vnd.ms-visio.pages+xml"],
		...pages.map((_, i) => [`/visio/pages/page${i + 1}.xml`, "application/vnd.ms-visio.page+xml"]),
		["/visio/windows.xml", "application/vnd.ms-visio.windows+xml"],
	];
	files.set(
		"[Content_Types].xml",
		XML_HEADER +
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
			'<Default Extension="xml" ContentType="application/xml"/>' +
			'<Default Extension="png" ContentType="image/png"/>' +
			'<Default Extension="jpeg" ContentType="image/jpeg"/>' +
			'<Default Extension="gif" ContentType="image/gif"/>' +
			overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("") +
			"</Types>"
	);
	for (const [name, content] of Object.entries(STATIC_PARTS)) {
		files.set(name, content);
	}

	let pagesXml = `<Pages xmlns="${VISIO_NS}" xmlns:r="${REL_NS}" xml:space="preserve">`;
	let pagesRels = `<Relationships xmlns="${PKG_REL_NS}">`;
	pages.forEach((page, i) => {
		const k = UNITS_PER_INCH;
		const layers = page.layers
			.map(
				(l, ix) =>
					`<Row IX="${ix}"><Cell N="Name" V="${esc(l.name)}"/><Cell N="Color" V="255"/><Cell N="Status" V="0"/>` +
					`<Cell N="Visible" V="1"/><Cell N="Print" V="1"/><Cell N="Active" V="0"/><Cell N="Lock" V="${l.locked ? 1 : 0}"/>` +
					`<Cell N="Snap" V="1"/><Cell N="Glue" V="1"/><Cell N="NameUniv" V="${esc(l.name)}"/><Cell N="ColorTrans" V="0"/></Row>`
			)
			.join("");
		pagesXml +=
			`<Page ID="${i}" NameU="${esc(page.name)}" Name="${esc(page.name)}">` +
			`<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">` +
			`<Cell N="PageWidth" V="${num(page.width / k)}"/><Cell N="PageHeight" V="${num(page.height / k)}"/>` +
			`<Cell N="PageScale" V="${num(page.scale)}"/><Cell N="DrawingScale" V="1"/>` +
			(layers ? `<Section N="Layer">${layers}</Section>` : "") +
			`</PageSheet><Rel r:id="rId${i + 1}"/></Page>`;
		pagesRels += `<Relationship Id="rId${i + 1}" Type="${PAGE_REL}" Target="page${i + 1}.xml"/>`;

		files.set(`visio/pages/page${i + 1}.xml`, serialize(page.doc));
		files.set(
			`visio/pages/_rels/page${i + 1}.xml.rels`,
			XML_HEADER +
				`<Relationships xmlns="${PKG_REL_NS}">` +
				`<Relationship Id="rId1" Type="${MASTER_REL}" Target="../masters/master1.xml"/>` +
				page.media
					.map((m, ix) => `<Relationship Id="rId${ix + 2}" Type="${IMAGE_REL}" Target="../media/image${m.index}.${m.bitmap!.type}"/>`)
					.join("") +
				"</Relationships>"
		);
	});
	files.set("visio/pages/pages.xml", XML_HEADER + pagesXml + "</Pages>");
	files.set("visio/pages/_rels/pages.xml.rels", XML_HEADER + pagesRels + "</Relationships>");
	for (const m of media) {
		files.set(`visio/media/image${m.index}.${m.bitmap!.type}`, m.bitmap!.data);
	}

	return [...files].map(([name, content]) => ({
		name,
		data: typeof content === "string" ? enc.encode(content) : content,
	}));
}
