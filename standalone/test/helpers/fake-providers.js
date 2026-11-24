// Local stand-ins for the providers' APIs (Anthropic's Messages API, OpenAI's Responses API,
// Kimi's chat completions), for tests: a server on 127.0.0.1 that records what it is sent and
// answers what a test scripts. Like the real ones, it refuses a conversation that is not whole
// (an answer without content, a tool call without its answer) with a 400. Nothing here reaches
// a provider, and no key is a real one.
const http = require("http");

// ----- what the real APIs refuse -----

/** Why Anthropic would refuse these messages, or undefined. */
function anthropicProblem(body) {
	const messages = body?.messages;
	if (!Array.isArray(messages) || !messages.length) return "messages: at least one message is required";
	if (messages[0].role !== "user") return "messages: first message must use the user role";
	for (let i = 0; i < messages.length; i++) {
		const content = messages[i].content;
		if (typeof content === "string" ? !content : !Array.isArray(content) || !content.length) return `messages.${i}: all messages must have non-empty content`;
		if (Array.isArray(content) && content.some((b) => b.type === "text" && !String(b.text ?? "").trim())) return `messages.${i}: text content blocks must contain non-whitespace text`;
		const asked = messages[i].role === "assistant" && Array.isArray(content) ? content.filter((b) => b.type === "tool_use").map((b) => b.id) : [];
		const next = messages[i + 1];
		const answered = next && next.role === "user" && Array.isArray(next.content) ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
		if (asked.length && (asked.length !== answered.length || asked.some((id) => !answered.includes(id)))) return `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${asked.join(", ")}`;
		const results = messages[i].role === "user" && Array.isArray(content) ? content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
		const before = messages[i - 1];
		const calls = before && before.role === "assistant" && Array.isArray(before.content) ? before.content.filter((b) => b.type === "tool_use").map((b) => b.id) : [];
		if (results.some((id) => !calls.includes(id))) return `messages.${i}: unexpected tool_use_id found in tool_result blocks`;
	}
	return undefined;
}

/** Why a chat-completions API would refuse these messages, or undefined. */
function completionsProblem(body) {
	const messages = body?.messages;
	if (!Array.isArray(messages) || !messages.length) return "messages must not be empty";
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "assistant" && !m.content && !(m.tool_calls && m.tool_calls.length)) return `messages[${i}]: an assistant message must have content or tool_calls`;
		if (m.role === "assistant" && m.tool_calls) {
			for (const [n, call] of m.tool_calls.entries()) {
				const answer = messages[i + 1 + n];
				if (!answer || answer.role !== "tool" || answer.tool_call_id !== call.id) return `messages[${i}]: an assistant message with tool_calls must be followed by tool messages responding to each tool_call_id (${call.id})`;
			}
		}
		if (m.role === "tool") {
			let j = i - 1;
			while (j >= 0 && messages[j].role === "tool") j--;
			if (j < 0 || messages[j].role !== "assistant" || !(messages[j].tool_calls ?? []).some((c) => c.id === m.tool_call_id)) return `messages[${i}]: a tool message must follow the assistant message that called it`;
		}
	}
	if (messages[messages.length - 1].role === "assistant") return "the last message must not be from the assistant";
	return undefined;
}

/**
 * Starts a server. `answer(request, n)` gets each request ({ method, path, headers, body }, and
 * how many came before it) and returns { status?, headers?, json } or { sse: [{ event?, data }],
 * hold? } (`hold` leaves the stream open after the events, as a model that is still writing
 * does, until the client goes away).
 */
