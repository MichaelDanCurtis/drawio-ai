import type { Insertable } from "./galleries";
import { MAX_SVG_BYTES, sanitizeSvg, svgImgUri, svgStyleUri } from "./svgSanitize";
import { mapAttributes, mapXml, tagInfo } from "./xmlScan";

/**
 * The Shape Shifter's own logic: what one of draw.io's shapes becomes in the Workshop, what
 * is selected in a diagram and how a change to it is written, and one-colour icons.
 * Nothing here imports Electron or touches a diagram: the hosts do that (see core.ts).
 */

/** One of draw.io's own shapes, as the editor's sidebar search returns it. */
export interface BuiltInShape {
	title: string;
	/** The shape set it is in ("general", "aws4"…). */
	library?: string;
	style: string;
	width: number;
	height: number;
	isEdge?: boolean;
	/** Present when the shape consists of several cells (a UML class, say). */
	xml?: string;
	/** The sidebar's thumbnail of it, as SVG text. */
	preview?: string;
}

/** A selected cell of the diagram used last. */
export interface SelectedCell {
	id: string;
	style: string;
	edge?: boolean;
}

/** What the Shifter shows of the selection. A colour is given when every selected shape that has one agrees on it. */
export interface SelectionInfo {
	count: number;
	/** How many of them are pictures drawn from an SVG kept in the shape (gallery icons): those can be given one colour. */
	icons: number;
	fill?: string;
	stroke?: string;
	font?: string;
}

/** A change to the selected shapes: colours as "#rrggbb" or "none"; `icon` gives SVG pictures one colour. */
export interface ShapeChange {
	fill?: string;
	stroke?: string;
	font?: string;
	icon?: string;
}

/** A change to one cell's style: keys to set (a draw.io style has no ";" inside a value). */
export interface StyleEdit {
	id: string;
	props: Record<string, string>;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A colour the Shifter accepts ("#rgb", "#rrggbb", or "none" where that makes sense), lower-cased; undefined otherwise. */
export function colourOf(value: unknown, allowNone = true): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim().toLowerCase();
	if (v === "none") return allowNone ? "none" : undefined;
	if (!HEX.test(v)) return undefined;
	return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
}

/** The value of one key of a draw.io style ("a=1;b=2;"), or undefined. */
export function styleValue(style: string, key: string): string | undefined {
	for (const part of style.split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at) === key) return part.slice(at + 1);
	}
	return undefined;
}

/** The SVG a shape's picture is drawn from, when its style keeps one (`image=data:image/svg+xml,…`). */
export function iconSvgOf(style: string): string | undefined {
	const image = styleValue(style, "image");
	const m = image ? /^data:image\/svg\+xml,(.*)$/i.exec(image) : undefined;
	if (!m || m[1].length > MAX_SVG_BYTES * 2) return undefined;
	let text: string;
	try {
		// draw.io's own form is base64 without ";base64"; some shapes carry the SVG URI-encoded
		text = /^(%3C|<)/i.test(m[1]) ? decodeURIComponent(m[1]) : Buffer.from(m[1], "base64").toString("utf8");
	} catch {
		return undefined;
	}
	return /<svg[\s>]/i.test(text) ? text : undefined;
}

