import * as vscode from "vscode";
import { Disposable } from "@hediet/std/disposable";

/** Diagram files Draw.AI opens (see package.json → customEditors). */
export const DIAGRAM_GLOB = "**/*.{drawio,dio,drawio.svg,dio.svg,drawio.png,dio.png}";
const EXCLUDE_GLOB = "**/{node_modules,.git,out,dist,build,.next,.venv,venv,target}/**";
const MAX_FILES = 2000;

/** The Draw.AI editor that opens a file: the binary one for PNGs, the text one otherwise. */
export function drawioViewType(uri: vscode.Uri): string {
	return /\.(drawio|dio)\.png$/i.test(uri.path) ? "drawio-ai" : "drawio-ai-text";
}

interface StartItem {
	label: string;
	command: string;
	icon: string;
	tooltip: string;
}

/** The Start view: the things people come to Draw.AI for, one click away. */
const START: StartItem[] = [
	{ label: "New Diagram", command: "drawio-ai.newDiagram", icon: "new-file", tooltip: "Create a .drawio file and open it in Draw.AI" },
	{ label: "Open Draw.AI in Chat", command: "drawio-ai.openChat", icon: "sparkle", tooltip: "Ask the Draw.AI agent in VS Code's chat to draw or change a diagram" },
	{ label: "Diagram from Code…", command: "drawio-ai.diagramFromCode", icon: "code", tooltip: "Draw a diagram of a folder or file: architecture, data model, flow" },
	{ label: "Diagram from Sketch…", command: "drawio-ai.diagramFromImage", icon: "device-camera", tooltip: "Turn a sketch, whiteboard photo or screenshot into an editable diagram" },
	{ label: "Import from Another Tool…", command: "drawio-ai.importDiagram", icon: "cloud-download", tooltip: "Visio, Gliffy, yEd (GraphML), Lucidchart, Miro or draw.io CSV" },
	{ label: "Export to PDF…", command: "drawio-ai.exportPdf", icon: "file-pdf", tooltip: "Export the diagram you used last to PDF" },
	{ label: "Design Templates…", command: "drawio-ai.selectTemplate", icon: "symbol-color", tooltip: "Pick the house style the AI and the linter follow" },
	{ label: "Connect Claude Code / Codex…", command: "drawio-ai.connectAgents", icon: "plug", tooltip: "Let Claude Code and Codex edit the diagrams open here" },
];

class StartProvider implements vscode.TreeDataProvider<StartItem> {
	getTreeItem(item: StartItem): vscode.TreeItem {
		const t = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
		t.iconPath = new vscode.ThemeIcon(item.icon);
		t.tooltip = item.tooltip;
		t.command = { command: item.command, title: item.label };
		return t;
	}
	getChildren(): StartItem[] {
		return START;
	}
}

/** The Diagrams view: every diagram in the workspace, sorted by path. */
class DiagramsProvider implements vscode.TreeDataProvider<vscode.Uri> {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this.changed.event;
	private timer: NodeJS.Timeout | undefined;
	public truncated = false;

	refresh(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.changed.fire(), 300);
	}

	getTreeItem(uri: vscode.Uri): vscode.TreeItem {
		const t = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
		const rel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		t.label = uri.path.slice(uri.path.lastIndexOf("/") + 1);
		t.description = dir;
		t.tooltip = rel;
		t.contextValue = "drawioDiagram";
		t.command = { command: "drawio-ai.sidebar.open", title: "Open", arguments: [uri] };
		return t;
	}

	async getChildren(): Promise<vscode.Uri[]> {
		if (!vscode.workspace.workspaceFolders?.length) return [];
		const found = await vscode.workspace.findFiles(DIAGRAM_GLOB, EXCLUDE_GLOB, MAX_FILES + 1);
		this.truncated = found.length > MAX_FILES;
		return found
			.slice(0, MAX_FILES)
			.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b), undefined, { numeric: true, sensitivity: "base" }));
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.changed.dispose();
	}
}

/**
 * The Draw.AI icon in the activity bar: a Start view (new diagram, the chat, diagrams from
 * code or a sketch, import, export, templates, Claude Code / Codex) and the workspace's
 * diagrams, which open in Draw.AI whatever the default editor for them is.
 */
export class SidebarFeature {
	public readonly dispose = Disposable.fn();

	constructor() {
		const diagrams = new DiagramsProvider();
		this.dispose.track(diagrams);
		this.dispose.track(vscode.window.registerTreeDataProvider("drawio-ai.start", new StartProvider()));
		const view = vscode.window.createTreeView("drawio-ai.diagrams", { treeDataProvider: diagrams, showCollapseAll: false });
		this.dispose.track(view);

		const watcher = vscode.workspace.createFileSystemWatcher(DIAGRAM_GLOB, false, true, false);
		this.dispose.track(watcher);
		this.dispose.track(watcher.onDidCreate(() => diagrams.refresh()));
		this.dispose.track(watcher.onDidDelete(() => diagrams.refresh()));
		this.dispose.track(vscode.workspace.onDidChangeWorkspaceFolders(() => diagrams.refresh()));

		const uriArg = (arg: unknown): vscode.Uri | undefined => (arg instanceof vscode.Uri ? arg : undefined);
		this.dispose.track(vscode.commands.registerCommand("drawio-ai.sidebar.refresh", () => diagrams.refresh()));
		this.dispose.track(
			vscode.commands.registerCommand("drawio-ai.sidebar.open", (arg: unknown) => {
				const uri = uriArg(arg);
				if (uri) return vscode.commands.executeCommand("vscode.openWith", uri, drawioViewType(uri));
			})
		);
		this.dispose.track(
			vscode.commands.registerCommand("drawio-ai.sidebar.openToSide", (arg: unknown) => {
				const uri = uriArg(arg);
				if (uri) return vscode.commands.executeCommand("vscode.openWith", uri, drawioViewType(uri), vscode.ViewColumn.Beside);
			})
		);
		this.dispose.track(
			vscode.commands.registerCommand("drawio-ai.sidebar.reveal", (arg: unknown) => {
				const uri = uriArg(arg);
				if (uri) return vscode.commands.executeCommand("revealInExplorer", uri);
			})
		);
	}
}
