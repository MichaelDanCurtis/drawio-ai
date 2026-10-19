import * as vscode from "vscode";
import formatter = require("xml-formatter");
import type { DiagramImport, DiagramImportFormat } from "../DrawioClient/CustomizedDrawioClient";
import { registerFailableCommand } from "../utils/registerFailableCommand";
import { assertNoSymbolicLinks, isInsideFolder, normalizePath } from "./ai/exportDiagram";

/**
 * Opening diagrams made in other tools: Microsoft Visio, Gliffy, yEd (GraphML),
 * Lucidchart and Miro files, and draw.io's CSV format, are converted with
 * draw.io's own importers inside a draw.io webview, so nothing is uploaded, and
 * written as a new .drawio file next to the original. Existing files are never
 * replaced.
 */

/** What runs the conversion: draw.io's importers in a draw.io webview. */
export interface DrawioImporter {
	importDiagram(format: DiagramImportFormat, fileName: string, data: Uint8Array): Promise<DiagramImport>;
}

/** Runs a task against a draw.io webview; see DrawioEditorService.withDrawioWebview. */
export type RunInDrawio = <T>(forUri: vscode.Uri, task: (client: DrawioImporter) => Promise<T>) => Promise<T>;

export interface ImportedDiagram extends Omit<DiagramImport, "xml"> {
	source: vscode.Uri;
	target: vscode.Uri;
	format: DiagramImportFormat;
}

export const VISIO_EXTENSIONS = ["vsdx", "vsd", "vssx", "vss", "vstx", "vst"];

const FORMAT_NAMES: Record<DiagramImportFormat, string> = {
	visio: "Visio",
	gliffy: "Gliffy",
	graphml: "GraphML",
	lucidchart: "Lucidchart",
	miro: "Miro",
	csv: "CSV",
};

