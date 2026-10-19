// Unit tests for the extension-side agent loop and provider stream parsing.
// Run: node --test test/ai/agent.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const settings = {};
const vscodeStub = {
	workspace: {
		getConfiguration: () => ({ get: (key, def) => (key in settings ? settings[key] : def) }),
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const src = (p) => path.resolve(__dirname, "../../src/features/ai", p);
const { DiagramAgent } = require(src("DiagramAgent.ts"));
const { OpenAiProvider } = require(src("providers/OpenAiProvider.ts"));
const { AnthropicProvider } = require(src("providers/AnthropicProvider.ts"));

function token(cancelled = false) {
	const listeners = [];
	return {
		get isCancellationRequested() { return cancelled; },
		cancel() { cancelled = true; listeners.forEach((l) => l()); },
		onCancellationRequested: (l) => { listeners.push(l); return { dispose() {} }; },
	};
}

function scriptedClient(rounds) {
	const requests = [];
	return {
		requests,
		providerId: "openai",
		model: { id: "m", name: "m", vision: false },
		async *stream(req) {
			requests.push(JSON.parse(JSON.stringify(req.messages)));
			for (const evt of rounds.shift() ?? []) yield evt;
		},
	};
}

const fakeToolbox = (impl) => ({
	specs: () => [{ name: "drawio_get_diagram", description: "", inputSchema: {} }],
	invoke: impl,
});

const sink = () => {
	const out = { text: "", tools: [] };
	out.sink = { text: (t) => (out.text += t), toolStart: (c) => out.tools.push(c.name), toolEnd: () => {} };
	return out;
};

test("agent runs tools, feeds results back and stops on a text-only reply", async () => {
	const client = scriptedClient([
		[{ type: "text", text: "Looking. " }, { type: "toolCall", id: "c1", name: "drawio_get_diagram", input: {} }],
		[{ type: "text", text: "Done." }],
	]);
	const s = sink();
	const agent = new DiagramAgent(fakeToolbox(async () => ({ text: '{"cells":[]}', summary: "ok" })));
	const { messages, error } = await agent.run({
		client, history: [], userText: "hi", context: "ctx", sink: s.sink, token: token(), maxRounds: 5,
	});
	assert.equal(error, undefined);
	assert.equal(s.text, "Looking. Done.");
	assert.deepEqual(s.tools, ["drawio_get_diagram"]);
	assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
	const second = client.requests[1];
	const result = second[second.length - 1].parts[0];
	assert.equal(result.type, "toolResult");
	assert.equal(result.callId, "c1");
});

test("every tool call gets a result even when cancelled mid-round", async () => {
	const t = token();
	const client = scriptedClient([
		[
			{ type: "toolCall", id: "a", name: "drawio_get_diagram", input: {} },
			{ type: "toolCall", id: "b", name: "drawio_get_diagram", input: {} },
		],
	]);
	const agent = new DiagramAgent(fakeToolbox(async () => { t.cancel(); return { text: "x", summary: "x" }; }));
	const { messages } = await agent.run({
		client, history: [], userText: "go", context: "", sink: sink().sink, token: t, maxRounds: 5,
	});
	const calls = messages.flatMap((m) => m.parts.filter((p) => p.type === "toolCall").map((p) => p.id));
	const results = messages.flatMap((m) => m.parts.filter((p) => p.type === "toolResult").map((p) => p.callId));
	assert.deepEqual(results, calls);
});

test("provider errors are returned with the partial turn, not thrown", async () => {
	const client = {
		providerId: "openai",
		model: { id: "m", name: "m", vision: false },
		async *stream() { yield { type: "text", text: "partial" }; throw new Error("boom"); },
	};
	const agent = new DiagramAgent(fakeToolbox(async () => ({ text: "", summary: "" })));
	const { messages, error } = await agent.run({
		client, history: [], userText: "x", context: "", sink: sink().sink, token: token(), maxRounds: 3,
	});
	assert.equal(error.message, "boom");
	assert.equal(messages[messages.length - 1].parts[0].text, "partial");
});

test("round limit appends a note and keeps history well-formed", async () => {
	const loop = () => [{ type: "toolCall", id: String(Math.random()), name: "drawio_get_diagram", input: {} }];
	const client = scriptedClient([loop(), loop(), loop()]);
	const agent = new DiagramAgent(fakeToolbox(async () => ({ text: "{}", summary: "" })));
	const { messages } = await agent.run({
		client, history: [], userText: "x", context: "", sink: sink().sink, token: token(), maxRounds: 2,
	});
	assert.equal(messages[messages.length - 1].role, "assistant");
	assert.match(messages[messages.length - 1].parts[0].text, /Stopped after 2/);
});

function sseResponse(chunks) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(typeof c === "string" ? encoder.encode(c) : c);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } }
	);
}

const secrets = (values) => ({ get: async (k) => values[k] });

