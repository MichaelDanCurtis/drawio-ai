// Second polish round: the Claude Code / Codex adapters stay current (so their model lists
// are today's), the four icon styles, the Mapper's short card texts, quick tooltips.
// Run from standalone/: node --test test/polish-round-2.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const av = require("../src/main/adapterVersions");
const { modelsFromSession } = require("../src/main/modelNames");

test("adapters: an installed copy older than npm's is replaced by that exact version through npx", () => {
	assert.ok(av.newerVersion("0.109.1", "0.48.0"));
	assert.ok(!av.newerVersion("0.48.0", "0.48.0"));
	assert.ok(!av.newerVersion("0.9.0", "0.10.0"), "numbers, not text");
	assert.deepEqual(av.chooseAdapter({ bin: "/x", version: "0.48.0" }, "0.109.1"), { use: "npx", version: "0.109.1" });
	assert.deepEqual(av.chooseAdapter({ bin: "/x", version: "0.109.1" }, "0.109.1"), { use: "installed" });
	assert.deepEqual(av.chooseAdapter({ bin: "/x", version: "0.48.0" }, undefined), { use: "installed" }, "offline: what is installed");
	assert.deepEqual(av.chooseAdapter({ bin: "/x" }, "0.109.1"), { use: "installed" }, "an unknown install is left alone");
	assert.deepEqual(av.chooseAdapter(undefined, "0.109.1"), { use: "npx", version: "0.109.1" });
	assert.deepEqual(av.chooseAdapter(undefined, undefined), { use: "npx", version: undefined });
});

test("adapters: the installed version is read from the package the executable belongs to", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-adapter-"));
	const pkg = path.join(root, "lib", "node_modules", "@agentclientprotocol", "claude-agent-acp");
	fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.48.0" }));
	fs.writeFileSync(path.join(pkg, "dist", "index.js"), "");
	fs.mkdirSync(path.join(root, "bin"));
	fs.symlinkSync(path.join(pkg, "dist", "index.js"), path.join(root, "bin", "claude-agent-acp"));
	assert.equal(av.installedAdapterVersion(path.join(root, "bin", "claude-agent-acp"), "@agentclientprotocol/claude-agent-acp"), "0.48.0");
	assert.equal(av.installedAdapterVersion(path.join(root, "bin", "claude-agent-acp"), "some-other-package"), undefined);
	assert.equal(av.installedAdapterVersion(path.join(root, "bin", "missing"), "x"), undefined);
});

test("adapters: npm is asked at most twice a day, only package names are sent, and failures keep the last answer", async () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-adapter-")), "adapters.json");
	av.useAdapterCache(file);
	const asked = [];
	let version = "0.109.1", ok = true;
	const fetcher = async (url) => {
		asked.push(String(url));
		if (!ok) throw new Error("offline");
		return { ok: true, json: async () => ({ version }) };
	};
	assert.equal(await av.refreshAdapterVersions(["@agentclientprotocol/claude-agent-acp"], { fetcher }), true);
	assert.equal(av.latestAdapterVersion("@agentclientprotocol/claude-agent-acp"), "0.109.1");
	assert.deepEqual(asked, ["https://registry.npmjs.org/@agentclientprotocol%2Fclaude-agent-acp/latest"]);
	await av.refreshAdapterVersions(["@agentclientprotocol/claude-agent-acp"], { fetcher });
	assert.equal(asked.length, 1, "not asked again so soon");
	ok = false;
	await av.refreshAdapterVersions(["@agentclientprotocol/claude-agent-acp"], { fetcher, force: true });
	assert.equal(av.latestAdapterVersion("@agentclientprotocol/claude-agent-acp"), "0.109.1", "offline keeps the last answer");
	ok = true;
	version = "not a version; rm -rf";
	await av.refreshAdapterVersions(["@agentclientprotocol/claude-agent-acp"], { fetcher, force: true });
	assert.equal(av.latestAdapterVersion("@agentclientprotocol/claude-agent-acp"), "0.109.1", "only plain versions are accepted (they end up on a command line)");
	av.useAdapterCache(file);
	assert.equal(av.latestAdapterVersion("@agentclientprotocol/claude-agent-acp"), "0.109.1", "kept in the app's data folder");
});

