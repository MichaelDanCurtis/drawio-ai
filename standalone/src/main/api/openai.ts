import OpenAI from "openai";
import { ApiError, MAX_TOOL_ROUNDS, NO_PICTURE, providerSaid, quoted, type ApiChat, type ApiChatOptions, type ApiImage, type ApiModel, type ApiProvider, type ApiStop } from "./chat";
import { withoutProviderEnv } from "./env";

/**
 * OpenAI's models through its API. The Responses API is used (OpenAI recommends it for new
 * work, and its newest models call tools only there); each request names the one before it
 * (`previous_response_id`), so the model's own reasoning between tool calls stays with OpenAI
 * and only what is new is sent.
 */
export const OPENAI_BASE = "https://api.openai.com/v1";

/**
 * A client that uses this key and this address, whatever the environment says (see env.ts).
 * (Also for the providers that speak OpenAI's protocol at an address of their own.)
 */
export function openAiClient(apiKey: string, baseURL: string, fetch?: typeof globalThis.fetch): OpenAI {
	return withoutProviderEnv(() => new OpenAI({ apiKey, baseURL, organization: null, project: null, adminAPIKey: null, webhookSecret: null, maxRetries: 2, logLevel: "warn", ...(fetch ? { fetch } : {}) }));
}

/** What went wrong, in words for the user (`who` is the provider's name). */
export function explainOpenAi(e: unknown, who: string, apiKey: string): Error {
	if (e instanceof ApiError) return e;
	const said = quoted(providerSaid(e), apiKey);
	if (e instanceof OpenAI.AuthenticationError) {
		// (a key that is real but restricted is answered the same way as one that is not a key)
		if (/insufficient permissions|missing scopes?/i.test(said)) return new ApiError(`This ${who} key is restricted and may not do this: ${said}`);
		return new ApiError(`${who} did not accept the API key. Check it in Settings → Agents & models → API keys.`, true);
	}
	if (e instanceof OpenAI.PermissionDeniedError) return new ApiError(`${who} refused this request for this key (no access to the model, or no balance): ${said}`);
	// (going on from the answer before needs the provider to have kept it: an organisation can switch that off)
	if (e instanceof OpenAI.APIError && notKept(said)) return new ApiError(`${who} could not go on from its own previous answer (${said}). This way of working needs ${who} to keep answers for a while, which an organisation can switch off.`);
	if (e instanceof OpenAI.NotFoundError) return new ApiError(`${who} does not know that model. Choose another one.`);
	if (e instanceof OpenAI.RateLimitError) {
		const code = String((e as { code?: unknown }).code ?? "");
		return new ApiError(/quota|credit|spend|usage_limit/i.test(`${code} ${said}`) ? `This ${who} key has no credit or has reached its spending limit: ${said}` : `${who} is limiting requests for this key right now. Try again in a moment.`);
	}
	if (e instanceof OpenAI.APIConnectionError) return new ApiError(`${who}'s API could not be reached. Check the connection and try again.`);
	if (e instanceof OpenAI.APIError) return new ApiError(`${who} answered with an error${e.status ? ` (${e.status})` : ""}: ${said}`);
	return e instanceof Error ? e : new Error(String(e));
}

/** The provider says it has no previous answer to go on from. */
const notKept = (said: string) => /previous[_ ]response/i.test(said);

export const dataUrl = (i: ApiImage) => `data:${i.mimeType};base64,${i.base64}`;

/**
 * OpenAI's list says nothing about what a model can do. These older ones are known to take
 * words only (no pictures): they are given none.
 */
const WORDS_ONLY = /^(gpt-3\.5|gpt-4(-\d{4}|-32k(-\d{4})?)?$|o1-mini|o1-preview|o3-mini)/i;

/** Models that are not for a conversation with tools (speech, images, embeddings, moderation…). */
const NOT_CHAT = /embedding|tts|whisper|audio|realtime|image|moderation|transcribe|search|instruct|dall-e|sora|babbage|davinci|computer-use/i;

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const client = openAiClient(apiKey, options.baseURL ?? OPENAI_BASE);
		const found: { value: string; at: number }[] = [];
		for await (const m of client.models.list({ signal: options.signal })) {
			if (/^(gpt-|o\d|chatgpt-)/i.test(m.id) && !NOT_CHAT.test(m.id)) found.push({ value: m.id, at: Number(m.created) || 0 });
			if (found.length >= 300) break;
		}
		// the newest first (the list says nothing about what a model can do: the names are the guide)
		return found.sort((a, b) => b.at - a.at || a.value.localeCompare(b.value)).map(({ value }) => ({ value, name: value, ...(WORDS_ONLY.test(value) ? { images: false as const } : {}) }));
	} catch (e) {
		throw explainOpenAi(e, "OpenAI", apiKey);
	}
}

