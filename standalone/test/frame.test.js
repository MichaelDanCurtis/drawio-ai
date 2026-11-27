// The editor add-ons in another host's page (omnidraw-frame): who they answer to when a page
// frames the editor, and the sheets a browser prints to a PDF. No browser here: the window is a
// small stand-in.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
require("./helpers/ts");

/** A window as the add-ons see it: framed by `parent` (or opened by `opener`), at `origin`. */
function fakeWindow({ origin = "https://pad.example", opener, framed = true, config } = {}) {
	const posted = [];
	const parent = { postMessage: (message, to) => posted.push({ to: "parent", message, origin: to }) };
	const win = { omnidrawConfig: config };
	win.parent = framed ? parent : win;
	if (opener) win.opener = { postMessage: (message, to) => posted.push({ to: "opener", message, origin: to }) };
	return { win, parent, posted, location: { origin } };
}

test("the add-ons answer to the page that frames the editor, at its own origin unless told another; an opener comes first", () => {
	const load = (w) => {
		global.window = w.win;
		global.location = w.location;
		delete require.cache[require.resolve("../../drawio-custom-plugins/src/vscode")];
		return require("../../drawio-custom-plugins/src/vscode");
	};
	try {
		// framed, as OmniPad runs it
		let w = fakeWindow();
		let host = load(w);
		assert.equal(host.hostWindow(), w.parent);
		host.sendEvent({ event: "pluginLoaded", pluginId: "x" });
		assert.deepEqual(w.posted, [{ to: "parent", message: '{"event":"pluginLoaded","pluginId":"x"}', origin: "https://pad.example" }], "what the editor says goes to its own origin only");
		assert.equal(host.fromHost({ source: w.parent, origin: "https://pad.example" }), true);
		assert.equal(host.fromHost({ source: w.parent, origin: "https://elsewhere.example" }), false, "a page of another origin that frames the editor is not listened to");
		assert.equal(host.fromHost({ source: {}, origin: "https://pad.example" }), false, "nor another frame of the same origin");
		// a host on another origin, named in the settings
		w = fakeWindow({ config: { hostOrigin: "https://app.example" } });
		host = load(w);
		host.sendEvent({ event: "pluginLoaded", pluginId: "x" });
		assert.equal(w.posted[0].origin, "https://app.example");
		assert.equal(host.fromHost({ source: w.parent, origin: "https://app.example" }), true);
		assert.equal(host.fromHost({ source: w.parent, origin: "https://pad.example" }), false);
		// VS Code and the desktop app: the stand-in at window.opener, as before
		w = fakeWindow({ opener: true });
		host = load(w);
		assert.equal(host.hostWindow(), w.win.opener);
		host.sendEvent({ event: "pluginLoaded", pluginId: "x" });
		assert.deepEqual(w.posted.map((p) => p.to), ["opener"]);
		assert.equal(host.fromHost({ source: w.win.opener, origin: "null" }), true);
		// on its own, with nobody to answer to
		w = fakeWindow({ framed: false });
		host = load(w);
		assert.equal(host.hostWindow(), null);
		assert.equal(host.fromHost({ source: w.win, origin: "https://pad.example" }), false);
	} finally {
		delete global.window;
		delete global.location;
	}
});

