import { app, dialog, Menu, MenuItemConstructorOptions, nativeTheme, session, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AGENTS } from "./agents";
import { DiagramWindow } from "./diagramWindow";
import { runE2e } from "./e2e";
import { EXPORT_FORMATS } from "./exporter";
import { CATEGORIES } from "./mapper/types";
import { connectAgents, DesktopMcp } from "./desktopMcp";
import { paths } from "./paths";
import { settingsPath, updateSettings } from "./settings";
import { StaticServer } from "./staticServer";

app.setName("Draw.AI");
// For checks and screenshots: DRAWAI_THEME=light|dark overrides the system appearance.
if (process.env.DRAWAI_THEME === "light" || process.env.DRAWAI_THEME === "dark") nativeTheme.themeSource = process.env.DRAWAI_THEME;
// Test runs get their own data folder: they must not touch the user's settings or
// collide with a copy of the app that is already running.
if (process.env.DRAWAI_E2E) {
	app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "drawai-e2e-data-")));
	// Nor the user's ~/.drawio-ai (the desktop MCP endpoint's address file and launcher).
	process.env.DRAWIO_AI_HOME ||= fs.mkdtempSync(path.join(require("os").tmpdir(), "drawai-e2e-home-"));
}
const server = new StaticServer();
const pendingFiles: string[] = [];
let ready = false;
let desktopMcp: DesktopMcp | undefined;

/** Agent → Connect / Disconnect Claude Code and Codex: registers the desktop app as their MCP server. */
async function connectExternalAgents(connect: boolean): Promise<void> {
	const results = await connectAgents(connect);
	const ok = results.some((r) => r.ok);
	await dialog.showMessageBox({
		type: ok ? "info" : "warning",
		message: connect ? "Claude Code and Codex can use Draw.AI" : "Claude Code and Codex disconnected",
		detail:
			results.map((r) => `${r.ok ? "✓" : "✕"} ${r.agent}: ${r.message}`).join("\n") +
			(connect && ok
				? "\n\nIn a new Claude Code or Codex session, the draw-ai-desktop tools work on the diagrams open here (pass `file` to pick one) and on their maps: mapper_maps, mapper_find, mapper_show, mapper_path, mapper_run, mapper_findings… Keep Draw.AI open while they work."
				: ""),
	});
}

if (!app.requestSingleInstanceLock() && !process.env.DRAWAI_E2E) {
	app.quit();
}

function diagramArgs(argv: string[]): string[] {
	return argv
		.slice(app.isPackaged ? 1 : 2)
		.filter((a) => !a.startsWith("-") && fs.existsSync(a) && fs.statSync(a).isFile())
		.map((a) => path.resolve(a));
}

async function openFile(file?: string): Promise<void> {
	if (!ready) {
		if (file) pendingFiles.push(file);
		return;
	}
	if (file) app.addRecentDocument(file);
	await DiagramWindow.open(server, file);
}

async function openDialog(defaultPath?: string): Promise<void> {
	const r = await dialog.showOpenDialog({
		properties: ["openFile", "multiSelections"],
		defaultPath,
		filters: [...DiagramWindow.openFilters, { name: "All Files", extensions: ["*"] }],
	});
	for (const f of r.filePaths) await openFile(f);
}

app.on("open-file", (e, file) => {
	e.preventDefault();
	void openFile(file);
});

app.on("second-instance", (_e, argv) => {
	const files = diagramArgs(argv);
	if (files.length) files.forEach((f) => void openFile(f));
	else DiagramWindow.focused()?.win.focus();
});

