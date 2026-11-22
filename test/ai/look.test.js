// Unit tests for the editor tools and the look the extension shares with the desktop app:
// the settings, what the editor page is given, and how text gets into the page.
// Run: node --test test/ai/look.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const root = path.resolve(__dirname, "../..");
const look = require(path.join(root, "src/features/editorLook.ts"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
/** An editor with draw.io's standard theme, and a read-only view of a diagram. */
const EDIT = { readOnly: false, drawioTheme: "kennedy" };
const VIEW = { readOnly: true, drawioTheme: "kennedy" };
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

test("settings that are missing or wrong give the default look", () => {
	assert.deepEqual(look.cleanLook(undefined), look.DEFAULT_LOOK);
	assert.deepEqual(look.cleanLook({ editorTools: "yes", theme: "neon", icons: 3, matrix: null, toolbar: "middle" }), look.DEFAULT_LOOK);
	assert.deepEqual(look.cleanLook({ editorTools: false, theme: "drawio", icons: "real", matrix: "off", toolbar: "left" }), {
		editorTools: false,
		theme: "drawio",
		icons: "real",
		matrix: "off",
		toolbar: "left",
	});
});

test("the settings in package.json are the ones the code reads, with the same defaults and choices", () => {
	const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties));
	for (const [key, value] of Object.entries(look.DEFAULT_LOOK)) {
		const prop = props[`drawio-ai.look.${key}`];
		assert.ok(prop, `drawio-ai.look.${key} is contributed`);
		assert.equal(prop.default, value);
		// every choice offered is one the code accepts
		for (const choice of prop.enum ?? []) {
			assert.equal(look.cleanLook({ [key]: choice })[key], choice, `${key}: ${choice}`);
		}
		if (prop.enum) assert.equal(prop.enumItemLabels.length, prop.enum.length);
	}
	assert.ok(pkg.contributes.commands.some((c) => c.command === "drawio-ai.present"));
});

test("the page gets the tools' settings, and nothing when they are off or the editor is read-only", () => {
	const on = look.cleanLook({ icons: "dots", matrix: "green", toolbar: "right" });
	assert.deepEqual(look.omniConfig(on, "https://x/omni", EDIT), {
		host: "vscode",
		name: "Draw.AI",
		base: "https://x/omni",
		icons: "dots",
		toolbar: "right",
		matrix: "green",
		// not in the extension: the Shape Workshop, a chat button of its own, the desktop app's shortcuts
		features: { workshop: false, chat: false, shortcuts: false, toolbar: true, matrix: true },
	});
	assert.equal(look.omniConfig(on, "https://x/omni", VIEW), null);
	assert.equal(look.omniConfig(look.cleanLook({ editorTools: false }), "https://x/omni", EDIT), null);
});

test("plugins load in the order they need: icons and tooltips, the theme, the bundle, the toolbar", () => {
	const paths = look.editorPluginPaths(look.DEFAULT_LOOK, "B", "bundle.js", EDIT);
	assert.deepEqual(paths, ["B/ui/icons.js", "B/ui/brandmark.js", "B/ui/tips.js", "B/plugin/theme.js", "bundle.js", "B/plugin/desktop-toolbar.js", "B/plugin/presentation.js"]);
	// draw.io's own colours: everything but the theme
	assert.deepEqual(
		look.editorPluginPaths(look.cleanLook({ theme: "drawio" }), "B", "bundle.js", EDIT),
		paths.filter((p) => p !== "B/plugin/theme.js")
	);
	// off, or a read-only view: the editor as it was
	assert.deepEqual(look.editorPluginPaths(look.cleanLook({ editorTools: false }), "B", "bundle.js", EDIT), ["bundle.js"]);
	assert.deepEqual(look.editorPluginPaths(look.DEFAULT_LOOK, "B", "bundle.js", VIEW), ["bundle.js"]);
});