test("the first script of the bundle gives the toolbar's scripts someone to post to, and leaves a host that has its own alone", () => {
	const src = fs.readFileSync(path.join(__dirname, "../src/renderer/frame/host.js"), "utf8");
	const run = (w) => vm.runInNewContext(src, { window: w.win, location: w.location });
	let w = fakeWindow();
	run(w);
	w.win.VsCodeApi.postMessage('{"event":"desktopCommand","command":"present"}');
	assert.deepEqual(w.posted, [{ to: "parent", message: '{"event":"desktopCommand","command":"present"}', origin: "https://pad.example" }]);
	w = fakeWindow({ config: { hostOrigin: "*" } });
	run(w);
	w.win.VsCodeApi.postMessage("x");
	assert.equal(w.posted[0].origin, "*");
	// what the toolbar's scripts are told is taken from the framing page only, at that origin
	w = fakeWindow();
	run(w);
	assert.equal(w.win.omnidrawFromHost({ source: w.parent, origin: "https://pad.example" }), true);
	assert.equal(w.win.omnidrawFromHost({ source: w.parent, origin: "https://elsewhere.example" }), false);
	assert.equal(w.win.omnidrawFromHost({ source: {}, origin: "https://pad.example" }), false, "another frame or window that can reach the editor is not the host");
	w = fakeWindow({ config: { hostOrigin: "https://app.example" } });
	run(w);
	assert.equal(w.win.omnidrawFromHost({ source: w.parent, origin: "https://app.example" }), true);
	assert.equal(w.win.omnidrawFromHost({ source: w.parent, origin: "https://pad.example" }), false);
	// every script of the bundle that listens for messages puts them to that test first
	const bundled = ["desktop-toolbar.js", "presentation.js", "theme.js", "ui/icons.js", "ui/brandmark.js", "ui/tips.js"];
	let listeners = 0;
	for (const f of bundled) {
		const text = fs.readFileSync(path.join(__dirname, "../src/renderer", f), "utf8");
		for (const part of text.split('addEventListener("message"').slice(1)) {
			listeners++;
			assert.match(part.slice(0, 400), /if \(window\.omnidrawFromHost && !window\.omnidrawFromHost\(evt\)\) return;/, `${f}: a message listener that does not ask who is speaking`);
		}
	}
	assert.equal(listeners, 2);
	// the desktop app's and VS Code's editor pages have an api of their own already: nothing is added there
	w = fakeWindow();
	const own = { postMessage() {} };
	w.win.VsCodeApi = own;
	run(w);
	assert.equal(w.win.VsCodeApi, own);
	assert.equal(w.win.omnidrawFromHost, undefined);
	// nobody frames it: nothing is posted, and nothing throws
	w = fakeWindow({ framed: false });
	run(w);
	w.win.VsCodeApi.postMessage("x");
	assert.deepEqual(w.posted, []);
});

test("the sheets a browser prints to a PDF: one of the drawing's size for each page, nothing but the drawings", () => {
	const { printDocument } = require("../../drawio-custom-plugins/src/pdf/PrintPdf");
	const html = printDocument(
		[
			{ svg: '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="300.4" height="120"><text>One</text></svg>', width: 300.4, height: 120 },
			{ svg: '<svg width="800" height="600"><text>Two</text></svg>', width: 800, height: 600 },
		],
		'Plan <script>"x"</script> & more'
	);
	assert.match(html, /^<!DOCTYPE html><html><head><meta charset="utf-8"><title>Plan scriptx\/script  more<\/title>/, "the title cannot break out of its tag");
	assert.match(html, /@page p0\{size:301px 120px;margin:0\}/, "each sheet is the size of its drawing");
	assert.match(html, /@page p1\{size:800px 600px;margin:0\}/);
	assert.equal((html.match(/<div class="p\d">/g) || []).length, 2);
	assert.ok(!html.includes("<?xml") && !/<!DOCTYPE svg/i.test(html), "an SVG's own prolog does not belong inside a page");
	assert.ok(html.indexOf("One") < html.indexOf("Two"));
});

test("the frame folder's README names every setting the scripts read and every action it promises", () => {
	const readme = fs.readFileSync(path.join(__dirname, "../src/renderer/frame/README.md"), "utf8");
	const { ICON_STYLES, MATRIX_STYLES } = require("../src/main/settings");
	for (const key of ["base", "host", "name", "icons", "toolbar", "matrix", "presence", "hostOrigin", "features"]) assert.match(readme, new RegExp(`\\b${key}:`), key);
	for (const style of [...ICON_STYLES, ...MATRIX_STYLES]) assert.ok(readme.includes(style), style);
	const ai = fs.readFileSync(path.join(__dirname, "../../drawio-custom-plugins/src/ai.ts"), "utf8");
	const live = fs.readFileSync(path.join(__dirname, "../../drawio-custom-plugins/src/liveshare.ts"), "utf8");
	for (const action of ["aiExportVsdx", "aiExportPdf", "aiPrintPdf", "aiImportDiagram"]) assert.ok(readme.includes(action) && ai.includes(`case "${action}"`), action);
	for (const action of ["setDiffSync", "liveLock", "liveCompose", "liveLoading", "liveNotice", "updateLiveshareViewState"]) assert.ok(readme.includes(action) && live.includes(`case "${action}"`), action);
});
