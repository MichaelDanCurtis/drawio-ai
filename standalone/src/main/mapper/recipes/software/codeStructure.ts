/**
 * Module dependency graph and class diagram of a code base. Imports are resolved
 * per language (JS/TS, Python, Go, Java/Kotlin); classes come from the
 * extension's static analyzer (src/features/ai/codeAnalysis.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { agentRequest, digDeeperRequest, FOLDER_FIELD, folderInput, readFiles, slug, type FoundFile } from "../common";
import type { CollectResult, FieldDef, MapEdge, MapGraph, MapNode, MapRow, Recipe } from "../../types";
import { isOn, STYLE } from "./shared";

// The analyzer lives in the extension's sources. It is loaded with require() so the
// bundler includes it while the app's type-check does not pull in its js-yaml 3 calls.
interface CaEntity {
	id: string;
	kind: string;
	name: string;
	file: string;
	line: number;
	endLine?: number;
	details?: string[];
	group?: string;
}
interface CaAnalysis {
	entities: CaEntity[];
	relations: { from: string; to: string; kind: string; label?: string }[];
	notes: string[];
	fileCount: number;
}
interface CodeAnalysisModule {
	analyze(files: { path: string; text: string }[], kind: "classes" | "dependencies"): CaAnalysis;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const codeAnalysis: CodeAnalysisModule = require("../../../../../../src/features/ai/codeAnalysis");

const CODE_RE = /\.(tsx?|jsx?|mjs|cjs|py|go|java|kt|cs)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|__mocks__|testdata|examples?|samples?)(\/|$)|\.(test|spec|stories)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const SKIP_RE = /(^|\/)(vendor|third_party|thirdparty|bower_components|jspm_packages|generated|__generated__|migrations)(\/|$)|\.min\.js$|\.bundle\.js$|-bundle\.js$|\.d\.ts$|\.(pb|g|generated|designer)\.\w+$/i;
export const MAX_NODES = 150;

const TESTS_FIELD: FieldDef = { id: "includeTests", label: "Include tests and examples", type: "checkbox", default: "" };

export function readSources(root: string, includeTests: boolean, maxFiles = 6000): { files: FoundFile[]; capped: boolean } {
	let n = 0;
	let capped = false;
	const files = readFiles(root, {
		maxFiles: maxFiles + 1,
		maxBytes: 400_000,
		match: (rel) => {
			if (!CODE_RE.test(rel) || SKIP_RE.test(rel) || (!includeTests && TEST_RE.test(rel))) return false;
			if (++n > maxFiles) {
				capped = true;
				return false;
			}
			return true;
		},
	});
	return { files, capped };
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const normalize = (p: string) => {
	const out: string[] = [];
	for (const part of p.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
};

// ----- module dependencies -----

export interface ModuleDeps {
	/** Node id → file (or Go package folder). */
	modules: Map<string, { file: string; lang: string }>;
	edges: Map<string, Set<string>>;
	externals: Map<string, number>;
	unresolved: number;
	languages: Map<string, number>;
}

