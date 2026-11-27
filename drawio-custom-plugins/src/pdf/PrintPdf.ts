import { pageSvgs, PageSvg, PdfExportOptions } from "./PdfExport";

/**
 * A PDF whose text stays text, in a browser: every page as draw.io's SVG, one to a sheet of
 * the drawing's own size, handed to the browser's print dialog, where the person chooses
 * "Save as PDF". (The desktop app prints the same sheets to a file itself; a page in a browser
 * cannot, and PdfExport.ts, which can, places each page as a picture.)
 *
 * The sheets are put in a hidden frame of their own, so that nothing of the editor is printed
 * and nothing of the diagram runs: the frame's document is these SVGs and a stylesheet.
 */
export interface PrintPdfResult {
	pages: number;
	warnings: string[];
}

export function printDocument(pages: PageSvg[], title: string): string {
	const css: string[] = ["html,body{margin:0;padding:0;background:#fff}", "svg{display:block}"];
	const body: string[] = [];
	pages.forEach((p, i) => {
		const w = Math.ceil(p.width);
		const h = Math.ceil(p.height);
		// (a sheet of the drawing's size for each page: named pages, which browsers that print to PDF follow)
		css.push(`@page p${i}{size:${w}px ${h}px;margin:0}`, `.p${i}{page:p${i};width:${w}px;height:${h}px;overflow:hidden;break-after:page}`);
		body.push(`<div class="p${i}">${p.svg.replace(/^<\?xml[^>]*>\s*/, "").replace(/<!DOCTYPE[^>]*>\s*/i, "")}</div>`);
	});
	const safe = title.replace(/[<>&"]/g, "");
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe}</title><style>${css.join("\n")}</style></head><body>${body.join("\n")}</body></html>`;
}

export async function printPdf(ui: any, options: PdfExportOptions = {}): Promise<PrintPdfResult> {
	const { pages, warnings } = await pageSvgs(ui, options);
	const frame = document.createElement("iframe");
	frame.setAttribute("aria-hidden", "true");
	// (scripts stay off: what is printed is a drawing, and a label's markup is not to run anywhere)
	frame.setAttribute("sandbox", "allow-same-origin allow-modals");
	frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
	const loaded = new Promise<void>((resolve, reject) => {
		frame.onload = () => resolve();
		frame.onerror = () => reject(new Error("The pages could not be prepared for printing."));
	});
	frame.srcdoc = printDocument(pages, options.title || "Diagram");
	document.body.appendChild(frame);
	try {
		await loaded;
		const win = frame.contentWindow;
		if (!win) throw new Error("The pages could not be prepared for printing.");
		// (the name the browser offers for the file is the title of the page that is printed)
		win.focus();
		win.print();
	} finally {
		// (some browsers come back from print() before the dialog has closed: the sheets stay a while)
		setTimeout(() => frame.remove(), 60_000);
	}
	return { pages: pages.length, warnings };
}
