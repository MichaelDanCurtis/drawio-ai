import * as fs from "fs";
import * as path from "path";
import type { FieldDef, MapInput } from "../types";
import { MapperError } from "../types";

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
				if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && !dotDirs(e.name))) continue;
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

export const FOLDER_FIELD: FieldDef = {
	id: "folder",
	label: "Repository or folder",
	type: "folder",
	required: true,
	help: "Read locally; nothing is uploaded except what you then send to the agent.",
};

/** Shared rules for every request the Mapper sends to the agent. */
export const AGENT_RULES = [
	"Work ONLY through the drawio_* tools of the \"omnidraw\" MCP server to read and change the diagram; never edit diagram files on disk.",
	"You may read files and run read-only inspection commands (list / describe / show / get / query) to investigate. NEVER run anything that creates, changes, deletes, deploys, restarts or costs money, and never print secrets.",
	"Shapes the Mapper drew carry data attributes (mapper, mapperKind, mapperId and source ids such as ARNs or resource ids): keep them, and give new shapes the same attributes where you can.",
	"Use proper icons (search the shape libraries with drawio_search_shapes) and keep the existing layout readable; add new shapes next to what they relate to.",
	"End with a short summary of what you found and what you changed on the map.",
].join("\n- ");

/** A request for the agent with the facts attached, size-limited. */
export function agentRequest(task: string, facts?: string, maxFacts = 60_000): string {
	const parts = [task, "", `Rules:\n- ${AGENT_RULES}`];
	if (facts?.trim()) {
		const trimmed = facts.length > maxFacts ? facts.slice(0, maxFacts) + "\n… (truncated)" : facts;
		parts.push("", "<facts collected read-only by the Mapper>", trimmed, "</facts>");
	}
	return parts.join("\n");
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