const MAX_BYTES = 50 * 1024 * 1024;
const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Tells the supported formats apart by extension and content. */
export function detectImportFormat(fileName: string, bytes: Uint8Array): DiagramImportFormat {
	const ext = (/\.([^./\\]+)$/.exec(fileName)?.[1] ?? "").toLowerCase();
	if (VISIO_EXTENSIONS.includes(ext)) {
		if (startsWith(bytes, [0x50, 0x4b]) || startsWith(bytes, COMPOUND_FILE)) {
			return "visio";
		}
		throw new Error(`${fileName} is not a Visio file: Visio files are ZIP packages (.vsdx, .vssx, .vstx) or binary documents (.vsd, .vss, .vst).`);
	}
	if (/^v[dst]x$/.test(ext)) {
		throw new Error(`${fileName} is a Visio 2003-2010 XML file, which draw.io cannot convert. Save it as .vsdx in Visio first.`);
	}
	const head = new TextDecoder().decode(bytes.subarray(0, 65536)).replace(/^﻿/, "").trimStart();
	if (ext === "gliffy" || /"contentType"\s*:\s*"application\/gliffy\+json"/.test(head)) {
		return "gliffy";
	}
	if (ext === "graphml" || /<graphml[\s>]/.test(head)) {
		return "graphml";
	}
	if (/^\{\s*"(state|Properties|Pages|Page)"\s*:/.test(head)) {
		return "lucidchart";
	}
	// Miro puts this on the clipboard when shapes are copied from a board.
	if (/^\{\s*"isProtected"\s*:/.test(head)) {
		return "miro";
	}
	if (ext === "csv") {
		return "csv";
	}
	throw new Error(
		`${fileName} is not a file draw.io can convert. It reads Microsoft Visio (.vsdx, .vsd, .vssx, .vstx), Gliffy (.gliffy), yEd/GraphML (.graphml), Lucidchart and Miro (.json) and draw.io CSV (.csv) files.`
	);
}

/** Where the converted diagram goes: name.drawio next to the source, then name-2.drawio, name-3.drawio… */
export function diagramUriFor(source: vscode.Uri, n: number): vscode.Uri {
	const file = source.path.split("/").pop() ?? "";
	const base = file.replace(/\.[^.]*$/, "") || file;
	return vscode.Uri.joinPath(source, "..", n <= 1 ? `${base}.drawio` : `${base}-${n}.drawio`);
}

/** Converts a file and writes it as a new .drawio file next to it. */
export async function importDiagramFile(source: vscode.Uri, runInDrawio: RunInDrawio): Promise<ImportedDiagram> {
	const fileName = source.path.split("/").pop() ?? "";
	let stat: vscode.FileStat;
	try {
		stat = await vscode.workspace.fs.stat(source);
	} catch {
		throw new Error(`${fileName} was not found.`);
	}
	if (stat.type & vscode.FileType.Directory) {
		throw new Error(`${fileName} is a folder.`);
	}
	if (stat.size > MAX_BYTES) {
		throw new Error(`${fileName} is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
	}
	const bytes = await vscode.workspace.fs.readFile(source);
	const format = detectImportFormat(fileName, bytes);
	const { xml, ...result } = await runInDrawio(source, (client) => client.importDiagram(format, fileName, bytes));
	const target = await createNewFile(source, new TextEncoder().encode(formatter(xml)));
	return { source, target, format, ...result };
}

/**
 * Creates the file under the first free name. The edit itself refuses to create a
 * file that exists, so a file that appears in the meantime is not replaced either.
 */
async function createNewFile(source: vscode.Uri, contents: Uint8Array): Promise<vscode.Uri> {
	for (let n = 1; n <= 100; n++) {
		const target = diagramUriFor(source, n);
		if (await exists(target)) {
			continue;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.createFile(target, { overwrite: false, ignoreIfExists: false, contents });
		if (await vscode.workspace.applyEdit(edit)) {
			return target;
		}
		if (!(await exists(target))) {
			throw new Error(`${vscode.workspace.asRelativePath(target, false)} could not be created.`);
		}
	}
	throw new Error(`There are already 100 converted copies of ${source.path.split("/").pop()}.`);
}

export function describeImport(r: ImportedDiagram): string {
	const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
	const contents =
		r.kind === "stencil"
			? `${count(r.shapes, "shape")} of the stencil laid out on one page`
			: [count(r.pages, "page"), count(r.shapes, "shape"), count(r.connectors, "connector")].join(", ");
	return `Converted ${fileNameOf(r.source)} from ${FORMAT_NAMES[r.format]} to ${fileNameOf(r.target)} (${contents}).`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const VISIO_FILTERS = { "Microsoft Visio": VISIO_EXTENSIONS };
const ALL_FILTERS = {
	"Diagrams from other tools": [...VISIO_EXTENSIONS, "gliffy", "graphml", "json", "csv"],
	"Microsoft Visio": VISIO_EXTENSIONS,
	Gliffy: ["gliffy", "json"],
	"yEd / GraphML": ["graphml", "xml"],
	"Lucidchart (JSON)": ["json"],
	"Miro board data (JSON)": ["json"],
	"draw.io CSV": ["csv"],
};

export interface ImportCommandResult {
	converted: ImportedDiagram[];
	failed: { source: vscode.Uri; error: string }[];
}

/**
 * "Open Visio File as Draw.io…" and "Import Diagram from Another Tool…". Both take
 * the file(s) from the explorer, or ask for them, and open each converted diagram.
 * assertAvailable throws when files cannot be converted for that folder.
 */
export function registerImportCommands(
	runInDrawio: RunInDrawio,
	defaultFolder: () => vscode.Uri | undefined,
	assertAvailable: (folder: vscode.Uri | undefined) => void = () => {}
): vscode.Disposable[] {
	const output = vscode.window.createOutputChannel("Draw.io Import");

	const run = async (filters: Record<string, string[]>, title: string, uri?: unknown, uris?: unknown): Promise<ImportCommandResult> => {
		let sources = Array.isArray(uris) && uris.length > 0 ? (uris as vscode.Uri[]) : uri instanceof vscode.Uri ? [uri] : undefined;
		if (!sources) {
			const folder = defaultFolder();
			// Say so before the user picks files, not after.
			assertAvailable(folder);
			sources = await vscode.window.showOpenDialog({ canSelectMany: true, filters, title, openLabel: "Convert", defaultUri: folder });
		}
		const result: ImportCommandResult = { converted: [], failed: [] };
		for (const source of sources ?? []) {
			let r: ImportedDiagram;
			try {
				r = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Converting ${fileNameOf(source)} with draw.io…` },
					() => importDiagramFile(source, runInDrawio)
				);
			} catch (e: any) {
				const error = String(e?.message ?? e);
				result.failed.push({ source, error });
				void vscode.window.showErrorMessage(withoutLinks(`Could not convert ${fileNameOf(source)}: ${error}`));
				continue;
			}
			result.converted.push(r);
			report(r);
			try {
				await vscode.commands.executeCommand("vscode.openWith", r.target, "drawio-ai-text");
			} catch (e: any) {
				void vscode.window.showErrorMessage(withoutLinks(`Converted ${fileNameOf(r.target)}, but could not open it: ${e?.message ?? e}`));
			}
		}
		return result;
	};

	const report = (r: ImportedDiagram) => {
		const summary = describeImport(r);
		if (r.warnings.length === 0) {
			void vscode.window.showInformationMessage(withoutLinks(summary));
			return;
		}
		output.appendLine(`${new Date().toLocaleString()} ${summary}`);
		for (const w of r.warnings) {
			output.appendLine(`  - ${w}`);
		}
		const detail =
			r.warnings.length === 1 ? r.warnings[0] : `${r.warnings.length} things did not carry over exactly, for example: ${r.warnings[0]}`;
		void vscode.window.showWarningMessage(withoutLinks(`${summary} ${detail}`), "Show Details").then((choice) => {
			if (choice) output.show(true);
		});
	};

	return [
		output,
		registerFailableCommand("drawio-ai.openVisio", (uri?: unknown, uris?: unknown) =>
			run(VISIO_FILTERS, "Open Visio File as Draw.io", uri, uris)
		),
		registerFailableCommand("drawio-ai.importDiagram", (uri?: unknown, uris?: unknown) =>
			run(ALL_FILTERS, "Import Diagram from Another Tool", uri, uris)
		),
	];
}

