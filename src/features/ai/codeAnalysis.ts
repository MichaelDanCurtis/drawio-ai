import * as yaml from "js-yaml";

// Pure, best-effort static analysis that turns source files into entities and
// relations for the AI to draw. No vscode import (unit-testable).

export type DiagramKind = "dependencies" | "classes" | "erd" | "infrastructure";

export interface SourceFile {
	/** Workspace-relative path with "/" separators. */
	path: string;
	text: string;
}

export interface Entity {
	id: string;
	kind: string;
	name: string;
	file: string;
	/** 1-based. */
	line: number;
	endLine?: number;
	details?: string[];
	group?: string;
}

export interface Relation {
	from: string;
	to: string;
	kind: string;
	label?: string;
}

export interface Analysis {
	kind: DiagramKind;
	entities: Entity[];
	relations: Relation[];
	notes: string[];
	fileCount: number;
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|java|cs|kt|go)$/;
const JS_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const MAX_MODULES = 60;
const MAX_MEMBERS = 12;

export function detectKind(files: SourceFile[]): DiagramKind {
	if (files.some((f) => /\.(sql|prisma)$/i.test(f.path))) return "erd";
	if (files.some((f) => /\.tf$/i.test(f.path) || (/\.ya?ml$/i.test(f.path) && /^\s*(services:|kind:\s*\w)/m.test(f.text)))) {
		return "infrastructure";
	}
	const code = files.filter((f) => CODE_EXT.test(f.path));
	return code.length <= 12 ? "classes" : "dependencies";
}

export function analyze(files: SourceFile[], kind: DiagramKind = detectKind(files)): Analysis {
	switch (kind) {
		case "erd":
			return { ...erd(files), kind, fileCount: files.length };
		case "infrastructure":
			return { ...infrastructure(files), kind, fileCount: files.length };
		case "classes":
			return { ...classes(files), kind, fileCount: files.length };
		default:
			return { ...dependencies(files), kind: "dependencies", fileCount: files.length };
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lineAt(text: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** Index of the bracket matching the one at `open` (skips strings and comments). */
function matchBracket(text: string, open: number): number {
	const o = text[open];
	const c = o === "{" ? "}" : o === "(" ? ")" : "]";
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const q = ch;
			for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) return text.length - 1;
			i++;
			continue;
		}
		if (ch === "-" && text[i + 1] === "-" && c === ")") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === o) depth++;
		else if (ch === c && --depth === 0) return i;
	}
	return text.length - 1;
}

/** Lines directly inside a `{...}` body (depth 0 relative to the body). */
function topLevelLines(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	for (const raw of body.split("\n")) {
		const line = raw.replace(/\/\/.*$/, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, '""');
		if (depth === 0 && line.trim()) out.push(line.trim());
		for (const ch of line) {
			if (ch === "{" || ch === "(" || ch === "[") depth++;
			else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		}
	}
	return out;
}

