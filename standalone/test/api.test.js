// API access: models reached through a provider's API (Anthropic, OpenAI, Kimi) with the
// user's own key, as an alternative to an agent program. Where a key is kept, what is sent to
// a provider and what is made of its answers, and the Shape Creator drawing this way.
// The providers here are local stand-ins (test/helpers/fake-providers.js): no network, no real
// key, no tokens spent.
// Run from standalone/: node --test test/api.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");
const fake = require("./helpers/fake-providers");

const { KeyStore, cleanKey } = require("../src/main/api/keyStore");
const { ApiAccess, apiAgentId } = require("../src/main/api/access");
const { ApiError, MAX_TOOL_ROUNDS } = require("../src/main/api/chat");
const { anthropicProvider, anthropicClient, ANTHROPIC_BASE } = require("../src/main/api/anthropic");
const { openAiProvider, openAiClient, OPENAI_BASE } = require("../src/main/api/openai");
const { kimiProvider, kimiAnswerRoom, KIMI_BASE } = require("../src/main/api/kimi");
const { ApiKeysPanel } = require("../src/main/api/keysPanel");
const { API_PROVIDERS } = require("../src/main/api/providers");
const { withoutProviderEnv } = require("../src/main/api/env");
const { apiCreatorAgents, openApiCreator } = require("../src/main/api/creator");
const { WorkshopCore } = require("../src/main/workshop/core");
const { GalleryService } = require("../src/main/workshop/galleries");
const { CREATOR_TOOLS } = require("../src/main/workshop/creator");

// (made up: nothing a provider issued)
const KEY = "test-key-for-the-stand-in-1";
const OTHER_KEY = "test-key-for-the-stand-in-2";
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="var(--fill, #141414)" d="M6 6h36v36H6z"/></svg>';
const PNG = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, ms = 5000) => {
	for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (what()) return;
	assert.fail("waited too long");
};

const servers = [];
after(async () => {
	for (const s of servers) await s.close();
});
async function api(answer) {
	const s = await fake.fakeApi(answer);
	servers.push(s);
	return s;
}

/**
 * A cipher for tests: it gives back what it hid, and what it writes looks nothing like the key.
 * `state.asked` counts how often it was asked anything (the app's one asks the keychain).
 */
const flip = (bytes, by = 0x5a) => Buffer.from([...bytes].map((b) => b ^ by));
const cipher = (state = { available: true }) => ({
	available: async () => {
		state.asked = (state.asked ?? 0) + 1;
		return state.available;
	},
	encrypt: async (text) => {
		state.asked = (state.asked ?? 0) + 1;
		if (state.cannotEncrypt) throw new Error("the keychain is locked");
		return flip(Buffer.from(text, "utf8"), state.secret ?? 0x5a);
	},
	decrypt: async (bytes) => {
		state.asked = (state.asked ?? 0) + 1;
		// (`gate`: the keychain is waiting for the user, a prompt for one)
		if (state.gate) await state.gate;
		if (state.broken) throw new Error("the keychain item is gone");
		// (`rotated`: the system has a new secret; what was encrypted with the old one still opens, and says so)
		return state.rotated ? { text: flip(bytes, state.rotated).toString("utf8"), stale: true } : { text: flip(bytes, state.secret ?? 0x5a).toString("utf8") };
	},
});
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-api-test-")), "sub", "api-keys.json");

/** The two tools a chat is given here, and what calling them answers. */
const TOOLS = CREATOR_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
function toolbox(answers = {}) {
	const calls = [];
	return {
		calls,
		callTool: async (name, args) => {
			calls.push([name, args]);
			const a = answers[name];
			return typeof a === "function" ? a(args) : a ?? { text: "ok" };
		},
	};
}

test("a key: what counts as one", () => {
	assert.equal(cleanKey(`  ${KEY}\n`), KEY);
	for (const not of ["short", "a".repeat(513), "two words in the key here", "line\nbreak-in-the-middle-of-it", "ключ-не-из-ascii-символов", "", undefined, null, 12345678901234567890, { key: KEY }]) assert.equal(cleanKey(not), undefined, String(not));
});

test("the key store: a key is kept encrypted in a file of the user's own, and never as it is", async () => {
	const file = tmpFile();
	const state = { available: true };
	const keys = new KeyStore(file, cipher(state));
	const changes = [];
	const off = keys.onChange((id) => changes.push(id));
	assert.equal(keys.has("anthropic"), false);
	assert.equal(await keys.get("anthropic"), undefined);
	assert.equal(fs.existsSync(file), false, "nothing is written until a key is kept");

	await keys.set("anthropic", ` ${KEY} `);
	assert.equal(keys.has("anthropic"), true);
	assert.equal(await keys.get("anthropic"), KEY);
	assert.deepEqual(changes, ["anthropic"]);
	const written = fs.readFileSync(file, "utf8");
	assert.doesNotMatch(written, new RegExp(KEY));
	assert.doesNotMatch(Buffer.from(JSON.parse(written).keys.anthropic, "base64").toString("latin1"), new RegExp(KEY));
	assert.deepEqual(Object.keys(JSON.parse(written)), ["version", "keys"]);
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600, "readable by this user only");
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ["api-keys.json"], "no temporary file is left");

	// whether a key is kept is known without asking the keychain
	state.asked = 0;
	assert.deepEqual([keys.has("anthropic"), keys.has("openai"), state.asked], [true, false, 0]);

	// a second key beside it, also when both are saved at the same moment; another store on the same file sees them
	await Promise.all([keys.set("openai", OTHER_KEY), keys.set("kimi", KEY)]);
	const again = new KeyStore(file, cipher());
	assert.deepEqual([await again.get("anthropic"), await again.get("openai"), await again.get("kimi")], [KEY, OTHER_KEY, KEY]);
	keys.remove("kimi");

	// what is not a key is not kept, and says so
	await assert.rejects(keys.set("kimi", "nope"), /does not look like an API key/);
	assert.equal(keys.has("kimi"), false);

	// without the system's encryption nothing is written, and nothing can be read back
	state.available = false;
	assert.equal(await keys.available(), false);
	await assert.rejects(keys.set("kimi", KEY), /cannot keep the key safely/);
	assert.equal(keys.has("kimi"), false);
	assert.equal(keys.has("anthropic"), true);
	assert.equal(await keys.get("anthropic"), undefined);
	state.available = true;
	// a key the keychain no longer gives back (the app's secret is gone) is no key
	state.broken = true;
	assert.equal(await keys.get("anthropic"), undefined);
	state.broken = false;

	// the system's secret has changed: the key still opens, and is encrypted again with the new one, in place
	const old = JSON.parse(fs.readFileSync(file, "utf8")).keys.anthropic;
	Object.assign(state, { rotated: 0x5a, secret: 0x33 });
	changes.length = 0;
	assert.equal(await keys.get("anthropic"), KEY);
	const renewed = JSON.parse(fs.readFileSync(file, "utf8")).keys;
	assert.notEqual(renewed.anthropic, old);
	assert.equal(flip(Buffer.from(renewed.anthropic, "base64"), 0x33).toString("utf8"), KEY);
	assert.deepEqual(changes, [], "nothing changed for anyone");
	// (the other key was not asked for, and is as it was)
	delete state.rotated;
	delete state.secret;
	assert.equal(await keys.get("openai"), OTHER_KEY);
	await keys.set("anthropic", KEY);
	// ... and when it cannot be encrypted again just now, the key is still the key
	Object.assign(state, { rotated: 0x5a, secret: 0x33, cannotEncrypt: true });
	assert.equal(await keys.get("anthropic"), KEY);
	delete state.rotated;
	delete state.secret;
	delete state.cannotEncrypt;

	// the keychain takes its time (it asks the user): the key that counts is the one kept when it has answered
	let open;
	state.gate = new Promise((r) => (open = r));
	const removedMeanwhile = keys.get("anthropic");
	const replacedMeanwhile = keys.get("openai");
	await wait(10);
	keys.remove("anthropic");
	delete state.gate;
	await keys.set("openai", KEY);
	open();
	assert.deepEqual([await removedMeanwhile, await replacedMeanwhile], [undefined, KEY]);
	await keys.set("anthropic", KEY);
	await keys.set("openai", OTHER_KEY);

	// a listener that fails does not make a kept key look unkept
	const failing = keys.onChange(() => assert.fail("a listener of the store's"));
	await keys.set("kimi", KEY);
	assert.equal(await keys.get("kimi"), KEY);
	failing();
	keys.remove("kimi");

	changes.length = 0;
	keys.remove("openai");
	keys.remove("openai");
	keys.remove("never-there");
	assert.deepEqual(changes, ["openai"], "removing what is not there changes nothing");
	assert.deepEqual([keys.has("openai"), await keys.get("anthropic")], [false, KEY]);
	off();
	keys.remove("anthropic");
	assert.deepEqual(changes, ["openai"]);

	// a file that is not what the store wrote counts as holding nothing ...
	for (const junk of ["not json", "[]", '{"keys":"x"}', '{"keys":{"anthropic":7}}']) {
		fs.writeFileSync(file, junk);
		assert.equal(keys.has("anthropic"), false, junk);
		assert.equal(await keys.get("anthropic"), undefined, junk);
	}
	// ... but is set aside, not written over, when a key is kept next: it may hold keys
	fs.writeFileSync(file, "not json");
	await keys.set("anthropic", KEY);
	assert.equal(fs.readFileSync(`${file}.unreadable`, "utf8"), "not json");
	assert.equal(await keys.get("anthropic"), KEY);
	if (process.platform !== "win32") assert.equal(fs.statSync(`${file}.unreadable`).mode & 0o777, 0o600);
	// what decrypts to something that is no key is not handed out
	fs.writeFileSync(file, JSON.stringify({ version: 1, keys: { anthropic: (await cipher().encrypt("two words")).toString("base64") } }));
	assert.equal(await keys.get("anthropic"), undefined);

	// a file that cannot be read may hold keys: nothing is written over it, and that is said
	if (process.platform !== "win32" && process.getuid() !== 0) {
		await keys.set("anthropic", KEY);
		const held = fs.readFileSync(file, "utf8");
		fs.chmodSync(file, 0o000);
		try {
			assert.equal(keys.has("anthropic"), false);
			await assert.rejects(keys.set("openai", OTHER_KEY), /^Error: The file the keys are kept in cannot be read, so nothing was changed\./);
			assert.doesNotThrow(() => keys.remove("openai"));
		} finally {
			fs.chmodSync(file, 0o600);
		}
		assert.equal(fs.readFileSync(file, "utf8"), held);
		assert.equal(await keys.get("anthropic"), KEY);
	}
});