test("draw.io's themes with their own toolbars get presentation mode and tooltips, not the toolbar or the look", () => {
	for (const drawioTheme of ["min", "simple", "sketch", "Sketch"]) {
		const page = { readOnly: false, drawioTheme };
		assert.equal(look.fullLook(drawioTheme), false);
		const config = look.omniConfig(look.cleanLook({ matrix: "green" }), "B", page);
		assert.equal(config.features.toolbar, false);
		assert.equal(config.features.matrix, false);
		assert.equal(config.matrix, "off");
		const paths = look.editorPluginPaths(look.DEFAULT_LOOK, "B", "bundle.js", page);
		assert.equal(paths.includes("B/plugin/theme.js"), false);
		assert.ok(paths.includes("B/plugin/presentation.js") && paths.includes("B/ui/tips.js"));
	}
	for (const drawioTheme of ["kennedy", "auto", "atlas"]) assert.equal(look.fullLook(drawioTheme), true);
});

test("the plugin build copies every shared file the page loads, and the fonts they name", () => {
	const build = read("drawio-custom-plugins/webpack.config.ts");
	const copied = (name) => build.includes(`"${name}"`);
	for (const p of look.editorPluginPaths(look.DEFAULT_LOOK, "", "", EDIT).filter(Boolean)) {
		assert.ok(copied(path.basename(p)), `${p} is copied`);
	}
	// loaded by the toolbar itself: the dot field and the matrix (which imports the dot field)
	const toolbar = read("standalone/src/renderer/desktop-toolbar.js");
	const imports = Array.from(toolbar.matchAll(/import\(BASE \+ "\/ui\/([\w.-]+)"\)/g), (m) => m[1]);
	assert.deepEqual(imports.sort(), ["dots.js", "matrix.js"]);
	for (const file of imports) assert.ok(copied(file), `${file} is copied`);
	assert.equal(/import\("\//.test(toolbar), false, "every import goes through the host's base");
	const fonts = new Set();
	for (const file of ["standalone/src/renderer/theme.js", "standalone/src/renderer/presentation.js"]) {
		for (const m of read(file).matchAll(/url\('\/ui\/fonts\/([\w-]+)\.woff2'\)/g)) fonts.add(m[1]);
	}
	assert.ok(fonts.size >= 3);
	for (const f of fonts) assert.ok(copied(f), `font ${f} is copied`);
	assert.equal(look.OMNI_DIR, "dist/custom-drawio-plugins/omni");
	assert.ok(pkg.files.includes("dist/custom-drawio-plugins/**/*"), "the shared files are in the package");
});

test("a value becomes script source that cannot end the script", () => {
	const nasty = { a: "</script><script>alert(1)</script>", b: `line${LS}sep${PS}`, c: "$& $1" };
	const src = look.scriptLiteral(nasty);
	assert.equal(src.includes("<"), false);
	assert.equal(src.includes(LS) || src.includes(PS), false);
	assert.deepEqual(new Function(`return ${src};`)(), nasty);
	assert.equal(look.scriptLiteral(undefined), "null");
	assert.equal(look.scriptLiteral(null), "null");
});

test("the template is filled in one pass: values are not patterns and are not filled again", () => {
	const out = look.fillTemplate("a=$$one$$; b=$$two$$; c=$$one$$; d=$$unknown$$", { one: "$& $$two$$ $1", two: "2" });
	assert.equal(out, "a=$& $$two$$ $1; b=2; c=$& $$two$$ $1; d=$$unknown$$");
});

test("every placeholder of the editor page is filled by the extension and by the desktop app", () => {
	const template = read("src/DrawioClient/webview-content.html");
	const names = new Set(Array.from(template.matchAll(/\$\$([A-Za-z][\w-]*)\$\$/g), (m) => m[1]));
	assert.ok(names.has("omniConfig") && names.has("localStorage"));
	const factory = read("src/DrawioClient/DrawioClientFactory.ts");
	const desktop = read("standalone/src/main/staticServer.ts");
	for (const name of names) {
		assert.ok(factory.includes(`\t${name}: `) || factory.includes(`"${name}": `), `the extension fills ${name}`);
		assert.ok(desktop.includes("$$" + name + "$$") || desktop.includes("\\$\\$" + name + "\\$\\$"), `the desktop app fills ${name}`);
	}
	// plugin scripts run in the order given
	assert.match(template, /pluginScript\.async = false;/);
});

test("the shared toolbar leaves out what the host switches off, and keeps the desktop app's defaults", () => {
	const toolbar = read("standalone/src/renderer/desktop-toolbar.js");
	// no config (the desktop app): every feature is on
	assert.ok(toolbar.includes("return !CFG.features || CFG.features[feature] !== false;"));
	for (const gate of ['has("workshop") ? tb.addItems(["desktop.workshop"]', 'has("chat") && has("toolbar") ? document.querySelector(".geToolbarEnd")', 'has("workshop") ? ui.actions.get("shapes")', 'has("toolbar") ? ui.toolbar : null']) {
		assert.ok(toolbar.includes(gate), gate);
	}
	// the desktop app still reads its look from the page's address
	assert.ok(toolbar.includes("CFG.icons || (/[?&]icons="));
	assert.ok(toolbar.includes("CFG.toolbar || (/[?&]toolbar="));
});

test("the toolbar's commands reach the extension's event and the desktop app's unknown-message path", async () => {
	// (the desktop app uses the same client and takes "desktopCommand" from onUnknownMessage)
	const { CustomizedDrawioClient } = require(path.join(root, "src/DrawioClient/CustomizedDrawioClient.ts"));
	let deliver;
	const sent = [];
	const client = new CustomizedDrawioClient(
		{
			sendMessage: (m) => sent.push(JSON.parse(m)),
			registerMessageHandler: (handler) => {
				deliver = handler;
				return { dispose() {} };
			},
		},
		async () => ({}),
		() => {},
		() => "auto"
	);
	const commands = [];
	const unknown = [];
	client.onEditorCommand.sub(({ command }) => commands.push(command));
	client.onUnknownMessage.sub(({ message }) => unknown.push(message.event));
	deliver(JSON.stringify({ event: "desktopCommand", command: "present" }));
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(commands, ["present"]);
	assert.deepEqual(unknown, ["desktopCommand"]);

	// no tools in the page: no question is asked (a question without an answer would stay pending)
	assert.equal(client.editorToolsLoaded, false);
	assert.equal(await client.editorLookState(50), undefined);
	assert.deepEqual(sent, []);

	// the tools report themselves, then answer questions; a missing answer gives undefined
	const state = { host: "vscode", presenting: false };
	deliver(JSON.stringify({ event: "desktopState", state }));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(client.editorToolsLoaded, true);
	sent.length = 0;
	const loads = [];
	client.onEditorToolsLoaded.sub(({ state: s }) => loads.push(s.host));
	deliver(JSON.stringify({ event: "desktopState", state, loaded: true }));
	assert.deepEqual(loads, ["vscode"]);
	const asked = client.editorLookState(500);
	assert.deepEqual(sent, [{ action: "desktopReportState", reqId: 1 }]);
	// the page answers twice (it gets every message twice): the second answer is not the next request's
	deliver(JSON.stringify({ event: "desktopState", reqId: 1, state: { ...state, presenting: true } }));
	assert.equal((await asked).presenting, true);
	const next = client.editorLookState(40);
	deliver(JSON.stringify({ event: "desktopState", reqId: 1, state: { ...state, presenting: true } }));
	assert.equal(await next, undefined);

	// a page that loads again starts without tools until they report themselves
	deliver(JSON.stringify({ event: "pluginLoaded", pluginId: "ai" }));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(client.editorToolsLoaded, false);
	deliver(JSON.stringify({ event: "desktopState", state, loaded: true }));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(client.editorToolsLoaded, true);

	client.setEditorPrefs({ iconStyle: "real", toolbar: "left", matrix: "off" });
	client.setPresenting(true);
	assert.deepEqual(sent.slice(-2), [
		{ action: "desktopPrefs", iconStyle: "real", toolbar: "left", matrix: "off" },
		{ action: "desktopPresentation", enabled: true },
	]);
});
