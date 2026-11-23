// Unit tests for the Shape Workshop in the VS Code extension: the desktop app's Workshop
// (standalone/src/main/workshop without its Electron window) used as it is, its page as a
// webview loads it, the extension's gallery store, and the editor's side of it.
// Run: node --test test/ai/workshop.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2022", esModuleInterop: true },
});

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const workshop = (file) => require(path.join(root, "standalone/src/main/workshop", file));
const store = require(path.join(root, "src/features/workshop/galleryStore.ts"));
const { workshopPageHtml, WORKSHOP_PAGE } = require(path.join(root, "src/features/workshop/workshopPage.ts"));

const PAGE = read("standalone/src/renderer/workshop.html");
const SVG = (colour) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${colour}"/></svg>`;

test("nothing saved yet: the default galleries are there, switched off, so nothing is downloaded unasked", () => {
	const fresh = store.storedGalleries(undefined);
	assert.deepEqual(fresh.map((g) => [g.id, g.enabled, g.builtin]), [["thesvg", false, true], ["tech-logos", false, true], ["ui-icons", false, true]]);
	assert.equal(store.anyGalleryOn(undefined), false);
	// (the desktop app starts with them on; its defaults are not changed by this)
	assert.ok(workshop("types.ts").DEFAULT_GALLERIES.every((g) => g.enabled));

	// what was saved is what counts, cleaned of anything that is not a gallery
	const saved = [
		{ id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }], enabled: true, builtin: true },
		{ id: "mine", title: "  Mine  ", sources: [{ kind: "folder", path: "/shapes" }], enabled: false },
		{ id: "bad id!", title: "x", sources: [{ kind: "folder", path: "/x" }] },
		{ id: "empty", title: "x", sources: [{ kind: "nope" }] },
		"text",
	];
	assert.deepEqual(store.storedGalleries(saved), [
		{ id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }], enabled: true, builtin: true },
		{ id: "mine", title: "Mine", sources: [{ kind: "folder", path: "/shapes" }], enabled: false },
	]);
	assert.equal(store.anyGalleryOn(saved), true);
	assert.equal(store.anyGalleryOn([{ id: "mine", title: "Mine", sources: [{ kind: "folder", path: "/shapes" }], enabled: false }]), false);
	assert.equal(store.anyGalleryOn([{ id: "bad id!", sources: [{ kind: "folder", path: "/x" }], enabled: true }]), false);
	// an emptied list stays empty (every gallery removed): the defaults do not come back by themselves
	assert.deepEqual(store.storedGalleries([]), []);
});