test("models come from what the agent's session says, with versions in their names", () => {
	const info = { configOptions: [{ id: "model", type: "select", category: "model", currentValue: "opus", options: [{ value: "opus", name: "Opus", description: "Opus 5.5 · most capable" }, { value: "claude-haiku-5-5", name: "Haiku" }] }] };
	const { models, current, currentId } = modelsFromSession(info);
	assert.deepEqual(models.map((m) => m.name), ["Opus 5.5", "Haiku 5.5"]);
	assert.equal(current, "opus");
	assert.equal(currentId, "opt:model:opus");
	assert.deepEqual(modelsFromSession({ modes: { currentModeId: "a", availableModes: [{ id: "a", name: "Ask" }] } }).models.map((m) => m.value), ["mode:a"]);
	assert.deepEqual(modelsFromSession(undefined).models, []);
});

test("icons: four styles that are drawn differently, old style names still work", () => {
	require("../src/renderer/ui/icons.js");
	const I = globalThis.DrawAIIcons;
	assert.deepEqual(I.styles, ["classic", "dots2d", "dots", "real"]);
	for (const name of I.names) {
		const drawn = I.styles.map((s) => I.svg(name, s));
		assert.equal(new Set(drawn).size, 4, `${name} looks different in each style`);
		for (const svg of drawn) assert.match(svg, /^<svg [^>]*viewBox="0 0 24 24"/);
	}
	assert.doesNotMatch(I.svg("gear", "dots2d"), /<path/, "dot-matrix 2D is only dots");
	assert.match(I.svg("gear", "real"), /fill="#[0-9a-f]{6}"/, "realistic icons carry their own colours");
	assert.doesNotMatch(I.svg("gear", "real"), /currentColor/);
	assert.ok(I.coloured("real") && !I.coloured("dots") && !I.coloured("classic"));
	assert.equal(I.svg("undo", "isometric"), I.svg("undo", "dots2d"));
	assert.equal(I.svg("undo", "extruded"), I.svg("undo", "real"));
	for (const name of ["ruler", "chevronLeft", "chevronRight", "code", "database", "ml"]) assert.ok(I.names.includes(name), name);
});

test("the Mapper's cards: a few words each, the full description stays for the form", () => {
	const { catalog } = require("../src/main/mapper/registry");
	for (const r of catalog().recipes) {
		assert.ok(r.blurb && r.blurb.length <= 32, `${r.id}: "${r.blurb}"`);
		assert.ok(r.description.length > r.blurb.length);
		assert.doesNotMatch(r.blurb, /[.:]$/);
	}
});

test("the vendors' logos for the Mapper are plain embedded SVGs", () => {
	require("../src/renderer/ui/brands.js");
	const B = globalThis.DrawAIBrands;
	assert.deepEqual(Object.keys(B).sort(), ["aws", "azure", "gcp"]);
	for (const uri of Object.values(B)) {
		const svg = Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString();
		assert.match(svg, /^<svg[\s>]/);
		assert.doesNotMatch(svg, /<script|\son\w+=|href=|url\(\s*["']?https?:/i);
	}
});

test("the chat's dot object: every shape it turns into has the same dots, all inside the stage", async () => {
	const m = await import("../src/renderer/ui/dot-object.js");
	assert.deepEqual(m.MORPH_SHAPES.slice(0, 5), ["planes", "bust", "tetrahedron", "spiral", "galaxy"], "it starts as the square of layers");
	const n = m.planes().length / 3;
	for (const make of [m.bust, m.tetrahedron, m.spiral, m.galaxy, m.saturn, m.helix, m.heart, m.wave]) {
		const pts = make();
		assert.ok(pts.length > 300, `${make.name} has enough dots to read`);
		const fit = m.fitShape(pts, n);
		assert.equal(fit.length, n * 3);
		for (let i = 0; i < n; i++) {
			const r = Math.hypot(fit[i * 3], fit[i * 3 + 1], fit[i * 3 + 2]);
			assert.ok(Number.isFinite(r) && r <= 1.2, `${make.name} dot ${i} is at ${r}`);
		}
	}
	// top to bottom, so a dot's place in one shape is near its place in the next
	const f = m.fitShape(m.galaxy(), n);
	assert.ok(f[1] >= f[(n - 1) * 3 + 1]);
});

test("adapters: when the newer version cannot be started, the installed copy is used for the rest of the run", async () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-adapter-")), "adapters.json");
	av.useAdapterCache(file);
	await av.refreshAdapterVersions(["some-adapter"], { fetcher: async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }) });
	assert.deepEqual(av.chooseAdapter({ bin: "/x", version: "1.0.0" }, av.latestAdapterVersion("some-adapter")), { use: "npx", version: "2.0.0" });
	av.noteAdapterFailure("some-adapter");
	assert.deepEqual(av.chooseAdapter({ bin: "/x", version: "1.0.0" }, av.latestAdapterVersion("some-adapter")), { use: "installed" });
});

