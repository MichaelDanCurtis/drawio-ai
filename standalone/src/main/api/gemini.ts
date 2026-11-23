import { ApiError, providerSaid, quoted, type ApiModel, type ApiProvider } from "./chat";
import { completionsChat, type CompletionsDialect } from "./completions";

/**
 * Gemini through Google's API, at its address for OpenAI's chat-completions protocol
 * (completions.ts): Google's own guide uses the OpenAI SDK there. What is particular to it:
 *
 * - With a tool call the model sends a signature of its thinking (on the call, under
 *   `extra_content`), and refuses to go on unless the call comes back with it. completions.ts
 *   keeps whatever a provider puts on a call and sends it back.
 * - Its tool calls arrive whole, without a position, and its answer ends as "stop" also when
 *   it calls tools.
 * - What went wrong comes as a list with the error in it, which the SDK cannot read: the list
 *   is opened before the SDK sees it.
 * - A tool's arguments are described in a part of JSON Schema only.
 * - The list of models comes from Google's own address, where it says which models hold a
 *   conversation. The key goes in a header there, never in the address.
 */
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** An answer that says what went wrong as `[{ error }]` is given the SDK as `{ error }`. */
const opened: typeof globalThis.fetch = async (input, init) => {
	const answer = await globalThis.fetch(input, init);
	if (answer.ok) return answer;
	const text = await answer.text();
	let body = text;
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object" && parsed[0].error) body = JSON.stringify(parsed[0]);
	} catch {
		// as it came
	}
	return new Response(body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
};

/** The parts of JSON Schema Gemini takes for a tool's arguments. */
const SCHEMA = ["type", "description", "properties", "required", "items", "enum", "format", "nullable", "minimum", "maximum", "minItems", "maxItems"];
export function geminiSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(schema)) {
		if (!SCHEMA.includes(name)) continue;
		if (name === "properties" && value && typeof value === "object") out[name] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, geminiSchema(v)]));
		else if (name === "items") out[name] = geminiSchema(value);
		else out[name] = value;
	}
	return out;
}

/** What Google says when it does not accept the key (with "bad request", not "unauthorised"). */
const NOT_A_KEY = /api key not valid|API_KEY_INVALID|api key expired|API_KEY_EXPIRED/i;

function explain(e: unknown, apiKey: string): Error | undefined {
	const status = (e as { status?: unknown })?.status;
	const said = quoted(providerSaid(e), apiKey);
	if (status === 400 && NOT_A_KEY.test(`${said} ${JSON.stringify((e as { error?: unknown })?.error ?? "")}`)) return new ApiError("Gemini did not accept the API key. Check it in Settings → Agents & models → API keys.", true);
	if (status === 402) return new ApiError(`This Gemini key has no credit left: ${said}`);
	if (status === 403) return new ApiError(`Gemini refused this key (it may be blocked, or may not use this API): ${said}`);
	// (Google's sentence for "too many requests" speaks of a quota: that is not taken for an empty account)
	if (status === 429) return new ApiError(`Gemini is limiting requests for this key right now, or it has used up what it may: ${said}`);
	return undefined;
}

const GEMINI: CompletionsDialect = { who: "Gemini", base: GEMINI_BASE, explain, schema: geminiSchema, fetch: opened };

/** Models that are not for a conversation with tools (pictures, speech, embeddings, robots…). */
const NOT_CHAT = /image|tts|live|transcribe|embedding|omni|nano-banana|robotics|decision|audio|aqa|learnlm|computer-use/i;

/**
 * The newest first: by the version a name begins with ("gemini-4-…" before "gemini-3.8-…"),
 * then by name. Names that begin with no version (aliases such as "gemini-flash-latest",
 * experiments) come last: what they stand for is not known here.
 */
const version = (id: string): [number, number] => {
	const v = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(id);
	return v ? [Number(v[1]), Number(v[2] ?? 0)] : [-1, 0];
};
const newestFirst = (a: string, b: string) => version(b)[0] - version(a)[0] || version(b)[1] - version(a)[1] || a.localeCompare(b, "en", { numeric: true });

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	// (Google's own list, beside the address for OpenAI's protocol: it says what each model can do)
	const base = (options.baseURL ?? GEMINI_BASE).replace(/\/openai\/?$/, "");
	let answer: Response;
	try {
		// (an answer that points elsewhere is not followed: the key in the header would go along)
		answer = await globalThis.fetch(`${base}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey }, signal: options.signal, redirect: "error" });
	} catch (e) {
		if (options.signal?.aborted) throw e;
		throw new ApiError("Gemini's API could not be reached. Check the connection and try again.");
	}
	let body: { models?: unknown; error?: { message?: unknown; status?: unknown; details?: unknown } } = {};
	try {
		body = (await answer.json()) ?? {};
	} catch (e) {
		// (time ran out, or it was stopped, while the answer came in: that is not an empty list)
		if (options.signal?.aborted) throw e;
		// otherwise it is said below by its status
	}
	if (!answer.ok) {
		const said = quoted(body?.error?.message ?? answer.statusText, apiKey);
		if (answer.status === 401 || (answer.status === 400 && NOT_A_KEY.test(`${said} ${JSON.stringify(body?.error ?? "")}`))) throw new ApiError("Gemini did not accept the API key. Check it in Settings → Agents & models → API keys.", true);
		if (answer.status === 403) throw new ApiError(`Gemini refused this key (it may be blocked, or may not use this API): ${said}`);
		if (answer.status === 429) throw new ApiError(`Gemini is limiting requests for this key right now, or it has used up what it may: ${said}`);
		throw new ApiError(`Gemini answered with an error (${answer.status}): ${said}`);
	}
	const listed: { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }[] = Array.isArray(body?.models) ? body.models : [];
	return listed
		.map((m) => ({ value: typeof m?.name === "string" ? m.name.replace(/^models\//, "") : "", name: typeof m?.displayName === "string" && m.displayName ? m.displayName : "", talks: Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent") }))
		.filter((m) => m.talks && /^gemini-/i.test(m.value) && !NOT_CHAT.test(m.value))
		.sort((a, b) => newestFirst(a.value, b.value))
		.slice(0, 200)
		.map(({ value, name }) => ({ value, name: name || value }));
}

export const geminiProvider: ApiProvider = { id: "gemini", label: "Gemini API", company: "Gemini", keyHint: "AIza… or AQ.…", models, chat: (o) => completionsChat(GEMINI, o) };
