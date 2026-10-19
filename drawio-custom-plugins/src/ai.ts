import { sendEvent } from "./vscode";
import { exportVsdx } from "./vsdx/VsdxExport";
import { importDiagram } from "./import/importDiagram";

const W = window as any;
const ACCENT = "#a855f7";
const SKIPPED = "skipped: an earlier operation in this atomic batch failed";
const PAGE_SWITCHED =
	"not applied: the page shown changed while this batch ran. Read the diagram again, select the page you meant with drawio_pages, and send the rest again.";

Draw.loadPlugin((ui: any) => {
	sendEvent({ event: "pluginLoaded", pluginId: "ai" });

	const graph = ui.editor.graph;
	const model = graph.getModel();
	const mx = {
		utils: W.mxUtils,
		constants: W.mxConstants,
	};

	// ---------------------------------------------------------------------
	// Reading the diagram
	// ---------------------------------------------------------------------

	// The reading helpers take the root of the page to read; by default the one shown.

	function isLayer(cell: any, root = model.getRoot()): boolean {
		return cell != null && model.getParent(cell) === root;
	}

	function layers(root = model.getRoot()): any[] {
		return model.getChildren(root) || [];
	}

	function allCells(root = model.getRoot()): any[] {
		const result: any[] = [];
		const visit = (c: any) => {
			for (const child of model.getChildren(c) || []) {
				result.push(child);
				visit(child);
			}
		};
		for (const layer of layers(root)) {
			visit(layer);
		}
		return result;
	}

	const isLocked = (cell: any) => /(^|;)locked=1(;|$)/.test(model.getStyle(cell) || "");

	function htmlToText(html: string): string {
		const doc = new DOMParser().parseFromString(
			html
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/(div|p|li|tr|h\d)>/gi, "\n"),
			"text/html"
		);
		return doc.body.textContent || "";
	}

	function plainLabel(cell: any): string {
		const value = model.getValue(cell);
		let raw = mx.utils.isNode(value)
			? value.getAttribute("label") || ""
			: value == null
			? ""
			: String(value);
		if (/<[a-z!/]/i.test(raw)) {
			raw = htmlToText(raw);
		}
		return raw.replace(/\u00a0/g, " ").replace(/\n{2,}/g, "\n").trim();
	}

	function cellData(cell: any): Record<string, string> | undefined {
		const value = model.getValue(cell);
		if (!mx.utils.isNode(value)) {
			return undefined;
		}
		const data: Record<string, string> = {};
		for (const attr of Array.from(value.attributes as NamedNodeMap)) {
			if (attr.name !== "label" && attr.name !== "id") {
				data[attr.name] = attr.value;
			}
		}
		return Object.keys(data).length > 0 ? data : undefined;
	}

	function kindOf(cell: any): AiCell["kind"] {
		if (model.isEdge(cell)) {
			return "edge";
		}
		const style: string = model.getStyle(cell) || "";
		if (graph.isSwimlane(cell) || /(^|;)container=1/.test(style)) {
			return "container";
		}
		if (model.getChildCount(cell) > 0 || /(^|;)group(;|$)/.test(style)) {
			return "group";
		}
		return "vertex";
	}

	function layerOf(cell: any, root = model.getRoot()): any {
		let c = cell;
		while (c != null && !isLayer(c, root)) {
			c = model.getParent(c);
		}
		return c;
	}

	const round = (n: number) => Math.round(n * 10) / 10;

	function describe(cell: any, includeStyles: boolean, root = model.getRoot()): AiCell {
		const kind = kindOf(cell);
		const parent = model.getParent(cell);
		const geo = model.getGeometry(cell);
		const result: AiCell = { id: cell.id, kind, label: plainLabel(cell) };
		if (includeStyles && model.getStyle(cell)) {
			result.style = model.getStyle(cell);
		}
		if (parent && !isLayer(parent, root)) {
			result.parent = parent.id;
		}
		if (layers(root).length > 1) {
			result.layer = layerOf(cell, root)?.id;
		}
		if (kind === "edge") {
			const s = model.getTerminal(cell, true);
			const t = model.getTerminal(cell, false);
			if (s) result.source = s.id;
			if (t) result.target = t.id;
			if (geo?.points?.length) {
				result.points = geo.points.map((p: any) => ({
					x: round(p.x),
					y: round(p.y),
				}));
			}
		} else if (geo) {
			result.geometry = {
				x: round(geo.x),
				y: round(geo.y),
				width: round(geo.width),
				height: round(geo.height),
			};
		}
		const data = cellData(cell);
		if (data) {
			result.data = data;
		}
		return result;
	}

	function pageBounds(cells: any[], root = model.getRoot()): AiRect {
		const bounds = graph.getBoundingBoxFromGeometry(
			cells.filter((c) => model.isVertex(c) && isLayer(model.getParent(c), root)),
			true
		);
		if (!bounds) {
			return { x: 0, y: 0, width: 0, height: 0 };
		}
		return {
			x: round(bounds.x),
			y: round(bounds.y),
			width: round(bounds.width),
			height: round(bounds.height),
		};
	}

	/** Reads the page shown in the editor, or another page without switching to it. */
	function snapshot(action: AiGetModelAction): AiDiagramModel {
		const page = action.page ? findPage(action.page) : ui.currentPage;
		const current = page == null || page === ui.currentPage;
		const root = current ? model.getRoot() : pageRoot(page);
		const cells = allCells(root);
		// Only the page shown has a selection.
		const selection: any[] = current ? graph.getSelectionCells() : [];
		const selectedIds = new Set(selection.map((c) => c.id));

		let included: { cell: any; context: boolean }[];
		if (action.scope === "selection" && selection.length > 0) {
			const core = new Set<any>();
			for (const c of selection) {
				core.add(c);
				for (const d of model.getDescendants(c)) core.add(d);
			}
			const context = new Set<any>();
			for (const c of core) {
				for (const e of model.getEdges(c) || []) {
					if (!core.has(e)) context.add(e);
					for (const t of [model.getTerminal(e, true), model.getTerminal(e, false)]) {
						if (t && !core.has(t)) context.add(t);
					}
				}
				const p = model.getParent(c);
				if (p && !isLayer(p, root) && !core.has(p)) context.add(p);
			}
			included = [
				...[...core].map((cell) => ({ cell, context: false })),
				...[...context].map((cell) => ({ cell, context: true })),
			];
		} else {
			included = cells.map((cell) => ({ cell, context: false }));
		}

		// Vertices before edges so that edge endpoints are already known.
		included.sort(
			(a, b) => Number(model.isEdge(a.cell)) - Number(model.isEdge(b.cell))
		);

		const maxCells = Math.max(1, action.maxCells || 400);
		const out = included.slice(0, maxCells).map(({ cell, context }) => {
			const d = describe(cell, action.includeStyles, root);
			if (selectedIds.has(cell.id)) d.selected = true;
			if (context) d.context = true;
			return d;
		});

		const pages = allPages();
		return {
			page: {
				id: page?.getId?.() ?? "",
				name: page?.getName?.() ?? "",
				index: Math.max(0, pages.indexOf(page)),
				count: Math.max(1, pages.length),
				current,
			},
			layers: layers(root).map((l) => ({ id: l.id, name: plainLabel(l), visible: model.isVisible(l), locked: isLocked(l) })),
			bounds: pageBounds(cells, root),
			selection: [...selectedIds],
			cells: out,
			truncated: included.length > out.length,
			totalCells: cells.length,
		};
	}

	function emptyModel(): AiDiagramModel {
		const page = { id: "", name: "", index: 0, count: 0, current: false };
		return { page, layers: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, selection: [], cells: [], truncated: false, totalCells: 0 };
	}

	// ---------------------------------------------------------------------
	// Pages
	// ---------------------------------------------------------------------

	function allPages(): any[] {
		return ui.pages || [];
	}

	const pageName = (page: any): string => page?.getName?.() ?? "";
	const describePage = (page: any): string => `"${pageName(page)}" (${page.getId()})`;

	/** The page an id or name (exact, else ignoring case) refers to. */
	function findPage(ref: string): any {
		const pages = allPages();
		const wanted = String(ref).trim();
		const byId = pages.find((p) => p.getId() === wanted);
		if (byId) return byId;
		let named = pages.filter((p) => pageName(p) === wanted);
		if (named.length === 0) named = pages.filter((p) => pageName(p).toLowerCase() === wanted.toLowerCase());
		if (named.length === 1) return named[0];
		if (named.length > 1) {
			throw new Error(`${named.length} pages are named "${wanted}": pass the page id instead (${named.map((p) => p.getId()).join(", ")}).`);
		}
		throw new Error(`No page "${wanted}". The pages are ${pages.map(describePage).join(", ") || "none"}.`);
	}

	/** The root cell of a page; pages never shown yet are decoded first, as draw.io does on switching to them. */
	function pageRoot(page: any): any {
		if (page === ui.currentPage) return model.getRoot();
		ui.updatePageRoot(page);
		return page.root;
	}

	function pageInfo(page: any): AiPageInfo {
		return {
			id: page.getId(),
			name: pageName(page),
			index: allPages().indexOf(page),
			cells: allCells(pageRoot(page)).length,
			current: page === ui.currentPage,
		};
	}

	// ---------------------------------------------------------------------
	// Applying operations
	// ---------------------------------------------------------------------

	type Resolver = (ref: string | undefined, what?: string) => any;

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function looksLikeHtml(s: string): boolean {
		return /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(s);
	}

	function normalizeLabel(label: string, style: string): string {
		if (!/(^|;)html=1/.test(style) || looksLikeHtml(label)) {
			return label;
		}
		return escapeHtml(label).replace(/\n/g, "<br>");
	}

	function buildStyle(
		base: string | undefined,
		props: Record<string, AiStyleValue> | undefined
	): string {
		let style = base ?? "";
		for (const [key, value] of Object.entries(props || {})) {
			const v =
				value === null || value === undefined
					? null
					: value === true
					? "1"
					: value === false
					? "0"
					: String(value);
			style = mx.utils.setStyle(style, key, v);
		}
		return style;
	}

	function setLabel(cell: any, label: string) {
		const style = model.getStyle(cell) || "";
		const text = normalizeLabel(label, style);
		const value = model.getValue(cell);
		if (mx.utils.isNode(value)) {
			const clone = value.cloneNode(true);
			clone.setAttribute("label", text);
			model.setValue(cell, clone);
		} else {
			model.setValue(cell, text);
		}
	}

	function setData(cell: any, data: Record<string, string | null>) {
		let value = model.getValue(cell);
		if (!mx.utils.isNode(value)) {
			const obj = mx.utils.createXmlDocument().createElement("UserObject");
			obj.setAttribute("label", value == null ? "" : String(value));
			value = obj;
		} else {
			value = value.cloneNode(true);
		}
		for (const [k, v] of Object.entries(data)) {
			if (!/^[A-Za-z_][\w.-]*$/.test(k) || k === "id") {
				throw new Error(`Invalid data attribute name "${k}"`);
			}
			if (v === null) {
				value.removeAttribute(k);
			} else {
				value.setAttribute(k, String(v));
			}
		}
		model.setValue(cell, value);
	}

	function estimateSize(label: string): { width: number; height: number } {
		const lines = label.split("\n");
		const longest = Math.max(...lines.map((l) => l.length), 1);
		return {
			width: Math.min(260, Math.max(120, longest * 7.5 + 30)),
			height: Math.max(60, lines.length * 18 + 24),
		};
	}

	function freeSpot(parent: any): { x: number; y: number } {
		const siblings = (model.getChildren(parent) || []).filter((c: any) =>
			model.isVertex(c)
		);
		if (siblings.length === 0) {
			return { x: 40, y: 40 };
		}
		const b = graph.getBoundingBoxFromGeometry(siblings, false);
		return b ? { x: b.x + b.width + 60, y: b.y } : { x: 40, y: 40 };
	}

	function updateGeometry(cell: any, f: (g: any) => void) {
		const geo = model.getGeometry(cell);
		if (!geo) {
			throw new Error(`Cell "${cell.id}" has no geometry`);
		}
		const clone = geo.clone();
		f(clone);
		model.setGeometry(cell, clone);
	}

	function parseModelXml(xml: string): Document {
		let text = xml.trim();
		if (!/^<(mxfile|mxGraphModel|diagram)\b/.test(text)) {
			const body = /^<root\b/.test(text)
				? text.replace(/^<root[^>]*>/, "").replace(/<\/root>\s*$/, "")
				: text;
			const hasRoot = /\sid="0"/.test(body) && /\sid="1"/.test(body);
			text = `<mxGraphModel><root>${
				hasRoot ? "" : '<mxCell id="0"/><mxCell id="1" parent="0"/>'
			}${body}</root></mxGraphModel>`;
		}
		const doc = mx.utils.parseXml(text);
		const err = doc.getElementsByTagName("parsererror")[0];
		if (err) {
			throw new Error("Invalid XML: " + (err.textContent || "").slice(0, 200));
		}
		let node = doc.documentElement;
		if (node.nodeName !== "mxGraphModel") {
			node = W.Editor.extractGraphModel(node, true);
			if (!node) {
				throw new Error("No <mxGraphModel> found in XML");
			}
		}
		const result = mx.utils.createXmlDocument();
		result.appendChild(result.importNode(node, true));
		return result;
	}

	/**
	 * Adds the cells of an mxGraphModel XML to the live model without cloning,
	 * so requested ids survive unless they collide. Parent/terminal references
	 * to cells outside the snippet are re-linked through the model (undoable).
	 */
	function insertXml(
		xml: string,
		targetParent: any,
		resolve: Resolver,
		idMap: Record<string, string>,
		dx = 0,
		dy = 0
	): any[] {
		const doc = parseModelXml(xml);
		const rootEl = doc.getElementsByTagName("root")[0];
		if (!rootEl) {
			throw new Error("XML has no <root>");
		}
		const elements = Array.from(rootEl.children) as Element[];
		const snippetIds = new Set(elements.map((e) => e.getAttribute("id")));
		const cellElOf = (el: Element) =>
			el.nodeName === "mxCell"
				? el
				: (Array.from(el.children).find((c) => c.nodeName === "mxCell") as
						| Element
						| undefined);

		const rootIds = new Set(
			elements
				.filter((e) => !cellElOf(e)?.getAttribute("parent"))
				.map((e) => e.getAttribute("id"))
		);
		const fallbackLayer = elements
			.filter((e) => rootIds.has(cellElOf(e)?.getAttribute("parent") ?? null))
			.map((e) => e.getAttribute("id"))[0];

		const externalParent = new Map<string, string>();
		const externalTerminals: { id: string; ref: string; source: boolean }[] = [];
		for (const el of elements) {
			const c = cellElOf(el);
			if (!c) continue;
			const id = el.getAttribute("id") || "";
			const parent = c.getAttribute("parent");
			if (parent != null && !snippetIds.has(parent)) {
				externalParent.set(id, parent);
				if (fallbackLayer) c.setAttribute("parent", fallbackLayer);
			}
			for (const source of [true, false]) {
				const attr = source ? "source" : "target";
				const ref = c.getAttribute(attr);
				if (ref != null && !snippetIds.has(ref)) {
					externalTerminals.push({ id, ref, source });
					c.removeAttribute(attr);
				}
			}
		}

		const tmp = new W.mxGraphModel();
		new W.mxCodec(doc).decode(doc.documentElement, tmp);

		const original = new Map<any, string>();
		for (const [id, cell] of Object.entries(tmp.cells as Record<string, any>)) {
			original.set(cell, id);
		}
		const tmpLayers = tmp.getChildren(tmp.getRoot()) || [];
		const topLevel: any[] = [];
		for (const layer of tmpLayers) {
			topLevel.push(...(tmp.getChildren(layer) || []));
		}

		const added: any[] = [];
		for (const cell of topLevel) {
			const origId = original.get(cell)!;
			const ext = externalParent.get(origId);
			model.add(ext ? resolve(ext, "parent") : targetParent, cell);
			added.push(cell);
		}
		for (const cell of topLevel) {
			for (const d of model.getDescendants(cell)) {
				const origId = original.get(d);
				if (origId != null) idMap[origId] = d.id;
			}
		}
		for (const t of externalTerminals) {
			const cell = model.getCell(idMap[t.id] ?? t.id);
			model.setTerminal(cell, resolve(t.ref, "terminal"), t.source);
		}
		if (dx || dy) {
			graph.moveCells(added.filter((c) => !model.isEdge(c)), dx, dy);
		}
		return added;
	}

	const ELK_PRESETS: Record<string, string> = {
		hierarchical: "verticalFlow",
		horizontalHierarchical: "horizontalFlow",
		tree: "verticalTree",
		horizontalTree: "horizontalTree",
		radialTree: "radialTree",
		organic: "organic",
	};

	function whenElkReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ready = () => typeof W.ElkLayout !== "undefined" && W.ElkLayout.MENU_PRESETS != null;
			if (ready()) return resolve();
			if (typeof ui.whenScriptReady !== "function") {
				return reject(new Error("The layout engine is not available"));
			}
			ui.whenScriptReady(ready, resolve, () => reject(new Error("The layout engine (ELK) failed to load")));
		});
	}

	function runStep(exec: () => void): Promise<void> {
		return new Promise((resolve) => ui.executeLayout(exec, false, resolve));
	}

	/** draw.io >= 32 lays out with ELK, which computes asynchronously and then applies in one model update. */
	async function layoutCells(op: Extract<AiOp, { op: "layout" }>, resolve: Resolver): Promise<string[]> {
		// ELK computes asynchronously: never apply its result to a page the user switched to meanwhile.
		const root = model.getRoot();
		const runLayoutStep = (exec: () => void) => {
			if (model.getRoot() !== root) throw new Error(PAGE_SWITCHED);
			return runStep(exec);
		};
		const scoped = (op.ids || []).map((id) => resolve(id));
		let parent = op.parent ? resolve(op.parent, "parent") : undefined;
		if (!parent) {
			const parents = new Set(scoped.map((c) => model.getParent(c)));
			parent = parents.size === 1 ? [...parents][0] : graph.getDefaultParent();
		}
		const scope = new Set(scoped);
		const inScope = (cell: any): boolean => {
			for (let c = cell; c != null && c !== parent; c = model.getParent(c)) {
				if (scope.has(c)) return true;
			}
			return false;
		};
		const cellFilter =
			scope.size === 0
				? undefined
				: (c: any) =>
						model.isEdge(c)
							? inScope(model.getTerminal(c, true)) && inScope(model.getTerminal(c, false))
							: inScope(c);
		const spacing = op.spacing ?? 50;
		const vertices = (model.getChildren(parent) || []).filter(
			(c: any) => model.isVertex(c) && (!cellFilter || cellFilter(c))
		);

		if (op.type === "grid") {
			const cols = Math.ceil(Math.sqrt(vertices.length));
			const cw = Math.max(...vertices.map((v: any) => model.getGeometry(v).width), 0) + spacing;
			const ch = Math.max(...vertices.map((v: any) => model.getGeometry(v).height), 0) + spacing;
			const origin = graph.getBoundingBoxFromGeometry(vertices, false) || { x: 40, y: 40 };
			await runLayoutStep(() =>
				vertices.forEach((v: any, i: number) =>
					updateGeometry(v, (g) => {
						g.x = origin.x + (i % cols) * cw;
						g.y = origin.y + Math.floor(i / cols) * ch;
					})
				)
			);
		} else if (op.type === "circle") {
			const layout = new W.mxCircleLayout(graph);
			layout.isVertexIgnored = (v: any) => !!cellFilter && !cellFilter(v);
			await runLayoutStep(() => layout.execute(parent));
		} else {
			const preset = ELK_PRESETS[op.type];
			if (!preset) throw new Error(`Unknown layout type "${op.type}"`);
			await whenElkReady();
			const list: any[] = ui.resolveLayoutList(preset).map((entry: any) => ({
				...entry,
				config: op.spacing
					? {
							...entry.config,
							"elk.spacing.nodeNode": spacing,
							"elk.layered.spacing.nodeNodeBetweenLayers": spacing * 1.5,
					  }
					: entry.config,
			}));
			for (const layout of graph.createLayouts(list, cellFilter ? { cellFilter } : undefined)) {
				if (typeof layout.prepare === "function") {
					const apply = await new Promise<() => void>((res, rej) =>
						layout.prepare(parent, (err: any, ap: () => void) =>
							err ? rej(err instanceof Error ? err : new Error(String(err))) : res(ap)
						)
					);
					await runLayoutStep(apply);
				} else {
					await runLayoutStep(() => layout.execute(parent));
				}
			}
		}
		return vertices.map((v: any) => v.id);
	}

	function runOp(
		op: AiOp,
		resolve: Resolver,
		idMap: Record<string, string>,
		touched: Set<any>
	): string[] {
		const cells = (ids: string[] | undefined) => {
			if (!ids || ids.length === 0) throw new Error("ids must not be empty");
			return ids.map((id) => {
				const cell = resolve(id);
				if (cell === model.getRoot()) throw new Error(`"${id}" is the page itself; use the ids of its layers or cells.`);
				return cell;
			});
		};
		const register = (cell: any, tempId?: string) => {
			if (tempId) idMap[tempId] = cell.id;
			touched.add(cell);
			return cell.id as string;
		};
		const layer = (ref: string | undefined, what = "id") => {
			const cell = resolve(ref, what);
			if (!isLayer(cell)) {
				throw new Error(`"${ref}" is not a layer. drawio_get_diagram lists the page's layers.`);
			}
			return cell;
		};

		switch (op.op) {
			case "addShape": {
				let parent = op.parent ? resolve(op.parent, "parent") : undefined;
				const style = buildStyle(
					op.style ?? "rounded=1;whiteSpace=wrap;html=1;",
					op.styleProps
				);
				const label = op.label ?? "";
				const est = estimateSize(label);
				const w = op.width ?? est.width;
				const h = op.height ?? est.height;
				let x = op.x;
				let y = op.y;
				if (op.placement) {
					const rel = resolve(op.placement.relativeTo, "placement.relativeTo");
					parent = parent ?? model.getParent(rel);
					const g = model.getGeometry(rel);
					const gap = op.placement.gap ?? 60;
					switch (op.placement.side) {
						case "right": x = g.x + g.width + gap; y = g.y + (g.height - h) / 2; break;
						case "left": x = g.x - gap - w; y = g.y + (g.height - h) / 2; break;
						case "below": x = g.x + (g.width - w) / 2; y = g.y + g.height + gap; break;
						case "above": x = g.x + (g.width - w) / 2; y = g.y - gap - h; break;
					}
				}
				parent = parent ?? graph.getDefaultParent();
				if (x === undefined || y === undefined) {
					const spot = freeSpot(parent);
					x = x ?? spot.x;
					y = y ?? spot.y;
				}
				const cell = graph.insertVertex(
					parent, null, normalizeLabel(label, style), x, y, w, h, style
				);
				if (op.data) setData(cell, op.data);
				return [register(cell, op.tempId)];
			}
			case "addEdge": {
				const source = resolve(op.source, "source");
				const target = resolve(op.target, "target");
				const parent = op.parent ? resolve(op.parent, "parent") : graph.getDefaultParent();
				const style = buildStyle(
					op.style ??
						"edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;",
					op.styleProps
				);
				const edge = graph.insertEdge(
					parent, null, normalizeLabel(op.label ?? "", style), source, target, style
				);
				if (op.points?.length) {
					updateGeometry(edge, (g) => {
						g.points = op.points!.map((p) => new W.mxPoint(p.x, p.y));
					});
				}
				return [register(edge, op.tempId)];
			}
			case "update": {
				const cell = resolve(op.id);
				if (op.style !== undefined || op.styleProps) {
					model.setStyle(cell, buildStyle(op.style ?? model.getStyle(cell), op.styleProps));
				}
				if (op.label !== undefined) setLabel(cell, op.label);
				if (op.data) setData(cell, op.data);
				if ([op.x, op.y, op.width, op.height].some((v) => v !== undefined)) {
					updateGeometry(cell, (g) => {
						if (op.x !== undefined) g.x = op.x;
						if (op.y !== undefined) g.y = op.y;
						if (op.width !== undefined) g.width = op.width;
						if (op.height !== undefined) g.height = op.height;
					});
				}
				if (op.parent) {
					const parent = resolve(op.parent, "parent");
					if (parent === cell || model.isAncestor(cell, parent)) {
						throw new Error("A cell cannot be moved into itself or its descendant");
					}
					model.add(parent, cell);
				}
				if (op.source) model.setTerminal(cell, resolve(op.source, "source"), true);
				if (op.target) model.setTerminal(cell, resolve(op.target, "target"), false);
				return [register(cell)];
			}
			case "delete": {
				const cs = cells(op.ids);
				if (layers().every((l) => cs.includes(l))) {
					throw new Error("A page needs at least one layer: keep one, or delete the cells on it instead.");
				}
				const removed = graph.removeCells(cs, op.includeEdges ?? true) || [];
				// The layer the user draws on may have gone.
				graph.checkDefaultParent?.();
				return removed.map((c: any) => c.id);
			}
			case "move": {
				const cs = cells(op.ids);
				graph.moveCells(cs, op.dx, op.dy);
				cs.forEach((c) => touched.add(c));
				return cs.map((c) => c.id);
			}
			case "resize": {
				const cs = cells(op.ids);
				for (const c of cs) {
					updateGeometry(c, (g) => {
						if (op.scale) { g.width *= op.scale; g.height *= op.scale; }
						if (op.width !== undefined) g.width = op.width;
						if (op.height !== undefined) g.height = op.height;
					});
					touched.add(c);
				}
				return cs.map((c) => c.id);
			}
			case "group": {
				const cs = cells(op.ids);
				const parents = new Set(cs.map((c) => model.getParent(c)));
				if (parents.size > 1) {
					throw new Error("All cells of a group must have the same parent");
				}
				const padding = op.padding ?? 20;
				let group: any = null;
				if (op.label !== undefined || op.style !== undefined) {
					const style =
						op.style ??
						"rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;dashed=1;fillColor=none;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;";
					group = new W.mxCell(normalizeLabel(op.label ?? "", style), new W.mxGeometry(), style);
					group.setVertex(true);
				}
				group = graph.groupCells(group, padding, cs);
				const header = /swimlane/.test(model.getStyle(group) || "")
					? Number(mx.utils.getValue(graph.getCellStyle(group), "startSize", 26))
					: op.label
					? 24
					: 0;
				if (header > 0) {
					updateGeometry(group, (g) => { g.y -= header; g.height += header; });
					for (const child of model.getChildren(group) || []) {
						if (model.isVertex(child)) updateGeometry(child, (g) => { g.y += header; });
					}
				}
				return [register(group, op.tempId)];
			}
			case "ungroup": {
				const result = graph.ungroupCells(cells(op.ids)) || [];
				result.forEach((c: any) => touched.add(c));
				return result.map((c: any) => c.id);
			}
			case "align": {
				const cs = cells(op.ids);
				graph.alignCells(op.align, cs);
				cs.forEach((c) => touched.add(c));
				return cs.map((c) => c.id);
			}
			case "distribute": {
				const cs = cells(op.ids);
				graph.distributeCells(op.direction === "horizontal", cs);
				cs.forEach((c) => touched.add(c));
				return cs.map((c) => c.id);
			}
			case "zOrder": {
				const cs = cells(op.ids);
				graph.orderCells(op.position === "back", cs);
				return cs.map((c) => c.id);
			}
			case "layout":
				throw new Error("internal: layout ops are run by applyOps");
			case "insertXml": {
				const parent = op.parent ? resolve(op.parent, "parent") : graph.getDefaultParent();
				const added = insertXml(op.xml, parent, resolve, idMap, op.dx, op.dy);
				added.forEach((c) => touched.add(c));
				return added.map((c) => c.id);
			}
			case "replaceAll": {
				const existing: any[] = [];
				for (const layer of layers()) existing.push(...(model.getChildren(layer) || []));
				if (existing.length > 0) graph.removeCells(existing, true);
				const added = insertXml(op.xml, graph.getDefaultParent(), resolve, idMap);
				added.forEach((c) => touched.add(c));
				return added.map((c) => c.id);
			}
			// Layers, as draw.io's Layers panel changes them. The default layer the user draws on stays the same.
			case "addLayer": {
				const cell = new W.mxCell(op.name?.trim() || `Layer ${layers().length + 1}`);
				if (op.locked) cell.setStyle("locked=1;");
				const drawingOn = graph.getDefaultParent();
				model.add(model.getRoot(), cell, op.position === "back" ? 0 : layers().length);
				// Without an explicit default layer, draw.io draws on the first one, which this may now be.
				if (graph.defaultParent == null && graph.getDefaultParent() !== drawingOn) graph.setDefaultParent(drawingOn);
				if (op.visible === false) model.setVisible(cell, false);
				return [register(cell, op.tempId)];
			}
			case "renameLayer": {
				const cell = layer(op.id);
				if (!op.name?.trim()) throw new Error("renameLayer needs a name");
				setLabel(cell, op.name.trim());
				return [register(cell)];
			}
			case "setLayerVisible": {
				const cell = layer(op.id);
				if (typeof op.visible !== "boolean") throw new Error("setLayerVisible needs visible: true or false");
				model.setVisible(cell, op.visible);
				return [register(cell)];
			}
			case "setLayerLocked": {
				const cell = layer(op.id);
				if (typeof op.locked !== "boolean") throw new Error("setLayerLocked needs locked: true or false");
				model.setStyle(cell, mx.utils.setStyle(model.getStyle(cell) || "", "locked", op.locked ? "1" : null));
				return [register(cell)];
			}
			case "moveToLayer": {
				const target = layer(op.layer, "layer");
				if (isLocked(target)) {
					throw new Error(`Layer "${plainLabel(target) || target.id}" is locked. Unlock it first with setLayerLocked.`);
				}
				const cs = cells(op.ids);
				const nested = cs.find((c) => isLayer(c));
				if (nested) throw new Error(`"${nested.id}" is a layer; move the cells on it instead.`);
				graph.moveCells(cs, 0, 0, false, target);
				cs.forEach((c) => touched.add(c));
				return cs.map((c) => c.id);
			}
			default:
				throw new Error(`Unknown operation "${(op as any)?.op}"`);
		}
	}

	/** Collapses every undoable edit added since `from` into one, so a batch is a single Ctrl+Z. */
	function squashHistory(from: number) {
		const um = ui.editor.undoManager;
		const count = um.indexOfNextAdd - from;
		if (count <= 1) return;
		const merged = model.createUndoableEdit(true);
		for (const edit of um.history.slice(from, um.indexOfNextAdd)) {
			merged.changes.push(...edit.changes);
		}
		um.history.splice(from, count, merged);
		um.indexOfNextAdd = from + 1;
	}

	let applyQueue: Promise<unknown> = Promise.resolve();
	/** AI edits (batches and page changes) run one at a time. */
	function serialized<T>(run: () => T | Promise<T>): Promise<T> {
		const result = applyQueue.then(run);
		applyQueue = result.catch(() => undefined);
		return result;
	}

	async function applyOps(action: AiApplyOpsAction): Promise<AiApplyOpsResultEvent> {
		syncReviewPage();
		const page = ui.currentPage;
		const root = model.getRoot();
		const reviewBefore = action.review && !review ? snapAll() : undefined;
		aiEditing++;
		try {
			const result = await applyOpsInner(action);
			if (action.review && !result.rolledBack && result.results.some((r) => r.ok)) {
				const created = reviewBefore ? { page, root, before: reviewBefore, changes: [], edit: undefined } : undefined;
				if (result.switched) {
					// What was applied is on the page the batch started on, which now waits with it.
					if (created) parked.push(created);
				} else {
					if (created) review = created;
					absorbIntoReviewEdit(result.historyBefore);
				}
				if (created) reviewing = true;
				refreshReview();
			}
			const { historyBefore: _, switched: __, ...event } = result;
			return event;
		} finally {
			aiEditing--;
		}
	}

	async function applyOpsInner(action: AiApplyOpsAction): Promise<AiApplyOpsResultEvent & { historyBefore: number; switched: boolean }> {
		const idMap: Record<string, string> = {};
		const results: AiOpResult[] = [];
		const touched = new Set<any>();
		const resolve: Resolver = (ref, what = "id") => {
			if (ref === undefined || ref === null || ref === "") {
				throw new Error(`Missing ${what}`);
			}
			const cell = model.getCell(idMap[ref] ?? ref);
			if (!cell) {
				throw new Error(`Unknown cell ${what} "${ref}". Use ids from drawio_get_diagram or tempIds defined earlier in this batch.`);
			}
			return cell;
		};

		const undoManager = ui.editor.undoManager;
		const historyBefore = undoManager.indexOfNextAdd;
		const root = model.getRoot();
		let switched = false;
		const ops: AiOp[] = action.ops || [];
		let failed = false;
		const fail = (index: number, op: any, e: any) => {
			failed = true;
			results.push({ index, op: op?.op, ok: false, error: String(e?.message ?? e) });
		};
		const skip = () => failed && action.atomic;

		let i = 0;
		while (i < ops.length) {
			// The user switched pages while a layout ran: the rest must not land on the other page.
			if (model.getRoot() !== root) {
				switched = failed = true;
				for (; i < ops.length; i++) results.push({ index: i, op: ops[i]?.op, ok: false, error: PAGE_SWITCHED });
				break;
			}
			const op = ops[i];
			if (op?.op === "layout") {
				if (skip()) {
					results.push({ index: i, op: op.op, ok: false, error: SKIPPED });
				} else {
					try {
						const ids = await layoutCells(op, resolve);
						ids.forEach((id) => touched.add(model.getCell(id)));
						results.push({ index: i, op: op.op, ok: true, ids });
					} catch (e) {
						fail(i, op, e);
						if (model.getRoot() !== root) switched = true;
					}
				}
				i++;
				continue;
			}
			model.beginUpdate();
			try {
				for (; i < ops.length && ops[i]?.op !== "layout"; i++) {
					if (skip()) {
						results.push({ index: i, op: ops[i]?.op, ok: false, error: SKIPPED });
						continue;
					}
					try {
						results.push({ index: i, op: ops[i].op, ok: true, ids: runOp(ops[i], resolve, idMap, touched) });
					} catch (e) {
						fail(i, ops[i], e);
					}
				}
			} finally {
				model.endUpdate();
			}
		}

		// After a page switch, the history holds it between the batch's steps: leave both as they are.
		if (!switched) squashHistory(historyBefore);
		let rolledBack = false;
		if (!switched && failed && action.atomic && undoManager.indexOfNextAdd > historyBefore) {
			undoManager.undo();
			rolledBack = true;
		}

		if (!rolledBack && !switched) {
			const alive = [...touched].filter((c) => model.contains(c) && !isLayer(c));
			if (action.flash) flash(alive);
			if (action.selectResult && alive.length > 0) {
				graph.setSelectionCells(alive.filter((c) => model.isVertex(c)));
				graph.scrollCellToVisible(alive[0]);
			}
		}

		return { event: "aiApplyOpsResult", message: action, results, idMap, rolledBack, historyBefore, switched };
	}

	function flash(cells: any[]) {
		const highlights = cells.slice(0, 60).map((c) => {
			const h = new mxCellHighlight(graph, ACCENT, 3);
			h.highlight(graph.view.getState(c as DrawioCell));
			return h;
		});
		setTimeout(() => highlights.forEach((h) => h.destroy()), 1400);
	}

	// ---------------------------------------------------------------------
	// Review: AI edits are applied (so the AI can inspect its own result) but
	// stay pending until the user keeps or reverts them. Reverting restores the
	// state each cell had before the AI first touched it. Each page keeps its
	// own pending changes while another page is shown; the AI's changes to the
	// page list itself (drawio_pages) are part of the same review.
	// ---------------------------------------------------------------------

	const ADDED = "#16a34a";
	const CHANGED = "#d97706";
	const REMOVED = "#dc2626";
	const SVGNS = "http://www.w3.org/2000/svg";

	interface CellSnap {
		cell: any;
		parentId: string | undefined;
		index: number;
		/** -1 for layers. */
		depth: number;
		value: any;
		valueKey: string;
		style: string;
		geo: any;
		geoKey: string;
		visible: boolean;
		sourceId: string | undefined;
		targetId: string | undefined;
		/** Where the cell was drawn, in graph coordinates; used for ghosts of moved/removed cells. */
		bounds?: AiRect;
		path?: { x: number; y: number }[];
	}

	/** The pending AI changes on one page. */
	interface Review {
		page: any;
		/** The page's root cell when the changes were made. */
		root: any;
		before: Map<string, CellSnap>;
		changes: AiChange[];
		edit: any;
	}

	/** The AI's pending changes to the page list. */
	interface PageReview {
		added: Set<any>;
		/** Added pages the user has drawn on: rejecting keeps them (reverting only the AI's changes on them). */
		edited: Set<any>;
		renamed: Map<any, { from: string; to: string }>;
		moved: Set<any>;
		/** The page order before the AI first moved a page. */
		order?: any[];
	}

	/** Pending AI changes on the page shown in the editor. */
	let review: Review | undefined;
	/** Pending AI changes on other pages; they are shown again when their page is. */
	let parked: Review[] = [];
	let pageReview: PageReview | undefined;
	/** A review is open (until nothing is pending), and how the user has resolved parts of it so far. */
	let reviewing = false;
	let verdict = { accepted: false, rejected: false };
	/** > 0 while the AI (or a review action) is changing the model, so those edits are not mistaken for the user's. */
	let aiEditing = 0;

	const cloneValue = (v: any) => (v != null && typeof v === "object" && typeof v.cloneNode === "function" ? v.cloneNode(true) : v);
	const valueKey = (v: any) => (v == null ? "" : typeof v === "object" ? mx.utils.getXml(v) : String(v));
	const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
	const geoKey = (g: any) =>
		g
			? JSON.stringify([
					r2(g.x), r2(g.y), r2(g.width), r2(g.height), !!g.relative,
					(g.points || []).map((p: any) => [r2(p.x), r2(p.y)]),
					g.offset ? [r2(g.offset.x), r2(g.offset.y)] : null,
			  ])
			: "";
	const live = (id: string | undefined) => (id ? model.getCell(id) ?? null : null);
	const kindOfChange = (cell: any, depth?: number): AiChange["cellKind"] =>
		depth === -1 || isLayer(cell) ? "layer" : model.isEdge(cell) ? "edge" : "vertex";

	function depthOf(cell: any): number {
		if (isLayer(cell)) return -1;
		let d = 0;
		for (let p = model.getParent(cell); p && !isLayer(p) && p !== model.getRoot(); p = model.getParent(p)) d++;
		return d;
	}

	function snapCell(cell: any, depth = depthOf(cell)): CellSnap {
		const parent = model.getParent(cell);
		const value = model.getValue(cell);
		const geo = model.getGeometry(cell);
		const snap: CellSnap = {
			cell,
			parentId: parent?.id,
			index: parent ? parent.getIndex(cell) : 0,
			depth,
			value: cloneValue(value),
			valueKey: valueKey(value),
			style: model.getStyle(cell) ?? "",
			geo: geo ? geo.clone() : null,
			geoKey: geoKey(geo),
			visible: model.isVisible(cell),
			sourceId: model.getTerminal(cell, true)?.id,
			targetId: model.getTerminal(cell, false)?.id,
		};
		const state = depth >= 0 ? graph.view.getState(cell) : undefined;
		if (state) {
			const { scale, translate: t } = graph.view;
			const toModel = (p: any) => ({ x: p.x / scale - t.x, y: p.y / scale - t.y });
			if (model.isEdge(cell)) {
				snap.path = (state.absolutePoints || []).filter(Boolean).map(toModel);
			} else {
				snap.bounds = { ...toModel(state), width: state.width / scale, height: state.height / scale };
			}
		}
		return snap;
	}

	/** Every layer and cell of the page shown. */
	function snapAll(): Map<string, CellSnap> {
		const result = new Map<string, CellSnap>();
		const visit = (cell: any, depth: number) => {
			for (const child of model.getChildren(cell) || []) {
				result.set(child.id, snapCell(child, depth));
				visit(child, depth + 1);
			}
		};
		for (const layer of layers()) {
			result.set(layer.id, snapCell(layer, -1));
			visit(layer, 0);
		}
		return result;
	}

	function computeChanges(before: Map<string, CellSnap>): AiChange[] {
		const out: AiChange[] = [];
		const now = new Map<string, any>([...layers(), ...allCells()].map((c) => [c.id, c]));
		for (const [id, cell] of now) {
			const cellKind = kindOfChange(cell);
			const b = before.get(id);
			if (!b) {
				out.push({ id, change: "added", cellKind, label: plainLabel(cell) });
				continue;
			}
			const fields: NonNullable<AiChange["fields"]> = [];
			if (b.valueKey !== valueKey(model.getValue(cell))) fields.push("label");
			if (b.style !== (model.getStyle(cell) ?? "")) fields.push("style");
			if (b.geoKey !== geoKey(model.getGeometry(cell))) fields.push("geometry");
			if (b.parentId !== model.getParent(cell)?.id) fields.push("parent");
			if (b.sourceId !== model.getTerminal(cell, true)?.id || b.targetId !== model.getTerminal(cell, false)?.id) {
				fields.push("connection");
			}
			if (b.visible !== model.isVisible(cell)) fields.push("visible");
			if (fields.length > 0 || b.cell !== cell) {
				out.push({ id, change: "changed", cellKind, label: plainLabel(cell), fields });
			}
		}
		for (const [id, b] of before) {
			// A removed group (or layer) is reported once, not once per descendant.
			if (now.has(id) || (b.parentId && before.has(b.parentId) && !now.has(b.parentId))) continue;
			out.push({
				id,
				change: "removed",
				cellKind: kindOfChange(b.cell, b.depth),
				label: plainLabel(b.cell),
			});
		}
		return out;
	}

	function summarize(changes: AiChange[]): AiReviewSummary {
		const count = (k: AiChange["change"]) => changes.filter((c) => c.change === k).length;
		return { added: count("added"), changed: count("changed"), removed: count("removed") };
	}

	/** The AI's page-list changes that are still in effect (the user may have undone some). */
	function pendingPageChanges(): AiPageChange[] {
		return pageReview ? pendingPageChangesOf(pageReview) : [];
	}

	function pendingPageChangesOf(pr: PageReview): AiPageChange[] {
		const pages = allPages();
		const out: AiPageChange[] = [];
		for (const p of pr.added) {
			if (pages.includes(p)) out.push({ change: "added", page: p.getId(), name: pageName(p) });
		}
		for (const [p, r] of pr.renamed) {
			if (pages.includes(p) && !pr.added.has(p) && pageName(p) === r.to) out.push({ change: "renamed", page: p.getId(), name: r.to, from: r.from });
		}
		if (pr.order) {
			const before = pr.order.filter((p) => pages.includes(p));
			const now = pages.filter((p) => before.includes(p));
			if (now.some((p, i) => p !== before[i])) {
				for (const p of pr.moved) {
					if (pages.includes(p) && !pr.added.has(p)) out.push({ change: "moved", page: p.getId(), name: pageName(p) });
				}
			}
		}
		return out;
	}

	function anyPending(): boolean {
		return !!review || parked.length > 0 || pendingPageChanges().length > 0;
	}

	/** Records a drawio_pages change made in review mode. */
	function notePageChange(change: { added: any } | { renamed: any; from: string; to: string } | { moved: any; order: any[] }) {
		const pr: PageReview = (pageReview = pageReview ?? { added: new Set(), edited: new Set(), renamed: new Map(), moved: new Set() });
		reviewing = true;
		if ("added" in change) {
			pr.added.add(change.added);
		} else if ("renamed" in change) {
			const from = pr.renamed.get(change.renamed)?.from ?? change.from;
			if (from === change.to) pr.renamed.delete(change.renamed);
			else pr.renamed.set(change.renamed, { from, to: change.to });
		} else {
			pr.order = pr.order ?? change.order;
			pr.moved.add(change.moved);
		}
	}

	let lastReviewEvent = "";
	function publishReview(resolved?: AiReviewEvent["resolved"]) {
		const changes = [
			...(review?.changes ?? []),
			...parked.flatMap((r) => r.changes.map((c) => ({ ...c, page: pageName(r.page) }))),
		];
		const pageChanges = pendingPageChanges();
		const summary = summarize(changes);
		if (pageChanges.length) summary.pages = pageChanges.length;
		const evt: AiReviewEvent = {
			event: "aiReview",
			pending: anyPending(),
			summary,
			changes: changes.slice(0, 300),
			resolved,
		};
		if (pageChanges.length) evt.pageChanges = pageChanges;
		const key = JSON.stringify(evt);
		if (key === lastReviewEvent) return;
		lastReviewEvent = key;
		sendEvent(evt);
	}

	/** Repaints and reports the review; ends it once nothing is pending. */
	function settle() {
		let resolved: AiReviewEvent["resolved"];
		if (reviewing && !anyPending()) {
			resolved = verdict.accepted && verdict.rejected ? "mixed" : verdict.accepted ? "accepted" : "rejected";
			reviewing = false;
			review = undefined;
			parked = [];
			pageReview = undefined;
			verdict = { accepted: false, rejected: false };
		}
		paintReview();
		publishReview(resolved);
	}

	/**
	 * Keeps `review` on the page shown: a page switch parks it, coming back resumes it.
	 * Changes on a page that was deleted went with it; those on a page whose content was
	 * replaced (e.g. the file was reloaded) are kept.
	 */
	function syncReviewPage() {
		const root = model.getRoot();
		const pages = allPages();
		if (review && review.root !== root) {
			parked.push(review);
			review = undefined;
		}
		parked = parked.filter((r) => {
			const keep = r.root === root || (pages.includes(r.page) && r.page !== ui.currentPage && r.page.root === r.root);
			if (!keep) verdict.accepted = true;
			return keep;
		});
		if (!review) {
			const i = parked.findIndex((r) => r.root === root);
			if (i >= 0) review = parked.splice(i, 1)[0];
		}
	}

	let refreshTimer: any;
	function scheduleReviewRefresh() {
		if (!reviewing) return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refreshReview, 40);
	}

	function refreshReview() {
		clearTimeout(refreshTimer);
		if (!reviewing) return;
		syncReviewPage();
		recomputeReview();
		settle();
	}

	/** Brings the changes on the page shown up to date; the page's review ends when none are left. */
	function recomputeReview() {
		if (!review) return;
		review.changes = computeChanges(review.before);
		if (review.changes.length === 0) review = undefined;
	}

	/** Folds the newest history entry into the review's entry, so the whole review is a single Ctrl+Z. */
	function absorbIntoReviewEdit(historyBefore: number, r = review) {
		if (!r) return;
		const um = ui.editor.undoManager;
		if (um.indexOfNextAdd !== historyBefore + 1) return;
		if (r.edit && historyBefore > 0 && um.history[historyBefore - 1] === r.edit) {
			squashHistory(historyBefore - 1);
		}
		r.edit = um.history[um.indexOfNextAdd - 1];
	}

	/** Forgets a cell and, transitively, the cells that were inside it. */
	function forgetSubtree(before: Map<string, CellSnap>, id: string) {
		const gone = new Set([id]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const [bid, b] of before) {
				if (!gone.has(bid) && b.parentId && gone.has(b.parentId)) {
					gone.add(bid);
					grew = true;
				}
			}
		}
		gone.forEach((g) => before.delete(g));
	}

	function pendingIds(): Set<string> {
		return new Set((review?.changes ?? []).map((c) => c.id));
	}

	function acceptCells(ids: string[]) {
		if (!review) return;
		const before = review.before;
		for (const id of ids) {
			const cell = model.getCell(id);
			if (cell) {
				const keep = (c: any) => {
					before.set(c.id, snapCell(c));
					(model.getChildren(c) || []).forEach(keep);
				};
				keep(cell);
			} else {
				forgetSubtree(before, id);
			}
		}
		verdict.accepted = true;
	}

	function revertCells(ids: string[]) {
		if (!review) return;
		const before = review.before;
		const byId = new Map(review.changes.map((c) => [c.id, c]));
		const set = new Set(ids);

		// Reverting one thing must not leave the diagram half-connected: pull in
		// removed ancestors/descendants, pending edges attached to it, and
		// existing cells the AI moved into it.
		for (let changed = true; changed; ) {
			changed = false;
			const add = (id: string | undefined) => {
				if (id && !set.has(id)) {
					set.add(id);
					changed = true;
				}
			};
			for (const id of [...set]) {
				const b = before.get(id);
				if (b && !model.getCell(id)) {
					for (let p = b.parentId; p && before.has(p) && !model.getCell(p); p = before.get(p)!.parentId) add(p);
					for (const [bid, other] of before) {
						if (model.getCell(bid)) continue;
						if (other.parentId === id || other.sourceId === id || other.targetId === id) add(bid);
					}
				}
				if (byId.get(id)?.change === "added") {
					const cell = model.getCell(id);
					for (const edge of cell ? model.getEdges(cell) || [] : []) {
						if (byId.get(edge.id)?.change === "changed") add(edge.id);
					}
					for (const d of cell ? model.getDescendants(cell) : []) {
						if (d !== cell && byId.get(d.id)?.change === "changed") add(d.id);
					}
				}
			}
		}

		const toRestore = [...set]
			.map((id) => before.get(id))
			.filter((b): b is CellSnap => !!b)
			.sort((a, b) => Number(model.isEdge(a.cell)) - Number(model.isEdge(b.cell)) || a.depth - b.depth);
		const added = [...set].filter((id) => !before.has(id)).map((id) => model.getCell(id)).filter(Boolean);
		// An added layer or container that now holds the user's own shapes stays, so they do not go with it.
		const holdsUserCells = (c: any) => model.getDescendants(c).some((d: any) => d !== c && before.has(d.id) && !set.has(d.id));
		const kept = added.filter(holdsUserCells);
		const toRemove = added.filter((c) => !kept.includes(c));

		const um = ui.editor.undoManager;
		const historyBefore = um.indexOfNextAdd;
		aiEditing++;
		model.beginUpdate();
		try {
			for (const b of toRestore) {
				const current = model.getCell(b.cell.id);
				if (current && current !== b.cell) model.remove(current);
				const parent = live(b.parentId) ?? (b.depth === -1 ? model.getRoot() : graph.getDefaultParent());
				if (model.getParent(b.cell) !== parent || !model.contains(b.cell)) {
					model.add(parent, b.cell, Math.min(b.index, model.getChildCount(parent)));
				}
			}
			for (const b of toRestore) {
				const c = b.cell;
				if (valueKey(model.getValue(c)) !== b.valueKey) model.setValue(c, cloneValue(b.value));
				if ((model.getStyle(c) ?? "") !== b.style) model.setStyle(c, b.style);
				if (geoKey(model.getGeometry(c)) !== b.geoKey) model.setGeometry(c, b.geo ? b.geo.clone() : null);
				if (model.isVisible(c) !== b.visible) model.setVisible(c, b.visible);
				if (model.getTerminal(c, true)?.id !== b.sourceId) model.setTerminal(c, live(b.sourceId), true);
				if (model.getTerminal(c, false)?.id !== b.targetId) model.setTerminal(c, live(b.targetId), false);
			}
			if (toRemove.length > 0) graph.removeCells(toRemove, true);
			graph.checkDefaultParent?.();
		} finally {
			model.endUpdate();
			aiEditing--;
		}
		for (const c of kept) before.set(c.id, snapCell(c));
		absorbIntoReviewEdit(historyBefore);
		verdict.rejected = true;
	}

	/** Reverts every pending change on the page shown. */
	function revertPage() {
		recomputeReview();
		if (!review) return;
		revertCells(review.changes.map((c) => c.id));
		recomputeReview();
	}

	/**
	 * Reverts everything the review holds: the page shown, the other pages with pending
	 * changes (visiting each), and the AI's page-list changes; then shows the page the
	 * user was on, if it is still there. All of it is one undo step.
	 */
	function rejectAll() {
		const home = ui.currentPage;
		const homeReview = review;
		const pr = pageReview;
		// Pages the AI added go entirely, with what is on them, unless the user drew on them.
		const removed = new Set<any>([...(pr?.added ?? [])].filter((p) => !pr?.edited.has(p)));
		verdict.rejected = true;
		parked = parked.filter((r) => !removed.has(r.page));
		if (review && removed.has(review.page)) review = undefined;
		if (graph.isEditing()) graph.stopEditing(false);
		const historyBefore = ui.editor.undoManager.indexOfNextAdd;
		let otherPages = false;
		aiEditing++;
		model.beginUpdate();
		try {
			revertPage();
			for (const r of [...parked]) {
				if (!allPages().includes(r.page)) continue;
				// Switching inside the edit puts the switches in its undo, in order.
				model.execute(new W.SelectPage(ui, r.page));
				otherPages = true;
				syncReviewPage();
				if (review === r) revertPage();
			}
			otherPages = revertPageChanges(home) || otherPages;
			if (allPages().includes(home) && ui.currentPage !== home) model.execute(new W.SelectPage(ui, home));
		} finally {
			model.endUpdate();
			aiEditing--;
		}
		// On a single page, the rejection folds into the AI's own undo step, as reverting part of it does.
		if (!otherPages) absorbIntoReviewEdit(historyBefore, homeReview);
		syncReviewPage();
	}

	/** Undoes the AI's page-list changes; says whether there were any. */
	function revertPageChanges(home: any): boolean {
		const pr = pageReview;
		pageReview = undefined;
		if (!pr || pendingPageChangesOf(pr).length === 0) return false;
		aiEditing++;
		model.beginUpdate();
		try {
			const doomed = [...pr.added].filter((p) => allPages().includes(p) && !pr.edited.has(p));
			for (const p of doomed) {
				const pages = allPages();
				if (pages.length <= 1) break;
				if (p === ui.currentPage) {
					const staying = pages.filter((x) => !doomed.includes(x));
					const i = pages.indexOf(p);
					const next = staying.includes(home) ? home : staying[0] ?? pages[i === pages.length - 1 ? i - 1 : i + 1];
					model.execute(new W.ChangePage(ui, p, next));
				} else {
					model.execute(new W.ChangePage(ui, p, null));
				}
			}
			for (const [p, r] of pr.renamed) {
				if (allPages().includes(p) && pageName(p) === r.to) model.execute(new W.RenamePage(ui, p, r.from));
			}
			if (pr.order) {
				// The pages that were there before go back to their old order, in the places they hold now.
				const pages = allPages();
				const before = pr.order.filter((p) => pages.includes(p));
				const slots = pages.map((p, i) => (before.includes(p) ? i : -1)).filter((i) => i >= 0);
				const wanted = pages.slice();
				slots.forEach((slot, k) => (wanted[slot] = before[k]));
				for (let i = 0; i < wanted.length; i++) {
					const from = allPages().indexOf(wanted[i]);
					if (from !== i) model.execute(new W.MovePage(ui, from, i));
				}
			}
		} finally {
			model.endUpdate();
			aiEditing--;
		}
		return true;
	}

	function resolveReview(decision: "accept" | "reject", cellIds?: string[]) {
		refreshReview();
		if (!reviewing) return;
		if (cellIds) {
			// Cells on the page shown.
			const pending = pendingIds();
			const targets = cellIds.filter((id) => pending.has(id));
			if (targets.length === 0) return;
			if (decision === "accept") acceptCells(targets);
			else revertCells(targets);
		} else if (decision === "accept") {
			verdict.accepted = true;
			review = undefined;
			parked = [];
			pageReview = undefined;
		} else {
			rejectAll();
		}
		refreshReview();
	}

	/** The user's own edits while a review is open become part of the baseline, unless they touch a pending cell. */
	function absorbUserEdit(edit: any) {
		if (!review || !edit?.changes) return;
		const pending = pendingIds();
		const touched = new Set<any>();
		for (const ch of edit.changes) {
			for (const c of [ch.cell, ch.child]) if (c && c !== model.getRoot()) touched.add(c);
		}
		for (const cell of touched) {
			if (pending.has(cell.id)) continue;
			if (model.contains(cell)) review.before.set(cell.id, snapCell(cell));
			else forgetSubtree(review.before, cell.id);
		}
		scheduleReviewRefresh();
	}

	// Decorations: outlines on pending cells, ghosts where cells used to be, and a review bar.
	let highlights: any[] = [];
	let ghostLayer: SVGGElement | undefined;
	let reviewBar: HTMLDivElement | undefined;

	function paintGhosts() {
		ghostLayer?.remove();
		ghostLayer = undefined;
		if (!review) return;
		const { scale, translate: t } = graph.view;
		const vx = (x: number) => (x + t.x) * scale;
		const vy = (y: number) => (y + t.y) * scale;
		const g = document.createElementNS(SVGNS, "g") as SVGGElement;
		g.setAttribute("pointer-events", "none");
		for (const ch of review.changes.slice(0, 300)) {
			const moved = ch.change === "changed" && ch.fields?.some((f) => f === "geometry" || f === "parent");
			if (ch.change !== "removed" && !moved) continue;
			const b = review.before.get(ch.id);
			const color = ch.change === "removed" ? REMOVED : CHANGED;
			let el: SVGElement | undefined;
			if (b?.bounds) {
				el = document.createElementNS(SVGNS, "rect");
				el.setAttribute("x", String(vx(b.bounds.x)));
				el.setAttribute("y", String(vy(b.bounds.y)));
				el.setAttribute("width", String(b.bounds.width * scale));
				el.setAttribute("height", String(b.bounds.height * scale));
				el.setAttribute("rx", "4");
				el.setAttribute("fill", color);
				el.setAttribute("fill-opacity", ch.change === "removed" ? "0.08" : "0.04");
			} else if (b?.path && b.path.length > 1) {
				el = document.createElementNS(SVGNS, "polyline");
				el.setAttribute("points", b.path.map((p) => `${vx(p.x)},${vy(p.y)}`).join(" "));
				el.setAttribute("fill", "none");
			}
			if (!el) continue;
			el.setAttribute("stroke", color);
			el.setAttribute("stroke-width", "1.5");
			el.setAttribute("stroke-dasharray", "5 4");
			el.setAttribute("data-ai-ghost", ch.change);
			g.appendChild(el);
		}
		ghostLayer = g;
		graph.view.getOverlayPane().appendChild(g);
	}

	function paintReview() {
		highlights.forEach((h) => h.destroy());
		highlights = [];
		if (review) {
			for (const ch of review.changes.slice(0, 300)) {
				if (ch.change === "removed" || ch.cellKind === "layer") continue;
				const state = graph.view.getState(model.getCell(ch.id));
				if (!state) continue;
				const h = new W.mxCellHighlight(graph, ch.change === "added" ? ADDED : CHANGED, 2, true);
				h.highlight(state);
				highlights.push(h);
			}
		}
		paintGhosts();
		renderReviewBar();
	}

	/** Waits for an AI batch in progress: rejecting everything may switch pages. */
	function userResolves(decision: "accept" | "reject", cellIds?: string[]) {
		void serialized(() => resolveReview(decision, cellIds));
	}

	function selectedPending(): string[] {
		if (!review) return [];
		const pending = pendingIds();
		return graph.getSelectionCells().map((c: any) => c.id).filter((id: string) => pending.has(id));
	}

	function renderReviewBar() {
		if (!reviewing || !anyPending()) {
			reviewBar?.remove();
			reviewBar = undefined;
			return;
		}
		if (!reviewBar) {
			reviewBar = document.createElement("div");
			reviewBar.setAttribute("data-ai-review-bar", "");
			Object.assign(reviewBar.style, {
				position: "fixed", left: "50%", bottom: "16px", transform: "translateX(-50%)", zIndex: "10001",
				display: "flex", gap: "8px", alignItems: "center", padding: "6px 8px 6px 12px",
				borderRadius: "10px", font: "12px system-ui, sans-serif", boxShadow: "0 6px 20px rgba(0,0,0,.25)",
				whiteSpace: "nowrap",
			});
			for (const type of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) {
				reviewBar.addEventListener(type, (e) => e.stopPropagation());
			}
			document.body.appendChild(reviewBar);
		}
		const bar = reviewBar;
		themed(bar);
		bar.style.borderColor = ACCENT;
		bar.replaceChildren();

		const s = summarize(review?.changes ?? []);
		const title = document.createElement("span");
		title.style.fontWeight = "600";
		title.textContent = "✦ AI changes";
		bar.appendChild(title);
		const part = (text: string, color?: string) => {
			const el = document.createElement("span");
			if (color) el.style.color = color;
			el.textContent = text;
			bar.appendChild(el);
			return el;
		};
		for (const [n, label, color] of [
			[s.added, "added", ADDED], [s.changed, "changed", CHANGED], [s.removed, "removed", REMOVED],
		] as const) {
			if (n) part(`${n} ${label}`, color);
		}
		const elsewhere = parked.reduce((n, r) => n + r.changes.length, 0);
		if (elsewhere) {
			const where = parked.length === 1 ? `page "${pageName(parked[0].page)}"` : `${parked.length} other pages`;
			part(`${review ? "+ " : ""}${elsewhere} on ${where}`).setAttribute("data-ai-review-elsewhere", "");
		}
		const pc = pendingPageChanges();
		if (pc.length) {
			const count = (k: AiPageChange["change"]) => pc.filter((c) => c.change === k).length;
			const words = ([["added", "new"], ["renamed", "renamed"], ["moved", "moved"]] as const)
				.filter(([k]) => count(k))
				.map(([k, w]) => `${count(k)} ${w}`);
			part(`pages: ${words.join(", ")}`, ACCENT).setAttribute("data-ai-review-pages", "");
		}

		const button = (text: string, title: string, onClick: () => void, primary = false) => {
			const b = document.createElement("button");
			b.textContent = text;
			b.title = title;
			b.setAttribute("data-ai-review", text);
			Object.assign(b.style, {
				font: "inherit", padding: "3px 10px", borderRadius: "6px", cursor: "pointer",
				border: `1px solid ${primary ? ACCENT : isDark() ? "#3f3f46" : "#d0d7de"}`,
				background: primary ? ACCENT : "transparent", color: primary ? "white" : "inherit",
			});
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick();
			});
			bar.appendChild(b);
		};
		const sel = selectedPending();
		if (sel.length > 0) {
			button(`Revert ${sel.length} selected`, "Restore the selected items to how they were before the AI changed them", () =>
				userResolves("reject", sel)
			);
			button(`Keep ${sel.length} selected`, "Accept the AI's change for the selected items", () => userResolves("accept", sel));
		}
		button("Reject all", "Undo every pending AI change, on every page", () => userResolves("reject"));
		button("Accept all", "Keep every pending AI change, on every page", () => userResolves("accept"), true);
	}

	ui.editor.undoManager.addListener(W.mxEvent.ADD, (_sender: any, evt: any) => {
		if (aiEditing > 0) return;
		const edit = evt.getProperty("edit");
		if (pageReview?.added.has(ui.currentPage) && edit?.changes?.some((ch: any) => ch.cell || ch.child)) {
			pageReview.edited.add(ui.currentPage);
		}
		if (review) absorbUserEdit(edit);
	});
	for (const name of [W.mxEvent.UNDO, W.mxEvent.REDO]) {
		ui.editor.undoManager.addListener(name, (_sender: any, evt: any) => {
			const edit = evt.getProperty("edit");
			if (!review) return;
			if (edit === review.edit) scheduleReviewRefresh();
			else absorbUserEdit(edit);
		});
	}
	model.addListener(W.mxEvent.CHANGE, () => scheduleReviewRefresh());
	// Switching pages parks the pending changes of the page left and shows those of the page shown.
	ui.editor.addListener("pageSelected", () => {
		if (!reviewing) return;
		syncReviewPage();
		scheduleReviewRefresh();
	});
	graph.getSelectionModel().addListener(W.mxEvent.CHANGE, () => reviewing && renderReviewBar());
	for (const name of [W.mxEvent.SCALE, W.mxEvent.TRANSLATE, W.mxEvent.SCALE_AND_TRANSLATE]) {
		graph.view.addListener(name, () => review && paintGhosts());
	}

	function exportImage(action: AiExportImageAction): Promise<AiExportImageEvent> {
		return new Promise((resolve) => {
			const done = (dataUrl: string, error?: string) =>
				resolve({ event: "aiExportImage", message: action, dataUrl, error });
			try {
				const cells = (action.cellIds || []).map((id) => model.getCell(id)).filter(Boolean);
				const bounds = cells.length > 0 ? graph.getBoundingBox(cells) : graph.getGraphBounds();
				const viewScale = graph.view.scale || 1;
				const size = Math.max(bounds?.width ?? 0, bounds?.height ?? 0) / viewScale;
				if (!size) {
					done("", "Diagram is empty");
					return;
				}
				const scale = Math.min(2, (action.maxSize || 1024) / size);
				ui.editor.exportToCanvas(
					(canvas: HTMLCanvasElement) => {
						try {
							done(canvas.toDataURL("image/png"));
						} catch (e: any) {
							done("", String(e?.message ?? e));
						}
					},
					null, null, null,
					(e: any) => done("", String(e?.message ?? e ?? "Export failed")),
					null, true, scale, false, false, null, null, 10, false, false, null, null,
					cells.length > 0 ? cells : null
				);
			} catch (e: any) {
				done("", String(e?.message ?? e));
			}
		});
	}

	// ---------------------------------------------------------------------
	// Page operations (drawio_pages), with draw.io's own undoable page changes
	// ---------------------------------------------------------------------

	function pagesOp(action: AiPagesAction): AiPagesEvent {
		const reply = (page?: any, extra: Partial<AiPagesEvent> = {}): AiPagesEvent => ({
			event: "aiPages",
			message: action,
			pages: allPages().map(pageInfo),
			...(page ? { page: pageInfo(page) } : {}),
			...extra,
		});
		aiEditing++;
		try {
			const pages = allPages();
			if (action.op === "list") return reply();
			if (pages.length === 0) throw new Error("This diagram has no pages.");
			if (!graph.isEnabled()) throw new Error("The diagram is read-only.");
			if (graph.isEditing() && !action.dryRun) graph.stopEditing(false);
			const position = (max: number) =>
				typeof action.index === "number" && Number.isFinite(action.index)
					? Math.max(0, Math.min(max, Math.round(action.index)))
					: undefined;
			const target = () => {
				if (!action.page) throw new Error(`${action.op} needs the page's id or name.`);
				return findPage(action.page);
			};

			switch (action.op) {
				case "add": {
					const page = ui.createPage(action.name?.trim() || null, ui.createPageId());
					insertPage(page, position(pages.length) ?? pages.length, action.select !== false);
					if (action.review) notePageChange({ added: page });
					return reply(page);
				}
				case "duplicate": {
					const source = target();
					const name = action.name?.trim() || W.mxResources.get("copyOf", [pageName(source)]) || `Copy of ${pageName(source)}`;
					const copy = clonePage(source, name);
					insertPage(copy, position(pages.length) ?? pages.indexOf(source) + 1, action.select !== false);
					if (action.review) notePageChange({ added: copy });
					return reply(copy);
				}
				case "rename": {
					const page = target();
					const name = action.name?.trim();
					if (!name) throw new Error("rename needs the new name.");
					const from = pageName(page);
					if (name !== from) {
						model.execute(new W.RenamePage(ui, page, name));
						if (action.review) notePageChange({ renamed: page, from, to: name });
					}
					return reply(page);
				}
				case "move": {
					const page = target();
					const to = position(pages.length - 1);
					if (to === undefined) throw new Error("move needs the new 0-based index.");
					const from = pages.indexOf(page);
					if (to !== from) {
						const order = pages.slice();
						ui.movePage(from, to);
						if (action.review) notePageChange({ moved: page, order });
					}
					return reply(page);
				}
				case "select": {
					const page = target();
					if (page !== ui.currentPage) ui.selectPage(page);
					return reply(page);
				}
				case "delete": {
					const page = target();
					const info = pageInfo(page);
					// Deleting a page the AI added needs no confirmation, unless the user has drawn on it.
					const aiAdded = !!pageReview?.added.has(page) && !pageReview.edited.has(page);
					if (pages.length <= 1) {
						throw new Error(`"${info.name}" is the only page, and a diagram needs one. To empty it, delete its cells instead.`);
					}
					if (action.dryRun) return reply(page, { aiAdded });
					// Shows the next page when it was the one shown, like draw.io's Delete Page.
					ui.removePage(page);
					if (allPages().includes(page)) throw new Error(`Could not delete page "${info.name}".`);
					return { ...reply(), page: info, aiAdded };
				}
				default:
					throw new Error(`Unknown page action "${(action as any).op}".`);
			}
		} catch (e: any) {
			let pages: AiPageInfo[] = [];
			try {
				pages = allPages().map(pageInfo);
			} catch {
				// a page that cannot be read
			}
			return { event: "aiPages", message: action, pages, error: String(e?.message ?? e) };
		} finally {
			aiEditing--;
			if (action.review) refreshReview();
		}
	}

	/** Inserts a page as one undoable step; shows it when `select`. */
	function insertPage(page: any, index: number, select: boolean) {
		if (select) ui.insertPage(page, index);
		else model.execute(new W.ChangePage(ui, page, null, index));
	}

	/** A copy of any page (draw.io's own Duplicate only copies the page shown), with new cell ids. */
	function clonePage(source: any, name: string): any {
		const root = pageRoot(source);
		const node = source.node.cloneNode(false);
		node.removeAttribute("id");
		const copy = new W.DiagramPage(node, ui.createPageId());
		const cloneMap: Record<string, any> = {};
		const lookup = graph.createCellLookup([root]);
		copy.root = model.cloneCells([root], true, cloneMap)[0];
		// Gives the copies new ids, as draw.io's Duplicate does.
		const ids = new W.mxGraphModel();
		ids.prefix = W.Editor.guid() + "-";
		ids.setRoot(copy.root);
		graph.updateCustomLinks(graph.createCellMapping(cloneMap, lookup), [copy.root]);
		// A deep copy: draw.io changes parts of a page's view state (e.g. its translate) in place.
		const view = source === ui.currentPage ? graph.getViewState() : source.viewState;
		copy.viewState = view ? mx.utils.clone(view, W.EditorUi.transientViewStateProperties) : graph.getViewState();
		ui.initDiagramNode(copy);
		copy.viewState.scale = 1;
		delete copy.viewState.scrollLeft;
		delete copy.viewState.scrollTop;
		delete copy.viewState.currentRoot;
		delete copy.viewState.defaultParent;
		copy.setName(name);
		return copy;
	}

	// ---------------------------------------------------------------------
	// Visio export
	// ---------------------------------------------------------------------

	async function exportVisio(action: AiExportVsdxAction): Promise<AiExportVsdxEvent> {
		const empty = { data: "", pages: 0, shapes: 0, connectors: 0, images: 0, warnings: [] as string[] };
		try {
			const result = await exportVsdx(ui, { currentPageOnly: action.currentPageOnly });
			return { event: "aiExportVsdx", message: action, ...result, data: toBase64(result.data) };
		} catch (e: any) {
			return { event: "aiExportVsdx", message: action, ...empty, error: String(e?.message ?? e) };
		}
	}

	// ---------------------------------------------------------------------
	// Importing files from other tools (Visio, Gliffy, GraphML, Lucidchart)
	// ---------------------------------------------------------------------

	/** Converts a file with draw.io's own importers; the open diagram is not touched. */
	async function importFile(action: AiImportDiagramAction): Promise<AiImportDiagramEvent> {
		const message = { ...action, data: "" };
		try {
			const binary = atob(action.data);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			const result = await importDiagram(ui, action.format, bytes, action.fileName, { timeoutMs: action.timeoutMs });
			return { event: "aiImportDiagram", message, ...result };
		} catch (e: any) {
			const error = String(e?.message ?? e);
			return { event: "aiImportDiagram", message, xml: "", kind: "diagram", pages: 0, shapes: 0, connectors: 0, warnings: [], error };
		}
	}

	function toBase64(bytes: Uint8Array): string {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
		}
		return btoa(s);
	}

	// ---------------------------------------------------------------------
	// Shape library search (draw.io's own sidebar index)
	// ---------------------------------------------------------------------

	/** Sidebar entries are DOM factories; intercept createItem to get their cells. */
	function captureTemplate(fn: any): { cells: any[]; title: string } | undefined {
		const sidebar = ui.sidebar;
		const original = sidebar.createItem;
		let captured: { cells: any[]; title: string } | undefined;
		sidebar.createItem = function (cells: any[], title: string) {
			captured = { cells, title };
			return document.createElement("a");
		};
		try {
			fn();
		} catch {
			// Some entries need UI state; skip them.
		} finally {
			sidebar.createItem = original;
		}
		return captured;
	}

	function searchShapes(action: AiSearchShapesAction): Promise<AiSearchShapesEvent> {
		return new Promise((resolve) => {
			const done = (shapes: AiShapeTemplate[], error?: string) =>
				resolve({ event: "aiSearchShapes", message: action, shapes, error });
			const sidebar = ui.sidebar;
			if (!sidebar?.searchEntries) {
				done([], "Shape library search is not available in this editor");
				return;
			}
			const limit = Math.min(Math.max(action.limit || 8, 1), 25);
			try {
				sidebar.searchEntries(
					action.query,
					limit,
					0,
					(results: any[]) => {
						const shapes: AiShapeTemplate[] = [];
						for (const fn of (results || []).slice(0, limit)) {
							const t = captureTemplate(fn);
							const first = t?.cells?.[0];
							if (!t || !first) continue;
							const shape: AiShapeTemplate = {
								title: t.title || "",
								library: fn.parentLibraries?.[0],
								style: first.style || "",
								width: first.geometry?.width ?? 0,
								height: first.geometry?.height ?? 0,
								isEdge: !!first.edge,
							};
							if (t.cells.length > 1 || first.getChildCount?.() > 0) {
								shape.xml = mx.utils.getXml(graph.encodeCells(t.cells)).slice(0, 6000);
							}
							shapes.push(shape);
						}
						done(shapes);
					},
					(e: any) => done([], String(e?.message ?? e ?? "Search failed")),
					true
				);
			} catch (e: any) {
				done([], String(e?.message ?? e));
			}
		});
	}

	// ---------------------------------------------------------------------
	// In-diagram UI: status pill, inline prompt, lasso
	// ---------------------------------------------------------------------

	const isDark = () => !!W.Editor?.isDarkMode?.();

	function themed(el: HTMLElement) {
		const dark = isDark();
		el.style.background = dark ? "#1f1f23" : "#ffffff";
		el.style.color = dark ? "#e5e5e5" : "#1f2328";
		el.style.border = `1px solid ${dark ? "#3f3f46" : "#d0d7de"}`;
	}

	let statusEl: HTMLDivElement | undefined;
	function setStatus(busy: boolean, text?: string) {
		if (!busy) {
			statusEl?.remove();
			statusEl = undefined;
			return;
		}
		if (!statusEl) {
			statusEl = document.createElement("div");
			Object.assign(statusEl.style, {
				position: "fixed", right: "16px", bottom: "16px", zIndex: "10001",
				padding: "6px 12px", borderRadius: "999px", font: "12px system-ui, sans-serif",
				boxShadow: "0 4px 16px rgba(0,0,0,.2)", pointerEvents: "none",
			});
			themed(statusEl);
			statusEl.style.borderColor = ACCENT;
			document.body.appendChild(statusEl);
		}
		statusEl.textContent = `✦ ${text || "AI is working…"}`;
	}

	function selectionClientRect(cells: any[]): DOMRect | undefined {
		if (cells.length === 0) return undefined;
		const b = graph.getBoundingBox(cells);
		if (!b) return undefined;
		const r = graph.container.getBoundingClientRect();
		return new DOMRect(
			r.left + b.x - graph.container.scrollLeft,
			r.top + b.y - graph.container.scrollTop,
			b.width,
			b.height
		);
	}

	let promptEl: HTMLDivElement | undefined;
	function closePrompt() {
		promptEl?.remove();
		promptEl = undefined;
	}

	function openPrompt(region?: AiRect) {
		closePrompt();
		const cells: any[] = graph.getSelectionCells();
		const el = document.createElement("div");
		promptEl = el;
		themed(el);
		Object.assign(el.style, {
			position: "fixed", zIndex: "10002", width: "340px", padding: "10px",
			borderRadius: "10px", boxShadow: "0 8px 28px rgba(0,0,0,.28)",
			font: "13px system-ui, sans-serif", borderColor: ACCENT,
		});

		const title = document.createElement("div");
		title.style.cssText = "font-weight:600;margin-bottom:6px;display:flex;gap:6px;align-items:center";
		title.textContent =
			cells.length > 0
				? `✦ Ask AI · ${cells.length} selected item${cells.length === 1 ? "" : "s"}`
				: "✦ Ask AI · whole diagram";

		const input = document.createElement("textarea");
		input.rows = 3;
		input.placeholder =
			cells.length > 0
				? "e.g. make these blue and connect them to the database"
				: "e.g. add a load balancer in front of the web servers";
		Object.assign(input.style, {
			width: "100%", boxSizing: "border-box", resize: "vertical", font: "inherit",
			padding: "6px 8px", borderRadius: "6px", outline: "none",
			background: isDark() ? "#141417" : "#f6f8fa", color: "inherit",
			border: `1px solid ${isDark() ? "#3f3f46" : "#d0d7de"}`,
		});

		const hint = document.createElement("div");
		hint.style.cssText = "opacity:.65;font-size:11px;margin-top:6px";
		hint.textContent = "Enter to send · Shift+Enter for newline · Esc to close";

		el.append(title, input, hint);
		document.body.appendChild(el);

		const anchor = selectionClientRect(cells);
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = anchor ? anchor.left : vw / 2 - 170;
		let top = anchor ? anchor.bottom + 12 : vh / 3;
		if (top + 140 > vh) top = Math.max(8, (anchor?.top ?? vh) - 150);
		left = Math.min(Math.max(8, left), vw - 350);
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;

		for (const type of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) {
			el.addEventListener(type, (e) => e.stopPropagation());
		}
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				closePrompt();
			} else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				const prompt = input.value.trim();
				if (!prompt) return;
				sendEvent({
					event: "aiAsk",
					prompt,
					cellIds: graph.getSelectionCells().map((c: any) => c.id),
					region,
				});
				closePrompt();
			}
		});
		input.addEventListener("keyup", (e) => e.stopPropagation());
		input.addEventListener("keypress", (e) => e.stopPropagation());
		setTimeout(() => input.focus(), 0);
	}

	let lassoEl: HTMLDivElement | undefined;

	function toGraph(clientX: number, clientY: number) {
		const p = mx.utils.convertPoint(graph.container, clientX, clientY);
		const { scale, translate } = graph.view;
		return { view: p, model: { x: p.x / scale - translate.x, y: p.y / scale - translate.y } };
	}

	function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]) {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const a = poly[i];
			const b = poly[j];
			if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
				inside = !inside;
			}
		}
		return inside;
	}

	function setLasso(enabled: boolean) {
		lassoEl?.remove();
		lassoEl = undefined;
		if (!enabled) {
			sendEvent({ event: "aiLasso", cellIds: [], lassoModeEnabled: false });
			return;
		}
		closePrompt();
		const rect = graph.container.getBoundingClientRect();
		const overlay = document.createElement("div");
		lassoEl = overlay;
		Object.assign(overlay.style, {
			position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
			width: `${rect.width}px`, height: `${rect.height}px`, zIndex: "10000",
			cursor: "crosshair", background: "rgba(168,85,247,0.05)", touchAction: "none",
		});
		const svgns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgns, "svg");
		svg.setAttribute("width", String(rect.width));
		svg.setAttribute("height", String(rect.height));
		svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
		const path = document.createElementNS(svgns, "path");
		path.setAttribute("fill", "rgba(168,85,247,0.12)");
		path.setAttribute("stroke", ACCENT);
		path.setAttribute("stroke-width", "2");
		path.setAttribute("stroke-dasharray", "6 4");
		svg.appendChild(path);
		const tip = document.createElement("div");
		tip.textContent = "✦ Draw around the shapes you want to change · Esc to cancel";
		tip.style.cssText = `position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:4px 10px;border-radius:999px;font:12px system-ui,sans-serif;background:${ACCENT};color:white;pointer-events:none`;
		overlay.append(svg, tip);
		document.body.appendChild(overlay);
		sendEvent({ event: "aiLasso", cellIds: [], lassoModeEnabled: true });

		let points: { x: number; y: number }[] = [];
		overlay.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			overlay.setPointerCapture(e.pointerId);
			points = [{ x: e.clientX, y: e.clientY }];
		});
		overlay.addEventListener("pointermove", (e) => {
			if (points.length === 0) return;
			points.push({ x: e.clientX, y: e.clientY });
			path.setAttribute(
				"d",
				"M" + points.map((p) => `${p.x - rect.left},${p.y - rect.top}`).join("L") + "Z"
			);
		});
		overlay.addEventListener("pointerup", (e) => {
			e.stopPropagation();
			const pts = points;
			points = [];
			const xs = pts.map((p) => p.x);
			const ys = pts.map((p) => p.y);
			if (pts.length < 3 || Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) < 12) {
				path.setAttribute("d", "");
				return;
			}
			const converted = pts.map((p) => toGraph(p.x, p.y));
			const poly = converted.map((p) => p.view);
			const selected = allCells().filter((c) => {
				const state = graph.view.getState(c);
				return (
					state &&
					graph.isCellVisible(c) &&
					pointInPolygon(state.getCenterX(), state.getCenterY(), poly)
				);
			});
			const mxs = converted.map((p) => p.model.x);
			const mys = converted.map((p) => p.model.y);
			const region: AiRect = {
				x: round(Math.min(...mxs)), y: round(Math.min(...mys)),
				width: round(Math.max(...mxs) - Math.min(...mxs)),
				height: round(Math.max(...mys) - Math.min(...mys)),
			};
			lassoEl?.remove();
			lassoEl = undefined;
			graph.setSelectionCells(selected);
			sendEvent({
				event: "aiLasso",
				cellIds: selected.map((c) => c.id),
				region,
				lassoModeEnabled: false,
			});
			openPrompt(region);
		});
	}

	// ---------------------------------------------------------------------
	// Markup: arrows, strike-throughs and pinned notes drawn over the diagram
	// (not part of the model), sent to the AI as one request.
	// ---------------------------------------------------------------------

	type Pt = { x: number; y: number };
	type Mark =
		| { kind: "arrow"; from: Pt; to: Pt; fromCell?: string; toCell?: string; note?: string }
		| { kind: "strike"; points: Pt[]; cells: string[] }
		| { kind: "note"; at: Pt; cell?: string; text: string };
	type MarkTool = "arrow" | "strike" | "note";
	const MARK = "#e11d48";

	let markup:
		| { marks: Mark[]; tool: MarkTool; overlay: HTMLDivElement; bar: HTMLDivElement; instructions: HTMLInputElement; draft?: Pt[]; noteInput?: HTMLDivElement }
		| undefined;
	let markLayer: SVGGElement | undefined;

	function cellAtView(view: Pt, verticesOnly: boolean): any | undefined {
		const cell = graph.getCellAt(view.x, view.y, null, true, !verticesOnly);
		return cell && !isLayer(cell) && cell !== model.getRoot() ? cell : undefined;
	}

	function describeCellForPrompt(id: string | undefined): string {
		const cell = id ? model.getCell(id) : undefined;
		if (!cell) return "empty space";
		const label = plainLabel(cell);
		if (model.isEdge(cell)) {
			const ends = [cell.source, cell.target].map((c: any) => (c ? `"${plainLabel(c) || c.id}"` : "?"));
			return `connector ${label ? `"${label}" ` : ""}${ends.join("→")} [id ${id}]`;
		}
		return `${label ? `"${label}"` : "unlabeled shape"} [id ${id}]`;
	}

	function markupPrompt(marks: Mark[], instructions: string): { prompt: string; cellIds: string[] } {
		const ids = new Set<string>();
		const at = (p: Pt) => `(x=${Math.round(p.x)}, y=${Math.round(p.y)})`;
		const lines = marks.map((m, i) => {
			const n = `${i + 1}.`;
			if (m.kind === "arrow") {
				[m.fromCell, m.toCell].forEach((id) => id && ids.add(id));
				const from = m.fromCell ? describeCellForPrompt(m.fromCell) : `empty space ${at(m.from)}`;
				const to = m.toCell ? describeCellForPrompt(m.toCell) : `empty space ${at(m.to)}`;
				return `${n} Arrow from ${from} to ${to}${m.note ? ` — "${m.note}"` : ""}`;
			}
			if (m.kind === "strike") {
				m.cells.forEach((id) => ids.add(id));
				return `${n} Strike-through over ${m.cells.map(describeCellForPrompt).join(", ")}`;
			}
			if (m.cell) ids.add(m.cell);
			return `${n} Note on ${m.cell ? describeCellForPrompt(m.cell) : `empty space ${at(m.at)}`}: "${m.text}"`;
		});
		return {
			cellIds: [...ids],
			prompt: [
				"I marked up the diagram (numbers match the marks I drew):",
				...lines,
				"",
				instructions || "Apply these marks.",
				"",
				"How to read the marks: an arrow means connect / data flow between the two ends (or move something there, if its note says so); a strike-through means remove the struck items; a note is a change request for the item or place it is pinned to. Coordinates are page coordinates.",
			].join("\n"),
		};
	}

	function paintMarkup() {
		markLayer?.remove();
		markLayer = undefined;
		if (!markup) return;
		const { scale, translate: t } = graph.view;
		const v = (p: Pt) => ({ x: (p.x + t.x) * scale, y: (p.y + t.y) * scale });
		const g = document.createElementNS(SVGNS, "g") as SVGGElement;
		g.setAttribute("pointer-events", "none");
		g.setAttribute("data-ai-markup-layer", "");
		const el = (name: string, attrs: Record<string, string | number>) => {
			const e = document.createElementNS(SVGNS, name);
			for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, String(val));
			g.appendChild(e);
			return e;
		};
		const badge = (p: Pt, n: number, text?: string, kind?: string) => {
			const circle = el("circle", { cx: p.x, cy: p.y, r: 9, fill: MARK });
			if (kind) circle.setAttribute("data-ai-mark", kind);
			const num = el("text", { x: p.x, y: p.y + 4, "text-anchor": "middle", "font-size": 11, "font-family": "system-ui,sans-serif", fill: "white", "font-weight": 700 });
			num.textContent = String(n);
			if (text) {
				const label = text.length > 48 ? text.slice(0, 47) + "…" : text;
				const w = label.length * 6.4 + 12;
				el("rect", { x: p.x + 12, y: p.y - 10, width: w, height: 20, rx: 4, fill: "#fff1f2", stroke: MARK });
				const tx = el("text", { x: p.x + 18, y: p.y + 4, "font-size": 11, "font-family": "system-ui,sans-serif", fill: "#881337" });
				tx.textContent = label;
			}
		};
		const all: (Mark | { kind: "draft"; points: Pt[] })[] = [...markup.marks];
		if (markup.draft) all.push({ kind: "draft", points: markup.draft });
		all.forEach((m, i) => {
			if (m.kind === "arrow" || (m.kind === "draft" && markup!.tool === "arrow")) {
				const a = v(m.kind === "arrow" ? m.from : m.points[0]);
				const b = v(m.kind === "arrow" ? m.to : m.points[m.points.length - 1]);
				const ang = Math.atan2(b.y - a.y, b.x - a.x);
				const head = (d: number) => `${b.x - 12 * Math.cos(ang + d)},${b.y - 12 * Math.sin(ang + d)}`;
				el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: MARK, "stroke-width": 3, "stroke-linecap": "round", "data-ai-mark": "arrow" });
				el("polygon", { points: `${b.x},${b.y} ${head(0.45)} ${head(-0.45)}`, fill: MARK });
				if (m.kind === "arrow") badge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, i + 1, m.note);
			} else if (m.kind === "strike" || m.kind === "draft") {
				const pts = m.points.map(v);
				el("polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), fill: "none", stroke: MARK, "stroke-width": 4, "stroke-opacity": 0.75, "stroke-linecap": "round", "stroke-linejoin": "round", "data-ai-mark": m.kind });
				if (m.kind === "strike") badge(pts[0], i + 1);
			} else {
				badge(v(m.at), i + 1, m.text, "note");
			}
		});
		markLayer = g;
		graph.view.getOverlayPane().appendChild(g);
	}

	function closeNoteInput() {
		markup?.noteInput?.remove();
		if (markup) markup.noteInput = undefined;
	}

	/** Small text field at a client position; resolves with the text, or undefined when cancelled. */
	function askNote(clientX: number, clientY: number, placeholder: string): Promise<string | undefined> {
		closeNoteInput();
		return new Promise((resolve) => {
			if (!markup) return resolve(undefined);
			const box = document.createElement("div");
			markup.noteInput = box;
			themed(box);
			Object.assign(box.style, {
				position: "fixed", zIndex: "10003", left: `${Math.min(clientX + 8, window.innerWidth - 270)}px`,
				top: `${Math.min(clientY + 8, window.innerHeight - 44)}px`, padding: "4px", borderRadius: "8px",
				borderColor: MARK, boxShadow: "0 6px 20px rgba(0,0,0,.25)",
			});
			const input = document.createElement("input");
			input.placeholder = placeholder;
			input.setAttribute("data-ai-markup-note", "");
			Object.assign(input.style, { width: "250px", font: "12px system-ui, sans-serif", padding: "4px 6px", border: "none", outline: "none", background: "transparent", color: "inherit" });
			box.appendChild(input);
			document.body.appendChild(box);
			for (const type of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) box.addEventListener(type, (e) => e.stopPropagation());
			let done = false;
			const finish = (value: string | undefined) => {
				if (done) return;
				done = true;
				closeNoteInput();
				resolve(value);
			};
			input.addEventListener("keydown", (e) => {
				e.stopPropagation();
				// preventDefault also suppresses the keypress, which draw.io would turn into a new text cell.
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					finish(input.value.trim());
				} else if (e.key === "Escape") {
					e.preventDefault();
					finish(undefined);
				}
			});
			input.addEventListener("keyup", (e) => e.stopPropagation());
			input.addEventListener("keypress", (e) => e.stopPropagation());
			input.addEventListener("blur", () => setTimeout(() => !box.contains(document.activeElement) && finish(input.value.trim() || undefined), 0));
			input.focus();
			setTimeout(() => input.focus(), 0);
		});
	}

	function renderMarkupBar() {
		if (!markup) return;
		const bar = markup.bar;
		themed(bar);
		bar.style.borderColor = MARK;
		for (const b of Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-tool]"))) {
			const active = b.dataset.tool === markup.tool;
			b.style.background = active ? MARK : "transparent";
			b.style.color = active ? "white" : "inherit";
		}
		const count = bar.querySelector<HTMLSpanElement>("[data-ai-markup-count]");
		if (count) count.textContent = markup.marks.length ? `${markup.marks.length} mark${markup.marks.length === 1 ? "" : "s"}` : "";
		const send = bar.querySelector<HTMLButtonElement>('[data-ai-markup="send"]');
		if (send) send.disabled = markup.marks.length === 0;
	}

	function sendMarkup() {
		if (!markup || markup.marks.length === 0) return;
		const { prompt, cellIds } = markupPrompt(markup.marks, markup.instructions.value.trim());
		const markCount = markup.marks.length;
		setMarkup(false);
		sendEvent({ event: "aiAsk", prompt, cellIds, source: "markup", markCount });
	}

	function setMarkup(enabled: boolean) {
		if (!enabled) {
			if (!markup) return;
			closeNoteInput();
			markup.overlay.remove();
			markup.bar.remove();
			markup = undefined;
			paintMarkup();
			sendEvent({ event: "aiMarkup", active: false });
			return;
		}
		if (markup) return;
		if (lassoEl) setLasso(false);
		closePrompt();
		if (graph.isEditing()) graph.stopEditing(false);
		(document.activeElement as HTMLElement | null)?.blur?.();

		const rect = graph.container.getBoundingClientRect();
		const overlay = document.createElement("div");
		overlay.setAttribute("data-ai-markup-overlay", "");
		Object.assign(overlay.style, {
			position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
			zIndex: "10000", cursor: "crosshair", background: "rgba(225,29,72,0.03)", touchAction: "none",
		});

		const bar = document.createElement("div");
		bar.setAttribute("data-ai-markup-bar", "");
		Object.assign(bar.style, {
			position: "fixed", left: `${rect.left + rect.width / 2}px`, top: `${rect.top + 10}px`, transform: "translateX(-50%)",
			zIndex: "10002", display: "flex", gap: "6px", alignItems: "center", padding: "5px 6px 5px 10px", borderRadius: "10px",
			font: "12px system-ui, sans-serif", boxShadow: "0 6px 20px rgba(0,0,0,.25)", whiteSpace: "nowrap",
		});
		for (const type of ["mousedown", "pointerdown", "click", "dblclick", "wheel", "keydown", "keyup", "keypress"]) {
			bar.addEventListener(type, (e) => e.stopPropagation());
		}
		const title = document.createElement("span");
		title.style.fontWeight = "600";
		title.textContent = "✎ Markup";
		bar.appendChild(title);
		const button = (text: string, key: string, tip: string, onClick: () => void, tool?: MarkTool) => {
			const b = document.createElement("button");
			b.textContent = text;
			b.title = tip;
			b.setAttribute("data-ai-markup", key);
			if (tool) b.dataset.tool = tool;
			Object.assign(b.style, {
				font: "inherit", padding: "3px 8px", borderRadius: "6px", cursor: "pointer",
				border: `1px solid ${isDark() ? "#3f3f46" : "#d0d7de"}`, background: "transparent", color: "inherit",
			});
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick();
			});
			bar.appendChild(b);
			return b;
		};
		const pick = (tool: MarkTool) => () => {
			if (!markup) return;
			markup.tool = tool;
			renderMarkupBar();
		};
		button("➜ Arrow", "arrow", "Drag from one shape (or spot) to another (A)", pick("arrow"), "arrow");
		button("✕ Strike", "strike", "Scribble across shapes or connectors to remove them (S)", pick("strike"), "strike");
		button("✎ Note", "note", "Click a shape or empty spot and type a request (N)", pick("note"), "note");
		button("↶", "undo", "Remove the last mark (Ctrl/Cmd+Z)", () => {
			markup?.marks.pop();
			paintMarkup();
			renderMarkupBar();
		});
		const instructions = document.createElement("input");
		instructions.placeholder = "Anything else? (optional)";
		instructions.setAttribute("data-ai-markup-instructions", "");
		Object.assign(instructions.style, {
			width: "190px", font: "inherit", padding: "3px 6px", borderRadius: "6px", outline: "none", color: "inherit",
			background: isDark() ? "#141417" : "#f6f8fa", border: `1px solid ${isDark() ? "#3f3f46" : "#d0d7de"}`,
		});
		instructions.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				sendMarkup();
			} else if (e.key === "Escape") {
				e.preventDefault();
				setMarkup(false);
			}
		});
		bar.appendChild(instructions);
		const count = document.createElement("span");
		count.setAttribute("data-ai-markup-count", "");
		count.style.opacity = ".7";
		bar.appendChild(count);
		const send = button("Send to AI", "send", "Send all marks as one request (Enter)", sendMarkup);
		Object.assign(send.style, { background: ACCENT, borderColor: ACCENT, color: "white" });
		button("✕", "close", "Leave markup mode (Esc)", () => setMarkup(false));

		document.body.append(overlay, bar);
		markup = { marks: [], tool: "arrow", overlay, bar, instructions };
		renderMarkupBar();
		sendEvent({ event: "aiMarkup", active: true });

		overlay.addEventListener("wheel", (e) => {
			e.preventDefault();
			graph.container.scrollLeft += e.deltaX;
			graph.container.scrollTop += e.deltaY;
		}, { passive: false });

		let start: { client: Pt; view: Pt; model: Pt } | undefined;
		overlay.addEventListener("pointerdown", (e) => {
			if (!markup || e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			closeNoteInput();
			const p = toGraph(e.clientX, e.clientY);
			start = { client: { x: e.clientX, y: e.clientY }, view: p.view, model: p.model };
			if (markup.tool !== "note") {
				overlay.setPointerCapture(e.pointerId);
				markup.draft = [p.model];
			}
		});
		overlay.addEventListener("pointermove", (e) => {
			if (!markup?.draft || !start) return;
			const p = toGraph(e.clientX, e.clientY).model;
			if (markup.tool === "arrow") markup.draft = [markup.draft[0], p];
			else markup.draft.push(p);
			paintMarkup();
		});
		overlay.addEventListener("pointerup", async (e) => {
			e.stopPropagation();
			if (!markup || !start) return;
			const s = start;
			start = undefined;
			const end = toGraph(e.clientX, e.clientY);
			const draft = markup.draft ?? [];
			markup.draft = undefined;
			const moved = Math.hypot(e.clientX - s.client.x, e.clientY - s.client.y);
			if (markup.tool === "note") {
				const cell = cellAtView(s.view, false);
				const text = await askNote(e.clientX, e.clientY, cell ? `Note on "${plainLabel(cell) || cell.id}"…` : "Note for this spot…");
				if (markup && text) markup.marks.push({ kind: "note", at: s.model, cell: cell?.id, text });
			} else if (markup.tool === "arrow" && moved > 12) {
				const mark: Mark = {
					kind: "arrow", from: s.model, to: end.model,
					fromCell: cellAtView(s.view, true)?.id, toCell: cellAtView(end.view, true)?.id,
				};
				markup.marks.push(mark);
				paintMarkup();
				renderMarkupBar();
				const note = await askNote(e.clientX, e.clientY, "What does this arrow mean? (optional, Enter)");
				if (note) mark.note = note;
			} else if (markup.tool === "strike" && moved > 12) {
				const { scale, translate: t } = graph.view;
				const ids: string[] = [];
				for (const p of draft) {
					const cell = cellAtView({ x: (p.x + t.x) * scale, y: (p.y + t.y) * scale }, false);
					if (cell && !ids.includes(cell.id)) ids.push(cell.id);
				}
				if (ids.length) markup.marks.push({ kind: "strike", points: draft, cells: ids });
			}
			paintMarkup();
			renderMarkupBar();
		});
	}

	for (const name of [W.mxEvent.SCALE, W.mxEvent.TRANSLATE, W.mxEvent.SCALE_AND_TRANSLATE]) {
		graph.view.addListener(name, () => markup && paintMarkup());
	}

	// ---------------------------------------------------------------------
	// Badges: small clickable status icons on cells (e.g. stale code links).
	// Cell overlays live in the view only and are never written to the file.
	// ---------------------------------------------------------------------

	const BADGE_COLORS = { error: REMOVED, warning: CHANGED, info: "#2563eb" };
	const badgeImages = new Map<string, any>();
	const badgeOverlays = new Map<string, { cell: any; overlay: any }[]>();

	function badgeImage(kind: AiBadge["kind"]) {
		let img = badgeImages.get(kind);
		if (!img) {
			const glyph = kind === "info" ? "i" : "!";
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="8" fill="${BADGE_COLORS[kind]}" stroke="white" stroke-width="1.5"/><text x="9" y="13" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="white">${glyph}</text></svg>`;
			img = new W.mxImage(`data:image/svg+xml;base64,${btoa(svg)}`, 18, 18);
			badgeImages.set(kind, img);
		}
		return img;
	}

	function setBadges(group: string, badges: AiBadge[]) {
		for (const { cell, overlay } of badgeOverlays.get(group) ?? []) graph.removeCellOverlay(cell, overlay);
		const added: { cell: any; overlay: any }[] = [];
		for (const b of badges) {
			const cell = model.getCell(b.cellId);
			if (!cell) continue;
			const overlay = new W.mxCellOverlay(badgeImage(b.kind), b.tooltip, mx.constants.ALIGN_RIGHT, mx.constants.ALIGN_TOP, new W.mxPoint(-2, 2), "pointer");
			overlay.aiBadge = { group, kind: b.kind };
			overlay.addListener(W.mxEvent.CLICK, () => sendEvent({ event: "aiBadgeClick", group, cellId: b.cellId }));
			graph.addCellOverlay(cell, overlay);
			added.push({ cell, overlay });
		}
		badgeOverlays.set(group, added);
	}

	// Turn the selected image (or any shape) into an editable diagram.
	async function convertToDiagram(cell: any) {
		const result = await exportImage({ action: "aiExportImage", cellIds: [cell.id], maxSize: 1600 });
		const prefix = "data:image/png;base64,";
		if (!result.dataUrl.startsWith(prefix)) return;
		const g = cell.geometry;
		sendEvent({
			event: "aiAsk",
			source: "image",
			cellIds: [cell.id],
			images: [{ mimeType: "image/png", base64: result.dataUrl.slice(prefix.length) }],
			prompt:
				`Convert the attached image (cell ${cell.id}${g ? ` at x=${Math.round(g.x)}, y=${Math.round(g.y)}, ${Math.round(g.width)}x${Math.round(g.height)}` : ""}) into an editable diagram: recreate its shapes, labels, connections and layout with real draw.io shapes (search the libraries for recognisable icons), placed where the image is. Then delete the image cell ${cell.id} and render the result to compare.`,
		});
	}

	const isImageCell = (cell: any) => !!cell && model.isVertex(cell) && /(^|;)(image|shape=image)(;|$)|(^|;)image=/.test(cell.style || "");

	// Context menu entries.
	const menus = ui.menus;
	const originalCreatePopupMenu = menus.createPopupMenu;
	menus.createPopupMenu = function (menu: any, cell: any, evt: any) {
		originalCreatePopupMenu.apply(this, arguments);
		menu.addSeparator();
		menu.addItem("✦ Ask AI…  (Alt+K)", null, () => openPrompt());
		menu.addItem("✦ Lasso select for AI  (Alt+L)", null, () => setLasso(true));
		menu.addItem("✦ Mark up for AI  (Alt+M)", null, () => setMarkup(true));
		const selected = graph.getSelectionCells();
		if (selected.length === 1 && model.isVertex(selected[0]) && (isImageCell(selected[0]) || !plainLabel(selected[0]))) {
			menu.addItem("✦ Convert image to diagram", null, () => void convertToDiagram(selected[0]));
		}
		const sel = selectedPending();
		if (sel.length > 0) {
			menu.addItem(`✦ Keep AI change${sel.length > 1 ? "s" : ""}`, null, () => userResolves("accept", sel));
			menu.addItem(`✦ Revert AI change${sel.length > 1 ? "s" : ""}`, null, () => userResolves("reject", sel));
		}
	};

	document.addEventListener(
		"keydown",
		(e) => {
			if (e.key === "Escape" && lassoEl) {
				setLasso(false);
				e.stopPropagation();
				return;
			}
			if (markup?.noteInput && !markup.noteInput.contains(e.target as Node)) {
				// A key arrived before the note field got focus: keep it away from draw.io's single-key shortcuts.
				const input = markup.noteInput.querySelector("input");
				if (input && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) input.value += e.key;
				input?.focus();
				if (e.key === "Escape" || e.key === "Enter") input?.dispatchEvent(new KeyboardEvent("keydown", { key: e.key }));
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (markup && !markup.noteInput) {
				const target = e.target as HTMLElement | null;
				// draw.io keeps an invisible "typing shim" textarea focused so typing edits the selected cell; that is not a field.
				const inField = !!target && /^(INPUT|TEXTAREA)$/.test(target.tagName) && !target.classList.contains("mxTypingShim");
				if (inField) return;
				const mod = e.ctrlKey || e.metaKey;
				if (e.key === "Escape") {
					setMarkup(false);
				} else if (mod && e.key.toLowerCase() === "z") {
					markup.marks.pop();
					paintMarkup();
					renderMarkupBar();
				} else if (!mod && !e.altKey && /^[asn]$/i.test(e.key)) {
					markup.tool = ({ a: "arrow", s: "strike", n: "note" } as const)[e.key.toLowerCase() as "a"];
					renderMarkupBar();
				} else if (e.key === "Enter") {
					sendMarkup();
				} else if (!mod && (e.key.length === 1 || e.key === "Delete" || e.key === "Backspace")) {
					// Swallow typing and deletion so they cannot edit the diagram underneath the markup.
				} else {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			const target = e.target as HTMLElement | null;
			const typing =
				graph.isEditing() ||
				(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
			if (typing || !e.altKey || e.ctrlKey || e.metaKey) return;
			if (e.code === "KeyK") {
				e.preventDefault();
				e.stopPropagation();
				openPrompt();
			} else if (e.code === "KeyL") {
				e.preventDefault();
				e.stopPropagation();
				setLasso(!lassoEl);
			} else if (e.code === "KeyM") {
				e.preventDefault();
				e.stopPropagation();
				setMarkup(!markup);
			}
		},
		true
	);

	// ---------------------------------------------------------------------
	// Protocol
	// ---------------------------------------------------------------------

	window.addEventListener("message", async (evt) => {
		if (evt.source !== window.opener) {
			return;
		}
		let data: CustomDrawioAction;
		try {
			data = JSON.parse(evt.data);
		} catch {
			return;
		}
		if (!data || typeof data.action !== "string" || !data.action.startsWith("ai")) {
			return;
		}
		evt.stopImmediatePropagation();

		switch (data.action) {
			case "aiGetModel": {
				let evt: AiModelEvent;
				try {
					evt = { event: "aiModel", message: data, model: snapshot(data) };
				} catch (e: any) {
					evt = { event: "aiModel", message: data, model: emptyModel(), error: String(e?.message ?? e) };
				}
				sendEvent(evt);
				break;
			}
			case "aiApplyOps":
				sendEvent(await serialized(() => applyOps(data)));
				break;
			case "aiSetSelection": {
				const cells = data.cellIds.map((id) => model.getCell(id)).filter(Boolean);
				graph.setSelectionCells(cells);
				if (data.reveal && cells.length > 0) {
					graph.scrollCellToVisible(cells[0], true);
					flash(cells);
				}
				sendEvent({ event: "aiAck", message: data });
				break;
			}
			case "aiSetLassoMode":
				setLasso(data.enabled);
				sendEvent({ event: "aiAck", message: data });
				break;
			case "aiSetStatus":
				setStatus(data.busy, data.text);
				break;
			case "aiOpenPrompt":
				openPrompt();
				break;
			case "aiExportImage":
				sendEvent(await exportImage(data));
				break;
			case "aiSearchShapes":
				sendEvent(await searchShapes(data));
				break;
			case "aiExportVsdx":
				sendEvent(await exportVisio(data));
				break;
			case "aiImportDiagram":
				sendEvent(await importFile(data));
				break;
			case "aiSetBadges":
				setBadges(data.group, data.badges);
				break;
			case "aiSetMarkupMode":
				setMarkup(data.enabled);
				break;
			case "aiResolveReview":
				await serialized(() => resolveReview(data.decision, data.cellIds));
				break;
			case "aiPages":
				sendEvent(await serialized(() => pagesOp(data)));
				break;
		}
	});
});
