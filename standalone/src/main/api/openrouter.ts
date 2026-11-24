import { ApiError, providerSaid, quoted, type ApiModel, type ApiProvider } from "./chat";
import { completionsChat, completionsClient, explainCompletions, type CompletionsDialect } from "./completions";

/**
 * OpenRouter: one key for the models of many providers, over OpenAI's chat-completions
 * protocol (completions.ts). The model's reasoning comes as a list of parts
 * (`reasoning_details`) that goes back with its answer as it came: the providers behind
 * OpenRouter need it to go on after a tool call.
 *
 * Nothing that names this app is sent (OpenRouter's optional `HTTP-Referer` and title
 * headers are left out). Which providers a request may be routed to, and what they may keep,
 * is the user's own setting in their OpenRouter account.
 */
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const OPENROUTER: CompletionsDialect = {
	who: "OpenRouter",
	base: OPENROUTER_BASE,
	reasoning: "reasoning_details",
	// (routed only to a provider that takes everything in the request: otherwise the tools can be quietly left out)
	request: () => ({ provider: { require_parameters: true } }),
	explain: (e, apiKey) => {
		const status = (e as { status?: unknown })?.status;
		const said = quoted(providerSaid(e), apiKey);
		if (status === 402) return new ApiError(`This OpenRouter key has no credit left: ${said}`);
		if (status === 403) return new ApiError(`OpenRouter refused this request (moderation, or a limit set on the key): ${said}`);
		if (status === 404) return new ApiError(`OpenRouter has no provider for that model that can take this request (its tools, or the privacy settings of your OpenRouter account): ${said}`);
		return undefined;
	},
};

/** A model as OpenRouter lists it (the fields used here). */
interface Listed {
	id?: unknown;
	name?: unknown;
	created?: unknown;
	architecture?: { input_modalities?: unknown; output_modalities?: unknown };
}

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const client = completionsClient(OPENROUTER, apiKey, options.baseURL);
		// OpenRouter's list of models is open to anyone, so it says nothing about a key. What does is the
		// key's own page: a key OpenRouter does not know is refused there. (Anything else that goes wrong
		// with that page is not the key's fault, and the list is asked for all the same.)
		try {
			await client.get("/key", { signal: options.signal });
		} catch (e) {
			if (options.signal?.aborted || (e as { status?: unknown })?.status === 401) throw e;
		}
		// (only the models that can call tools: there are several hundred)
		const page = (await client.get("/models", { query: { supported_parameters: "tools" }, signal: options.signal })) as { data?: unknown };
		const listed: Listed[] = Array.isArray(page?.data) ? page.data : [];
		const has = (list: unknown, what: string) => Array.isArray(list) && list.includes(what);
		return listed
			.filter((m) => typeof m?.id === "string" && m.id && (m.architecture?.output_modalities === undefined || has(m.architecture.output_modalities, "text")))
			.map((m) => ({ value: m.id as string, name: typeof m.name === "string" && m.name ? m.name : (m.id as string), at: Number(m.created) || 0, sees: m.architecture?.input_modalities === undefined || has(m.architecture.input_modalities, "image") }))
			.sort((a, b) => b.at - a.at || a.value.localeCompare(b.value))
			.slice(0, 500)
			.map(({ value, name, sees }) => ({ value, name, ...(sees ? {} : { images: false as const }) }));
	} catch (e) {
		throw explainCompletions(OPENROUTER, e, apiKey);
	}
}

export const openRouterProvider: ApiProvider = { id: "openrouter", label: "OpenRouter", company: "OpenRouter", keyHint: "sk-or-v1-…", models, chat: (o) => completionsChat(OPENROUTER, o) };
