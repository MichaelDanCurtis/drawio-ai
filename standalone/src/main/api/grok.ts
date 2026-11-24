import { ApiError, providerSaid, quoted, type ApiModel, type ApiProvider } from "./chat";
import { completionsChat, completionsClient, explainCompletions, type CompletionsDialect } from "./completions";

/**
 * Grok through xAI's API, over OpenAI's chat-completions protocol (completions.ts). xAI calls
 * this way of talking to it deprecated (no end date is given) and points new work to another
 * one, but it is the one that needs nothing kept on xAI's side between requests. Its tool
 * calls arrive whole and without a position, and what went wrong can come as a plain
 * sentence: completions.ts and chat.ts read both.
 */
export const GROK_BASE = "https://api.x.ai/v1";

const GROK: CompletionsDialect = {
	who: "Grok",
	base: GROK_BASE,
	explain: (e, apiKey) => {
		// (xAI's reference lists "bad request" for a key that is not one, beside "unauthorised")
		const said = quoted(providerSaid(e), apiKey);
		if ((e as { status?: unknown })?.status === 400 && /api key/i.test(said)) return new ApiError("Grok did not accept the API key. Check it in Settings → Agents & models → API keys.", true);
		return undefined;
	},
};

/** Models that are not for a conversation with this app's tools (one that plans with agents of its own, a retired builder, pictures, speech). */
const NOT_CHAT = /multi-agent|^grok-build|imagine|voice|image|video|embedding/i;

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const client = completionsClient(GROK, apiKey, options.baseURL);
		// (the list of the models that hold a conversation: it says which of them take pictures)
		const page = (await client.get("/language-models", { signal: options.signal })) as { models?: unknown };
		const listed: { id?: unknown; created?: unknown; input_modalities?: unknown; output_modalities?: unknown }[] = Array.isArray(page?.models) ? page.models : [];
		const has = (list: unknown, what: string) => Array.isArray(list) && list.includes(what);
		return listed
			.filter((m) => typeof m?.id === "string" && m.id && !NOT_CHAT.test(m.id) && (m.output_modalities === undefined || has(m.output_modalities, "text")))
			.map((m) => ({ value: m.id as string, at: Number(m.created) || 0, sees: m.input_modalities === undefined || has(m.input_modalities, "image") }))
			.sort((a, b) => b.at - a.at || b.value.localeCompare(a.value, "en", { numeric: true }))
			.slice(0, 200)
			.map(({ value, sees }) => ({ value, name: value, ...(sees ? {} : { images: false as const }) }));
	} catch (e) {
		throw explainCompletions(GROK, e, apiKey);
	}
}

export const grokProvider: ApiProvider = { id: "grok", label: "Grok API", company: "xAI", keyHint: "xai-…", models, chat: (o) => completionsChat(GROK, o) };
