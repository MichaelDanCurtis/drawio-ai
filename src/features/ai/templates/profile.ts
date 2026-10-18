import { inflateRawSync, inflateSync } from "zlib";

// Pure helpers (no vscode import) for turning template sources into a style profile.

export type SourceKind = "diagram" | "library" | "guide" | "image";

export interface Count {
	value: string;
	uses: number;
}

export interface ShapeRole {
	role: string;
	style: string;
	example?: string;
	width: number;
	height: number;
	uses: number;
}

export interface TemplateProfile {
	colors: { fill: Count[]; stroke: Count[]; font: Count[] };
	fonts: Count[];
	fontSizes: Count[];
	edgeStyles: Count[];
	shapes: ShapeRole[];
	library: { title: string; style: string; width: number; height: number }[];
	hasTitle: boolean;
	hasLegend: boolean;
	stats: { diagrams: number; cells: number };
}

export interface TemplateEnforce {
	palette: boolean;
	fonts: boolean;
	edges: boolean;
	title: boolean;
	legend: boolean;
}

export interface TemplateManifest {
	version: 1;
	name: string;
	description?: string;
	sources: { file: string; kind: SourceKind; note?: string }[];
	enforce: TemplateEnforce;
	profile: TemplateProfile;
	createdAt: string;
}

export interface LoadedTemplate {
	id: string;
	/** Folder of the template (informational). */
	location: string;
	manifest: TemplateManifest;
	rules: string;
}

export interface ParsedCell {
	id: string;
	value: string;
	style: string;
	vertex: boolean;
	edge: boolean;
	parent?: string;
	width?: number;
	height?: number;
}

const IGNORED_COLORS = new Set(["", "none", "default", "inherit"]);
const EDGE_STYLE_KEYS = ["edgeStyle", "curved", "rounded", "orthogonalLoop", "jettySize", "endArrow", "endFill", "startArrow", "startFill", "dashed", "strokeWidth"];

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (_, e: string) => {
		const k = e.toLowerCase();
		if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
		return ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " } as Record<string, string>)[k];
	});
}

export function parseStyle(style: string): { base: string[]; props: Record<string, string> } {
	const base: string[] = [];
	const props: Record<string, string> = {};
	for (const part of (style || "").split(";")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq < 0) base.push(part);
		else props[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return { base, props };
}

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
	return out;
}

/** draw.io's compressed page format: base64(deflateRaw(encodeURIComponent(xml))). */
export function decompressDrawio(data: string): string {
	const inflated = inflateRawSync(Buffer.from(data.trim(), "base64")).toString("utf8");
	try {
		return decodeURIComponent(inflated);
	} catch {
		return inflated;
	}
}

/** Returns the mxGraphModel XML of every page in a .drawio / .drawio.svg / plain model file. */
export function diagramPages(content: string): string[] {
	let text = content;
	const svgContent = /<svg[^>]*\scontent="([^"]*)"/.exec(text);
	if (svgContent) text = decodeEntities(svgContent[1]);
	if (!/<mxfile/.test(text)) {
		return /<mxGraphModel/.test(text) ? [text] : [];
	}
	const pages: string[] = [];
	const re = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const body = m[1].trim();
		if (body.startsWith("<")) pages.push(body);
		else if (body) {
			try {
				pages.push(decompressDrawio(body));
			} catch {
				// unreadable page; skip
			}
		}
	}
	return pages;
}

export function parseCells(modelXml: string): ParsedCell[] {
	const cells: ParsedCell[] = [];
	// <object|UserObject label=...><mxCell .../></object>, or a bare <mxCell ...>...</mxCell>
	const re = /<(object|UserObject)\b([^>]*)>\s*<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)\s*<\/\1>|<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(modelXml))) {
		const wrapper = m[1] ? attrs(m[2]) : undefined;
		const a = attrs(m[1] ? m[3] : m[5]);
		const inner = (m[1] ? m[4] : m[6]) ?? "";
		const geo = /<mxGeometry\b([^>]*)/.exec(inner);
		const g = geo ? attrs(geo[1]) : {};
		cells.push({
			id: wrapper?.id ?? a.id ?? "",
			value: wrapper ? wrapper.label ?? "" : a.value ?? "",
			style: a.style ?? "",
			vertex: a.vertex === "1",
			edge: a.edge === "1",
			parent: a.parent,
			width: g.width ? Number(g.width) : undefined,
			height: g.height ? Number(g.height) : undefined,
		});
	}
	return cells;
}

