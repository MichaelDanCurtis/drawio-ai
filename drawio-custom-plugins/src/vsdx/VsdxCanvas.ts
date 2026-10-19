/**
 * Records draw.io's own shape painting as Visio geometry, so every built-in
 * shape and stencil (vendor icons included) becomes real Visio geometry.
 *
 * Ported from draw.io v24.7.17 (js/diagramly/vsdx/mxVsdxCanvas2D.js),
 * Copyright (c) 2006-2017, JGraph Ltd, Apache License 2.0. Changes: coordinates
 * are taken relative to the shape's absolute frame, colors are resolved from
 * draw.io's light-dark() values, a shape keeps one Text and one image, and
 * paragraph/character rows are deduplicated and indexed correctly.
 */

import { resolveColor } from "./colors";

export const VISIO_NS = "http://schemas.microsoft.com/office/visio/2012/main";
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** draw.io units per Visio inch. Matches draw.io's own Visio importer (40 per cm). */
export const UNITS_PER_INCH = 40 * 2.54;

/** Absolute bounds (draw.io units) of the shape being recorded. */
export interface Frame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ImageRequest {
	src: string;
	width: number;
	height: number;
}

/** Registers an image for the current page and returns the ForeignData element that references it. */
export type AddImage = (doc: XMLDocument, request: ImageRequest) => Element;

/** The colors a geometry section was actually painted with. */
export interface Paint {
	fill?: string;
	stroke?: string;
	strokeWidth: number;
	dashed: boolean;
	alpha: number;
}

export interface RecordedSection {
	element: Element;
	/** Undefined while the path has been neither filled nor stroked. */
	paint?: Paint;
}

interface CharFormat {
	color?: string;
	size?: number;
	font?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
}

interface ParaFormat {
	align: number;
	bullet: boolean;
}

interface Run {
	text: string;
	char: CharFormat;
	para: ParaFormat;
}

const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR)$/;