test("nothing comes from the environment: the key and the address are the ones given", async () => {
	const names = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_LOG", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_CUSTOM_HEADERS", "OPENAI_LOG"];
	const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
	const s = await api((r) => (r.path.startsWith("/v1/models?") ? fake.anthropicModels([]) : r.path === "/v1/models" ? fake.openAiModels([]) : undefined));
	try {
		Object.assign(process.env, {
			ANTHROPIC_BASE_URL: "http://127.0.0.1:9/elsewhere",
			ANTHROPIC_API_KEY: "key-from-the-environment",
			ANTHROPIC_AUTH_TOKEN: "token-from-the-environment",
			ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer key-from-the-environment\nx-api-key: key-from-the-environment\nx-extra: 1",
			ANTHROPIC_LOG: "debug",
			OPENAI_BASE_URL: "http://127.0.0.1:9/elsewhere",
			OPENAI_API_KEY: "key-from-the-environment",
			OPENAI_ORG_ID: "org-from-the-environment",
			OPENAI_PROJECT_ID: "project-from-the-environment",
			OPENAI_CUSTOM_HEADERS: "Authorization: Bearer key-from-the-environment\nx-extra: 1",
			OPENAI_LOG: "debug",
		});
		// the provider's own address, not the environment's
		assert.equal(anthropicClient(KEY).baseURL, ANTHROPIC_BASE);
		assert.equal(ANTHROPIC_BASE, "https://api.anthropic.com");
		assert.equal(openAiClient(KEY, OPENAI_BASE).baseURL, "https://api.openai.com/v1");
		assert.equal(KIMI_BASE, "https://api.moonshot.ai/v1");
		assert.equal(anthropicClient(KEY).logLevel, "warn");
		assert.equal(openAiClient(KEY, OPENAI_BASE).logLevel, "warn");
		// the variables are only out of sight while a client is made
		assert.equal(withoutProviderEnv(() => process.env.ANTHROPIC_BASE_URL ?? process.env.OPENAI_API_KEY ?? "hidden"), "hidden");
		assert.equal(process.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9/elsewhere");
		assert.throws(() => withoutProviderEnv(() => assert.fail("a client that cannot be made")));
		assert.equal(process.env.OPENAI_ORG_ID, "org-from-the-environment", "they are back after a failure too");

		// what is sent: the key that was given, and nothing of the environment's
		await anthropicProvider.models(KEY, { baseURL: s.url });
		const a = s.requests.pop().headers;
		assert.deepEqual([a.authorization, a["x-api-key"], a["x-extra"]], [`Bearer ${KEY}`, undefined, undefined]);
		assert.ok(a["anthropic-version"]);
		await openAiProvider.models(KEY, { baseURL: `${s.url}/v1` });
		const o = s.requests.pop().headers;
		assert.deepEqual([o.authorization, o["openai-organization"], o["openai-project"], o["x-extra"]], [`Bearer ${KEY}`, undefined, undefined, undefined]);
		await kimiProvider.models(KEY, { baseURL: `${s.url}/v1` });
		const k = s.requests.pop().headers;
		assert.deepEqual([k.authorization, k["openai-organization"], k["x-extra"]], [`Bearer ${KEY}`, undefined, undefined]);
	} finally {
		for (const n of names) {
			if (before[n] === undefined) delete process.env[n];
			else process.env[n] = before[n];
		}
	}
});

// ----- Anthropic -----

test("Anthropic: its models, newest first, without the retired ones", async () => {
	const s = await api((r) =>
		r.method === "GET" && r.path.startsWith("/v1/models?")
			? fake.anthropicModels([
					{ id: "claude-old", display_name: "Claude Old", created_at: "2024-02-01T00:00:00Z" },
					{ id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" },
					{ id: "claude-gone", display_name: "Claude Gone", created_at: "2023-01-01T00:00:00Z", lifecycle: "retired" },
					{ id: "claude-unnamed", display_name: "", created_at: "2025-01-01T00:00:00Z" },
			  ])
			: undefined
	);
	assert.deepEqual(await anthropicProvider.models(KEY, { baseURL: s.url }), [{ value: "claude-new", name: "Claude New" }, { value: "claude-unnamed", name: "claude-unnamed" }, { value: "claude-old", name: "Claude Old" }]);
	assert.deepEqual([anthropicProvider.id, anthropicProvider.label, anthropicProvider.company], ["anthropic", "Anthropic API", "Anthropic"]);
});

/** An Anthropic stand-in whose answers to requests are taken from `script` in order. */
async function anthropicApi(script, model = { max_tokens: 128000 }) {
	return api((r) => {
		if (r.method === "GET" && r.path === "/v1/models/claude-new") return model ? { json: { type: "model", id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z", ...model } } : { status: 404, json: { type: "error", error: { type: "not_found_error", message: "no such model" } } };
		if (r.method === "POST" && r.path === "/v1/messages") return script.shift();
		return undefined;
	});
}

test("Anthropic: a request, the model's tool calls and their answers, and the conversation that is kept", async () => {
	const script = [
		fake.anthropicAnswer([{ text: "Looking. " }, { tool: "workshop_render_preview", id: "toolu_1", input: { svg: ICON } }]),
		fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_2", input: { svg: ICON, name: "Key", tags: ["key"] } }, { tool: "workshop_submit_svg", id: "toolu_3", input: { svg: "<p/>" } }]),
		fake.anthropicAnswer([{ text: "Done." }]),
		fake.anthropicAnswer([{ text: "Thicker now." }]),
	];
	const s = await anthropicApi(script);
	const said = [];
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG }, workshop_submit_svg: (a) => (a.name ? { text: "Taken." } : { text: "That is not an SVG.", isError: true }) });
	const chat = anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "You draw icons.", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: s.url });
	assert.equal(await chat.send("Draw a key.", [{ mimeType: "image/jpeg", base64: "AAAA" }], new AbortController().signal), "end_turn");
	assert.equal(said.join(""), "Looking. Done.");
	assert.deepEqual(box.calls, [["workshop_render_preview", { svg: ICON }], ["workshop_submit_svg", { svg: ICON, name: "Key", tags: ["key"] }], ["workshop_submit_svg", { svg: "<p/>" }]]);

	const sent = s.posts("/v1/messages").map((r) => r.body);
	assert.equal(sent.length, 3);
	// one shape for every model: no thinking, effort or sampling settings; the answer is streamed
	assert.deepEqual(Object.keys(sent[0]).sort(), ["max_tokens", "messages", "model", "stream", "system", "tools"]);
	assert.deepEqual([sent[0].model, sent[0].max_tokens, sent[0].system, sent[0].stream], ["claude-new", 32000, "You draw icons.", true]);
	assert.deepEqual(sent[0].tools, CREATOR_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
	// the request: the images first, then the words
	assert.deepEqual(sent[0].messages, [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }, { type: "text", text: "Draw a key." }] }]);
	// the model's answer goes back as it came, then what the tool answered: its picture too
	assert.deepEqual(sent[1].messages.slice(1), [
		{ role: "assistant", content: [{ type: "text", text: "Looking. " }, { type: "tool_use", id: "toolu_1", name: "workshop_render_preview", input: { svg: ICON } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Here it is." }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.base64 } }] }] },
	]);
	// two calls in one answer: both answered in one message, a refusal marked as an error
	assert.deepEqual(sent[2].messages[4], {
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "Taken." }] },
			{ type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: [{ type: "text", text: "That is not an SVG." }] },
		],
	});
	for (const r of s.requests) assert.equal(r.headers.authorization, `Bearer ${KEY}`);
	assert.equal(s.requests.filter((r) => r.path === "/v1/models/claude-new").length, 1, "how much the model may write is asked once");

	// the next request goes on from there
	assert.equal(await chat.send("Thicker lines.", [], new AbortController().signal), "end_turn");
	const next = s.posts("/v1/messages").pop().body.messages;
	assert.equal(next.length, 7);
	assert.deepEqual(next.slice(5), [{ role: "assistant", content: [{ type: "text", text: "Done." }] }, { role: "user", content: [{ type: "text", text: "Thicker lines." }] }]);
	assert.equal(s.requests.filter((r) => r.path === "/v1/models/claude-new").length, 1);
});

test("Anthropic: an answer that declines, runs out of room, pauses, or never stops calling tools", async () => {
	const script = [];
	const s = await anthropicApi(script, { max_tokens: 8000 });
	const box = toolbox();
	const said = [];
	const chat = anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "s", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: s.url });
	const send = (text) => chat.send(text, [], new AbortController().signal);
	const last = () => s.posts("/v1/messages").pop().body;

	// declined: said so, and the request is forgotten
	script.push(fake.anthropicAnswer([{ text: "I can't help with that." }], "refusal"));
	assert.equal(await send("one"), "refusal");
	assert.equal(last().max_tokens, 8000, "no more than the model allows");

	// a tool call cut off by the length limit is not run: the model is told to send it again
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_cut", partial: '{"svg": "<svg xmlns=' }], "max_tokens"), fake.anthropicAnswer([{ text: "Shorter then." }]));
	assert.equal(await send("two"), "end_turn");
	assert.deepEqual(box.calls, []);
	const told = last().messages;
	assert.deepEqual(told[0], { role: "user", content: [{ type: "text", text: "two" }] }, "the declined request is not sent again");
	assert.deepEqual(told[2].content, [{ type: "tool_result", tool_use_id: "toolu_cut", is_error: true, content: [{ type: "text", text: "This call was cut off by the length limit. Send it again, shorter." }] }]);

	// out of room while writing
	script.push(fake.anthropicAnswer([{ text: "A long story that" }], "max_tokens"));
	assert.equal(await send("three"), "max_tokens");

	// a pause on the provider's side: asked again to go on, with what it wrote so far
	script.push(fake.anthropicAnswer([{ text: "Half, " }], "pause_turn"), fake.anthropicAnswer([{ text: "and the rest." }]));
	said.length = 0;
	assert.equal(await send("four"), "end_turn");
	assert.equal(said.join(""), "Half, and the rest.");
	assert.deepEqual(last().messages.slice(-2), [{ role: "user", content: [{ type: "text", text: "four" }] }, { role: "assistant", content: [{ type: "text", text: "Half, " }] }]);

	// a model that calls tools without end is stopped, and that request forgotten
	const before = last().messages.length + 1;
	for (let i = 0; i <= MAX_TOOL_ROUNDS; i++) script.push(fake.anthropicAnswer([{ tool: "workshop_render_preview", id: `toolu_r${i}`, input: { svg: ICON } }]));
	await assert.rejects(send("five"), (e) => e instanceof ApiError && /kept calling tools without finishing/.test(e.message));
	assert.equal(box.calls.length, MAX_TOOL_ROUNDS);
	assert.equal(script.length, 0);
	script.push(fake.anthropicAnswer([{ text: "Fine." }]));
	assert.equal(await send("six"), "end_turn");
	assert.equal(last().messages.length, before + 1);
	assert.deepEqual(last().messages.pop(), { role: "user", content: [{ type: "text", text: "six" }] });
});

test("Anthropic: a request that is stopped ends as stopped, and leaves no half conversation", { timeout: 30000 }, async () => {
	const script = [];
	const s = await anthropicApi(script);
	const said = [];
	const stop = new AbortController();
	const box = toolbox({
		// stopped while a tool runs
		workshop_render_preview: () => {
			stop.abort();
			return { text: "Here it is.", image: PNG };
		},
	});
	const chat = anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "s", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: s.url });

	// while the model is still writing
	script.push(fake.anthropicUnfinished("Thinking about"));
	const first = new AbortController();
	const running = chat.send("one", [], first.signal);
	await until(() => said.join("") === "Thinking about");
	first.abort();
	assert.equal(await running, "cancelled");
	await until(() => s.posts("/v1/messages")[0].dropped);

	// between two tool calls of one answer: the second is not run
	script.push(fake.anthropicAnswer([{ tool: "workshop_render_preview", id: "toolu_a", input: { svg: ICON } }, { tool: "workshop_submit_svg", id: "toolu_b", input: { svg: ICON } }]));
	assert.equal(await chat.send("two", [], stop.signal), "cancelled");
	assert.deepEqual(box.calls.map((c) => c[0]), ["workshop_render_preview"]);

	// already stopped before it began
	assert.equal(await chat.send("three", [], stop.signal), "cancelled");

	// the next request starts from a conversation the API accepts: neither stopped request is in it
	script.push(fake.anthropicAnswer([{ text: "Here." }]));
	assert.equal(await chat.send("four", [], new AbortController().signal), "end_turn");
	assert.deepEqual(s.posts("/v1/messages").pop().body.messages, [{ role: "user", content: [{ type: "text", text: "four" }] }]);
});

