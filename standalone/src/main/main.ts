import { app, dialog, Menu, MenuItemConstructorOptions, nativeTheme, session, shell, webContents, type WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import { adapterPackages, AGENTS } from "./agents";
import { refreshAdapterVersions, useAdapterCache } from "./adapterVersions";
import { DiagramWindow, type DrawioMenuItem, flushDrawioStorage } from "./diagramWindow";
import { documentWindows } from "./documentShell";
import { sniffExcalidraw } from "./excalidrawFile";
import { ExcalidrawWindow } from "./excalidrawWindow";
import { LiveDialog } from "./liveDialog";
import { toAccelerator } from "./shortcuts";
import { runE2e } from "./e2e";
import { EXPORT_FORMATS } from "./exporter";
import { CATEGORIES } from "./mapper/types";
import { connectAgents, DesktopMcp } from "./desktopMcp";
import { paths } from "./paths";
import { onSettingsChanged, settings } from "./settings";
import { SettingsWindow } from "./settingsWindow";
import { galleries } from "./workshop";
import { WorkshopWindow } from "./workshop/workshopWindow";
import { StaticServer } from "./staticServer";
import { errorDetails, RunLog } from "./runLog";

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
	// It starts like a profile from an earlier version: draw.io's settings name the Scratchpad, nothing is kept for it yet.
	fs.writeFileSync(
		path.join(app.getPath("userData"), "drawio-local-storage.json"),
		JSON.stringify({ ".drawio-config@undefined": JSON.stringify({ language: "", customFonts: [], libraries: "general", customLibraries: ["L.scratchpad"], plugins: [], recentColors: [], formatWidth: 0, sidebarWidth: 232, pageFormat: { x: 0, y: 0, width: 850, height: 1100 }, search: true, darkMode: "auto", autosave: true, openCounter: 0, version: 18, unit: 1, isRulerOn: true, ui: "" }) })
	);
	// Nor the user's ~/.drawio-ai (the desktop MCP endpoint's address file and launcher).
	process.env.DRAWIO_AI_HOME ||= fs.mkdtempSync(path.join(require("os").tmpdir(), "drawai-e2e-home-"));
}
/** When this run started and how it ends: `logs/app.log` in the app's data folder. */
const runLog = new RunLog(path.join(app.getPath("userData"), "logs", "app.log"));
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
} else {
	// (only the copy that runs: one started beside it hands its files over and goes, which is neither
	// a run of its own nor a sign that the running one ended)
	runLog.started({ version: app.getVersion(), pid: process.pid, built: path.basename(paths.out), ...(process.env.DRAWAI_E2E ? { test: "yes" } : {}) });
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
	// (an Excalidraw drawing, by its name or by what a picture carries, opens in the Excalidraw editor)
	if (file && sniffExcalidraw(file, () => fs.readFileSync(file))) await ExcalidrawWindow.open(server, file);
	else await DiagramWindow.open(server, file);
}

/** File → New Excalidraw Drawing: an empty drawing in the Excalidraw editor. */
async function newDrawing(): Promise<void> {
	if (ready) await ExcalidrawWindow.open(server);
}

/** A drawing dropped on an Excalidraw window: it opens as a document, if it is a file that is one. */
async function openDroppedDrawing(file: string): Promise<void> {
	try {
		if (!fs.statSync(file).isFile() || !sniffExcalidraw(file, () => fs.readFileSync(file))) return;
	} catch {
		return;
	}
	await openFile(path.resolve(file));
}

