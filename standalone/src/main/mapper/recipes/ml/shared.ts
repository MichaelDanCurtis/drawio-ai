import { MapperError } from "../../types";
import type { MapFinding, MapGraph } from "../../types";

const SEVERITY_ORDER: Record<MapFinding["severity"], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Findings whose shapes are on the map, one per id, most severe first. */
export function keepOnMap(findings: MapFinding[], graph: MapGraph | undefined): MapFinding[] {
	if (!graph) return [];
	const ids = new Set(graph.nodes.map((n) => n.id));
	const seen = new Set<string>();
	const out: MapFinding[] = [];
	for (const f of findings) {
		const nodeIds = [...new Set(f.nodeIds.filter((id) => ids.has(id)))];
		if (!nodeIds.length || seen.has(f.id)) continue;
		seen.add(f.id);
		out.push({ ...f, nodeIds });
	}
	return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}

/** "latest" or "none" when a container image reference floats (no tag, or :latest, and no digest); else undefined. */
export function floatingImage(image: string): "latest" | "none" | undefined {
	const ref = image.trim();
	if (!ref || /@sha256:[0-9a-f]{16,}/i.test(ref)) return undefined;
	const last = ref.split("/").pop() ?? ref;
	if (!last.includes(":")) return "none";
	return last.split(":").pop()!.toLowerCase() === "latest" ? "latest" : undefined;
}

/** Shapes shared by the ML maps. */
export const ML_STYLES = {
	pipeline:
		"rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#f6f8fa;strokeColor=#57606a;",
	group:
		"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;dashed=1;fillColor=none;strokeColor=#9673a6;",
	step: "rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontStyle=1;",
	stepTable:
		"swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;rounded=1;arcSize=4;",
	condition: "rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;",
	data: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=8;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;",
	model: "shape=cube;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;darkOpacity=0.05;darkOpacity2=0.1;size=8;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;",
	metrics: "shape=document;whiteSpace=wrap;html=1;boundedLbl=1;size=0.2;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;",
	artifact: "shape=document;whiteSpace=wrap;html=1;boundedLbl=1;size=0.2;fillColor=#f5f5f5;strokeColor=#666666;fontSize=11;",
	params: "shape=note;whiteSpace=wrap;html=1;size=10;fillColor=#fff2cc;strokeColor=#d6b656;align=left;verticalAlign=top;spacingLeft=6;fontSize=10;",
	external: "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;fontColor=#555555;fontSize=11;",
	gap: "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#fff5f5;strokeColor=#d14b4b;fontColor=#a33;fontSize=11;fontStyle=2;",
	flowEdge: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#6b7280;fontSize=10;",
	depEdge: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;dashed=1;strokeColor=#9673a6;fontSize=10;",
	softEdge: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;strokeColor=#9ca3af;fontSize=10;",
};

export type ArtifactType = "data" | "model" | "metrics" | "artifact";

/** Guesses what an artifact is from its name, path or declared type. */
export function artifactType(name: string, typeHint = ""): ArtifactType {
	const s = `${typeHint} ${name}`.toLowerCase();
	if (/metric|score|report|plots?\b|evaluation|\beval\b/.test(s)) return "metrics";
	if (/model|\.(pkl|pickle|joblib|pt|pth|onnx|h5|keras|safetensors|ckpt|gguf|mar|pb)\b|checkpoint|weights|estimator/.test(s)) return "model";
	if (/data|dataset|\.(csv|tsv|parquet|jsonl?|npy|npz|feather|arrow|tfrecords?|xml|txt|avro|orc)\b|uri_folder|uri_file|mltable|feature|train|test|valid|split|raw|prepared|processed|s3:\/\/|gs:\/\/|abfss?:\/\/|azureml:|\bin(put)?\b|\bout(put)?s?\b/.test(s)) return "data";
	return "artifact";
}

export function styleFor(type: ArtifactType): string {
	return ML_STYLES[type];
}

/** 494032768 → "494.0M"; 1543714304 → "1.54B". */
export function fmtCount(n: number): string {
	if (!Number.isFinite(n)) return "?";
	const a = Math.abs(n);
	if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
	if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(Math.round(n));
}

export function fmtInt(n: number): string {
	return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "?";
}

/** Metric values: short and readable. */
export function fmtNum(v: number): string {
	if (!Number.isFinite(v)) return String(v);
	if (Number.isInteger(v)) return String(v);
	const a = Math.abs(v);
	if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
	return String(Number(v.toPrecision(4)));
}

