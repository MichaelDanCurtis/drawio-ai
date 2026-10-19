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