async function fakeApi(answer) {
	const requests = [];
	const open = new Set();
	// (the Responses API keeps each answer: the tool calls of one must be answered by the request that goes on from it)
	const kept = new Map();
	const refuse = (request) => {
		const path = request.path.split("?")[0];
		if (request.method !== "POST") return undefined;
		if (path.endsWith("/v1/messages")) {
			const why = anthropicProblem(request.body);
			return why && { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: why } } };
		}
		if (path.endsWith("/chat/completions")) {
			const why = completionsProblem(request.body);
			return why && { status: 400, json: { error: { message: why, type: "invalid_request_error", code: null, param: null } } };
		}
		if (path.endsWith("/responses")) {
			const input = Array.isArray(request.body?.input) ? request.body.input : [];
			const answered = input.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
			const previous = request.body?.previous_response_id;
			const waiting = previous ? kept.get(previous) : [];
			const why = previous && !waiting ? `Previous response with id '${previous}' not found.` : waiting.some((id) => !answered.includes(id)) ? `No tool output found for function call ${waiting.find((id) => !answered.includes(id))}.` : answered.some((id) => !waiting.includes(id)) ? `No tool call found for function call output with call_id ${answered.find((id) => !waiting.includes(id))}.` : undefined;
			return why && { status: 400, json: { error: { message: why, type: "invalid_request_error", code: null, param: "input" } } };
		}
		return undefined;
	};
	const server = http.createServer((req, res) => {
		let current = {};
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = text;
			}
			const request = { method: req.method, path: req.url, headers: req.headers, body };
			current = request;
			requests.push(request);
			let reply = refuse(request);
			if (reply) request.refused = (reply.json.error.message ?? reply.json.error).toString();
			else {
				try {
					reply = answer(request, requests.length - 1);
				} catch (e) {
					reply = { status: 500, json: { error: { message: `the test's script failed: ${e.message}` } } };
				}
			}
			reply ??= { status: 404, json: { error: { type: "not_found_error", message: "nothing scripted for this" } } };
			if (reply.keeps) kept.set(reply.keeps.id, reply.keeps.calls);
			// (`delay`: a provider that takes its time)
			if (reply.delay) return void setTimeout(() => respond(reply), reply.delay);
			respond(reply);
		});
		const respond = (reply) => {
			if (res.destroyed) return;
			if (reply.sse) {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...(reply.headers ?? {}) });
				// (`comment`: a line that is not an event, as some providers send to keep the connection open)
				for (const e of reply.sse) res.write(e.comment ? `: ${e.comment}\n\n` : `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
				if (reply.hold) {
					open.add(res);
					res.on("close", () => open.delete(res));
					req.socket.on("close", () => (current.dropped = true));
				} else res.end();
				return;
			}
			// (the SDKs try again after some failures: a test that wants one request says so)
			res.writeHead(reply.status ?? 200, { "content-type": "application/json", "x-should-retry": "false", ...(reply.headers ?? {}) });
			// (`text`: an answer that is not JSON, as it is)
			res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
		};
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}`;
	return {
		url,
		requests,
		posts: (path) => requests.filter((r) => r.method === "POST" && r.path.split("?")[0].endsWith(path)),
		close: async () => {
			for (const res of open) res.destroy();
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const pieces = (text) => (text.length > 1 ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))] : [text]);

// ----- Anthropic: the Messages API's stream -----

/**
 * The events of one answer. `blocks`: { text } or { tool: name, id, input } (or `partial`: the
 * tool's arguments as far as they got, for an answer cut off by the length limit).
 */
function anthropicAnswer(blocks, stop = blocks.some((b) => b.tool) ? "tool_use" : "end_turn") {
	const events = [{ event: "message_start", data: { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } }];
	blocks.forEach((b, index) => {
		if (b.tool) {
			events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.tool, input: {} } } });
			for (const partial_json of pieces(b.partial ?? JSON.stringify(b.input))) events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } } });
		} else {
			events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
			for (const text of pieces(b.text)) events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
		}
		events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
	});
	events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } } });
	events.push({ event: "message_stop", data: { type: "message_stop" } });
	return { sse: events };
}

/** An answer that says `text` and then stays open, as a model that is still writing does. */
function anthropicUnfinished(text) {
	return { sse: anthropicAnswer([{ text }]).sse.slice(0, 2 + pieces(text).length), hold: true };
}

const anthropicModels = (models) => ({ json: { data: models.map((m) => ({ type: "model", lifecycle: "active", max_tokens: 64000, ...m })), has_more: false, first_id: models[0]?.id ?? null, last_id: models[models.length - 1]?.id ?? null } });

// ----- OpenAI: the Responses API's stream -----

