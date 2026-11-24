import type { ApiModel, ApiProvider } from "./chat";
import { completionsChat, completionsClient, explainCompletions, type CompletionsDialect } from "./completions";

/**
 * Kimi (Moonshot AI) through its API, which speaks OpenAI's chat-completions protocol
 * (completions.ts). The model's reasoning is passed back as it came (Kimi's thinking models
 * ask for that).
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

const KIMI: CompletionsDialect = { who: "Kimi", base: KIMI_BASE, reasoning: "reasoning_content", request: (model) => ({ max_completion_tokens: kimiAnswerRoom(model) }) };

async function models(apiKey: string, options: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ApiModel[]> {
	try {
		const found: { value: string; at: number; sees: boolean }[] = [];
		for await (const m of completionsClient(KIMI, apiKey, options.baseURL).models.list({ signal: options.signal })) {
			const sees = (m as { supports_image_in?: unknown }).supports_image_in;
			found.push({ value: m.id, at: Number(m.created) || 0, sees: sees !== false });
			if (found.length >= 200) break;
		}
		// models that see images first (the Creator shows the model its own drawing), then the newest
		return found.sort((a, b) => Number(b.sees) - Number(a.sees) || b.at - a.at || a.value.localeCompare(b.value)).map(({ value, sees }) => ({ value, name: value, ...(sees ? {} : { images: false as const }) }));
	} catch (e) {
		throw explainCompletions(KIMI, e, apiKey);
	}
}

export const kimiProvider: ApiProvider = { id: "kimi", label: "Kimi API", company: "Kimi", keyHint: "sk-…", models, chat: (o) => completionsChat(KIMI, o) };