test("Anthropic: what goes wrong is said in words, and a key that is not accepted is told apart", { timeout: 30000 }, async () => {
	const error = (status, type, message) => ({ status, json: { type: "error", error: { type, message } } });
	const script = [];
	const s = await anthropicApi(script, null);
	const chat = () => anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "s", tools: TOOLS, callTool: async () => ({ text: "ok" }), onText: () => undefined, baseURL: s.url });
	const fails = async (reply, pattern, badKey = false) => {
		script.push(reply);
		await assert.rejects(chat().send("x", [], new AbortController().signal), (e) => {
			assert.ok(e instanceof ApiError, String(e));
			assert.match(e.message, pattern);
			assert.equal(e.badKey, badKey);
			assert.doesNotMatch(e.message, new RegExp(KEY));
			return true;
		});
	};
	await fails(error(401, "authentication_error", "invalid x-api-key"), /^Anthropic did not accept the API key\. Check it in Settings → Agents & models → API keys\.$/, true);
	// (the model could not be looked up either: a size every model takes is used)
	assert.equal(s.posts("/v1/messages").pop().body.max_tokens, 16000);
	await fails(error(403, "permission_error", "no access"), /^This Anthropic API key may not use that model\.$/);
	await fails(error(404, "not_found_error", "model: claude-new"), /^Anthropic does not know that model\. Choose another one\.$/);
	await fails(error(429, "rate_limit_error", "slow down"), /^Anthropic is limiting requests for this key right now\. Try again in a moment\.$/);
	await fails(error(529, "overloaded_error", "Overloaded\nsecond line"), /^Anthropic answered with an error \(529\): Overloaded$/);
	// the models of a key that is not accepted
	const bad = await api(() => error(401, "authentication_error", "invalid x-api-key"));
	await assert.rejects(anthropicProvider.models(KEY, { baseURL: bad.url }), (e) => e instanceof ApiError && e.badKey && /did not accept the API key/.test(e.message));
	// nobody there
	const gone = await api(() => undefined);
	await gone.close();
	await assert.rejects(anthropicProvider.models(KEY, { baseURL: gone.url }), /^ApiError: Anthropic's API could not be reached\. Check the connection and try again\.$|could not be reached/);
});

test("Anthropic: an answer with nothing in it, a request the API calls malformed, a model that takes no pictures, a provider that quotes the key back", async () => {
	const script = [];
	const s = await anthropicApi(script);
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG } });
	const chat = anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "s", tools: TOOLS, callTool: box.callTool, onText: () => undefined, baseURL: s.url });
	const send = (text) => chat.send(text, [], new AbortController().signal);
	const last = () => s.posts("/v1/messages").pop();
	assert.equal(chat.blank(), true);

	// a model may end its turn with nothing after a tool's answer: that is not kept as an answer
	// (the API takes no message without content), and the conversation goes on
	script.push(fake.anthropicAnswer([{ tool: "workshop_render_preview", id: "toolu_1", input: { svg: ICON } }]), fake.anthropicAnswer([]), fake.anthropicAnswer([{ text: "" }, { text: "Rounder." }]));
	assert.equal(await send("one"), "end_turn");
	assert.equal(chat.blank(), false);
	assert.equal(await send("two"), "end_turn");
	assert.equal(last().refused, undefined);
	assert.deepEqual(last().body.messages.map((m) => m.role), ["user", "assistant", "user", "user"]);
	// (text that is empty is left out of what goes back)
	script.push(fake.anthropicAnswer([{ text: "Yes." }]));
	assert.equal(await send("three"), "end_turn");
	assert.deepEqual(last().body.messages.slice(-2), [{ role: "assistant", content: [{ type: "text", text: "Rounder." }] }, { role: "user", content: [{ type: "text", text: "three" }] }]);
	assert.equal(last().refused, undefined);
	// ... and so is text that is only white space, as a model writes before a tool call
	script.push(fake.anthropicAnswer([{ text: "\n\n" }, { tool: "workshop_render_preview", id: "toolu_w", input: { svg: ICON } }]), fake.anthropicAnswer([{ text: "Looked." }]));
	assert.equal(await send("three and a half"), "end_turn");
	assert.equal(last().refused, undefined);
	assert.deepEqual(last().body.messages.slice(-2)[0], { role: "assistant", content: [{ type: "tool_use", id: "toolu_w", name: "workshop_render_preview", input: { svg: ICON } }] });

	// a request the API calls malformed may be so because of what is kept: all of it is forgotten, and the next one starts over
	script.push({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: `messages.3: something this app got wrong, with the key ${KEY} quoted back` } } });
	await assert.rejects(send("four"), (e) => {
		assert.ok(e instanceof ApiError);
		// (a provider's words are shown, never the key in them)
		assert.match(e.message, /^Anthropic answered with an error \(400\): .*with the key \(the key\) quoted back/);
		assert.doesNotMatch(e.message, new RegExp(KEY));
		return true;
	});
	// (nor a part of it, where the key falls on the place a long message is cut at)
	script.push({ status: 500, json: { type: "error", error: { type: "api_error", message: `${"x".repeat(290)}${KEY} and more` } } });
	await assert.rejects(send("four and a half"), (e) => e instanceof ApiError && !e.message.includes(KEY.slice(0, 6)) && e.message.length < 360);
	assert.equal(chat.blank(), true);
	script.push(fake.anthropicAnswer([{ text: "From the start." }]));
	assert.equal(await send("five"), "end_turn");
	assert.deepEqual(last().body.messages, [{ role: "user", content: [{ type: "text", text: "five" }] }]);

	// a model that takes no pictures gets none: not with the request, and not from a tool, which says so
	const blind = anthropicProvider.chat({ apiKey: KEY, model: "claude-new", system: "s", tools: TOOLS, images: false, callTool: box.callTool, onText: () => undefined, baseURL: s.url });
	script.push(fake.anthropicAnswer([{ tool: "workshop_render_preview", id: "toolu_2", input: { svg: ICON } }]), fake.anthropicAnswer([{ text: "Drawn blind." }]));
	assert.equal(await blind.send("six", [{ mimeType: "image/png", base64: "AAAA" }], new AbortController().signal), "end_turn");
	assert.deepEqual(last().body.messages, [
		{ role: "user", content: [{ type: "text", text: "six" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "workshop_render_preview", input: { svg: ICON } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "Here it is. (This model takes no pictures, so the picture is not shown to it.)" }] }] },
	]);
});

// ----- OpenAI -----

test("OpenAI: its models: the ones for a conversation, newest first", async () => {
	const s = await api((r) =>
		r.method === "GET" && r.path === "/v1/models"
			? fake.openAiModels([
					{ id: "gpt-6-luna", created: 200 },
					{ id: "text-embedding-3-large", created: 900 },
					{ id: "gpt-6.2-astra", created: 300 },
					{ id: "gpt-image-2", created: 800 },
					{ id: "o5-mini", created: 250 },
					{ id: "whisper-1", created: 700 },
					{ id: "gpt-realtime-2", created: 600 },
					{ id: "gpt-6-tts", created: 500 },
					{ id: "ft:someone-elses-name", created: 400 },
			  ])
			: undefined
	);
	assert.deepEqual(await openAiProvider.models(KEY, { baseURL: `${s.url}/v1` }), [{ value: "gpt-6.2-astra", name: "gpt-6.2-astra" }, { value: "o5-mini", name: "o5-mini" }, { value: "gpt-6-luna", name: "gpt-6-luna" }]);
	assert.deepEqual([openAiProvider.id, openAiProvider.label, openAiProvider.company], ["openai", "OpenAI API", "OpenAI"]);
});

async function openAiApi(script) {
	return api((r) => (r.method === "POST" && r.path === "/v1/responses" ? script.shift() : undefined));
}

test("OpenAI: a request, the model's tool calls and their answers, each request going on from the answer before", async () => {
	const script = [
		fake.responsesAnswer("resp_1", [{ text: "Looking. " }, { call: "workshop_render_preview", id: "call_1", arguments: { svg: ICON } }]),
		fake.responsesAnswer("resp_2", [{ call: "workshop_submit_svg", id: "call_2", arguments: { svg: ICON, name: "Key" } }, { call: "workshop_submit_svg", id: "call_3", arguments: '{"svg": ' }, { call: "workshop_submit_svg", id: "call_4", arguments: { svg: "<p/>" } }]),
		fake.responsesAnswer("resp_3", [{ text: "Done." }]),
		fake.responsesAnswer("resp_4", [{ text: "Thicker now." }]),
	];
	const s = await openAiApi(script);
	const said = [];
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG }, workshop_submit_svg: (a) => (a.name ? { text: "Taken." } : { text: "That is not an SVG.", isError: true }) });
	const chat = openAiProvider.chat({ apiKey: KEY, model: "gpt-6.2-astra", system: "You draw icons.", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: `${s.url}/v1` });
	assert.equal(await chat.send("Draw a key.", [{ mimeType: "image/jpeg", base64: "AAAA" }], new AbortController().signal), "end_turn");
	assert.equal(said.join(""), "Looking. Done.");
	// (the call whose arguments were not JSON is not run)
	assert.deepEqual(box.calls, [["workshop_render_preview", { svg: ICON }], ["workshop_submit_svg", { svg: ICON, name: "Key" }], ["workshop_submit_svg", { svg: "<p/>" }]]);

	const sent = s.posts("/v1/responses").map((r) => r.body);
	assert.equal(sent.length, 3);
	assert.deepEqual(Object.keys(sent[0]).sort(), ["input", "instructions", "model", "stream", "tools"]);
	assert.deepEqual([sent[0].model, sent[0].instructions, sent[0].stream], ["gpt-6.2-astra", "You draw icons.", true]);
	assert.deepEqual(sent[0].tools, CREATOR_TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false })));
	assert.deepEqual(sent[0].input, [{ role: "user", content: [{ type: "input_text", text: "Draw a key." }, { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "auto" }] }]);
	// only what is new is sent: the tool's answer, and its picture in a message of its own
	assert.equal(sent[1].previous_response_id, "resp_1");
	assert.deepEqual(sent[1].input, [
		{ type: "function_call_output", call_id: "call_1", output: "Here it is." },
		{ role: "user", content: [{ type: "input_text", text: "The picture the tool returned:" }, { type: "input_image", image_url: `data:image/png;base64,${PNG.base64}`, detail: "auto" }] },
	]);
	assert.equal(sent[2].previous_response_id, "resp_2");
	assert.deepEqual(sent[2].input, [
		{ type: "function_call_output", call_id: "call_2", output: "Taken." },
		{ type: "function_call_output", call_id: "call_3", output: "Error: the arguments were not valid JSON. Send the call again." },
		{ type: "function_call_output", call_id: "call_4", output: "Error: That is not an SVG." },
	]);
	for (const r of s.requests) assert.equal(r.headers.authorization, `Bearer ${KEY}`);

	assert.equal(await chat.send("Thicker lines.", [], new AbortController().signal), "end_turn");
	const next = s.posts("/v1/responses").pop().body;
	assert.equal(next.previous_response_id, "resp_3");
	assert.deepEqual(next.input, [{ role: "user", content: [{ type: "input_text", text: "Thicker lines." }] }]);
});

