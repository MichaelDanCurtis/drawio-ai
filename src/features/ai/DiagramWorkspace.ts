import * as vscode from "vscode";
import * as nodePath from "path";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import { normalizeFsPath } from "../../agent-bridge/discovery";
import type { DiagramWorkspace as DiagramWorkspaceApi, ToolResult } from "./DiagramToolbox";
import { assertNoSymbolicLinks, isDiagramFile } from "./exportDiagram";
import { decodeEntities, decompressDrawio, labelText, parseCells } from "./templates/profile";

const DIAGRAM_GLOB = "**/*.{drawio,dio,drawio.svg,dio.svg,drawio.png,dio.png}";
const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,.venv,venv,target,coverage,.next}/**";
const MAX_FILES = 2000;
const MAX_SEARCH_BYTES = 5_000_000;

/**
 * Diagrams other than the focused one, for the `file` argument and the
 * workspace tools. An agent can only reach diagrams inside the workspace
 * folders (or ones the user already opened), and never through symbolic links.
 */
export class DiagramWorkspace implements DiagramWorkspaceApi {
	constructor(
		private readonly editorService: DrawioEditorService,
		private readonly targetEditor: () => DrawioEditor | undefined
	) {}

	public async open(file: string, options: { reveal: boolean }): Promise<DrawioEditor> {
		const p = file.trim().replace(/\\/g, "/");
		if (!isDiagramFile(p)) {
			throw new Error(`${file} is not a draw.io diagram (.drawio, .dio, .drawio.svg or .drawio.png).`);
		}
		const candidates = this.candidates(p);
		for (const uri of candidates) {
			const editor = this.findEditor(uri);
			if (editor) {
				if (options.reveal && !editor.webviewPanel.visible) editor.webviewPanel.reveal(undefined, true);
				return editor;
			}
		}
		for (const uri of candidates) {
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (!folder || !(await exists(uri))) continue;
			await assertNoSymbolicLinks(folder.uri, uri);
			return this.openEditor(uri);
		}
		if (!vscode.workspace.workspaceFolders?.length) {
			throw new Error(`${file} is not open in VS Code, and no folder is open, so it cannot be opened for you. Ask the user to open it.`);
		}
		const outside = candidates.length > 0 && candidates.every((u) => !vscode.workspace.getWorkspaceFolder(u));
		throw new Error(
			outside
				? `${file} is outside the workspace folders. Only diagrams inside the workspace (or already open in VS Code) can be edited.`
				: `No diagram at ${file} in the workspace. drawio_list_diagrams lists them; drawio_create makes a new one.`
		);
	}

	public async list(input: Record<string, any>): Promise<ToolResult> {
		const limit = clamp(input.limit, 1, MAX_FILES, 200);
		const filter = typeof input.filter === "string" ? input.filter.trim().toLowerCase() : "";
		const target = this.targetEditor();
		const open = [...this.editorService.openedEditors].map((e) => ({
			path: this.shown(e.uri),
			focused: e === target,
			visible: e.webviewPanel.visible,
			selectedCells: e.drawioClient.currentSelection.length,
			pendingReview: !!e.drawioClient.pendingReview,
		}));
		const files = (await this.files())
			.map((u) => this.shown(u))
			.filter((p) => !filter || p.toLowerCase().includes(filter))
			.sort();
		return {
			text: JSON.stringify({
				focused: target ? this.shown(target.uri) : null,
				open,
				files: files.slice(0, limit),
				totalFiles: files.length,
				truncated: files.length > limit || undefined,
				hint: "Pass a path as `file` to the other drawio_* tools.",
			}),
			summary: `${open.length} open, ${files.length} diagram file${files.length === 1 ? "" : "s"}`,
		};
	}

	public async search(input: Record<string, any>): Promise<ToolResult> {
		const query = typeof input.query === "string" ? input.query.trim() : "";
		if (!query) throw new Error("`query` is required.");
		const limit = clamp(input.limit, 1, 500, 50);
		const re = /^\/(.+)\/([a-z]*)$/.exec(query);
		let matches: (s: string) => boolean;
		if (re) {
			// Without g/y, test() keeps no state between labels.
			const flags = re[2].replace(/[gy]/g, "");
			const regex = new RegExp(re[1], flags.includes("i") ? flags : flags + "i");
			matches = (s) => regex.test(s);
		} else {
			const q = query.toLowerCase();
			matches = (s) => s.toLowerCase().includes(q);
		}
		const results: { path: string; page: string; cellId: string; kind: string; label: string }[] = [];
		let skipped = 0;
		let total = 0;
		for (const uri of await this.files()) {
			const content = await this.readDiagram(uri);
			if (content === undefined) {
				skipped++;
				continue;
			}
			for (const page of pagesOf(content)) {
				for (const cell of parseCells(page.xml)) {
					const label = labelText(cell.value);
					if (!label || !matches(label)) continue;
					total++;
					if (results.length < limit) {
						results.push({ path: this.shown(uri), page: page.name, cellId: cell.id, kind: cell.edge ? "edge" : "vertex", label: label.slice(0, 200) });
					}
				}
			}
		}
		return {
			text: JSON.stringify({
				query,
				total,
				matches: results,
				skipped: skipped ? `${skipped} file(s) could not be read (.drawio.png, or too large)` : undefined,
			}),
			summary: `${total} match${total === 1 ? "" : "es"} for "${query}"`,
		};
	}

