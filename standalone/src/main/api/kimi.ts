import OpenAI from "openai";
import { ApiError, MAX_TOOL_ROUNDS, NO_PICTURE, type ApiChat, type ApiChatOptions, type ApiImage, type ApiModel, type ApiProvider, type ApiStop } from "./chat";
import { dataUrl, explainOpenAi, openAiClient } from "./openai";

/**
 * Kimi (Moonshot AI) through its API, which speaks OpenAI's chat-completions shape: Kimi's own
 * guides use the OpenAI SDK with this address. The whole conversation is sent each time, with
 * the model's reasoning passed back as it came (Kimi's thinking models ask for that).
 */
export const KIMI_BASE = "https://api.moonshot.ai/v1";

/**
 * How much the model may write in one answer. Kimi counts its reasoning too, and says not to
 * go below 16,000 for its thinking models. The older moonshot-v1 models are named after the
 * size of their whole conversation ("moonshot-v1-8k"): an answer gets half of that at most.
 */
export function kimiAnswerRoom(model: string): number {
	const named = /^moonshot-v1-(\d+)k/i.exec(model);
	return named ? Math.min(16000, Math.max(1024, Math.floor((Number(named[1]) * 1024) / 2))) : 16000;
}

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const client = openAiClient(apiKey, options.baseURL ?? KIMI_BASE);
		const found: { value: string; at: number; sees: boolean }[] = [];
		for await (const m of client.models.list({ signal: options.signal })) {
			const sees = (m as { supports_image_in?: unknown }).supports_image_in;
			found.push({ value: m.id, at: Number(m.created) || 0, sees: sees !== false });
			if (found.length >= 200) break;
		}
		// models that see images first (the Creator shows the model its own drawing), then the newest
		return found.sort((a, b) => Number(b.sees) - Number(a.sees) || b.at - a.at || a.value.localeCompare(b.value)).map(({ value, sees }) => ({ value, name: value, ...(sees ? {} : { images: false as const }) }));
	} catch (e) {
		throw explainOpenAi(e, "Kimi", apiKey);
	}
}

function chat(o: ApiChatOptions): ApiChat {
	const client = openAiClient(o.apiKey, o.baseURL ?? KIMI_BASE);
	const tools = o.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
	const sees = o.images !== false;
	const messages: Message[] = [{ role: "system", content: o.system }];
	const pictures = (images: ApiImage[]) => images.map((i) => ({ type: "image_url" as const, image_url: { url: dataUrl(i) } }));

	return {
		blank: () => messages.length === 1,
		send: async (text, images, signal): Promise<ApiStop> => {
			const before = messages.length;
			const forget = <T>(result: T): T => {
				messages.length = before;
				return result;
			};
			messages.push({ role: "user", content: sees && images.length ? [{ type: "text", text }, ...pictures(images)] : text });
			try {
				for (let round = 0; ; round++) {
					const stream = await client.chat.completions.create({ model: o.model, messages, tools, stream: true, max_completion_tokens: kimiAnswerRoom(o.model) }, { signal });
					let said = "";
					let reasoning = "";
					let finish = "";
					const calls: { id: string; name: string; arguments: string }[] = [];
					for await (const chunk of stream) {
						const choice = chunk.choices?.[0];
						if (!choice) continue;
						const delta = choice.delta as { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] };
						if (delta.reasoning_content) reasoning += delta.reasoning_content;
						if (delta.content) {
							said += delta.content;
							o.onText(delta.content);
						}
						// a call arrives in pieces: its id and name first, then its arguments, by position
						for (const piece of delta.tool_calls ?? []) {
							const call = (calls[piece.index] ??= { id: "", name: "", arguments: "" });
							if (piece.id) call.id = piece.id;
							if (piece.function?.name) call.name = piece.function.name;
							if (piece.function?.arguments) call.arguments += piece.function.arguments;
						}
						if (choice.finish_reason) finish = choice.finish_reason;
					}
					// (a stream that is stopped ends quietly, as one that broke off does: neither is an answer)
					if (signal.aborted) return forget("cancelled");
					if (!finish) throw new ApiError("Kimi ended the answer without finishing it. Try again.");
					// (a tool call cut off by the length limit is not run, and not kept: its arguments are not whole,
					// and a conversation with such a call in it may be refused from then on)
					const asked = finish === "length" ? [] : calls.filter((c) => c && c.id && c.name);
					// the answer goes back as it came, reasoning included. (One that says nothing and calls nothing
					// is not kept: the API takes no empty answer. A model may end with nothing after a tool's answer.)
					if (said.trim() || asked.length)
						messages.push({
							role: "assistant",
							content: said,
							...(reasoning ? { reasoning_content: reasoning } : {}),
							...(asked.length ? { tool_calls: asked.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
						} as Message);
					if (!asked.length) return finish === "length" ? "max_tokens" : finish === "content_filter" ? forget("refusal") : "end_turn";
					if (round >= MAX_TOOL_ROUNDS) throw new ApiError("The model kept calling tools without finishing, so it was stopped.");
					const made: ApiImage[] = [];
					for (const call of asked) {
						if (signal.aborted) return forget("cancelled");
						let output: string;
						try {
							const r = await o.callTool(call.name, JSON.parse(call.arguments || "{}"));
							output = r.isError ? `Error: ${r.text}` : r.text;
							if (r.image && sees) made.push(r.image);
							else if (r.image) output += ` ${NO_PICTURE}`;
						} catch (e) {
							if (!(e instanceof SyntaxError)) throw e;
							output = "Error: the arguments were not valid JSON. Send the call again.";
						}
						messages.push({ role: "tool", tool_call_id: call.id, content: output });
					}
					if (signal.aborted) return forget("cancelled");
					// (a tool's answer is text only here: a picture it made follows in a message of its own)
					if (made.length) messages.push({ role: "user", content: [{ type: "text", text: "The picture the tool returned:" }, ...pictures(made)] });
				}
			} catch (e) {
				forget(undefined);
				if (signal.aborted) return "cancelled";
				// (a request the API calls malformed may be so because of what is kept: start over rather than fail for good)
				if (e instanceof OpenAI.BadRequestError) messages.length = 1;
				throw explainOpenAi(e, "Kimi", o.apiKey);
			}
		},
	};
}

export const kimiProvider: ApiProvider = { id: "kimi", label: "Kimi API", company: "Kimi", keyHint: "sk-…", models, chat };