test("the Workshop page names its files by their webview address and gets its bridge before anything loads", () => {
	const base = "https://file.vscode-cdn.test/ext/dist/custom-drawio-plugins/omni";
	const html = workshopPageHtml(PAGE, { nonce: "abc123", cspSource: "https://file.vscode-cdn.test", base: `${base}/` });
	assert.doesNotMatch(html, /\$\$/);
	assert.doesNotMatch(html, /["']\/ui\//);
	const files = [...new Set([...PAGE.matchAll(/["']\/ui\/([\w.-]+)["']/g)].map((m) => m[1]))];
	assert.ok(files.length >= 9, files.join(", "));
	const config = read("drawio-custom-plugins/webpack.config.ts");
	for (const f of files) {
		assert.ok(html.includes(`"${base}/ui/${f}"`), `${f} is not named by its webview address`);
		assert.ok(config.includes(`"${f}"`), `${f} is loaded by the page but not copied by the plugin build`);
	}
	assert.match(config, /standalone\/src\/renderer\/workshop\.html"\), to: "omni\/workshop\.html"/);
	assert.equal(WORKSHOP_PAGE, "workshop.html");
	for (const tag of html.match(/<(script|style|link rel="stylesheet")\b[^>]*>/g)) assert.match(tag, /nonce="abc123"/, tag);
	const bridge = html.indexOf('window["omnidrawWorkshop"] = {');
	assert.ok(bridge > html.indexOf("</title>") && bridge < html.indexOf('<link rel="stylesheet"'), "the bridge is not before the page's files");
	// images are data only: nothing the page shows is fetched by the webview itself
	assert.match(html, /img-src https:\/\/file\.vscode-cdn\.test data:;/);
	assert.match(html, /default-src 'none'/);
});

/** A gallery service on a folder of shapes, with a fetcher that must never be called. */
function folderGallery() {
	const { GalleryService } = workshop("galleries.ts");
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-workshop-"));
	const shapes = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-shapes-"));
	for (const [name, colour] of [["postgres", "navy"], ["redis", "red"], ["kafka queue", "black"]]) fs.writeFileSync(path.join(shapes, `${name}.svg`), SVG(colour));
	fs.writeFileSync(path.join(shapes, "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><circle r="5"/></svg>`);
	const calls = [];
	const service = new GalleryService(data, async (url) => {
		calls.push(url);
		throw new Error(`no downloads in this test: ${url}`);
	});
	return { service, data, shapes, calls, gallery: { id: "mine", title: "My shapes", sources: [{ kind: "folder", path: shapes }], enabled: true } };
}

/** The page's other half with everything around it faked. */
function core(configs, service, overrides = {}) {
	const { WorkshopCore } = workshop("core.ts");
	const posted = [];
	const inserted = [];
	const asked = [];
	let list = configs;
	const ports = {
		post: (msg) => posted.push(msg),
		service: () => service,
		configs: () => list,
		save: (next) => (list = next),
		host: () => ({
			insert: async (shape) => (inserted.push(shape), "shop.drawio"),
			diagramName: () => "shop.drawio",
			shapeSets: () => [{ title: "Yours", entries: [{ id: ".scratchpad", title: "Scratchpad", on: false }] }],
			setShapeSet: (id, on) => asked.push(["set", id, on]),
			refreshShapeSets: () => asked.push(["refresh"]),
		}),
		look: () => ({ iconStyle: "dots", matrix: "green" }),
		version: () => "0.4.0",
		confirm: async (message, detail, yes) => (asked.push(["confirm", message, yes]), true),
		pickLocal: async (kind) => (asked.push(["pick", kind]), undefined),
		pickExport: async (name) => (asked.push(["export", name]), path.join(os.tmpdir(), `drawio-ai-export-${Date.now()}-${name}`)),
		reveal: (file) => asked.push(["reveal", file]),
		openExternal: (url) => asked.push(["open", url]),
		...overrides,
	};
	const c = new WorkshopCore(ports);
	const settle = () => new Promise((r) => setTimeout(r, 60));
	return { core: c, posted, inserted, asked, configs: () => list, settle };
}

test("the Workshop's other half: state, search with previews, a shape put in, collections, shape sets", async () => {
	const { service, gallery, calls } = folderGallery();
	const w = core([gallery], service);
	await w.core.onMessage({ type: "ready" });
	await service.items(gallery);
	await w.settle();
	const state = w.posted.filter((m) => m.type === "state").pop();
	assert.deepEqual([state.diagram, state.iconStyle, state.matrix, state.version], ["shop.drawio", "dots", "green", "0.4.0"]);
	assert.deepEqual(state.sets[0].entries[0], { id: ".scratchpad", title: "Scratchpad", on: false });
	assert.deepEqual(state.galleries.map((g) => [g.id, g.enabled, g.count]), [["mine", true, 4]]);
	assert.deepEqual(w.asked[0], ["refresh"]);

	// search: titles first, then previews as data (the webview loads nothing itself)
	w.posted.length = 0;
	await w.core.onMessage({ type: "search", reqId: 7, query: "kafka" });
	const results = w.posted.find((m) => m.type === "results");
	assert.deepEqual([results.reqId, results.hits.map((h) => h.title)], [7, ["kafka queue"]]);
	const previews = w.posted.filter((m) => m.type === "previews").flatMap((m) => m.previews);
	assert.equal(previews.length, 1);
	assert.match(previews[0].src, /^data:image\/svg\+xml/);

	// a shape goes into the diagram used last, as a plain image; a hostile SVG arrives cleaned
	const items = await service.items(gallery);
	await w.core.onMessage({ type: "insert", galleryId: "mine", itemId: items.find((i) => i.title === "postgres").id });
	assert.equal(w.inserted.length, 1);
	assert.match(w.inserted[0].style, /^shape=image;.*image=data:image\/svg\+xml,/);
	assert.deepEqual(w.posted.filter((m) => m.type === "notice").pop(), { type: "notice", message: "Added postgres to shop.drawio." });
	await w.core.onMessage({ type: "insert", galleryId: "mine", itemId: items.find((i) => i.title === "evil").id });
	assert.doesNotMatch(decodeURIComponent(w.inserted[1].style), /script|onload|alert/);

	// a collection: made, filled, exported as a draw.io library, removed after a question
	await w.core.onMessage({ type: "newCollection", title: "Favourites" });
	const col = w.configs().find((g) => g.sources[0].kind === "collection");
	assert.deepEqual([col.id, col.title, col.enabled], ["favourites", "Favourites", true]);
	await w.core.onMessage({ type: "addToCollection", collectionId: col.id, galleryId: "mine", itemId: items.find((i) => i.title === "redis").id });
	assert.deepEqual((await service.items(col)).map((i) => i.title), ["redis"]);
	await w.core.onMessage({ type: "exportCollection", id: col.id });
	const exported = w.asked.find((a) => a[0] === "reveal")[1];
	assert.match(fs.readFileSync(exported, "utf8"), /^<mxlibrary>\[.*redis.*\]<\/mxlibrary>$/s);
	assert.deepEqual(w.asked.find((a) => a[0] === "export"), ["export", "Favourites.xml"]);
	await w.core.onMessage({ type: "remove", id: col.id });
	assert.deepEqual(w.asked.find((a) => a[0] === "confirm").slice(1), ["Remove “Favourites”?", "Remove"]);
	assert.equal(w.configs().some((g) => g.id === col.id), false);

	// draw.io's shape sets are switched in the editor; only a plain id gets there
	await w.core.onMessage({ type: "setShapeSet", id: "uml", on: true });
	await w.core.onMessage({ type: "setShapeSet", id: "x y; drop", on: true });
	assert.deepEqual(w.asked.filter((a) => a[0] === "set"), [["set", "uml", true]]);

	// off (a folder on this computer can still be browsed then: that downloads nothing) and on again
	await w.core.onMessage({ type: "toggle", id: "mine", enabled: false });
	assert.equal(w.configs()[0].enabled, false);
	w.posted.length = 0;
	await w.core.onMessage({ type: "search", reqId: 8, query: "", galleryId: "mine" });
	assert.equal(w.posted.find((m) => m.type === "results").hits.length, 4);
	// an address that is not GitHub's is refused, and only https pages are opened
	await assert.rejects(w.core.onMessage({ type: "addGithub", url: "https://evil.example/owner/repo" }), /not a GitHub repository address/);
	assert.equal(w.asked.some((a) => a[0] === "open"), false);
	w.core.dispose();
	// nothing in all this needed the network
	assert.deepEqual(calls, []);
});

/** A gallery service whose downloads are counted and fail. */
function countingService() {
	const { GalleryService } = workshop("galleries.ts");
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-workshop-"));
	const calls = [];
	const service = new GalleryService(data, async (url) => {
		calls.push(url);
		throw new Error("offline");
	});
	return { service, data, calls };
}

test("in the extension a gallery that is off downloads nothing: not when browsed, synced, made offline or restored", async () => {
	const { DEFAULT_GALLERIES } = workshop("types.ts");
	const off = DEFAULT_GALLERIES.map((g) => ({ ...g, enabled: false }));
	const { service, data, calls } = countingService();
	const w = core(off.slice(0, 2), service, { offStaysOff: true });
	await w.core.onMessage({ type: "ready" });
	await w.settle();
	// clicking a gallery's card browses it; "Sync now" and "Make available offline" are in its menu
	await assert.rejects(w.core.onMessage({ type: "search", reqId: 4, query: "", galleryId: "thesvg" }), /“theSVG \(open licences\)” is off\. Switch it on to use it/);
	// (the page gets an empty answer, so it does not wait or keep older shapes on screen)
	assert.deepEqual(w.posted.filter((m) => m.type === "results"), [{ type: "results", reqId: 4, hits: [] }]);
	await assert.rejects(w.core.onMessage({ type: "sync", id: "thesvg" }), /is off/);
	await assert.rejects(w.core.onMessage({ type: "offline", id: "tech-logos" }), /is off/);
	await assert.rejects(w.core.onMessage({ type: "insert", galleryId: "thesvg", itemId: "x" }), /is off/);
	await assert.rejects(w.core.onMessage({ type: "addToCollection", collectionId: "tech-logos", galleryId: "thesvg", itemId: "x" }), /is off/);
	// a search across the galleries only looks at those that are on
	await w.core.onMessage({ type: "search", reqId: 5, query: "docker" });
	// the default gallery that was removed comes back switched off, like the others
	await w.core.onMessage({ type: "restoreDefaults" });
	assert.deepEqual(w.configs().map((g) => [g.id, g.enabled]), [["thesvg", false], ["tech-logos", false], ["ui-icons", false]]);
	await w.settle();
	assert.deepEqual(calls, [], "something was downloaded for a gallery that is off");
	assert.equal(fs.existsSync(path.join(data, "galleries")), false, "something was cached for a gallery that is off");

	// switching one on is the user's yes: then it is read
	await w.core.onMessage({ type: "toggle", id: "thesvg", enabled: true });
	await w.settle();
	assert.ok(calls.length > 0 && calls.every((u) => /^https:\/\/(cdn\.jsdelivr\.net|data\.jsdelivr\.com|raw\.githubusercontent\.com)\//.test(u)), JSON.stringify(calls));
	w.core.dispose();

	// the desktop app, as before: a gallery that is off can be browsed, and restored defaults are on
	const desktop = countingService();
	const d = core(off.slice(0, 2), desktop.service);
	await d.core.onMessage({ type: "search", reqId: 1, query: "", galleryId: "thesvg" }).catch(() => undefined);
	assert.ok(desktop.calls.length > 0, "the desktop app no longer browses a gallery that is off");
	await d.core.onMessage({ type: "restoreDefaults" });
	assert.deepEqual(d.configs().map((g) => [g.id, g.enabled]), [["thesvg", false], ["tech-logos", false], ["ui-icons", true]]);
	d.core.dispose();
	// the extension asks for it
	assert.match(read("src/features/workshop/WorkshopFeature.ts"), /offStaysOff: true,/);
});

test("a gallery that is on becomes a palette and answers draw.io's own search; one that is off does neither", async () => {
	const { galleryPalette, searchForEditor } = workshop("palette.ts");
	const { service, gallery, calls } = folderGallery();
	const palette = await galleryPalette(service, gallery);
	assert.deepEqual([palette.title, palette.path, palette.kind, palette.more], ["My shapes", "gallery:mine", "gallery", 0]);
	assert.equal(palette.shapes.length, 4);
	assert.ok(palette.shapes.every((s) => s.w > 0 && s.h > 0 && s.title && /^shape=image;/.test(s.style)));
	const hits = await searchForEditor(service, [gallery], "redis", 10);
	assert.deepEqual(hits.map((h) => h.title), ["redis"]);
	assert.deepEqual(await searchForEditor(service, [{ ...gallery, enabled: false }], "redis", 10), []);
	// with no shape that could be read, there is no palette
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-shapes-"));
	assert.equal(await galleryPalette(service, { id: "none", title: "None", sources: [{ kind: "folder", path: empty }], enabled: true }), undefined);
	assert.deepEqual(calls, []);
});

test("the editor's Workshop messages reach the extension's events and the desktop app's unknown-message path", async () => {
	const { CustomizedDrawioClient } = require(path.join(root, "src/DrawioClient/CustomizedDrawioClient.ts"));
	let deliver;
	const sent = [];
	const client = new CustomizedDrawioClient(
		{ sendMessage: (m) => sent.push(JSON.parse(m)), registerMessageHandler: (handler) => ((deliver = handler), { dispose() {} }) },
		async () => ({}),
		() => {},
		() => "auto"
	);
	const sets = [];
	const searches = [];
	const unknown = [];
	client.onShapeSets.sub(({ groups }) => sets.push(groups));
	client.onGallerySearch.sub((s) => searches.push(s));
	client.onUnknownMessage.sub(({ message }) => unknown.push(message.event));
	deliver(JSON.stringify({ event: "desktopShapeSets", groups: [{ title: "Yours", entries: [] }] }));
	deliver(JSON.stringify({ event: "desktopShapeSets", groups: "nope" }));
	deliver(JSON.stringify({ event: "desktopGallerySearch", reqId: 3, query: "redis", limit: 24 }));
	deliver(JSON.stringify({ event: "desktopGallerySearch", reqId: "x", query: 5 }));
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(sets, [[{ title: "Yours", entries: [] }]]);
	assert.deepEqual(searches, [{ reqId: 3, query: "redis", limit: 24 }]);
	// (the desktop app uses the same client and takes these from onUnknownMessage)
	assert.deepEqual(unknown, ["desktopShapeSets", "desktopShapeSets", "desktopGallerySearch", "desktopGallerySearch"]);

	const shape = { style: "shape=image;image=data:image/svg+xml,x;", w: 48, h: 48, title: "Redis" };
	client.setShapes([{ title: "Mine", kind: "gallery", shapes: [shape] }]);
	client.insertShape(shape);
	client.insertShape(shape);
	client.reportShapeSets();
	client.setShapeSet(".scratchpad", true);
	client.galleryResults(3, [shape]);
	assert.deepEqual(sent.map((m) => [m.action, m.seq]), [["desktopShapes", undefined], ["desktopInsertShape", 1], ["desktopInsertShape", 2], ["desktopReportShapeSets", undefined], ["desktopSetShapeSet", undefined], ["desktopGalleryResults", undefined]]);
	// what the page reports of its shape sets is kept to plain short strings and booleans
	const { cleanShapeSets } = require(path.join(root, "standalone/src/main/shapeSets.ts"));
	assert.deepEqual(cleanShapeSets([{ title: 7, entries: [{ id: "uml", title: "UML", on: 1 }, { id: "bad id", title: "x" }, null] }, "x", { entries: "y" }]), [{ title: "Shapes", entries: [{ id: "uml", title: "UML", on: true }] }]);
});

test("the Workshop's command is contributed and registered, its editor side is on, and its code stays free of Electron", () => {
	const feature = read("src/features/workshop/WorkshopFeature.ts");
	const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
	const registered = [...feature.matchAll(/(?:command|registerCommand)\("(drawio-ai\.[\w.]+)"/g)].map((m) => m[1]);
	assert.deepEqual(registered, ["drawio-ai.shapeWorkshop", "drawio-ai.workshop.state", "drawio-ai.workshop.message", "drawio-ai.workshop.setGalleries"]);
	for (const c of registered) assert.equal(contributed.has(c), c === "drawio-ai.shapeWorkshop", c);
	assert.ok(pkg.contributes.menus["editor/title"].some((m) => m.command === "drawio-ai.shapeWorkshop"));
	assert.match(read("src/features/SidebarFeature.ts"), /command: "drawio-ai\.shapeWorkshop"/);
	// the toolbar's Workshop button, "+ More Shapes" and the gallery search are part of the editor tools
	const look = require(path.join(root, "src/features/editorLook.ts"));
	assert.equal(look.omniConfig(look.DEFAULT_LOOK, "https://x/omni", { readOnly: false, drawioTheme: "kennedy" }).features.workshop, true);
	// what the extension loads of the Workshop does not reach Electron (the build has no Electron to give it)
	const seen = new Set();
	const walk = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		const text = fs.readFileSync(file, "utf8");
		assert.doesNotMatch(text, /from "electron"/, path.relative(root, file));
		for (const m of text.matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g)) {
			const base = path.resolve(path.dirname(file), m[1]);
			const target = [base, `${base}.ts`, path.join(base, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
			if (target) walk(target);
		}
	};
	for (const f of ["runtime.ts", "galleryStore.ts", "WorkshopFeature.ts"]) walk(path.join(root, "src/features/workshop", f));
	assert.ok([...seen].some((f) => f.endsWith("standalone/src/main/workshop/galleries.ts")), "the walk did not reach the gallery service");
	assert.ok(![...seen].some((f) => /standalone\/src\/main\/(settings|workshop\/index|workshop\/workshopWindow)\.ts$/.test(f)));
	// downloads go through the desktop app's guarded fetch, and the extension has none of its own
	assert.match(feature, /new rt\.GalleryService\(this\.deps\.context\.globalStorageUri\.fsPath, rt\.workshopFetch\)/);
	// the automation command saves a list or nothing (anything else would mean the desktop app's defaults, switched on)
	assert.match(feature, /\(list: unknown\) => \(Array\.isArray\(list\) \? this\.save\(cleanGalleries\(list\)\) : undefined\)/);
	assert.doesNotMatch(feature, /\bfetch\(|https?:\/\//);
});

test("a diagram's name is taken as it is on disk, and a remote folder counts as on disk only where the extension runs", () => {
	const { fileNameOf, isOnDisk } = require(path.join(root, "src/features/diskUri.ts"));
	// (a Uri's path is already decoded: decoding it again throws on a percent sign, which took the Workshop's state with it)
	assert.equal(fileNameOf({ path: "/work/100%.drawio" }), "100%.drawio");
	assert.equal(fileNameOf({ path: "/work/a b/Größe %41.drawio.svg" }), "Größe %41.drawio.svg");
	assert.equal(fileNameOf({ path: "" }), "");
	assert.equal(isOnDisk({ scheme: "file" }, false), true);
	assert.equal(isOnDisk({ scheme: "vscode-remote" }, true), true);
	assert.equal(isOnDisk({ scheme: "vscode-remote" }, false), false);
	assert.equal(isOnDisk({ scheme: "untitled" }, true), false);
	assert.equal(isOnDisk({ scheme: "vscode-vfs" }, true), false);
	// no feature decodes a Uri's path a second time
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
	for (const file of walk(path.join(root, "src/features"))) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /decodeURIComponent\([^)]*\.uri\.path/, path.relative(root, file));
	// folders, libraries and exports the user picks go through the same question
	const feature = read("src/features/workshop/WorkshopFeature.ts");
	assert.match(feature, /return picked\?\.\[0\] \? this\.onDisk\(picked\[0\], /);
	assert.match(feature, /return to \? this\.onDisk\(to, "That place"\) : undefined;/);
	assert.doesNotMatch(feature, /scheme === "file"/);
});