function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
	const out: string[] = [];
	for (const part of p.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

const unquote = (s: string) => s.trim().replace(/^[`"[]|[`"\]]$/g, "");
const lastPart = (s: string) => unquote(s.split(".").pop() ?? s);

// ---------------------------------------------------------------------------
// Module dependencies
// ---------------------------------------------------------------------------

function dependencies(files: SourceFile[]): Omit<Analysis, "kind" | "fileCount"> {
	const code = files.filter((f) => CODE_EXT.test(f.path) && !/\.d\.ts$/.test(f.path));
	const paths = new Set(code.map((f) => f.path));
	const externals = new Map<string, number>();
	const edges = new Map<string, Set<string>>();

	const resolveJs = (from: string, spec: string): string | undefined => {
		if (!spec.startsWith(".")) {
			const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (!spec.startsWith("node:")) externals.set(pkg, (externals.get(pkg) ?? 0) + 1);
			return undefined;
		}
		const base = normalize(`${dirname(from)}/${spec}`);
		const stripped = base.replace(/\.(m|c)?js$/, "");
		for (const cand of [base, ...[stripped, `${stripped}/index`].flatMap((b) => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((e) => b + e))]) {
			if (paths.has(cand)) return cand;
		}
		return undefined;
	};
	const resolvePy = (from: string, dots: string, mod: string): string[] => {
		let baseDir = dirname(from);
		for (let i = 1; i < dots.length; i++) baseDir = dirname(baseDir);
		const rel = mod.replace(/\./g, "/");
		const cands = dots
			? [normalize(`${baseDir}/${rel}.py`), normalize(`${baseDir}/${rel}/__init__.py`)]
			: [...paths].filter((p) => p.endsWith(`${rel}.py`) || p.endsWith(`${rel}/__init__.py`));
		const hit = cands.filter((c) => paths.has(c));
		if (!hit.length && !dots) externals.set(mod.split(".")[0], (externals.get(mod.split(".")[0]) ?? 0) + 1);
		return hit;
	};

	for (const f of code) {
		const deps = new Set<string>();
		if (JS_EXT.test(f.path)) {
			const re = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(f.text))) {
				const target = resolveJs(f.path, m[1] ?? m[2] ?? m[3]);
				if (target && target !== f.path) deps.add(target);
			}
		} else if (f.path.endsWith(".py")) {
			for (const line of f.text.split("\n")) {
				const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)/.exec(line);
				if (from) {
					const names = from[3].replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+/)[0]);
					const targets = resolvePy(f.path, from[1], from[2]);
					if (!targets.length && from[1] && !from[2]) names.forEach((n) => resolvePy(f.path, from[1], n).forEach((t) => deps.add(t)));
					targets.forEach((t) => deps.add(t));
					continue;
				}
				const imp = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(line);
				if (imp) imp[1].split(",").forEach((mod) => resolvePy(f.path, "", mod.trim()).forEach((t) => deps.add(t)));
			}
		}
		deps.delete(f.path);
		edges.set(f.path, deps);
	}

	const notes: string[] = [];
	const cycles = findCycles(edges);
	if (cycles.length) notes.push(`Import cycles: ${cycles.slice(0, 5).map((c) => c.join(" → ")).join("; ")}`);
	const ext = [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
	if (ext.length) notes.push(`Most used external packages: ${ext.map(([p, n]) => `${p} (${n})`).join(", ")}`);

	if (code.length > MAX_MODULES) {
		// Too many modules: one node per directory, edges weighted by import count.
		const dirOf = (p: string) => dirname(p) || ".";
		const dirs = new Map<string, Entity>();
		for (const f of code) {
			const d = dirOf(f.path);
			const e = dirs.get(d) ?? { id: `dir:${d}`, kind: "folder", name: d, file: f.path, line: 1, details: [] as string[] };
			e.details!.push(f.path.slice(d.length + 1));
			dirs.set(d, e);
		}
		for (const e of dirs.values()) {
			const n = e.details!.length;
			e.details = [`${n} file${n === 1 ? "" : "s"}`];
		}
		const counts = new Map<string, number>();
		for (const [from, tos] of edges) {
			for (const to of tos) {
				if (dirOf(from) === dirOf(to)) continue;
				const k = `${dirOf(from)}\u0000${dirOf(to)}`;
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
		}
		notes.unshift(`${code.length} modules aggregated into ${dirs.size} folders.`);
		return {
			entities: [...dirs.values()],
			relations: [...counts.entries()].map(([k, n]) => {
				const [a, b] = k.split("\u0000");
				return { from: `dir:${a}`, to: `dir:${b}`, kind: "imports", label: String(n) };
			}),
			notes,
		};
	}

	return {
		entities: code.map((f) => ({ id: `mod:${f.path}`, kind: "module", name: f.path.split("/").pop()!, file: f.path, line: 1, group: dirname(f.path) || undefined })),
		relations: [...edges].flatMap(([from, tos]) => [...tos].map((to) => ({ from: `mod:${from}`, to: `mod:${to}`, kind: "imports" }))),
		notes,
	};
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
	let index = 0;
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const on = new Set<string>();
	const out: string[][] = [];
	const visit = (v: string) => {
		idx.set(v, index);
		low.set(v, index++);
		stack.push(v);
		on.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!idx.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
		}
		if (low.get(v) === idx.get(v)) {
			const comp: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				on.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1) out.push([...comp.reverse(), comp[0]]);
		}
	};
	for (const v of graph.keys()) if (!idx.has(v)) visit(v);
	return out;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

interface ClassInfo extends Entity {
	extends: string[];
	implements: string[];
	fieldTypes: string[];
}