function buildMenu(): void {
	const w = () => DiagramWindow.focused();
	const template: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [
					{
						label: "Draw.AI",
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							{ label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
							{ type: "separator" },
							{ role: "hide" },
							{ role: "hideOthers" },
							{ role: "unhide" },
							{ type: "separator" },
							{ role: "quit" },
						],
					} as MenuItemConstructorOptions,
			  ]
			: []),
		{
			label: "File",
			submenu: [
				{ label: "New Diagram", accelerator: "CmdOrCtrl+N", click: () => void openFile() },
				{ label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void openDialog() },
				{ label: "Open Example…", click: () => void openDialog(paths.examples) },
				{ role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] } as MenuItemConstructorOptions,
				{ type: "separator" },
				{ label: "Save", accelerator: "CmdOrCtrl+S", click: () => void w()?.save() },
				{ label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => void w()?.saveAs() },
				{ type: "separator" },
				{ label: "Export as PDF…", accelerator: "CmdOrCtrl+Shift+E", click: () => void w()?.exportInteractive("pdf") },
				{
					label: "Export As",
					submenu: EXPORT_FORMATS.map((f) => ({ label: f.label, click: () => void w()?.exportInteractive(f.format) })),
				},
				{ label: "Open from Another Tool…", click: () => void w()?.importFromOtherTool() },
				{ type: "separator" },
				{ label: "Print…", accelerator: "CmdOrCtrl+P", click: () => void w()?.print() },
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				{ label: "Presentation Mode", accelerator: "F5", click: () => w()?.togglePresentation() },
				// Same, for keyboards without easy F-keys (hidden; its shortcut still works).
				{ label: "Presentation Mode", accelerator: "CmdOrCtrl+Shift+Enter", visible: false, acceleratorWorksWhenHidden: true, click: () => w()?.togglePresentation() },
				{ type: "separator" },
				{ label: "Toggle Chat", accelerator: "CmdOrCtrl+J", click: () => w()?.toggleChat() },
				{ label: "Wider Chat", accelerator: "CmdOrCtrl+Alt+]", click: () => w()?.resizeChat(60) },
				{ label: "Narrower Chat", accelerator: "CmdOrCtrl+Alt+[", click: () => w()?.resizeChat(-60) },
				{ type: "separator" },
				{ label: "Reload Editor", click: () => w()?.editorView.webContents.reload() },
				{ label: "Editor Developer Tools", click: () => w()?.editorView.webContents.openDevTools({ mode: "detach" }) },
				{ label: "Chat Developer Tools", click: () => w()?.chatView.webContents.openDevTools({ mode: "detach" }) },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Agent",
			submenu: [
				...AGENTS.map((a) => ({
					label: `Use ${a.label}`,
					click: () => void w()?.chat.onMessage({ type: "pickProvider", providerId: a.id }),
				})),
				{ type: "separator" },
				{ label: "New Chat", accelerator: "CmdOrCtrl+Shift+N", click: () => w()?.chat.newChat() },
				{ label: "Stop", accelerator: "CmdOrCtrl+.", click: () => w()?.chat.stop() },
				{ label: "Restart Agent", click: () => void w()?.chat.onMessage({ type: "command", command: "drawai.retry" }) },
				{ type: "separator" },
				{ label: "Connect Claude Code / Codex to Draw.AI…", click: () => void connectExternalAgents(true) },
				{ label: "Disconnect Claude Code / Codex", click: () => void connectExternalAgents(false) },
				{ type: "separator" },
				{ label: "Allow All Requests in This Chat", click: () => w()?.chat.setAllowAll(true) },
				{ label: "Ask Before Each Request", click: () => w()?.chat.setAllowAll(false) },
				{ type: "separator" },
				{ label: "Keep AI Changes", click: () => w()?.client.aiResolveReview("accept") },
				{ label: "Revert AI Changes", click: () => w()?.client.aiResolveReview("reject") },
			],
		},
		{
			label: "Map",
			submenu: [
				{ label: "Map Something…", accelerator: "CmdOrCtrl+Shift+M", click: () => void withWindow((x) => x.mapper.open()) },
				{ type: "separator" },
				...CATEGORIES.map((c) => ({ label: `${c.title}…`, click: () => void withWindow((x) => x.mapper.open(c.id)) })),
				{ type: "separator" },
				{ label: "Dig Deeper into Selection", accelerator: "CmdOrCtrl+Shift+D", click: () => void w()?.digDeeper("") },
				{ type: "separator" },
				{ label: "Show Findings", click: () => w()?.chat.onMessage({ type: "mapAction", action: "findings", text: "" }) },
				{ label: "Describe Shapes in Plain English", click: () => w()?.chat.onMessage({ type: "mapAction", action: "describe", text: "" }) },
				{ label: "Show Recent Changes", click: () => w()?.chat.onMessage({ type: "mapAction", action: "recent", text: "" }) },
				{ label: "Refresh Map", click: () => w()?.chat.onMessage({ type: "mapAction", action: "refresh", text: "" }) },
				{ label: "Build a Tour", click: () => w()?.chat.onMessage({ type: "mapAction", action: "tour", text: "" }) },
				{ label: "Play Tour", accelerator: "CmdOrCtrl+Shift+T", click: () => w()?.setPresenting(true, { startTour: true }) },
			],
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [{ label: "Agent Client Protocol", click: () => void shell.openExternal("https://agentclientprotocol.com") }],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Runs `action` on the focused window, opening a new diagram first when there is none. */
async function withWindow(action: (w: DiagramWindow) => void): Promise<void> {
	let w = DiagramWindow.focused();
	if (!w) {
		await openFile();
		w = DiagramWindow.focused();
	}
	if (!w) return;
	await w.whenLoaded();
	action(w);
}

function openSettings(): void {
	if (!fs.existsSync(settingsPath())) updateSettings({});
	void shell.openPath(settingsPath());
}

/** The editor works offline: only our own 127.0.0.1 server (and data/blob URLs) may be loaded. */
function blockRemoteRequests(): void {
	session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
		const u = details.url;
		const local = u.startsWith(server.base + "/") || /^(data|blob|devtools|chrome-extension|file):/.test(u);
		callback({ cancel: !local });
	});
}

app.whenReady().then(async () => {
	if (!fs.existsSync(path.join(paths.webapp, "index.html"))) {
		const message = `The draw.io webapp was not found at ${paths.webapp}.\nRun \`git submodule update --init --depth 1 drawio\` in the repository (or \`yarn start\`, which does it), then start again.`;
		console.error(message);
		if (!process.env.DRAWAI_E2E) dialog.showErrorBox("draw.io is missing", message);
		app.quit();
		return;
	}
	await server.start();
	blockRemoteRequests();
	DiagramWindow.installIpc();
	DiagramWindow.appCommands = { newDiagram: () => void openFile(), open: () => void openDialog() };
	desktopMcp = new DesktopMcp({
		windows: () => [...DiagramWindow.all],
		focused: () => DiagramWindow.focused(),
		open: (file) => DiagramWindow.open(server, file),
	});
	await desktopMcp.start().catch((e) => console.error("Draw.AI: desktop MCP endpoint did not start:", e));
	buildMenu();
	ready = true;

	if (process.env.DRAWAI_E2E) {
		await runE2e(server, JSON.parse(process.env.DRAWAI_E2E));
		return;
	}

	const files = [...pendingFiles.splice(0), ...diagramArgs(process.argv)];
	if (files.length) for (const f of files) await openFile(f);
	else await openFile();
});

app.on("activate", () => {
	if (ready && DiagramWindow.all.size === 0) void openFile();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin" || process.env.DRAWAI_E2E) app.quit();
});

app.on("will-quit", () => {
	desktopMcp?.dispose();
	server.dispose();
});
