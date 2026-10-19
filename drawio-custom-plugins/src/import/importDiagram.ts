/**
 * Converts diagrams made in other tools with draw.io's own importers, inside
 * the webview: Microsoft Visio (.vsdx, .vssx stencils, .vstx templates, and
 * binary .vsd/.vss/.vst through drawio-vsd), Gliffy, GraphML (yEd),
 * Lucidchart, Miro board data and draw.io's CSV format. The converters are the
 * scripts that ship with draw.io and are loaded from the webview's own files;
 * nothing is sent anywhere.
 */

const W = window as any;

export type ImportFormat = "visio" | "gliffy" | "graphml" | "lucidchart" | "miro" | "csv";

export interface ImportOptions {
	/** Gives up when the converter has not finished by then. */
	timeoutMs?: number;
}

export interface ImportResult {
	/** An uncompressed <mxfile>. */
	xml: string;
	/** "stencil" when a Visio stencil's shapes were laid out on a page. */
	kind: "diagram" | "stencil";
	pages: number;
	shapes: number;
	connectors: number;
	/** What the converter could not carry over, in words for the user. */
	warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 100_000;
const MAX_WARNINGS = 20;
const CONVERTER_SCRIPTS = /extensions\.min\.js|drawio-gliffy|drawio-vsd|jszip/i;

let queue: Promise<unknown> = Promise.resolve();

/**
 * Converts one file. Conversions run one at a time: the Lucidchart importer keeps
 * global state, and warnings are collected from the console while one runs.
 */
export function importDiagram(
	ui: any,
	format: ImportFormat,
	bytes: Uint8Array,
	fileName: string,
	options: ImportOptions = {}
): Promise<ImportResult> {
	const run = queue.then(() => convert(ui, format, bytes, fileName, options));
	queue = run.catch(() => undefined);
	return run;
}

async function convert(ui: any, format: ImportFormat, bytes: Uint8Array, fileName: string, options: ImportOptions): Promise<ImportResult> {
	const warnings = new Warnings();
	const raw = await watched(() => runImporter(ui, format, bytes, fileName, warnings), warnings, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	// GraphML has no page names, and draw.io numbers its pages from the wrong counter.
	return toDiagramFile(ui, raw, baseName(fileName), warnings, format === "graphml");
}

async function runImporter(ui: any, format: ImportFormat, bytes: Uint8Array, fileName: string, warnings: Warnings): Promise<string> {
	switch (format) {
		case "visio":
			return importVisio(ui, bytes, fileName, warnings);
		case "gliffy": {
			await ensureScript(() => W.mxGliffyToDrawio?.convertWithReport, "js/gliffy/drawio-gliffy.min.js");
			const result = W.mxGliffyToDrawio.convertWithReport(decodeText(bytes));
			for (const line of String(result.report ?? "").split("\n")) {
				const text = line.trim().replace(/^--\s*/, "").replace(/^Warning,\s*/, "");
				if (text) warnings.add(text);
			}
			return result.xml;
		}
		case "graphml": {
			await ensureScript(() => ui.doImportGraphML, "js/extensions.min.js");
			const text = decodeText(bytes);
			if (!/<graphml[\s>]/.test(text)) {
				throw new Error("This is not a GraphML file.");
			}
			// draw.io 32 routes edges with Graph.isRoundedPerimeter, which only its own
			// Graph class has, but the GraphML importer lays the diagram out in a plain
			// mxGraph: without this every diagram with a connector fails to import.
			const plain = W.mxGraph.prototype;
			if (typeof plain.isRoundedPerimeter !== "function") {
				plain.isRoundedPerimeter = () => false;
			}
			return callback<string>((done, fail) => ui.doImportGraphML(text, done, fail));
		}
		case "lucidchart": {
			await ensureScript(() => W.LucidImporter?.importState, "js/extensions.min.js");
			const text = decodeText(bytes);
			let data: any;
			try {
				data = JSON.parse(text);
			} catch {
				throw new Error("This is not a Lucidchart export: the file is not JSON.");
			}
			if (!data || (data.state == null && data.Pages == null && data.Page == null && data.Blocks == null && data.Objects == null)) {
				throw new Error("This is not a Lucidchart export: it has no pages or shapes.");
			}
			const xml = await callback<string>((done, fail) => ui.convertLucidChart(text, done, fail));
			const lucid = W.LucidImporter;
			if (lucid.hasUnknownShapes) warnings.add("Some Lucidchart shapes have no draw.io equivalent; they were imported as plain shapes or left out.");
			if (lucid.hasOrgChart) warnings.add("Org charts were rebuilt with draw.io's org chart layout and may be arranged differently.");
			if (lucid.hasTimeLine) warnings.add("Timelines are not supported and were left out.");
			return xml;
		}
		case "miro":
			return importMiro(decodeText(bytes), warnings);
		case "csv":
			return importCsv(ui, decodeText(bytes), warnings);
		default:
			throw new Error(`Unknown format "${format}".`);
	}
}

async function importVisio(ui: any, bytes: Uint8Array, fileName: string, warnings: Warnings): Promise<string> {
	await ensureScript(() => ui.doImportVisio, "js/extensions.min.js");
	let data: Blob;
	let name = fileName;
	if (isCompoundFile(bytes)) {
		// Visio 2003-2010 binary drawing: drawio-vsd rewrites it as a Visio XML package.
		await ensureScript(() => W.DrawioVsd?.convert, "js/vsd/drawio-vsd.min.js");
		let converted: any;
		try {
			converted = W.DrawioVsd.convert(bytes, { filename: fileName });
		} catch (e) {
			throw new Error(`This binary Visio file could not be read: ${messageOf(e)}`);
		}
		const issues: string[] = converted.warnings ?? [];
		if (issues.length > 0) {
			warnings.add(
				`${issues.length} part${issues.length === 1 ? "" : "s"} of the binary Visio file could not be read and may be missing or look different (first: ${issues[0]}).`
			);
		}
		data = new Blob([converted.bytes()]);
		name = baseName(fileName) + "." + converted.type;
	} else if (isZip(bytes)) {
		// draw.io's codec never calls back for a ZIP without Visio parts (a renamed .docx, say).
		if (!containsAscii(bytes, "visio/")) {
			throw new Error("This ZIP file is not a Visio package: it has no Visio drawing in it.");
		}
		data = new Blob([bytes]);
	} else {
		throw new Error("This is not a Visio file draw.io can read: .vsdx, .vssx and .vstx files are ZIP packages, .vsd, .vss and .vst files are binary Visio documents.");
	}
	return callback<string>((done, fail) => ui.doImportVisio(data, done, fail, name));
}

/** The widget kinds draw.io's Miro importer draws; others become plain boxes. */
const MIRO_WIDGETS = ["shape", "sticker", "text", "card", "stencil", "paint", "line"];

/** Miro board data as Miro puts it on the clipboard: {"isProtected": …, "version": 2, "data": {"objects": […]}}. */
async function importMiro(text: string, warnings: Warnings): Promise<string> {
	await ensureScript(() => W.MiroImporter, "js/extensions.min.js");
	let board: any;
	try {
		board = JSON.parse(text);
	} catch {
		throw new Error("This is not Miro board data: the file is not JSON.");
	}
	if (!board || !board.data || !Array.isArray(board.data.objects)) {
		throw new Error("This is not Miro board data: it has no objects.");
	}
	if (board.version !== 2) {
		throw new Error(`Only version 2 of Miro's board data can be converted; this is version ${board.version}.`);
	}
	const unknown = new Map<string, number>();
	for (const o of board.data.objects) {
		const kind = o && o.type === 14 && o.widgetData ? String(o.widgetData.type) : undefined;
		if (kind && MIRO_WIDGETS.indexOf(kind) < 0) {
			unknown.set(kind, (unknown.get(kind) ?? 0) + 1);
		}
	}
	if (unknown.size > 0) {
		const n = Array.from(unknown.values()).reduce((a, b) => a + b, 0);
		const kinds = Array.from(unknown.keys()).join(", ");
		const became = n === 1 ? "became a plain box or was left out" : "became plain boxes or were left out";
		warnings.add(`${n} Miro widget${n === 1 ? "" : "s"} of a kind draw.io does not know (${kinds}) ${became}.`);
	}
	const xml = new W.MiroImporter().importMiroJson(board);
	if (!xml) {
		throw new Error("draw.io's Miro importer could not read this board data.");
	}
	return xml;
}

/**
 * draw.io's CSV format: rows plus "# key: value" lines that say how rows become
 * shapes, connectors and a layout. draw.io builds the result in the editor itself
 * (its layouts run on the editor's graph), so this only runs in an empty editor,
 * the conversion panel's, and empties it again. Nothing is rendered meanwhile, so
 * images the CSV links to are not fetched.
 */
async function importCsv(ui: any, text: string, warnings: Warnings): Promise<string> {
	const graph = ui.editor.graph;
	const model = graph.getModel();
	const empty =
		(ui.pages == null || ui.pages.length <= 1) &&
		model.getChildCount(model.getRoot()) <= 1 &&
		model.getChildCount(graph.getDefaultParent()) === 0;
	if (!empty) {
		throw new Error("CSV files are converted in an empty draw.io editor.");
	}
	if (!/^\s*#[^#\n]*:/m.test(text)) {
		warnings.add(
			'This CSV has no draw.io configuration (lines such as "# connect:" or "# label:"), so each row became one shape, without connectors. draw.io\'s CSV import (Arrange > Insert > Advanced > CSV) shows the configuration.'
		);
	}
	const saved = { handleError: ui.handleError, allowAnimation: ui.allowAnimation, rendering: graph.view.rendering };
	ui.allowAnimation = false;
	graph.view.rendering = false;
	try {
		await new Promise<void>((resolve, reject) => {
			// draw.io reports a bad configuration through a dialog instead of a callback.
			ui.handleError = (e: unknown) => reject(new Error(`The CSV could not be read: ${messageOf(e)}`));
			ui.importCsv(text, () => resolve(), null, true);
		});
		return W.mxUtils.getXml(ui.editor.getGraphXml());
	} finally {
		ui.handleError = saved.handleError;
		ui.allowAnimation = saved.allowAnimation;
		model.clear();
		ui.editor.undoManager.clear();
		graph.view.rendering = saved.rendering;
		graph.refresh();
	}
}

// ---------------------------------------------------------------------------
// Running draw.io's converters
// ---------------------------------------------------------------------------

/** Wraps draw.io's done/error callbacks; its errors are plain objects with a message. */
function callback<T>(start: (done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => start(resolve, (e) => reject(new Error(messageOf(e)))));
}

/**
 * Runs a conversion and settles it however the converter ends: draw.io's
 * importers sometimes throw from inside a promise or timer and never call back,
 * so uncaught errors from the converter scripts and a timeout end it too.
 * What the converter scripts write to the console is kept as warnings.
 */
async function watched<T>(run: () => Promise<T>, warnings: Warnings, timeoutMs: number): Promise<T> {
	const original = { warn: console.warn, error: console.error, log: console.log };
	const keep = (all: boolean) => (...args: unknown[]) => {
		// Only messages from the converters, not from draw.io or other plugins meanwhile.
		if (!CONVERTER_SCRIPTS.test(new Error().stack ?? "")) return;
		const text = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" ").trim();
		if (text && (all || /no mapping|not supported|unsupported|unhandled|cannot|could not|failed/i.test(text))) {
			warnings.add(text);
		}
	};
	const warn = keep(true);
	const log = keep(false);
	console.warn = (...args: unknown[]) => (warn(...args), original.warn.apply(console, args));
	console.error = (...args: unknown[]) => (warn(...args), original.error.apply(console, args));
	console.log = (...args: unknown[]) => (log(...args), original.log.apply(console, args));

	let onError: (e: ErrorEvent) => void = () => {};
	let onRejection: (e: PromiseRejectionEvent) => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const crashed = new Promise<never>((_, reject) => {
		onError = (e) => {
			if (CONVERTER_SCRIPTS.test(e.filename || "") || CONVERTER_SCRIPTS.test(String(e.error?.stack ?? ""))) {
				reject(new Error(`draw.io's converter failed: ${e.error?.message ?? e.message}`));
			}
		};
		onRejection = (e) => {
			if (CONVERTER_SCRIPTS.test(String(e.reason?.stack ?? ""))) {
				reject(new Error(`draw.io's converter failed: ${messageOf(e.reason)}`));
			}
		};
		timer = setTimeout(() => reject(new Error(`draw.io's converter did not finish within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
	});
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	try {
		return await Promise.race([Promise.resolve().then(run), crashed]);
	} finally {
		clearTimeout(timer);
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
		console.warn = original.warn;
		console.error = original.error;
		console.log = original.log;
	}
}

/**
 * Loads one of draw.io's converter scripts from the webview's own copy of draw.io.
 * The paths are relative to the page's <base>; draw.io's own loaders use its
 * server URL, which does not point at those files inside VS Code.
 */
async function ensureScript(ready: () => unknown, src: string): Promise<void> {
	if (ready()) {
		return;
	}
	const loaded = Array.from(document.scripts).some((s) => s.src.endsWith("/" + src));
	if (!loaded) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = src;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`draw.io's converter (${src}) could not be loaded.`));
			document.head.appendChild(script);
		});
	}
	// A script draw.io started loading itself may still be on its way.
	const start = Date.now();
	while (!ready()) {
		if (Date.now() - start > 30_000) {
			throw new Error(`draw.io's converter (${src}) did not load.`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}

// ---------------------------------------------------------------------------
// The converted file
// ---------------------------------------------------------------------------

/** Turns whatever the converter returned into an uncompressed <mxfile> and counts what is in it. */
function toDiagramFile(ui: any, raw: unknown, name: string, warnings: Warnings, renumberPages = false): ImportResult {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error("The converter returned nothing.");
	}
	const root = parse(raw.trim());
	let kind: ImportResult["kind"] = "diagram";
	const pages: { name: string; id: string; model: Element }[] = [];
	let masters = 0;
	if (root.nodeName === "mxlibrary") {
		kind = "stencil";
		const library = libraryPage(ui, root);
		masters = library.shapes;
		pages.push({ name: name || "Stencil", id: W.Editor.guid(), model: library.model });
	} else if (root.nodeName === "mxGraphModel") {
		pages.push({ name: "Page-1", id: W.Editor.guid(), model: root });
	} else if (root.nodeName === "mxfile") {
		const diagrams = Array.from(root.children).filter((c) => c.nodeName === "diagram");
		diagrams.forEach((d, i) => {
			const inline = Array.from(d.children).find((c) => c.nodeName === "mxGraphModel");
			const model = inline ?? parse(W.Graph.decompress(d.textContent || ""));
			if (model.nodeName !== "mxGraphModel") {
				throw new Error(`Page ${i + 1} of the converted diagram could not be read.`);
			}
			const pageName = renumberPages ? "" : d.getAttribute("name");
			pages.push({ name: pageName || `Page-${i + 1}`, id: d.getAttribute("id") || W.Editor.guid(), model });
		});
	} else {
		throw new Error(`The converter returned <${root.nodeName}> instead of a diagram.`);
	}

	let shapes = 0;
	let connectors = 0;
	let webImages = 0;
	for (const page of pages) {
		for (const cell of Array.from(page.model.getElementsByTagName("mxCell"))) {
			if (cell.getAttribute("edge") === "1") connectors++;
			else if (cell.getAttribute("vertex") === "1") shapes++;
			if (/(^|;)image=https?:/i.test(cell.getAttribute("style") || "")) webImages++;
		}
	}
	if (pages.length === 0 || shapes + connectors === 0) {
		throw new Error("The file was read, but it contains no shapes.");
	}
	if (webImages > 0) {
		warnings.add(
			`${webImages} image${webImages === 1 ? " is" : "s are"} linked from the web instead of embedded; ${webImages === 1 ? "it is" : "they are"} downloaded when the diagram is shown.`
		);
	}

	const doc = W.mxUtils.createXmlDocument();
	const file = doc.createElement("mxfile");
	file.setAttribute("host", "65bd71144e");
	for (const page of pages) {
		const diagram = doc.createElement("diagram");
		diagram.setAttribute("name", page.name);
		diagram.setAttribute("id", page.id);
		diagram.appendChild(doc.importNode(page.model, true));
		file.appendChild(diagram);
	}
	doc.appendChild(file);
	// A stencil counts its shapes, not the cells they are drawn with or their name labels.
	const counts = kind === "stencil" ? { shapes: masters, connectors: 0 } : { shapes, connectors };
	return { xml: W.mxUtils.getXml(file), kind, pages: pages.length, ...counts, warnings: warnings.list() };
}

/** A Visio stencil comes back as a draw.io library: lay its shapes out on a page, each with its name below. */
function libraryPage(ui: any, root: Element): { model: Element; shapes: number } {
	let entries: { xml?: string; w?: number; h?: number; title?: string }[];
	try {
		// The Visio codec writes NaN for shapes it could not measure.
		entries = JSON.parse((root.textContent || "[]").replace(/:\s*NaN\b/g, ":null"));
	} catch {
		throw new Error("The stencil could not be read.");
	}
	// No container: nothing is rendered, like the Visio codec's own graphs.
	const graph = new W.Graph();
	try {
		const model = graph.getModel();
		const parent = graph.getDefaultParent();
		const items = entries
			.map((e) => {
				const cells: any[] = e.xml ? ui.stringToCells(e.xml.charAt(0) === "<" ? e.xml : W.Graph.decompress(e.xml)) : [];
				const box = cells.length > 0 && !(e.w && e.h) ? graph.getBoundingBoxFromGeometry(cells, true) : null;
				return { title: e.title && e.title !== "null" ? e.title : "", cells, w: e.w || box?.width || 0, h: e.h || box?.height || 0 };
			})
			.filter((e) => e.cells.length > 0);
		const width = Math.max(80, ...items.map((e) => e.w)) + 40;
		const height = Math.max(40, ...items.map((e) => e.h)) + 60;
		const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)));
		model.beginUpdate();
		try {
			items.forEach((item, i) => {
				const x = 20 + (i % columns) * width;
				const y = 20 + Math.floor(i / columns) * height;
				graph.importCells(item.cells, x + (width - 40 - item.w) / 2, y, parent);
				if (item.title) {
					const label = W.mxUtils.htmlEntities(item.title);
					graph.insertVertex(parent, null, label, x, y + item.h + 8, width - 40, 20, "text;html=1;align=center;verticalAlign=top;whiteSpace=wrap;fontSize=11;");
				}
			});
		} finally {
			model.endUpdate();
		}
		return { model: new W.mxCodec().encode(model), shapes: items.length };
	} finally {
		graph.destroy();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class Warnings {
	private readonly items: string[] = [];
	private dropped = 0;

	add(text: string): void {
		const t = text.replace(/\s+/g, " ").trim();
		if (!t || this.items.indexOf(t) >= 0) return;
		if (this.items.length < MAX_WARNINGS) this.items.push(t);
		else this.dropped++;
	}

	list(): string[] {
		return this.dropped > 0 ? [...this.items, `…and ${this.dropped} more.`] : [...this.items];
	}
}

function parse(xml: string): Element {
	const doc = W.mxUtils.parseXml(xml);
	const root: Element = doc.documentElement;
	if (!root || root.nodeName === "parsererror" || doc.getElementsByTagName("parsererror").length > 0) {
		throw new Error("The converter returned XML that could not be read.");
	}
	return root;
}

function decodeText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Whether the bytes contain the ASCII text, e.g. a file name in a ZIP directory. */
function containsAscii(bytes: Uint8Array, text: string): boolean {
	const first = text.charCodeAt(0);
	for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - text.length; i = bytes.indexOf(first, i + 1)) {
		let j = 1;
		while (j < text.length && bytes[i + j] === text.charCodeAt(j)) j++;
		if (j === text.length) return true;
	}
	return false;
}

function isZip(bytes: Uint8Array): boolean {
	return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

/** OLE2 compound file, the container of binary Visio documents. */
function isCompoundFile(bytes: Uint8Array): boolean {
	const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	return bytes.length >= 512 && signature.every((b, i) => bytes[i] === b);
}

function baseName(fileName: string): string {
	return fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
}

function messageOf(e: unknown): string {
	const m = (e as any)?.message;
	return typeof m === "string" && m ? m : e == null ? "unknown error" : String(e);
}
