import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";

export const EXPORT_FORMATS = ["vsdx", "svg", "png", "drawio"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportRequest {
	format: string;
	/** Workspace-relative path; defaults to the diagram's name with the format's extension. */
	path?: string;
	/** vsdx only: export just the page shown in the editor. */
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
	await assertNoSymbolicLinks(exportRoot(editor.uri), target);
	if (await exists(target)) {
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
	} else if (format === "drawio") {
		data = new TextEncoder().encode(await editor.drawioClient.getXml());
	} else {
		// The page shown in the editor, with the diagram embedded so it stays editable.
		data = await editor.drawioClient.export(`.${format}`, true);
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
	await vscode.workspace.fs.writeFile(target, data);
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
	const base = root.path.endsWith("/") ? root.path : root.path + "/";
	const caseInsensitive = /^\/[a-z]:/i.test(base);
	const inside = caseInsensitive
		? target.path.toLowerCase().startsWith(base.toLowerCase())
		: target.path.startsWith(base);
	if (!inside) {
		throw new Error(`path must be inside ${folder ? "the workspace folder" : "the diagram's folder"}.`);
	}
	return target;
}

/** Exports stay inside the diagram's workspace folder, or its own folder outside a workspace. */
function exportRoot(diagram: vscode.Uri): vscode.Uri {
	return vscode.workspace.getWorkspaceFolder(diagram)?.uri ?? vscode.Uri.joinPath(diagram, "..");
}

/**
 * The containment check is on the path text, but writes follow symbolic links:
 * refuse targets that pass through a link below the root (a linked folder, or a
 * link in place of the file), since the file could land outside the workspace.
 */
async function assertNoSymbolicLinks(root: vscode.Uri, target: vscode.Uri): Promise<void> {
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
			throw new Error(`${vscode.workspace.asRelativePath(at, false)} is a symbolic link; exports are not written through links.`);
		}
	}
}

function normalizePath(p: string): string {
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

function isDiagramFile(p: string): boolean {
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