export function firstLine(s: unknown, max = 70): string {
	const t = String(s ?? "").trim().split("\n")[0].trim();
	return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** URLs as shown to the user and the agent: no credentials, no query string. */
export function redactUrl(u: string): string {
	try {
		const url = new URL(u);
		url.username = "";
		url.password = "";
		url.search = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return u.replace(/\/\/[^/@]*@/, "//");
	}
}

export interface HttpResult {
	status: number;
	ok: boolean;
	text: string;
	json?: any;
	headers: Headers;
}

/**
 * A GET/POST with a timeout that also stops when the Mapper is cancelled.
 * Errors never include request headers (they may hold tokens).
 */
export async function httpRequest(
	url: string,
	opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; binary?: boolean } = {}
): Promise<HttpResult & { bytes?: Buffer }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
	const onAbort = () => ctrl.abort();
	opts.signal?.addEventListener("abort", onAbort);
	try {
		const res = await fetch(url, {
			method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
			headers: { Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: ctrl.signal,
			redirect: "follow",
		});
		if (opts.binary) {
			const bytes = Buffer.from(await res.arrayBuffer());
			return { status: res.status, ok: res.ok, text: "", bytes, headers: res.headers };
		}
		const text = await res.text();
		let json: any;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		return { status: res.status, ok: res.ok, text, json, headers: res.headers };
	} catch (e: any) {
		if (opts.signal?.aborted) throw new MapperError("Cancelled");
		if (ctrl.signal.aborted) throw new MapperError(`${redactUrl(url)} did not answer in time.`);
		throw new MapperError(`Could not reach ${redactUrl(url)}: ${e?.cause?.code ?? e?.message ?? e}`);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

// ----- a little Python source scanning (static, best effort) -----

/** Index just past the string literal that starts at `i` (handles prefixes' quotes, triple quotes, escapes). */
export function skipString(src: string, i: number): number {
	const q = src[i];
	const triple = src.startsWith(q.repeat(3), i);
	const close = triple ? q.repeat(3) : q;
	let j = i + close.length;
	while (j < src.length) {
		if (src[j] === "\\") {
			j += 2;
			continue;
		}
		if (src.startsWith(close, j)) return j + close.length;
		if (!triple && src[j] === "\n") return j;
		j++;
	}
	return j;
}

/** Python source with comments blanked out (same length, so positions stay valid). */
export function stripPyComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '"' || c === "'") {
			const end = skipString(src, i);
			out += src.slice(i, end);
			i = end;
		} else if (c === "#") {
			let j = src.indexOf("\n", i);
			if (j < 0) j = src.length;
			out += " ".repeat(j - i);
			i = j;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

/** Index of the bracket closing the one at `open` (or the end of the text). */
export function matchBracket(src: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	const stack: string[] = [];
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'") {
			i = skipString(src, i) - 1;
			continue;
		}
		if (pairs[c]) stack.push(pairs[c]);
		else if (c === ")" || c === "]" || c === "}") {
			stack.pop();
			if (stack.length === 0) return i;
		}
	}
	return src.length;
}

/** Splits at `sep` characters that are not nested in brackets or strings. */
export function splitTopLevel(s: string, sep = ","): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '"' || c === "'") {
			i = skipString(s, i) - 1;
			continue;
		}
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === sep && depth === 0) {
			parts.push(s.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(s.slice(start));
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** `a=1, b="x"` → { a: "1", b: "\"x\"" } for the top-level keyword arguments of a call. */
export function kwargs(args: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of splitTopLevel(args)) {
		const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
		if (m) out[m[1]] = m[2].trim();
	}
	return out;
}

/** The value of a Python string literal (`"x"`, `'x'`, `f"x"`), else undefined. */
export function pyString(expr: string | undefined): string | undefined {
	if (!expr) return undefined;
	const m = /^[rbfuRBFU]{0,2}("""|'''|"|')([\s\S]*)\1$/.exec(expr.trim());
	return m ? m[2] : undefined;
}

/** Logical lines of Python: physical lines joined while brackets are open or a line ends with `\`. */
export function logicalLines(src: string): { text: string; start: number }[] {
	const out: { text: string; start: number }[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'") {
			i = skipString(src, i) - 1;
			continue;
		}
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
		else if (c === "\n" && depth === 0 && src[i - 1] !== "\\") {
			out.push({ text: src.slice(start, i), start });
			start = i + 1;
		}
	}
	out.push({ text: src.slice(start), start });
	return out.filter((l) => l.text.trim());
}
