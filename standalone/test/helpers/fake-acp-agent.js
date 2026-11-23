// A stand-in coding agent for tests: it speaks the Agent Client Protocol on stdio (JSON-RPC,
// one message per line) and uses the tool endpoint it is given over HTTP, as a real agent
// does. It reaches nothing else. What it does on a prompt is written in the prompt itself,
// as JSON after "STEPS:", so that one script can play every part a test needs:
//   { "say": "text" }                              says it
//   { "tools": true }                              says the names of the tools on offer
//   { "permission": { title, kind, rawInput, options? } }   asks for permission, says the answer
//   { "call": { name, arguments } }                calls a tool, says what came back
//   { "cwd": true }                                says what is in the folder it was started in
//   { "wait": ms }                                 waits (a cancel ends it)
//   { "exit": code }                               ends its process, mid-request
// It also says which model it was switched to, and how many images came with the prompt.
const fs = require("fs");
const readline = require("readline");

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const pending = new Map();
let nextId = 5000;
const ask = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		send({ id, method, params });
	});

const sessionId = "fake-session-1";
let mcp;
let model = "small";
let cancelled = false;
const say = (text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

async function tool(method, params) {
	const r = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", authorization: mcp.authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
	const body = await r.json();
	return body.result ?? { error: body.error, status: r.status };
}

const OPTIONS = [
	{ optionId: "always", name: "Always allow", kind: "allow_always" },
	{ optionId: "once", name: "Allow", kind: "allow_once" },
	{ optionId: "no", name: "Reject", kind: "reject_once" },
];

async function prompt(blocks) {
	cancelled = false;
	const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
	const images = blocks.filter((b) => b.type === "image").length;
	say(`[model ${model}] [images ${images}] `);
	const at = text.indexOf("STEPS:");
	const steps = at < 0 ? [] : JSON.parse(text.slice(at + 6));
	for (const step of steps) {
		if (cancelled) return "cancelled";
		if (step.say) say(step.say);
		if (step.tools) say(`[tools ${(await tool("tools/list", {})).tools.map((t) => t.name).join(",")}] `);
		if (step.cwd) say(`[cwd ${fs.readdirSync(process.cwd()).length} entries] `);
		if (step.permission) {
			const { options, ...toolCall } = step.permission;
			const r = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: `t${nextId}`, status: "pending", ...toolCall }, options: options ?? OPTIONS });
			say(`[permission ${r?.outcome?.outcome === "selected" ? r.outcome.optionId : r?.outcome?.outcome}] `);
		}
		if (step.call) {
			const r = await tool("tools/call", step.call);
			const parts = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `<${c.type} ${c.mimeType}>`)).join(" ");
			say(`[call ${r.isError || r.error ? "error" : "ok"}: ${parts || (r.error ? r.error.message : JSON.stringify(r))}] `);
		}
		if (step.exit !== undefined) process.exit(step.exit);
		// (a wait ends early when the request is cancelled, as an agent's work does)
		for (let waited = 0; step.wait && waited < step.wait && !cancelled; waited += 20) await new Promise((done) => setTimeout(done, 20));
	}
	return cancelled ? "cancelled" : "end_turn";
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.method === undefined) {
		const done = pending.get(msg.id);
		pending.delete(msg.id);
		if (done) done(msg.result ?? { error: msg.error });
		return;
	}
	const answer = (result) => msg.id !== undefined && send({ id: msg.id, result });
	try {
		switch (msg.method) {
			case "initialize":
				return answer({
					protocolVersion: msg.params.protocolVersion,
					agentCapabilities: { promptCapabilities: { image: process.env.FAKE_AGENT_NO_IMAGES ? false : true }, mcpCapabilities: { http: true } },
					agentInfo: { name: "fake-agent", title: "Fake agent", version: "1.0.0" },
					authMethods: [],
				});
			case "session/new": {
				const server = msg.params.mcpServers[0];
				mcp = server ? { url: server.url, authorization: server.headers[0].value } : undefined;
				return answer({
					sessionId,
					configOptions: [
						{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
					],
				});
			}
			case "session/set_config_option":
				if (process.env.FAKE_AGENT_EXIT_ON_MODEL) process.exit(4);
				model = msg.params.value;
				return answer({ configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }] });
			case "session/prompt":
				return answer({ stopReason: await prompt(msg.params.prompt) });
			case "session/cancel":
				cancelled = true;
				return;
			default:
				if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
		}
	} catch (e) {
		if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(e && e.message ? e.message : e) } });
	}
});