export function createVsdxCanvas(W: any, addImage: AddImage): any {
	const mxUtils = W.mxUtils;
	const Base: new () => any = W.mxAbstractCanvas2D;

	class VsdxCanvas extends Base {
		doc!: XMLDocument;
		shape!: Element;
		cellState: any;
		frame!: Frame;
		geoSec: RecordedSection | null = null;
		/** Sections of the path being built: a path with several subpaths spans several sections. */
		path: RecordedSection[] = [];
		sections: RecordedSection[] = [];
		step = 1;
		lastX = 0;
		lastY = 0;
		lastMoveX = 0;
		lastMoveY = 0;
		shapeType = "Shape";
		hasText = false;
		foreign: Element | null = null;
		html2txt: HTMLDivElement | null = null;

		el(name: string): Element {
			return this.doc.createElementNS(VISIO_NS, name);
		}

		cell(name: string, value: string | number, formula?: string): Element {
			const c = this.el("Cell");
			c.setAttribute("N", name);
			c.setAttribute("V", String(value));
			if (formula) c.setAttribute("F", formula);
			return c;
		}

		/** Sets a shape-level cell, replacing an earlier value. */
		setCell(name: string, value: string | number, formula?: string) {
			for (const child of Array.from(this.shape.children)) {
				if (child.localName === "Cell" && child.getAttribute("N") === name) {
					this.shape.removeChild(child);
				}
			}
			this.shape.appendChild(this.cell(name, value, formula));
		}

		setCellScaled(name: string, value: number) {
			this.setCell(name, value / UNITS_PER_INCH);
		}

		beginShape(shape: Element, cellState: any, frame: Frame, doc: XMLDocument) {
			this.doc = doc;
			this.shape = shape;
			this.cellState = cellState;
			this.frame = frame;
			this.geoSec = null;
			this.sections = [];
			this.path = [];
			this.shapeType = "Shape";
			this.hasText = false;
			this.foreign = null;
			this.newGeoSection();
		}

		/**
		 * Attaches the image, if any, and returns the recorded geometry sections
		 * (not attached: the caller decides how to split them by color).
		 */
		endShape(): RecordedSection[] {
			if (this.foreign) {
				this.shape.appendChild(this.foreign);
				this.shapeType = "Foreign";
			}
			// Paths that were never filled or stroked are invisible in draw.io.
			return this.sections.filter((sec) => sec.paint && sec.element.getElementsByTagNameNS(VISIO_NS, "Row").length > 0);
		}

		newGeoSection() {
			const sec: RecordedSection = { element: this.el("Section") };
			sec.element.setAttribute("N", "Geometry");
			this.sections.push(sec);
			this.path.push(sec);
			this.geoSec = sec;
			this.step = 1;
			this.lastX = this.lastY = this.lastMoveX = this.lastMoveY = 0;
		}

		startPath() {
			if (this.step > 1) {
				this.path = [];
				this.newGeoSection();
			} else {
				this.path = this.geoSec ? [this.geoSec] : [];
			}
		}

		/** Applies the canvas' current colors to every section of the current path. */
		paintPath(fill: boolean, stroke: boolean) {
			const st = this.state;
			const color = (c: unknown) => {
				const r = resolveColor(c);
				return r === "none" ? undefined : r;
			};
			for (const sec of this.path) {
				const prev = sec.paint;
				const paint: Paint = {
					fill: fill ? color(st.fillColor) : prev?.fill,
					stroke: stroke ? color(st.strokeColor) : prev?.stroke,
					strokeWidth: stroke || !prev ? st.strokeWidth ?? 1 : prev.strokeWidth,
					dashed: stroke || !prev ? !!st.dashed : prev.dashed,
					alpha: (st.alpha ?? 1) * ((fill ? st.fillAlpha : st.strokeAlpha) ?? 1),
				};
				sec.paint = paint;
				for (const child of Array.from(sec.element.children)) {
					if (child.localName === "Cell") sec.element.removeChild(child);
				}
				sec.element.appendChild(this.cell("NoFill", paint.fill ? 0 : 1));
				sec.element.appendChild(this.cell("NoLine", paint.stroke ? 0 : 1));
			}
		}

		/** Canvas point → shape-local Visio coordinates (draw.io units, y up). */
		local(x: number, y: number): { x: number; y: number } {
			const s = this.state;
			const f = this.frame;
			return {
				x: (x + s.dx) * s.scale - f.x,
				y: f.height - ((y + s.dy) * s.scale - f.y),
			};
		}

		row(type: string, cells: [string, number, string?][]): Element {
			const r = this.el("Row");
			r.setAttribute("T", type);
			r.setAttribute("IX", String(this.step++));
			for (const [n, v, f] of cells) {
				if (v != null && isFinite(v)) r.appendChild(this.cell(n, v, f));
			}
			return r;
		}

		/** Relative coordinates (fractions of Width/Height) keep the geometry correct when the shape is resized in Visio. */
		rel(p: { x: number; y: number }): { x: number; y: number } {
			const f = this.frame;
			return { x: f.width ? p.x / f.width : 0, y: f.height ? p.y / f.height : 0 };
		}

		begin() {
			this.startPath();
		}

		rect(x: number, y: number, w: number, h: number) {
			this.startPath();
			const s = this.state;
			const p = this.local(x, y);
			w *= s.scale;
			h *= s.scale;
			const k = UNITS_PER_INCH;
			const sec = this.geoSec!.element;
			sec.appendChild(this.row("MoveTo", [["X", p.x / k], ["Y", p.y / k]]));
			sec.appendChild(this.row("LineTo", [["X", (p.x + w) / k], ["Y", p.y / k]]));
			sec.appendChild(this.row("LineTo", [["X", (p.x + w) / k], ["Y", (p.y - h) / k]]));
			sec.appendChild(this.row("LineTo", [["X", p.x / k], ["Y", (p.y - h) / k]]));
			sec.appendChild(this.row("LineTo", [["X", p.x / k], ["Y", p.y / k]]));
		}

		roundrect(x: number, y: number, w: number, h: number, dx: number, dy: number) {
			this.rect(x, y, w, h);
			this.setCellScaled("Rounding", Math.min(dx, dy) * this.state.scale);
		}

		ellipse(x: number, y: number, w: number, h: number) {
			this.startPath();
			const s = this.state;
			w *= s.scale;
			h *= s.scale;
			const p = this.local(x, y);
			const f = this.frame;
			const k = UNITS_PER_INCH;
			const cx = p.x + w / 2;
			const cy = p.y - h / 2;
			const fw = f.width || 1;
			const fh = f.height || 1;
			this.geoSec!.element.appendChild(
				this.row("Ellipse", [
					["X", cx / k, `Width*${cx / fw}`],
					["Y", cy / k, `Height*${cy / fh}`],
					["A", p.x / k, `Width*${p.x / fw}`],
					["B", cy / k, `Height*${cy / fh}`],
					["C", cx / k, `Width*${cx / fw}`],
					["D", p.y / k, `Height*${p.y / fh}`],
				])
			);
		}

		moveTo(x: number, y: number) {
			// A MoveTo inside a section usually produces a wrong fill in Visio.
			if (this.step > 1) this.newGeoSection();
			this.lastMoveX = this.lastX = x;
			this.lastMoveY = this.lastY = y;
			const r = this.rel(this.local(x, y));
			this.geoSec!.element.appendChild(this.row("RelMoveTo", [["X", r.x], ["Y", r.y]]));
		}

		lineTo(x: number, y: number) {
			this.lastX = x;
			this.lastY = y;
			const r = this.rel(this.local(x, y));
			this.geoSec!.element.appendChild(this.row("RelLineTo", [["X", r.x], ["Y", r.y]]));
		}

		quadTo(x1: number, y1: number, x2: number, y2: number) {
			this.lastX = x2;
			this.lastY = y2;
			const c = this.rel(this.local(x1, y1));
			const e = this.rel(this.local(x2, y2));
			this.geoSec!.element.appendChild(this.row("RelQuadBezTo", [["X", e.x], ["Y", e.y], ["A", c.x], ["B", c.y]]));
		}

		curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
			this.lastX = x3;
			this.lastY = y3;
			const c1 = this.rel(this.local(x1, y1));
			const c2 = this.rel(this.local(x2, y2));
			const e = this.rel(this.local(x3, y3));
			this.geoSec!.element.appendChild(
				this.row("RelCubBezTo", [["X", e.x], ["Y", e.y], ["A", c1.x], ["B", c1.y], ["C", c2.x], ["D", c2.y]])
			);
		}

		close() {
			if (this.lastMoveX !== this.lastX || this.lastMoveY !== this.lastY) {
				this.lineTo(this.lastMoveX, this.lastMoveY);
			}
		}

		stroke() {
			this.paintPath(false, true);
		}

		fill() {
			this.paintPath(true, false);
		}

		fillAndStroke() {
			this.paintPath(true, true);
		}

		rotate(theta: number) {
			// Flips are written from the style (FlipX/FlipY); only the angle is needed here.
			if (theta !== 0) {
				this.setCell("Angle", ((360 - theta) * Math.PI) / 180);
				this.state.rotation = (this.state.rotation || 0) + theta;
			}
		}

		image(x: number, y: number, w: number, h: number, src: string) {
			if (this.foreign || !src) {
				return;
			}
			const s = this.state;
			w *= s.scale;
			h *= s.scale;
			const p = this.local(x, y);
			this.foreign = addImage(this.doc, { src, width: w, height: h });
			this.setCellScaled("ImgOffsetX", p.x);
			this.setCellScaled("ImgOffsetY", p.y - h);
			this.setCellScaled("ImgWidth", w);
			this.setCellScaled("ImgHeight", h);
		}

		text(
			x: number, y: number, w: number, h: number, str: any,
			align: string, valign: string, wrap: boolean, format: string,
			_overflow: string, _clip: boolean, rotation: number
		) {
			if (this.hasText || str == null || str === "") {
				return;
			}
			this.hasText = true;
			const state = this.cellState;
			const style = state.style;
			if (mxUtils.isNode(str)) {
				str = mxUtils.getOuterHtml(str);
			}
			const s = this.state;
			if (w === 0 && h === 0) {
				// Edge labels have no box.
				const size = mxUtils.getSizeForString(String(str), style.fontSize, style.fontFamily);
				w = size.width * 2;
				h = size.height * 2;
			}
			w *= s.scale;
			h *= s.scale;

			const runs = format === "html" ? this.htmlRuns(String(str)) : this.plainRuns(String(str));
			if (runs.length === 0) {
				return;
			}

			// Measured text extent: the Visio text block must be at least this large.
			let calcW = 0;
			let calcH = 0;
			for (const line of runs.map((r) => r.text).join("").split("\n")) {
				const size = mxUtils.getSizeForString(line || " ", style.fontSize, style.fontFamily, wrap && w > 0 ? w : null);
				calcW = Math.max(calcW, Math.min(size.width, w || size.width));
				calcH += size.height;
			}

			// draw.io anchors the label box at (x, y): its left/center/right edge and its
			// top/middle/bottom edge. Put the same point of the Visio text block there.
			const bw = Math.max(w, calcW);
			const bh = Math.max(h, calcH);
			const locX = align === "left" ? 0 : align === "right" ? bw : bw / 2;
			const locY = valign === "top" ? bh : valign === "bottom" ? 0 : bh / 2;

			// The shape's Visio angle includes its direction (north/south/west turn the
			// outline), but draw.io never turns the label by the direction: undo it here.
			const total = state.shape?.getShapeRotation?.() ?? 0;
			const direction = (((total - (state.shape?.getRotation?.() ?? 0)) % 360) + 360) % 360;
			let p = this.local(x, y);
			if (direction !== 0) {
				const f = this.frame;
				const rad = (direction * Math.PI) / 180;
				const dx = p.x - f.width / 2;
				const dy = p.y - f.height / 2;
				p = {
					x: f.width / 2 + dx * Math.cos(rad) - dy * Math.sin(rad),
					y: f.height / 2 + dx * Math.sin(rad) + dy * Math.cos(rad),
				};
			}
			this.setCellScaled("TxtPinX", p.x);
			this.setCellScaled("TxtPinY", p.y);
			this.setCellScaled("TxtWidth", bw);
			this.setCellScaled("TxtHeight", bh);
			this.setCellScaled("TxtLocPinX", locX);
			this.setCellScaled("TxtLocPinY", locY);
			this.setCell("VerticalAlign", valign === "top" ? 0 : valign === "bottom" ? 2 : 1);
			const textAngle = ((((rotation || 0) - total) % 360) + 360) % 360;
			if (textAngle !== 0) {
				this.setCell("TxtAngle", ((360 - textAngle) * Math.PI) / 180);
			}
			this.appendRuns(runs);
		}

		baseChar(): CharFormat {
			const style = this.cellState.style;
			const fontStyle = parseInt(style.fontStyle, 10) || 0;
			return {
				color: resolveColor(style.fontColor) ?? "#000000",
				size: parseFloat(style.fontSize) || 12,
				font: style.fontFamily || "Helvetica",
				bold: (fontStyle & 1) !== 0,
				italic: (fontStyle & 2) !== 0,
				underline: (fontStyle & 4) !== 0,
			};
		}

		basePara(): ParaFormat {
			return { align: horzAlign(this.cellState.style.align), bullet: false };
		}

		plainRuns(str: string): Run[] {
			return [{ text: str, char: this.baseChar(), para: this.basePara() }];
		}

		/** Reads the rendered HTML label (fonts and colors as the browser computed them). */
		htmlRuns(str: string): Run[] {
			const textNode = this.cellState.text?.node as Element | undefined;
			const container = textNode?.getElementsByTagName("div")[W.mxClient.NO_FO ? 0 : 1];
			if (!container) {
				// Not rendered as HTML: fall back to the label's text.
				if (!this.html2txt) this.html2txt = document.createElement("div");
				if (mxUtils.getValue(this.cellState.style, "nl2Br", "1") !== "0") {
					str = str.replace(/\n/g, "").replace(/<br\s*\/?>/gi, "\n");
				}
				this.html2txt.innerHTML = W.Graph.sanitizeHtml(str);
				return this.plainRuns(mxUtils.extractTextWithWhitespace(this.html2txt.childNodes));
			}

			const runs: Run[] = [];
			const base = this.baseChar();
			const push = (text: string, char: CharFormat, para: ParaFormat) => {
				const last = runs[runs.length - 1];
				if (last && sameChar(last.char, char) && samePara(last.para, para)) {
					last.text += text;
				} else {
					runs.push({ text, char, para });
				}
			};
			const endsWithBreak = () => runs.length === 0 || runs[runs.length - 1].text.endsWith("\n");

			const charOf = (el: Element, inherited: CharFormat): CharFormat => {
				const cs = getComputedStyle(el);
				const weight = parseInt(cs.fontWeight, 10);
				// Only markup sets a run's color: draw.io's page CSS (.geEditor *) recolors
				// every element of the hidden graph and would break inheritance.
				const inline = (el as HTMLElement).style?.color;
				const fontAttr = el.nodeName.toUpperCase() === "FONT" ? el.getAttribute("color") : null;
				const explicit = inline ? resolveColor(inline) : fontAttr ? resolveColor(fontAttr) : undefined;
				return {
					color: explicit && explicit !== "none" ? explicit : inherited.color,
					size: parseFloat(cs.fontSize) || inherited.size,
					font: (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim() || inherited.font,
					bold: cs.fontWeight === "bold" || weight >= 600,
					italic: cs.fontStyle === "italic",
					underline: inherited.underline || (cs.textDecorationLine || "").includes("underline"),
				};
			};

			const walk = (node: Node, char: CharFormat, para: ParaFormat, list?: { ordered: boolean; n: number }) => {
				if (node.nodeType === 3) {
					const text = (node.textContent || "").replace(/\s*\n\s*/g, " ");
					if (text) push(text, char, para);
					return;
				}
				if (node.nodeType !== 1) {
					return;
				}
				const el = node as Element;
				const tag = el.nodeName.toUpperCase();
				if (tag === "BR") {
					push("\n", char, para);
					return;
				}
				const c = charOf(el, char);
				let p = para;
				const block = BLOCK.test(tag);
				if (block) {
					const align = getComputedStyle(el).textAlign;
					p = { align: align ? horzAlign(align) : para.align, bullet: para.bullet };
					if (!endsWithBreak()) push("\n", c, para);
				}
				let childList = list;
				if (tag === "UL" || tag === "OL") {
					childList = { ordered: tag === "OL", n: 0 };
				} else if (tag === "LI") {
					if (list?.ordered) {
						push(`${++list.n}. `, c, p);
					} else {
						p = { ...p, bullet: true };
					}
				}
				for (const child of Array.from(el.childNodes)) {
					walk(child, c, p, childList);
				}
				if (block && !endsWithBreak()) {
					push("\n", c, p);
				}
			};

			const rootPara = this.basePara();
			for (const child of Array.from(container.childNodes)) {
				walk(child, charOf(container, base), rootPara);
			}
			// A trailing break would add an empty paragraph in Visio.
			const last = runs[runs.length - 1];
			if (last && last.text.endsWith("\n")) {
				last.text = last.text.replace(/\n+$/, "");
				if (!last.text) runs.pop();
			}
			return runs;
		}

		appendRuns(runs: Run[]) {
			const chars: CharFormat[] = [];
			const paras: ParaFormat[] = [];
			const charSec = this.el("Section");
			charSec.setAttribute("N", "Character");
			const paraSec = this.el("Section");
			paraSec.setAttribute("N", "Paragraph");
			const text = this.el("Text");

			let lastChar = -1;
			let lastPara = -1;
			for (const run of runs) {
				let ci = chars.findIndex((c) => sameChar(c, run.char));
				if (ci < 0) {
					ci = chars.push(run.char) - 1;
					charSec.appendChild(this.charRow(ci, run.char));
				}
				let pi = paras.findIndex((p) => samePara(p, run.para));
				if (pi < 0) {
					pi = paras.push(run.para) - 1;
					paraSec.appendChild(this.paraRow(pi, run.para));
				}
				if (pi !== lastPara) {
					const pp = this.el("pp");
					pp.setAttribute("IX", String(pi));
					text.appendChild(pp);
					lastPara = pi;
				}
				if (ci !== lastChar) {
					const cp = this.el("cp");
					cp.setAttribute("IX", String(ci));
					text.appendChild(cp);
					lastChar = ci;
				}
				text.appendChild(this.doc.createTextNode(stripInvalidXml(run.text)));
			}
			this.shape.appendChild(charSec);
			this.shape.appendChild(paraSec);
			this.shape.appendChild(text);
		}

		charRow(ix: number, c: CharFormat): Element {
			const row = this.el("Row");
			row.setAttribute("IX", String(ix));
			if (c.color) row.appendChild(this.cell("Color", c.color));
			// Sizes scale with the shapes; 0.97 keeps Visio from wrapping text that fits in draw.io.
			if (c.size) row.appendChild(this.cell("Size", (c.size * 0.97) / UNITS_PER_INCH));
			if (c.font) row.appendChild(this.cell("Font", c.font));
			const style = (c.bold ? 1 : 0) | (c.italic ? 2 : 0) | (c.underline ? 4 : 0);
			row.appendChild(this.cell("Style", style));
			row.appendChild(this.cell("Case", 0));
			row.appendChild(this.cell("Pos", 0));
			row.appendChild(this.cell("FontScale", 1));
			row.appendChild(this.cell("Letterspace", 0));
			return row;
		}

		paraRow(ix: number, p: ParaFormat): Element {
			const row = this.el("Row");
			row.setAttribute("IX", String(ix));
			row.appendChild(this.cell("HorzAlign", p.align));
			if (p.bullet) {
				row.appendChild(this.cell("Bullet", 1));
				row.appendChild(this.cell("IndLeft", 0.25));
				row.appendChild(this.cell("IndFirst", -0.25));
			}
			return row;
		}
	}

	return new VsdxCanvas();
}

function horzAlign(align: string | undefined): number {
	switch (align) {
		case "left":
		case "start":
		case "justify":
			return 0;
		case "right":
		case "end":
			return 2;
		default:
			return 1;
	}
}

function sameChar(a: CharFormat, b: CharFormat): boolean {
	return (
		a.color === b.color && a.size === b.size && a.font === b.font &&
		!!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline
	);
}

function samePara(a: ParaFormat, b: ParaFormat): boolean {
	return a.align === b.align && a.bullet === b.bullet;
}

/** Drops characters XML 1.0 cannot contain. (No regex: escapes must stay ASCII in the bundle.) */
export function stripInvalidXml(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		if (c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000) {
			out += ch;
		}
	}
	return out;
}