test("the editor reads style names with digits, and a remembered mode is never applied by itself", () => {
	const toolbar = fs.readFileSync(path.join(__dirname, "../src/renderer/desktop-toolbar.js"), "utf8");
	const re = new RegExp(/\(\/(\[\?&\]icons=[^/]+)\//.exec(toolbar)[1]);
	assert.equal(re.exec("?icons=dots2d&toolbar=top")[1], "dots2d");
	const chat = fs.readFileSync(path.join(__dirname, "../src/main/chatController.ts"), "utf8");
	assert.match(chat, /preferred\.startsWith\("mode:"\)/, "a stored mode is skipped when a session starts");
	assert.match(chat, /kind === "opt" \? this\.modelList/, "only model picks are remembered");
});

test("draw.io's shape sets from the editor are passed on as plain short values only", () => {
	const { cleanShapeSets } = require("../src/main/shapeSets");
	const out = cleanShapeSets([
		{ title: "Standard", entries: [{ id: "general", title: "General", on: true }, { id: "uml", title: "UML", on: 0 }, { id: "bad id; rm", title: "x", on: true }, null] },
		{ title: "x".repeat(500), entries: [{ id: ".scratchpad", title: 7, on: "yes" }] },
		{ title: "Empty", entries: [] },
		"junk",
	]);
	assert.deepEqual(out[0], { title: "Standard", entries: [{ id: "general", title: "General", on: true }, { id: "uml", title: "UML", on: false }] });
	assert.equal(out[1].title.length, 80);
	assert.deepEqual(out[1].entries, [{ id: ".scratchpad", title: ".scratchpad", on: true }]);
	assert.equal(out.length, 2, "groups without usable entries are left out");
});

test("an editor page always gets a Scratchpad, also with a profile from before it was kept here", () => {
	const { withScratchpad } = require("../src/main/shapeSets");
	assert.equal(withScratchpad({})[".scratchpad"], "<mxlibrary>[]</mxlibrary>");
	const kept = '<mxlibrary>[{"xml":"x","w":90,"h":40}]</mxlibrary>';
	assert.equal(withScratchpad({ ".scratchpad": kept })[".scratchpad"], kept, "shapes that are there stay");
	assert.equal(withScratchpad({ ".scratchpad": "<mxfile/>" })[".scratchpad"], "<mxlibrary>[]</mxlibrary>", "something that is not a library is replaced");
});

test("draw.io's storage: a window only changes what it changed, so two windows cannot lose each other's Scratchpad", () => {
	const { DrawioStorage } = require("../src/main/drawioStorage");
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-storage-")), "drawio-local-storage.json");
	const store = new DrawioStorage(() => file);
	const a = store.snapshot(), b = store.snapshot(); // what windows A and B were given
	assert.equal(a[".scratchpad"], "<mxlibrary>[]</mxlibrary>");

	// A puts a shape on the Scratchpad
	const withShape = '<mxlibrary>[{"xml":"x","w":90,"h":40,"title":"mine"}]</mxlibrary>';
	assert.deepEqual(store.apply({ ...a, ".scratchpad": withShape }, a), { ".scratchpad": withShape });
	// B, which knows nothing of it, saves a setting: its old Scratchpad copy is not taken over
	assert.deepEqual(store.apply({ ...b, ".drawio-config": '{"libraries":"general;uml"}' }, b), { ".drawio-config": '{"libraries":"general;uml"}' });
	assert.equal(store.all()[".scratchpad"], withShape, "A's shape is still there");
	assert.equal(store.all()[".drawio-config"], '{"libraries":"general;uml"}');
	// a key a page removes is removed; things that are not strings are ignored
	assert.deepEqual(store.apply({ ".scratchpad": b[".scratchpad"], junk: 7 }, b), { ".drawio-config": null });
	assert.equal(store.all()[".scratchpad"], withShape, "and B's old Scratchpad copy still does not count as a change");
	assert.deepEqual(store.apply("nonsense", a), {});

	store.flush();
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ".scratchpad": withShape });
	assert.ok(!fs.existsSync(file + ".tmp"), "written whole, then moved into place");
	assert.equal(new DrawioStorage(() => file).all()[".scratchpad"], withShape, "there after a restart");
});

