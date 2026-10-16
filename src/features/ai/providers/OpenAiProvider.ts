import type { CancellationToken, SecretStorage } from "vscode";
import { getAiSettings, SECRET_KEYS } from "../aiSettings";
import { abortSignalFor, readSse, throwForStatus } from "./sse";
import {
	AiModelClient,
	AiProvider,
	ChatRequest,
	ModelInfo,
	parseToolInput,
	ProviderError,
	StreamEvent,
} from "./types";

/** Any OpenAI-compatible Chat Completions endpoint: OpenAI, Azure OpenAI (v1 API), OpenRouter, Ollama, LM Studio, vLLM... */
export class OpenAiProvider implements AiProvider {
	public readonly id = "openai" as const;
	public readonly label = "OpenAI-compatible (API key)";

	constructor(private readonly secrets: SecretStorage) {}

	private async headers(): Promise<Record<string, string>> {
		const s = getAiSettings().openai;
		const key = await this.secrets.get(SECRET_KEYS.openai);
		const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(s.baseUrl);
		if (!key && !isLocal) {
			throw new ProviderError('No OpenAI-compatible API key. Run "Draw.io AI: Set API Key".');
		}
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (key) {
			if (s.authHeader === "api-key") headers["api-key"] = key;
			else headers["authorization"] = `Bearer ${key}`;
		}
		return headers;
	}

	async isConfigured(): Promise<boolean> {
		try {
			await this.headers();
			return true;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const s = getAiSettings().openai;
		const response = await fetch(`${s.baseUrl}/models`, { headers: await this.headers() });
		await throwForStatus(response, "OpenAI-compatible endpoint");
		const json: any = await response.json();
		const models: ModelInfo[] = (json?.data ?? [])
			.map((m: any) => String(m.id))
			.filter((id: string) => !/embedding|whisper|tts|dall-e|moderation|transcribe|image|audio|realtime/i.test(id))
			.sort()
			.map((id: string) => ({ id, name: id, vision: s.supportsImages }));
		if (s.model && !models.some((m) => m.id === s.model)) {
			models.unshift({ id: s.model, name: s.model, vision: s.supportsImages });
		}
		return models;
	}

	async getClient(modelId: string | undefined): Promise<AiModelClient> {
		const s = getAiSettings().openai;
		const id = modelId || s.model;
		if (!id) {
			throw new ProviderError(
				"No model selected for the OpenAI-compatible provider. Pick one in the Draw.io AI chat or set drawio-ai.openai.model."
			);
		}
		return new OpenAiClient({ id, name: id, vision: s.supportsImages }, await this.headers());
	}
}

class OpenAiClient implements AiModelClient {
	public readonly providerId = "openai" as const;

	constructor(public readonly model: ModelInfo, private readonly headers: Record<string, string>) {}

	async *stream(request: ChatRequest, token: CancellationToken): AsyncIterable<StreamEvent> {
		const s = getAiSettings().openai;
		const body: Record<string, unknown> = {
			model: this.model.id,
			messages: this.toMessages(request),
			stream: true,
		};
		// Sending tool_choice/tools with an empty list is rejected by several providers.
		if (request.tools.length > 0) {
			body.tools = request.tools.map((t) => ({
				type: "function",
				function: { name: t.name, description: t.description, parameters: t.inputSchema },
			}));
		}

		const abort = abortSignalFor(token);
		try {
			const response = await fetch(`${s.baseUrl}/chat/completions`, {
				method: "POST",
				signal: abort.signal,
				headers: this.headers,
				body: JSON.stringify(body),
			});
			await throwForStatus(response, "OpenAI-compatible endpoint");

			const calls = new Map<number, { id: string; name: string; args: string }>();
			for await (const msg of readSse(response)) {
				if (msg.data === "[DONE]") break;
				const data = JSON.parse(msg.data);
				if (data.error) {
					throw new ProviderError(`Provider error: ${data.error.message ?? "unknown"}`);
				}
				const delta = data.choices?.[0]?.delta;
				if (!delta) continue;
				if (typeof delta.content === "string" && delta.content) {
					yield { type: "text", text: delta.content };
				}
				for (const tc of delta.tool_calls ?? []) {
					const index = tc.index ?? 0;
					const entry = calls.get(index) ?? { id: "", name: "", args: "" };
					if (tc.id) entry.id = tc.id;
					if (tc.function?.name) entry.name += tc.function.name;
					if (tc.function?.arguments) entry.args += tc.function.arguments;
					calls.set(index, entry);
				}
			}
			for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
				yield {
					type: "toolCall",
					id: c.id || `call_${index}_${Date.now()}`,
					name: c.name,
					input: parseToolInput(c.args),
				};
			}
		} finally {
			abort.dispose();
		}
	}

	private toMessages(request: ChatRequest): any[] {
		const out: any[] = [{ role: "system", content: request.system }];
		for (const msg of request.messages) {
			if (msg.role === "assistant") {
				const text = msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
				const toolCalls = msg.parts.flatMap((p) =>
					p.type === "toolCall"
						? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }]
						: []
				);
				out.push({
					role: "assistant",
					content: text || null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				});
				continue;
			}
			const images: string[] = [];
			const texts: string[] = [];
			for (const p of msg.parts) {
				if (p.type === "toolResult") {
					out.push({ role: "tool", tool_call_id: p.callId, content: p.text || "(empty)" });
					if (p.image && this.model.vision) {
						images.push(`data:${p.image.mimeType};base64,${p.image.base64}`);
					}
				} else if (p.type === "text" && p.text) {
					texts.push(p.text);
				}
			}
			// Chat Completions cannot carry images in tool messages; attach them as a follow-up user turn.
			if (images.length > 0 || texts.length > 0) {
				out.push({
					role: "user",
					content:
						images.length === 0
							? texts.join("\n\n")
							: [
									{ type: "text", text: texts.join("\n\n") || "Rendered diagram from the previous tool call:" },
									...images.map((url) => ({ type: "image_url", image_url: { url } })),
							  ],
				});
			}
		}
		return out;
	}
}
