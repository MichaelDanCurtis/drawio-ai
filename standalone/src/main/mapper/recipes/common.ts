import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";
import { parseRepository, repositoryLabel } from "../repository";
import type { CollectContext, FieldDef, MapInput } from "../types";
import { MapperError } from "../types";

/**
 * YAML as the Mapper reads it: js-yaml's core schema, which only ever builds plain data, plus
 * merge keys (`<<: *common`). Compose files, Kubernetes manifests and pipeline definitions
 * lean on them: without, a service built on an anchor loses its image and what it depends on.
 */
export const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);

/** One YAML document. */
export function loadYaml(text: string): any {
	return yaml.load(text, { schema: YAML_SCHEMA });
}

/** Every document of a YAML file (`---` between them). */
export function loadYamlAll(text: string): any[] {
	return yaml.loadAll(text, { schema: YAML_SCHEMA }) as any[];
}

/** Folders never worth reading when mapping a repository. */
export const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"out",
	"build",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"bin",
	"obj",
	".next",
	".terraform",
	"coverage",
	".idea",
	".vscode",
	".gradle",
	".mypy_cache",
	".pytest_cache",
	"site-packages",
]);

export interface WalkOptions {
	/** Files whose path (relative, with /) matches. */
	match: (rel: string) => boolean;
	maxFiles?: number;
	maxBytes?: number;
	maxDepth?: number;
	/** Also enter folders that start with a dot (e.g. .github). Default: only .github. */
	dotDirs?: (name: string) => boolean;
	/** A folder that is read although its name is one of build output (`rel`: its path below the root). */
	keepDir?: (rel: string) => boolean;
}

export interface FoundFile {
	/** Relative to the root, with forward slashes. */
	rel: string;
	abs: string;
	text: string;
}

/** Reads matching text files below `root`, skipping dependencies and build output. */
export function readFiles(root: string, opts: WalkOptions): FoundFile[] {
	const out: FoundFile[] = [];
	const maxFiles = opts.maxFiles ?? 2000;
	const maxBytes = opts.maxBytes ?? 1_000_000;
	const dotDirs = opts.dotDirs ?? ((n: string) => n === ".github");
	const walk = (dir: string, depth: number) => {
		if (out.length >= maxFiles || depth > (opts.maxDepth ?? 14)) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (out.length >= maxFiles) return;
			const abs = path.join(dir, e.name);
			if (e.isSymbolicLink()) continue;
			if (e.isDirectory()) {
				const kept = opts.keepDir && SKIP_DIRS.has(e.name) && opts.keepDir(path.relative(root, abs).split(path.sep).join("/"));
				if ((SKIP_DIRS.has(e.name) && !kept) || (e.name.startsWith(".") && !dotDirs(e.name))) continue;
				walk(abs, depth + 1);
			} else if (e.isFile()) {
				const rel = path.relative(root, abs).split(path.sep).join("/");
				if (!opts.match(rel)) continue;
				try {
					if (fs.statSync(abs).size > maxBytes) continue;
					out.push({ rel, abs, text: fs.readFileSync(abs, "utf8") });
				} catch {
					// unreadable: skip
				}
			}
		}
	};
	walk(root, 0);
	return out;
}

/** The folder a recipe maps: its `folder` field, else the diagram's folder. */
export function folderInput(input: MapInput, cwd: string, field = "folder"): string {
	const dir = (input[field] || cwd).trim();
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new MapperError(`${dir} is not a folder.`);
	return dir;
}

/**
 * A recipe's input with every repository in it downloaded: a field that takes a repository
 * (FieldDef.repository) and holds one, by its address or as owner/name, gets the folder the
 * repository was downloaded to, so that the recipe reads a folder as it always does. A folder of
 * that name on this computer wins: `docs/api` in the diagram's folder is a folder.
 */
export async function withRepositories(fields: FieldDef[], input: MapInput, ctx: CollectContext): Promise<{ input: MapInput; root?: string; source?: string }> {
	let out = input;
	let root: string | undefined;
	let source: string | undefined;
	for (const f of fields) {
		if (!f.repository) continue;
		const typed = (input[f.id] ?? "").trim();
		if (!typed) continue;
		const local = path.resolve(ctx.cwd, typed);
		if (fs.existsSync(local)) continue;
		const spec = parseRepository(typed);
		if (!spec) throw new MapperError(`${typed} is not a folder on this computer, and not a GitHub repository (its address, or owner/name).`);
		if (!ctx.repository) throw new MapperError(`${typed} looks like a GitHub repository, and repositories cannot be downloaded here. Clone it and choose its folder.`);
		const fetched = await ctx.repository(spec);
		out = { ...out, [f.id]: fetched.root };
		root ??= fetched.root;
		source ??= repositoryLabel(spec);
	}
	return { input: out, ...(root ? { root, source } : {}) };
}

