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
	assert.deepEqual(m.MORPH_SHAPES.slice(0, 5), ["planes", "face", "tetrahedron", "spiral", "galaxy"], "it starts as the square of layers");
	const n = m.planes().length / 3;
	for (const make of [m.face, m.tetrahedron, m.spiral, m.galaxy, m.saturn, m.helix, m.heart, m.wave]) {
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