export function moduleDependencies(files: FoundFile[]): ModuleDeps {
	const modules = new Map<string, { file: string; lang: string }>();
	const edges = new Map<string, Set<string>>();
	const externals = new Map<string, number>();
	const languages = new Map<string, number>();
	let unresolved = 0;
	const paths = new Set(files.map((f) => f.rel));
	const langOf = (rel: string) => (/\.(tsx?|jsx?|mjs|cjs)$/i.test(rel) ? "js" : /\.py$/i.test(rel) ? "py" : /\.go$/i.test(rel) ? "go" : /\.(java|kt)$/i.test(rel) ? "java" : "cs");
	const idOf = (rel: string) => (langOf(rel) === "go" ? `go:${dirOf(rel) || "."}` : rel);
	for (const f of files) {
		const lang = langOf(f.rel);
		languages.set(lang, (languages.get(lang) ?? 0) + 1);
		const id = idOf(f.rel);
		if (!modules.has(id)) modules.set(id, { file: lang === "go" ? dirOf(f.rel) || "." : f.rel, lang });
	}
	const ext = (name: string) => externals.set(name, (externals.get(name) ?? 0) + 1);

	// JS / TS
	const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
	const resolveJs = (from: string, spec: string): string | undefined => {
		const tryBase = (base: string) => {
			const stripped = base.replace(/\.(m|c)?js$/, "");
			for (const cand of [base, ...[stripped, `${stripped}/index`].flatMap((b) => JS_EXTS.map((e) => b + e))]) if (paths.has(cand)) return cand;
			return undefined;
		};
		if (spec.startsWith(".")) return tryBase(normalize(`${dirOf(from)}/${spec}`));
		// Root-relative or "@/x" / "~/x" aliases to a src folder.
		const alias = /^[@~]\//.test(spec) ? spec.slice(2) : spec;
		const hit = tryBase(normalize(alias)) ?? tryBase(normalize(`src/${alias}`));
		if (hit) return hit;
		if (!spec.startsWith("node:") && !/^[@~]\//.test(spec)) ext(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
		return undefined;
	};
	// Python: dotted suffixes → files
	const pySuffix = new Map<string, string[]>();
	for (const f of files.filter((x) => x.rel.endsWith(".py"))) {
		const parts = f.rel.replace(/\.py$/, "").split("/");
		if (parts[parts.length - 1] === "__init__") parts.pop();
		for (let k = 0; k < parts.length; k++) {
			const key = parts.slice(k).join(".");
			pySuffix.set(key, [...(pySuffix.get(key) ?? []), f.rel]);
		}
	}
	const closest = (from: string, cands: string[]) => {
		const score = (c: string) => {
			const a = from.split("/");
			const b = c.split("/");
			let i = 0;
			while (i < a.length && i < b.length && a[i] === b[i]) i++;
			return i;
		};
		return [...cands].sort((x, y) => score(y) - score(x))[0];
	};
	const resolvePy = (from: string, dots: string, mod: string): string | undefined => {
		if (dots) {
			let base = dirOf(from);
			for (let i = 1; i < dots.length; i++) base = dirOf(base);
			const rel = mod.replace(/\./g, "/");
			for (const c of [`${base}/${rel}.py`, `${base}/${rel}/__init__.py`].map(normalize)) if (paths.has(c)) return c;
			return undefined;
		}
		const parts = mod.split(".");
		for (let n = parts.length; n > 0; n--) {
			const cands = pySuffix.get(parts.slice(0, n).join("."));
			if (cands?.length) return closest(from, cands);
		}
		ext(parts[0]);
		return undefined;
	};
	// Go: module path → folder
	const goModules = files.length ? goModulePaths(files) : [];
	// Java / Kotlin: fully qualified names → files
	const fqn = new Map<string, string>();
	const packages = new Map<string, string[]>();
	for (const f of files.filter((x) => /\.(java|kt)$/i.test(x.rel))) {
		const pkg = /^\s*package\s+([\w.]+)/m.exec(f.text)?.[1] ?? "";
		const cls = f.rel.split("/").pop()!.replace(/\.(java|kt)$/i, "");
		fqn.set(pkg ? `${pkg}.${cls}` : cls, f.rel);
		packages.set(pkg, [...(packages.get(pkg) ?? []), f.rel]);
	}

	for (const f of files) {
		const lang = langOf(f.rel);
		const from = idOf(f.rel);
		const deps = edges.get(from) ?? new Set<string>();
		const add = (target: string | undefined) => {
			if (target === undefined) return;
			const to = idOf(target);
			if (to !== from) deps.add(to);
		};
		if (lang === "js") {
			for (const m of f.text.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
				const spec = m[1] ?? m[2] ?? m[3];
				const t = resolveJs(f.rel, spec);
				if (t) add(t);
				else if (spec.startsWith(".")) unresolved++;
			}
		} else if (lang === "py") {
			for (const line of f.text.split("\n")) {
				const fm = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)/.exec(line);
				if (fm) {
					const t = resolvePy(f.rel, fm[1], fm[2]);
					if (t) add(t);
					else if (fm[1] && !fm[2]) for (const n of fm[3].replace(/[()]/g, "").split(",")) add(resolvePy(f.rel, fm[1], n.trim().split(/\s+/)[0]));
					continue;
				}
				const im = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(line);
				if (im) for (const mod of im[1].split(",")) add(resolvePy(f.rel, "", mod.trim()));
			}
		} else if (lang === "go") {
			for (const m of f.text.matchAll(/^import\s*\(([\s\S]*?)\)|^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) {
				const specs = m[2] ? [m[2]] : [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]);
				for (const spec of specs) {
					const mod = goModules.find((g) => spec === g.module || spec.startsWith(`${g.module}/`));
					if (mod) {
						const dir = normalize(`${mod.dir}/${spec.slice(mod.module.length)}`) || ".";
						if (modules.has(`go:${dir}`) && `go:${dir}` !== from) deps.add(`go:${dir}`);
					} else if (spec.includes(".")) ext(spec.split("/").slice(0, 3).join("/"));
				}
			}
		} else if (lang === "java") {
			for (const m of f.text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?/gm)) {
				if (m[2]) (packages.get(m[1]) ?? []).slice(0, 12).forEach(add);
				else {
					let name = m[1];
					let hit = fqn.get(name);
					while (!hit && name.includes(".")) {
						name = name.slice(0, name.lastIndexOf("."));
						hit = fqn.get(name);
					}
					if (hit) add(hit);
					else ext(m[1].split(".").slice(0, 2).join("."));
				}
			}
		}
		edges.set(from, deps);
	}
	return { modules, edges, externals, unresolved, languages };
}

