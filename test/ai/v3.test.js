// Unit tests for v3 features: per-diagram chat persistence, live code links and the MCP endpoint.
// Run: node --test test/ai/v3.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});
require.extensions[".html"] = (m, file) => {
	m.exports = { __esModule: true, default: fs.readFileSync(file, "utf8") };
};

// ---------------------------------------------------------------------------
// Minimal vscode stub with an in-memory file system
// ---------------------------------------------------------------------------

const files = new Map();
const settings = {};
class Uri {
	constructor(p) {
		this.path = p;
		this.fsPath = p;
		this.scheme = "file";
	}
	static file(p) {
		return new Uri(p);
	}
	static joinPath(u, ...segs) {
		return new Uri(path.posix.normalize([u.path, ...segs].join("/")));
	}
	toString() {
		return `file://${this.path}`;
	}
	with({ path: p }) {
		return new Uri(p ?? this.path);
	}
}
const notFound = () => Object.assign(new Error("not found"), { code: "FileNotFound" });
const vscodeStub = {
	Uri,
	FileType: { File: 1, Directory: 2 },
	workspace: {
		getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
		fs: {
			readFile: async (u) => {
				if (!files.has(u.path)) throw notFound();
				return files.get(u.path);
			},
			writeFile: async (u, data) => void files.set(u.path, Buffer.from(data)),
			delete: async (u) => {
				if (!files.delete(u.path)) throw notFound();
			},
			createDirectory: async () => {},
			stat: async (u) => {
				if (!files.has(u.path)) throw notFound();
				return { type: 1, size: files.get(u.path).length };
			},
		},
		getWorkspaceFolder: () => undefined,
		workspaceFolders: [],
	},
	CancellationTokenSource: class {
		constructor() {
			this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
		}
		cancel() {
			this.token.isCancellationRequested = true;
		}
		dispose() {}
	},
	commands: { executeCommand: async () => {} },
	window: {},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const src = (p) => path.resolve(__dirname, "../../src/features/ai", p);
const { ChatViewProvider } = require(src("ChatViewProvider.ts"));
const { DiagramAgent } = require(src("DiagramAgent.ts"));
const { prepareForStorage, parseStoredChat } = require(src("chatStore.ts"));

// ---------------------------------------------------------------------------
// chat persistence
// ---------------------------------------------------------------------------

function scriptedClient(replies, vision = true) {
	const requests = [];
	return {
		requests,
		providerId: "anthropic",
		model: { id: "m", name: "M", vision },
		async *stream(req) {
			requests.push(JSON.parse(JSON.stringify(req.messages)));
			for (const evt of replies.shift() ?? [{ type: "text", text: "ok" }]) yield evt;
		},
	};
}

function makeProvider(client) {
	const state = new Map();
	const context = {
		storageUri: Uri.file("/storage/ws"),
		globalStorageUri: Uri.file("/storage/global"),
		globalState: { get: (k) => state.get(k), update: async (k, v) => void state.set(k, v) },
	};
	const registry = { providers: [], get: () => ({ getClient: async () => client, listModels: async () => [] }) };
	const toolbox = {
		specs: () => [{ name: "drawio_get_diagram", description: "", inputSchema: {} }],
		invoke: async () => ({ text: "x".repeat(10000), summary: "Read diagram", image: { mimeType: "image/png", base64: "AAAA" } }),
	};
	const editor = { uri: Uri.file("/repo/arch.drawio"), drawioClient: { currentSelection: [], aiSetStatus() {}, pendingReview: undefined } };
	const provider = new ChatViewProvider(context, registry, new DiagramAgent(toolbox), () => editor);
	return { provider, editor };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const storedFiles = () => [...files.keys()].filter((k) => k.startsWith("/storage/ws/chats/"));

test("chat panel conversations are saved per diagram and restored in a new session", async () => {
	files.clear();
	const first = scriptedClient([
		[{ type: "toolCall", id: "t1", name: "drawio_get_diagram", input: {} }],
		[{ type: "text", text: "Made it blue." }],
	]);
	const a = makeProvider(first);
	await a.provider.send("make it blue", undefined, { images: [{ mimeType: "image/png", base64: "QUJD".repeat(1000) }] });
	await settle();
	assert.equal(storedFiles().length, 1, "one file per diagram");
	const raw = files.get(storedFiles()[0]).toString("utf8");
	assert.doesNotMatch(raw, /QUJDQUJD/, "attached images are not stored");
	assert.doesNotMatch(raw, /"base64"/, "tool result images are not stored");
	assert.ok(raw.length < 12000, "large tool results are truncated");

	// A new provider (= VS Code restarted) restores the transcript and continues the conversation.
	const second = scriptedClient([[{ type: "text", text: "Now green." }]]);
	const b = makeProvider(second);
	await b.provider.send("and now green");
	const history = second.requests[0];
	assert.match(history[0].parts[0].text, /make it blue$/);
	assert.equal(history[0].parts[1].text, "[image omitted]");
	assert.equal(history[1].parts[0].type, "toolCall");
	assert.equal(history[2].parts[0].type, "toolResult");
	assert.match(history[3].parts[0].text, /Made it blue/);
	assert.match(history[4].parts[0].text, /and now green$/);

	const transcript = b.provider.conversation(b.editor).transcript;
	assert.deepEqual(
		transcript.map((t) => t.kind),
		["user", "tool", "assistant", "note", "user", "assistant"]
	);
	assert.match(transcript[3].text, /^Restored conversation from /);
	assert.equal(transcript[0].attachments[0], "🖼 1 image");

	// "New chat" forgets it on disk too.
	b.provider.newChat();
	await settle();
	assert.equal(storedFiles().length, 0);
	const c = makeProvider(scriptedClient([]));
	await c.provider.conversation(c.editor).loading;
	assert.equal(c.provider.conversation(c.editor).transcript.length, 0);
});

test("chat persistence can be turned off", async () => {
	files.clear();
	settings.persistChat = false;
	try {
		const a = makeProvider(scriptedClient([[{ type: "text", text: "hi" }]]));
		await a.provider.send("hello");
		await settle();
		assert.equal(storedFiles().length, 0);
	} finally {
		delete settings.persistChat;
	}
});

test("stored chats are size-capped by whole turns and validated on load", () => {
	const turn = (i) => [
		{ role: "user", parts: [{ type: "text", text: `q${i} ` + "x".repeat(15000) }] },
		{ role: "assistant", parts: [{ type: "toolCall", id: `c${i}`, name: "t", input: {} }] },
		{ role: "user", parts: [{ type: "toolResult", callId: `c${i}`, name: "t", text: "y".repeat(3000) }] },
		{ role: "assistant", parts: [{ type: "text", text: `a${i}` }] },
	];
	const messages = Array.from({ length: 120 }, (_, i) => turn(i)).flat();
	const stored = prepareForStorage("u", messages, [{ kind: "note", text: "x" }, { kind: "tool", id: "1", summary: "Edit", status: "running" }]);
	assert.ok(JSON.stringify(stored).length <= 1_500_000);
	assert.match(stored.messages[0].parts[0].text, /^q\d+ /, "starts at a user turn");
	assert.match(stored.messages.at(-1).parts[0].text, /^a119$/, "keeps the newest turn");
	assert.deepEqual(stored.transcript, [{ kind: "tool", id: "1", summary: "Edit (interrupted)", status: "error" }]);

	const dangling = JSON.stringify({ ...stored, messages: [...stored.messages, { role: "assistant", parts: [{ type: "toolCall", id: "z", name: "t", input: {} }] }] });
	assert.equal(parseStoredChat(dangling, "u").messages.at(-1).parts[0].text, "a119", "unanswered tool calls are dropped");
	assert.equal(parseStoredChat(dangling, "other"), undefined, "a file for another diagram is ignored");
	assert.equal(parseStoredChat("{not json", "u"), undefined);
});

// ---------------------------------------------------------------------------
// live code links
// ---------------------------------------------------------------------------

const links = require(src("codeLinks.ts"));
const { resolveLinkPath } = require(src("CodeLinkService.ts"));

const SQL = ["-- schema", "CREATE TABLE users (", "  id int primary key,", "  email text", ");", "", "CREATE TABLE orgs (id int);"];

test("code links: fingerprinted links detect unchanged, moved, changed and removed code", () => {
	const data = links.linkData("../db/schema.sql", SQL, 1, 4);
	assert.equal(data["hedietLinkedDataV1_end_col_x-num"], "2", "end column covers the last line");
	const link = links.parseLink(data);
	assert.deepEqual(link.start, { line: 1, col: 0 });
	assert.equal(link.anchor, "CREATE TABLE users (");

	const check = (lines) => links.checkLink(link, lines && lines.join("\n"));
	assert.equal(check(SQL).status, "ok");
	assert.equal(check(SQL.map((l) => l + "   ")).status, "ok", "trailing whitespace is ignored");

	const moved = check(["-- header", "-- more", ...SQL]);
	assert.equal(moved.status, "moved");
	assert.deepEqual(moved.newRange, { start: { line: 3, col: 0 }, end: { line: 6, col: 2 } });

	const changed = check(["CREATE TABLE orgs (id int);", ...SQL.slice(0, 3), "  email text,", "  name text", ");"]);
	assert.equal(changed.status, "changed");
	assert.equal(changed.newRange.start.line, 2);
	assert.match(changed.message, /was line 2/);

	assert.equal(check(SQL.map((l) => l.replace("users", "accounts"))).status, "missing-code");
	assert.equal(check(undefined).status, "missing-file");
});

test("code links: legacy links without fingerprints, symbol links, and path resolution", () => {
	const legacy = links.parseLink({
		hedietLinkedDataV1_path: "a.ts",
		"hedietLinkedDataV1_start_line_x-num": "10",
		"hedietLinkedDataV1_start_col_x-num": "0",
		"hedietLinkedDataV1_end_line_x-num": "12",
		"hedietLinkedDataV1_end_col_x-num": "0",
	});
	assert.equal(links.checkLink(legacy, "x\n".repeat(20)).status, "ok");
	assert.equal(links.checkLink(legacy, "x\n".repeat(5)).status, "out-of-range");
	assert.equal(links.checkLink(links.parseLink({ hedietLinkedDataV1_symbol: "Foo.bar" }), "").status, "unverified");
	assert.equal(links.parseLink({ label: "x" }), undefined);
	assert.equal(links.badgeKind("changed"), "warning");
	assert.equal(links.badgeKind("ok"), undefined);

	// Relative to the diagram file itself, so the first ".." only drops the file name.
	assert.equal(resolveLinkPath(Uri.file("/repo/docs/arch.drawio"), "../src/db.sql").path, "/repo/docs/src/db.sql");
	assert.equal(resolveLinkPath(Uri.file("/repo/arch.drawio"), "../schema.sql").path, "/repo/schema.sql");
	assert.equal(resolveLinkPath(Uri.file("/repo/docs/arch.drawio"), "../../src/a.ts").path, "/repo/src/a.ts");
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const http = require("http");
const { createMcpListener, handleMcpMessage } = require(src("mcp.ts"));

async function withMcpServer(fn) {
	const calls = [];
	const deps = {
		serverVersion: "9.9.9",
		tools: () => [
			{ name: "drawio_get_diagram", title: "Get", description: "read", inputSchema: { type: "object", properties: {} }, readOnly: true },
			{ name: "drawio_apply_operations", title: "Edit", description: "edit", inputSchema: { type: "object", properties: {} }, readOnly: false },
		],
		callTool: async (name, args) => {
			calls.push([name, args]);
			if (args.boom) throw new Error("kaboom");
			return name === "drawio_get_diagram" ? { text: '{"cells":[]}', image: { mimeType: "image/png", base64: "AAA=" } } : { text: "failed", isError: true };
		},
		instructions: async () => "Edit the open diagram.",
	};
	let port = 0;
	const server = http.createServer(createMcpListener({ token: () => "secret", port: () => port, deps }));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	port = server.address().port;
	const post = (body, headers = {}) =>
		fetch(`http://127.0.0.1:${port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer secret", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	try {
		await fn({ post, port, calls });
	} finally {
		server.close();
	}
}

test("MCP: initialize negotiates the version, lists tools with annotations and calls them", () =>
	withMcpServer(async ({ post, calls }) => {
		let r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("content-type"), "application/json");
		let body = await r.json();
		assert.equal(body.result.protocolVersion, "2025-06-18");
		assert.deepEqual(body.result.serverInfo, { name: "draw-ai", title: "Draw.AI", version: "9.9.9" });
		assert.equal(body.result.instructions, "Edit the open diagram.");
		assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });

		body = await (await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
		assert.equal(body.result.protocolVersion, "2025-11-25", "unknown versions get the latest supported one");

		r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		assert.equal(r.status, 202);
		assert.equal(await r.text(), "");

		body = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
		assert.deepEqual(body.result.tools.map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint]), [
			["drawio_get_diagram", true, false],
			["drawio_apply_operations", false, true],
		]);

		body = await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "drawio_get_diagram", arguments: { scope: "page" } } })).json();
		assert.deepEqual(body.result, { content: [{ type: "text", text: '{"cells":[]}' }, { type: "image", data: "AAA=", mimeType: "image/png" }], isError: false });
		assert.deepEqual(calls[0], ["drawio_get_diagram", { scope: "page" }]);

		body = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "drawio_apply_operations", arguments: { boom: true } } })).json();
		assert.equal(body.result.isError, true);
		assert.match(body.result.content[0].text, /kaboom/);

		body = await (await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rm_rf" } })).json();
		assert.equal(body.error.code, -32602);
		body = await (await post({ jsonrpc: "2.0", id: 7, method: "resources/list" })).json();
		assert.equal(body.error.code, -32601);
		body = await (await post({ jsonrpc: "2.0", id: "p", method: "ping" })).json();
		assert.deepEqual(body, { jsonrpc: "2.0", id: "p", result: {} });
		assert.equal((await post("{oops")).status, 400);
	}));

test("MCP: rejects missing tokens, foreign origins/hosts, GET and huge bodies", () =>
	withMcpServer(async ({ post, port, calls }) => {
		const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
		let r = await post(ping, { authorization: "Bearer wrong" });
		assert.equal(r.status, 401);
		assert.match(r.headers.get("www-authenticate"), /Bearer/);
		r = await post(ping, { authorization: "" });
		assert.equal(r.status, 401);

		r = await post(ping, { origin: "https://evil.example" });
		assert.equal(r.status, 403, "browsers on other sites cannot reach the server");
		r = await post(ping, { origin: `http://localhost:${port}` });
		assert.equal(r.status, 200);

		// DNS rebinding: a request whose Host is not loopback is rejected even with the right token.
		const status = await new Promise((resolve) => {
			const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "attacker.example", authorization: "Bearer secret", "content-type": "application/json" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.end(JSON.stringify(ping));
		});
		assert.equal(status, 403);

		r = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: "Bearer secret" } });
		assert.equal(r.status, 405);
		r = await fetch(`http://127.0.0.1:${port}/other`, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
		assert.equal(r.status, 404);

		r = await post('{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + "a".repeat(11 * 1024 * 1024) + '"}').catch(() => ({ status: 413 }));
		assert.equal(r.status, 413);
		assert.equal(calls.length, 0, "no tool ran for any rejected request");
	}));

test("MCP: notifications and client responses produce no reply", async () => {
	const deps = { serverVersion: "1", tools: () => [], callTool: async () => ({ text: "" }), instructions: async () => "" };
	assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, deps), undefined);
	assert.equal(await handleMcpMessage({ jsonrpc: "2.0", id: 9, result: {} }, deps), undefined);
	assert.equal((await handleMcpMessage({ id: 1, method: "ping" }, deps)).error.code, -32600);
});