function classes(files: SourceFile[]): Omit<Analysis, "kind" | "fileCount"> {
	const found: ClassInfo[] = [];
	for (const f of files) {
		if (JS_EXT.test(f.path)) found.push(...curlyClasses(f, "ts"));
		else if (/\.(java|kt)$/.test(f.path)) found.push(...curlyClasses(f, "java"));
		else if (f.path.endsWith(".cs")) found.push(...curlyClasses(f, "cs"));
		else if (f.path.endsWith(".py")) found.push(...pythonClasses(f));
		else if (f.path.endsWith(".go")) found.push(...goTypes(f));
	}
	const ids = new Set<string>();
	for (const c of found) {
		if (ids.has(c.id)) c.id = `${c.id}@${c.file}`;
		ids.add(c.id);
	}
	const byName = new Map<string, ClassInfo[]>();
	for (const c of found) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
	const ext = (f: string) => f.slice(f.lastIndexOf("."));
	const lookup = (from: ClassInfo, name: string) => {
		const cands = byName.get(name) ?? [];
		return cands.find((c) => c.file === from.file) ?? cands.find((c) => ext(c.file) === ext(from.file));
	};
	const relations: Relation[] = [];
	const seen = new Set<string>();
	const add = (from: ClassInfo, name: string, kind: string) => {
		const target = lookup(from, name.replace(/<.*$/, "").trim());
		if (!target || target === from) return;
		const key = `${from.id}|${target.id}|${kind}`;
		if (seen.has(key)) return;
		seen.add(key);
		relations.push({ from: from.id, to: target.id, kind });
	};
	for (const c of found) {
		c.extends.forEach((n) => add(c, n, lookup(c, n)?.kind === "interface" && c.kind !== "interface" ? "implements" : "extends"));
		c.implements.forEach((n) => add(c, n, "implements"));
		for (const t of c.fieldTypes) for (const n of t.match(/[A-Za-z_]\w*/g) ?? []) if (byName.has(n)) add(c, n, "association");
	}
	const notes = found.length > 40 ? [`${found.length} types found; consider drawing the most connected ones first.`] : [];
	return {
		entities: found.map(({ extends: _e, implements: _i, fieldTypes: _f, ...e }) => e),
		relations,
		notes,
	};
}

