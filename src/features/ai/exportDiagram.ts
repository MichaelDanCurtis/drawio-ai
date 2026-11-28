import * as fs from "fs";
import * as nodePath from "path";
import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";
// The desktop app's own code for writing an agent's export (no Electron in it), used as it is.
import { exportTarget, writeExport } from "../../../standalone/src/main/exportTarget";

export const EXPORT_FORMATS = ["vsdx", "pdf", "svg", "png", "drawio"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportRequest {
	format: string;
	/** Workspace-relative path; defaults to the diagram's name with the format's extension. */
	path?: string;
	/** vsdx and pdf: export just the page shown in the editor. */
	currentPageOnly?: boolean;
	/** Replace an existing export. The user still has to confirm. */
	overwrite?: boolean;
}

/** Asks the user whether an existing file may be replaced. */
export type ConfirmReplace = (shownPath: string) => Promise<boolean>;

const confirmWithDialog: ConfirmReplace = async (shownPath) =>
	(await vscode.window.showWarningMessage(
		`The AI wants to replace ${shownPath} with a new export of the diagram.`,
		{ modal: true },
		"Replace"
	)) === "Replace";

/** Writes an export of the open diagram into the workspace (the drawio_export tool). */
export async function exportDiagramToWorkspace(
	editor: DrawioEditor,
	request: ExportRequest,
	confirmReplace: ConfirmReplace = confirmWithDialog
): Promise<{ text: string; summary: string }> {
	const format = String(request.format ?? "").toLowerCase().replace(/^\./, "") as ExportFormat;
	if (!EXPORT_FORMATS.includes(format)) {
		throw new Error(`format must be one of: ${EXPORT_FORMATS.join(", ")}.`);
	}
	const target = resolveExportTarget(editor.uri, (ext) => editor.getUriWithExtension(ext), format, request.path);
	const shown = vscode.workspace.asRelativePath(target, false);
	if (sameFile(target, editor.uri)) {
		throw new Error("That path is the open diagram itself. Choose another path.");
	}
	const root = exportRoot(editor.uri);
	// A file on this computer's disk is placed and written by where it really is (see placeOnDisk).
	const onDisk = target.scheme === "file";
	await assertNoSymbolicLinks(root, target);
	const existed = onDisk ? !!placeOnDisk(root, target, shown)?.exists : await exists(target);
	if (existed) {
		if (isDiagramFile(target.path)) {
			throw new Error(`${shown} is an existing draw.io diagram; exports never replace diagrams. Choose another path.`);
		}
		if (!request.overwrite) {
			throw new Error(`${shown} already exists. Pass overwrite: true to replace it; the user is asked to confirm.`);
		}
		// Whichever surface called the tool (chat panel, @drawio, MCP, Copilot), the user decides.
		if (!(await confirmReplace(shown))) {
			throw new Error(`The user chose not to replace ${shown}.`);
		}
	}

	let data: Uint8Array;
	let details: Record<string, unknown> = {};
	if (format === "vsdx") {
		const result = await editor.drawioClient.exportVsdx({ currentPageOnly: !!request.currentPageOnly });
		data = result.data;
		const { pages, shapes, connectors, images, warnings } = result;
		details = { pages, shapes, connectors, images, warnings };
	} else if (format === "pdf") {
		const result = await editor.drawioClient.exportPdf({ currentPageOnly: !!request.currentPageOnly });
		data = result.data;
		details = { pages: result.pages, warnings: result.warnings };
	} else if (format === "drawio") {
		data = new TextEncoder().encode(await editor.drawioClient.getXml());
	} else {
		// The page shown in the editor, with the diagram embedded so it stays editable.
		data = await editor.drawioClient.export(`.${format}`, true);
	}
	// Exporting can take a while: check the path again right before writing.
	await assertNoSymbolicLinks(root, target);
	if (onDisk) placeOnDisk(root, target, shown);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
	if (onDisk) {
		// Where it lands now that its folders are there, and a write that follows no link: a new file
		// is made only if nothing has its name by then, and a file the user agreed to replace is
		// written into only if it is still a plain file under that name.
		const where = placeOnDisk(root, target, shown);
		if (!where) throw new Error(`${shown} could not be created.`);
		writeExport(where.real, Buffer.from(data.buffer, data.byteOffset, data.byteLength), existed);
	} else if (existed) {
		// The user agreed to replace this file.
		await vscode.workspace.fs.writeFile(target, data);
	} else {
		// Only creates the file, so one that appeared there meanwhile is not replaced.
		const edit = new vscode.WorkspaceEdit();
		edit.createFile(target, { overwrite: false, ignoreIfExists: false, contents: data });
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error(
				(await exists(target))
					? `${shown} was created by something else while the diagram was being exported, and was not replaced. Export again to decide what to do.`
					: `${shown} could not be created.`
			);
		}
	}
	return {
		text: JSON.stringify({ path: shown, format, bytes: data.length, ...details }),
		summary: `Exported ${shown}`,
	};
}

/**
 * Resolves where an export goes. Relative paths are taken from the diagram's
 * workspace folder (or its own folder outside a workspace) and must stay inside it.
 */