test("OpenAI-compatible stream: text, chunked tool-call args, split UTF-8, request shape", async () => {
	settings["openai.baseUrl"] = "https://example.test/v1";
	let sent;
	const euro = new TextEncoder().encode("€");
	global.fetch = async (url, init) => {
		sent = { url, headers: init.headers, body: JSON.parse(init.body) };
		return sseResponse([
			'data: {"choices":[{"delta":{"content":"Price: "}}]}\n\n',
			new Uint8Array([...new TextEncoder().encode('data: {"choices":[{"delta":{"content":"'), euro[0]]),
			new Uint8Array([euro[1], euro[2], ...new TextEncoder().encode('"}}]}\n\n')]),
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"drawio_apply_operations","arguments":"{\\"ops\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[]}"}}]}}]}\n\n',
			"data: [DONE]\n\n",
		]);
	};
	const provider = new OpenAiProvider(secrets({ "drawio-ai.openai.apiKey": "sk-test" }));
	const client = await provider.getClient("gpt-x");
	const events = [];
	for await (const e of client.stream(
		{
			system: "SYS",
			tools: [{ name: "drawio_apply_operations", description: "d", inputSchema: { type: "object" } }],
			messages: [
				{ role: "user", parts: [{ type: "text", text: "hello" }] },
				{ role: "assistant", parts: [{ type: "toolCall", id: "p", name: "drawio_get_diagram", input: {} }] },
				{ role: "user", parts: [{ type: "toolResult", callId: "p", name: "drawio_get_diagram", text: "{}" }] },
			],
		},
		token()
	)) events.push(e);

	assert.equal(sent.url, "https://example.test/v1/chat/completions");
	assert.equal(sent.headers.authorization, "Bearer sk-test");
	assert.equal(sent.body.tools[0].type, "function");
	assert.equal(sent.body.messages[0].role, "system");
	assert.equal(sent.body.messages[2].tool_calls[0].id, "p");
	assert.equal(sent.body.messages[3].role, "tool");
	assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Price: €");
	assert.deepEqual(events.find((e) => e.type === "toolCall"), {
		type: "toolCall", id: "t1", name: "drawio_apply_operations", input: { ops: [] },
	});
});

test("Anthropic stream: tool_use blocks assembled from input_json_delta", async () => {
	let sent;
	global.fetch = async (url, init) => {
		sent = { url, headers: init.headers, body: JSON.parse(init.body) };
		return sseResponse([
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ok"}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"drawio_get_diagram","input":{}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"scope\\":"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"selection\\"}"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		]);
	};
	const provider = new AnthropicProvider(secrets({ "drawio-ai.anthropic.apiKey": "ak" }));
	const client = await provider.getClient("claude-x");
	const events = [];
	for await (const e of client.stream(
		{ system: "SYS", tools: [], messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] },
		token()
	)) events.push(e);
	assert.equal(sent.headers["x-api-key"], "ak");
	assert.equal(sent.body.system, "SYS");
	assert.deepEqual(events, [
		{ type: "text", text: "Ok" },
		{ type: "toolCall", id: "tu1", name: "drawio_get_diagram", input: { scope: "selection" } },
	]);
});

test("HTTP errors become actionable messages without echoing whole bodies", async () => {
	global.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
	const provider = new AnthropicProvider(secrets({ "drawio-ai.anthropic.apiKey": "bad" }));
	const client = await provider.getClient("claude-x");
	await assert.rejects(async () => {
		for await (const _ of client.stream({ system: "", tools: [], messages: [] }, token()));
	}, /Anthropic request failed \(401\): invalid x-api-key\. Check the API key/);
});

test("chat panel tools stay on the focused diagram; agents can name another one", async () => {
	const { DiagramToolbox } = require(src("DiagramToolbox.ts"));
	const workspace = {
		open: async (file) => {
			throw new Error(`would open ${file}`);
		},
		list: async () => ({ text: "listed", summary: "" }),
		search: async () => ({ text: "searched", summary: "" }),
		create: async () => ({ text: "created", summary: "" }),
	};
	const toolbox = new DiagramToolbox(() => undefined, undefined, undefined, undefined, undefined, undefined, workspace);
	assert.ok(toolbox.specs({ vision: true }).some((t) => t.name === "drawio_import"), "the panel can still import files");
	const specs = toolbox.specs({ vision: true });
	assert.ok(specs.some((t) => t.name === "drawio_style_reference"));
	assert.ok(!specs.some((t) => ["drawio_create", "drawio_list_diagrams", "drawio_search_diagrams"].includes(t.name)));
	assert.ok(specs.every((t) => !("file" in (t.inputSchema.properties ?? {}))), "no `file` for the panel");

	const scoped = await toolbox.invoke("drawio_get_diagram", { file: "docs/a.drawio" }, { scoped: true });
	assert.match(scoped.text, /No draw.io diagram is open/, "`file` is ignored for the panel");
	assert.match((await toolbox.invoke("drawio_create", { path: "a.drawio" }, { scoped: true })).text, /not available here/);

	assert.match((await toolbox.invoke("drawio_get_diagram", { file: "docs/a.drawio" })).text, /would open docs\/a\.drawio/);
	assert.equal((await toolbox.invoke("drawio_list_diagrams", {})).text, "listed");
});
