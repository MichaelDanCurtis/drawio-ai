// End-to-end check of the home screen in the real app (`yarn e2e --home`, see e2e.ts): a library
// folder of this run's own is shown as cards with pictures, a drawing and a diagram are made from
// the home screen and saved (each save a version, and a picture from the editor), a document is
// renamed, moved and trashed from the home screen while it is open in a window, a version is gone
// back to, the trash gives back and deletes, and the window is screenshot in light and dark.
// No agent is started and nothing leaves the machine.
import { dialog, nativeTheme } from "electron";
import * as fs from "fs";
import * as path from "path";
import { DiagramWindow } from "./diagramWindow";
import { documentWindows } from "./documentShell";
import type { AppCommands, E2eConfig } from "./e2e";
import { addElement, elementIds, expect, pause, until } from "./e2eExcalidraw";
import { ExcalidrawWindow } from "./excalidrawWindow";
import { HomeWindow } from "./homeWindow";
import { paths } from "./paths";
import { updateSettings } from "./settings";

export async function runHome(config: E2eConfig, log: (k: string, v: unknown) => void, app: AppCommands): Promise<void> {
	const openFile = app.openFile;
	process.env.DRAWAI_E2E_API = "1";
	const folder = path.join(path.dirname(config.out), "library");
	updateSettings({ agent: "api:stand-in", library: { folder } });
	const shown: string[] = [];
	ExcalidrawWindow.showError = (title, message) => shown.push(`${title}: ${message}`);

	// ----- a library that has things in it already, as one a person has used: put there by hand -----
	fs.mkdirSync(path.join(folder, "Team"), { recursive: true });
	fs.copyFileSync(config.file, path.join(folder, "Team", "Plan.excalidraw"));
	const diagram = path.join(paths.examples, "use-cases", "cloud-architecture.drawio");
	if (fs.existsSync(diagram)) fs.copyFileSync(diagram, path.join(folder, "Cloud architecture.drawio"));
	const picture = path.join(paths.appDir, "test/fixtures/excalidraw/exported.excalidraw.png");
	if (fs.existsSync(picture)) fs.copyFileSync(picture, path.join(folder, "Team", "Whiteboard.excalidraw.png"));
	fs.writeFileSync(path.join(folder, "notes.txt"), "not a document");
	// (a link to a file elsewhere is not one of the library's)
	const outside = path.join(path.dirname(config.out), "elsewhere.drawio");
	fs.writeFileSync(outside, fs.existsSync(diagram) ? fs.readFileSync(diagram) : "<mxfile/>");
	fs.symlinkSync(outside, path.join(folder, "Linked.drawio"));
	const seeded = fs.readdirSync(folder, { recursive: true }).filter((n) => /\.(excalidraw|drawio)(\.png)?$/.test(String(n)) && !String(n).startsWith("Linked")).length;

	// (through the same door as Window → Home and the app's start with no file)
	app.showHome();
	const home = HomeWindow.window!;
	const page = home.webContents;
	const inHome = <T>(body: string): Promise<T> => page.executeJavaScript(`(async () => { ${body} })()`);
	const send = (msg: unknown) => inHome<void>(`window.omnidrawHome.post(${JSON.stringify(msg)});`);
	const cards = () =>
		inHome<{ name: string; sub: string; img: boolean; open: string | null }[]>(
			`return [...document.querySelectorAll(".doc")].map((n) => ({ name: n.querySelector(".name")?.textContent ?? "", sub: n.querySelector(".sub")?.textContent ?? "", img: !!n.querySelector(".shot img"), open: n.querySelector(".open") ? (n.querySelector(".open").hasAttribute("data-unsaved") ? "unsaved" : "open") : null }));`
		);
	const nav = () => inHome<string[]>(`return [...document.querySelectorAll("#nav .nav")].map((b) => b.textContent.trim());`);
	const go = (label: string) => inHome<void>(`[...document.querySelectorAll("#nav .nav")].find((b) => b.querySelector(".t").textContent === ${JSON.stringify(label)}).click();`);
	const said = () => inHome<string | null>(`const s = document.getElementById("said"); return s.hidden ? null : s.textContent;`);
	const lib = () => HomeWindow.library();
	const shot = async (name: string) => {
		const still = "*, *::before, *::after { animation: none !important; transition: none !important; }";
		// (a window behind another is not drawn: the picture would be of what it showed when it last was)
		home.show();
		home.focus();
		home.moveTop();
		await pause(400);
		const key = await page.insertCSS(still);
		await pause(200);
		fs.writeFileSync(path.join(config.out, `${name}.png`), (await page.capturePage()).toPNG());
		await page.removeInsertedCSS(key);
	};
	const drawing = (name: string) => [...ExcalidrawWindow.all].find((w) => w.file && path.basename(w.file) === name);

	await until("the home screen to list the library", async () => (await cards()).length === seeded);
	await until("every card to have its picture", async () => (await cards()).every((c) => c.img));
	const first = await cards();
	log("homeCards", first);
	log("homeNav", await nav());
	expect(seeded >= 1 && first.some((c) => c.name === "Plan" && /Drawing/.test(c.sub) && /Team/.test(c.sub)), "a drawing in a folder is a card, with its collection");
	expect(!first.some((c) => c.name === "Linked" || c.name === "notes"), "what is not a document, and a link to one elsewhere, is not listed");
	expect((await nav()).some((n) => /^Team\s*\d/.test(n.replace(/\s+/g, " "))) || (await nav()).some((n) => n.startsWith("Team")), "the folder is a collection in the rail");
	nativeTheme.themeSource = "light";
	await pause(300);
	await shot("home-light");
	nativeTheme.themeSource = "dark";
	await pause(300);
	await shot("home-dark");
	nativeTheme.themeSource = "light";
	// (every picture shows the whole of its document: none is larger than its place on the card)
	const fits = await inHome<boolean>(`return [...document.querySelectorAll(".doc .shot")].every((s) => { const i = s.querySelector("img").getBoundingClientRect(), b = s.getBoundingClientRect(); return i.width <= b.width + 1 && i.height <= b.height + 1; });`);
	expect(fits, "a card's picture is within the card");

	// ----- a new drawing, made from the home screen: a file in the library at once, open in its editor -----
	await inHome<void>(`document.getElementById("newDrawing").click();`);
	await until("the new drawing's window", () => !!drawing("Untitled.excalidraw"));
	const w = drawing("Untitled.excalidraw")!;
	await w.whenLoaded();
	expect(fs.existsSync(path.join(folder, "Untitled.excalidraw")) && w.file === path.join(lib().root, "Untitled.excalidraw"), "a new drawing is a file in the library, and the window is that file's");
	await until("the card to say it is open", async () => (await cards()).find((c) => c.name === "Untitled")?.open === "open");
	expect(lib().versions("Untitled.excalidraw").length === 1 && lib().versions("Untitled.excalidraw")[0].kept, "the document as it was opened is kept as a version");
	await addElement(w, "home-1", "rectangle", { x: 100, y: 100 });
	await until("the card to say it has unsaved changes", async () => (await cards()).find((c) => c.name === "Untitled")?.open === "unsaved", 20_000).catch(() => undefined);
	expect(await w.save(), "the drawing is saved");
	await until("the save to be a version", () => lib().versions("Untitled.excalidraw").length === 2);
	await until("the editor's picture of it to be kept", () => !!lib().thumb("Untitled.excalidraw"));
	log("homeSaved", { versions: lib().versions("Untitled.excalidraw").map((v) => [v.kept, v.size]), picture: lib().thumb("Untitled.excalidraw")!.length });

	// ----- renamed and moved from the home screen while it is open: the window follows -----
	await send({ type: "rename", id: "Untitled.excalidraw", name: "Roadmap" });
	await until("the window to be the renamed file's", () => w.file === path.join(lib().root, "Roadmap.excalidraw"));
	expect(/^Roadmap\.excalidraw/.test(w.win.getTitle()) && fs.existsSync(w.file!) && !fs.existsSync(path.join(folder, "Untitled.excalidraw")), "renaming a document renames its file, and the open window is the new file's");
	await send({ type: "newCollection", name: "Clients" });
	await until("the new collection", async () => (await nav()).some((n) => n.startsWith("Clients")));
	await send({ type: "move", id: "Roadmap.excalidraw", collection: "Clients" });
	const moved = "Clients/Roadmap.excalidraw";
	await until("the window to be the moved file's", () => w.file === lib().pathOf(moved));
	expect(lib().versions(moved).length === 2 && !!lib().thumb(moved), "its versions and its picture went with it");
	// a save after the move is the same document's: a second save within minutes is the same version, in its new state
	await addElement(w, "home-2", "ellipse", { x: 400, y: 100 });
	expect(await w.save(), "saved again where it now is");
	await until("the version to have the new state", () => lib().versionBytes(moved, lib().versions(moved)[0].key).includes("home-2"));
	expect(lib().versions(moved).length === 2, "saves close together are one version");
	// (names that are no names are refused, and said)
	await send({ type: "rename", id: moved, name: "../escape" });
	await until("the refusal to be said", async () => /cannot have/.test((await said()) ?? ""));
	expect(w.file === lib().pathOf(moved), "a name that is a path changes nothing");

	// ----- its versions, in the panel; going back to how it was opened -----
	await go("Clients");
	await until("the collection's one card", async () => (await cards()).length === 1 && (await cards())[0].name === "Roadmap");
	await inHome<void>(`document.querySelector(".doc .more").click(); [...document.querySelectorAll(".menu [role=menuitem]")].find((b) => b.textContent.startsWith("Versions")).click();`);
	await until("the versions to be listed", () => inHome<boolean>(`return document.querySelectorAll("#versions li button").length === 2 && !!document.querySelector("#sideLook img");`));
	await shot("home-versions");
	await inHome<void>(`[...document.querySelectorAll("#versions li button")].pop().click();`);
	await pause(200);
	await inHome<void>(`document.getElementById("goBack").click();`);
	// (the window had nothing unsaved: it closes, the file goes back, and it opens again)
	await until("the document to be as it was opened, in a window again", async () => {
		const again = drawing("Roadmap.excalidraw");
		return !!again && again !== w && !again.win.isDestroyed() && (await again.whenLoaded().then(() => elementIds(again))).length === 0;
	});
	// (what it was before going back was its last save: that version is kept from now on, and no later save takes its place)
	expect(lib().versions(moved).length === 2 && lib().versions(moved)[0].kept && lib().versionBytes(moved, lib().versions(moved)[0].key).includes("home-2"), "what it was before going back is kept, so that going back can be gone back on");

	// ----- unsaved changes are not thrown out with the file -----
	const again = drawing("Roadmap.excalidraw")!;
	await addElement(again, "home-3", "diamond", { x: 100, y: 300 });
	await until("the window to have unsaved changes", () => again.isDirty);
	await send({ type: "trash", id: moved });
	await until("the refusal to be said", async () => /changes that are not saved/.test((await said()) ?? ""));
	expect(fs.existsSync(lib().pathOf(moved)) && !again.win.isDestroyed(), "a document with unsaved changes is not moved to the trash");
	expect(await again.save(), "saved");

	// ----- the trash: the window closes, the document is there with its versions, and comes back -----
	await send({ type: "trash", id: moved });
	await until("the document to be in the trash", () => lib().contents().trash.length === 1 && again.win.isDestroyed());
	expect(!fs.existsSync(lib().pathOf(moved)), "its file is out of the library's folder");
	await go("Trash");
	await until("the trash to show it", async () => (await cards()).length === 1 && (await cards())[0].name === "Roadmap" && (await cards())[0].img);
	await shot("home-trash");
	await send({ type: "restore", trashId: lib().contents().trash[0].id });
	await until("the document to be back", () => fs.existsSync(lib().pathOf(moved)) && lib().contents().trash.length === 0);
	expect(lib().versions(moved).length >= 3, "it is back with its versions");
	// for good, after being asked
	const asked: string[] = [];
	const realBox = dialog.showMessageBox;
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		asked.push(options.message);
		return { response: asked.length === 1 ? 1 : 0, checkboxChecked: false };
	};
	try {
		await send({ type: "trash", id: moved });
		await until("it to be in the trash again", () => lib().contents().trash.length === 1);
		const trashId = lib().contents().trash[0].id;
		await send({ type: "deleteForever", trashId });
		await until("the question", () => asked.length === 1);
		await pause(200);
		expect(lib().contents().trash.length === 1, "Cancel deletes nothing");
		await send({ type: "emptyTrash" });
		await until("the trash to be empty", () => lib().contents().trash.length === 0);
		expect(asked.length === 2 && /for good/.test(asked[0]) && /for good/.test(asked[1]), "deleting for good is asked about");
	} finally {
		(dialog as any).showMessageBox = realBox;
	}

	// ----- a new diagram, from the home screen: saved, it has a version and the editor's picture too -----
	await go("All documents");
	if (fs.existsSync(path.join(paths.webapp, "index.html"))) {
		await inHome<void>(`document.getElementById("newDiagram").click();`);
		await until("the new diagram's window", () => [...DiagramWindow.all].some((d) => d.file === path.join(lib().root, "Untitled.drawio")));
		const d = [...DiagramWindow.all].find((x) => x.file === path.join(lib().root, "Untitled.drawio"))!;
		await d.whenLoaded();
		expect(await d.save(), "the diagram is saved");
		await until("the diagram's version and picture", () => lib().versions("Untitled.drawio").length >= 1 && !!lib().thumb("Untitled.drawio"), 30_000);
		log("homeDiagram", { versions: lib().versions("Untitled.drawio").length, picture: lib().thumb("Untitled.drawio")!.length });
		// a collection renamed with an open document in it; then taken away, its document staying in the library
		await send({ type: "move", id: "Untitled.drawio", collection: "Clients" });
		await until("the diagram to be in the collection", () => d.file === lib().pathOf("Clients/Untitled.drawio"));
		await send({ type: "renameCollection", name: "Clients", to: "Customers" });
		await until("the window to follow the collection's new name", () => d.file === lib().pathOf("Customers/Untitled.drawio"));
		await send({ type: "removeCollection", name: "Customers" });
		await until("the diagram to be at the library's top", () => d.file === lib().pathOf("Untitled.drawio") && !fs.existsSync(path.join(folder, "Customers")));
		expect(lib().versions("Untitled.drawio").length >= 1, "its versions are still its own");
		d.win.close();
		await until("the diagram's window to close", () => d.win.isDestroyed());
	} else log("homeDiagram", "skipped: draw.io is not here");

	// ----- Recent: what was opened, wherever it is; a file from elsewhere can be copied in -----
	await openFile(outside);
	await until("the file from elsewhere to be open", () => !!documentWindows.of(outside));
	await go("Recent");
	await until("Recent to list it", async () => (await cards()).some((c) => c.name === "elsewhere"));
	log("homeRecent", (await cards()).map((c) => `${c.name} (${c.sub})`));
	await send({ type: "addRecent", path: outside, collection: "" });
	await until("the copy in the library", () => fs.existsSync(path.join(folder, "elsewhere.drawio")));
	expect(fs.existsSync(outside), "the file elsewhere stays where it is");
	documentWindows.of(outside)?.win.close();
	await until("that window to close", () => !documentWindows.of(outside));

	// ----- the library elsewhere: another folder is another library -----
	await go("All documents");
	const before = (await cards()).length;
	fs.writeFileSync(path.join(folder, "Dropped in.excalidraw"), fs.readFileSync(config.file));
	await until("a file put into the folder by hand to be a card", async () => (await cards()).length === before + 1, 20_000);
	await until("every card to have its picture", async () => (await cards()).every((c) => c.img));
	await shot("home-after");
	log("homeAfter", (await cards()).map((c) => c.name));
	// ----- with the last document closed, the home screen is what is left: it comes back if it was closed -----
	if (process.platform === "darwin") {
		app.homeWhenEmpty(true);
		await openFile(path.join(lib().root, "Dropped in.excalidraw"));
		const last = drawing("Dropped in.excalidraw")!;
		await last.whenLoaded();
		home.close();
		await until("the home screen to close", () => !HomeWindow.window);
		last.win.close();
		await until("the home screen to come back", () => !!HomeWindow.window && documentWindows.size === 0);
		app.homeWhenEmpty(false);
		log("homeCameBack", true);
	}
	log("errorsShown", shown);
	expect(shown.length === 0, `no error boxes: ${shown.join(" | ")}`);
}
