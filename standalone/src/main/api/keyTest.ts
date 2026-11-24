import type { ApiAccess } from "./access";
import { ApiError, type ApiProviderId, type ApiTool } from "./chat";

/** The tool the model is asked to call: one that reads, takes no arguments and is always offered. */
export const TEST_TOOL = "drawio_lint";

/** What the model is asked. It is a check, and says so: nothing it answers is acted on. */
export const TEST_REQUEST = `This is a connection check, not a task. Call the tool ${TEST_TOOL} once, with no arguments, and then reply with the single word OK.`;

export type KeyTestResult = { ok: true; said: string } | { ok: false; problem: string };

/**
 * Sends one short request through a provider the way the chat does, on the user's say: the
 * key, a model, the chat's own tools with their real descriptions, one tool call and its
 * answer. Listing the models (which keeping a key does) proves the key; this proves that the
 * provider takes a request shaped as the chat shapes it. It costs a little of the user's
 * credit, which is why nothing does it by itself. No tool is run: the one call is answered
 * with a fixed line, and the diagram is not touched.
 */
export async function testKey(access: ApiAccess, id: ApiProviderId, tools: ApiTool[], ms = 60_000): Promise<KeyTestResult> {
	const provider = access.provider(id);
	if (!provider) return { ok: false, problem: "That provider is not known here." };
	if (!access.hasKey(id)) return { ok: false, problem: `There is no ${provider.company} key to test.` };
	if (!access.listed(id)) {
		const failed = await access.load(id);
		if (failed) return { ok: false, problem: failed.problem };
	}
	const models = access.models(id);
	const model = models.find((m) => m.value === access.preferred(id)) ?? models[0];
	if (!model) return { ok: false, problem: `Every ${provider.company} model is switched off below. Switch one on to test with it.` };
	const kept = await access.keyFor(provider);
	if ("problem" in kept) return { ok: false, problem: kept.problem };

	const offered = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	const called: string[] = [];
	let said = "";
	const late = AbortSignal.timeout(ms);
	// (one tool call and its answer, no more: a model that goes on calling tools is stopped at its
	// second call, before the provider's own loop makes a paid request of each)
	const enough = new AbortController();
	const signal = AbortSignal.any([late, enough.signal]);
	try {
		const chat = provider.chat({
			apiKey: kept.key,
			model: model.value,
			system: "You are being checked for a working connection. Do exactly what the request says and nothing else.",
			tools: offered,
			callTool: async (name) => {
				called.push(name);
				if (called.length > 1) {
					enough.abort();
					return { text: "The check is over: no further tool is answered.", isError: true };
				}
				return { text: "No problems found." };
			},
			onText: (text) => void (said += text),
			images: model.images !== false,
			baseURL: access.baseURL(id),
		});
		const stop = await chat.send(TEST_REQUEST, [], signal);
		access.noteRejected(id, false);
		if (enough.signal.aborted) return { ok: false, problem: `${model.name} took the request and called ${called[0]}, but then went on calling tools (${called[1]}) where it was asked to answer. The test was stopped there.` };
		if (stop === "cancelled") return { ok: false, problem: `${provider.company} did not answer in time. Try again.` };
		if (stop === "refusal") return { ok: false, problem: `${model.name} declined the test request.` };
		const tool = called.length ? `called ${called[0]}` : "did not call the tool it was asked to (it may not use tools well)";
		const answer = said.replace(/\s+/g, " ").trim().slice(0, 60);
		return called.length
			? { ok: true, said: `Works: ${model.name} took the chat's ${offered.length} tools, ${tool}${answer ? `, and answered "${answer}"` : ""}.` }
			: { ok: false, problem: `${model.name} answered${answer ? ` "${answer}"` : ""} but ${tool}.` };
	} catch (e: any) {
		if (enough.signal.aborted) return { ok: false, problem: `${model.name} went on calling tools (${called.slice(0, 2).join(", ")}) where it was asked to answer. The test was stopped there.` };
		if (late.aborted) return { ok: false, problem: `${provider.company} did not answer in time. Try again.` };
		if (e instanceof ApiError && e.badKey) access.noteRejected(id);
		return { ok: false, problem: String(e?.message ?? e).split("\n")[0].slice(0, 400) };
	}
}
