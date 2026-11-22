// Unit tests for the Mapper in the VS Code extension: the desktop app's Mapper
// (standalone/src/main/mapper) used as it is, its page as a webview loads it, its tools in
// the manifest and over MCP, and the dialog logic both programs share.
// Run: node --test test/ai/mapper.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2022", esModuleInterop: true },
});

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const mapper = (file) => require(path.join(root, "standalone/src/main/mapper", file));
const { mapperPageHtml, pageNonce, MAPPER_PAGE } = require(path.join(root, "src/features/mapper/mapperPage.ts"));
const { allMcpTools, MAPPER_TOOL_SCHEMAS, MAPPER_TOOL_NAMES } = require(path.join(root, "src/features/ai/allTools.ts"));
const { handleMcpMessage } = require(path.join(root, "src/features/ai/mcp.ts"));

const PAGE = read("standalone/src/renderer/mapper.html");
const OPTIONS = { nonce: "abc123", cspSource: "https://file.vscode-cdn.test", base: "https://file.vscode-cdn.test/ext/dist/custom-drawio-plugins/omni/" };

test("the page names its files by their webview address, with one nonce, and gets a bridge before anything loads", () => {
	const html = mapperPageHtml(PAGE, OPTIONS);
	assert.doesNotMatch(html, /\$\$/, "a placeholder is left");
	assert.doesNotMatch(html, /["']\/ui\//, "a file is still named from the root");
	const base = "https://file.vscode-cdn.test/ext/dist/custom-drawio-plugins/omni";
	for (const file of ["fonts.css", "tokens.css", "motion.css", "depth.css", "app.css", "brandmark.js", "icons.js", "tips.js", "brands.js", "dots.js", "matrix.js"]) {
		assert.ok(html.includes(`"${base}/ui/${file}"`), `${file} is not named by its webview address`);
	}
	// every script and style sheet carries the nonce the policy names
	assert.match(html, /script-src 'nonce-abc123' https:\/\/file\.vscode-cdn\.test;/);
	for (const tag of html.match(/<(script|style|link rel="stylesheet")\b[^>]*>/g)) assert.match(tag, /nonce="abc123"/, tag);
	// the bridge is the first script: the page's own script reads window.drawaiMapper as it starts
	const bridge = html.indexOf("acquireVsCodeApi()");
	assert.ok(bridge > html.indexOf("</title>") && bridge < html.indexOf('<link rel="stylesheet"'), "the bridge is not before the page's files");
	assert.match(html, /window\.drawaiMapper = \{/);
	assert.match(html, /host: "vscode"/);
	// the desktop app's page is not changed by it
	assert.ok(html.includes("host.post({ type: \"ready\" })"));
});

test("a nonce is letters and digits, and nothing else gets into the page as one", () => {
	const nonce = pageNonce((n) => new Uint8Array(n).fill(171));
	assert.equal(nonce, "ab".repeat(16));
	assert.throws(() => mapperPageHtml(PAGE, { ...OPTIONS, nonce: 'x" onload="alert(1)' }), /letters and digits/);
	assert.throws(() => mapperPageHtml("<html></html>", OPTIONS), /no <title>/);
});

test("the plugin build copies the page and every file it loads", () => {
	const config = read("drawio-custom-plugins/webpack.config.ts");
	assert.match(config, /standalone\/src\/renderer\/mapper\.html"\), to: "omni\/mapper\.html"/);
	assert.equal(MAPPER_PAGE, "mapper.html");
	const files = [...new Set([...PAGE.matchAll(/["']\/ui\/([\w.-]+)["']/g)].map((m) => m[1]))];
	assert.ok(files.length >= 10, files.join(", "));
	for (const f of files) {
		assert.ok(config.includes(`"${f}"`), `${f} is loaded by the page but not copied by the plugin build`);
		assert.ok(fs.existsSync(path.join(root, "standalone/src/renderer/ui", f)), `${f} does not exist`);
	}
	// matrix.js loads dots.js, and fonts.css the font files, relative to themselves
	for (const font of [...read("standalone/src/renderer/ui/fonts.css").matchAll(/url\("\.\/fonts\/([\w-]+)\.woff2"\)/g)].map((m) => m[1]).filter((f) => !f.startsWith("doto"))) {
		assert.ok(config.includes(`"${font}"`), `${font} is named by fonts.css but not copied`);
	}
});

test("the Mapper's tool definitions are data only, and the manifest and the agent list every one", () => {
	const source = read("standalone/src/main/mapper/toolSchemas.ts");
	// (the generators load this file on its own: an import that is not a type would fail there)
	for (const line of source.split("\n").filter((l) => /^import /.test(l))) assert.match(line, /^import type /, line);
	assert.equal(MAPPER_TOOL_SCHEMAS.length, 13);
	const manifest = new Map(pkg.contributes.languageModelTools.map((t) => [t.name, t]));
	const agent = read("media/chat/draw-ai.agent.md");
	const skill = read("agent-plugin/skills/drawio-diagrams/SKILL.md");
	for (const t of MAPPER_TOOL_SCHEMAS) {
		const m = manifest.get(t.name);
		assert.ok(m, `${t.name} is not in package.json`);
		assert.equal(m.modelDescription, t.description);
		assert.equal(m.displayName, t.title);
		assert.deepEqual(m.inputSchema, t.inputSchema);
		assert.equal(m.toolReferenceName, t.name.replace(/_/g, "-"));
		assert.ok(agent.includes(`${pkg.publisher}.${pkg.name}/${m.toolReferenceName}`), `${t.name} is not one of the Draw.AI agent's tools`);
		assert.ok(skill.includes(`\`${t.name}\``), `${t.name} is not in the agent plugin's skill`);
		// several model providers reject or mishandle these
		assert.doesNotMatch(JSON.stringify(t.inputSchema), /"(oneOf|anyOf|allOf)"/, t.name);
	}
	// what each tool does is defined for exactly the tools that are listed
	const { MAPPER_TOOLS } = mapper("mcpTools.ts");
	assert.deepEqual(MAPPER_TOOLS.map((t) => [t.name, typeof t.run]), MAPPER_TOOL_SCHEMAS.map((t) => [t.name, "function"]));
	assert.match(agent, /mapper_maps/);
});

test("MCP lists the diagram tools and the Mapper's, each once, and says which only read", async () => {
	const tools = allMcpTools();
	assert.equal(tools.length, 18 + 13);
	assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
	assert.equal(tools.filter((t) => MAPPER_TOOL_NAMES.has(t.name)).length, 13);
	const readOnly = tools.filter((t) => MAPPER_TOOL_NAMES.has(t.name) && t.readOnly).map((t) => t.name);
	assert.deepEqual(readOnly, ["mapper_maps", "mapper_list_recipes", "mapper_find", "mapper_show", "mapper_path", "mapper_findings", "mapper_worksheet"]);
	const calls = [];
	const deps = { serverVersion: "0", tools: allMcpTools, callTool: async (name, args) => (calls.push([name, args]), { text: "ok" }), instructions: async () => "" };
	const listed = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps);
	const run = listed.result.tools.find((t) => t.name === "mapper_run");
	assert.deepEqual([run.title, run.annotations.readOnlyHint], ["Map Something", false]);
	assert.equal(listed.result.tools.find((t) => t.name === "mapper_find").annotations.readOnlyHint, true);
	await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mapper_maps", arguments: {} } }, deps);
	assert.deepEqual(calls, [["mapper_maps", {}]]);
	// the extension's server and the bridge list the same tools (the real VS Code suite calls one over MCP)
	assert.match(read("src/features/ai/McpService.ts"), /tools: allMcpTools,/);
	assert.match(read("src/agent-bridge/bridge.ts"), /tools: allMcpTools,/);
});

test("the Mapper's commands, view and menus are contributed, and what needs a clicked item stays out of the palette", () => {
	const feature = read("src/features/mapper/MapperFeature.ts");
	const registered = [...feature.matchAll(/(?:command|registerCommand)\("(drawio-ai\.[\w.]+)"/g)].map((m) => m[1]);
	const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
	const internal = ["drawio-ai.maps.run", "drawio-ai.maps.tool", "drawio-ai.maps.state", "drawio-ai.maps.makeTarget"];
	for (const c of registered) assert.equal(contributed.has(c), !internal.includes(c), `${c}: registered ${internal.includes(c) ? "for tests only, but contributed" : "but not contributed"}`);
	for (const c of [...contributed].filter((c) => c === "drawio-ai.mapSomething" || c.startsWith("drawio-ai.maps."))) assert.ok(registered.includes(c), `${c} is contributed but not registered`);
	assert.ok(pkg.contributes.views["drawio-ai"].some((v) => v.id === "drawio-ai.maps"));
	assert.match(feature, /createTreeView\("drawio-ai\.maps"/);
	const menus = pkg.contributes.menus;
	for (const item of [...menus["view/title"], ...menus["view/item/context"], ...menus["editor/title"]]) assert.ok(contributed.has(item.command), `${item.command} is in a menu but not a command`);
	const hidden = new Set(menus.commandPalette.filter((m) => m.when === "false").map((m) => m.command));
	for (const c of ["drawio-ai.maps.playTour", "drawio-ai.maps.showFinding", "drawio-ai.maps.fixFinding", "drawio-ai.maps.dismissFinding", "drawio-ai.maps.showShapes"]) assert.ok(hidden.has(c), `${c} needs an item of the Maps view`);
	// the items of the view name the commands and the context values the menus use
	const view = read("src/features/mapper/MapsView.ts");
	for (const value of ["drawioMap", "drawioMapFinding", "drawioMapTour"]) {
		assert.ok(view.includes(`"${value}"`), value);
		assert.ok(menus["view/item/context"].some((m) => m.when.includes(`viewItem == ${value}`)), value);
	}
	for (const c of [...view.matchAll(/command: "(drawio-ai\.[\w.]+)"/g)].map((m) => m[1])) assert.ok(contributed.has(c), `${c} is used by the Maps view but not contributed`);
});

test("the extension bundles the Mapper's database drivers from its own packages, in step with the desktop app's", () => {
	const desktop = JSON.parse(read("standalone/package.json")).dependencies;
	const config = read("webpack.config.ts");
	for (const driver of ["pg", "mysql2", "mssql", "oracledb", "mongodb"]) {
		assert.equal(pkg.devDependencies[driver], desktop[driver], `${driver}: the extension and the desktop app ask for different versions`);
		assert.ok(config.includes(`"${driver}"`), `${driver} is not taken from the extension's own packages`);
	}
	assert.equal(pkg.dependencies["js-yaml"], desktop["js-yaml"]);
	assert.match(config, /"node:sqlite": "commonjs node:sqlite"/);
});

/** The page's other half with everything around it faked. */
function dialog(overrides = {}) {
	const { MapperDialogCore } = mapper("dialog.ts");
	const posted = [];
	const asked = [];
	let saved = {};
	const ports = {
		post: (msg) => posted.push(msg),
		cwd: () => "/work/diagrams",
		ready: () => true,
		service: () => ({
			run: async (recipeId, input) => ({
				record: { id: "m1", title: "Shop", graph: { nodes: [{ id: "a" }] }, findings: [{}, {}] },
				result: { summary: "3 services", facts: "FACTS ABOUT THE SHOP", graph: { title: "Shop" }, warnings: [] },
				drawn: { cells: 7, newPage: true, page: "Shop" },
				badges: 2,
				input,
			}),
		}),
		context: () => ({ cwd: "/work/diagrams", signal: new AbortController().signal, progress: () => undefined, exec: async () => ({ stdout: "", stderr: "", code: 0 }) }),
		askAgent: (text, shown, facts) => asked.push({ text, shown, facts }),
		showChat: () => undefined,
		loadInputs: () => ({ ...saved }),
		saveInputs: (all) => (saved = all),
		pick: async (kind, current) => `/picked/${kind}${current ? `-from-${path.basename(current)}` : ""}`,
		look: () => ({ iconStyle: "real", matrix: "green" }),
		close: () => posted.push({ type: "closed" }),
		...overrides,
	};
	return { core: new MapperDialogCore(ports), posted, asked, saved: () => saved };
}

test("the dialog gives the page the catalog, the remembered inputs and the look, and answers Choose and Close", async () => {
	const { core, posted } = dialog();
	await core.onMessage({ type: "ready" });
	const catalog = posted[0];
	assert.equal(catalog.type, "catalog");
	assert.deepEqual([catalog.cwd, catalog.iconStyle, catalog.matrix], ["/work/diagrams", "real", "green"]);
	assert.deepEqual(catalog.catalog.categories.map((c) => c.id), ["software", "database", "azure", "aws", "gcp", "ml"]);
	assert.ok(catalog.catalog.recipes.length >= 19);
	// functions do not cross to the page
	assert.doesNotThrow(() => structuredClone(catalog));
	await core.onMessage({ type: "pick", kind: "folder", fieldId: "folder", current: "/work/old" });
	assert.deepEqual(posted[1], { type: "picked", fieldId: "folder", path: "/picked/folder-from-old" });
	await core.onMessage({ type: "close" });
	assert.deepEqual(posted[2], { type: "closed" });
});

test("a run remembers the inputs without secrets and hands the map to the agent", async () => {
	const { core, posted, asked, saved } = dialog();
	const input = { engine: "postgres", connectWith: "url", connectionString: "postgres://admin:hunter2@db.example.com/shop", schemas: "public" };
	const out = await core.run("database.schema", input, true);
	assert.equal(out.mapId, "m1");
	// nothing secret is kept: not the field, and no credentials inside other fields
	assert.equal(saved()["database.schema"].connectionString, undefined);
	assert.doesNotMatch(JSON.stringify(saved()), /hunter2/);
	assert.equal(saved()["database.schema"].schemas, "public");
	assert.deepEqual(posted.map((m) => m.type), ["running", "done"]);
	assert.match(posted[1].summary, /3 services .*Drew 7 cells on a new page "Shop".*2 finding\(s\).*Handed to the agent/);
	assert.equal(asked.length, 1);
	assert.match(asked[0].text, /<facts collected read-only by the Mapper>\nFACTS ABOUT THE SHOP\n<\/facts>/);
	assert.doesNotMatch(asked[0].text + asked[0].shown, /hunter2/);

	// "describe every shape" goes to the agent with the map's id
	const describe = dialog();
	await describe.core.run("database.schema", input, false, true);
	assert.match(describe.asked[0].text, /map id m1/);

	// VS Code's chat shows a request as the user's message: there the facts travel as an attachment
	const { splitFacts } = require(path.join(root, "src/features/mapper/requests.ts"));
	const split = splitFacts(asked[0].text);
	assert.equal(split.facts, "FACTS ABOUT THE SHOP");
	assert.doesNotMatch(split.text, /FACTS ABOUT THE SHOP|<\/?facts/);
	assert.match(split.text, /Rules:\n- Work ONLY through the drawio_\* tools/);
	assert.match(split.text, /attached as "map-facts"\.$/);
	assert.deepEqual(splitFacts("Describe the map."), { text: "Describe the map." });
	assert.equal(splitFacts("A\n\n<facts collected read-only by the Mapper>\nshort\n</facts>\nB\n\n<facts collected read-only by the Mapper>\nthe longer one\n</facts>").facts, "the longer one");
});

test("a run that cannot start says why: fields missing, an unknown map, a diagram not ready, a map already being made", async () => {
	const missing = dialog();
	assert.equal((await missing.core.run("software.connectivity", {}, false)).error, "missing fields");
	assert.match(missing.posted[0].message, /^Fill in: /);
	assert.equal((await dialog().core.run("nope", {}, false)).error, "Unknown map nope");
	const loading = dialog({ ready: () => false });
	assert.equal((await loading.core.run("software.connectivity", { folder: "/x" }, false)).error, "not ready");
	let release;
	const slow = dialog({ service: () => ({ run: () => new Promise((_res, rej) => (release = () => rej(new Error("stopped")))) }) });
	const first = slow.core.run("software.connectivity", { folder: "/x" }, false);
	assert.equal(slow.core.busy, true);
	assert.equal((await slow.core.run("software.connectivity", { folder: "/x" }, false)).error, "busy");
	release();
	assert.equal((await first).error, "stopped");
	assert.equal(slow.core.busy, false);
	assert.deepEqual(slow.posted.map((m) => m.type), ["running", "failed", "failed"]);
});

test("requests to the agent name the host's diagram tools and its way to play a tour", () => {
	const common = mapper("recipes/common.ts");
	const prompts = mapper("prompts.ts");
	const record = { id: "m1", title: "Shop", graph: { nodes: [{ id: "a", label: "API", data: {}, files: ["api/main.py"] }] } };
	assert.match(common.agentRequest("Do it."), /drawio_\* tools of the "omnidraw" MCP server/);
	assert.match(prompts.tourPrompt(record, ""), /press F5 \(presentation mode\)/);
	try {
		common.setToolSource("of the Draw.AI extension");
		assert.match(common.agentRequest("Do it."), /drawio_\* tools of the Draw\.AI extension to read and change the diagram/);
		assert.doesNotMatch(common.agentRequest("Do it."), /omnidraw/);
		// F5 starts a debugger in VS Code
		const tour = prompts.tourPrompt(record, "checkout", "click the tour in the Maps view");
		assert.match(tour, /focused on: checkout/);
		assert.match(tour, /telling the user to click the tour in the Maps view\./);
		assert.doesNotMatch(tour, /F5/);
		const fix = prompts.fixFindingPrompt(record, { id: "f1", kind: "k", severity: "high", title: "API is open to the internet", detail: "0.0.0.0/0 on 22", nodeIds: ["a"], fix: "Restrict it" });
		assert.match(fix, /Fix this finding from the map "Shop" \(map m1\): API is open to the internet\./);
		assert.match(fix, /Evidence: 0\.0\.0\.0\/0 on 22\nSuggested fix: Restrict it/);
		assert.match(fix, /"files":\["api\/main\.py"\]/);
		assert.match(fix, /never change live cloud resources or databases yourself/);
	} finally {
		common.setToolSource('of the "omnidraw" MCP server');
	}
	// the extension sets both
	const feature = read("src/features/mapper/MapperFeature.ts");
	assert.match(feature, /rt\.setToolSource\("of the Draw\.AI extension"\)/);
	assert.match(feature, /rt\.tourPrompt\(r, about, PLAY_TOUR\)/);
	assert.doesNotMatch(feature.match(/const PLAY_TOUR = .*/)[0], /F5/);
});

test("the Mapper stays read-only in the extension, and git never runs a repository's own programs", async () => {
	const feature = read("src/features/mapper/MapperFeature.ts");
	// commands run through the desktop app's guarded runner, nothing else
	assert.doesNotMatch(feature, /child_process|execFile|spawn\(/);
	assert.match(feature, /rt\.createContext\(/);
	assert.match(feature, /if \(!vscode\.workspace\.isTrusted\) \{\s*throw new rt\.MapperError/);
	const { checkReadOnly } = mapper("readOnly.ts");
	assert.equal(checkReadOnly("git", ["status", "--short"]), undefined);
	assert.match(checkReadOnly("git", ["push"]), /not a read-only command/);
	assert.match(checkReadOnly("az", ["vm", "delete", "--name", "x"]), /not a read-only command/);
	assert.match(checkReadOnly("rm", ["-rf", "/"]), /not one of the Mapper's read-only tools/);

	// A repository can name a program for git to start on `git status` (core.fsmonitor): the Mapper's git does not start it.
	const os = require("os");
	const { execFileSync } = require("child_process");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-mapper-git-"));
	const marker = path.join(repo, "RAN");
	const hook = path.join(repo, "hook.sh");
	fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(repo, "a.txt"), "a");
	const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("add", "a.txt");
	git("commit", "-qm", "initial");
	git("config", "core.fsmonitor", hook);
	const { createContext } = mapper("context.ts");
	const ctx = createContext({ cwd: repo, env: process.env });
	const status = await ctx.exec("git", ["status", "--short"]);
	assert.equal(status.code, 0, status.stderr);
	assert.match(status.stdout, /hook\.sh/);
	assert.equal(fs.existsSync(marker), false, "git started the repository's own program");
	await assert.rejects(ctx.exec("git", ["commit", "-m", "x"]), /Refused: .*not a read-only command/);
});

test("a signal given to a tool call stops the map it started", async () => {
	const { callMapperTool } = mapper("mcpTools.ts");
	const seen = [];
	// (the service checks the signal after collecting and before drawing: here it only has to arrive)
	const service = {
		run: async (recipe, input, opts) => (seen.push(["run", opts.signal]), Promise.reject(new Error("Cancelled"))),
		record: () => ({ id: "m1" }),
		refresh: async (record, secrets, opts) => (seen.push(["refresh", opts.signal]), Promise.reject(new Error("Cancelled"))),
	};
	const ac = new AbortController();
	const run = await callMapperTool(service, "mapper_run", { recipe: "software.connectivity", input: { folder: "/x" } }, { signal: ac.signal });
	const again = await callMapperTool(service, "mapper_refresh", {}, { signal: ac.signal });
	assert.deepEqual([run.isError, run.text, again.isError], [true, "Cancelled", true]);
	assert.deepEqual(seen, [["run", ac.signal], ["refresh", ac.signal]]);
});

test("only a commit hash from a map's record reaches git's arguments", async () => {
	const { MapperService } = mapper("service.ts");
	const calls = [];
	const service = new MapperService({
		client: {},
		cwd: () => root,
		diagram: () => path.join(root, "x.drawio"),
		context: () => ({ cwd: root, signal: new AbortController().signal, progress: () => undefined, exec: async (command, args) => (calls.push([command, ...args]), { stdout: "", stderr: "", code: 0 }) }),
	});
	const record = (head) => ({ id: "m1", title: "T", root, git: { head }, graph: { title: "T", nodes: [], edges: [] }, findings: [], dismissed: {}, descriptions: {}, tours: [], checked: [], fingerprints: {} });
	// a record is a file next to the diagram: anyone can have written it
	const crafted = await service.recentChanges(record("--output=/tmp/pwned"));
	assert.equal(crafted.since, undefined);
	assert.ok(calls.length > 0);
	assert.doesNotMatch(JSON.stringify(calls), /--output|pwned/);
	calls.length = 0;
	const real = await service.recentChanges(record("0123456789abcdef0123456789abcdef01234567"));
	assert.equal(real.since, "0123456");
	assert.ok(calls.some((c) => c.includes("0123456789abcdef0123456789abcdef01234567..HEAD")));
});

test("tours keep unique ids, and a renamed diagram keeps its maps", () => {
	const os = require("os");
	const { MapperService } = mapper("service.ts");
	const store = mapper("store.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-mapper-rec-"));
	let diagram = path.join(dir, "shop.drawio");
	const service = new MapperService({ client: {}, cwd: () => dir, diagram: () => diagram, context: () => { throw new Error("not used"); } });
	const record = { version: 1, id: "m1", recipe: "software.connectivity", title: "Shop", input: {}, createdAt: "", updatedAt: "", summary: "", graph: { title: "Shop", nodes: [{ id: "a", label: "A", kind: "k" }, { id: "b", label: "B", kind: "k" }], edges: [{ from: "a", to: "b" }] }, fingerprints: {}, findings: [], checked: [], dismissed: {}, descriptions: {}, tours: [] };
	const steps = [{ title: "One", caption: "This is where it starts.", nodeIds: ["a"] }, { title: "Two", caption: "And this is where it ends.", nodeIds: ["b"] }];
	for (const title of ["A", "B", "A", "C"]) assert.equal(service.setTour(record, title, steps).saved, true, title);
	// (saving "A" again replaced it; its id must not be handed to "C" as well)
	assert.deepEqual(record.tours.map((t) => t.title), ["B", "A", "C"]);
	assert.equal(new Set(record.tours.map((t) => t.id)).size, 3, JSON.stringify(record.tours.map((t) => t.id)));
	assert.equal(service.records().length, 1);

	// renamed in the same folder, then moved to another one
	const renamed = path.join(dir, "shop-v2.drawio");
	assert.equal(store.adoptRecords({ cwd: dir, diagram }, { cwd: dir, diagram: renamed }), 1);
	assert.equal(service.records().length, 0, "the old name still has the map");
	diagram = renamed;
	assert.deepEqual(service.records().map((r) => [r.id, r.diagram, r.tours.length]), [["m1", "shop-v2.drawio", 3]]);
	const other = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-mapper-rec-"));
	assert.equal(store.adoptRecords({ cwd: dir, diagram: renamed }, { cwd: other, diagram: path.join(other, "shop-v2.drawio") }), 1);
	assert.equal(store.loadRecord(other, "m1").diagram, "shop-v2.drawio");
	// the extension does this when VS Code renames a file
	assert.match(read("src/features/mapper/MapperFeature.ts"), /onDidRenameFiles\(\(e\) => void this\.adopt\(e\.files\)\)/);
});

test("before the agent starts a map the user is asked, with the fields' names and never their values", () => {
	const { collects, runConfirmation } = require(path.join(root, "src/features/mapper/requests.ts"));
	assert.deepEqual(MAPPER_TOOL_SCHEMAS.map((t) => t.name).filter(collects), ["mapper_run", "mapper_refresh"]);
	const ask = runConfirmation("mapper_run", { recipe: "database.schema", input: { engine: "postgres", connectionString: "postgres://admin:hunter2@db.example.com/shop", password: "hunter2" } });
	assert.equal(ask.title, "Map something into the diagram?");
	assert.match(ask.message, /The Mapper will run `database\.schema`: it collects read-only/);
	assert.match(ask.message, /With: `engine`, `connectionString`, `password`$/);
	assert.doesNotMatch(ask.message, /hunter2|postgres:\/\/|db\.example\.com/);
	// names from the agent cannot bring Markdown or a link into the question
	const odd = runConfirmation("mapper_run", { recipe: "x`](http://evil.example) [", input: { "a`b [c](d)": "v" } });
	assert.doesNotMatch(odd.message, /\]\(|evil\.example\)|\[c\]/);
	assert.match(runConfirmation("mapper_refresh", { mapId: "m1" }).message, /^The Mapper will run the same map again: /);
	assert.equal(runConfirmation("mapper_run", undefined).message.startsWith("The Mapper will run a map: "), true);
	// VS Code's chat asks through the tool's confirmation; `@drawio`, which has none, through a dialog; MCP agents ask their own user
	const feature = read("src/features/mapper/MapperFeature.ts");
	assert.match(feature, /confirmationMessages: ask \? \{/);
	assert.match(feature, /invoke: \(name, input, options\) => this\.callTool\(name, input, \{ confirm: !!options\.scoped, signal: options\.signal \}\)/);
	assert.match(read("src/features/ai/DiagramToolbox.ts"), /if \(this\.extra\?\.has\(name\)\) \{\s*return this\.extra\.invoke\(name, rawInput, options\);/);
	assert.match(read("src/Extension.ts"), /this\.aiFeature\.extraTools = this\.mapperFeature\.tools;/);
});