	public async create(input: Record<string, any>): Promise<ToolResult> {
		const p = typeof input.path === "string" ? input.path.trim().replace(/\\/g, "/") : "";
		if (!p) throw new Error("`path` is required.");
		if (!isDiagramFile(p) || /\.xml$/i.test(p)) {
			throw new Error("path must end in .drawio (recommended), .drawio.svg or .drawio.png.");
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) throw new Error("No folder is open in VS Code, so there is nowhere to create the diagram.");
		const uri = this.candidates(p)[0];
		const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
		if (!uri || !folder) throw new Error("path must be inside the workspace folder.");
		await assertNoSymbolicLinks(folder.uri, uri);
		if (await exists(uri)) {
			throw new Error(`${this.shown(uri)} already exists. Pass it as \`file\` to edit it.`);
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
		await vscode.workspace.fs.writeFile(uri, new Uint8Array());
		await this.openEditor(uri);
		const shown = this.shown(uri);
		return {
			text: JSON.stringify({ created: shown, hint: `Build it with drawio_apply_operations and file: "${shown}".` }),
			summary: `Created ${shown}`,
		};
	}

	/** Where a path may point: absolute, `<folder name>/rest` in a multi-root workspace, or relative to each folder. */
	private candidates(p: string): vscode.Uri[] {
		if (nodePath.isAbsolute(p) || /^[a-z]:\//i.test(p)) return [vscode.Uri.file(nodePath.resolve(p))];
		const folders = vscode.workspace.workspaceFolders ?? [];
		const [first, ...rest] = p.split("/");
		const named = folders.find((f) => f.name === first);
		const uris = [
			...(named && rest.length ? [vscode.Uri.joinPath(named.uri, ...rest)] : []),
			...folders.map((f) => vscode.Uri.joinPath(f.uri, p)),
		];
		// joinPath resolves "..": keep only paths that stay inside a folder.
		return uris.filter((u) => !!vscode.workspace.getWorkspaceFolder(u));
	}

	private findEditor(uri: vscode.Uri): DrawioEditor | undefined {
		const key = normalizeFsPath(uri.fsPath);
		return [...this.editorService.openedEditors].find((e) => e.uri.scheme === uri.scheme && normalizeFsPath(e.uri.fsPath) === key);
	}

	/** Opens the diagram where the user can see it, without taking focus from where they are typing. */
	private async openEditor(uri: vscode.Uri): Promise<DrawioEditor> {
		const viewType = /\.png$/i.test(uri.path) ? "drawio-ai" : "drawio-ai-text";
		await vscode.commands.executeCommand("vscode.openWith", uri, viewType, { preserveFocus: true, preview: false });
		for (let i = 0; i < 300; i++) {
			const editor = this.findEditor(uri);
			if (editor) return editor;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`Could not open ${this.shown(uri)} in the Draw.AI editor.`);
	}

	private async files(): Promise<vscode.Uri[]> {
		if (!vscode.workspace.workspaceFolders?.length) return [];
		return vscode.workspace.findFiles(DIAGRAM_GLOB, EXCLUDE_GLOB, MAX_FILES);
	}

	/** The open editor's text when there is one (it may be unsaved), else the file. */
	private async readDiagram(uri: vscode.Uri): Promise<string | undefined> {
		if (/\.png$/i.test(uri.path)) return undefined;
		const editor = this.findEditor(uri);
		if (editor?.document.kind === "text") return editor.document.document.getText();
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_SEARCH_BYTES) return undefined;
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return undefined;
		}
	}

	private shown(uri: vscode.Uri): string {
		// Relative to the folder; prefixed with the folder's name only in a multi-root workspace, as candidates() expects.
		return vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : uri.fsPath;
	}
}

/** Every page's name and model XML, for .drawio and .drawio.svg content. */
function pagesOf(content: string): { name: string; xml: string }[] {
	let text = content;
	const svgContent = /<svg[^>]*\scontent="([^"]*)"/.exec(text);
	if (svgContent) text = decodeEntities(svgContent[1]);
	if (!/<mxfile/.test(text)) return /<mxGraphModel/.test(text) ? [{ name: "Page-1", xml: text }] : [];
	const pages: { name: string; xml: string }[] = [];
	const re = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const name = decodeEntities(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? `Page-${pages.length + 1}`);
		const body = m[2].trim();
		try {
			if (body.startsWith("<")) pages.push({ name, xml: body });
			else if (body) pages.push({ name, xml: decompressDrawio(body) });
		} catch {
			// An unreadable page; skip it.
		}
	}
	return pages;
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