export function resolveExportTarget(
	diagram: vscode.Uri,
	withExtension: (ext: string) => vscode.Uri,
	format: ExportFormat,
	requested: string | undefined
): vscode.Uri {
	const ext = `.${format}`;
	const p = (requested ?? "").trim().replace(/\\/g, "/");
	if (!p) {
		const next = withExtension(ext);
		// "Export as .drawio" next to a .drawio file would be the file itself: write a copy.
		return sameFile(next, diagram) ? next.with({ path: next.path.slice(0, -ext.length) + `-copy${ext}` }) : next;
	}
	const folder = vscode.workspace.getWorkspaceFolder(diagram);
	const root = exportRoot(diagram);
	const withExt = p.toLowerCase().endsWith(ext) ? p : p + ext;
	const absolute = withExt.startsWith("/") || /^[a-z]:\//i.test(withExt);
	const joined = absolute ? vscode.Uri.file(withExt).path : `${root.path}/${withExt}`;
	// Resolve "." and ".." before checking where the file goes.
	const target = root.with({ path: normalizePath(joined) });
	if (!isInsideFolder(root, target)) {
		throw new Error(`path must be inside ${folder ? "the workspace folder" : "the diagram's folder"}.`);
	}
	return target;
}

/** Whether a normalized path lies below the folder (drive letters compare without case). */
export function isInsideFolder(root: vscode.Uri, target: vscode.Uri): boolean {
	const base = root.path.endsWith("/") ? root.path : root.path + "/";
	const caseInsensitive = /^\/[a-z]:/i.test(base);
	return caseInsensitive
		? target.path.toLowerCase().startsWith(base.toLowerCase())
		: target.path.startsWith(base);
}

/** Exports stay inside the diagram's workspace folder, or its own folder outside a workspace. */
function exportRoot(diagram: vscode.Uri): vscode.Uri {
	return vscode.workspace.getWorkspaceFolder(diagram)?.uri ?? vscode.Uri.joinPath(diagram, "..");
}

/**
 * Where an export to a file on this computer's disk really lands, with the links in its folders
 * followed: whether a file is there already (looked at without following a link), and its real
 * place. `undefined` while its folder is not there yet. Refuses a place that the links take out
 * of the folder exports stay in, and a name that is a link (to a file or to nothing) or a folder.
 *
 * `assertNoSymbolicLinks` asks VS Code about each part of the path, which is all there is for a
 * file system that is not a disk. For a disk this is the check that counts: it does not rest on
 * how VS Code reports a link, and it is made again at the moment of writing.
 */
function placeOnDisk(root: vscode.Uri, target: vscode.Uri, shown: string): { exists: boolean; real: string } | undefined {
	const within = vscode.workspace.getWorkspaceFolder(target) ? "the workspace folder" : "the diagram's folder";
	const limit = fs.realpathSync(root.fsPath);
	// The deepest folder above the file that is there: where the folders still to be made would go.
	let folder = nodePath.dirname(target.fsPath);
	let real: string | undefined;
	let missing = false;
	while (real === undefined) {
		try {
			real = fs.realpathSync(folder);
		} catch (e: any) {
			if (e?.code === "ENOTDIR") throw new Error(`${shown} cannot be written: a part of its path is a file, not a folder.`);
			const up = nodePath.dirname(folder);
			if (e?.code !== "ENOENT" || up === folder) throw e;
			// (no such folder yet; a link to nothing under its name is a link all the same)
			if (isLink(folder)) throw new Error(`${shown} is reached through a symbolic link that leads nowhere; exports are not written through links.`);
			folder = up;
			missing = true;
		}
	}
	if (!fs.statSync(real).isDirectory()) throw new Error(`${shown} cannot be written: a part of its path is a file, not a folder.`);
	const outside = () => new Error(`${shown} is reached through a symbolic link that leads out of ${within}; exports are not written through links.`);
	const below = nodePath.relative(limit, real);
	if (below === ".." || below.startsWith(".." + nodePath.sep) || nodePath.isAbsolute(below)) throw outside();
	if (missing) return undefined;
	const where = exportTarget(nodePath.join(real, nodePath.basename(target.fsPath)));
	// (the folder that was just checked, and no other one that a link put in its place since)
	if (nodePath.dirname(where.real) !== real) throw outside();
	return where;
}

function isLink(file: string): boolean {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * The containment check is on the path text, but writes follow symbolic links:
 * refuse targets that pass through a link below the root (a linked folder, or a
 * link in place of the file), since the file could land outside the workspace.
 * Also used for diagrams that agents name with `file`.
 */
export async function assertNoSymbolicLinks(
	root: vscode.Uri,
	target: vscode.Uri,
	reason = "exports are not written through links"
): Promise<void> {
	const base = root.path.endsWith("/") ? root.path : root.path + "/";
	let at = root;
	for (const segment of target.path.slice(base.length).split("/").filter(Boolean)) {
		at = vscode.Uri.joinPath(at, segment);
		let stat: vscode.FileStat;
		try {
			stat = await vscode.workspace.fs.stat(at);
		} catch {
			return; // Nothing below a missing folder exists yet.
		}
		if (stat.type & vscode.FileType.SymbolicLink) {
			throw new Error(`${vscode.workspace.asRelativePath(at, false)} is a symbolic link; ${reason}.`);
		}
	}
}

export function normalizePath(p: string): string {
	const out: string[] = [];
	for (const segment of p.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return "/" + out.join("/");
}

/** File systems on macOS and Windows usually ignore case, so compare without it. */
function sameFile(a: vscode.Uri, b: vscode.Uri): boolean {
	return a.scheme === b.scheme && normalizePath(a.path).toLowerCase() === normalizePath(b.path).toLowerCase();
}

export function isDiagramFile(p: string): boolean {
	return /\.(drawio|dio)(\.(svg|png|xml))?$/i.test(p);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
