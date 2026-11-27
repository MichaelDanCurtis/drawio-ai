import { PdfImage, PdfPage, rgbaToRgb, writePdf } from "./pdfWriter";

/**
 * Exports draw.io pages to a PDF, inside the webview and without a server:
 * draw.io's own PDF export needs its export service or a print dialog, and
 * neither works in VS Code. Each page is rendered by draw.io at high resolution
 * and placed on a PDF page of the diagram's size (1 px = 0.75 pt).
 */

export interface PdfExportOptions {
	/** Only the page that is visible in the editor. Default: all pages. */
	currentPageOnly?: boolean;
	title?: string;
}

export interface PdfExportResult {
	data: Uint8Array;
	pages: number;
	warnings: string[];
}

/** Rendering resolution: 3x is about 288 dpi when printed at 100%. */
const MAX_SCALE = 3;
/** Pixels per page, to keep memory and file size in check on huge diagrams. */
const MAX_PIXELS = 36_000_000;
const PX_TO_PT = 0.75;

export async function exportPdf(ui: any, options: PdfExportOptions = {}): Promise<PdfExportResult> {
	const lossless = typeof (globalThis as any).CompressionStream === "function";
	const { rendered, warnings } = await eachPage(ui, options, async (tmp, w, h) => {
		const scale = Math.max(0.25, Math.min(MAX_SCALE, Math.sqrt(MAX_PIXELS / (w * h))));
		const { canvas, svgWidth, svgHeight } = await toCanvas(ui, tmp, scale);
		return { image: readImage(canvas), widthPt: svgWidth * PX_TO_PT, heightPt: svgHeight * PX_TO_PT } as PdfPage;
	});
	const data = await writePdf(rendered, { title: options.title });
	return { data, pages: rendered.length, warnings };

	function readImage(canvas: HTMLCanvasElement): PdfImage {
		if (!lossless) {
			const url = canvas.toDataURL("image/jpeg", 0.92);
			const binary = atob(url.slice(url.indexOf(",") + 1));
			const data = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
			return { kind: "jpeg", width: canvas.width, height: canvas.height, data };
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("The page could not be rendered.");
		}
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		return { kind: "rgb", width: canvas.width, height: canvas.height, pixels: rgbaToRgb(data) };
	}
}

export interface PageSvg {
	svg: string;
	/** In CSS pixels. */
	width: number;
	height: number;
}

/**
 * Every page as the SVG draw.io draws for an export, in light colours: for a PDF whose text
 * stays text (see PrintPdf.ts). The pages are drawn in a temporary graph; the editor stays
 * on its page.
 */
export async function pageSvgs(ui: any, options: PdfExportOptions = {}): Promise<{ pages: PageSvg[]; warnings: string[] }> {
	const { rendered, warnings } = await eachPage(ui, options, async (tmp) => {
		const { svgRoot, svgWidth, svgHeight } = await toCanvas(ui, tmp, 1);
		if (!svgRoot) throw new Error("The page could not be drawn as an SVG.");
		return { svg: new XMLSerializer().serializeToString(svgRoot), width: svgWidth, height: svgHeight } as PageSvg;
	});
	return { pages: rendered, warnings };
}

/**
 * Draws each page (all of them unless `currentPageOnly`) in a temporary graph and hands it to
 * `render` with the drawing's size. An empty page is left out, and said so when there are others.
 */
async function eachPage<T>(ui: any, options: PdfExportOptions, render: (tmp: any, width: number, height: number) => Promise<T>): Promise<{ rendered: T[]; warnings: string[] }> {
	const graph = ui.editor.graph;
	const W = window as any;
	const allPages: any[] = ui.pages && ui.pages.length > 0 ? ui.pages : [null];
	const pages = options.currentPageOnly ? [allPages.includes(ui.currentPage) ? ui.currentPage : allPages[0]] : allPages;
	const rendered: T[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		const page = pages[i];
		const name = String(page?.getName?.() || `Page-${i + 1}`);
		const one = await renderPage(page);
		if (one !== undefined) {
			rendered.push(one);
		} else if (pages.length > 1) {
			warnings.push(`Page "${name}" is empty and was left out.`);
		}
	}
	if (rendered.length === 0) {
		throw new Error("The diagram is empty.");
	}
	return { rendered, warnings };

	async function renderPage(page: any): Promise<T | undefined> {
		let root: any;
		let background = graph.background;
		if (page == null || page === ui.currentPage) {
			// Decode a copy so that nothing here can touch the live model.
			const node = ui.editor.getGraphXml();
			root = new W.mxCodec(node.ownerDocument).decode(node).root;
		} else {
			ui.updatePageRoot(page);
			root = page.root;
			background = page.viewState?.background ?? background;
		}

		const tmp = ui.createTemporaryGraph(graph.getStylesheet());
		const container: HTMLElement = tmp.container;
		// Render HTML labels with light colors whatever the editor theme is.
		container.style.colorScheme = "light";
		document.body.appendChild(container);
		try {
			tmp.background = background;
			tmp.model.setRoot(root);
			const bounds = tmp.getGraphBounds();
			const s = tmp.view.scale || 1;
			const w = bounds.width / s;
			const h = bounds.height / s;
			if (!(w > 0 && h > 0)) {
				return undefined;
			}
			return await render(tmp, w, h);
		} finally {
			tmp.destroy();
			container.parentNode?.removeChild(container);
		}
	}
}

function toCanvas(ui: any, tmp: any, scale: number): Promise<{ canvas: HTMLCanvasElement; svgRoot: SVGElement | undefined; svgWidth: number; svgHeight: number }> {
	return new Promise((resolve, reject) => {
		ui.editor.exportToCanvas(
			(canvas: HTMLCanvasElement, svgRoot: SVGElement) => {
				const svgWidth = parseFloat(svgRoot?.getAttribute("width") ?? "") || canvas.width / scale;
				const svgHeight = parseFloat(svgRoot?.getAttribute("height") ?? "") || canvas.height / scale;
				resolve({ canvas, svgRoot: svgRoot ?? undefined, svgWidth, svgHeight });
			},
			null, // width
			null, // imageCache
			null, // background: the graph's
			(e: any) => reject(new Error(String(e?.message ?? e ?? "The page could not be rendered."))),
			false, // limitHeight
			true, // ignoreSelection
			scale,
			false, // transparentBackground: PDF pages are opaque
			false, // addShadow
			null, // converter
			tmp,
			10, // border
			false, // noCrop
			false, // grid
			"light"
		);
	});
}
