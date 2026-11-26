// End-to-end check of Excalidraw drawings in the real app (`yarn e2e --excalidraw`, see e2e.ts):
// a .excalidraw file opens in the Excalidraw editor, an element added through Excalidraw's own API
// makes it unsaved, the menu bar's Undo, Redo and Save act on it, the saved file reopens with the
// element, PNG and SVG exports carry the drawing and open again for editing, what is not a
// drawing is refused, and the window is screenshot in light and dark.
// Nothing leaves the machine: the page's requests that the app refused are counted, and must be none.
import { dialog, Menu, nativeTheme, session, shell, type WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { E2eConfig } from "./e2e";
import { EXCALIDRAW_SOURCE, parseScene, readScene, sniffExcalidraw } from "./excalidrawFile";
import { ExcalidrawWindow, NO_AI_YET } from "./excalidrawWindow";
import type { StaticServer } from "./staticServer";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await pause(50);
	}
	throw new Error(`Timed out waiting for: ${what}`);
}

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Check failed: ${message}`);
}

/** Runs in the editor page, with `x` as what the page offers the app (Excalidraw's API among it). */
function inEditor<T>(w: ExcalidrawWindow, body: string): Promise<T> {
	return w.editorView.webContents.executeJavaScript(`(async () => { const x = window.omnidrawExcalidraw; const bar = document.getElementById("bar").shadowRoot; ${body} })()`);
}

const elementIds = (w: ExcalidrawWindow) => inEditor<string[]>(w, `return x.api.getSceneElements().map((e) => e.id);`);

/** Adds one element through Excalidraw's API, as an edit of the user's (it can be undone). */
const addElement = (w: ExcalidrawWindow, id: string, type: string, at: { x: number; y: number }) =>
	inEditor<void>(
		w,
		`const [el] = x.convertToExcalidrawElements([{ type: ${JSON.stringify(type)}, id: ${JSON.stringify(id)}, x: ${at.x}, y: ${at.y}, width: 170, height: 110, backgroundColor: "#b2f2bb", fillStyle: "solid" }], { regenerateIds: false });
		x.api.updateScene({ elements: [...x.api.getSceneElementsIncludingDeleted(), el], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`
	);

function menuItem(...labels: string[]): Electron.MenuItem {
	let items = Menu.getApplicationMenu()?.items ?? [];
	let found: Electron.MenuItem | undefined;
	for (const label of labels) {
		found = items.find((i) => i.label === label);
		if (!found) throw new Error(`No menu item ${labels.join(" → ")} (there: ${items.map((i) => i.label).join(", ")})`);
		items = found.submenu?.items ?? [];
	}
	return found!;
}

async function closed(w: ExcalidrawWindow): Promise<void> {
	await until("the window to close", () => w.win.isDestroyed());
}

export async function runExcalidraw(server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const shown: string[] = [];
	ExcalidrawWindow.showError = (title, message) => shown.push(`${title}: ${message}`);
	// what the page asked for and the app refused (anything that is not the app's own server)
	const refused: string[] = [];
	session.defaultSession.webRequest.onErrorOccurred((d) => {
		if (d.error === "net::ERR_BLOCKED_BY_CLIENT") refused.push(d.url);
	});
	const consoleProblems: string[] = [];
	const watch = (wc: WebContents) => {
		wc.on("console-message", (e) => {
			if (e.level === "error" || e.level === "warning") consoleProblems.push(`${e.level}: ${e.message}`.slice(0, 400));
			// DRAWAI_E2E_CONSOLE=1: what the page says, as it says it (to find out why a run stops)
			if (process.env.DRAWAI_E2E_CONSOLE) console.log(`[page ${e.level}] ${e.message.slice(0, 600)} (${e.sourceId}:${e.lineNumber})`);
		});
		wc.on("preload-error", (_e, preload, error) => consoleProblems.push(`error: preload ${path.basename(preload)}: ${error.message}`));
	};

	// ----- open -----
	const t0 = Date.now();
	const first = await ExcalidrawWindow.open(server, config.file);
	expect(first, "the drawing opens");
	watch(first.editorView.webContents);
	await Promise.race([first.whenLoaded(), pause(30_000).then(() => Promise.reject(new Error(`The drawing did not load. The page said: ${consoleProblems.join(" | ") || "nothing"}; shown: ${shown.join(" | ") || "nothing"}`)))]);
	log("loadedMs", Date.now() - t0);
	const before = await elementIds(first);
	log("elementsBefore", before.length);
	expect(before.length === 5, `the sample has 5 elements, the editor shows ${before.length}`);
	expect(first.win.getTitle() === `${path.basename(config.file)} — OmniDraw`, `the title is the file's name: ${first.win.getTitle()}`);
	expect(!first.isDirty, "a drawing that has just opened has no unsaved changes");

	// Excalidraw's fonts come from the app (EXCALIDRAW_ASSET_PATH), not from a CDN
	await until("the hand-drawn font to load", () => inEditor<boolean>(first, `return [...document.fonts].some((f) => f.family === "Excalifont" && f.status === "loaded");`));
	const page = await inEditor<{ assetPath: string; fonts: string[]; theme: string; wasm: string }>(
		first,
		`return {
			assetPath: window.EXCALIDRAW_ASSET_PATH,
			fonts: [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family))],
			theme: document.querySelector(".excalidraw").classList.contains("theme--dark") ? "dark" : "light",
			wasm: await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "allowed", (e) => "refused: " + e.message),
		};`
	);
	log("page", page);
	expect(page.assetPath === "/excalidraw/", "the fonts are served by the app");

	// ----- the bar and the chat -----
	const bar = () => inEditor<{ name: string; unsaved: boolean; saveDisabled: boolean; chatButton: boolean; font: string }>(first, `return { name: bar.getElementById("name").textContent, unsaved: !!bar.getElementById("unsaved"), saveDisabled: bar.getElementById("save").disabled, chatButton: !!bar.getElementById("chat"), font: getComputedStyle(bar.querySelector(".bar")).fontFamily.split(",")[0] };`);
	await until("the bar's styles", () => inEditor<boolean>(first, `return !!bar.querySelector(".bar") && !bar.querySelector(".bar").hidden;`));
	log("bar", await bar());
	expect((await bar()).name === path.basename(config.file) && (await bar()).saveDisabled && !(await bar()).unsaved, "the bar names the drawing, with nothing to save");
	const chat = first.chatView.webContents;
	await until("the chat to say what it cannot do", () => chat.executeJavaScript(`document.body.classList.contains("unavailable")`));
	const chatState = await chat.executeJavaScript(`({ text: document.getElementById("emptyText").textContent, composer: getComputedStyle(document.querySelector("footer")).display, tools: getComputedStyle(document.getElementById("context")).display, pickers: getComputedStyle(document.getElementById("providerBtn")).display })`);
	log("chat", chatState);
	expect(chatState.text === NO_AI_YET && chatState.composer === "none" && chatState.tools === "none" && chatState.pickers === "none", "the chat says AI editing is not there yet, and offers no tools");

	// ----- the menu bar is the drawing's -----
	await until("the menu bar to follow the drawing", () => !!Menu.getApplicationMenu()?.items.some((i) => i.label === "File" && i.submenu?.items.some((s) => s.label === "Export as PNG…")));
	const menus = Menu.getApplicationMenu()!.items.map((i) => i.label);
	log("menus", menus);
	expect(!menus.includes("Agent") && !menus.includes("Map") && !menus.includes("Shapes") && !menus.includes("Arrange"), "none of draw.io's menus while a drawing is in front");

	// ----- screenshots, light and dark -----
	const shot = async (name: string, w: ExcalidrawWindow) => {
		const a = await w.editorView.webContents.capturePage(), b = await w.chatView.webContents.capturePage();
		fs.writeFileSync(path.join(config.out, `${name}-editor.png`), a.toPNG());
		fs.writeFileSync(path.join(config.out, `${name}-chat.png`), b.toPNG());
		// the two views side by side, as the window shows them
		const whole = await inEditor<string>(
			w,
			`const load = (u) => new Promise((r, no) => { const i = new Image(); i.onload = () => r(i); i.onerror = no; i.src = u; });
			const [a, b] = await Promise.all([load(${JSON.stringify(a.toDataURL())}), load(${JSON.stringify(b.toDataURL())})]);
			const c = document.createElement("canvas"); c.width = a.width + b.width; c.height = Math.max(a.height, b.height);
			const g = c.getContext("2d"); g.drawImage(a, 0, 0); g.drawImage(b, a.width, 0);
			return c.toDataURL("image/png");`
		);
		fs.writeFileSync(path.join(config.out, `${name}.png`), Buffer.from(whole.split(",")[1], "base64"));
	};
	const themes: Record<string, unknown> = {};
	for (const theme of ["light", "dark"] as const) {
		nativeTheme.themeSource = theme;
		await until(`Excalidraw's ${theme} theme`, () => inEditor<boolean>(first, `return document.querySelector(".excalidraw").classList.contains("theme--dark") === ${theme === "dark"};`));
		await pause(600);
		themes[theme] = await inEditor(first, `return { bar: getComputedStyle(bar.querySelector(".bar")).backgroundColor, ink: getComputedStyle(bar.querySelector(".bar")).color, canvas: x.api.getAppState().theme };`);
		await shot(`window-${theme}`, first);
	}
	log("themes", themes);
	nativeTheme.themeSource = "light";
	await pause(300);

	// ----- edit through Excalidraw's API: unsaved, undo and redo from the menu bar -----
	await addElement(first, "e2e-diamond", "diamond", { x: 290, y: 250 });
	await until("the drawing to have unsaved changes", () => first.isDirty);
	expect(first.win.getTitle() === `${path.basename(config.file)} • — OmniDraw`, `the title marks unsaved changes: ${first.win.getTitle()}`);
	await until("the bar's unsaved dot", async () => (await bar()).unsaved && !(await bar()).saveDisabled);
	menuItem("Edit", "Undo").click();
	await until("Edit → Undo to take the element away", async () => !(await elementIds(first)).includes("e2e-diamond"));
	menuItem("Edit", "Redo").click();
	await until("Edit → Redo to bring it back", async () => (await elementIds(first)).includes("e2e-diamond"));
	menuItem("Edit", "Select All").click();
	await until("Edit → Select All to select the drawing's elements", () => inEditor<boolean>(first, `return Object.keys(x.api.getAppState().selectedElementIds).length >= 4;`));
	log("undoRedoSelectAllFromMenu", true);
	// the bar while there is something to save: Save is the one ink button
	const saveButton = await inEditor<{ primary: boolean; background: string }>(first, `const b = bar.getElementById("save"); await new Promise((r) => setTimeout(r, 400)); return { primary: b.classList.contains("btn-primary"), background: getComputedStyle(b).backgroundColor };`);
	log("saveButtonWhenUnsaved", saveButton);
	expect(saveButton.primary, "Save is the primary button while there are unsaved changes");
	await shot("window-edited", first);

	// ----- the chat closes and opens again (View → Toggle Chat, and the button in the bar) -----
	const chatWidth = () => first.chatView.getBounds().width, editorWidth = () => first.editorView.getBounds().width, windowWidth = () => first.win.getContentBounds().width;
	expect(first.chatView.getVisible() && editorWidth() + chatWidth() === windowWidth(), "the chat is beside the editor");
	menuItem("View", "Toggle Chat").click();
	await until("the chat to close", async () => !first.chatView.getVisible() && editorWidth() === windowWidth() && (await bar()).chatButton);
	await inEditor(first, `bar.getElementById("chat").click();`);
	await until("the bar's button to open the chat again", async () => first.chatView.getVisible() && editorWidth() + chatWidth() === windowWidth() && !(await bar()).chatButton);
	log("chatClosesAndOpens", true);

	// ----- save: File → Save, and the key (Cmd/Ctrl+S goes to the app, not to Excalidraw) -----
	menuItem("File", "Save").click();
	await until("the drawing to be saved", () => !first.isDirty);
	await addElement(first, "e2e-keyed", "rectangle", { x: 700, y: 260 });
	await until("unsaved changes again", () => first.isDirty);
	first.editorView.webContents.sendInputEvent({ type: "keyDown", keyCode: "s", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
	first.editorView.webContents.sendInputEvent({ type: "keyUp", keyCode: "s", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
	await until("Cmd/Ctrl+S to save the drawing", () => !first.isDirty && parseScene(fs.readFileSync(config.file, "utf8")).elements.some((e: any) => e.id === "e2e-keyed"));
	log("saveKey", true);
	// (back to the six elements the rest of the run counts)
	await inEditor(first, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().filter((e) => e.id !== "e2e-keyed"), captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	await until("unsaved changes again", () => first.isDirty);
	menuItem("File", "Save").click();
	await until("the drawing to be saved", () => !first.isDirty);
	const saved = JSON.parse(fs.readFileSync(config.file, "utf8"));
	log("savedFile", { type: saved.type, version: saved.version, source: saved.source, elements: saved.elements.length, appState: Object.keys(saved.appState).length, files: Object.keys(saved.files).length });
	expect(saved.type === "excalidraw" && saved.version === 2 && saved.source === EXCALIDRAW_SOURCE, "the file is Excalidraw's JSON, version 2, with the app as its source");
	expect(Array.isArray(saved.elements) && saved.elements.length === 6 && saved.elements.some((e: any) => e.id === "e2e-diamond" && e.type === "diamond"), "the added element is in the file");
	expect(saved.appState && typeof saved.appState === "object" && saved.files && typeof saved.files === "object", "the file has appState and files");
	expect(first.win.getTitle() === `${path.basename(config.file)} — OmniDraw` && (await bar()).saveDisabled, "nothing is unsaved after the save");

	// ----- a setting that is saved with the drawing (the grid) is a change to save -----
	await inEditor(first, `x.api.updateScene({ appState: { gridModeEnabled: true } });`);
	await until("the grid to count as an unsaved change", async () => first.isDirty && !(await bar()).saveDisabled);
	menuItem("File", "Save").click();
	await until("the drawing to be saved with its grid", () => !first.isDirty && JSON.parse(fs.readFileSync(config.file, "utf8")).appState.gridModeEnabled === true);
	// (what is not saved with a drawing is not a change: the view moved, something selected)
	await inEditor(first, `x.api.updateScene({ appState: { scrollX: x.api.getAppState().scrollX + 40, zoom: { value: 1.1 } } });`);
	await pause(300);
	expect(!first.isDirty, "moving the view is not an unsaved change");
	await inEditor(first, `x.api.updateScene({ appState: { gridModeEnabled: false, scrollX: x.api.getAppState().scrollX - 40, zoom: { value: 1 } } });`);
	await until("unsaved changes again", () => first.isDirty);
	menuItem("File", "Save").click();
	await until("the drawing to be saved", () => !first.isDirty);
	log("gridIsSaved", true);

	// ----- an export under a name that gets its ending added: an existing file of that name is asked about -----
	const typed = path.join(config.out, "typed.svg"), becomes = `${typed}.png`;
	fs.writeFileSync(becomes, "something else that is already there");
	const dialogs = { save: dialog.showSaveDialog, box: dialog.showMessageBox, reveal: shell.showItemInFolder };
	const replaceAsked: string[] = [];
	const asks = (): number => replaceAsked.length;
	const replaceAnswers = [1, 0]; // Cancel, then Replace
	(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: typed });
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		replaceAsked.push(String(options.message));
		return { response: replaceAnswers.shift() ?? 1, checkboxChecked: false };
	};
	(shell as any).showItemInFolder = () => undefined;
	try {
		await first.exportInteractive("png");
		expect(asks() === 1 && fs.readFileSync(becomes, "utf8") === "something else that is already there", "Cancel leaves the file that was there");
		await first.exportInteractive("png");
		expect(asks() === 2 && sniffExcalidraw(becomes, () => fs.readFileSync(becomes)) === "png" && !fs.existsSync(typed), "Replace writes the export under the name with its ending");
	} finally {
		(dialog as any).showSaveDialog = dialogs.save;
		(dialog as any).showMessageBox = dialogs.box;
		(shell as any).showItemInFolder = dialogs.reveal;
	}
	log("exportNameWithEndingAdded", replaceAsked);

	// ----- exports carry the drawing -----
	const png = path.join(config.out, "export.png"), svg = path.join(config.out, "export.svg");
	expect(await first.exportTo("png", png), "export as PNG");
	expect(await first.exportTo("svg", svg), "export as SVG");
	const svgText = fs.readFileSync(svg, "utf8");
	const exports = {
		png: { bytes: fs.statSync(png).size, kind: sniffExcalidraw(png, () => fs.readFileSync(png)), elements: readScene("png", fs.readFileSync(png)).elements.length },
		// (the SVG holds its fonts, cut down to the letters the drawing uses: Excalidraw does that with WebAssembly, in a worker)
		svg: { bytes: svgText.length, kind: sniffExcalidraw(svg, () => fs.readFileSync(svg)), elements: readScene("svg", fs.readFileSync(svg)).elements.length, fontBytes: (svgText.match(/url\(data:font[^)]*\)/g) ?? []).reduce((n, u) => n + u.length, 0) },
	};
	log("exports", exports);
	expect(exports.svg.fontBytes > 0 && exports.svg.fontBytes < 20_000, `the SVG's fonts hold only the letters used (${exports.svg.fontBytes} bytes)`);
	expect(exports.png.kind === "png" && exports.png.elements === 6 && exports.svg.kind === "svg" && exports.svg.elements === 6, "both exports carry the drawing's 6 elements");
	expect(!first.isDirty && first.file === config.file, "an export changes neither the drawing nor its file");

	// ----- a new drawing (it stays open to the end: a test run ends when its last window closes) -----
	const fresh = await ExcalidrawWindow.open(server);
	expect(fresh, "a new drawing opens");
	watch(fresh.editorView.webContents);
	await fresh.whenLoaded();
	expect(fresh.win.getTitle() === "Untitled drawing — OmniDraw" && (await elementIds(fresh)).length === 0, "a new drawing is empty and untitled");

	// ----- reopen the saved file -----
	first.win.close();
	await closed(first);
	const again = await ExcalidrawWindow.open(server, config.file);
	expect(again, "the saved drawing opens again");
	watch(again.editorView.webContents);
	await again.whenLoaded();
	const reopened = await elementIds(again);
	log("elementsReopened", reopened.length);
	expect(reopened.length === 6 && reopened.includes("e2e-diamond"), "the reopened drawing has the added element");

	// ----- the question before a window with unsaved changes closes -----
	const asked: string[] = [];
	const answers = [2, 1]; // Cancel, then Don't Save
	const realMessageBox = dialog.showMessageBox;
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		asked.push(`${options.message} [${(options.buttons ?? []).join(" / ")}]`);
		return { response: answers.shift() ?? 2, checkboxChecked: false };
	};
	try {
		await addElement(again, "e2e-unsaved", "ellipse", { x: 520, y: 260 });
		await until("unsaved changes", () => again.isDirty);
		again.win.close();
		await until("the question to be asked", () => asked.length === 1);
		await pause(200);
		expect(!again.win.isDestroyed(), "Cancel keeps the window open");
		again.win.close();
		await closed(again);
	} finally {
		(dialog as any).showMessageBox = realMessageBox;
	}
	log("closeQuestion", asked);
	expect(asked.length === 2 && asked[0] === `Save changes to ${path.basename(config.file)}? [Save / Don't Save / Cancel]`, "the window asks before it closes with unsaved changes");
	expect(parseScene(fs.readFileSync(config.file, "utf8")).elements.length === 6, "Don't Save leaves the file as it was");

	// ----- Save in that question, and a change made while the file is written: the window does not close over it -----
	const late = await ExcalidrawWindow.open(server, png);
	expect(late, "the exported PNG opens");
	watch(late.editorView.webContents);
	await late.whenLoaded();
	await addElement(late, "e2e-before-save", "rectangle", { x: 60, y: 260 });
	await until("unsaved changes", () => late.isDirty);
	// (the change arrives after the editor has handed the picture over, and before the file is written)
	const contents = (late as any).contents.bind(late);
	let changedMeanwhile = false;
	(late as any).contents = async (format: string) => {
		const handed = await contents(format);
		if (!changedMeanwhile) {
			changedMeanwhile = true;
			await addElement(late, "e2e-while-saving", "ellipse", { x: 300, y: 420 });
		}
		return handed;
	};
	asked.length = 0;
	answers.push(0, 2); // Save, then Cancel when it asks again
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		asked.push(String(options.message));
		return { response: answers.shift() ?? 2, checkboxChecked: false };
	};
	try {
		late.win.close();
		await until("the question to be asked again after the save", () => asked.length === 2);
		await pause(300);
	} finally {
		(dialog as any).showMessageBox = realMessageBox;
	}
	const lateSaved = readScene("png", fs.readFileSync(png)).elements.map((e: any) => e.id);
	log("changedWhileSaving", { asked: asked.length, open: !late.win.isDestroyed(), unsaved: late.isDirty, saved: lateSaved.includes("e2e-before-save"), lateChangeInFile: lateSaved.includes("e2e-while-saving") });
	expect(!late.win.isDestroyed() && late.isDirty, "the window stays open, with the later change unsaved");
	expect(lateSaved.includes("e2e-before-save") && !lateSaved.includes("e2e-while-saving"), "the file has what was there when Save was chosen");
	expect(await late.save(), "the later change is saved");
	expect(!late.isDirty && readScene("png", fs.readFileSync(png)).elements.length === 8, "after a save nothing is unsaved, and the file has both changes");
	late.win.close();
	await closed(late);
	// (back to the six elements the rest of the run counts)
	const back = await ExcalidrawWindow.open(server, png);
	expect(back, "the PNG opens again");
	await back.whenLoaded();
	await inEditor(back, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().filter((e) => !e.id.startsWith("e2e-before") && !e.id.startsWith("e2e-while")), captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	await until("unsaved changes", () => back.isDirty);
	expect(await back.save(), "the PNG is saved with its six elements");
	back.win.close();
	await closed(back);

	// ----- an exported picture opens for editing, and is saved back as the picture -----
	const results: Record<string, unknown> = {};
	for (const picture of [png, svg]) {
		const format = picture.endsWith(".png") ? "png" : "svg";
		const w = await ExcalidrawWindow.open(server, picture);
		expect(w, `the exported ${format} opens`);
		watch(w.editorView.webContents);
		await w.whenLoaded();
		expect((await elementIds(w)).length === 6, `the exported ${format} opens with the drawing's 6 elements`);
		await addElement(w, `e2e-in-${format}`, "rectangle", { x: 60, y: 260 });
		await until("unsaved changes", () => w.isDirty);
		expect(await w.save(), `the ${format} is saved`);
		await until("the picture to be saved", () => !w.isDirty);
		const scene = readScene(format, fs.readFileSync(picture));
		results[format] = { elements: scene.elements.length, stillAPicture: format === "png" ? fs.readFileSync(picture).subarray(1, 4).toString("latin1") === "PNG" : /^<svg/.test(fs.readFileSync(picture, "utf8")) };
		expect(scene.elements.length === 7 && scene.elements.some((e: any) => e.id === `e2e-in-${format}`), `the saved ${format} carries the new element`);
		w.win.close();
		await closed(w);
	}
	log("picturesEditedAndSaved", results);

	// ----- the new drawing, saved under a name -----
	await addElement(fresh, "e2e-first", "rectangle", { x: 100, y: 100 });
	await until("unsaved changes", () => fresh.isDirty);
	const named = path.join(config.out, "new.excalidraw");
	expect(await fresh.saveTo(named), "the new drawing is saved under a name");
	await until("the new drawing to be saved", () => !fresh.isDirty);
	log("newDrawing", { title: fresh.win.getTitle(), elements: parseScene(fs.readFileSync(named, "utf8")).elements.length });
	expect(fresh.file === named && fresh.win.getTitle() === "new.excalidraw — OmniDraw" && parseScene(fs.readFileSync(named, "utf8")).elements.length === 1, "it has its name and its one element");
	// the same file is not opened twice
	expect((await ExcalidrawWindow.open(server, named)) === fresh, "a drawing that is open comes to the front instead of opening again");

	// ----- a .excalidraw file dropped on the window opens as a document of its own -----
	const dropped = path.join(config.out, "dropped.excalidraw");
	fs.copyFileSync(config.file, dropped);
	const dbg = fresh.editorView.webContents.debugger;
	dbg.attach("1.3");
	try {
		const data = { items: [], files: [dropped], dragOperationsMask: 1 };
		for (const type of ["dragEnter", "dragOver", "drop"]) await dbg.sendCommand("Input.dispatchDragEvent", { type, x: 500, y: 500, data });
	} finally {
		dbg.detach();
	}
	await until("the dropped drawing to open in a window of its own", () => [...ExcalidrawWindow.all].some((w) => w.file === dropped));
	const droppedWindow = [...ExcalidrawWindow.all].find((w) => w.file === dropped)!;
	await droppedWindow.whenLoaded();
	expect((await elementIds(droppedWindow)).length === 6 && (await elementIds(fresh)).length === 1 && !fresh.isDirty, "the dropped drawing is in its own window, and the window it was dropped on is unchanged");
	log("droppedDrawingOpens", true);
	droppedWindow.win.close();
	await closed(droppedWindow);

	// ----- Excalidraw's Mermaid import works offline (it is part of the package, loaded when used) -----
	await inEditor(fresh, `x.api.updateScene({ appState: { openDialog: { name: "ttd", tab: "mermaid" } } });`);
	await until("the Mermaid dialog to draw its preview", () => inEditor<boolean>(fresh, `return !!document.querySelector(".ttd-dialog-output-canvas-container canvas") && !document.querySelector(".ttd-dialog-output-error");`), 30_000);
	await inEditor(fresh, `document.querySelector(".ttd-dialog-panel-button-container:not(.invisible) .ttd-dialog-panel-button").click();`);
	await until("the Mermaid diagram to be inserted", async () => (await elementIds(fresh)).length > 1);
	log("mermaidImport", { elements: (await elementIds(fresh)).length });

	// ----- what is not a drawing is refused, and no window opens -----
	const windows = ExcalidrawWindow.all.size;
	const refusals: Record<string, string | undefined> = {};
	const notDrawings: Record<string, string | Buffer> = {
		"library.excalidraw": JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: [] }),
		"text.excalidraw": "not a drawing at all",
		"other.excalidraw": JSON.stringify({ type: "something-else", elements: [] }),
		"plain.png": await plainPng(fresh),
	};
	for (const [name, content] of Object.entries(notDrawings)) {
		const file = path.join(config.out, name);
		fs.writeFileSync(file, content);
		shown.length = 0;
		const w = await ExcalidrawWindow.open(server, file);
		refusals[name] = shown[0];
		expect(!w && shown.length === 1 && ExcalidrawWindow.all.size === windows, `${name} is refused with a message, and no window opens`);
	}
	log("refused", refusals);
	expect(sniffExcalidraw(path.join(config.out, "plain.png"), () => fs.readFileSync(path.join(config.out, "plain.png"))) === undefined, "a picture without a drawing is not taken for one (it opens as before, in draw.io)");

	// ----- nothing was asked of the network, and the pages had nothing to complain about -----
	log("refusedRequests", refused);
	log("consoleProblems", consoleProblems);
	log("errorsShown", shown.length);
	expect(refused.length === 0, `the Excalidraw page asked for something outside the app: ${refused.join(", ")}`);
	const serious = consoleProblems.filter((m) => /Content Security Policy|Refused to|Failed to load|wasm|WebAssembly|subset/i.test(m));
	expect(serious.length === 0, `the Excalidraw page reported: ${serious.join(" | ")}`);
}

/** A PNG with no drawing in it: a screenshot of the editor. */
async function plainPng(w: ExcalidrawWindow): Promise<Buffer> {
	return (await w.editorView.webContents.capturePage()).toPNG();
}