function goModulePaths(files: FoundFile[]): { module: string; dir: string }[] {
	const out: { module: string; dir: string }[] = [];
	// go.mod files are not code files: read them from the folders we can see.
	const seen = new Set<string>();
	const tryDir = (absRoot: string, rel: string) => {
		if (seen.has(rel)) return;
		seen.add(rel);
		try {
			const text = fs.readFileSync(path.join(absRoot, rel, "go.mod"), "utf8");
			const mod = /^module\s+(\S+)/m.exec(text)?.[1];
			if (mod) out.push({ module: mod, dir: rel });
		} catch {
			// no go.mod here
		}
	};
	const any = files.find((f) => f.rel.endsWith(".go"));
	if (!any) return out;
	const absRoot = any.abs.slice(0, any.abs.length - any.rel.length);
	tryDir(absRoot, "");
	for (const f of files.filter((x) => x.rel.endsWith(".go"))) for (let d = dirOf(f.rel); d; d = dirOf(d)) tryDir(absRoot, d);
	return out.sort((a, b) => b.module.length - a.module.length);
}

/** Strongly connected components with more than one member (import cycles). */
export function cycleMembers(edges: Map<string, Set<string>>): Map<string, number> {
	let index = 0;
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const on = new Set<string>();
	const comp = new Map<string, number>();
	let compId = 0;
	const nodes = new Set([...edges.keys(), ...[...edges.values()].flatMap((s) => [...s])]);
	// Iterative Tarjan (deep import chains would overflow the stack).
	for (const start of nodes) {
		if (idx.has(start)) continue;
		const work: [string, string[], number][] = [[start, [...(edges.get(start) ?? [])], 0]];
		idx.set(start, index);
		low.set(start, index++);
		stack.push(start);
		on.add(start);
		while (work.length) {
			const frame = work[work.length - 1];
			const [v, succ] = frame;
			if (frame[2] < succ.length) {
				const w = succ[frame[2]++];
				if (!idx.has(w)) {
					idx.set(w, index);
					low.set(w, index++);
					stack.push(w);
					on.add(w);
					work.push([w, [...(edges.get(w) ?? [])], 0]);
				} else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1][0];
				low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
			}
			if (low.get(v) === idx.get(v)) {
				const members: string[] = [];
				let w: string;
				do {
					w = stack.pop()!;
					on.delete(w);
					members.push(w);
				} while (w !== v);
				if (members.length > 1) {
					compId++;
					members.forEach((m) => comp.set(m, compId));
				}
			}
		}
	}
	return comp;
}

