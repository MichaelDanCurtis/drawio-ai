import { app, dialog, Menu, MenuItemConstructorOptions, nativeTheme, session, shell, webContents, type WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AGENTS } from "./agents";
import { DiagramWindow, type DrawioMenuItem } from "./diagramWindow";
import { toAccelerator } from "./shortcuts";
import { runE2e } from "./e2e";
import { EXPORT_FORMATS } from "./exporter";
import { CATEGORIES } from "./mapper/types";
import { connectAgents, DesktopMcp } from "./desktopMcp";
import { paths } from "./paths";
import { onSettingsChanged, settings } from "./settings";
import { SettingsWindow } from "./settingsWindow";
import { WorkshopWindow } from "./workshop/workshopWindow";
import { StaticServer } from "./staticServer";

app.setName("OmniDraw");
/**
 * Before the rename the app was "Draw.AI", with its data in a folder of that name: carry the
 * user's settings, draw.io preferences and Mapper inputs over once (the old folder is kept).
 */
function adoptDrawAiData(): void {
	if (process.env.DRAWAI_E2E) return;
	try {
		const now = app.getPath("userData");
		const before = path.join(app.getPath("appData"), "Draw.AI");
		if (path.resolve(now) === path.resolve(before) || !fs.existsSync(before) || fs.existsSync(path.join(now, "settings.json"))) return;
		fs.mkdirSync(now, { recursive: true });
		for (const f of ["settings.json", "drawio-local-storage.json", "mapper-inputs.json"]) {
			const from = path.join(before, f);
			if (fs.existsSync(from) && !fs.existsSync(path.join(now, f))) fs.copyFileSync(from, path.join(now, f));
		}
	} catch (e) {
		console.warn("OmniDraw: could not carry over the Draw.AI settings:", e);
	}
}
adoptDrawAiData();
/** Settings → Appearance → Theme; DRAWAI_THEME=light|dark (checks and screenshots) wins. */
function applyTheme(): void {
	const forced = process.env.DRAWAI_THEME;
	nativeTheme.themeSource = forced === "light" || forced === "dark" ? forced : settings().appearance.theme;
}
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
		message: connect ? "Claude Code and Codex can use OmniDraw" : "Claude Code and Codex disconnected",
		detail:
			results.map((r) => `${r.ok ? "✓" : "✕"} ${r.agent}: ${r.message}`).join("\n") +
			(connect && ok
				? "\n\nIn a new Claude Code or Codex session, the omnidraw tools work on the diagrams open here (pass `file` to pick one) and on their maps: mapper_maps, mapper_find, mapper_show, mapper_path, mapper_run, mapper_findings… Keep OmniDraw open while they work."
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

/**
 * Edit commands whose keys must keep working everywhere: in draw.io's canvas they are its
 * own actions (undo, redo and select all go through its key handler, which a menu shortcut
 * would bypass); in text (the chat, a label being edited, Settings) the system's.
 * Cut, copy and paste are always the system's: draw.io handles their clipboard events.
 */
const ROUTED: Record<string, { accelerator: string; native: (wc: WebContents) => void; drawio?: boolean }> = {
	undo: { accelerator: "CmdOrCtrl+Z", native: (wc) => wc.undo(), drawio: true },
	redo: { accelerator: "Shift+CmdOrCtrl+Z", native: (wc) => wc.redo(), drawio: true },
	cut: { accelerator: "CmdOrCtrl+X", native: (wc) => wc.cut() },
	copy: { accelerator: "CmdOrCtrl+C", native: (wc) => wc.copy() },
	paste: { accelerator: "CmdOrCtrl+V", native: (wc) => wc.paste() },
	selectAll: { accelerator: "CmdOrCtrl+A", native: (wc) => wc.selectAll(), drawio: true },
};

async function routedEdit(win: DiagramWindow | undefined, key: string): Promise<void> {
	const r = ROUTED[key];
	const wc = webContents.getFocusedWebContents() ?? win?.editorView.webContents;
	if (!wc) return;
	if (r.drawio && win && wc === win.editorView.webContents && (await win.runDrawioAction(key))) return;
	r.native(wc);
}

/** draw.io's menu entries (from desktop-menubar.js) as native menu items. */
function drawioItems(win: DiagramWindow, nodes: DrawioMenuItem[] | null | undefined): MenuItemConstructorOptions[] {
	return (nodes ?? []).map((n): MenuItemConstructorOptions => {
		if (n.separator) return { type: "separator" };
		const label = (n.label ?? "").replace(/\.\.\.$/, "…");
		if (n.children) return { label, enabled: n.enabled !== false, submenu: drawioItems(win, n.children) };
		if (n.key && ROUTED[n.key]) return { label, accelerator: ROUTED[n.key].accelerator, click: () => void routedEdit(DiagramWindow.focused(), n.key!) };
		const accelerator = toAccelerator(n.shortcut);
		return {
			label,
			enabled: n.enabled !== false,
			type: n.checked ? "checkbox" : "normal",
			checked: !!n.checked,
			// The app's and the system's own keys win (⌘M minimizes, ⌘W closes…).
			accelerator: accelerator && !RESERVED_KEYS.has(normalizeAccelerator(accelerator)) ? accelerator : undefined,
			// Windows/Linux: shown only (draw.io's key handler does the work). macOS has no such
			// option, so a key the page did not handle arrives here: see invokeDrawioMenuFromKey.
			registerAccelerator: false,
			click: (_item, _window, event) => {
				if (n.id === undefined) return;
				if (event?.triggeredByAccelerator) void win.invokeDrawioMenuFromKey(n.id, webContents.getFocusedWebContents());
				else win.invokeDrawioMenu(n.id);
			},
		};
	});
}

/** Keys the app or macOS own: draw.io's items never take them in the menu bar. */
const RESERVED_KEYS = new Set(
	["Cmd+M", "Cmd+H", "Cmd+Alt+H", "Cmd+Q", "Cmd+W", "Cmd+N", "Cmd+O", "Cmd+S", "Cmd+Shift+S", "Cmd+P", "Cmd+,", "Cmd+J", "Cmd+Shift+N", "Cmd+.", "Cmd+Shift+M", "Cmd+Shift+D", "Cmd+Shift+T", "Cmd+Shift+E", "Cmd+Ctrl+F", "Cmd+`", "F5", "Cmd+Alt+]", "Cmd+Alt+["].map(normalizeAccelerator)
);
function normalizeAccelerator(a: string): string {
	return a.replace(/CmdOrCtrl|CommandOrControl|Command/g, "Cmd").split("+").map((k) => k.trim()).sort().join("+").toLowerCase();
}

let menuTimer: NodeJS.Timeout | undefined;
function scheduleMenu(): void {
	clearTimeout(menuTimer);
	menuTimer = setTimeout(buildMenu, 120);
}

function buildMenu(): void {
	const w = () => DiagramWindow.focused();
	const front = DiagramWindow.focused();
	const dm = front?.drawioMenus;
	const pick = (menu: string, keys: string[]) => drawioItems(front!, (dm?.[menu] ?? []).filter((n) => n.key && keys.includes(n.key)));
	const template: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [
					{
						label: app.name,
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
				...(dm ? pick("file", ["vscode.import"]) : []),
				{ type: "separator" },
				...(dm ? pick("file", ["properties", "pageSetup"]) : []),
				{ label: "Print…", accelerator: "CmdOrCtrl+P", click: () => void w()?.print() },
				{ type: "separator" },
				{ role: "close" },
			],
		},
		dm?.edit?.length ? { label: "Edit", submenu: drawioItems(front!, dm.edit) } : { role: "editMenu" },
		{
			label: "View",
			submenu: [
				...(dm?.view?.length ? [...drawioItems(front!, dm.view), { type: "separator" } as MenuItemConstructorOptions] : []),
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
		...(dm?.arrange?.length ? [{ label: "Arrange", submenu: drawioItems(front!, dm.arrange) }] : []),
		...(dm?.extras?.length ? [{ label: "Extras", submenu: drawioItems(front!, dm.extras) }] : []),
		{
			label: "Shapes",
			submenu: [
				{ label: "Shape Workshop…", accelerator: "CmdOrCtrl+Alt+K", click: () => WorkshopWindow.open(server, "gallery") },
				{ label: "Shape Gallery…", click: () => WorkshopWindow.open(server, "gallery") },
				{ type: "separator" },
				{ label: "Your Shape Folders…", click: () => openSettings("shapes") },
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
				{ label: "Connect Claude Code / Codex to OmniDraw…", click: () => void connectExternalAgents(true) },
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

function openSettings(section?: string): void {
	SettingsWindow.open(server, section);
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
	applyTheme();
	onSettingsChanged((_s, patch) => {
		if ("appearance" in patch) applyTheme();
	});
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
	DiagramWindow.appCommands = { newDiagram: () => void openFile(), open: () => void openDialog(), settings: (section) => openSettings(section), workshop: (mode) => WorkshopWindow.open(server, mode ?? "gallery") };
	SettingsWindow.openWorkshop = () => WorkshopWindow.open(server, "gallery");
	WorkshopWindow.host = {
		insert: async (shape) => {
			const w = DiagramWindow.focused();
			if (!w) return undefined;
			await w.whenLoaded();
			w.insertShape(shape);
			return w.fileName() ?? "the untitled diagram";
		},
		diagramName: () => {
			const w = DiagramWindow.focused();
			return w ? w.fileName() ?? "the untitled diagram" : undefined;
		},
	};
	desktopMcp = new DesktopMcp({
		windows: () => [...DiagramWindow.all],
		focused: () => DiagramWindow.focused(),
		open: (file) => DiagramWindow.open(server, file),
	});
	await desktopMcp.start().catch((e) => console.error("OmniDraw: desktop MCP endpoint did not start:", e));
	buildMenu();
	// draw.io's menus in the menu bar follow the diagram window in front.
	DiagramWindow.onMenus = (w) => {
		if (w === DiagramWindow.focused()) scheduleMenu();
	};
	DiagramWindow.onClosed = () => scheduleMenu();
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
