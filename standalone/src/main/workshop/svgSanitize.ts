import { codePoint } from "./xmlScan";

/**
 * Cleans an SVG from a gallery, an import or an agent before it is cached, shown or put in
 * a diagram: no scripts, no event handlers, no external references, no embedded HTML, no
 * DTDs. draw.io shows shapes' images as <img>, where scripts never run, but a diagram is
 * shared and exported, so nothing active is let in at all.
 *
 * Returns the cleaned SVG, or undefined when the input is not a usable SVG.
 */
export const MAX_SVG_BYTES = 512 * 1024;

/** Elements dropped with their content: they run code, embed documents or media, or (animations) can swap links. */
const DROP_TAGS = ["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "handler", "listener", "set", "animate", "animateMotion", "animateTransform", "animateColor", "discard"];

/** Numeric and a few named character references, and CSS escapes, decoded: what a browser would see. */
export function decodeForCheck(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => codePoint(parseInt(h, 16)))
		.replace(/&#(\d+);?/g, (_m, d) => codePoint(Number(d)))
		.replace(/&(colon|lpar|rpar|sol|period|Tab|NewLine);/gi, (_m, n) => ({ colon: ":", lpar: "(", rpar: ")", sol: "/", period: ".", tab: "", newline: "" } as Record<string, string>)[n.toLowerCase()] ?? "")
		.replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, h) => codePoint(parseInt(h, 16)))
		.replace(/\\(.)/g, "$1")
		.replace(/[\u0000-\u0020]+/g, " ");
}

export function sanitizeSvg(input: string, opts: { fill?: string } = {}): string | undefined {
	if (typeof input !== "string" || !input || input.length > MAX_SVG_BYTES) return undefined;
	let s = input.replace(/^\uFEFF/, "");
	// prolog, doctype (no entities), comments, processing instructions, CDATA
	s = s.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
	s = s.trim();
	if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return undefined;
	// dropped elements, with or without a namespace prefix (<s:script>)
	for (const tag of DROP_TAGS) {
		s = s.replace(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}\\s*>`, "gi"), "").replace(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>`, "gi"), "");
	}
	// event handler attributes (one space before each is enough to find it: "\s+" would try every
	// start in a long run of spaces again and again)
	s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	// links (quoted or not): keep same-document (#id) and embedded raster images only
	s = s.replace(/\s((?:[\w-]+:)?href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi, (m, _attr, _q, a, b, c) => {
		const v = String(a ?? b ?? c ?? "").trim();
		return /^#[\w.:-]*$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v) ? m : "";
	});
	// external resources in styles; same-document url(#id) / url('#id') stay
	s = s.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none").replace(/expression\s*\(/gi, "(");
	// what is left, read the way a browser would: anything that could run or fetch rejects the SVG
	const seen = decodeForCheck(s);
	if (/<\s*(?:[\w-]+:)?script|javascript:|vbscript:|data:text\/html|url\(\s*(?!['"]?#)|@import/i.test(seen)) return undefined;
	const root = /^<svg\b[^>]*>/i.exec(s)![0];
	let head = root;
	if (!/\sxmlns\s*=/.test(head)) head = head.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
	if (opts.fill && /^#[0-9a-f]{3,8}$/i.test(opts.fill) && !/\sfill\s*=/.test(head)) head = head.replace(/^<svg\b/i, `<svg fill="${opts.fill}"`);
	return head + s.slice(root.length);
}

/**
 * An image a library, folder or collection supplies, made safe for a draw.io style: raster
 * images as they are, SVGs decoded, cleaned and encoded again. Anything else (a web address,
 * a broken or crafted data URI that could end the style's image= key) gives undefined.
 */
export function safeImageData(data: string): { style: string; img: string } | undefined {
	if (typeof data !== "string") return undefined;
	const d = data.trim();
	const raster = /^data:image\/(png|jpe?g|gif|webp|bmp|tiff)(;base64)?,([A-Za-z0-9+/=]+)$/.exec(d);
	if (raster) return { style: `data:image/${raster[1]},${raster[3]}`, img: `data:image/${raster[1]};base64,${raster[3]}` };
	let svg: string | undefined;
	const b64 = /^data:image\/svg\+xml(;base64)?,([A-Za-z0-9+/=]+)$/.exec(d);
	if (b64) svg = Buffer.from(b64[2], "base64").toString("utf8");
	else {
		const utf = /^data:image\/svg\+xml(?:;charset=[\w-]+)?,(.*)$/s.exec(d);
		if (utf) {
			try {
				svg = decodeURIComponent(utf[1]);
			} catch {
				return undefined;
			}
		}
	}
	const clean = svg ? sanitizeSvg(svg) : undefined;
	return clean ? { style: svgStyleUri(clean), img: svgImgUri(clean) } : undefined;
}

/** An SVG as a data URI for a draw.io style (draw.io's own form: no ";base64", which would split the style). */
export function svgStyleUri(svg: string): string {
	return `data:image/svg+xml,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** An SVG as a data URI for an <img> in the Workshop page. */
export function svgImgUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Width and height from an SVG's width/height or viewBox; 48×48 when unknown, scaled to at most 64. */
export function svgSize(svg: string): { w: number; h: number } {
	const tag = /^<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
	const num = (name: string) => {
		const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
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
	if (!(w > 0 && h > 0)) return { w: 48, h: 48 };
	const k = Math.min(64 / Math.max(w, h), 48 / Math.min(w, h), 4);
	return { w: Math.max(8, Math.round(w * k)), h: Math.max(8, Math.round(h * k)) };
}