/** Shapes from a draw.io custom library (<mxlibrary>[{xml,w,h,title}]</mxlibrary>). */
export function parseLibrary(content: string): TemplateProfile["library"] {
	const m = /<mxlibrary>([\s\S]*)<\/mxlibrary>/.exec(content);
	if (!m) return [];
	let entries: any[];
	try {
		entries = JSON.parse(m[1]);
	} catch {
		return [];
	}
	const out: TemplateProfile["library"] = [];
	for (const e of Array.isArray(entries) ? entries : []) {
		if (typeof e?.xml !== "string") continue;
		let xml = e.xml.trim();
		if (!xml.startsWith("<") && !xml.startsWith("&lt;")) {
			try {
				xml = decompressDrawio(xml);
			} catch {
				continue;
			}
		}
		if (xml.startsWith("&lt;")) xml = decodeEntities(xml);
		const cell = parseCells(xml).find((c) => c.vertex || c.edge);
		if (!cell) continue;
		out.push({
			title: String(e.title || labelText(cell.value) || "shape"),
			style: cell.style,
			width: Number(e.w ?? cell.width ?? 120),
			height: Number(e.h ?? cell.height ?? 60),
		});
	}
	return out;
}

export function labelText(value: string): string {
	return decodeEntities(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeColor(c: string | undefined): string | undefined {
	if (c == null) return undefined;
	const v = c.trim().toLowerCase();
	if (IGNORED_COLORS.has(v) || v.startsWith("light-dark")) return undefined;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
	return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : v;
}

export function shapeRole(style: string): string {
	const { base, props } = parseStyle(style);
	if (base.includes("swimlane") || props.shape === "swimlane" || props.container === "1") return "container";
	if (base.includes("text") || props.shape === "text") return "text";
	if (base.includes("image") || props.shape === "image" || props.image) return "image";
	const shape = props.shape ?? base.find((b) => b !== "html" && b !== "whiteSpace");
	if (shape) return shape;
	return props.rounded === "1" ? "rounded rectangle" : "rectangle";
}

export function edgeSignature(style: string): string {
	const { props } = parseStyle(style);
	return EDGE_STYLE_KEYS.filter((k) => props[k] !== undefined)
		.map((k) => `${k}=${props[k]}`)
		.join(";");
}

function tally(map: Map<string, number>, key: string | undefined) {
	if (key) map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, n: number): Count[] {
	return [...map.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([value, uses]) => ({ value, uses }));
}

export function isTitleLike(label: string, style: string, maxFont: number): boolean {
	if (!label) return false;
	const size = Number(parseStyle(style).props.fontSize) || 0;
	return /\btitle\b/i.test(label) || /\btitle\b/i.test(style) || (size >= Math.max(18, maxFont) && label.length < 80);
}

export function isLegendLike(label: string, style: string): boolean {
	return /^\s*(legend|key)\b/i.test(label) || /\blegend\b/i.test(style);
}

export function extractProfile(input: { diagrams: string[]; libraries: string[] }): TemplateProfile {
	const fill = new Map<string, number>();
	const stroke = new Map<string, number>();
	const font = new Map<string, number>();
	const fonts = new Map<string, number>();
	const sizes = new Map<string, number>();
	const edges = new Map<string, number>();
	const shapes = new Map<string, ShapeRole>();
	let pages = 0;
	let cellCount = 0;
	let hasTitle = false;
	let hasLegend = false;

	const addStyle = (style: string, vertex: boolean) => {
		const { props } = parseStyle(style);
		tally(fill, vertex ? normalizeColor(props.fillColor) : undefined);
		tally(stroke, normalizeColor(props.strokeColor));
		tally(font, normalizeColor(props.fontColor));
		tally(fonts, props.fontFamily);
		tally(sizes, props.fontSize);
		if (!vertex) tally(edges, edgeSignature(style) || "(default)");
	};

	for (const content of input.diagrams) {
		for (const page of diagramPages(content)) {
			pages++;
			const cells = parseCells(page).filter((c) => c.vertex || c.edge);
			cellCount += cells.length;
			const maxFont = Math.max(0, ...cells.map((c) => Number(parseStyle(c.style).props.fontSize) || 0));
			for (const c of cells) {
				addStyle(c.style, c.vertex);
				if (!c.vertex) continue;
				const label = labelText(c.value);
				hasTitle ||= isTitleLike(label, c.style, maxFont);
				hasLegend ||= isLegendLike(label, c.style);
				const role = shapeRole(c.style);
				const { props } = parseStyle(c.style);
				const key = [role, normalizeColor(props.fillColor), normalizeColor(props.strokeColor), props.dashed].join("|");
				const existing = shapes.get(key);
				if (existing) {
					existing.uses++;
					existing.example ??= label || undefined;
				} else {
					shapes.set(key, { role, style: c.style, example: label || undefined, width: c.width ?? 120, height: c.height ?? 60, uses: 1 });
				}
			}
		}
	}

	const library = input.libraries.flatMap(parseLibrary);
	for (const l of library) {
		addStyle(l.style, !/endArrow|edgeStyle/.test(l.style));
	}

	return {
		colors: { fill: top(fill, 16), stroke: top(stroke, 12), font: top(font, 8) },
		fonts: top(fonts, 4),
		fontSizes: top(sizes, 6),
		edgeStyles: top(edges, 3),
		shapes: [...shapes.values()].sort((a, b) => b.uses - a.uses).slice(0, 20),
		library: library.slice(0, 200),
		hasTitle,
		hasLegend,
		stats: { diagrams: pages, cells: cellCount },
	};
}

/** Colours allowed by the template: everything its sources use. */
export function paletteOf(profile: TemplateProfile): Set<string> {
	return new Set([...profile.colors.fill, ...profile.colors.stroke, ...profile.colors.font].map((c) => c.value));
}

// ---------------------------------------------------------------------------
// Style guide documents
// ---------------------------------------------------------------------------

export function extractDocumentText(fileName: string, data: Uint8Array): { text: string; warning?: string } {
	const lower = fileName.toLowerCase();
	const buf = Buffer.from(data);
	if (lower.endsWith(".docx")) {
		const xml = unzipEntry(buf, "word/document.xml");
		if (!xml) return { text: "", warning: `${fileName}: not a readable .docx file.` };
		const text = decodeEntities(
			xml
				.toString("utf8")
				.replace(/<w:tab\/>/g, "\t")
				.replace(/<\/w:p>/g, "\n")
				.replace(/<[^>]+>/g, "")
		);
		return { text: tidy(text) };
	}
	if (lower.endsWith(".pdf")) {
		const text = tidy(pdfText(buf));
		const letters = (text.match(/[a-z]/gi) ?? []).length;
		if (letters < 40 || letters / Math.max(1, text.length) < 0.4) {
			return { text: "", warning: `${fileName}: could not extract text from this PDF. Paste its rules into rules.md instead.` };
		}
		return { text };
	}
	return { text: tidy(buf.toString("utf8")) };
}

function tidy(s: string): string {
	return s
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Minimal ZIP reader (enough for .docx). */
export function unzipEntry(buf: Buffer, name: string): Buffer | undefined {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return undefined;
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	for (let i = 0; i < count && p + 46 <= buf.length; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) return undefined;
		const method = buf.readUInt16LE(p + 10);
		const size = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
			const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
			const raw = buf.subarray(start, start + size);
			return method === 8 ? inflateRawSync(raw) : method === 0 ? raw : undefined;
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return undefined;
}

/** Best-effort PDF text extraction (simple fonts; Flate-compressed or plain content streams). */
export function pdfText(buf: Buffer): string {
	const raw = buf.toString("latin1");
	const out: string[] = [];
	const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) {
		const start = m.index + m[0].length;
		const end = raw.indexOf("endstream", start);
		if (end < 0) break;
		let body = buf.subarray(start, end);
		if (/\/FlateDecode/.test(m[1])) {
			try {
				body = inflateSync(body, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
			} catch {
				re.lastIndex = end;
				continue;
			}
		} else if (/\/Filter/.test(m[1])) {
			re.lastIndex = end;
			continue;
		}
		out.push(textOperators(body.toString("latin1")));
		re.lastIndex = end;
	}
	return out.join("\n");
}

function textOperators(content: string): string {
	if (!/\b(Tj|TJ)\b/.test(content)) return "";
	let text = "";
	const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|\bT\*|\bET\b|-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+T[dD]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content))) {
		const tok = m[0];
		if (tok.startsWith("(")) {
			text += pdfString(tok.slice(0, tok.lastIndexOf(")") + 1));
		} else if (tok.startsWith("[")) {
			for (const p of m[1].match(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g) ?? []) {
				if (p.startsWith("(")) text += pdfString(p);
				else if (Number(p) < -200) text += " ";
			}
		} else if (/T[dD]$/.test(tok)) {
			text += Number(tok.trim().split(/\s+/)[1]) !== 0 ? "\n" : " ";
		} else {
			text += "\n";
		}
	}
	return text;
}

