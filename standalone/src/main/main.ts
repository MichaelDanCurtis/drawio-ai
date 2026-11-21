import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, session, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AGENTS } from "./agents";
import { DiagramWindow } from "./diagramWindow";
import { runE2e } from "./e2e";
import { EXPORT_FORMATS } from "./exporter";
import { paths } from "./paths";
import { settingsPath, updateSettings } from "./settings";
import { StaticServer } from "./staticServer";

app.setName("Draw.AI");
// Test runs get their own data folder: they must not touch the user's settings, or
// hang on the data folder of a copy of the app that is already running.
if (process.env.DRAWAI_E2E) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "drawai-e2e-data-")));
const server = new StaticServer();
const pendingFiles: string[] = [];
let ready = false;

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
				{
					label: "Export As",
					submenu: EXPORT_FORMATS.map((f) => ({
						label: f.label,
						accelerator: f.format === "pdf" ? "CmdOrCtrl+Shift+E" : undefined,
						click: () => void w()?.exportInteractive(f.format),
					})),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
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
				{ label: "Keep AI Changes", click: () => w()?.client.aiResolveReview("accept") },
				{ label: "Revert AI Changes", click: () => w()?.client.aiResolveReview("reject") },
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
	if (ready && BrowserWindow.getAllWindows().length === 0) void openFile();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin" || process.env.DRAWAI_E2E) app.quit();
});

app.on("will-quit", () => server.dispose());
