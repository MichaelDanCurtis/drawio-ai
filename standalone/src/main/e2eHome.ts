// End-to-end check of the home screen in the real app (`yarn e2e --home`, see e2e.ts): a library
// folder of this run's own is shown as cards with pictures, a drawing and a diagram are made from
// the home screen and saved (each save a version, and a picture from the editor), a document is
// renamed, moved and trashed from the home screen while it is open in a window, a version is gone
// back to, the trash gives back and deletes, and the window is screenshot in light and dark.
// No agent is started and nothing leaves the machine.
import { dialog, nativeTheme } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DiagramWindow } from "./diagramWindow";
import { documentWindows } from "./documentShell";
import type { AppCommands, E2eConfig } from "./e2e";
import { addElement, elementIds, expect, pause, until } from "./e2eExcalidraw";
import { ExcalidrawWindow } from "./excalidrawWindow";
import { HomeWindow } from "./homeWindow";
import { loadRecord, saveRecord } from "./mapper/store";
import { paths } from "./paths";
import { updateSettings } from "./settings";
import type { StaticServer } from "./staticServer";

export async function runHome(server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void, app: AppCommands): Promise<void> {
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
	await until("the card to say it has unsaved changes", async () => (await cards()).find((c) => c.name === "Untitled")?.open === "unsaved");
	expect(await w.save(), "the drawing is saved");
	await until("the save to be a version", () => lib().versions("Untitled.excalidraw").length === 2);
	await until("the editor's picture of it to be kept", () => !!lib().thumb("Untitled.excalidraw"));
	log("homeSaved", { versions: lib().versions("Untitled.excalidraw").map((v) => [v.kept, v.size]), picture: lib().thumb("Untitled.excalidraw")!.length });

	// ----- renamed and moved from the home screen while it is open: the window follows -----
	// (renamed while a save is still under way: the save ends first, and what it wrote is in the renamed file)
	await addElement(w, "home-pending", "diamond", { x: 100, y: 400 });
	const saving = w.save();
	await send({ type: "rename", id: "Untitled.excalidraw", name: "Roadmap" });
	expect(await saving, "the save that was under way ended");
	await until("the window to be the renamed file's", () => w.file === path.join(lib().root, "Roadmap.excalidraw"));
	await pause(300);
	expect(!fs.existsSync(path.join(folder, "Untitled.excalidraw")) && fs.readFileSync(w.file!, "utf8").includes("home-pending") && !w.isDirty, "a save under way is not written where the file was: the renamed file has it, and nothing is made again under the old name");
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
	log("homeWentBack", lib().versions(moved).map((v) => [v.key.split("-")[0], v.kept, lib().versionBytes(moved, v.key).includes("home-2"), lib().versionBytes(moved, v.key).includes("home-pending")]));
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
	// (with a map: its record is copied beside the copy, and stays with the original too)
	saveRecord(path.dirname(outside), { version: 1, id: "e2e-elsewhere-map", diagram: "elsewhere.drawio" } as any);
	await send({ type: "addRecent", path: outside, collection: "" });
	await until("the copy in the library", () => fs.existsSync(path.join(folder, "elsewhere.drawio")));
	await until("its map record beside it", () => loadRecord(lib().root, "e2e-elsewhere-map")?.diagram === "elsewhere.drawio");
	expect(!!loadRecord(path.dirname(outside), "e2e-elsewhere-map"), "the original keeps its map record");
	// copied in a second time: its maps would be shared with the first copy's, so it is not
	await inHome<void>(`document.getElementById("said").hidden = true;`);
	await send({ type: "addRecent", path: outside, collection: "" });
	await until("the refusal to be said", async () => /would share them/.test((await said()) ?? ""));
	expect(!fs.existsSync(path.join(folder, "elsewhere 2.drawio")), "a second copy of a mapped diagram is not made beside the first");
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
	// ----- an agent at work on a document works in its folder: moved to another, it starts again there -----
	{
		const fake = path.join(paths.appDir, "test/helpers/fake-acp-agent.js");
		if (fs.existsSync(fake)) {
			// (the stand-in agent, in place of "Claude Code" in this run's own settings: no real agent is started)
			updateSettings({ agents: { claude: { command: process.execPath, args: [fake], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
			const agentDoc = lib().create("", "Agent", ".excalidraw", fs.readFileSync(config.file));
			await openFile(lib().pathOf(agentDoc));
			await until("the agent's drawing to be open", () => !!drawing("Agent.excalidraw"));
			const aw = drawing("Agent.excalidraw")!;
			await aw.whenLoaded();
			await aw.chat.onMessage({ type: "pickProvider", providerId: "claude" });
			aw.chat.autoApprove = true;
			const turn = (text: string) => {
				const done = new Promise<void>((resolve) => (aw.chat.onTurnEnd = () => resolve()));
				void aw.chat.send(text);
				return done;
			};
			const where = async () => {
				await turn(`Where? STEPS:${JSON.stringify([{ where: true }])}`);
				const reply = ([...aw.chat.items].reverse().find((i: any) => i.kind === "assistant") as any)?.text ?? "";
				return /\[session in ([^\]]*)\]/.exec(reply)?.[1];
			};
			const first = await where();
			await send({ type: "move", id: agentDoc, collection: "Agents" });
			await until("the window to follow", () => aw.file === lib().pathOf("Agents/Agent.excalidraw"));
			const second = await where();
			log("homeAgentFolder", { first, second });
			expect(first && fs.realpathSync(first) === lib().root && second && fs.realpathSync(second) === path.join(lib().root, "Agents"), "an agent started for a document works in its new folder once the document moved");
			aw.win.close();
			await until("the agent's window to close", () => aw.win.isDestroyed());
		}
	}

	// ----- a diagram moved while it is closed takes its maps along (Mapper's records, kept in its folder) -----
	{
		const mapped = lib().create("", "Mapped", ".drawio", Buffer.from('<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'));
		saveRecord(lib().root, { version: 1, id: "e2e-map", diagram: "Mapped.drawio" } as any);
		await send({ type: "move", id: mapped, collection: "Maps" });
		await until("the closed diagram to be in the collection", () => fs.existsSync(lib().pathOf("Maps/Mapped.drawio")));
		const carried = loadRecord(path.join(lib().root, "Maps"), "e2e-map");
		log("homeMapsCarried", carried ? { diagram: carried.diagram } : null);
		expect(carried?.diagram === "Mapped.drawio" && !loadRecord(lib().root, "e2e-map"), "a closed diagram's map records go with it to its new folder, and none stay behind");
		// changed where it is now, then moved back: what it has now comes back with it, not what was left before
		saveRecord(path.join(lib().root, "Maps"), { ...carried, note: "changed in Maps" } as any);
		await send({ type: "move", id: "Maps/Mapped.drawio", collection: "" });
		await until("the diagram to be back at the top", () => fs.existsSync(lib().pathOf("Mapped.drawio")));
		const back = loadRecord(lib().root, "e2e-map") as any;
		expect(back?.note === "changed in Maps" && !loadRecord(path.join(lib().root, "Maps"), "e2e-map"), "moved back, it has its records as they are now");
		// not duplicated while it has maps: a copy would share them
		await send({ type: "duplicate", id: "Mapped.drawio" });
		await until("the refusal to be said", async () => /has maps/.test((await said()) ?? ""));
		expect(!fs.existsSync(lib().pathOf("Mapped copy.drawio")), "a diagram with maps is not duplicated");
		// nor is a version of it opened as a copy
		lib().snapshotNow("Mapped.drawio", { kept: true });
		const before = lib().contents().docs.length;
		await inHome<void>(`document.getElementById("said").hidden = true;`);
		await send({ type: "openVersion", id: "Mapped.drawio", key: lib().versions("Mapped.drawio")[0].key });
		await until("the refusal to be said", async () => /has maps/.test((await said()) ?? ""));
		expect(lib().contents().docs.length === before, "no version of a diagram with maps is opened as a copy");
		// trashed, a new diagram made under its name, and put back: it comes back as "Mapped 2" with its own maps, and the new one has none
		await send({ type: "trash", id: "Mapped.drawio" });
		await until("it to be in the trash", () => !fs.existsSync(lib().pathOf("Mapped.drawio")));
		expect(!loadRecord(lib().root, "e2e-map"), "its maps went into the trash with it");
		lib().create("", "Mapped", ".drawio", Buffer.from("<mxfile/>"));
		await send({ type: "restore", trashId: lib().contents().trash.find((t) => t.name === "Mapped")!.id });
		await until("it to be back under another name", () => fs.existsSync(lib().pathOf("Mapped 2.drawio")));
		const restored = loadRecord(lib().root, "e2e-map") as any;
		log("homeMapsRestored", restored ? { diagram: restored.diagram, note: restored.note } : null);
		expect(restored?.diagram === "Mapped 2.drawio" && restored.note === "changed in Maps", "its maps came back with it, under the name it has now");
		// put back where its maps cannot go (the folder's .drawai is a file): the document is back, its maps are kept, and the person is told where
		await send({ type: "trash", id: "Mapped 2.drawio" });
		await until("it to be in the trash again", () => !fs.existsSync(lib().pathOf("Mapped 2.drawio")));
		const trashId = lib().contents().trash.find((t) => t.name === "Mapped 2")!.id;
		fs.rmSync(path.join(lib().root, ".drawai"), { recursive: true, force: true });
		fs.writeFileSync(path.join(lib().root, ".drawai"), "not a folder");
		await inHome<void>(`document.getElementById("said").hidden = true;`);
		await send({ type: "restore", trashId });
		await until("it to be back", () => fs.existsSync(lib().pathOf("Mapped 2.drawio")));
		await until("the person to be told where its maps are", async () => /maps could not be put beside it/.test((await said()) ?? ""));
		const keptAt = /kept in (.+)\.$/.exec((await said()) ?? "")?.[1]?.replace(/^~/, os.homedir());
		log("homeMapsHeld", keptAt);
		expect(!!keptAt && !!loadRecord(keptAt, "e2e-map"), "its maps are kept where it says, not thrown away");
		fs.rmSync(path.join(lib().root, ".drawai"), { force: true });
	}

	// ----- a document opened by a path with a link in it is the same document: its card says so, and it follows -----
	const byLink = path.join(path.dirname(config.out), "library-by-link");
	fs.symlinkSync(folder, byLink);
	await openFile(path.join(byLink, "Team", "Plan.excalidraw"));
	await until("the window opened through the link", () => !!drawing("Plan.excalidraw"));
	const linked = drawing("Plan.excalidraw")!;
	await linked.whenLoaded();
	expect(linked.file!.startsWith(byLink) && documentWindows.of(lib().pathOf("Team/Plan.excalidraw")) === linked, "a window opened through a link is found by the file's real place");
	await until("its card to say it is open", async () => (await cards()).find((c) => c.name === "Plan")?.open === "open");
	// (opened again by its plain path, from its card: the window it has, not a second one on the same file)
	await send({ type: "open", id: "Team/Plan.excalidraw" });
	await pause(600);
	expect(documentWindows.allOf(lib().pathOf("Team/Plan.excalidraw")).length === 1 && [...ExcalidrawWindow.all].filter((x) => x.file && path.basename(x.file) === "Plan.excalidraw").length === 1, "a file is open in one window, by whatever path it is asked for");
	await addElement(linked, "home-link", "rectangle", { x: 500, y: 500 });
	await until("the window to have unsaved changes", () => linked.isDirty);
	await send({ type: "trash", id: "Team/Plan.excalidraw" });
	await until("the refusal to be said", async () => /Plan\.excalidraw has changes that are not saved/.test((await said()) ?? ""));
	expect(fs.existsSync(lib().pathOf("Team/Plan.excalidraw")), "its unsaved changes keep it out of the trash, by whatever path it was opened");
	await send({ type: "rename", id: "Team/Plan.excalidraw", name: "Plan B" });
	await until("the window to follow the new name", () => linked.file === lib().pathOf("Team/Plan B.excalidraw"));

	// ----- the picture kept is of what was saved: changed again at once, the editor's picture is not the file's -----
	expect(await linked.save(), "saved");
	await addElement(linked, "home-after-save", "ellipse", { x: 800, y: 500 });
	await pause(1500);
	expect(!lib().thumb("Team/Plan B.excalidraw"), "a picture of changes that are not saved is not kept as the file's");
	// (a window behind another does not load pictures it is not showing: the person comes back to it)
	home.show();
	home.focus();
	await until("its card to show the file as it is all the same", async () => (await cards()).find((c) => c.name === "Plan B")?.img === true);
	expect(await linked.save(), "saved again");
	await until("the picture of what was saved", () => !!lib().thumb("Team/Plan B.excalidraw"));
	linked.win.close();
	await until("that window to close", () => linked.win.isDestroyed());

	// ----- a diagram opened without the menus or the home screen (as an agent's tool opens one) is kept as it was opened too -----
	if (fs.existsSync(path.join(paths.webapp, "index.html")) && fs.existsSync(lib().pathOf("Cloud architecture.drawio"))) {
		expect(lib().versions("Cloud architecture.drawio").length === 0, "never opened so far");
		const direct = await DiagramWindow.open(server, lib().pathOf("Cloud architecture.drawio"));
		expect(lib().versions("Cloud architecture.drawio").length === 1 && lib().versions("Cloud architecture.drawio")[0].kept, "however a document is opened, what it was is kept");
		await direct.whenLoaded();
		direct.win.close();
		await until("the diagram's window to close", () => direct.win.isDestroyed());
	}

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
