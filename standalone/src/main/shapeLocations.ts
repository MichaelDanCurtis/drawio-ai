import * as fs from "fs";
import * as path from "path";
import type { ShapeLocation } from "./settings";

/** One palette for the shapes sidebar: images from a folder, or a draw.io library file. */
export type ShapeLibrary =
	| { title: string; path: string; kind: "images"; images: { data: string; w: number; h: number; title: string }[]; truncated?: boolean }
	| { title: string; path: string; kind: "xml"; xml: string }
	| { title: string; path: string; kind: "missing"; error: string };

const MAX_IMAGES = 400;
const MAX_FILE = 2 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Reads the user's shape locations (Settings → Shapes) into palettes. Never follows links out of a folder. */
export async function shapeLibraries(locations: ShapeLocation[]): Promise<ShapeLibrary[]> {
	const out: ShapeLibrary[] = [];
	for (const loc of locations) {
		if (!loc.enabled) continue;
		const title = loc.name || path.basename(loc.path).replace(/\.(xml|drawiolib)$/i, "");
		try {
			const st = await fs.promises.stat(loc.path);
			if (st.isDirectory()) out.push({ title, path: loc.path, kind: "images", ...(await folderImages(loc.path)) });
			else if (st.size > 20 * 1024 * 1024) out.push({ title, path: loc.path, kind: "missing", error: "The library file is larger than 20 MB." });
			else out.push({ title, path: loc.path, kind: "xml", xml: await fs.promises.readFile(loc.path, "utf8") });
		} catch (e: any) {
			out.push({ title, path: loc.path, kind: "missing", error: e?.code === "ENOENT" ? "Not found." : String(e?.message ?? e) });
		}
	}
	return out;
}

async function folderImages(dir: string): Promise<{ images: { data: string; w: number; h: number; title: string }[]; truncated?: boolean }> {
	const images: { data: string; w: number; h: number; title: string }[] = [];
	const root = await fs.promises.realpath(dir);
	const walk = async (d: string, depth: number): Promise<void> => {
		const entries = (await fs.promises.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (images.length >= MAX_IMAGES) return;
			if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				if (depth < 2) await walk(full, depth + 1);
				continue;
			}
			const mime = IMAGE_EXT[path.extname(e.name).toLowerCase()];
			if (!mime) continue;
			const real = await fs.promises.realpath(full);
			if (!real.startsWith(root + path.sep)) continue;
			const st = await fs.promises.stat(real);
			if (st.size > MAX_FILE) continue;
			const bytes = await fs.promises.readFile(real);
			const size = imageSize(bytes, mime);
			const scale = Math.min(1, 64 / Math.max(size.w, size.h));
			images.push({
				data: `data:${mime};base64,${bytes.toString("base64")}`,
				w: Math.max(8, Math.round(size.w * scale)),
				h: Math.max(8, Math.round(size.h * scale)),
				title: path.relative(root, full).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
			});
		}
	};
	await walk(root, 0);
	return images.length >= MAX_IMAGES ? { images, truncated: true } : { images };
}

/** Width and height of an SVG (width/height or viewBox) or a PNG; 64×64 when unknown. */
export function imageSize(bytes: Buffer, mime: string): { w: number; h: number } {
	if (mime === "image/png" && bytes.length > 24 && bytes.readUInt32BE(12) === 0x49484452) return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
	if (mime === "image/svg+xml") {
		const head = bytes.subarray(0, 4096).toString("utf8");
		const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
		const num = (name: string) => {
			const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
			return m ? Number(m[1]) : NaN;
		};
		let w = num("width"), h = num("height");
		if (!(w > 0 && h > 0)) {
			const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
			if (vb) {
				w = Number(vb[1]);
				h = Number(vb[2]);
			}
		}
		if (w > 0 && h > 0) return { w, h };
	}
	return { w: 64, h: 64 };
}