const KEEP = /^(none|transparent|inherit|url\()/i;

/** Elements whose content is not the picture's paint: a mask works by brightness, a clip path by shape, a pattern has colours of its own. */
const NOT_PAINT = new Set(["mask", "clipPath", "pattern"]);

/**
 * An SVG in one colour: every fill and stroke that paints becomes `colour` ("none" and
 * references to gradients or patterns stay, and so does what is inside a mask, a clip path or
 * a pattern), and a picture that relies on the default black fill gets the colour on its
 * root. Returns the cleaned SVG, or undefined when it is not one.
 *
 * The SVG is cleaned first and then read tag by tag (xmlScan.ts): only the `fill`, `stroke`
 * and `style` attributes of elements and the text of <style> blocks are rewritten, and only
 * with the colour, so text, titles and other attributes stay as they are and the result is
 * as well-formed as what came in. (A rule in a <style> block is rewritten whatever it
 * selects, also when that is a mask's content: the selectors are not read.)
 */
export function recolourSvg(svg: string, colour: string): string | undefined {
	const c = colourOf(colour, false);
	const clean = c ? sanitizeSvg(svg) : undefined;
	if (!c || !clean) return undefined;
	let painted = false;
	const paint = (value: string): boolean => {
		const v = value.trim();
		if (!v || KEEP.test(v)) return false;
		painted = true;
		return true;
	};
	// fill: … and stroke: … declarations (of a style attribute or a <style> block); "!important" and the space before it stay
	const css = (text: string) =>
		text.replace(/(^|[;{\s])((?:fill|stroke)\s*:\s*)([^;}!]+)/gi, (all, lead: string, head: string, value: string) => (paint(value) ? `${lead}${head}${c}${value.slice(value.trimEnd().length)}` : all));
	let rootFill: boolean | undefined;
	let unpainted = 0; // how deep inside masks, clip paths and patterns
	let inStyle = false;
	const out = mapXml(clean, {
		text: (text) => (inStyle ? css(text) : text),
		tag: (tag) => {
			const { local, closing, empty } = tagInfo(tag);
			if (closing) {
				if (local === "style") inStyle = false;
				else if (NOT_PAINT.has(local) && unpainted > 0) unpainted--;
				return tag;
			}
			const root = rootFill === undefined;
			if (root) rootFill = false;
			const next =
				unpainted > 0
					? tag
					: mapAttributes(tag, (name, raw) => {
							if (root && name === "fill") rootFill = true;
							if (name === "fill" || name === "stroke") return paint(raw) ? c : undefined;
							if (name !== "style") return undefined;
							const styled = css(raw);
							return styled === raw ? undefined : styled;
					  });
			if (!empty) {
				if (local === "style") inStyle = true;
				else if (NOT_PAINT.has(local)) unpainted++;
			}
			return next;
		},
	});
	if (out === undefined || rootFill === undefined || !/^<svg[\s>]/i.test(out)) return undefined;
	// shapes without a fill of their own are black by default: the root gives them the colour
	if (!rootFill) return out.replace(/^<svg\b/i, `<svg fill="${c}"`);
	return painted ? out : undefined; // nothing in it paints (fill="none" and no strokes)
}

/** What the selection looks like to the Shifter. */
export function selectionInfo(cells: SelectedCell[]): SelectionInfo {
	const common = (key: string, of: SelectedCell[]) => {
		const values = new Set(of.map((c) => colourOf(styleValue(c.style, key))).filter(Boolean));
		return values.size === 1 ? [...values][0] : undefined;
	};
	const shapes = cells.filter((c) => !c.edge);
	return {
		count: cells.length,
		icons: cells.filter((c) => !!iconSvgOf(c.style)).length,
		fill: common("fillColor", shapes),
		stroke: common("strokeColor", cells),
		font: common("fontColor", cells),
	};
}

/**
 * The style edits that make `change` to the selected cells. Fill is for shapes (a connector
 * has none); the icon colour only touches pictures drawn from an SVG kept in the shape.
 */
export function styleEdits(cells: SelectedCell[], change: ShapeChange): StyleEdit[] {
	const fill = colourOf(change.fill);
	const stroke = colourOf(change.stroke);
	const font = colourOf(change.font, false);
	const icon = colourOf(change.icon, false);
	const out: StyleEdit[] = [];
	for (const cell of cells) {
		const props: Record<string, string> = {};
		if (fill && !cell.edge) props.fillColor = fill;
		if (stroke) props.strokeColor = stroke;
		if (font) props.fontColor = font;
		if (icon) {
			const svg = iconSvgOf(cell.style);
			const next = svg ? recolourSvg(svg, icon) : undefined;
			if (next) props.image = svgStyleUri(next);
		}
		if (Object.keys(props).length) out.push({ id: cell.id, props });
	}
	return out;
}

/** One of draw.io's shapes, ready for a diagram. */
export function builtInInsertable(shape: BuiltInShape): Insertable {
	const w = shape.width > 0 ? shape.width : 120;
	const h = shape.height > 0 ? shape.height : 60;
	return shape.xml ? { xml: shape.xml, w, h, title: shape.title } : { style: shape.style, w, h, title: shape.title };
}

/** The thumbnail of one of draw.io's shapes for the Workshop page: cleaned like any SVG, as a data URI. */
export function builtInPreview(shape: BuiltInShape): string | undefined {
	const clean = shape.preview ? sanitizeSvg(shape.preview) : undefined;
	return clean ? svgImgUri(clean) : undefined;
}

/** The request the chat's agent gets for "describe the change" on the selection. */
export function restyleRequest(text: string, count: number): string {
	return [
		`Change the ${count === 1 ? "selected shape" : `${count} selected shapes`} like this: ${text.trim()}`,
		"",
		"Only change how they look (style, size, label formatting): keep their text, their place and their connections, and leave everything that is not selected as it is.",
	].join("\n");
}