/** Builds the module map: files in folder containers, or folders when there are too many files. */
export function modulesToGraph(deps: ModuleDeps, name: string, maxNodes = MAX_NODES): { graph: MapGraph; level: string; cycles: number } {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	let level = "file";
	let groupOf = (id: string) => id;
	if (deps.modules.size > maxNodes) {
		// Aggregate to folders, at the deepest level that stays under the cap.
		const folders = [...deps.modules.values()].map((m) => (m.lang === "go" ? m.file : dirOf(m.file) || "."));
		let depth = Math.max(...folders.map((f) => f.split("/").length));
		const cut = (f: string, d: number) => (f === "." ? "." : f.split("/").slice(0, d).join("/"));
		while (depth > 1 && new Set(folders.map((f) => cut(f, depth))).size > maxNodes) depth--;
		const byId = new Map([...deps.modules].map(([id, m]) => [id, cut(m.lang === "go" ? m.file : dirOf(m.file) || ".", depth)]));
		groupOf = (id) => `dir:${byId.get(id) ?? id}`;
		level = `folder (depth ${depth})`;
	}
	const counts = new Map<string, number>();
	const members = new Map<string, number>();
	for (const id of deps.modules.keys()) members.set(groupOf(id), (members.get(groupOf(id)) ?? 0) + 1);
	const agg = new Map<string, Set<string>>();
	for (const [from, tos] of deps.edges) {
		for (const to of tos) {
			const a = groupOf(from);
			const b = groupOf(to);
			if (a === b) continue;
			const k = `${a}\u0000${b}`;
			counts.set(k, (counts.get(k) ?? 0) + 1);
			if (!agg.has(a)) agg.set(a, new Set());
			agg.get(a)!.add(b);
		}
	}
	const cycles = cycleMembers(agg);
	const containers = new Set<string>();
	const container = (dir: string) => {
		const id = `folder:${dir || "."}`;
		if (!containers.has(id)) {
			containers.add(id);
			nodes.push({ id, label: dir || "(root)", kind: "software:folder", container: true, style: STYLE.folder, data: { folder: dir || "." } });
		}
		return id;
	};
	if (level === "file") {
		for (const [id, m] of deps.modules) {
			const dir = m.lang === "go" ? dirOf(m.file === "." ? "" : m.file) : dirOf(m.file);
			const label = m.lang === "go" ? `${m.file.split("/").pop()} (package)` : m.file.split("/").pop()!;
			nodes.push({ id, label, kind: "software:module", parent: container(dir), style: STYLE.module, height: 36, data: { file: m.file, language: m.lang, ...(cycles.has(id) ? { cycle: String(cycles.get(id)) } : {}) } });
		}
	} else {
		const tops = new Set([...members.keys()].map((g) => g.slice(4).split("/")[0]));
		for (const [g, n] of members) {
			const folder = g.slice(4);
			const top = folder.split("/")[0];
			const parent = tops.size > 1 && folder.includes("/") ? container(top) : undefined;
			const label = parent ? folder.slice(top.length + 1) : folder === "." ? "(root)" : folder;
			nodes.push({ id: g, label: `${label}\n${n} module${n === 1 ? "" : "s"}`, kind: "software:folder", parent, style: STYLE.folderNode, height: 52, data: { folder, modules: String(n), ...(cycles.has(g) ? { cycle: String(cycles.get(g)) } : {}) } });
		}
	}
	for (const [k, n] of counts) {
		const [a, b] = k.split("\u0000");
		const inCycle = cycles.has(a) && cycles.get(a) === cycles.get(b);
		edges.push({ from: a, to: b, label: level === "file" || n === 1 ? undefined : String(n), kind: "imports", style: inCycle ? STYLE.edgeCycle : STYLE.edge });
	}
	return { graph: { title: `Modules · ${name}`, nodes, edges, direction: "down" }, level, cycles: new Set(cycles.values()).size };
}

