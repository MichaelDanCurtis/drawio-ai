import { BrowserWindow } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CustomizedDrawioClient } from "../../../src/DrawioClient/CustomizedDrawioClient";

export type ExportFormat = "pdf" | "svg" | "png" | "drawio" | "vsdx";
export const EXPORT_FORMATS: { format: ExportFormat; label: string; ext: string }[] = [
	{ format: "pdf", label: "PDF (vector)", ext: "pdf" },
	{ format: "svg", label: "SVG (editable .drawio.svg)", ext: "drawio.svg" },
	{ format: "png", label: "PNG (editable .drawio.png)", ext: "drawio.png" },
	{ format: "vsdx", label: "Visio (.vsdx)", ext: "vsdx" },
	{ format: "drawio", label: "draw.io (.drawio)", ext: "drawio" },
];

export interface ExportResult {
	bytes: number;
	note?: string;
}

/** Renders the diagram in the given format and writes it to `file`. */
export async function exportDiagram(
	client: CustomizedDrawioClient,
	format: ExportFormat,
	file: string,
	options: { currentPageOnly?: boolean } = {}
): Promise<ExportResult> {
	let data: Buffer;
	let note: string | undefined;
	switch (format) {
		case "pdf": {
			const r = await exportPdf(client, options);
			data = r.data;
			note = `${r.pages} page${r.pages === 1 ? "" : "s"}`;
			break;
		}
		case "svg":
			data = Buffer.from((await client.exportAsSvgWithEmbeddedXml()).toString("base64"), "base64");
			note = "page shown";
			break;
		case "png":
			data = Buffer.from((await client.exportAsPngWithEmbeddedXml(true)).toString("base64"), "base64");
			note = "page shown";
			break;
		case "drawio":
			data = Buffer.from(await client.getXml(), "utf8");
			break;
		case "vsdx": {
			const v = await client.exportVsdx({ currentPageOnly: options.currentPageOnly });
			data = Buffer.from(v.data.toString("base64"), "base64");
			note = `${v.pages} page(s), ${v.shapes} shapes, ${v.connectors} connectors${v.warnings.length ? `; ${v.warnings.length} warning(s): ${v.warnings.slice(0, 3).join("; ")}` : ""}`;
			break;
		}
		default:
			throw new Error(`Unknown format ${format}`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
	return { bytes: data.length, note };
}

/** One SVG per diagram page (all pages unless currentPageOnly), via draw.io's own export. */
async function pageSvgs(client: CustomizedDrawioClient, options: { currentPageOnly?: boolean }): Promise<string[]> {
	const svgs: string[] = [];
	const listed = await client.aiPages({ op: "list" });
	const pages = listed.pages ?? [];
	const shown = pages.find((p) => p.current);
	if (options.currentPageOnly || pages.length <= 1) {
		svgs.push(await pageSvg(client));
	} else {
		try {
			for (const p of pages) {
				await client.aiPages({ op: "select", page: p.id });
				svgs.push(await pageSvg(client));
			}
		} finally {
			if (shown) await client.aiPages({ op: "select", page: shown.id });
		}
	}
	return svgs.map((svg) => svg.replace(/^<\?xml[^>]*>\s*/, "").replace(/<!DOCTYPE[^>]*>\s*/i, ""));
}

/** Loads `html` in a hidden window and runs `fn` on it. */
async function withHiddenPage<T>(html: string, offscreen: boolean, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
	const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drawai-print-")), "print.html");
	fs.writeFileSync(tmp, html);
	const win = new BrowserWindow({ show: false, webPreferences: { offscreen, javascript: false } });
	try {
		await win.loadFile(tmp);
		return await fn(win);
	} finally {
		win.destroy();
		fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
	}
}

/**
 * True vector PDF: each page is exported as SVG by draw.io, laid out one per PDF
 * page (sized to the drawing) and printed with Chromium's printToPDF.
 */
async function exportPdf(client: CustomizedDrawioClient, options: { currentPageOnly?: boolean }): Promise<{ data: Buffer; pages: number }> {
	const svgs = await pageSvgs(client, options);
	const css: string[] = ["html,body{margin:0;padding:0;background:#fff}", "svg{display:block}"];
	const body: string[] = [];
	svgs.forEach((svg, i) => {
		const { width, height } = svgSize(svg);
		css.push(`@page p${i}{size:${width}px ${height}px;margin:0}`, `.p${i}{page:p${i};width:${width}px;height:${height}px;overflow:hidden;break-after:page}`);
		body.push(`<div class="p${i}">${svg}</div>`);
	});
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css.join("\n")}</style></head><body>${body.join("\n")}</body></html>`;
	const data = await withHiddenPage(html, true, (win) =>
		win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
	);
	return { data, pages: svgs.length };
}

/** Prints every page through the system print dialog, each drawing scaled to fit the paper. */
export async function printDiagram(client: CustomizedDrawioClient, title: string): Promise<{ printed: boolean; error?: string }> {
	const svgs = await pageSvgs(client, {});
	const css = [
		"@page{margin:12mm}",
		"html,body{margin:0;padding:0;background:#fff}",
		".page{height:100vh;display:flex;align-items:center;justify-content:center;break-after:page;overflow:hidden}",
		".page:last-child{break-after:auto}",
		".page svg{max-width:100%;max-height:100%;width:auto;height:auto}",
	];
	const body = svgs.map((svg) => {
		const { width, height } = svgSize(svg);
		// Keep the aspect ratio when the SVG is scaled down to the paper.
		const sized = /viewBox=/.test(svg.slice(0, 400)) ? svg : svg.replace(/<svg\b/, `<svg viewBox="0 0 ${width} ${height}"`);
		return `<div class="page">${sized}</div>`;
	});
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, "")}</title><style>${css.join("\n")}</style></head><body>${body.join("\n")}</body></html>`;
	return withHiddenPage(html, false, (win) =>
		new Promise((resolve) => win.webContents.print({ silent: false, printBackground: true }, (printed, error) => resolve({ printed, error: printed ? undefined : error })))
	);
}

async function pageSvg(client: CustomizedDrawioClient): Promise<string> {
	// Light colours regardless of the editor's theme: PDFs are for paper.
	const raw = await (client as any).sendActionWaitForResponse({ action: "export", format: "xmlsvg", theme: "light" });
	const prefix = "data:image/svg+xml;base64,";
	if (typeof raw?.data !== "string" || !raw.data.startsWith(prefix)) throw new Error("draw.io did not return an SVG");
	return Buffer.from(raw.data.slice(prefix.length), "base64").toString("utf8");
}

function svgSize(svg: string): { width: number; height: number } {
	const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
	const num = (name: string) => {
		const m = new RegExp(`\\b${name}="([\\d.]+)(px)?"`).exec(tag);
		return m ? Math.ceil(parseFloat(m[1])) : undefined;
	};
	let width = num("width");
	let height = num("height");
	if (!width || !height) {
		const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(tag);
		width = width ?? (vb ? Math.ceil(+vb[1]) : 800);
		height = height ?? (vb ? Math.ceil(+vb[2]) : 600);
	}
	return { width: Math.max(1, width), height: Math.max(1, height) };
}
