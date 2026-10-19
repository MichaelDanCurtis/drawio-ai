// Unit tests for VS Code chat integration: the generated Draw.AI agent, the scoped
// instructions, and how requests from the diagram reach VS Code's chat.
// Run: node --test test/ai/chat.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const root = path.resolve(__dirname, "../..");

class Uri {
	constructor(p) {
		this.path = p;
		this.scheme = "file";
	}
	static joinPath(u, ...segs) {
		return new Uri(path.posix.normalize([u.path, ...segs].join("/")));
	}
	toString() {
		return `file://${this.path}`;
	}
}
const settings = {};
const files = new Map();
const commands = [];
let models = [{ id: "copilot" }];
const vscodeStub = {
	Uri,
	version: "1.150.0",
	FileType: { File: 1, Directory: 2 },
	lm: { selectChatModels: async () => models },
	commands: { executeCommand: async (...args) => void commands.push(args) },
	workspace: {
		getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
		fs: {
			createDirectory: async () => {},
			writeFile: async (u, data) => void files.set(u.path, Buffer.from(data)),
			readFile: async (u) => {
				if (!files.has(u.path)) throw new Error("not found");
				return files.get(u.path);
			},
			readDirectory: async (u) => [
				...new Set([...files.keys()].filter((f) => f.startsWith(u.path + "/")).map((f) => f.slice(u.path.length + 1).split("/")[0])),
			].map((n) => [n, 2]),
			delete: async (u) => {
				for (const f of [...files.keys()]) if (f === u.path || f.startsWith(u.path + "/")) files.delete(f);
			},
		},
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const src = (p) => path.resolve(root, "src/features/ai", p);
const { NATIVE_AGENT, configuredSurface, nativeChatAvailable, pruneAttachments, readAttachment, sendToNativeChat } = require(src("nativeChat.ts"));
const { TOOL_SCHEMAS } = require(src("toolSchemas.ts"));
const { SYSTEM_PROMPT, NATIVE_AGENT_NOTES } = require(src("systemPrompt.ts"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const frontmatter = (text) => {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(m, "missing frontmatter");
	return m[1];
};

test("the Draw.AI agent: contributed, named like the chat mode we open, with every drawio tool by extension id", () => {
	assert.deepEqual(pkg.contributes.chatAgents, [{ path: "./media/chat/draw-ai.agent.md" }]);
	const text = fs.readFileSync(path.join(root, "media/chat/draw-ai.agent.md"), "utf8");
	const head = frontmatter(text);
	assert.match(head, new RegExp(`^name: ${NATIVE_AGENT.replace(".", "\\.")}$`, "m"));
	const tools = [...head.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]);
	const id = `${pkg.publisher}.${pkg.name}`;
	for (const schema of TOOL_SCHEMAS) {
		const ref = pkg.contributes.languageModelTools.find((t) => t.name === schema.name).toolReferenceName;
		assert.ok(tools.includes(`${id}/${ref}`), `agent is missing ${schema.name}`);
	}
	assert.ok(!tools.some((t) => /^(edit|execute|vscode)\b/.test(t)), "the agent must not get file-editing tools");
	assert.ok(text.includes(SYSTEM_PROMPT) && text.includes(NATIVE_AGENT_NOTES));
});

test("the scoped instructions apply to every draw.io file type", () => {
	assert.deepEqual(pkg.contributes.chatInstructions, [{ path: "./media/chat/drawio.instructions.md" }]);
	const head = frontmatter(fs.readFileSync(path.join(root, "media/chat/drawio.instructions.md"), "utf8"));
	const applyTo = /^applyTo: "(.+)"$/m.exec(head)[1].split(",");
	for (const ext of [".drawio", ".dio", ".drawio.svg", ".drawio.png"]) {
		assert.ok(applyTo.includes(`**/*${ext}`), `applyTo misses ${ext}`);
	}
});

test("chat surface: auto by default; VS Code's chat only with agent mode, AI features, a recent VS Code and a model", async () => {
	delete settings.chatSurface;
	assert.equal(configuredSurface(), "auto");
	settings.chatSurface = "panel";
	assert.equal(configuredSurface(), "panel");
	settings.chatSurface = "bogus";
	assert.equal(configuredSurface(), "auto");
	delete settings.chatSurface;

	assert.equal(await nativeChatAvailable(), true);
	models = [];
	assert.equal(await nativeChatAvailable(), false, "no chat model");
	models = [{ id: "copilot" }];
	settings["agent.enabled"] = false;
	assert.equal(await nativeChatAvailable(), false, "agent mode disabled (e.g. by policy)");
	delete settings["agent.enabled"];
	settings.disableAIFeatures = true;
	assert.equal(await nativeChatAvailable(), false, "AI features disabled");
	delete settings.disableAIFeatures;
	vscodeStub.version = "1.141.9";
	assert.equal(await nativeChatAvailable(), false, "VS Code too old to open the chat on an agent by name");
	vscodeStub.version = "1.142.0-insider";
	assert.equal(await nativeChatAvailable(), true);
	vscodeStub.version = "1.150.0";
});

test("a lasso request opens VS Code's chat on the Draw.AI agent; images and texts are named, not attached", async () => {
	commands.length = 0;
	files.clear();
	const editor = { uri: new Uri("/ws/docs/arch.drawio"), drawioClient: { currentSelection: ["x"] } };
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
	const r = await sendToNativeChat(
		new Uri("/storage"),
		"  make these blue  ",
		{ cellIds: ["api", "db"], viaLasso: true },
		{
			editor,
			images: [{ mimeType: "image/png", base64: png }, { mimeType: "text/html", base64: "PHA+" }],
			attachments: [{ name: "code analysis of src (3 files)", text: "class A" }],
		}
	);
	assert.equal(commands.length, 1);
	const [id, args] = commands[0];
	assert.equal(id, "workbench.action.chat.open");
	assert.deepEqual(Object.keys(args).sort(), ["isPartialQuery", "mode", "query"]);
	assert.equal(args.mode, NATIVE_AGENT);
	assert.equal(args.isPartialQuery, false);
	assert.match(args.query, /^make these blue\n---\nOpen diagram: arch\.drawio\nThe user circled \(lasso-selected\) 2 item\(s\) with ids: api, db\./);
	const ids = [...args.query.matchAll(/"(\d+-[a-z0-9]+\/\d+\.\w+)"/g)].map((m) => m[1]);
	assert.equal(ids.length, 2, "the non-image is dropped; the image and the text are named");
	assert.match(args.query, /drawio_get_attachment/);
	assert.match(args.query, /\(image 1\)/);
	assert.match(args.query, /\(code analysis of src \(3 files\)\)/);
	assert.equal(r.query, args.query);

	const image = await readAttachment(new Uri("/storage"), ids[0]);
	assert.deepEqual(image.image, { mimeType: "image/png", base64: png });
	const text = await readAttachment(new Uri("/storage"), ids[1]);
	assert.equal(text.text, "class A");
	assert.equal((await readAttachment(new Uri("/storage"), "../../etc/passwd")).isError, true);
	assert.equal((await readAttachment(new Uri("/storage"), ids[0].replace(/^\d+/, "1"))).isError, true);

	// Two requests in the same millisecond still get separate folders.
	const again = await sendToNativeChat(new Uri("/storage"), "again", undefined, { editor, attachments: [{ name: "x", text: "y" }] });
	assert.notEqual(again.query.match(/"(\d+-[a-z0-9]+)\//)[1], ids[1].split("/")[0]);

	// Without an explicit selection, the editor's current selection is described.
	commands.length = 0;
	await sendToNativeChat(new Uri("/storage"), "explain", undefined, { editor });
	assert.match(commands[0][1].query, /selected 1 item\(s\) with ids: x/);
	assert.doesNotMatch(commands[0][1].query, /Attached/);
});

test("attachments are kept for a week", async () => {
	files.clear();
	const now = Date.now();
	files.set(`/storage/chat-attachments/${now - 8 * 86400000}-old/1.png`, Buffer.from("old"));
	files.set(`/storage/chat-attachments/${now - 6 * 86400000}-new/1.md`, Buffer.from("new"));
	await pruneAttachments(new Uri("/storage"), now);
	assert.deepEqual([...files.keys()], [`/storage/chat-attachments/${now - 6 * 86400000}-new/1.md`]);
});