async function openDialog(defaultPath?: string): Promise<void> {
	const r = await dialog.showOpenDialog({
		properties: ["openFile", "multiSelections"],
		defaultPath,
		filters: [{ name: "Diagrams and drawings", extensions: [...DiagramWindow.openFilters[0].extensions, "excalidraw"] }, { name: "All Files", extensions: ["*"] }],
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
	else documentWindows.front()?.win.focus();
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
	["Cmd+M", "Cmd+H", "Cmd+Alt+H", "Cmd+Q", "Cmd+W", "Cmd+N", "Cmd+Alt+N", "Cmd+O", "Cmd+S", "Cmd+Shift+S", "Cmd+P", "Cmd+,", "Cmd+J", "Cmd+Shift+N", "Cmd+.", "Cmd+Shift+M", "Cmd+Shift+D", "Cmd+Shift+T", "Cmd+Shift+E", "Cmd+Ctrl+F", "Cmd+`", "F5", "Cmd+Alt+]", "Cmd+Alt+["].map(normalizeAccelerator)
);
function normalizeAccelerator(a: string): string {
	return a.replace(/CmdOrCtrl|CommandOrControl|Command/g, "Cmd").split("+").map((k) => k.trim()).sort().join("+").toLowerCase();
}

let menuTimer: NodeJS.Timeout | undefined;
function scheduleMenu(): void {
	clearTimeout(menuTimer);
	menuTimer = setTimeout(buildMenu, 120);
}

/** The document in front, of either kind (Save, the chat and the developer tools are the same for both). */
const doc = () => documentWindows.front();

/** The app's own menu (macOS). */
function appMenu(): MenuItemConstructorOptions[] {
	if (process.platform !== "darwin") return [];
	return [
		{
			label: app.name,
			submenu: [{ role: "about" }, { type: "separator" }, { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
		},
	];
}

/** View: the chat beside the document, and the pages' developer tools. */
function chatAndToolsItems(): MenuItemConstructorOptions[] {
	return [
		{ label: "Toggle Chat", accelerator: "CmdOrCtrl+J", click: () => doc()?.toggleChat() },
		{ label: "Wider Chat", accelerator: "CmdOrCtrl+Alt+]", click: () => doc()?.resizeChat(60) },
		{ label: "Narrower Chat", accelerator: "CmdOrCtrl+Alt+[", click: () => doc()?.resizeChat(-60) },
		{ type: "separator" },
		{ label: "Reload Editor", click: () => doc()?.editorView.webContents.reload() },
		{ label: "Editor Developer Tools", click: () => doc()?.editorView.webContents.openDevTools({ mode: "detach" }) },
		{ label: "Chat Developer Tools", click: () => doc()?.chatView.webContents.openDevTools({ mode: "detach" }) },
		{ type: "separator" },
		{ role: "togglefullscreen" },
	];
}

const HELP_MENU: MenuItemConstructorOptions = { role: "help", submenu: [{ label: "Agent Client Protocol", click: () => void shell.openExternal("https://agentclientprotocol.com") }] };

/** Undo, redo and select all in an Excalidraw window: Excalidraw's own on the canvas, the system's in text. */
async function excalidrawEdit(key: "undo" | "redo" | "selectAll"): Promise<void> {
	const front = doc();
	const x = front instanceof ExcalidrawWindow ? front : undefined;
	const wc = webContents.getFocusedWebContents() ?? x?.editorView.webContents;
	if (!wc) return;
	if (x && wc === x.editorView.webContents && (await x.runEdit(key))) return;
	ROUTED[key].native(wc);
}

/**
 * The menu bar while an Excalidraw drawing is in front: the document's commands, and none of
 * draw.io's (its menus, Shapes, the agents and the Mapper work on diagrams).
 */
function excalidrawMenu(): MenuItemConstructorOptions[] {
	const x = () => {
		const front = doc();
		return front instanceof ExcalidrawWindow ? front : undefined;
	};
	return [
		...appMenu(),
		{
			label: "File",
			submenu: [
				{ label: "New Diagram", accelerator: "CmdOrCtrl+N", click: () => void openFile() },
				{ label: "New Excalidraw Drawing", accelerator: "CmdOrCtrl+Alt+N", click: () => void newDrawing() },
				{ label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void openDialog() },
				{ label: "Open Example…", click: () => void openDialog(paths.examples) },
				{ role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] } as MenuItemConstructorOptions,
				{ type: "separator" },
				{ label: "Save", accelerator: "CmdOrCtrl+S", click: () => void x()?.save() },
				{ label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => void x()?.saveAs() },
				{ type: "separator" },
				{ label: "Export as PNG…", accelerator: "CmdOrCtrl+Shift+E", click: () => void x()?.exportInteractive("png") },
				{ label: "Export as SVG…", click: () => void x()?.exportInteractive("svg") },
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ label: "Undo", accelerator: ROUTED.undo.accelerator, click: () => void excalidrawEdit("undo") },
				{ label: "Redo", accelerator: ROUTED.redo.accelerator, click: () => void excalidrawEdit("redo") },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ label: "Select All", accelerator: ROUTED.selectAll.accelerator, click: () => void excalidrawEdit("selectAll") },
			],
		},
		{ label: "View", submenu: chatAndToolsItems() },
		{ role: "windowMenu" },
		HELP_MENU,
	];
}

function buildMenu(): void {
	if (doc() instanceof ExcalidrawWindow) return Menu.setApplicationMenu(Menu.buildFromTemplate(excalidrawMenu()));
	// (while an Excalidraw drawing is in front, nothing here acts on a diagram behind it)
	const w = () => (doc() instanceof ExcalidrawWindow ? undefined : DiagramWindow.focused());
	const front = DiagramWindow.focused();
	const dm = front?.drawioMenus;
	const pick = (menu: string, keys: string[]) => drawioItems(front!, (dm?.[menu] ?? []).filter((n) => n.key && keys.includes(n.key)));
	const template: MenuItemConstructorOptions[] = [
		...appMenu(),
		{
			label: "File",
			submenu: [
				{ label: "New Diagram", accelerator: "CmdOrCtrl+N", click: () => void openFile() },
				{ label: "New Excalidraw Drawing", accelerator: "CmdOrCtrl+Alt+N", click: () => void newDrawing() },
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
				{ label: w()?.live ? "Sharing…" : "Go Live…", accelerator: "CmdOrCtrl+Shift+L", click: () => LiveDialog.open(server, w(), "share") },
				{ label: "Join a Shared Diagram…", click: () => LiveDialog.open(server, w(), "join") },
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
				...chatAndToolsItems(),
			],
		},
		...(dm?.arrange?.length ? [{ label: "Arrange", submenu: drawioItems(front!, dm.arrange) }] : []),
		...(dm?.extras?.length ? [{ label: "Extras", submenu: drawioItems(front!, dm.extras) }] : []),
		{
			label: "Shapes",
			submenu: [
				{ label: "Shape Workshop…", accelerator: "CmdOrCtrl+Alt+K", click: () => WorkshopWindow.open(server, "gallery") },
				{ label: "Find a Shape…", click: () => WorkshopWindow.open(server, "shifter") },
				{ label: "Create a Shape…", click: () => WorkshopWindow.open(server, "creator") },
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
		HELP_MENU,
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
	// the newest Claude Code and Codex adapters (so their model lists are today's), looked up in the background
	useAdapterCache(path.join(app.getPath("userData"), "adapters.json"));
	if (!process.env.DRAWAI_E2E) void refreshAdapterVersions(adapterPackages());
	DiagramWindow.installIpc();
	ExcalidrawWindow.installIpc();
	ExcalidrawWindow.appCommands = { newDrawing: () => void newDrawing(), open: () => void openDialog(), openPath: (file) => void openDroppedDrawing(file), settings: (section) => openSettings(section) };
	// the menu bar follows the kind of document in front
	// (a drawing's window that stays open after all ends a quit, as a diagram's does)
	ExcalidrawWindow.onStayed = () => (DiagramWindow.quitting = false);
	ExcalidrawWindow.onFront = () => scheduleMenu();
	ExcalidrawWindow.onClosed = () => scheduleMenu();
	DiagramWindow.appCommands = { newDiagram: () => void openFile(), newDrawing: () => void newDrawing(), open: () => void openDialog(), settings: (section) => openSettings(section), workshop: (mode) => WorkshopWindow.open(server, mode ?? "gallery") };
	SettingsWindow.openWorkshop = () => WorkshopWindow.open(server, "gallery");
	WorkshopWindow.openSettings = (section) => openSettings(section);
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
		shapeSets: () => (DiagramWindow.all.size ? DiagramWindow.shapeSets : undefined),
		refreshShapeSets: () => DiagramWindow.requestShapeSets(),
		setShapeSet: (id, on) => DiagramWindow.setShapeSet(id, on),
		// the Shape Shifter works on the diagram used last: with none open it has nothing to search, change or convert with
		get shifter() {
			const w = DiagramWindow.focused();
			if (!w) return undefined;
			return {
				searchBuiltIn: (query: string, limit: number) => w.searchOwnShapes(query, limit),
				selectedCells: () => w.selectedCells(),
				applyStyles: (edits: { id: string; props: Record<string, string> }[]) => w.applyStyles(edits),
				askAgent: (request: string, shown: string) => w.askAboutSelection(request, shown),
				convertStencil: (file: string) => w.convertStencil(file),
			};
		},
	};
	DiagramWindow.onShapeSets = () => WorkshopWindow.refresh();
	DiagramWindow.onSelection = () => WorkshopWindow.selection();
	// a collection filled or emptied in the Workshop, a gallery synced: the diagrams' palettes follow
	galleries().onChange(() => DiagramWindow.refreshShapesSoon());
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
	// A shared diagram that ended by someone else's doing: the person is told, and the window that
	// shows who is here follows.
	DiagramWindow.onLive = (win) => {
		LiveDialog.refresh(win);
		if (win === DiagramWindow.focused()) scheduleMenu();
	};
	DiagramWindow.onLiveEnded = (win, why) => {
		LiveDialog.refresh(win);
		if (!win.win.isDestroyed()) void dialog.showMessageBox(win.win, { type: "info", message: why, detail: "The diagram stays here as it was. Save it to keep a copy." });
	};
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
	if (ready && documentWindows.size === 0) void openFile();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin" || process.env.DRAWAI_E2E) app.quit();
});

app.on("before-quit", () => {
	DiagramWindow.quitting = true;
	flushDrawioStorage();
});
app.on("will-quit", () => {
	flushDrawioStorage();
	desktopMcp?.dispose();
	server.dispose();
});

// How this run ends, for the next person who wonders where the app went (see runLog.ts).
// None of these changes what happens: they only write a line.
app.on("quit", (_e, code) => runLog.end("quit", { code, pid: process.pid }));
process.on("uncaughtExceptionMonitor", (e, origin) => runLog.write("error in the app's main process", { ...errorDetails(e), origin, pid: process.pid }));
process.on("unhandledRejection", (e) => runLog.write("a failure nothing handled", { ...errorDetails(e), pid: process.pid }));
app.on("render-process-gone", (_e, contents, details) => runLog.write("a window's page ended", { reason: details.reason, code: details.exitCode, page: pageName(contents.getURL()), pid: process.pid }));
app.on("child-process-gone", (_e, details) => runLog.write("a helper process ended", { type: details.type, reason: details.reason, code: details.exitCode, name: details.name, pid: process.pid }));

/** Which of the app's pages a window shows: its file's name, never the address with what it carries. */
function pageName(url: string): string {
	try {
		return path.basename(new URL(url).pathname) || "editor";
	} catch {
		return "?";
	}
}