function pdfString(lit: string): string {
	return lit
		.slice(1, -1)
		.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
			/^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: "\n", r: "", t: "\t", b: "", f: "" } as Record<string, string>)[e] ?? e
		);
}

// ---------------------------------------------------------------------------
// Rules and prompt text
// ---------------------------------------------------------------------------

const fmtCounts = (cs: Count[], n = 12) => cs.slice(0, n).map((c) => c.value).join(", ");

export function draftRules(name: string, profile: TemplateProfile, enforce: TemplateEnforce, extra: string[] = []): string {
	const lines: string[] = [];
	const fills = fmtCounts(profile.colors.fill);
	const strokes = fmtCounts(profile.colors.stroke);
	if (fills) lines.push(`- Fill colours come from this palette: ${fills}.`);
	if (strokes) lines.push(`- Stroke colours: ${strokes}.`);
	if (profile.fonts.length) lines.push(`- Font family: ${fmtCounts(profile.fonts, 2)}.`);
	if (profile.fontSizes.length) lines.push(`- Font sizes: ${fmtCounts(profile.fontSizes, 4)}.`);
	if (profile.edgeStyles[0] && profile.edgeStyles[0].value !== "(default)") {
		lines.push(`- Connectors use \`${profile.edgeStyles[0].value}\`.`);
	}
	for (const s of profile.shapes.slice(0, 8)) {
		if (s.role === "text") continue;
		lines.push(`- ${s.example ? `Shapes like "${s.example}"` : `A ${s.role}`} use \`${s.style}\` (${s.width}x${s.height}).`);
	}
	if (profile.library.length) {
		lines.push(`- Prefer shapes from the template library (${profile.library.slice(0, 8).map((l) => l.title).join(", ")}${profile.library.length > 8 ? ", …" : ""}).`);
	}
	if (enforce.title) lines.push("- Every diagram has a title.");
	if (enforce.legend) lines.push("- Every diagram has a legend explaining colours and shapes.");
	return [
		`# ${name}: diagram standards`,
		"",
		"<!-- The AI receives these rules for every diagram in this repository while this template is active.",
		"     Edit freely: naming conventions, layout direction, what each colour means, etc.",
		"     The AI follows them and flags anything that breaks them. -->",
		"",
		"## Rules",
		"",
		...(lines.length ? lines : ["- (add your rules here)"]),
		...extra,
		"",
	].join("\n");
}