function curlyClasses(f: SourceFile, lang: "ts" | "java" | "cs"): ClassInfo[] {
	const out: ClassInfo[] = [];
	const re =
		lang === "cs"
			? /^[ \t]*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|abstract|sealed|static|partial|record)\s+)*(class|interface|struct|enum|record)\s+(\w+)(?:<[^>{]*>)?\s*(?::\s*([^{]+?))?\s*(?:where[^{]*)?\{/gm
			: lang === "java"
			? /^[ \t]*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|abstract|final|static|sealed|open|data|internal)\s+)*(class|interface|enum|record|object)\s+(\w+)(?:<[^>{]*>)?(?:\s*\([^)]*\))?\s*(?:extends\s+([\w.<>, ]+?))?\s*(?::\s*([\w.<>(), ]+?))?\s*(?:implements\s+([\w.<>, ]+?))?\s*\{/gm
			: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum)\s+(\w+)(?:<[^>{]*>)?\s*(?:extends\s+([\w.<>, ]+?))?\s*(?:implements\s+([\w.<>, ]+?))?\s*\{/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(f.text))) {
		const open = m.index + m[0].length - 1;
		const close = matchBracket(f.text, open);
		const body = f.text.slice(open + 1, close);
		const kind = m[1] === "struct" || m[1] === "record" || m[1] === "object" ? "class" : m[1];
		const list = (s?: string) => (s ? s.split(",").map((x) => x.trim().replace(/<.*$/, "").replace(/\(.*$/, "")).filter(Boolean) : []);
		let ext: string[];
		let impl: string[];
		if (lang === "cs") {
			ext = list(m[3]);
			impl = [];
		} else if (lang === "java") {
			ext = [...list(m[3]), ...list(m[4])];
			impl = list(m[5]);
		} else {
			ext = list(m[3]);
			impl = list(m[4]);
		}
		const members = kind === "enum" ? enumMembers(body) : curlyMembers(body, lang);
		out.push({
			id: `type:${m[2]}`,
			kind,
			name: m[2],
			file: f.path,
			line: lineAt(f.text, m.index + (m[0].length - m[0].trimStart().length)),
			endLine: lineAt(f.text, close),
			details: members.lines.slice(0, MAX_MEMBERS).concat(members.lines.length > MAX_MEMBERS ? [`… ${members.lines.length - MAX_MEMBERS} more`] : []),
			extends: ext,
			implements: impl,
			fieldTypes: members.types,
		});
		re.lastIndex = close;
	}
	return out;
}

function enumMembers(body: string): { lines: string[]; types: string[] } {
	return {
		lines: body
			.split(/[,;\n]/)
			.map((s) => s.trim().split(/[\s=(]/)[0])
			.filter((s) => /^[A-Za-z_]\w*$/.test(s)),
		types: [],
	};
}

const NOT_MEMBERS = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "new", "throw", "super", "this", "case", "default"]);

function curlyMembers(body: string, lang: "ts" | "java" | "cs"): { lines: string[]; types: string[] } {
	const lines: string[] = [];
	const types: string[] = [];
	const vis = (mods: string, name: string) =>
		/\bprivate\b/.test(mods) || name.startsWith("#") ? "-" : /\bprotected\b/.test(mods) ? "#" : "+";
	for (const l of topLevelLines(body)) {
		if (/^(@|\/\*|\*|import\b|package\b)/.test(l)) continue;
		if (lang === "ts") {
			const method = /^((?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*)([#\w$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)?\s*(?::\s*([^{;]+))?/.exec(l);
			if (method && !NOT_MEMBERS.has(method[2])) {
				lines.push(`${vis(method[1], method[2])}${method[2]}(${method[3]?.split(",").map((p) => p.split(":")[0].trim()).filter(Boolean).join(", ") ?? ""})${method[4] ? `: ${method[4].trim()}` : ""}`);
				continue;
			}
			const prop = /^((?:(?:public|private|protected|static|readonly|declare|override)\s+)*)([#\w$]+)[?!]?\s*(?::\s*([^=;]+?))?\s*(?:=|;|$)/.exec(l);
			if (prop && !NOT_MEMBERS.has(prop[2])) {
				lines.push(`${vis(prop[1], prop[2])}${prop[2]}${prop[3] ? `: ${prop[3].trim()}` : ""}`);
				if (prop[3]) types.push(prop[3]);
			}
		} else {
			const mods = "(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|readonly|sealed|open|suspend|fun|val|var|const|lateinit|private set)\\s+)*";
			const kt = new RegExp(`^(${mods})(?:fun\\s+)?(\\w+)\\s*\\(([^)]*)\\)?\\s*(?::\\s*([\\w<>?, .]+))?`).exec(l);
			const method = new RegExp(`^(${mods})([\\w<>\\[\\],.? ]+?)\\s+(\\w+)\\s*\\(([^)]*)\\)?`).exec(l);
			if (method && !NOT_MEMBERS.has(method[3]) && !/^(return|new|throw)\b/.test(method[2])) {
				lines.push(`${vis(method[1], method[3])}${method[3]}(${method[4] ? method[4].split(",").map((p) => p.trim().split(/\s+/).pop()).join(", ") : ""}): ${method[2].trim()}`);
				continue;
			}
			if (kt && /\bfun\b/.test(l) && !NOT_MEMBERS.has(kt[2])) {
				lines.push(`${vis(kt[1], kt[2])}${kt[2]}()${kt[4] ? `: ${kt[4]}` : ""}`);
				continue;
			}
			const field = new RegExp(`^(${mods})([\\w<>\\[\\],.?]+)\\s+(\\w+)\\s*(?:[=;{]|$)`).exec(l);
			if (field && !NOT_MEMBERS.has(field[3]) && !/^(return|class|interface|enum)$/.test(field[2])) {
				lines.push(`${vis(field[1], field[3])}${field[3]}: ${field[2]}`);
				types.push(field[2]);
				continue;
			}
			const ktProp = new RegExp(`^(${mods})(\\w+)\\s*:\\s*([\\w<>?, .]+)`).exec(l);
			if (ktProp && /\b(val|var)\b/.test(l)) {
				lines.push(`${vis(ktProp[1], ktProp[2])}${ktProp[2]}: ${ktProp[3].trim()}`);
				types.push(ktProp[3]);
			}
		}
	}
	return { lines, types };
}

function pythonClasses(f: SourceFile): ClassInfo[] {
	const out: ClassInfo[] = [];
	const lines = f.text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(lines[i]);
		if (!m) continue;
		const indent = m[1].length;
		const members: string[] = [];
		const attrs = new Set<string>();
		const types: string[] = [];
		let end = i;
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j];
			if (!l.trim() || /^\s*#/.test(l)) continue;
			const ind = l.length - l.trimStart().length;
			if (ind <= indent) break;
			end = j;
			const def = /^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/.exec(l);
			if (def && ind <= indent + 4) members.push(`${def[1].startsWith("_") && def[1] !== "__init__" ? "-" : "+"}${def[1]}(${def[2].split(",").map((p) => p.trim().split(/[:=]/)[0].trim()).filter((p) => p && p !== "self" && p !== "cls").join(", ")})`);
			const attr = /^\s*self\.(\w+)\s*(?::\s*([\w\[\], .]+))?\s*=/.exec(l);
			if (attr && !attrs.has(attr[1])) {
				attrs.add(attr[1]);
				if (attr[2]) types.push(attr[2]);
			}
			const field = /^\s*(\w+)\s*:\s*([\w\[\], .|"']+?)\s*(?:=|$)/.exec(l);
			if (field && ind <= indent + 4 && !def) {
				attrs.add(field[1]);
				types.push(field[2]);
			}
		}
		const bases = (m[3] ?? "").split(",").map((b) => b.trim().split("[")[0].split(".").pop()!).filter((b) => b && !/^(object|metaclass=.*|ABC|Protocol|Generic)$/.test(b));
		out.push({
			id: `type:${m[2]}`,
			kind: (m[3] ?? "").includes("Protocol") || (m[3] ?? "").includes("ABC") ? "interface" : "class",
			name: m[2],
			file: f.path,
			line: i + 1,
			endLine: end + 1,
			details: [...[...attrs].map((a) => `${a.startsWith("_") ? "-" : "+"}${a}`), ...members].slice(0, MAX_MEMBERS),
			extends: bases,
			implements: [],
			fieldTypes: types,
		});
	}
	return out;
}

function goTypes(f: SourceFile): ClassInfo[] {
	const out: ClassInfo[] = [];
	const re = /^type\s+(\w+)\s+(struct|interface)\s*\{/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(f.text))) {
		const open = m.index + m[0].length - 1;
		const close = matchBracket(f.text, open);
		const embeds: string[] = [];
		const types: string[] = [];
		const details: string[] = [];
		for (const l of topLevelLines(f.text.slice(open + 1, close))) {
			const parts = l.split(/\s+/);
			if (parts.length === 1 || (parts.length === 2 && parts[1].startsWith("`"))) embeds.push(parts[0].replace(/^\*/, "").split(".").pop()!);
			else {
				details.push(`${/^[A-Z]/.test(parts[0]) ? "+" : "-"}${parts[0]}${m[2] === "interface" ? "" : `: ${parts[1]}`}`);
				types.push(parts.slice(1).join(" "));
			}
		}
		out.push({ id: `type:${m[1]}`, kind: m[2] === "interface" ? "interface" : "class", name: m[1], file: f.path, line: lineAt(f.text, m.index), endLine: lineAt(f.text, close), details, extends: embeds, implements: [], fieldTypes: types });
		re.lastIndex = close;
	}
	const methods = /^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*\(/gm;
	while ((m = methods.exec(f.text))) {
		const t = out.find((o) => o.name === m![1]);
		if (t && (t.details?.length ?? 0) < MAX_MEMBERS) t.details!.push(`${/^[A-Z]/.test(m[2]) ? "+" : "-"}${m[2]}()`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Database schemas
// ---------------------------------------------------------------------------

function erd(files: SourceFile[]): Omit<Analysis, "kind" | "fileCount"> {
	const tables = new Map<string, Entity>();
	const relations: Relation[] = [];
	for (const f of files) {
		if (/\.sql$/i.test(f.path)) sqlTables(f, tables, relations);
		else if (/\.prisma$/i.test(f.path)) prismaModels(f, tables, relations);
	}
	const known = new Set(tables.keys());
	return {
		entities: [...tables.values()],
		relations: relations.filter((r) => known.has(r.from.slice(6)) && known.has(r.to.slice(6))),
		notes: [],
	};
}

function sqlTables(f: SourceFile, tables: Map<string, Entity>, relations: Relation[]) {
	const text = f.text;
	const re = /create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)\s*\(/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const name = lastPart(m[1]);
		const open = m.index + m[0].length - 1;
		const close = matchBracket(text, open);
		const columns = text.slice(open + 1, close).replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
		const pk = new Set<string>();
		const cols: { name: string; type: string; fk?: string }[] = [];
		for (const part of splitTopLevel(columns)) {
			const p = part.trim();
			if (!p) continue;
			const tablePk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/i.exec(p);
			if (tablePk) {
				tablePk[1].split(",").forEach((c) => pk.add(unquote(c)));
				continue;
			}
			const tableFk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(p);
			if (tableFk) {
				const col = unquote(tableFk[1].split(",")[0]);
				const c = cols.find((x) => x.name === col);
				const target = lastPart(tableFk[2]);
				if (c) c.fk = `${target}.${unquote(tableFk[3] ?? "id")}`;
				relations.push({ from: `table:${name}`, to: `table:${target}`, kind: "fk", label: col });
				continue;
			}
			if (/^(constraint|unique|check|index|key|exclude)\b/i.test(p)) continue;
			const col = /^([`"[\]\w]+)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))?)/i.exec(p);
			if (!col) continue;
			const c = { name: unquote(col[1]), type: col[2].replace(/\s+/g, " ") } as { name: string; type: string; fk?: string };
			if (/\bprimary\s+key\b/i.test(p)) pk.add(c.name);
			const ref = /\breferences\s+([`"[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(p);
			if (ref) {
				c.fk = `${lastPart(ref[1])}.${unquote(ref[2] ?? "id")}`;
				relations.push({ from: `table:${name}`, to: `table:${lastPart(ref[1])}`, kind: "fk", label: c.name });
			}
			cols.push(c);
		}
		tables.set(name, {
			id: `table:${name}`,
			kind: "table",
			name,
			file: f.path,
			line: lineAt(text, m.index),
			endLine: lineAt(text, close),
			details: cols.map((c) => `${pk.has(c.name) ? "PK " : ""}${c.fk ? "FK " : ""}${c.name}: ${c.type}${c.fk ? ` → ${c.fk}` : ""}`),
		});
		re.lastIndex = close;
	}
	const alter = /alter\s+table\s+(?:only\s+)?([`"[\]\w.]+)[\s\S]*?foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)/gi;
	while ((m = alter.exec(text))) {
		relations.push({ from: `table:${lastPart(m[1])}`, to: `table:${lastPart(m[3])}`, kind: "fk", label: unquote(m[2].split(",")[0]) });
	}
}

function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of s) {
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

function prismaModels(f: SourceFile, tables: Map<string, Entity>, relations: Relation[]) {
	const re = /^model\s+(\w+)\s*\{/gm;
	const blocks: { name: string; body: string; index: number; close: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(f.text))) {
		const open = m.index + m[0].length - 1;
		const close = matchBracket(f.text, open);
		blocks.push({ name: m[1], body: f.text.slice(open + 1, close), index: m.index, close });
	}
	const names = new Set(blocks.map((b) => b.name));
	for (const b of blocks) {
		const details: string[] = [];
		for (const line of b.body.split("\n")) {
			const fm = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
			if (!fm || line.trim().startsWith("@@") || line.trim().startsWith("//")) continue;
			const [, field, type, list, opt, attrs] = fm;
			if (names.has(type)) {
				const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(attrs);
				if (rel) relations.push({ from: `table:${b.name}`, to: `table:${type}`, kind: "fk", label: rel[1].trim() });
				else if (!list) {
					// back-reference without fields is the other side of a 1:1; skip
				}
				details.push(`${field}: ${type}${list ?? ""}${opt ?? ""} (relation)`);
				continue;
			}
			details.push(`${/@id\b/.test(attrs) ? "PK " : ""}${field}: ${type}${list ?? ""}${opt ?? ""}${/@unique\b/.test(attrs) ? " unique" : ""}`);
		}
		tables.set(b.name, { id: `table:${b.name}`, kind: "table", name: b.name, file: f.path, line: lineAt(f.text, b.index), endLine: lineAt(f.text, b.close), details });
	}
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function infrastructure(files: SourceFile[]): Omit<Analysis, "kind" | "fileCount"> {
	const entities: Entity[] = [];
	const relations: Relation[] = [];
	const notes: string[] = [];
	const tf = files.filter((f) => /\.tf$/i.test(f.path));
	if (tf.length) terraform(tf, entities, relations);
	for (const f of files.filter((x) => /\.ya?ml$/i.test(x.path))) {
		let docs: any[];
		try {
			docs = yaml.safeLoadAll(f.text).filter((d) => d && typeof d === "object");
		} catch (e: any) {
			notes.push(`${f.path}: YAML parse error (${String(e?.message ?? e).split("\n")[0]})`);
			continue;
		}
		if (docs.length === 1 && docs[0].services && typeof docs[0].services === "object" && !docs[0].kind) compose(f, docs[0], entities, relations);
		else kubernetes(f, docs, entities, relations);
	}
	return { entities, relations, notes };
}

function terraform(files: SourceFile[], entities: Entity[], relations: Relation[]) {
	const blocks: { e: Entity; body: string; ref: string }[] = [];
	for (const f of files) {
		const re = /^(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(f.text))) {
			const open = m.index + m[0].length - 1;
			const close = matchBracket(f.text, open);
			const body = f.text.slice(open + 1, close);
			const type = m[1] === "module" ? "module" : m[2];
			const name = m[1] === "module" ? m[2] : m[3] ?? "";
			const ref = m[1] === "module" ? `module.${name}` : m[1] === "data" ? `data.${type}.${name}` : `${type}.${name}`;
			const source = /\bsource\s*=\s*"([^"]+)"/.exec(body)?.[1];
			blocks.push({
				e: {
					id: `tf:${ref}`,
					kind: m[1] === "module" ? "module" : m[1] === "data" ? `data ${type}` : type,
					name: name || type,
					file: f.path,
					line: lineAt(f.text, m.index),
					endLine: lineAt(f.text, close),
					details: [m[1] === "module" ? `source: ${source ?? "?"}` : `${m[1]} ${type}`],
					group: type.split("_")[0],
				},
				body,
				ref,
			});
			re.lastIndex = close;
		}
	}
	const refs = new Map(blocks.map((b) => [b.ref, b.e.id]));
	for (const b of blocks) {
		entities.push(b.e);
		const seen = new Set<string>();
		for (const m of b.body.matchAll(/\b(module\.[\w-]+|data\.[\w-]+\.[\w-]+|[a-z][\w-]*_[\w-]+\.[\w-]+)/g)) {
			const target = refs.get(m[1]);
			if (target && target !== b.e.id && !seen.has(target)) {
				seen.add(target);
				relations.push({ from: b.e.id, to: target, kind: "references" });
			}
		}
	}
}

function lineOf(text: string, needle: RegExp): number {
	const m = needle.exec(text);
	return m ? lineAt(text, m.index) : 1;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compose(f: SourceFile, doc: any, entities: Entity[], relations: Relation[]) {
	for (const [name, svc] of Object.entries<any>(doc.services)) {
		const s = svc ?? {};
		const details = [
			s.image ? `image: ${s.image}` : s.build ? `build: ${typeof s.build === "string" ? s.build : s.build.context ?? "."}` : undefined,
			...(Array.isArray(s.ports) ? s.ports.slice(0, 4).map((p: any) => `port ${typeof p === "object" ? `${p.published ?? ""}:${p.target}` : p}`) : []),
			...(Array.isArray(s.volumes) ? s.volumes.slice(0, 3).map((v: any) => `volume ${typeof v === "object" ? v.source : String(v).split(":")[0]}`) : []),
		].filter(Boolean) as string[];
		const networks = Array.isArray(s.networks) ? s.networks : s.networks ? Object.keys(s.networks) : [];
		entities.push({
			id: `svc:${name}`,
			kind: "service",
			name,
			file: f.path,
			line: lineOf(f.text, new RegExp(`^\\s+${escapeRe(name)}:`, "m")),
			details,
			group: networks[0],
		});
		const deps = Array.isArray(s.depends_on) ? s.depends_on : s.depends_on ? Object.keys(s.depends_on) : [];
		for (const d of [...deps, ...(Array.isArray(s.links) ? s.links.map((l: string) => l.split(":")[0]) : [])]) {
			relations.push({ from: `svc:${name}`, to: `svc:${d}`, kind: "depends on" });
		}
	}
}

function kubernetes(f: SourceFile, docs: any[], entities: Entity[], relations: Relation[]) {
	const items = docs.flatMap((d) => (d.kind === "List" && Array.isArray(d.items) ? d.items : [d])).filter((d) => d.kind && d.metadata?.name);
	const id = (kind: string, name: string, ns?: string) => `k8s:${ns ?? "default"}/${kind}/${name}`;
	const podSpec = (d: any) => d.spec?.template?.spec ?? d.spec?.jobTemplate?.spec?.template?.spec ?? (d.kind === "Pod" ? d.spec : undefined);
	const podLabels = (d: any) => d.spec?.template?.metadata?.labels ?? (d.kind === "Pod" ? d.metadata.labels : undefined);
	for (const d of items) {
		const ns = d.metadata.namespace;
		const spec = podSpec(d);
		const details = [
			...(spec?.containers ?? []).slice(0, 3).map((c: any) => `container ${c.name}: ${c.image ?? "?"}`),
			d.spec?.replicas != null ? `replicas: ${d.spec.replicas}` : undefined,
			d.kind === "Service" ? `type: ${d.spec?.type ?? "ClusterIP"}${(d.spec?.ports ?? []).length ? `, ports ${(d.spec.ports as any[]).map((p) => p.port).join("/")}` : ""}` : undefined,
		].filter(Boolean) as string[];
		entities.push({
			id: id(d.kind, d.metadata.name, ns),
			kind: d.kind,
			name: d.metadata.name,
			file: f.path,
			line: lineOf(f.text, new RegExp(`^\\s*name:\\s*["']?${escapeRe(d.metadata.name)}["']?\\s*$`, "m")),
			details,
			group: ns ?? "default",
		});
		if (spec) {
			const refs = new Set<string>();
			for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
				for (const e of c.envFrom ?? []) {
					if (e.configMapRef?.name) refs.add(id("ConfigMap", e.configMapRef.name, ns));
					if (e.secretRef?.name) refs.add(id("Secret", e.secretRef.name, ns));
				}
				for (const e of c.env ?? []) {
					if (e.valueFrom?.configMapKeyRef?.name) refs.add(id("ConfigMap", e.valueFrom.configMapKeyRef.name, ns));
					if (e.valueFrom?.secretKeyRef?.name) refs.add(id("Secret", e.valueFrom.secretKeyRef.name, ns));
				}
			}
			for (const v of spec.volumes ?? []) {
				if (v.configMap?.name) refs.add(id("ConfigMap", v.configMap.name, ns));
				if (v.secret?.secretName) refs.add(id("Secret", v.secret.secretName, ns));
				if (v.persistentVolumeClaim?.claimName) refs.add(id("PersistentVolumeClaim", v.persistentVolumeClaim.claimName, ns));
			}
			refs.forEach((r) => relations.push({ from: id(d.kind, d.metadata.name, ns), to: r, kind: "uses" }));
		}
	}
	for (const svc of items.filter((d) => d.kind === "Service" && d.spec?.selector)) {
		for (const d of items) {
			const labels = podLabels(d);
			if (!labels || (d.metadata.namespace ?? "default") !== (svc.metadata.namespace ?? "default")) continue;
			if (Object.entries<string>(svc.spec.selector).every(([k, v]) => labels[k] === v)) {
				relations.push({ from: id("Service", svc.metadata.name, svc.metadata.namespace), to: id(d.kind, d.metadata.name, d.metadata.namespace), kind: "selects" });
			}
		}
	}
	for (const ing of items.filter((d) => d.kind === "Ingress")) {
		const backends = new Set<string>();
		const add = (b: any) => {
			const name = b?.service?.name ?? b?.serviceName;
			if (name) backends.add(name);
		};
		add(ing.spec?.defaultBackend ?? ing.spec?.backend);
		for (const r of ing.spec?.rules ?? []) for (const p of r.http?.paths ?? []) add(p.backend);
		backends.forEach((b) => relations.push({ from: id("Ingress", ing.metadata.name, ing.metadata.namespace), to: id("Service", b, ing.metadata.namespace), kind: "routes to" }));
	}
	for (const hpa of items.filter((d) => d.kind === "HorizontalPodAutoscaler" && d.spec?.scaleTargetRef)) {
		relations.push({ from: id(hpa.kind, hpa.metadata.name, hpa.metadata.namespace), to: id(hpa.spec.scaleTargetRef.kind, hpa.spec.scaleTargetRef.name, hpa.metadata.namespace), kind: "scales" });
	}
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const GUIDANCE: Record<DiagramKind, string> = {
	dependencies:
		"Draw a module dependency diagram: one rounded rectangle per entity (label = name), containers per `group` (folder), an arrow from importer to imported module, then run a hierarchical layout. Highlight import cycles (red edges) if notes list any.",
	classes:
		"Draw a UML class diagram: one class box per entity with its members as rows (use drawio_search_shapes \"uml class\" and insertXml, or a swimlane container with stackLayout child rows). Interfaces get «interface» in the header. extends = solid line with hollow triangle (endArrow=block;endFill=0), implements = dashed with hollow triangle, association = open arrow. Lay out inheritance top-down.",
	erd:
		"Draw an entity-relationship diagram: one table per entity with its columns as rows (PK/FK marked), e.g. a swimlane container (childLayout=stackLayout) or a draw.io ER table from drawio_search_shapes \"er table\". Relations use edgeStyle=entityRelationEdgeStyle with crow's-foot ends (endArrow=ERmandOne on the referenced table, startArrow=ERmany on the referencing table), labelled with the FK column.",
	infrastructure:
		"Draw an infrastructure diagram: use vendor icons from drawio_search_shapes (e.g. \"aws rds\", \"kubernetes deployment\", \"docker container\", \"azure app service\") labelled with the entity name; put entities into containers per `group` (namespace / network / provider); arrows show traffic or dependency direction with the relation kind as a short label.",
};

export function formatAnalysis(a: Analysis, maxChars = 60000): string {
	const refOf = new Map(a.entities.map((e, i) => [e.id, `e${i + 1}`]));
	const relations = a.relations.filter((r) => refOf.has(r.from) && refOf.has(r.to));
	const payload = (detailLimit: number) =>
		JSON.stringify({
			entities: a.entities.map((e) => ({
				codeRef: refOf.get(e.id),
				kind: e.kind,
				name: e.name,
				group: e.group,
				file: `${e.file}:${e.line}`,
				details: e.details?.slice(0, detailLimit),
			})),
			relations: relations.map((r) => ({ from: refOf.get(r.from), to: refOf.get(r.to), kind: r.kind, label: r.label })),
		});
	let json = payload(MAX_MEMBERS);
	for (const limit of [6, 3, 0]) if (json.length > maxChars) json = payload(limit);
	if (json.length > maxChars) json = json.slice(0, maxChars) + "…(truncated)";
	return [
		`Static analysis of ${a.fileCount} file${a.fileCount === 1 ? "" : "s"} (${a.kind}): ${a.entities.length} entities, ${relations.length} relations.`,
		...a.notes,
		"",
		`How to draw it: ${GUIDANCE[a.kind]}`,
		'Give the shape for each entity `data: {"codeRef": "<its codeRef>"}` so it is linked to the source afterwards (double-click jumps to the code). The active design template, if any, overrides the style hints above.',
		"",
		json,
	].join("\n");
}

/** Maps codeRef → entity (for linking shapes back to the source). */
export function codeRefs(a: Analysis): Map<string, Entity> {
	return new Map(a.entities.map((e, i) => [`e${i + 1}`, e]));
}