/**
 * Notifications turn [text](target) into links, command links included. File names
 * and converter messages come from the converted file, so they must not form one.
 */
export function withoutLinks(text: string): string {
	return text.replace(/\]\s*\(/g, "] (");
}

// ---------------------------------------------------------------------------
// The drawio_import tool
// ---------------------------------------------------------------------------

export interface ImportRequest {
	/** Workspace-relative (or absolute, inside the workspace) path of the file to convert. */
	path: string;
	/** Open the new diagram. Default true. */
	open?: boolean;
}

/**
 * Lets the agent convert a file. Only files inside the workspace (or, without a
 * workspace, the open diagram's folder) are read, and not through symbolic links.
 * An opened diagram takes focus so that the agent's next tool calls work on it;
 * whenTarget waits until they do.
 */
export async function importForAgent(
	request: ImportRequest,
	runInDrawio: RunInDrawio,
	diagramFolder: () => vscode.Uri | undefined,
	whenTarget: (diagram: vscode.Uri) => Promise<boolean> = async () => true
): Promise<{ text: string; summary: string }> {
	const source = await resolveSource(String(request.path ?? ""), diagramFolder());
	const r = await importDiagramFile(source, runInDrawio);
	let opened = false;
	let openError: string | undefined;
	if (request.open !== false) {
		try {
			await vscode.commands.executeCommand("vscode.openWith", r.target, "drawio-ai-text", { preview: false });
			opened = true;
			if (!(await whenTarget(r.target))) {
				openError = "The diagram opened but did not become the active, loaded one in time, so the other tools may still work on the previous diagram.";
			}
		} catch (e: any) {
			// The file is written either way; report that instead of failing the call.
			openError = String(e?.message ?? e);
		}
	}
	const shown = (u: vscode.Uri) => vscode.workspace.asRelativePath(u, false);
	const { format, kind, pages, shapes, connectors, warnings } = r;
	return {
		text: JSON.stringify({ path: shown(r.target), source: shown(r.source), format, kind, pages, shapes, connectors, warnings, opened, openError }),
		summary: `Imported ${shown(r.target)}`,
	};
}

async function resolveSource(requested: string, diagramFolder: vscode.Uri | undefined): Promise<vscode.Uri> {
	const p = requested.trim().replace(/\\/g, "/");
	if (!p) {
		throw new Error("path is required.");
	}
	const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri);
	const roots = folders?.length ? folders : diagramFolder ? [diagramFolder] : [];
	if (roots.length === 0) {
		throw new Error("Open a folder or a draw.io diagram first: files are only imported from the workspace.");
	}
	const absolute = p.startsWith("/") || /^[a-z]:\//i.test(p);
	const candidates = absolute
		? roots.map((r) => r.with({ path: normalizePath(vscode.Uri.file(p).path) }))
		: roots.map((r) => r.with({ path: normalizePath(`${r.path}/${p}`) }));
	let inside = false;
	for (let i = 0; i < candidates.length; i++) {
		if (!isInsideFolder(roots[i], candidates[i])) {
			continue;
		}
		inside = true;
		if (await exists(candidates[i])) {
			await assertNoSymbolicLinks(roots[i], candidates[i], "files are not read through links");
			return candidates[i];
		}
	}
	throw new Error(inside ? `${p} was not found.` : `path must be inside ${folders?.length ? "the workspace" : "the diagram's folder"}.`);
}

// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

function fileNameOf(uri: vscode.Uri): string {
	return uri.path.split("/").pop() ?? uri.path;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
