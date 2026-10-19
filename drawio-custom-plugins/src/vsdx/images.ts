/** Turns a draw.io image reference into PNG/JPEG/GIF bytes Visio can embed. */

export type BitmapType = "png" | "jpeg" | "gif";

export interface Bitmap {
	data: Uint8Array;
	type: BitmapType;
}

const DIRECT: Record<string, BitmapType> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/jpg": "jpeg",
	"image/gif": "gif",
};

/** 1x1 transparent PNG, used when an image cannot be loaded. */
export const PLACEHOLDER: Bitmap = {
	type: "png",
	data: Uint8Array.from(
		atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
		(c) => c.charCodeAt(0)
	),
};

function base64Bytes(s: string): Uint8Array {
	return Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

/**
 * Parses data: URIs, including draw.io's style-safe form "data:image/svg+xml,<base64>"
 * (styles cannot contain ";", so draw.io drops the ";base64" marker).
 */
export function parseDataUri(src: string): { mime: string; data: Uint8Array } {
	const comma = src.indexOf(",");
	if (!src.startsWith("data:") || comma < 0) {
		throw new Error("Not a data URI");
	}
	const meta = src.slice(5, comma);
	const payload = src.slice(comma + 1);
	const mime = (meta.split(";")[0] || "text/plain").toLowerCase();
	const marked = /;base64/i.test(meta);
	const compact = payload.replace(/\s+/g, "");
	if (marked || (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length % 4 === 0)) {
		return { mime, data: base64Bytes(compact) };
	}
	return { mime, data: new TextEncoder().encode(decodeURIComponent(payload)) };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
	]);
}

function guessMime(url: string): string {
	const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
	return ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext ? `image/${ext}` : "";
}

async function rasterize(blob: Blob, width: number, height: number): Promise<Bitmap> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = () => reject(new Error("Image could not be decoded"));
				img.src = url;
			}),
			10_000,
			"Image decoding"
		);
		const w = width || img.naturalWidth || 64;
		const h = height || img.naturalHeight || 64;
		// Enough pixels to stay sharp when the shape is enlarged a little in Visio.
		const f = Math.min(4, Math.max(1, 512 / Math.max(w, h)));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(w * f));
		canvas.height = Math.max(1, Math.round(h * f));
		canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!png) {
			throw new Error("Image could not be converted to PNG");
		}
		return { type: "png", data: new Uint8Array(await png.arrayBuffer()) };
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function loadBitmap(src: string, width: number, height: number): Promise<Bitmap> {
	let mime: string;
	let blob: Blob;
	if (src.startsWith("data:")) {
		const parsed = parseDataUri(src);
		mime = parsed.mime;
		blob = new Blob([parsed.data], { type: mime });
	} else {
		const url = new URL(src, document.baseURI).href;
		const res = await withTimeout(fetch(url), 10_000, "Image download");
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		blob = await res.blob();
		mime = (blob.type || guessMime(url)).toLowerCase();
		if (blob.type !== mime) {
			blob = new Blob([blob], { type: mime });
		}
	}
	const direct = DIRECT[mime];
	if (direct) {
		return { type: direct, data: new Uint8Array(await blob.arrayBuffer()) };
	}
	// SVG and anything else the browser can draw.
	return rasterize(blob, width, height);
}