function chat(o: ApiChatOptions): ApiChat {
	const client = openAiClient(o.apiKey, o.baseURL ?? OPENAI_BASE);
	const tools = o.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
	const sees = o.images !== false;
	const picture = (i: ApiImage) => ({ type: "input_image", image_url: dataUrl(i), detail: "auto" });
	let previous: string | undefined;

	return {
		blank: () => previous === undefined,
		send: async (text, images, signal): Promise<ApiStop> => {
			let input: unknown[] = [{ role: "user", content: [{ type: "input_text", text }, ...(sees ? images.map(picture) : [])] }];
			// (forgotten by going on from the answer this request started from: one that waits for a tool's answer cannot be gone on from)
			const before = previous;
			const forget = <T>(result: T): T => {
				previous = before;
				return result;
			};
			try {
				for (let round = 0; ; round++) {
					const stream = await client.responses.create(
						{ model: o.model, instructions: o.system, input, tools, stream: true, ...(previous ? { previous_response_id: previous } : {}) } as OpenAI.Responses.ResponseCreateParamsStreaming,
						{ signal }
					);
					let done: OpenAI.Responses.Response | undefined;
					for await (const event of stream) {
						if (event.type === "response.output_text.delta") o.onText(event.delta);
						else if (event.type === "response.completed" || event.type === "response.incomplete") done = event.response;
						else if (event.type === "response.failed") throw new ApiError(`OpenAI could not finish the request: ${quoted(event.response.error?.message ?? "no reason given", o.apiKey)}`);
						else if (event.type === "error") throw new ApiError(`OpenAI answered with an error: ${quoted(event.message, o.apiKey)}`);
					}
					// (a stream that is stopped ends quietly, as one that broke off does: neither is an answer)
					if (signal.aborted) return forget("cancelled");
					if (!done) throw new ApiError("OpenAI ended the answer without finishing it. Try again.");
					previous = done.id;
					const calls = done.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call");
					if (!calls.length) {
						const declined = done.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"));
						return declined ? forget("refusal") : done.status === "incomplete" ? "max_tokens" : "end_turn";
					}
					// (a tool call cut off by the length limit is not run, its arguments are not whole; and the answer it
					// is part of cannot be gone on from, as it waits for that tool: the request ends there, and is forgotten)
					if (done.status === "incomplete") return forget("max_tokens");
					if (round >= MAX_TOOL_ROUNDS) throw new ApiError("The model kept calling tools without finishing, so it was stopped.");
					input = [];
					const pictures: ApiImage[] = [];
					for (const call of calls) {
						if (signal.aborted) return forget("cancelled");
						let args: unknown;
						try {
							args = JSON.parse(call.arguments || "{}");
						} catch {
							input.push({ type: "function_call_output", call_id: call.call_id, output: "Error: the arguments were not valid JSON. Send the call again." });
							continue;
						}
						const r = await o.callTool(call.name, args);
						const said = r.isError ? `Error: ${r.text}` : r.text;
						input.push({ type: "function_call_output", call_id: call.call_id, output: r.image && !sees ? `${said} ${NO_PICTURE}` : said });
						if (r.image && sees) pictures.push(r.image);
					}
					// (a picture a tool made goes in a message of its own: every model that sees images takes one there)
					if (pictures.length) input.push({ role: "user", content: [{ type: "input_text", text: "The picture the tool returned:" }, ...pictures.map(picture)] });
				}
			} catch (e) {
				forget(undefined);
				if (signal.aborted) return "cancelled";
				// (a request the API calls malformed may be so because of what it goes on from, and an answer that
				// was not kept cannot be gone on from at all: start over rather than fail for good)
				if (e instanceof OpenAI.BadRequestError || (e instanceof OpenAI.APIError && notKept(providerSaid(e)))) previous = undefined;
				throw explainOpenAi(e, "OpenAI", o.apiKey);
			}
		},
	};
}

export const openAiProvider: ApiProvider = { id: "openai", label: "OpenAI API", company: "OpenAI", keyHint: "sk-…", models, chat };
