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
const { NATIVE_AGENT, nativeChatAvailable, openNativeChat, pruneAttachments, readAttachment, sendToNativeChat, splitDiagramRequest } = require(src("nativeChat.ts"));
const { diagramButtons, startButtons, followups } = require(src("copilotIntegration.ts"));
const { TOOL_SCHEMAS } = require(src("toolSchemas.ts"));
const { SYSTEM_PROMPT, NATIVE_AGENT_NOTES } = require(src("systemPrompt.ts"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const frontmatter = (text) => {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(m, "missing frontmatter");
	return m[1];
};

test("the Draw.AI agent: contributed, named Draw.AI, with every drawio tool by extension id", () => {
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

test("VS Code's chat is used when AI features are on and some extension provides a model", async () => {
	assert.equal(await nativeChatAvailable(), true);
	models = [];
	assert.equal(await nativeChatAvailable(), false, "no chat model");
	models = [{ id: "copilot" }];
	settings.disableAIFeatures = true;
	assert.equal(await nativeChatAvailable(), false, "AI features disabled");
	delete settings.disableAIFeatures;
	// Agent mode is not needed: @drawio works in Ask mode.
	settings["agent.enabled"] = false;
	assert.equal(await nativeChatAvailable(), true);
	delete settings["agent.enabled"];
});

test("Open Draw.AI in Chat opens VS Code's chat with the Draw.AI agent chosen, without sending", async () => {
	commands.length = 0;
	await openNativeChat();
	assert.deepEqual(commands, [["workbench.action.chat.open", { mode: "Draw.AI", query: "", isPartialQuery: true }]]);
	assert.equal(NATIVE_AGENT, "Draw.AI");
});

test("with drawio-ai.chat.target = participant, requests still go to @drawio (the Local chat runtime)", async () => {
	settings["chat.target"] = "participant";
	try {
		commands.length = 0;
		await openNativeChat();
		assert.deepEqual(commands, [["workbench.action.chat.open", { mode: "ask", query: "@drawio ", isPartialQuery: true }]]);
		commands.length = 0;
		const editor = { uri: new Uri("/ws/a.drawio"), drawioClient: { currentSelection: [] } };
		await sendToNativeChat(new Uri("/storage"), "tidy up", undefined, { editor });
		assert.equal(commands[0][1].mode, "ask");
		assert.match(commands[0][1].query, /^@drawio tidy up\n---\nOpen diagram: a\.drawio/);
	} finally {
		delete settings["chat.target"];
	}
	assert.equal(pkg.contributes.configuration.flatMap((c) => Object.entries(c.properties)).find(([k]) => k === "drawio-ai.chat.target")[1].default, "agent");
});

test("a lasso request is sent to the Draw.AI agent in VS Code's chat (no @drawio: the Copilot runtime has no participants); images and texts are named, not attached", async () => {
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
	assert.equal(args.mode, "Draw.AI");
	assert.equal(args.isPartialQuery, false);
	assert.doesNotMatch(args.query, /@drawio/);
	assert.match(args.query, /^make these blue\n---\nOpen diagram: arch\.drawio\nThe user circled \(lasso-selected\) 2 item\(s\) with ids: api, db\./);
	const ids = [...args.query.matchAll(/"(\d+-[a-z0-9]+\/\d+\.\w+)"/g)].map((m) => m[1]);
	assert.equal(ids.length, 2, "the non-image is dropped; the image and the text are named");
	assert.match(args.query, /drawio_get_attachment/);
	assert.match(args.query, /\(image 1\)/);
	assert.match(args.query, /\(code analysis of src \(3 files\)\)/);
	assert.equal(r.query, args.query);

	// The participant (when it is used) sees the same prompt and splits off the context.
	const sent = splitDiagramRequest(args.query);
	assert.equal(sent.text, "make these blue");
	assert.match(sent.context, /^Open diagram: arch\.drawio\nThe user circled/);
	assert.match(sent.context, /drawio_get_attachment/);

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

test("the toolbox reports each applied batch, so code links can follow what the native agent draws", async () => {
	const { DiagramToolbox } = require(src("DiagramToolbox.ts"));
	let rollBack = false;
	const editor = {
		drawioClient: {
			aiApplyOps: async (ops) => ({
				results: ops.map((o, index) => ({ index, op: o.op, ok: !rollBack, ids: ["x"], error: rollBack ? "nope" : undefined })),
				idMap: {},
				rolledBack: rollBack,
			}),
		},
	};
	const toolbox = new DiagramToolbox(() => editor);
	const seen = [];
	const sub = toolbox.onDidApplyOperations((e) => seen.push(e));
	await toolbox.invoke("drawio_apply_operations", { ops: [{ op: "addShape", label: "A" }] });
	assert.deepEqual(seen, [editor]);
	rollBack = true;
	await toolbox.invoke("drawio_apply_operations", { ops: [{ op: "addShape", label: "B" }] });
	assert.equal(seen.length, 1, "a rolled-back batch changed nothing");
	rollBack = false;
	sub.dispose();
	await toolbox.invoke("drawio_apply_operations", { ops: [{ op: "addShape", label: "C" }] });
	assert.equal(seen.length, 1);
});

test("a prompt typed in the chat has no diagram context, even with a --- line", () => {
	assert.deepEqual(splitDiagramRequest("add a cache"), { text: "add a cache" });
	assert.deepEqual(splitDiagramRequest("first\n---\nsecond"), { text: "first\n---\nsecond" });
});

test("@drawio answers end with buttons; keep/revert only while changes are pending", () => {
	const buttons = (pending) => {
		const out = [];
		diagramButtons({ button: (b) => out.push(b) }, pending);
		return out;
	};
	const commandsOf = (list) => list.map((b) => b.command);
	const declared = new Set(pkg.contributes.commands.map((c) => c.command));

	const idle = buttons(false);
	assert.deepEqual(commandsOf(idle), ["drawio-ai.lassoSelect", "drawio-ai.markup", "drawio-ai.reviewDiagram", "drawio-ai.exportPdf", "drawio-ai.export"]);
	const pending = buttons(true);
	assert.deepEqual(commandsOf(pending).slice(0, 2), ["drawio-ai.acceptChanges", "drawio-ai.rejectChanges"]);
	assert.equal(pending.length, idle.length + 2);

	const start = [];
	startButtons({ button: (b) => start.push(b) });
	for (const b of [...pending, ...start]) {
		assert.ok(declared.has(b.command), `${b.command} is not a declared command`);
		assert.ok(b.title && !b.title.includes("$("), `plain title for ${b.command}`);
	}
});

test("follow-ups use @drawio's slash commands and skip the one just used", () => {
	const declared = new Set(pkg.contributes.chatParticipants[0].commands.map((c) => c.name));
	const all = followups({ metadata: { diagram: true } });
	assert.ok(all.length >= 3);
	for (const f of all) assert.ok(declared.has(f.command), `unknown command /${f.command}`);
	assert.ok(!followups({ metadata: { diagram: true, command: "layout" } }).some((f) => f.command === "layout"));
	assert.deepEqual(followups({ metadata: { diagram: false } }), []);
	assert.deepEqual(followups({}), []);
});
