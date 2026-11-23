import Anthropic from "@anthropic-ai/sdk";
import { ApiError, MAX_TOOL_ROUNDS, NO_PICTURE, providerSaid, quoted, type ApiChat, type ApiChatOptions, type ApiImage, type ApiModel, type ApiProvider, type ApiStop } from "./chat";
import { withoutProviderEnv } from "./env";

/** Claude through Anthropic's API (the Messages API, with the tool loop run here). */
export const ANTHROPIC_BASE = "https://api.anthropic.com";

/** What went wrong, in words for the user. */
function explain(e: unknown, apiKey: string): Error {
	if (e instanceof ApiError) return e;
	if (e instanceof Anthropic.AuthenticationError) return new ApiError("Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys.", true);
	if (e instanceof Anthropic.PermissionDeniedError) return new ApiError("This Anthropic API key may not use that model.");
	if (e instanceof Anthropic.NotFoundError) return new ApiError("Anthropic does not know that model. Choose another one.");
	if (e instanceof Anthropic.RateLimitError) return new ApiError("Anthropic is limiting requests for this key right now. Try again in a moment.");
	if (e instanceof Anthropic.APIConnectionError) return new ApiError("Anthropic's API could not be reached. Check the connection and try again.");
	if (e instanceof Anthropic.APIError) return new ApiError(`Anthropic answered with an error${e.status ? ` (${e.status})` : ""}: ${quoted(providerSaid(e), apiKey)}`);
	return e instanceof Error ? e : new Error(String(e));
}

/** A client that uses this key and this address, whatever the environment says (see env.ts). */
export function anthropicClient(apiKey: string, baseURL?: string): Anthropic {
	return withoutProviderEnv(() => new Anthropic({ apiKey, baseURL: baseURL ?? ANTHROPIC_BASE, maxRetries: 2, logLevel: "warn" }));
}

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const found: { value: string; name: string; at: string }[] = [];
		for await (const m of anthropicClient(apiKey, options.baseURL).models.list({ limit: 100 }, { signal: options.signal })) {
			// (a retired model is still listed, and refuses every request)
			if (m.lifecycle === "retired") continue;
			found.push({ value: m.id, name: m.display_name || m.id, at: String(m.created_at ?? "") });
			if (found.length >= 200) break;
		}
		// the newest first
		return found.sort((a, b) => b.at.localeCompare(a.at)).map(({ value, name }) => ({ value, name }));
	} catch (e) {
		throw explain(e, apiKey);
	}
}

const imageBlock = (i: ApiImage): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: i.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: i.base64 } });

function chat(o: ApiChatOptions): ApiChat {
	const api = anthropicClient(o.apiKey, o.baseURL);
	const tools: Anthropic.Tool[] = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
	const sees = o.images !== false;
	const messages: Anthropic.MessageParam[] = [];
	let room: number | undefined;

	/** How much the model may write in one answer: what it allows, up to a size no icon or edit needs more than. */
	const maxTokens = async (signal: AbortSignal): Promise<number> => {
		if (room) return room;
		try {
			const info = await api.models.retrieve(o.model, {}, { signal });
			const cap = Number(info.max_tokens);
			room = cap > 0 ? Math.min(32000, cap) : 16000;
		} catch (e) {
			if (signal.aborted) throw e;
			room = 16000;
		}
		return room;
	};

	return {
		blank: () => messages.length === 0,
		send: async (text, images, signal): Promise<ApiStop> => {
			const before = messages.length;
			const forget = <T>(result: T): T => {
				messages.length = before;
				return result;
			};
			messages.push({ role: "user", content: [...(sees ? images.map(imageBlock) : []), { type: "text", text }] });
			try {
				const max_tokens = await maxTokens(signal);
				for (let round = 0; ; round++) {
					// (thinking and effort are left to each model's own default: one request shape for every model the key can use)
					const stream = api.messages.stream({ model: o.model, max_tokens, system: o.system, tools, messages }, { signal });
					stream.on("text", (delta) => o.onText(delta));
					const message = await stream.finalMessage();
					if (message.stop_reason === "refusal") return forget("refusal");
					// (an answer goes back as it came, but for text that is empty or only white space: the API takes
					// no such text, and no answer without content. A model may end its turn with nothing after a tool's answer.)
					const content = message.content.filter((b) => b.type !== "text" || b.text.trim().length > 0);
					if (content.some((b) => b.type !== "thinking" && b.type !== "redacted_thinking")) messages.push({ role: "assistant", content });
					// (a server-side pause: the turn is sent again to go on)
					if (message.stop_reason === "pause_turn") continue;
					const calls = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
					if (!calls.length) return message.stop_reason === "max_tokens" ? "max_tokens" : "end_turn";
					// a tool call cut off by the length limit is not run: its arguments are not whole
					const cut = message.stop_reason === "max_tokens";
					if (round >= MAX_TOOL_ROUNDS) throw new ApiError("The model kept calling tools without finishing, so it was stopped.");
					const results: Anthropic.ToolResultBlockParam[] = [];
					for (const call of calls) {
						if (signal.aborted) return forget("cancelled");
						const r = cut ? { text: "This call was cut off by the length limit. Send it again, shorter.", isError: true } : await o.callTool(call.name, call.input);
						results.push({
							type: "tool_result",
							tool_use_id: call.id,
							...(r.isError ? { is_error: true } : {}),
							content: [{ type: "text", text: r.image && !sees ? `${r.text} ${NO_PICTURE}` : r.text }, ...(r.image && sees ? [imageBlock(r.image)] : [])],
						});
					}
					messages.push({ role: "user", content: results });
				}
			} catch (e) {
				forget(undefined);
				if (signal.aborted) return "cancelled";
				// (a request the API calls malformed may be so because of what is kept: start over rather than fail for good)
				if (e instanceof Anthropic.BadRequestError) messages.length = 0;
				throw explain(e, o.apiKey);
			}
		},
	};
}

export const anthropicProvider: ApiProvider = { id: "anthropic", label: "Anthropic API", company: "Anthropic", keyHint: "sk-ant-…", models, chat };