export const FOLDER_FIELD: FieldDef = {
	id: "folder",
	label: "Repository or folder",
	type: "folder",
	required: true,
	repository: true,
	placeholder: "A folder, or a GitHub repository: owner/name or its address",
	help: "A folder is read where it is. A GitHub repository is downloaded first (its newest state, with the access to GitHub this computer already has) and read from the app's own folder. Nothing is uploaded except what you then send to the agent.",
};

/** Where the agent finds the diagram tools. The desktop app serves them as an MCP server; the VS Code extension names its own. */
let toolSource = 'of the "omnidraw" MCP server';

export function setToolSource(text: string): void {
	toolSource = text;
}

/** Shared rules for every request the Mapper sends to the agent. */
export function agentRules(): string {
	return [
		`Work ONLY through the drawio_* tools ${toolSource} to read and change the diagram; never edit diagram files on disk.`,
		"You may read files and run read-only inspection commands (list / describe / show / get / query) to investigate. NEVER run anything that creates, changes, deletes, deploys, restarts or costs money, and never print secrets.",
		"Shapes the Mapper drew carry data attributes (mapper, mapperKind, mapperId and source ids such as ARNs or resource ids): keep them, and give new shapes the same attributes where you can.",
		"Use proper icons (search the shape libraries with drawio_search_shapes) and keep the existing layout readable; add new shapes next to what they relate to.",
		"End with a short summary of what you found and what you changed on the map.",
	].join("\n- ");
}

/** A request for the agent with the facts attached, size-limited. */
export function agentRequest(task: string, facts?: string, maxFacts = 60_000): string {
	const parts = [task, "", `Rules:\n- ${agentRules()}`];
	if (facts?.trim()) {
		const trimmed = facts.length > maxFacts ? facts.slice(0, maxFacts) + "\n… (truncated)" : facts;
		parts.push("", "<facts collected read-only by the Mapper>", trimmed, "</facts>");
	}
	return parts.join("\n");
}

/**
 * Before an agent is sent to the folders some shapes were mapped from: a map of a downloaded
 * repository points at its download, which may have been cleared away since, so it is brought
 * back first. Returns what to add to the request when one could not be (the agent then knows the
 * files are not there, and says so), or "".
 */
export async function mapRootsReady(shapes: { data: Record<string, string> }[], ctx: Pick<CollectContext, "keepRepository">): Promise<string> {
	if (!ctx.keepRepository) return "";
	const missing: string[] = [];
	for (const root of new Set(shapes.map((s) => s.data.mapRoot).filter(Boolean))) {
		try {
			await ctx.keepRepository(root);
		} catch (e: any) {
			missing.push(`"${root}" (${String(e?.message ?? e).split("\n")[0].slice(0, 200)})`);
		}
	}
	return missing.length ? `\n\nNote: the downloaded copy of the repository this map was made from is no longer on this computer and could not be downloaded again: ${missing.join("; ")}. Its files cannot be read: say so, and work from the shapes' data.` : "";
}

/** The usual "dig deeper" request: the selected shapes' data plus the user's question. */
export function digDeeperRequest(what: string, shapes: { label: string; data: Record<string, string> }[], question: string): string {
	const listed = shapes
		.slice(0, 60)
		.map((s) => `- ${s.label || "(no label)"}: ${JSON.stringify(s.data)}`)
		.join("\n");
	const roots = [...new Set(shapes.map((s) => s.data.mapRoot).filter(Boolean))];
	return agentRequest(
		`${roots.length ? `The map was made from ${roots.map((r) => `"${r}"`).join(", ")}; paths in the shapes' data are relative to it. ` : ""}Dig deeper into these ${what} on the map${question.trim() ? `: ${question.trim()}` : "."} Investigate them read-only, then add what matters to the map (details, missing dependencies, connections, risks) next to the shapes it concerns, as pending changes.\n\nSelected shapes:\n${listed}${shapes.length > 60 ? `\n… and ${shapes.length - 60} more` : ""}`
	);
}

/** Short, stable ids from arbitrary strings (for node ids that become XML attributes). */
export function slug(s: string): string {
	return s.replace(/[^A-Za-z0-9_.:/-]+/g, "_").slice(0, 200);
}