test("OpenAI: an answer that declines, runs out of room, fails or breaks off; a request that is stopped", { timeout: 30000 }, async () => {
	const script = [];
	const s = await openAiApi(script);
	const said = [];
	const stop = new AbortController();
	const box = toolbox({
		workshop_render_preview: () => {
			stop.abort();
			return { text: "Here it is." };
		},
	});
	const chat = openAiProvider.chat({ apiKey: KEY, model: "gpt-6.2-astra", system: "s", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: `${s.url}/v1` });
	const send = (text, signal = new AbortController().signal) => chat.send(text, [], signal);
	const last = () => s.posts("/v1/responses").pop().body;

	script.push(fake.responsesAnswer("resp_1", [{ text: "Hello." }]));
	assert.equal(await send("one"), "end_turn");

	// declined: the next request goes on from the answer before it
	script.push(fake.responsesAnswer("resp_2", [{ refusal: "I can't help with that." }]));
	assert.equal(await send("two"), "refusal");
	script.push(fake.responsesAnswer("resp_3", [{ text: "A long story that" }], "incomplete"));
	assert.equal(await send("three"), "max_tokens");
	assert.equal(last().previous_response_id, "resp_1");

	// the provider could not finish; the stream ended without an answer
	script.push(fake.responsesAnswer("resp_4", [], "failed"));
	await assert.rejects(send("four"), (e) => e instanceof ApiError && /^OpenAI could not finish the request: the model broke down$/.test(e.message));
	script.push({ sse: fake.responsesAnswer("resp_5", [{ text: "Half" }]).sse.slice(0, 2) });
	await assert.rejects(send("five"), (e) => e instanceof ApiError && /^OpenAI ended the answer without finishing it\. Try again\.$/.test(e.message));
	script.push({ sse: [{ event: "error", data: { type: "error", sequence_number: 0, code: "server_error", message: "boom", param: null } }] });
	await assert.rejects(send("six"), /boom/);

	// stopped while the model writes, and between two tool calls
	script.push(fake.responsesUnfinished("resp_7", "Thinking about"));
	const first = new AbortController();
	said.length = 0;
	const running = send("seven", first.signal);
	await until(() => said.join("") === "Thinking about");
	first.abort();
	assert.equal(await running, "cancelled");
	script.push(fake.responsesAnswer("resp_8", [{ call: "workshop_render_preview", id: "call_a", arguments: { svg: ICON } }, { call: "workshop_submit_svg", id: "call_b", arguments: { svg: ICON } }]));
	assert.equal(await send("eight", stop.signal), "cancelled");
	assert.deepEqual(box.calls.map((c) => c[0]), ["workshop_render_preview"]);

	// after all that the conversation goes on from the last answer that was whole: one the API can go on from
	script.push(fake.responsesAnswer("resp_9", [{ text: "Here." }]));
	assert.equal(await send("nine"), "end_turn");
	assert.equal(last().previous_response_id, "resp_3");
	assert.deepEqual(last().input, [{ role: "user", content: [{ type: "input_text", text: "nine" }] }]);

	// a model that calls tools without end
	const more = toolbox();
	const loop = openAiProvider.chat({ apiKey: KEY, model: "gpt-6.2-astra", system: "s", tools: TOOLS, callTool: more.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	for (let i = 0; i <= MAX_TOOL_ROUNDS; i++) script.push(fake.responsesAnswer(`resp_l${i}`, [{ call: "workshop_render_preview", id: `call_l${i}`, arguments: { svg: ICON } }]));
	await assert.rejects(loop.send("again", [], new AbortController().signal), /kept calling tools without finishing/);
	assert.equal(more.calls.length, MAX_TOOL_ROUNDS);
});

test("OpenAI: a tool call cut off by the length limit, an answer OpenAI did not keep, a model that takes no pictures", async () => {
	const script = [];
	const s = await openAiApi(script);
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG } });
	const chat = openAiProvider.chat({ apiKey: KEY, model: "gpt-6.2-astra", system: "s", tools: TOOLS, callTool: box.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	const send = (text) => chat.send(text, [], new AbortController().signal);
	const last = () => s.posts("/v1/responses").pop();
	assert.equal(chat.blank(), true);

	// a tool call cut off by the length limit is not run: its arguments are not whole (here they even parse). The answer
	// it is part of waits for that tool and cannot be gone on from: the request ends as out of room, and is forgotten
	script.push(fake.responsesAnswer("resp_1", [{ call: "workshop_submit_svg", id: "call_cut", arguments: { svg: "<svg" } }], "incomplete"));
	assert.equal(await send("one"), "max_tokens");
	assert.deepEqual([box.calls, chat.blank()], [[], true]);
	script.push(fake.responsesAnswer("resp_2", [{ text: "Hello." }]));
	assert.equal(await send("one again"), "end_turn");
	assert.deepEqual([last().body.previous_response_id, last().refused, chat.blank()], [undefined, undefined, false]);

	// OpenAI did not keep the answer to go on from (an organisation can switch that off): said in words, and the conversation starts over
	const unkept = fake.responsesAnswer("resp_3", [{ call: "workshop_render_preview", id: "call_1", arguments: { svg: ICON } }]);
	delete unkept.keeps;
	script.push(unkept);
	await assert.rejects(send("two"), (e) => e instanceof ApiError && /^OpenAI could not go on from its own previous answer \(Previous response with id 'resp_3' not found\.\)\. This way of working needs OpenAI to keep answers for a while, which an organisation can switch off\.$/.test(e.message));
	assert.equal(last().refused, "Previous response with id 'resp_3' not found.");
	assert.equal(chat.blank(), true);
	script.push(fake.responsesAnswer("resp_4", [{ text: "From the start." }]));
	assert.equal(await send("three"), "end_turn");
	assert.equal(last().body.previous_response_id, undefined);
	// (the same when OpenAI says so with "not found": it is not taken for a model that does not exist)
	script.push({ status: 404, json: { error: { message: "Previous response with id 'resp_4' not found.", type: "invalid_request_error", code: "previous_response_not_found", param: "previous_response_id" } } });
	await assert.rejects(send("three and a half"), /could not go on from its own previous answer/);
	assert.equal(chat.blank(), true);

	// a model that takes no pictures gets none
	const blind = openAiProvider.chat({ apiKey: KEY, model: "gpt-words", system: "s", tools: TOOLS, images: false, callTool: box.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	script.push(fake.responsesAnswer("resp_5", [{ call: "workshop_render_preview", id: "call_2", arguments: { svg: ICON } }]), fake.responsesAnswer("resp_6", [{ text: "Drawn blind." }]));
	assert.equal(await blind.send("four", [{ mimeType: "image/png", base64: "AAAA" }], new AbortController().signal), "end_turn");
	assert.deepEqual(s.posts("/v1/responses").slice(-2)[0].body.input, [{ role: "user", content: [{ type: "input_text", text: "four" }] }]);
	assert.deepEqual(last().body.input, [{ type: "function_call_output", call_id: "call_2", output: "Here it is. (This model takes no pictures, so the picture is not shown to it.)" }]);
});

test("OpenAI and Kimi: what goes wrong is said in words", async () => {
	const error = (status, message, code = null, type = "invalid_request_error") => ({ status, json: { error: { message, type, code, param: null } } });
	const script = [];
	const s = await api((r) => (r.method === "POST" ? script.shift() : undefined));
	const fails = async (provider, reply, pattern, badKey = false) => {
		script.push(reply);
		const chat = provider.chat({ apiKey: KEY, model: "m", system: "s", tools: TOOLS, callTool: async () => ({ text: "ok" }), onText: () => undefined, baseURL: `${s.url}/v1` });
		await assert.rejects(chat.send("x", [], new AbortController().signal), (e) => {
			assert.ok(e instanceof ApiError, String(e));
			assert.match(e.message, pattern);
			assert.equal(e.badKey, badKey);
			assert.doesNotMatch(e.message, new RegExp(KEY));
			return true;
		});
	};
	await fails(openAiProvider, error(401, `Incorrect API key provided: ${KEY}. You can find your API key at the platform.`, "invalid_api_key"), /^OpenAI did not accept the API key\. Check it in Settings → Agents & models → API keys\.$/, true);
	// a key that is real but restricted is answered like one that is not a key: it is told apart, and is not a rejected key
	await fails(openAiProvider, error(401, "You have insufficient permissions for this operation. Missing scopes: api.responses.write. Check that you have the correct role.", null), /^This OpenAI key is restricted and may not do this: You have insufficient permissions for this operation\. Missing scopes: api\.responses\.write\./);
	// a provider that quotes the key back: its words are shown, the key in them is not
	await fails(openAiProvider, error(500, `The server had an error while processing a request made with ${KEY}`), /^OpenAI answered with an error \(500\): .*made with \(the key\)$/);
	await fails(openAiProvider, error(403, "Project does not have access to model"), /^OpenAI refused this request for this key \(no access to the model, or no balance\): .*does not have access/);
	await fails(openAiProvider, error(404, "The model `m` does not exist", "model_not_found"), /^OpenAI does not know that model\. Choose another one\.$/);
	await fails(openAiProvider, error(429, "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota"), /^This OpenAI key has no credit or has reached its spending limit: /);
	await fails(openAiProvider, error(429, "Rate limit reached for requests", "rate_limit_exceeded"), /^OpenAI is limiting requests for this key right now\. Try again in a moment\.$/);
	await fails(openAiProvider, error(500, "The server had an error"), /^OpenAI answered with an error \(500\): /);
	await fails(kimiProvider, error(401, "Invalid Authentication", "invalid_authentication_error"), /^Kimi did not accept the API key\. Check it in Settings → Agents & models → API keys\.$/, true);
	await fails(kimiProvider, error(403, "Your account is suspended due to insufficient balance"), /^Kimi refused this request for this key \(no access to the model, or no balance\): .*insufficient balance/);
	await fails(kimiProvider, error(429, "Your account has reached its rate limit", "rate_limit_reached_error"), /^Kimi is limiting requests for this key right now\. Try again in a moment\.$/);
	const bad = await api(() => error(401, "Incorrect API key provided", "invalid_api_key"));
	for (const p of [openAiProvider, kimiProvider]) await assert.rejects(p.models(KEY, { baseURL: `${bad.url}/v1` }), (e) => e instanceof ApiError && e.badKey);
});

// ----- Kimi -----

test("Kimi: its models: the ones that see images first, then the newest", async () => {
	const s = await api((r) =>
		r.method === "GET" && r.path === "/v1/models"
			? fake.openAiModels([
					{ id: "kimi-k3", created: 100, supports_image_in: true },
					{ id: "moonshot-v1-8k", created: 300, supports_image_in: false },
					{ id: "kimi-k3.1-pro", created: 200, supports_image_in: true },
					{ id: "kimi-unsaid", created: 50 },
			  ])
			: undefined
	);
	// (a model the provider says takes no pictures is marked: it is given words only)
	assert.deepEqual(await kimiProvider.models(KEY, { baseURL: `${s.url}/v1` }), [{ value: "kimi-k3.1-pro", name: "kimi-k3.1-pro" }, { value: "kimi-k3", name: "kimi-k3" }, { value: "kimi-unsaid", name: "kimi-unsaid" }, { value: "moonshot-v1-8k", name: "moonshot-v1-8k", images: false }]);
	assert.deepEqual([kimiProvider.id, kimiProvider.label, kimiProvider.company], ["kimi", "Kimi API", "Kimi"]);
});

async function kimiApi(script) {
	return api((r) => (r.method === "POST" && r.path === "/v1/chat/completions" ? script.shift() : undefined));
}

test("Kimi: a request, tool calls that arrive in pieces, and the whole conversation sent back with the model's reasoning", async () => {
	const script = [
		fake.completionsAnswer({ reasoning: "A key has a bow and a bit.", text: "Looking. ", calls: [{ id: "call_1", name: "workshop_render_preview", arguments: { svg: ICON } }] }),
		fake.completionsAnswer({ calls: [{ id: "call_2", name: "workshop_submit_svg", arguments: { svg: ICON, name: "Key" } }, { id: "call_3", name: "workshop_submit_svg", arguments: '{"svg": ' }, { id: "call_4", name: "workshop_submit_svg", arguments: { svg: "<p/>" } }] }),
		fake.completionsAnswer({ text: "Done." }),
		fake.completionsAnswer({ text: "Thicker now." }),
	];
	const s = await kimiApi(script);
	const said = [];
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG }, workshop_submit_svg: (a) => (a.name ? { text: "Taken." } : { text: "That is not an SVG.", isError: true }) });
	const chat = kimiProvider.chat({ apiKey: KEY, model: "kimi-k3.1-pro", system: "You draw icons.", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: `${s.url}/v1` });
	assert.equal(await chat.send("Draw a key.", [{ mimeType: "image/jpeg", base64: "AAAA" }], new AbortController().signal), "end_turn");
	// (its reasoning is not shown: only what it says)
	assert.equal(said.join(""), "Looking. Done.");
	assert.deepEqual(box.calls, [["workshop_render_preview", { svg: ICON }], ["workshop_submit_svg", { svg: ICON, name: "Key" }], ["workshop_submit_svg", { svg: "<p/>" }]]);

	const sent = s.posts("/v1/chat/completions").map((r) => r.body);
	assert.equal(sent.length, 3);
	assert.deepEqual(Object.keys(sent[0]).sort(), ["max_completion_tokens", "messages", "model", "stream", "tools"]);
	assert.deepEqual([sent[0].model, sent[0].stream, sent[0].max_completion_tokens], ["kimi-k3.1-pro", true, 16000]);
	assert.deepEqual(sent[0].tools, CREATOR_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })));
	assert.deepEqual(sent[0].messages, [
		{ role: "system", content: "You draw icons." },
		{ role: "user", content: [{ type: "text", text: "Draw a key." }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
	]);
	// the answer goes back as it came, reasoning included; then the tool's answer, and its picture in a message of its own
	assert.deepEqual(sent[1].messages.slice(2), [
		{ role: "assistant", content: "Looking. ", reasoning_content: "A key has a bow and a bit.", tool_calls: [{ id: "call_1", type: "function", function: { name: "workshop_render_preview", arguments: JSON.stringify({ svg: ICON }) } }] },
		{ role: "tool", tool_call_id: "call_1", content: "Here it is." },
		{ role: "user", content: [{ type: "text", text: "The picture the tool returned:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.base64}` } }] },
	]);
	assert.deepEqual(sent[2].messages.slice(6), [
		{ role: "tool", tool_call_id: "call_2", content: "Taken." },
		{ role: "tool", tool_call_id: "call_3", content: "Error: the arguments were not valid JSON. Send the call again." },
		{ role: "tool", tool_call_id: "call_4", content: "Error: That is not an SVG." },
	]);
	for (const r of s.requests) assert.equal(r.headers.authorization, `Bearer ${KEY}`);

	// a request without images is plain text
	assert.equal(await chat.send("Thicker lines.", [], new AbortController().signal), "end_turn");
	const next = s.posts("/v1/chat/completions").pop().body.messages;
	assert.deepEqual(next.slice(-2), [{ role: "assistant", content: "Done." }, { role: "user", content: "Thicker lines." }]);
});

test("Kimi: an answer cut off or filtered, a request that is stopped, a model that never stops calling tools", { timeout: 30000 }, async () => {
	const script = [];
	const s = await kimiApi(script);
	const said = [];
	const stop = new AbortController();
	const box = toolbox({
		workshop_render_preview: () => {
			stop.abort();
			return { text: "Here it is." };
		},
	});
	const chat = kimiProvider.chat({ apiKey: KEY, model: "kimi-k3", system: "s", tools: TOOLS, callTool: box.callTool, onText: (t) => said.push(t), baseURL: `${s.url}/v1` });
	const send = (text, signal = new AbortController().signal) => chat.send(text, [], signal);
	const last = () => s.posts("/v1/chat/completions").pop().body.messages;

	// a tool call cut off by the length limit is not run, and not kept (its arguments are not whole): the request ends as out of room
	script.push(fake.completionsAnswer({ text: "Handing it in. ", calls: [{ id: "call_cut", name: "workshop_submit_svg", arguments: '{"svg": "<svg' }], finish: "length" }));
	assert.equal(await send("one"), "max_tokens");
	assert.deepEqual(box.calls, []);
	script.push(fake.completionsAnswer({ text: "A long story that", finish: "length" }));
	assert.equal(await send("two"), "max_tokens");
	assert.deepEqual(last().slice(1, 4), [{ role: "user", content: "one" }, { role: "assistant", content: "Handing it in. " }, { role: "user", content: "two" }]);
	assert.equal(s.posts("/v1/chat/completions").pop().refused, undefined);
	const kept = last().length + 1;

	// an answer that breaks off without saying why it ended is no answer
	script.push({ sse: fake.completionsAnswer({ text: "Half" }).sse.slice(0, 2) });
	await assert.rejects(send("half"), (e) => e instanceof ApiError && /^Kimi ended the answer without finishing it\. Try again\.$/.test(e.message));

	// filtered: declined, and forgotten
	script.push(fake.completionsAnswer({ text: "", finish: "content_filter" }));
	assert.equal(await send("three"), "refusal");

	// stopped while the model writes, and between two tool calls
	script.push(fake.completionsUnfinished("Thinking about"));
	const first = new AbortController();
	said.length = 0;
	const running = send("four", first.signal);
	await until(() => said.join("") === "Thinking about");
	first.abort();
	assert.equal(await running, "cancelled");
	script.push(fake.completionsAnswer({ calls: [{ id: "call_a", name: "workshop_render_preview", arguments: { svg: ICON } }, { id: "call_b", name: "workshop_submit_svg", arguments: { svg: ICON } }] }));
	assert.equal(await send("five", stop.signal), "cancelled");
	assert.deepEqual(box.calls.map((c) => c[0]), ["workshop_render_preview"]);

	// none of those three is in the conversation that goes on
	script.push(fake.completionsAnswer({ text: "Here." }));
	assert.equal(await send("six"), "end_turn");
	assert.equal(last().length, kept + 1);
	assert.deepEqual(last().pop(), { role: "user", content: "six" });

	const more = toolbox();
	const loop = kimiProvider.chat({ apiKey: KEY, model: "kimi-k3", system: "s", tools: TOOLS, callTool: more.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	for (let i = 0; i <= MAX_TOOL_ROUNDS; i++) script.push(fake.completionsAnswer({ calls: [{ id: `call_l${i}`, name: "workshop_render_preview", arguments: { svg: ICON } }] }));
	await assert.rejects(loop.send("again", [], new AbortController().signal), /kept calling tools without finishing/);
	assert.equal(more.calls.length, MAX_TOOL_ROUNDS);
});

test("Kimi: an answer with nothing in it, a request the API calls malformed, a model that takes no pictures, how much an answer may hold", async () => {
	const script = [];
	const s = await kimiApi(script);
	const box = toolbox({ workshop_render_preview: { text: "Here it is.", image: PNG } });
	const chat = kimiProvider.chat({ apiKey: KEY, model: "kimi-k3", system: "s", tools: TOOLS, callTool: box.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	const send = (text) => chat.send(text, [], new AbortController().signal);
	const last = () => s.posts("/v1/chat/completions").pop();
	assert.equal(chat.blank(), true);

	// a model that only reasoned, or ended with nothing after a tool's answer: not kept as an answer, and the conversation goes on
	script.push(fake.completionsAnswer({ calls: [{ id: "call_1", name: "workshop_render_preview", arguments: { svg: ICON } }] }), fake.completionsAnswer({ reasoning: "Nothing more to say." }), fake.completionsAnswer({ text: "Rounder." }));
	assert.equal(await send("one"), "end_turn");
	assert.equal(chat.blank(), false);
	assert.equal(await send("two"), "end_turn");
	assert.equal(last().refused, undefined);
	assert.deepEqual(last().body.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "user"]);

	// a request the API calls malformed: all of the conversation is forgotten but what the model is here for
	script.push({ status: 400, json: { error: { message: "Invalid request: something this app got wrong", type: "invalid_request_error" } } });
	await assert.rejects(send("three"), /^ApiError: Kimi answered with an error \(400\)|Kimi answered with an error \(400\)/);
	assert.equal(chat.blank(), true);
	script.push(fake.completionsAnswer({ text: "From the start." }));
	assert.equal(await send("four"), "end_turn");
	assert.deepEqual(last().body.messages, [{ role: "system", content: "s" }, { role: "user", content: "four" }]);

	// a model that takes no pictures gets none: the request is words, and a tool's picture is said to be left out
	const blind = kimiProvider.chat({ apiKey: KEY, model: "moonshot-v1-8k", system: "s", tools: TOOLS, images: false, callTool: box.callTool, onText: () => undefined, baseURL: `${s.url}/v1` });
	script.push(fake.completionsAnswer({ calls: [{ id: "call_2", name: "workshop_render_preview", arguments: { svg: ICON } }] }), fake.completionsAnswer({ text: "Drawn blind." }));
	assert.equal(await blind.send("five", [{ mimeType: "image/png", base64: "AAAA" }], new AbortController().signal), "end_turn");
	assert.deepEqual(last().body.messages.slice(1), [
		{ role: "user", content: "five" },
		{ role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "workshop_render_preview", arguments: JSON.stringify({ svg: ICON }) } }] },
		{ role: "tool", tool_call_id: "call_2", content: "Here it is. (This model takes no pictures, so the picture is not shown to it.)" },
	]);
	// an answer gets what the model has room for: the older models are named after the size of their whole conversation
	assert.equal(last().body.max_completion_tokens, 4096);
	assert.deepEqual(["kimi-k3.1-pro", "kimi-k3", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k-vision-preview", "moonshot-v1-auto"].map(kimiAnswerRoom), [16000, 16000, 4096, 16000, 16000, 16000]);
});

// ----- keeping a key, and the models it can use -----

/** The app's API access with its parts in reach: a key file, settings in memory, the providers at local stand-ins. */
function access(urls, state = { available: true }, listMs) {
	const file = tmpFile();
	const settings = { models: {}, modelCatalog: {}, updates: 0 };
	const keys = new KeyStore(file, cipher(state));
	const a = new ApiAccess({
		providers: API_PROVIDERS,
		keys,
		settings: () => settings,
		update: (patch) => {
			settings.updates++;
			Object.assign(settings, patch);
		},
		baseURL: (id) => urls[id],
		...(listMs ? { listMs } : {}),
	});
	return { a, keys, settings, file, state };
}

test("keeping a key: the provider is asked with it first; one it does not accept is not kept; the key is in neither the settings nor the file", { timeout: 30000 }, async () => {
	let accepts = KEY;
	let down = false;
	const s = await api((r) => {
		if (r.method !== "GET" || !r.path.startsWith("/v1/models")) return undefined;
		if (down) return { status: 500, json: { type: "error", error: { type: "api_error", message: "Internal server error" } } };
		if (r.headers.authorization !== `Bearer ${accepts}`) return { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
		return fake.anthropicModels([{ id: "claude-old", display_name: "Claude Old", created_at: "2024-02-01T00:00:00Z" }, { id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
	});
	const w = access({ anthropic: s.url });
	const nowhere = () => assert.doesNotMatch(JSON.stringify(w.settings) + (fs.existsSync(w.file) ? fs.readFileSync(w.file, "utf8") : ""), new RegExp(`${KEY}|${OTHER_KEY}`));

	// what is not a key is not sent anywhere
	assert.match(await w.a.saveKey("anthropic", "nope"), /does not look like an API key/);
	assert.match(await w.a.saveKey("nobody", KEY), /not known here/);
	assert.equal(s.requests.length, 0);
	// nor is a key that could not be kept safely afterwards
	w.state.available = false;
	assert.match(await w.a.saveKey("anthropic", KEY), /cannot keep the key safely/);
	assert.equal(s.requests.length, 0);
	w.state.available = true;

	// a key the provider does not accept is not kept
	assert.equal(await w.a.saveKey("anthropic", OTHER_KEY), "Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys.");
	assert.deepEqual([w.a.hasKey("anthropic"), w.a.models("anthropic"), w.settings.updates], [false, [], 0]);
	assert.deepEqual(await w.a.keyFor(anthropicProvider), { problem: "There is no Anthropic API key. Add one in Settings → Agents & models → API keys." });

	// one it accepts is, with the models it can use: named where the agents' models are, under "api:anthropic"
	assert.equal(await w.a.saveKey("anthropic", ` ${KEY}\n`), undefined);
	assert.equal(w.a.hasKey("anthropic"), true);
	assert.deepEqual(await w.a.keyFor(anthropicProvider), { key: KEY });
	assert.equal(apiAgentId("anthropic"), "api:anthropic");
	assert.deepEqual(w.settings.modelCatalog, { "api:anthropic": [{ value: "claude-new", name: "Claude New" }, { value: "claude-old", name: "Claude Old" }] });
	assert.deepEqual(w.a.models("anthropic"), [{ value: "claude-new", name: "Claude New" }, { value: "claude-old", name: "Claude Old" }]);
	nowhere();

	// a model hidden in Settings is not offered; the one picked last is remembered while it is offered
	assert.equal(w.a.preferred("anthropic"), undefined);
	w.a.prefer("anthropic", "claude-old");
	const updates = w.settings.updates;
	w.a.prefer("anthropic", "claude-old");
	assert.equal(w.settings.updates, updates, "picking the same again writes nothing");
	assert.equal(w.a.preferred("anthropic"), "claude-old");
	w.settings.models["api:anthropic"].hidden = ["claude-old"];
	assert.deepEqual([w.a.models("anthropic"), w.a.preferred("anthropic")], [[{ value: "claude-new", name: "Claude New" }], undefined]);

	// asking again with the kept key; what goes wrong is said, and the list stays as it was
	down = true;
	assert.deepEqual(await w.a.load("anthropic"), { problem: "Anthropic answered with an error (500): Internal server error", badKey: false });
	assert.equal(w.settings.modelCatalog["api:anthropic"].length, 2);
	down = false;
	assert.equal(await w.a.load("anthropic"), undefined);
	// a key the provider has since withdrawn
	accepts = "withdrawn";
	assert.deepEqual(await w.a.load("anthropic"), { problem: "Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys.", badKey: true });
	// a kept key the keychain no longer gives back: said, and nothing is sent
	const asked = s.requests.length;
	w.state.broken = true;
	assert.match((await w.a.load("anthropic")).problem, /^The saved Anthropic API key could not be read back from the system keychain\. Remove it in Settings/);
	assert.equal(s.requests.length, asked);
	w.state.broken = false;
	nowhere();

	// removed: the key and its models are forgotten (what was hidden stays the user's choice)
	w.a.removeKey("anthropic");
	assert.deepEqual([w.a.hasKey("anthropic"), w.settings.modelCatalog, w.a.models("anthropic")], [false, {}, []]);
	assert.deepEqual(JSON.parse(fs.readFileSync(w.file, "utf8")).keys, {});
	assert.match((await w.a.load("anthropic")).problem, /^There is no Anthropic API key/);

	// a provider that cannot be asked right now: the key is kept, and what went wrong is said
	accepts = KEY;
	down = true;
	assert.match(await w.a.saveKey("anthropic", KEY), /^Anthropic answered with an error \(500\)/);
	assert.deepEqual([w.a.hasKey("anthropic"), w.a.models("anthropic")], [true, []]);
	nowhere();

	// which entry of an agent list stands for a provider
	assert.equal(w.a.providerOfAgent("api:openai"), openAiProvider);
	for (const not of ["openai", "api:nobody", "api:", "claude", undefined, 7]) assert.equal(w.a.providerOfAgent(not), undefined, String(not));
});

test("keeping a key: a provider that is slow, a key replaced while its provider is asked, a key that stops being accepted, a restricted key", { timeout: 30000 }, async () => {
	let reply = () => fake.openAiModels([{ id: "gpt-6.2-astra", created: 300 }]);
	const s = await api((r) => (r.method === "GET" && r.path === "/v1/models" ? reply(r) : undefined));
	const w = access({ openai: `${s.url}/v1`, kimi: `${s.url}/v1` }, { available: true }, 150);
	assert.equal(await w.a.saveKey("openai", KEY), undefined);

	// a provider that does not answer in time: said in those words, and the list stays as it was
	reply = () => ({ ...fake.openAiModels([{ id: "gpt-late", created: 400 }]), delay: 600 });
	assert.deepEqual(await w.a.load("openai"), { problem: "OpenAI did not answer in time. Try again.", badKey: false });
	assert.deepEqual(w.a.models("openai"), [{ value: "gpt-6.2-astra", name: "gpt-6.2-astra" }]);

	// the key is replaced while its provider is asked with the old one: that answer is about a key that is gone, and is dropped
	reply = (r) => ({ ...fake.openAiModels([{ id: r.headers.authorization === `Bearer ${KEY}` ? "gpt-of-the-old-key" : "gpt-of-the-new-key", created: 500 }]), delay: 60 });
	const asking = w.a.load("openai");
	await wait(20);
	await w.keys.set("openai", OTHER_KEY);
	assert.equal(await asking, undefined);
	assert.deepEqual(w.a.models("openai").map((m) => m.value), ["gpt-6.2-astra"], "the old key's models are not taken for the new key's");
	assert.equal(await w.a.load("openai"), undefined);
	assert.deepEqual(w.a.models("openai").map((m) => m.value), ["gpt-of-the-new-key"]);
	// ... and removed while it is asked: nothing is remembered for a key that is gone
	const again = w.a.load("openai");
	await wait(20);
	w.a.removeKey("openai");
	assert.equal(await again, undefined);
	assert.deepEqual([w.a.hasKey("openai"), w.a.listed("openai"), w.settings.modelCatalog], [false, 0, {}]);

	// a kept key the provider stops accepting: known from then on, until it is accepted again, replaced or removed
	reply = () => fake.openAiModels([{ id: "gpt-6.2-astra", created: 300 }]);
	assert.equal(await w.a.saveKey("openai", KEY), undefined);
	assert.equal(w.a.wasRejected("openai"), false);
	reply = () => ({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } });
	assert.equal((await w.a.load("openai")).badKey, true);
	assert.equal(w.a.wasRejected("openai"), true);
	reply = () => fake.openAiModels([{ id: "gpt-6.2-astra", created: 300 }]);
	assert.equal(await w.a.load("openai"), undefined);
	assert.equal(w.a.wasRejected("openai"), false);
	// (whoever shows it is told when it changes, and only then)
	let told = 0;
	const off = w.a.onRejected(() => told++);
	w.a.noteRejected("openai");
	w.a.noteRejected("openai");
	assert.deepEqual([w.a.wasRejected("openai"), told], [true, 1]);
	off();
	assert.equal(await w.a.saveKey("openai", OTHER_KEY), undefined);
	assert.equal(w.a.wasRejected("openai"), false);
	w.a.noteRejected("openai");
	w.a.removeKey("openai");
	assert.equal(w.a.wasRejected("openai"), false);
	// (a key that was typed and not accepted was never kept: there is nothing to mark)
	reply = () => ({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } });
	assert.match(await w.a.saveKey("openai", KEY), /did not accept the API key/);
	assert.deepEqual([w.a.hasKey("openai"), w.a.wasRejected("openai")], [false, false]);

	// a key that is real but may not list models is kept: what it may not do is said
	reply = () => ({ status: 401, json: { error: { message: "You have insufficient permissions for this operation. Missing scopes: api.model.read.", type: "invalid_request_error", code: null } } });
	assert.equal(await w.a.saveKey("openai", KEY), "This OpenAI key is restricted and may not do this: You have insufficient permissions for this operation. Missing scopes: api.model.read.");
	assert.deepEqual([w.a.hasKey("openai"), w.a.wasRejected("openai"), w.a.listed("openai")], [true, false, 0]);

	// which of a provider's models take no pictures is kept with their names
	reply = () => fake.openAiModels([{ id: "kimi-k3", created: 100, supports_image_in: true }, { id: "moonshot-v1-8k", created: 300, supports_image_in: false }]);
	assert.equal(await w.a.saveKey("kimi", OTHER_KEY), undefined);
	assert.deepEqual(w.settings.modelCatalog["api:kimi"], [{ value: "kimi-k3", name: "kimi-k3" }, { value: "moonshot-v1-8k", name: "moonshot-v1-8k", images: false }]);
	assert.deepEqual(w.a.models("kimi")[1], { value: "moonshot-v1-8k", name: "moonshot-v1-8k", images: false });
});

test("the Settings page's other half for API keys: what it shows, one request at a time for a provider, and the keychain left alone until a key is saved or used", { timeout: 30000 }, async () => {
	let reply = () => fake.anthropicModels([{ id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
	const s = await api((r) => (r.method === "GET" && r.path.startsWith("/v1/models") ? reply(r) : undefined));
	const w = access({ anthropic: s.url, openai: `${s.url}/v1`, kimi: `${s.url}/v1` });
	const shown = [];
	const panel = new ApiKeysPanel(() => w.a, () => shown.push(panel.rows().find((r) => r.id === "anthropic")));
	const row = () => panel.rows().find((r) => r.id === "anthropic");

	// what the page gets of a provider: no key, and nothing a key could be made from
	assert.deepEqual(panel.rows(), [
		{ id: "anthropic", agent: "api:anthropic", label: "Anthropic API", company: "Anthropic", keyHint: "sk-ant-…", hasKey: false, loadingModels: false, rejected: false },
		{ id: "openai", agent: "api:openai", label: "OpenAI API", company: "OpenAI", keyHint: "sk-…", hasKey: false, loadingModels: false, rejected: false },
		{ id: "kimi", agent: "api:kimi", label: "Kimi API", company: "Kimi", keyHint: "sk-…", hasKey: false, loadingModels: false, rejected: false },
	]);
	// messages that are not about API keys are someone else's; one for a provider that does not exist does nothing
	assert.equal(panel.onMessage({ type: "ready" }), undefined);
	assert.equal(panel.onMessage(undefined), undefined);
	await panel.onMessage({ type: "setApiKey", provider: "nobody", key: KEY });
	assert.deepEqual([shown.length, s.requests.length], [0, 0]);

	// a key is being checked: the page is told, a second one for that provider is dropped, and so is Remove
	reply = () => ({ ...fake.anthropicModels([{ id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]), delay: 80 });
	const saving = panel.onMessage({ type: "setApiKey", provider: "anthropic", key: KEY });
	await until(() => shown.length === 1);
	assert.deepEqual([shown[0].loadingModels, shown[0].hasKey], [true, false]);
	await panel.onMessage({ type: "setApiKey", provider: "anthropic", key: OTHER_KEY });
	await panel.onMessage({ type: "removeApiKey", provider: "anthropic" });
	await panel.onMessage({ type: "refreshApiModels", provider: "anthropic" });
	await saving;
	assert.equal(s.requests.length, 1, "one request: the dropped ones asked nobody");
	assert.deepEqual([row().hasKey, row().loadingModels, row().error, await w.keys.get("anthropic")], [true, false, undefined, KEY]);
	assert.deepEqual(shown.map((r) => [r.loadingModels, r.hasKey]), [[true, false], [false, true]]);
	assert.doesNotMatch(JSON.stringify(shown) + JSON.stringify(panel.rows()), new RegExp(`${KEY}|${OTHER_KEY}`));

	// Refresh: while it asks, Remove is dropped (the key it asks with stays); what goes wrong is shown, and gone after the next try
	reply = () => ({ status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, delay: 60 });
	const refreshing = panel.onMessage({ type: "refreshApiModels", provider: "anthropic" });
	await wait(15);
	await panel.onMessage({ type: "removeApiKey", provider: "anthropic" });
	await refreshing;
	assert.deepEqual([row().hasKey, row().error, row().rejected], [true, "Anthropic is limiting requests for this key right now. Try again in a moment.", false]);
	// the provider no longer accepts the kept key: the page marks it
	reply = () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
	await panel.onMessage({ type: "refreshApiModels", provider: "anthropic" });
	assert.deepEqual([row().hasKey, row().rejected, row().error], [true, true, "Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys."]);
	reply = () => fake.anthropicModels([{ id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
	await panel.onMessage({ type: "refreshApiModels", provider: "anthropic" });
	assert.deepEqual([row().rejected, row().error], [false, undefined]);
	// Refresh without a key asks nobody
	const asked = s.requests.length;
	await panel.onMessage({ type: "refreshApiModels", provider: "kimi" });
	assert.equal(s.requests.length, asked);

	// what the pages show is known without the keychain: it is asked when a key is saved or used, not when Settings or the Creator's list opens
	w.state.asked = 0;
	panel.rows();
	apiCreatorAgents(w.a);
	w.a.hasKey("anthropic");
	w.a.models("anthropic");
	w.a.preferred("anthropic");
	w.a.wasRejected("anthropic");
	assert.equal(w.state.asked, 0);
	await w.a.keyFor(anthropicProvider);
	assert.ok(w.state.asked > 0);

	// removed: gone from the page, with what went wrong before
	reply = () => ({ status: 500, json: { type: "error", error: { type: "api_error", message: "Internal server error" } } });
	await panel.onMessage({ type: "refreshApiModels", provider: "anthropic" });
	assert.match(row().error, /^Anthropic answered with an error \(500\)/);
	await panel.onMessage({ type: "removeApiKey", provider: "anthropic" });
	assert.deepEqual(row(), { id: "anthropic", agent: "api:anthropic", label: "Anthropic API", company: "Anthropic", keyHint: "sk-ant-…", hasKey: false, loadingModels: false, rejected: false });
});

// ----- the Shape Creator, drawing through an API -----

/** The Workshop's other half with the providers' models behind the Shape Creator. */
function studio(w) {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-api-creator-test-"));
	const service = new GalleryService(data, async (url) => assert.fail(`no downloads: ${url}`));
	let configs = [];
	const posted = [];
	let settingsOpened = 0;
	const core = new WorkshopCore({
		post: (msg) => {
			posted.push(msg);
			// the page draws what it is asked to and gives the picture back
			if (msg.type === "rasterise") setImmediate(() => void core.onMessage({ type: "rasterised", reqId: msg.reqId, png: `data:image/png;base64,${PNG.base64}` }));
		},
		service: () => service,
		configs: () => configs,
		save: (next) => (configs = next),
		host: () => undefined,
		look: () => ({ iconStyle: "dots2d", matrix: "grey" }),
		version: () => "0.1.0",
		confirm: async () => true,
		pickLocal: async () => undefined,
		pickExport: async () => undefined,
		reveal: () => undefined,
		openExternal: () => undefined,
		creator: {
			agents: () => apiCreatorAgents(w.a),
			open: async (o) => {
				const session = await openApiCreator(w.a, o);
				if (!session) throw new Error("That agent is not known here.");
				return session;
			},
			settings: () => void settingsOpened++,
		},
	});
	const of = (type) => posted.filter((m) => m.type === type);
	return { core, posted, of, send: (msg) => core.onMessage(msg), settingsOpened: () => settingsOpened };
}

test("the Shape Creator with an API key: listed beside the agents, drawing with the two tools, stopped, changed, and closed when its key changes", { timeout: 30000 }, async () => {
	const script = [];
	const s = await api((r) => {
		if (r.method === "GET" && r.path.startsWith("/v1/models?")) return fake.anthropicModels([{ id: "claude-old", display_name: "Claude Old", created_at: "2024-02-01T00:00:00Z" }, { id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
		if (r.method === "GET" && r.path.startsWith("/v1/models/")) return { json: { type: "model", id: r.path.slice(11), display_name: "x", created_at: "2026-05-01T00:00:00Z", max_tokens: 64000 } };
		if (r.method === "POST" && r.path === "/v1/messages") return script.shift();
		return undefined;
	});
	const w = access({ anthropic: s.url, openai: `${s.url}/v1`, kimi: `${s.url}/v1` });
	const c = studio(w);
	await c.send({ type: "ready" });

	// without a key a provider is listed, and says what it needs; Settings is one click away
	await c.send({ type: "creatorAgents" });
	const listed = c.of("creatorAgents").pop();
	assert.equal(listed.settings, true);
	assert.deepEqual(listed.agents, [
		{ id: "api:anthropic", kind: "api", label: "Anthropic API", ready: false, problem: "Add your Anthropic API key in Settings → Agents & models → API keys to use it.", models: [] },
		{ id: "api:openai", kind: "api", label: "OpenAI API", ready: false, problem: "Add your OpenAI API key in Settings → Agents & models → API keys to use it.", models: [] },
		{ id: "api:kimi", kind: "api", label: "Kimi API", ready: false, problem: "Add your Kimi API key in Settings → Agents & models → API keys to use it.", models: [] },
	]);
	await c.send({ type: "creatorSettings" });
	assert.equal(c.settingsOpened(), 1);
	await assert.rejects(c.send({ type: "create", agent: "api:anthropic", prompt: "a key" }), /^Error: There is no Anthropic API key\. Add one in Settings → Agents & models → API keys\.$/);
	assert.deepEqual(c.of("creating").map((m) => [m.state, m.count ?? null]), [["starting", null], ["idle", 0]]);
	assert.equal(s.requests.length, 0);
	assert.equal(await openApiCreator(w.a, { agent: "claude", tools: { call: async () => ({ text: "" }) }, onText: () => undefined }), undefined, "an agent program is not a provider");

	// a key kept before its models could be listed (the provider could not be asked then): they are asked for when it first draws
	await w.keys.set("anthropic", KEY);
	assert.deepEqual(apiCreatorAgents(w.a)[0], { id: "api:anthropic", kind: "api", label: "Anthropic API", ready: true, models: [] });
	script.push(
		fake.anthropicAnswer([{ text: "Looking. " }, { tool: "workshop_render_preview", id: "toolu_1", input: { svg: ICON } }]),
		fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_2", input: { svg: ICON.replace("<path", "<script>alert(1)</script><path"), name: "Key", tags: ["Key", "lock"] } }]),
		fake.anthropicAnswer([{ text: "Done." }])
	);
	await c.send({ type: "create", agent: "api:anthropic", prompt: "a key", style: "solid", variations: 1, images: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
	assert.deepEqual(c.of("creating").slice(2).map((m) => [m.state, m.agent ?? null, m.count ?? null]), [["starting", "Anthropic API", null], ["working", "Anthropic API · Claude New", null], ["idle", null, 1]]);
	assert.equal(c.of("creatorText").map((m) => m.text).join(""), "Looking. Done.");
	// what it handed in is cleaned like every icon
	assert.deepEqual([c.of("created")[0].title, c.of("created")[0].tags, c.of("created")[0].svg], ["Key", ["key", "lock"], ICON]);
	const sent = s.posts("/v1/messages").map((r) => r.body);
	assert.equal(sent[0].model, "claude-new", "the first model the provider listed, when none was picked");
	assert.deepEqual(sent[0].tools.map((t) => t.name), ["workshop_submit_svg", "workshop_render_preview"]);
	assert.match(sent[0].system, /^You draw icons as SVG/);
	// only the description, the attached image, and what the tools answer go to the provider
	assert.equal(sent[0].messages[0].content[0].source.data, "AAAA");
	assert.match(sent[0].messages[0].content[1].text, /^You are drawing an icon for a diagram, as SVG\.\n\nWhat to draw: a key\n/);
	// it looked at its work: the picture the page drew went back to it
	assert.deepEqual(sent[1].messages[2].content[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.base64 } });
	assert.deepEqual(sent[2].messages[4].content[0].content, [{ type: "text", text: "Received “Key”. The user sees it now." }]);
	assert.doesNotMatch(JSON.stringify(c.posted) + JSON.stringify(w.settings), new RegExp(KEY), "the key is not told to the page or written to the settings");

	// now its models are known: the page lists them, the newest picked
	await c.send({ type: "creatorAgents" });
	assert.deepEqual(c.of("creatorAgents").pop().agents[0], { id: "api:anthropic", kind: "api", label: "Anthropic API", ready: true, models: [{ value: "claude-new", name: "Claude New" }, { value: "claude-old", name: "Claude Old" }], model: "claude-new" });
	assert.deepEqual(c.of("creatorAgents").pop().last, { agent: "api:anthropic" });

	// another model is another conversation, and the one picked is remembered
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_3", input: { svg: ICON, name: "Old key" } }]), fake.anthropicAnswer([{ text: "There." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "an old key" });
	assert.equal(s.posts("/v1/messages").pop().body.model, "claude-old");
	assert.equal(s.posts("/v1/messages").pop().body.messages.length, 3);
	assert.equal(w.a.preferred("anthropic"), "claude-old");
	assert.equal(apiCreatorAgents(w.a)[0].model, "claude-old");
	// a model that is not offered is not asked for: the one picked last is used
	script.push(fake.anthropicAnswer([{ text: "Not this time." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-gone", prompt: "anything" });
	assert.equal(s.posts("/v1/messages").pop().body.model, "claude-old");
	assert.equal(w.a.preferred("anthropic"), "claude-old");
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_3b", input: { svg: ICON, name: "Old key" } }]), fake.anthropicAnswer([{ text: "There." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "an old key" });
	const made = c.of("created").length;

	// a change: the same conversation gets the request and the icon as it is now
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_4", input: { svg: ICON, name: "Old key, thicker" } }]), fake.anthropicAnswer([{ text: "Thicker." }]));
	await c.send({ type: "revise", id: c.of("created").pop().id, text: "thicker lines", agent: "api:anthropic", model: "claude-old" });
	assert.equal(c.of("created").length, made + 1);
	const revised = s.posts("/v1/messages").pop().body.messages;
	assert.equal(revised.length, 7);
	assert.match(revised[4].content[0].text, /^Change the icon “Old key” like this: thicker lines\n\nThe icon as it is now/);

	// Stop while the model writes: it ends as stopped, and the next request is accepted
	script.push(fake.anthropicUnfinished("Thinking about"));
	const running = c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "a lock" });
	await until(() => c.of("creatorText").some((m) => m.text === "king about" || /about$/.test(m.text)));
	await c.send({ type: "stopCreating" });
	await running;
	assert.deepEqual([c.of("creating").pop().state, c.of("creating").pop().stop, c.of("notice").pop().message], ["idle", "cancelled", "Stopped."]);
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_5", input: { svg: ICON, name: "Lock" } }]), fake.anthropicAnswer([{ text: "A lock." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "a lock again" });
	assert.equal(c.of("created").pop().title, "Lock");
	assert.equal(s.posts("/v1/messages").slice(-2)[0].body.messages.length, 9, "the stopped request is not in the conversation");

	// declined, and out of room: said in words
	script.push(fake.anthropicAnswer([{ text: "I can't draw that." }], "refusal"));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "something else" });
	assert.equal(c.of("notice").pop().message, "Anthropic API · Claude Old declined this request.");
	script.push(fake.anthropicAnswer([{ text: "A very long" }], "max_tokens"));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "something long" });
	assert.equal(c.of("notice").pop().message, "Anthropic API · Claude Old ran out of room before it handed in an icon. Ask for something simpler, or choose another model.");
	// what the provider refuses is the page's error
	script.push({ status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } });
	await assert.rejects(c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "once more" }), /Anthropic is limiting requests for this key right now/);
	assert.equal(c.of("creating").pop().state, "idle");

	// the key is replaced in Settings: the conversation that used the old one is closed, and the page is told who can draw
	const lists = c.of("creatorAgents").length;
	await w.keys.set("anthropic", OTHER_KEY);
	c.core.creatorChanged((agent) => agent === "api:anthropic");
	assert.equal(c.of("creatorAgents").length, lists + 1);
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_6", input: { svg: ICON, name: "New key" } }]), fake.anthropicAnswer([{ text: "With the new key." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "a new key" });
	const fresh = s.posts("/v1/messages").pop();
	assert.equal(fresh.headers.authorization, `Bearer ${OTHER_KEY}`);
	assert.equal(fresh.body.messages.length, 3, "a new conversation");
	// (another provider's key is not this one's business: the conversation stays open)
	c.core.creatorChanged((agent) => agent === "api:kimi");
	script.push(fake.anthropicAnswer([{ text: "Still here." }]));
	await c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "anything" });
	assert.equal(s.posts("/v1/messages").pop().body.messages.length, 5);

	// the key is removed while the model writes: the request ends as stopped
	script.push(fake.anthropicUnfinished("Thinking again"));
	const cut = c.send({ type: "create", agent: "api:anthropic", model: "claude-old", prompt: "a door" });
	await until(() => /again$/.test(c.of("creatorText").pop().text));
	w.a.removeKey("anthropic");
	c.core.creatorChanged((agent) => agent === "api:anthropic");
	await cut;
	assert.deepEqual([c.of("creating").pop().state, c.of("creating").pop().stop], ["idle", "cancelled"]);
	assert.equal(c.of("creatorAgents").pop().agents[0].ready, false);
	await assert.rejects(c.send({ type: "create", agent: "api:anthropic", prompt: "a door" }), /There is no Anthropic API key/);
	c.core.pageGone();
});

test("the Shape Creator with an API key: OpenAI and Kimi draw through the same two tools", { timeout: 30000 }, async () => {
	const responses = [];
	const completions = [];
	const s = await api((r) => {
		if (r.method === "GET" && r.path === "/v1/models") return fake.openAiModels(r.headers.authorization === `Bearer ${KEY}` ? [{ id: "gpt-6.2-astra", created: 300 }] : [{ id: "kimi-k3.1-pro", created: 200, supports_image_in: true }]);
		if (r.method === "POST" && r.path === "/v1/responses") return responses.shift();
		if (r.method === "POST" && r.path === "/v1/chat/completions") return completions.shift();
		return undefined;
	});
	const w = access({ openai: `${s.url}/v1`, kimi: `${s.url}/v1` });
	assert.equal(await w.a.saveKey("openai", KEY), undefined);
	assert.equal(await w.a.saveKey("kimi", OTHER_KEY), undefined);
	const c = studio(w);
	await c.send({ type: "ready" });
	assert.deepEqual(apiCreatorAgents(w.a).map((a) => [a.id, a.ready, a.model ?? null]), [["api:anthropic", false, null], ["api:openai", true, "gpt-6.2-astra"], ["api:kimi", true, "kimi-k3.1-pro"]]);

	responses.push(fake.responsesAnswer("resp_1", [{ call: "workshop_render_preview", id: "call_1", arguments: { svg: ICON } }]), fake.responsesAnswer("resp_2", [{ call: "workshop_submit_svg", id: "call_2", arguments: { svg: ICON, name: "Astra's key" } }]), fake.responsesAnswer("resp_3", [{ text: "Done." }]));
	await c.send({ type: "create", agent: "api:openai", model: "gpt-6.2-astra", prompt: "a key" });
	assert.equal(c.of("created").pop().title, "Astra's key");
	assert.equal(c.of("creating").find((m) => m.state === "working").agent, "OpenAI API · gpt-6.2-astra");
	const o = s.posts("/v1/responses");
	assert.equal(o[1].body.input[1].content[1].image_url, `data:image/png;base64,${PNG.base64}`, "the picture the page drew went back to the model");
	assert.equal(o[0].headers.authorization, `Bearer ${KEY}`);

	completions.push(fake.completionsAnswer({ calls: [{ id: "call_1", name: "workshop_submit_svg", arguments: { svg: ICON, name: "Kimi's key" } }] }), fake.completionsAnswer({ text: "Done." }));
	await c.send({ type: "create", agent: "api:kimi", model: "kimi-k3.1-pro", prompt: "a key" });
	assert.equal(c.of("created").pop().title, "Kimi's key");
	assert.equal(s.posts("/v1/chat/completions")[0].headers.authorization, `Bearer ${OTHER_KEY}`, "each provider gets its own key");
	assert.doesNotMatch(JSON.stringify(c.posted) + JSON.stringify(w.settings), new RegExp(`${KEY}|${OTHER_KEY}`));
	c.core.pageGone();
});

test("the Shape Creator with an API key: the rules are said again after a request was stopped, a model that takes no pictures, every model switched off, a key replaced while the model starts", { timeout: 30000 }, async () => {
	const script = [];
	const completions = [];
	let models = () => fake.anthropicModels([{ id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
	const s = await api((r) => {
		if (r.method === "GET" && r.path.startsWith("/v1/models?")) return models(r);
		if (r.method === "GET" && r.path === "/v1/models") return fake.openAiModels([{ id: "kimi-k3", created: 100, supports_image_in: true }, { id: "moonshot-v1-32k", created: 300, supports_image_in: false }]);
		if (r.method === "GET" && r.path.startsWith("/v1/models/")) return { json: { type: "model", id: r.path.slice(11), display_name: "x", created_at: "2026-05-01T00:00:00Z", max_tokens: 64000 } };
		if (r.method === "POST" && r.path === "/v1/messages") return script.shift();
		if (r.method === "POST" && r.path === "/v1/chat/completions") return completions.shift();
		return undefined;
	});
	const w = access({ anthropic: s.url, kimi: `${s.url}/v1` });
	assert.equal(await w.a.saveKey("anthropic", KEY), undefined);
	const c = studio(w);
	await c.send({ type: "ready" });
	const text = (request) => request.body.messages.filter((m) => m.role === "user").pop().content.find((b) => b.type === "text").text;

	// one icon is handed in, then the request is stopped while the model writes on
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_1", input: { svg: ICON, name: "Key" } }]), fake.anthropicUnfinished("And another one"));
	const running = c.send({ type: "create", agent: "api:anthropic", model: "claude-new", prompt: "a key", variations: 3 });
	await until(() => c.of("creatorText").some((m) => /one$/.test(m.text)));
	await c.send({ type: "stopCreating" });
	await running;
	assert.deepEqual([c.of("created").length, c.of("creating").pop().stop], [1, "cancelled"]);
	// a change to the icon that was kept: the conversation forgot the stopped request, so the rules are said again
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_2", input: { svg: ICON, name: "Key, thicker" } }]), fake.anthropicAnswer([{ text: "Thicker." }]));
	await c.send({ type: "revise", id: c.of("created")[0].id, text: "thicker lines", agent: "api:anthropic", model: "claude-new" });
	const again = s.posts("/v1/messages").slice(-2)[0];
	assert.equal(again.body.messages.length, 1);
	assert.match(text(again), /^Change the icon “Key” like this: thicker lines\n\nThe icon as it is now/);
	assert.match(text(again), /\n\nRules for the SVG:\n- /);
	// the next change goes to a conversation that has them: they are not said twice
	script.push(fake.anthropicAnswer([{ tool: "workshop_submit_svg", id: "toolu_3", input: { svg: ICON, name: "Key, rounder" } }]), fake.anthropicAnswer([{ text: "Rounder." }]));
	await c.send({ type: "revise", id: c.of("created").pop().id, text: "rounder", agent: "api:anthropic", model: "claude-new" });
	assert.doesNotMatch(text(s.posts("/v1/messages").slice(-2)[0]), /Rules for the SVG:/);
	// ... and after a request that failed, they are
	script.push({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
	script.push({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "something this app got wrong" } } });
	await assert.rejects(c.send({ type: "revise", id: c.of("created").pop().id, text: "squarer", agent: "api:anthropic", model: "claude-new" }), /answered with an error \(529\): Overloaded/);
	await assert.rejects(c.send({ type: "revise", id: c.of("created").pop().id, text: "squarer", agent: "api:anthropic", model: "claude-new" }), /answered with an error \(400\)/);
	script.push(fake.anthropicAnswer([{ text: "Squarer." }]));
	await c.send({ type: "revise", id: c.of("created").pop().id, text: "squarer", agent: "api:anthropic", model: "claude-new" });
	assert.match(text(s.posts("/v1/messages").pop()), /Rules for the SVG:/);

	// every model of the provider switched off in Settings: said so, and the provider is not asked again
	w.settings.models = { ...w.settings.models, "api:anthropic": { hidden: ["claude-new"] } };
	const asked = s.requests.length;
	assert.deepEqual(apiCreatorAgents(w.a)[0], { id: "api:anthropic", kind: "api", label: "Anthropic API", ready: true, models: [] });
	await assert.rejects(c.send({ type: "create", agent: "api:anthropic", prompt: "a key" }), /^Error: Every Anthropic model is switched off in Settings → Agents & models → API keys\. Switch one on to use it\.$/);
	assert.equal(s.requests.length, asked);
	w.settings.models = {};

	// a model the provider says takes no pictures: it gets the description only, the user is told, and a preview is words
	assert.equal(await w.a.saveKey("kimi", OTHER_KEY), undefined);
	assert.deepEqual(apiCreatorAgents(w.a)[2].models, [{ value: "kimi-k3", name: "kimi-k3" }, { value: "moonshot-v1-32k", name: "moonshot-v1-32k" }]);
	completions.push(fake.completionsAnswer({ calls: [{ id: "call_1", name: "workshop_render_preview", arguments: { svg: ICON } }] }), fake.completionsAnswer({ calls: [{ id: "call_2", name: "workshop_submit_svg", arguments: { svg: ICON, name: "Drawn blind" } }] }), fake.completionsAnswer({ text: "Done." }));
	await c.send({ type: "create", agent: "api:kimi", model: "moonshot-v1-32k", prompt: "a key", images: [{ mimeType: "image/png", base64: "AAAA" }] });
	assert.equal(c.of("created").pop().title, "Drawn blind");
	assert.equal(c.of("notice").pop().message, "Kimi API · moonshot-v1-32k does not take images here: it got the description only.");
	const blind = s.posts("/v1/chat/completions").pop().body.messages;
	assert.equal(typeof blind[1].content, "string");
	assert.doesNotMatch(blind[1].content, /attached image/);
	assert.equal(blind[3].content, "This is how the SVG looks (on white, enlarged). It is shown at 16 to 64 pixels in a diagram. (This model takes no pictures, so the picture is not shown to it.)");
	assert.equal(JSON.stringify(blind).includes("image_url"), false);
	// (the one that sees gets the picture)
	completions.push(fake.completionsAnswer({ calls: [{ id: "call_3", name: "workshop_render_preview", arguments: { svg: ICON } }] }), fake.completionsAnswer({ text: "Looked." }));
	await c.send({ type: "create", agent: "api:kimi", model: "kimi-k3", prompt: "a key", images: [{ mimeType: "image/png", base64: "AAAA" }] });
	assert.equal(JSON.stringify(s.posts("/v1/chat/completions").pop().body.messages).split("image_url").length - 1, 4);

	// the key is replaced while the model starts (its models are still being asked for with the old one):
	// the request goes out with the key that is kept now, and with that key's models
	w.a.removeKey("anthropic");
	await w.keys.set("anthropic", KEY);
	models = (r) => ({ ...fake.anthropicModels([{ id: r.headers.authorization === `Bearer ${KEY}` ? "claude-of-the-old-key" : "claude-of-the-new-key", display_name: "Claude", created_at: "2026-05-01T00:00:00Z" }]), delay: 60 });
	script.push(fake.anthropicAnswer([{ text: "With the new key." }]));
	const starting = c.send({ type: "create", agent: "api:anthropic", prompt: "a key" });
	await wait(20);
	await w.keys.set("anthropic", OTHER_KEY);
	await starting;
	const sent = s.posts("/v1/messages").pop();
	assert.deepEqual([sent.headers.authorization, sent.body.model], [`Bearer ${OTHER_KEY}`, "claude-of-the-new-key"]);
	// a key the provider does not accept while drawing is remembered as such, for Settings to show
	script.push({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
	assert.equal(w.a.wasRejected("anthropic"), false);
	await assert.rejects(c.send({ type: "create", agent: "api:anthropic", prompt: "a key" }), /Anthropic did not accept the API key/);
	assert.equal(w.a.wasRejected("anthropic"), true);
	c.core.pageGone();
});