export const modulesRecipe: Recipe = {
	id: "software.modules",
	category: "software",
	title: "Module dependencies",
	description: "Which modules import which (JS/TS, Python, Go, Java/Kotlin), grouped by folder; import cycles in red. Large code bases are shown per folder.",
	mode: "inventory",
	fields: [FOLDER_FIELD, TESTS_FIELD],
	async collect(input, ctx): Promise<CollectResult> {
		const root = folderInput(input, ctx.cwd);
		const started = Date.now();
		ctx.progress("Reading the code…");
		const { files, capped } = readSources(root, isOn(input.includeTests));
		const warnings = capped ? [`Only the first ${files.length} code files were read; map a sub-folder for full detail.`] : [];
		if (!files.length) return { summary: `No code files (JS/TS, Python, Go, Java, Kotlin, C#) in ${root}.`, warnings };
		ctx.progress(`Resolving imports of ${files.length} files…`);
		const deps = moduleDependencies(files);
		const name = path.basename(root);
		const { graph, level, cycles } = modulesToGraph(deps, name);
		const edgeCount = [...deps.edges.values()].reduce((a, s) => a + s.size, 0);
		const ext = [...deps.externals].sort((a, b) => b[1] - a[1]).slice(0, 15);
		if (deps.languages.get("cs")) warnings.push("C# files are counted but their `using` namespaces are not resolved to files.");
		graph.legend = [
			`Modules of ${name}: ${deps.modules.size} module(s), ${edgeCount} internal import(s), drawn per ${level}.`,
			cycles ? `${cycles} import cycle(s): red arrows.` : "No import cycles found.",
			ext.length ? `Most used packages: ${ext.slice(0, 8).map(([p, n]) => `${p} (${n})`).join(", ")}` : "",
		].filter(Boolean);
		const facts = [
			`# Module dependencies of ${name}`,
			`${deps.modules.size} modules (${[...deps.languages].map(([l, n]) => `${n} ${l}`).join(", ")}), ${edgeCount} internal imports, drawn per ${level}. ${deps.unresolved} relative imports could not be resolved.`,
			ext.length ? `External packages by use: ${ext.map(([p, n]) => `${p} (${n})`).join(", ")}` : "",
			"",
			"## Imports (module → modules it imports)",
			...[...deps.edges]
				.filter(([, s]) => s.size)
				.slice(0, 600)
				.map(([from, tos]) => `- ${from} → ${[...tos].slice(0, 20).join(", ")}${tos.size > 20 ? ` … +${tos.size - 20}` : ""}`),
		].join("\n");
		return { graph, summary: `${deps.modules.size} modules, ${edgeCount} imports, ${cycles} cycle(s) (${Date.now() - started} ms)`, warnings, facts };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"Explain the architecture shown by this module map: name the layers or components (e.g. UI, domain, data access, infrastructure) and group or colour the folders accordingly, point out dependencies that go the wrong way and the import cycles (red), and add a short note on how the main parts fit together. Read the code where the names are not enough.",
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest("modules / folders (read their code: what they export and who uses it)", shapes, question || "What does this module do, what depends on it and what does it depend on?"),
};

// ----- classes -----

const CLASS_STYLE: Record<string, string> = {
	class: STYLE.table("#dae8fc", "#6c8ebf"),
	interface: STYLE.table("#d5e8d4", "#82b366"),
	enum: STYLE.table("#fff2cc", "#d6b656"),
};

const INHERIT_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;startArrow=block;startFill=0;startSize=10;endArrow=none;strokeColor=#374151;";

/** Class diagram from the analyzer's entities: types as tables with their members, inheritance and associations. */
export function classesToGraph(a: CaAnalysis, name: string, maxNodes = MAX_NODES): { graph: MapGraph; shown: number; total: number } {
	const degree = new Map<string, number>();
	for (const r of a.relations) {
		degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
		degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
	}
	let entities = a.entities;
	if (entities.length > maxNodes) {
		entities = [...entities].sort((x, y) => (degree.get(y.id) ?? 0) - (degree.get(x.id) ?? 0) || (y.details?.length ?? 0) - (x.details?.length ?? 0)).slice(0, maxNodes);
	}
	const keep = new Set(entities.map((e) => e.id));
	const nodes: MapNode[] = [];
	const folders = new Set<string>();
	for (const e of entities) {
		const dir = dirOf(e.file);
		const folderId = `folder:${dir || "."}`;
		if (!folders.has(folderId)) {
			folders.add(folderId);
			nodes.push({ id: folderId, label: dir || "(root)", kind: "software:folder", container: true, style: STYLE.folder, data: { folder: dir || "." } });
		}
		const rows: MapRow[] = (e.details ?? []).map((d) => {
			const m = /^(.*?\))\s*:\s*(.+)$/.exec(d) ?? /^([+\-#]?[\w$#]+)\s*:\s*(.+)$/.exec(d);
			return m ? { text: m[1].slice(0, 60), detail: m[2].slice(0, 40) } : { text: d.slice(0, 70) };
		});
		const stereo = e.kind === "interface" ? "«interface» " : e.kind === "enum" ? "«enum» " : "";
		nodes.push({
			id: slug(e.id),
			label: `${stereo}${e.name}`,
			kind: `software:${e.kind}`,
			parent: folderId,
			shape: "table",
			style: CLASS_STYLE[e.kind] ?? CLASS_STYLE.class,
			rows,
			data: { file: e.file, line: String(e.line), type: e.kind },
		});
	}
	const edges: MapEdge[] = [];
	for (const r of a.relations) {
		if (!keep.has(r.from) || !keep.has(r.to)) continue;
		if (r.kind === "extends" || r.kind === "implements") {
			// Drawn base → derived so the base sits above; the hollow triangle is at the base.
			edges.push({ from: slug(r.to), to: slug(r.from), kind: r.kind, style: r.kind === "implements" ? INHERIT_STYLE + "dashed=1;" : INHERIT_STYLE });
		} else edges.push({ from: slug(r.from), to: slug(r.to), kind: r.kind, style: STYLE.association });
	}
	return { graph: { title: `Classes · ${name}`, nodes, edges, direction: "down" }, shown: entities.length, total: a.entities.length };
}

export const classesRecipe: Recipe = {
	id: "software.classes",
	category: "software",
	title: "Class diagram",
	description: "Classes, interfaces and enums with their members, inheritance and associations (TypeScript/JavaScript, Python, Java, Kotlin, C#, Go), grouped by folder. Large code bases show the most connected types.",
	mode: "inventory",
	fields: [FOLDER_FIELD, TESTS_FIELD],
	async collect(input, ctx): Promise<CollectResult> {
		const root = folderInput(input, ctx.cwd);
		const started = Date.now();
		ctx.progress("Reading the code…");
		const { files, capped } = readSources(root, isOn(input.includeTests), 4000);
		const warnings = capped ? [`Only the first ${files.length} code files were read; map a sub-folder for full detail.`] : [];
		ctx.progress(`Finding classes in ${files.length} files…`);
		const analysis = codeAnalysis.analyze(
			files.map((f) => ({ path: f.rel, text: f.text })),
			"classes"
		);
		const name = path.basename(root);
		if (!analysis.entities.length) return { summary: `No classes, interfaces or enums found in ${files.length} code file(s).`, warnings };
		const { graph, shown, total } = classesToGraph(analysis, name);
		if (shown < total) warnings.push(`${total} types found; the ${shown} most connected are drawn. Map a sub-folder to see the rest.`);
		graph.legend = [
			`Classes of ${name}: ${shown}${shown < total ? ` of ${total}` : ""} type(s) in ${new Set(graph.nodes.filter((n) => n.kind === "software:folder").map((n) => n.id)).size} folder(s).`,
			"Blue: classes, green: interfaces, yellow: enums. Hollow triangles: inheritance (dashed = implements). Open arrows: associations (field types).",
		];
		const facts = [
			`# Classes of ${name}`,
			`${total} types in ${files.length} files${shown < total ? `; ${shown} drawn` : ""}.`,
			...analysis.notes,
			"",
			...analysis.entities.slice(0, 400).map((e) => `- ${e.kind} ${e.name} — ${e.file}:${e.line}${e.details?.length ? `: ${e.details.slice(0, 8).join("; ")}` : ""}`),
			"",
			"## Relations",
			...analysis.relations.slice(0, 600).map((r) => `- ${r.from.replace(/^type:/, "")} ${r.kind} ${r.to.replace(/^type:/, "")}`),
		].join("\n");
		return { graph, summary: `${total} types, ${analysis.relations.length} relations (${Date.now() - started} ms)`, warnings, facts };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"Review the class diagram on this page: add a one-line note of responsibility to the key classes, name the design patterns you recognise, and add relations the static analysis missed (dependencies through constructors or method parameters, factories, composition). Read the code (file:line in the facts) instead of guessing.",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("classes (read their source at the file and line on each shape)", shapes, question || "What is this class responsible for, who uses it and how?"),
};
