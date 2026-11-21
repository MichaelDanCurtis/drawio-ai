/**
 * Minimal PDF writer: one image per page, the page sized to the image. Images
 * are RGB pixels compressed losslessly (FlateDecode) with the platform
 * CompressionStream, or JPEG data passed through as is (DCTDecode).
 * No dependencies, so it runs in the draw.io webview and in Node tests.
 */

export type PdfImage =
	| { kind: "rgb"; width: number; height: number; /** width * height * 3 bytes */ pixels: Uint8Array }
	| { kind: "jpeg"; width: number; height: number; data: Uint8Array };

export interface PdfPage {
	image: PdfImage;
	/** Page size in PDF points (1/72 inch). */
	widthPt: number;
	heightPt: number;
}

export interface PdfInfo {
	title?: string;
	producer?: string;
}

/** zlib-wrapped deflate, which is what FlateDecode expects. */
export async function deflate(data: Uint8Array): Promise<Uint8Array | undefined> {
	const CS = (globalThis as any).CompressionStream;
	if (typeof CS !== "function") {
		return undefined;
	}
	try {
		const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS("deflate"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return undefined;
	}
}

/** Drops the alpha channel of canvas pixels, blending them onto white. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
	const n = rgba.length >> 2;
	const out = new Uint8Array(n * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		const a = rgba[i + 3];
		if (a === 255) {
			out[j] = rgba[i];
			out[j + 1] = rgba[i + 1];
			out[j + 2] = rgba[i + 2];
		} else {
			const k = 255 - a;
			out[j] = (rgba[i] * a + 255 * k + 127) / 255;
			out[j + 1] = (rgba[i + 1] * a + 255 * k + 127) / 255;
			out[j + 2] = (rgba[i + 2] * a + 255 * k + 127) / 255;
		}
	}
	return out;
}

/** A PDF string literal: printable ASCII escaped, anything else as UTF-16BE hex. */
export function pdfString(text: string): string {
	if (/^[\x20-\x7e]*$/.test(text)) {
		return "(" + text.replace(/[\\()]/g, (c) => "\\" + c) + ")";
	}
	let hex = "FEFF";
	for (let i = 0; i < text.length; i++) {
		hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
	}
	return `<${hex}>`;
}

const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

export async function writePdf(pages: PdfPage[], info: PdfInfo = {}): Promise<Uint8Array> {
	if (pages.length === 0) {
		throw new Error("A PDF needs at least one page.");
	}
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (bytes: Uint8Array) => {
		chunks.push(bytes);
		length += bytes.length;
	};
	const text = (s: string) => push(enc.encode(s));
	/** Starts object number id (1-based) at the current offset. */
	const begin = (id: number) => {
		offsets[id] = length;
		text(`${id} 0 obj\n`);
	};

	// Object numbers: 1 catalog, 2 page tree, 3 info, then 3 per page (page, image, contents).
	const pageId = (i: number) => 4 + i * 3;
	text("%PDF-1.4\n");
	// A comment with high bytes tells tools the file is binary.
	push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

	begin(1);
	text("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	begin(2);
	text(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);
	begin(3);
	const infoEntries = [`/Producer ${pdfString(info.producer ?? "Draw.AI")}`];
	if (info.title) infoEntries.push(`/Title ${pdfString(info.title)}`);
	text(`<< ${infoEntries.join(" ")} >>\nendobj\n`);

	for (let i = 0; i < pages.length; i++) {
		const { image, widthPt, heightPt } = pages[i];
		const id = pageId(i);
		begin(id);
		text(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(widthPt)} ${num(heightPt)}] ` +
				`/Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>\nendobj\n`
		);

		let data: Uint8Array;
		let filter: string;
		if (image.kind === "jpeg") {
			data = image.data;
			filter = "/DCTDecode";
		} else {
			if (image.pixels.length !== image.width * image.height * 3) {
				throw new Error("Image pixel data does not match its size.");
			}
			const packed = await deflate(image.pixels);
			data = packed ?? image.pixels;
			filter = packed ? "/FlateDecode" : "";
		}
		begin(id + 1);
		text(
			`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
				`/ColorSpace /DeviceRGB /BitsPerComponent 8${filter ? ` /Filter ${filter}` : ""} /Length ${data.length} >>\nstream\n`
		);
		push(data);
		text("\nendstream\nendobj\n");

		const content = `q ${num(widthPt)} 0 0 ${num(heightPt)} 0 0 cm /Im0 Do Q`;
		begin(id + 2);
		text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
	}

	const count = 4 + pages.length * 3;
	const xref = length;
	let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
	for (let id = 1; id < count; id++) {
		table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	}
	text(table);
	text(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}
