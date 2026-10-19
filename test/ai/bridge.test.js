// Unit tests for the agent bridge (src/agent-bridge): window discovery, routing,
// the launcher, and forwarding to real MCP listeners standing in for VS Code windows.
// Run: node --test test/ai/bridge.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const src = (p) => path.resolve(__dirname, "../../src", p);
const { pickInstance, readInstances, writeInstance, removeInstance, writeLauncher, launcherPath } = require(src("agent-bridge/discovery.ts"));
const { AgentBridge, NOT_RUNNING } = require(src("agent-bridge/bridge.ts"));
const { createMcpListener } = require(src("features/ai/mcp.ts"));
const { toMcpTools } = require(src("features/ai/toolSchemas.ts"));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `drawio-ai-${name}-`));

function instance(over) {
	return {
		version: 1,
		pid: process.pid,
		port: 1,
		token: "t",
		app: "Visual Studio Code",
		extensionVersion: "0.0.0",
		workspaceFolders: [],
		openDiagrams: [],
		focused: false,
		lastFocusedAt: 0,
		...over,
	};
}

test("routing: the window with the diagram open wins, then the folder that holds it, then the agent's folder, then focus", () => {
	const a = instance({ pid: 1, workspaceFolders: ["/work/api"], openDiagrams: [], lastFocusedAt: 100 });
	const b = instance({ pid: 2, workspaceFolders: ["/work/web"], openDiagrams: ["/work/web/docs/arch.drawio"], lastFocusedAt: 50 });
	const c = instance({ pid: 3, workspaceFolders: ["/work/ops"], lastFocusedAt: 10, focused: true });
	const all = [a, b, c];
	const none = () => false;
	assert.equal(pickInstance(all, { file: "/work/web/docs/arch.drawio", roots: [], exists: none }).instance.pid, 2);
	assert.equal(pickInstance(all, { file: "docs/arch.drawio", roots: [], exists: none }).instance.pid, 2, "relative path matched against open diagrams");
	assert.equal(pickInstance(all, { file: "/work/api/x.drawio", roots: [], exists: none }).reason, "workspace");
	assert.equal(pickInstance(all, { file: "/work/api/x.drawio", roots: [], exists: none }).instance.pid, 1);
	assert.equal(pickInstance(all, { file: "new.drawio", roots: [], exists: (p) => p === path.join("/work/ops", "new.drawio") }).instance.pid, 3);
	assert.deepEqual(pickInstance(all, { roots: ["/work/api/src"], exists: none }), { instance: a, reason: "root" });
	assert.deepEqual(pickInstance(all, { roots: [], exists: none }), { instance: c, reason: "focus" }, "the focused window beats a more recent timestamp");
	assert.equal(pickInstance([], { roots: [] }), undefined);
});

test("discovery files are user-only, and entries of windows that are gone are dropped", () => {
	const home = tmp("home");
	writeInstance(home, instance({ pid: process.pid, port: 4242 }));
	writeInstance(home, instance({ pid: 2 ** 22 + 12345, port: 4343 })); // no such process
	const file = path.join(home, "instances", `${process.pid}.json`);
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const live = readInstances(home);
	assert.deepEqual(live.map((i) => i.port), [4242]);
	assert.deepEqual(fs.readdirSync(path.join(home, "instances")), [`${process.pid}.json`]);
	removeInstance(home, process.pid);
	assert.deepEqual(readInstances(home), []);
});

test("the launcher runs the bridge with the given runtime, even with spaces and quotes in paths", { skip: process.platform === "win32" }, () => {
	const home = tmp("launch");
	const dir = path.join(home, "it's a dir");
	fs.mkdirSync(dir);
	const script = path.join(dir, "bridge.js");
	fs.writeFileSync(script, "console.log(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }))");
	const file = writeLauncher(home, { execPath: process.execPath, bridgePath: script });
	assert.equal(file, launcherPath(home));
	const out = JSON.parse(execFileSync(file, ["--x", "a b"], { encoding: "utf8" }));
	assert.deepEqual(out, { args: ["--x", "a b"], electron: "1" });
});

// Fake VS Code windows: real MCP listeners with recording deps.
const windows = [];
async function startWindow(name, token = "secret-" + name) {
	const calls = [];
	const deps = {
		serverVersion: "1",
		tools: toMcpTools,
		callTool: async (tool, args, meta) => {
			calls.push({ tool, args, meta });
			return { text: `${name}:${tool}`, image: tool === "drawio_render_image" ? { mimeType: "image/png", base64: "iVBORw0KGgo=" } : undefined };
		},
		instructions: async () => `instructions from ${name}`,
	};
	let port = 0;
	const server = http.createServer(createMcpListener({ token: () => token, port: () => port, deps }));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	port = server.address().port;
	const w = { name, port, token, calls, server };
	windows.push(w);
	return w;
}
after(() => windows.forEach((w) => w.server.close()));

function bridgeFor(home, env = {}) {
	const sent = [];
	const waiters = [];
	const bridge = new AgentBridge({
		home,
		env,
		version: "9.9.9",
		write: (m) => {
			sent.push(m);
			for (const w of [...waiters]) if (w.match(m)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(m);
		},
		initializeTimeoutMs: 1000,
	});
	const next = (match) => {
		const found = sent.find(match);
		return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ match, resolve }));
	};
	let id = 0;
	const call = async (method, params) => {
		const n = ++id;
		await bridge.receive({ jsonrpc: "2.0", id: n, method, params });
		return next((m) => m.id === n);
	};
	return { bridge, sent, next, call };
}