test("draw.io's storage: a file that cannot be read is set aside, not written over", () => {
	const { DrawioStorage } = require("../src/main/drawioStorage");
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-storage-")), "drawio-local-storage.json");
	fs.writeFileSync(file, '{".scratchpad":"<mxlibrary>[{\\"xml\\":\\"half');
	const store = new DrawioStorage(() => file);
	assert.equal(store.all()[".scratchpad"], "<mxlibrary>[]</mxlibrary>");
	assert.ok(fs.readFileSync(file + ".broken", "utf8").includes("half"), "the unreadable file is kept");
});

test("the storage given to an editor page cannot break out of the page's script", () => {
	const { storageLiteral } = require("../src/main/drawioStorage");
	const nasty = { ".scratchpad": "$$E=mc^2$$ US$'000 $& $` </script><script>alert(1)</script>  " };
	const literal = storageLiteral(nasty);
	assert.ok(!literal.includes("</script>") && !literal.includes("<"), "no tag can end the script");
	assert.ok(!literal.includes(" "));
	// put into the page the way the server does (a function, so "$" is not a pattern), it reads back unchanged
	const page = "const storage = $$localStorage$$;".replace("$$localStorage$$", () => literal);
	assert.deepEqual(new Function(page + " return storage;")(), nasty);
});

test("the matrix and the head's field share one dot grid", async () => {
	const dots = await import("../src/renderer/ui/dots.js");
	const canvas = { getBoundingClientRect: () => ({ left: 13, top: 4, width: 300, height: 90 }), ownerDocument: {}, width: 0, height: 0 };
	const engine = new dots.DotEngine(canvas, {}, { anchor: "viewport", grid: 7 }, { performance: { now: () => 0 }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined });
	engine.w = 300;
	engine.h = 90;
	engine.layout();
	// every dot sits in the middle of a 7px cell counted from the window's corner
	for (let i = 0; i < engine.xs.length; i += 37) {
		assert.ok(Math.abs(((engine.xs[i] + 13 - 3.5) % 7 + 7) % 7) < 1e-6, `x of dot ${i}`);
		assert.ok(Math.abs(((engine.ys[i] + 4 - 3.5) % 7 + 7) % 7) < 1e-6, `y of dot ${i}`);
	}
	assert.ok(engine.xs.length > 400);
	const matrix = fs.readFileSync(path.join(__dirname, "../src/renderer/ui/matrix.js"), "utf8");
	assert.match(matrix, /const GRID = 7;/);
	assert.match(matrix, /pointerEvents: "none"/, "it never takes a click");
});

test("the dot object: shapes with fewer dots keep their look, the head brings its own light", async () => {
	const m = await import("../src/renderer/ui/dot-object.js");
	const head = m.bust();
	assert.ok(head.length > 2500, "the head is a fine mesh");
	assert.ok(head.every((p) => p.length === 7 && Math.abs(Math.hypot(p[3], p[4], p[5]) - 1) < 0.01), "every dot of it knows which way its surface faces");
	// a sparse shape fitted to the head's number of dots shows only its own dots
	const planes = [];
	const flat = m.planes();
	for (let i = 0; i < flat.length; i += 3) planes.push([flat[i], flat[i + 1], flat[i + 2]]);
	const fit = m.fitShape(planes, head.length);
	const shown = fit.weights.reduce((a, w) => a + w, 0);
	assert.equal(shown, planes.length, "the spare dots are hidden");
	assert.ok(fit.normals.every((v) => v === 0), "and it is not lit");
	const fitHead = m.fitShape(head, head.length);
	assert.ok(fitHead.weights.every((w) => w === 1));
	assert.ok(fitHead.normals.some((v) => v !== 0));
	const matrix = fs.readFileSync(path.join(__dirname, "../src/renderer/ui/matrix.js"), "utf8");
	assert.match(matrix, /zIndex: String\(opts\.zIndex \?\? -1\)/, "the matrix is a background layer");
});