/** The events of one answer. `output`: { text }, { refusal } or { call: name, id, arguments }. */
function responsesAnswer(id, output, status = "completed") {
	const items = output.map((o, i) =>
		o.call
			? { type: "function_call", id: `fc_${i}`, call_id: o.id, name: o.call, arguments: typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments), status: "completed" }
			: { type: "message", id: `msg_${i}`, role: "assistant", status: "completed", content: [o.refusal ? { type: "refusal", refusal: o.refusal } : { type: "output_text", text: o.text, annotations: [] }] }
	);
	const events = [{ event: "response.created", data: { type: "response.created", sequence_number: 0, response: { id, object: "response", status: "in_progress", output: [] } } }];
	output.forEach((o, i) => {
		if (o.text) for (const delta of pieces(o.text)) events.push({ event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: events.length, item_id: `msg_${i}`, output_index: i, content_index: 0, delta } });
	});
	const type = status === "completed" ? "response.completed" : status === "failed" ? "response.failed" : "response.incomplete";
	events.push({ event: type, data: { type, sequence_number: events.length, response: { id, object: "response", status, output: items, ...(status === "failed" ? { error: { code: "server_error", message: "the model broke down" } } : {}), ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } } });
	// (a failed answer is not one that can be gone on from)
	return { sse: events, ...(status === "failed" ? {} : { keeps: { id, calls: output.filter((o) => o.call).map((o) => o.id) } }) };
}

function responsesUnfinished(id, text) {
	return { sse: responsesAnswer(id, [{ text }]).sse.slice(0, 1 + pieces(text).length), hold: true };
}

const openAiModels = (models) => ({ json: { object: "list", data: models.map((m) => ({ object: "model", owned_by: "fake", ...m })) } });

// ----- Kimi: chat completions' stream -----

/**
 * The chunks of one answer: `reasoning` and `text` as the model wrote them, `calls`
 * ({ id, name, arguments }) in pieces as they arrive, then why it ended. For the providers
 * that do it differently: `details` (the model's reasoning as a list of parts, one list per
 * chunk), `whole` (each call in one chunk, without a position; `more` on a call is what the
 * provider adds to it), `usage` (a last chunk that repeats why it ended), `comments` (lines
 * that are not events), `error` (what went wrong, said in the middle of the answer).
 */
function completionsAnswer({ reasoning, details = [], text, calls = [], finish = calls.length ? "tool_calls" : "stop", whole = false, usage = false, comments = false, error }) {
	const chunk = (delta, finish_reason = null) => ({ data: { id: "cmpl_fake", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason }] } });
	const events = [chunk({ role: "assistant", content: "" })];
	if (comments) events.unshift({ comment: "PROCESSING" });
	if (reasoning) for (const reasoning_content of pieces(reasoning)) events.push(chunk({ reasoning_content }));
	for (const reasoning_details of details) events.push(chunk({ reasoning_details }));
	if (comments) events.push({ comment: "PROCESSING" });
	if (text) for (const content of pieces(text)) events.push(chunk({ content }));
	calls.forEach((c, index) => {
		const args = typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments);
		if (whole) return void events.push(chunk({ tool_calls: [{ ...(c.id === undefined ? {} : { id: c.id }), type: "function", function: { name: c.name, arguments: args }, ...(c.more ?? {}) }] }));
		const [first, ...rest] = pieces(args);
		events.push(chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: first }, ...(c.more ?? {}) }] }));
		for (const more of rest) events.push(chunk({ tool_calls: [{ index, function: { arguments: more } }] }));
	});
	if (error) return { sse: [...events, { data: { id: "cmpl_fake", error: { code: 502, message: error }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] } }, { data: "[DONE]" }] };
	events.push(chunk({}, finish));
	if (usage) events.push({ data: { id: "cmpl_fake", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { content: "" }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });
	events.push({ data: "[DONE]" });
	return { sse: events };
}

function completionsUnfinished(text) {
	return { sse: completionsAnswer({ text }).sse.slice(0, 1 + pieces(text).length), hold: true };
}

module.exports = { fakeApi, anthropicAnswer, anthropicUnfinished, anthropicModels, responsesAnswer, responsesUnfinished, openAiModels, completionsAnswer, completionsUnfinished };