export function describeTemplate(t: LoadedTemplate, options: { maxRuleChars?: number } = {}): string {
	const p = t.manifest.profile;
	const max = options.maxRuleChars ?? 6000;
	const rules = t.rules.replace(/<!--[\s\S]*?-->/g, "").trim();
	const enforced = Object.entries(t.manifest.enforce)
		.filter(([, v]) => v)
		.map(([k]) => k);
	const lines = [
		`## Active design template: "${t.manifest.name}"`,
		"This repository defines diagram standards. Follow them for everything you create or restyle. If the user explicitly asks for something that breaks a rule, do it, but say which rule it breaks. After larger edits call drawio_lint to check conformance and mention any remaining violations.",
		enforced.length ? `Checked by drawio_lint: ${enforced.join(", ")}.` : "",
		"",
		"### Rules",
		rules.length > max ? rules.slice(0, max) + "\n…(truncated; call drawio_get_template for the rest)" : rules || "(none)",
	];
	const profile: string[] = [];
	if (p.colors.fill.length) profile.push(`- Fill palette: ${fmtCounts(p.colors.fill)}`);
	if (p.colors.stroke.length) profile.push(`- Stroke palette: ${fmtCounts(p.colors.stroke)}`);
	if (p.colors.font.length) profile.push(`- Font colours: ${fmtCounts(p.colors.font, 6)}`);
	if (p.fonts.length) profile.push(`- Fonts: ${fmtCounts(p.fonts, 3)}${p.fontSizes.length ? `; sizes ${fmtCounts(p.fontSizes, 5)}` : ""}`);
	if (p.edgeStyles.length) profile.push(`- Edge style: ${p.edgeStyles[0].value}`);
	for (const s of p.shapes.slice(0, 10)) {
		profile.push(`- ${s.role}${s.example ? ` (e.g. "${s.example}")` : ""}: ${s.style} [${s.width}x${s.height}]`);
	}
	if (p.library.length) {
		profile.push(`- Library shapes (${p.library.length}): ${p.library.slice(0, 15).map((l) => l.title).join(", ")}${p.library.length > 15 ? ", …" : ""} (drawio_get_template lists their styles)`);
	}
	if (profile.length) lines.push("", "### Style profile extracted from the template sources", ...profile);
	return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
