import { codePoint, mapXml, tagInfo } from "./xmlScan";

/**
 * Cleans an SVG from a gallery, an import or an agent before it is cached, shown or put in
 * a diagram: no scripts, no event handlers, no external references, no embedded HTML, no
 * DTDs. draw.io shows shapes' images as <img>, where scripts never run, but a diagram is
 * shared and exported, so nothing active is let in at all.
 *
 * Every step reads the text once, from its start to its end, so what an SVG costs grows with
 * its size and no faster, whatever it is made of (an opener repeated to the size limit and
 * never closed used to hold the app, or the extension host, for many seconds).
 *
 * Returns the cleaned SVG, or undefined when the input is not a usable SVG.
 */
export const MAX_SVG_BYTES = 512 * 1024;

/** Elements dropped with their content: they run code, embed documents or media, or (animations) can swap links. */
const DROP_TAGS = ["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "handler", "listener", "set", "animate", "animateMotion", "animateTransform", "animateColor", "discard"];
const DROPPED = new Set(DROP_TAGS.map((tag) => tag.toLowerCase()));
/** The start of one of them as it is written, in any case and with or without a prefix, wherever it stands. */
const DROPPED_OPENER = new RegExp(`<(?:[\\w-]+:)?(?:${DROP_TAGS.join("|")})\\b`, "i");

/** What is left of a processing instruction, a comment, a CDATA section or a declaration. */
const MARKUP = /<[!?]/;
const DOCTYPE = /<!DOCTYPE/iy;
const SUBSET_END = /\]\s*>/g;
const URL_OPENER = /url\(/gi;

/**
 * A tag as XML writes one, as far as its attributes go: a name, then attributes, each after
 * white space (XML's: space, tab, line break) and with its value in quotes (no "<" in it).
 * What else XML asks of a tag (which characters a name may hold, no attribute twice, no "&"
 * on its own) is not looked at.
 */
const TAG_NAME = /^<[^\s=<>"'/]+/;
const ATTRIBUTE = /[ \t\r\n]+([^\s=<>"'/]+)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /[ \t\r\n]*\/?>$/y;
const CLOSING_TAG = /^<\/[^\s=<>"'/]+[ \t\r\n]*>$/;

/** A link that stays: a place in this document (#id) or an embedded raster image. */
function linkStays(value: string): boolean {
	const v = value.trim();
	return /^#[\w.:-]*$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v);
}

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

/**
 * Where the processing instruction, comment, CDATA section or DOCTYPE that starts at `lt`
 * ends: `lt` itself when none of them starts there, -1 when it never ends.
 */
function markupEnd(xml: string, lt: number): number {
	const after = (closer: string, from: number) => {
		const at = xml.indexOf(closer, from);
		return at < 0 ? -1 : at + closer.length;
	};
	if (xml[lt + 1] === "?") return after("?>", lt + 2);
	if (xml[lt + 1] !== "!") return lt;
	if (xml.startsWith("--", lt + 2)) return after("-->", lt + 4);
	if (xml.startsWith("[CDATA[", lt + 2)) return after("]]>", lt + 9);
	DOCTYPE.lastIndex = lt;
	if (!DOCTYPE.test(xml)) return lt;
	// a DOCTYPE ends at its first ">"; one that declares things itself ("[" before that) at the "]" a ">" follows
	const gt = xml.indexOf(">", lt + 9);
	if (gt < 0) return -1;
	const subset = xml.slice(lt + 9, gt).indexOf("[");
	if (subset < 0) return gt + 1;
	SUBSET_END.lastIndex = lt + 9 + subset + 1;
	return SUBSET_END.test(xml) ? SUBSET_END.lastIndex : -1;
}

/**
 * `xml` without its processing instructions (the prolog is one), comments and DOCTYPE, each
 * with all it holds, and with what its CDATA sections hold as the text it is ("<", ">" and
 * "&" as references, so it stays text): Illustrator keeps an SVG's CSS in one. Each closer is
 * looked for once and the reader goes on behind it. Returns undefined when one of them never
 * ends.
 */
function withoutMarkup(xml: string): string | undefined {
	let out = "";
	let kept = 0;
	let lt = xml.indexOf("<");
	while (lt >= 0) {
		const end = markupEnd(xml, lt);
		if (end < 0) return undefined;
		if (end > lt) {
			out += xml.slice(kept, lt);
			if (xml.startsWith("<![CDATA[", lt)) out += xml.slice(lt + 9, end - 3).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			kept = end;
		}
		lt = xml.indexOf("<", end > lt ? end : lt + 1);
	}
	return out + xml.slice(kept);
}

/**
 * `svg` without the elements in DROP_TAGS and what is inside them, whatever their prefix
 * (<s:script>) or case. It goes tag by tag and counts how many of the dropped element are
 * open, so its end is not looked for again from every start. Returns undefined when a tag or
 * a dropped element never ends, and when one is closed that is not open: where it ends is
 * then a guess (the pattern this replaces took everything up to that closing tag).
 */
function withoutDropped(svg: string): string | undefined {
	let inside = ""; // the dropped element the reader is in
	let depth = 0; // ... and how many of that name are open
	let unopened = false; // a closing tag of one that is not open
	const out = mapXml(svg, {
		tag: (tag) => {
			const t = tagInfo(tag);
			const name = t.name.slice(t.name.lastIndexOf(":") + 1).toLowerCase();
			if (inside) {
				if (name === inside) depth += t.closing ? -1 : t.empty ? 0 : 1;
				if (!depth) inside = "";
				return "";
			}
			if (!DROPPED.has(name)) return tag;
			if (t.closing) unopened = true;
			else if (!t.empty) {
				inside = name;
				depth = 1;
			}
			return "";
		},
		text: (text) => (inside ? "" : text),
	});
	return inside || unopened ? undefined : out;
}

/**
 * `css` (or a whole SVG) with every url(…) made none, but for a place in this document: "#"
 * straight after the bracket, or after its quote. One that never closes stays as it is, for
 * the last check to refuse.
 */
function withoutExternalUrls(css: string): string {
	let out = "";
	let kept = 0;
	URL_OPENER.lastIndex = 0;
	for (let m = URL_OPENER.exec(css); m; m = URL_OPENER.exec(css)) {
		const value = m.index + m[0].length;
		if (css[value] === "#" || ((css[value] === '"' || css[value] === "'") && css[value + 1] === "#")) continue;
		const close = css.indexOf(")", value);
		if (close < 0) break; // ... and neither does any after it
		out += css.slice(kept, m.index) + "none";
		kept = URL_OPENER.lastIndex = close + 1;
	}
	return out + css.slice(kept);
}

/** `svg` with everything that is taken out of one taken out; undefined when the dropped elements cannot be told from the rest. */
function clean(svg: string): string | undefined {
	// dropped elements, with or without a namespace prefix (<s:script>)
	let s = withoutDropped(svg);
	// one's name where the reader saw no tag of its own (inside a value, <script-x>): not a usable SVG
	if (s === undefined || DROPPED_OPENER.test(s)) return undefined;
	// event handler attributes (one space before each is enough to find it: "\s+" would try every
	// start in a long run of spaces again and again)
	s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	// links (quoted or not): keep same-document (#id) and embedded raster images only
	s = s.replace(/\s((?:[\w-]+:)?href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi, (m, _attr, _q, a, b, c) => (linkStays(String(a ?? b ?? c ?? "")) ? m : ""));
	// external resources in styles; same-document url(#id) / url('#id') stay
	return withoutExternalUrls(s.replace(/@import[^;]*;?/gi, "")).replace(/expression\s*\(/gi, "(");
}

/**
 * The attributes of a start tag, each name with its value as written, or undefined when the
 * tag is not written the way XML has it (see ATTRIBUTE).
 */
function attributesOf(tag: string): [name: string, value: string][] | undefined {
	const name = TAG_NAME.exec(tag);
	if (!name) return undefined;
	const attributes: [string, string][] = [];
	let at = name[0].length;
	for (;;) {
		ATTRIBUTE.lastIndex = at;
		const m = ATTRIBUTE.exec(tag);
		if (!m) break;
		attributes.push([m[1], m[2] ?? m[3]]);
		at = ATTRIBUTE.lastIndex;
	}
	TAG_END.lastIndex = at;
	return TAG_END.test(tag) ? attributes : undefined;
}

/**
 * The root tag of a cleaned `svg` and the names of its attributes, or undefined when one of
 * its tags is not written the way XML writes one (see ATTRIBUTE). The handler and link steps
 * find an attribute by the white space before it; a browser that reads the SVG as HTML also
 * finds one straight after a quote or a "/" (<rect width="9"onclick="…"/>). A browser that
 * reads it as XML, as for an <img>, shows nothing of such an SVG, so nothing that was shown
 * is lost. With every attribute in its place, a link under a prefix the link step does not
 * know (a.b:href) is seen here. Tags are looked at one by one, not how they nest.
 */
function soundRoot(svg: string): { tag: string; names: Set<string> } | undefined {
	let root: { tag: string; names: Set<string> } | undefined;
	let sound = true;
	const read = mapXml(svg, {
		tag: (tag) => {
			if (!sound) return "";
			if (tagInfo(tag).closing) {
				sound = CLOSING_TAG.test(tag);
				return "";
			}
			const attributes = attributesOf(tag);
			if (!attributes || attributes.some(([name, value]) => name.slice(name.lastIndexOf(":") + 1).toLowerCase() === "href" && !linkStays(value))) sound = false;
			else root ??= { tag, names: new Set(attributes.map(([name]) => name)) };
			return "";
		},
		text: () => "",
	});
	return read !== undefined && sound ? root : undefined;
}

export function sanitizeSvg(input: string, opts: { fill?: string } = {}): string | undefined {
	if (typeof input !== "string" || !input || input.length > MAX_SVG_BYTES) return undefined;
	const once = cleanedOnce(input, opts);
	// Taking one thing out can put another together (` o href="x"nload="…"`, <foreign@import;Object>): what
	// is clean stays as it is when it is cleaned again, and anything else is refused. So is an SVG that its
	// xmlns, its colour or the references in its CDATA text take over the size limit: it could not be cleaned
	// again later.
	return once !== undefined && once.length <= MAX_SVG_BYTES && cleanedOnce(once) === once ? once : undefined;
}

/** `input` as sanitizeSvg returns it, before it is known that nothing more would be taken out of that. */
function cleanedOnce(input: string, opts: { fill?: string } = {}): string | undefined {
	// prolog, doctype (no entities), comments, processing instructions; what CDATA sections hold, as text
	const bare = withoutMarkup(input.replace(/^\uFEFF/, ""))?.trim();
	// one that never ends, or that taking the others out put together, is nothing a browser would show
	if (bare === undefined || MARKUP.test(bare)) return undefined;
	if (!/^<svg[\s>]/i.test(bare) || !/<\/svg\s*>\s*$/i.test(bare)) return undefined;
	const s = clean(bare);
	if (s === undefined) return undefined;
	// what is left, read the way a browser would: anything that could run or fetch rejects the SVG
	const seen = decodeForCheck(s);
	if (/<\s*(?:[\w-]+:)?script|javascript:|vbscript:|data:text\/html|url\(\s*(?!['"]?#)|@import/i.test(seen)) return undefined;
	// tags as XML has them, and the root (up to its ">" outside quotes) with the attributes it has itself
	const root = soundRoot(s);
	if (!root || !s.startsWith(root.tag) || !/^<svg[\s/>]/i.test(root.tag)) return undefined;
	let head = root.tag;
	if (!root.names.has("xmlns")) head = head.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
	if (opts.fill && /^#[0-9a-f]{3,8}$/i.test(opts.fill) && !root.names.has("fill")) head = head.replace(/^<svg\b/i, `<svg fill="${opts.fill}"`);
	return head + s.slice(root.tag.length);
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

/** The first tag of `svg`, up to its ">" outside quotes; "" when it never ends. */
function firstTag(svg: string): string {
	let quote = "";
	for (let i = 0; i < svg.length; i++) {
		const ch = svg[i];
		if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ">") return svg.slice(0, i + 1);
	}
	return "";
}

/** Width and height from an SVG's width/height or viewBox; 48×48 when unknown, scaled to at most 64. */
export function svgSize(svg: string): { w: number; h: number } {
	const tag = /^<svg\b/i.test(svg) ? firstTag(svg) : "";
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