test("forwards tool calls to the right window, with the agent's name, and passes images through", async () => {
	const a = await startWindow("A");
	const b = await startWindow("B");
	const home = tmp("route");
	const folderA = tmp("folderA");
	fs.writeFileSync(path.join(folderA, "flow.drawio"), "");
	writeInstance(home, instance({ pid: process.pid, port: a.port, token: a.token, workspaceFolders: [folderA], focused: true, lastFocusedAt: 2 }));
	writeInstance(home, instance({ pid: process.ppid, port: b.port, token: b.token, workspaceFolders: ["/elsewhere"], openDiagrams: ["/elsewhere/b.drawio"], lastFocusedAt: 1 }));

	const { call } = bridgeFor(home);
	const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
	assert.equal(init.result.serverInfo.name, "draw-ai");
	assert.equal(init.result.serverInfo.version, "9.9.9");
	assert.equal(init.result.instructions, "instructions from A", "instructions come from the focused window");

	const list = await call("tools/list", {});
	assert.ok(list.result.tools.some((t) => t.name === "drawio_list_diagrams"));
	assert.ok(list.result.tools.find((t) => t.name === "drawio_get_diagram").inputSchema.properties.file, "diagram tools take `file`");
	assert.equal(list.result.tools.find((t) => t.name === "drawio_create").inputSchema.properties.file, undefined);

	const toB = await call("tools/call", { name: "drawio_get_diagram", arguments: { file: "/elsewhere/b.drawio" } });
	assert.equal(toB.result.content[0].text, "B:drawio_get_diagram");
	assert.equal(b.calls[0].meta.client, "claude-code");
	assert.deepEqual(b.calls[0].args, { file: "/elsewhere/b.drawio" });

	const toA = await call("tools/call", { name: "drawio_apply_operations", arguments: { file: "flow.drawio", ops: [] } });
	assert.equal(toA.result.content[0].text, "A:drawio_apply_operations", "relative path found in A's folder");

	const create = await call("tools/call", { name: "drawio_create", arguments: { path: "/elsewhere/new.drawio" } });
	assert.equal(create.result.content[0].text, "B:drawio_create", "drawio_create routes by its path");

	const focused = await call("tools/call", { name: "drawio_render_image", arguments: {} });
	assert.equal(focused.result.content[0].text, "A:drawio_render_image");
	assert.deepEqual(focused.result.content[1], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
});

test("asks the agent for its roots and routes by them", async () => {
	const a = await startWindow("RA");
	const b = await startWindow("RB");
	const home = tmp("roots");
	writeInstance(home, instance({ pid: process.pid, port: a.port, token: a.token, workspaceFolders: ["/proj/one"], focused: true, lastFocusedAt: 5 }));
	writeInstance(home, instance({ pid: process.ppid, port: b.port, token: b.token, workspaceFolders: ["/proj/two"], lastFocusedAt: 1 }));
	const { bridge, call, next } = bridgeFor(home);
	await call("initialize", { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "codex-mcp-client", version: "1" } });
	await bridge.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
	const request = await next((m) => m.method === "roots/list");
	await bridge.receive({ jsonrpc: "2.0", id: request.id, result: { roots: [{ uri: "file:///proj/two/service", name: "service" }] } });
	await new Promise((r) => setImmediate(r));
	const res = await call("tools/call", { name: "drawio_lint", arguments: {} });
	assert.equal(res.result.content[0].text, "RB:drawio_lint");
});

test("skips a window that stopped answering, reports a refused token, and explains when VS Code is not running", async () => {
	const live = await startWindow("LIVE");
	const dead = await startWindow("DEAD");
	await new Promise((r) => dead.server.close(r));
	const home = tmp("dead");
	writeInstance(home, instance({ pid: process.pid, port: dead.port, token: dead.token, focused: true, lastFocusedAt: 9 }));
	writeInstance(home, instance({ pid: process.ppid, port: live.port, token: live.token, lastFocusedAt: 1 }));
	const { call } = bridgeFor(home);
	const res = await call("tools/call", { name: "drawio_get_xml", arguments: {} });
	assert.equal(res.result.content[0].text, "LIVE:drawio_get_xml");

	const badHome = tmp("bad");
	writeInstance(badHome, instance({ pid: process.pid, port: live.port, token: "wrong" }));
	const refused = await bridgeFor(badHome).call("tools/call", { name: "drawio_get_xml", arguments: {} });
	assert.equal(refused.id, 1);
	assert.equal(refused.result.isError, true);
	assert.match(refused.result.content[0].text, /HTTP 401/);

	const { call: callNone } = bridgeFor(tmp("none"));
	const init = await callNone("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } });
	assert.match(init.result.instructions, /Draw\.AI extension/, "generic instructions without a window");
	const none = await callNone("tools/call", { name: "drawio_get_diagram", arguments: {} });
	assert.equal(none.result.isError, true);
	assert.equal(none.result.content[0].text, NOT_RUNNING);
});
