import OpenAI from "openai";
import { ApiError, MAX_TOOL_ROUNDS, NO_PICTURE, type ApiChat, type ApiChatOptions, type ApiImage, type ApiStop } from "./chat";
import { dataUrl, explainOpenAi, openAiClient } from "./openai";

/**
 * A conversation over OpenAI's chat-completions protocol, which several providers speak at an
 * address of their own (Kimi, Gemini, Grok, OpenRouter): their guides use the OpenAI SDK with
 * that address. The whole conversation is sent each time. What differs between them is small,
 * and named here.
 */
export interface CompletionsDialect {
	/** The provider's name where something that went wrong is said ("Kimi"). */
	who: string;
	/** The address of its API. */
	base: string;
	/** What is added to every request: how much the model may write, and the like. */
	request?(model: string): Record<string, unknown>;
	/**
	 * The field of an answer that holds the model's reasoning, where the provider wants it back
	 * with the answer as it came: a text (`reasoning_content`) or a list of parts
	 * (`reasoning_details`).
	 */
	reasoning?: "reasoning_content" | "reasoning_details";
	/** What went wrong, where this provider says it in a way of its own (else the common words are used). */
	explain?(e: unknown, apiKey: string): Error | undefined;
	/** A tool's arguments as this provider takes them described (one that knows only part of JSON Schema). */
	schema?(schema: Record<string, unknown>): Record<string, unknown>;
	/** How this provider is reached, where its answers need putting right before the SDK reads them. */
	fetch?: typeof globalThis.fetch;
}

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type CallPiece = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall;

/** What went wrong with a request to a provider of this kind, in words for the user. */
export function explainCompletions(d: CompletionsDialect, e: unknown, apiKey: string): Error {
	return d.explain?.(e, apiKey) ?? explainOpenAi(e, d.who, apiKey);
}

export function completionsClient(d: CompletionsDialect, apiKey: string, baseURL?: string): OpenAI {
	return openAiClient(apiKey, baseURL ?? d.base, d.fetch);
}

/**
 * A part of the model's reasoning as it arrives, piece by piece: pieces of the same part are
 * put together, their texts joined, everything else taken from the latest piece. The same
 * part: the same kind and the same `index` (or the same `id` where there is no index); a
 * piece that has neither goes on with the part before it, when that is of its kind.
 */
function addReasoningDetails(kept: Record<string, unknown>[], pieces: unknown): void {
	if (!Array.isArray(pieces)) return;
	for (const piece of pieces) {
		if (!piece || typeof piece !== "object") continue;
		const p = piece as Record<string, unknown>;
		const last = kept[kept.length - 1];
		const same =
			p.index !== undefined || p.id !== undefined
				? kept.find((k) => k.type === p.type && (p.index !== undefined ? k.index === p.index : k.id === p.id))
				: last && last.type === p.type
				? last
				: undefined;
		if (!same) {
			kept.push({ ...p });
			continue;
		}
		for (const [name, value] of Object.entries(p)) {
			// (the texts of a part come in pieces; a signature, a type or a format comes whole)
			if ((name === "text" || name === "summary" || name === "data") && typeof value === "string" && typeof same[name] === "string") same[name] = (same[name] as string) + value;
			else if (value !== null && value !== undefined) same[name] = value;
		}
	}
}

export function completionsChat(d: CompletionsDialect, o: ApiChatOptions): ApiChat {
	const client = completionsClient(d, o.apiKey, o.baseURL);
	const tools = o.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: d.schema ? d.schema(t.inputSchema) : t.inputSchema } }));
	const sees = o.images !== false;
	const messages: Message[] = [{ role: "system", content: o.system }];
	let calling = 0;
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
					const stream = await client.chat.completions.create({ model: o.model, messages, tools, stream: true, ...(d.request?.(o.model) ?? {}) } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, { signal });
					let said = "";
					let reasoning = "";
					const details: Record<string, unknown>[] = [];
					let finish = "";
					// (a call arrives in pieces: its id and name first, then its arguments. What else a provider puts
					// on a call, a signature of the model's thinking for one, is kept and goes back with it.)
					const calls: { id: string; name: string; arguments: string; more: Record<string, unknown> }[] = [];
					const placed = new Map<number, (typeof calls)[number]>();
					for await (const chunk of stream) {
						// (what goes wrong in the middle of an answer, the SDK reads from the chunk itself and throws)
						const choice = chunk.choices?.[0];
						if (!choice) continue;
						const delta = (choice.delta ?? {}) as { content?: string | null; reasoning_content?: string | null; reasoning_details?: unknown; tool_calls?: CallPiece[] };
						if (d.reasoning === "reasoning_content" && delta.reasoning_content) reasoning += delta.reasoning_content;
						if (d.reasoning === "reasoning_details") addReasoningDetails(details, delta.reasoning_details);
						if (delta.content) {
							said += delta.content;
							o.onText(delta.content);
						}
						for (const piece of delta.tool_calls ?? []) {
							// Which call a piece belongs to. By the position the provider gives, unless the piece names
							// another id than the call at that position has (a provider that gives every call the same
							// position). Without a position the calls come one after the other: a piece with the last
							// call's id, or with neither an id nor a name, goes on with the last; any other begins one.
							const last = calls[calls.length - 1];
							const there = typeof piece.index === "number" ? placed.get(piece.index) : undefined;
							let call =
								typeof piece.index === "number"
									? there && !(piece.id && there.id && piece.id !== there.id)
										? there
										: undefined
									: last && (piece.id ? piece.id === last.id : !piece.function?.name)
									? last
									: undefined;
							if (!call) {
								call = { id: "", name: "", arguments: "", more: {} };
								calls.push(call);
							}
							if (typeof piece.index === "number") placed.set(piece.index, call);
							if (piece.id) call.id = piece.id;
							if (piece.function?.name) call.name = piece.function.name;
							if (piece.function?.arguments) call.arguments += piece.function.arguments;
							for (const [name, value] of Object.entries(piece)) if (!["index", "id", "type", "function"].includes(name) && value !== null && value !== undefined) call.more[name] = value;
						}
						if (choice.finish_reason) finish = choice.finish_reason;
					}
					// (a stream that is stopped ends quietly, as one that broke off does: neither is an answer)
					if (signal.aborted) return forget("cancelled");
					if (finish === "error") throw new ApiError(`${d.who} could not finish the request. Try again.`);
					if (!finish) throw new ApiError(`${d.who} ended the answer without finishing it. Try again.`);
					// (a tool call cut off by the length limit is not run, and not kept: its arguments are not whole,
					// and a conversation with such a call in it may be refused from then on)
					const asked = finish === "length" ? [] : calls.filter((c) => c && c.name);
					// (a provider that gives a call no id still wants its answer to name one)
					for (const c of asked) c.id ||= `call_${++calling}`;
					// the answer goes back as it came, reasoning included. (One that says nothing and calls nothing
					// is not kept: the API takes no empty answer. A model may end with nothing after a tool's answer.)
					if (said.trim() || asked.length)
						messages.push({
							role: "assistant",
							content: said,
							...(reasoning ? { reasoning_content: reasoning } : {}),
							...(details.length ? { reasoning_details: details } : {}),
							...(asked.length ? { tool_calls: asked.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments }, ...c.more })) } : {}),
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
				throw explainCompletions(d, e, o.apiKey);
			}
		},
	};
}
