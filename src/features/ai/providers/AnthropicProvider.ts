import type { CancellationToken, SecretStorage } from "vscode";
import { getAiSettings, SECRET_KEYS } from "../aiSettings";
import { abortSignalFor, readSse, throwForStatus } from "./sse";
import {
	AiModelClient,
	AiProvider,
	ChatMessage,
	ChatRequest,
	ModelInfo,
	parseToolInput,
	ProviderError,
	StreamEvent,
} from "./types";

const API_VERSION = "2023-06-01";

export class AnthropicProvider implements AiProvider {
	public readonly id = "anthropic" as const;
	public readonly label = "Anthropic (API key)";

	constructor(private readonly secrets: SecretStorage) {}

	private async apiKey(): Promise<string> {
		const key = await this.secrets.get(SECRET_KEYS.anthropic);
		if (!key) {
			throw new ProviderError(
				'No Anthropic API key. Run "Draw.AI: Set API Key".'
			);
		}
		return key;
	}

	async isConfigured(): Promise<boolean> {
		return !!(await this.secrets.get(SECRET_KEYS.anthropic));
	}

	async listModels(): Promise<ModelInfo[]> {
		const s = getAiSettings().anthropic;
		const response = await fetch(`${s.baseUrl}/v1/models?limit=100`, {
			headers: { "x-api-key": await this.apiKey(), "anthropic-version": API_VERSION },
		});
		await throwForStatus(response, "Anthropic");
		const json: any = await response.json();
		const models: ModelInfo[] = (json?.data ?? []).map((m: any) => ({
			id: m.id,
			name: m.display_name ?? m.id,
			vision: true,
		}));
		if (s.model && !models.some((m) => m.id === s.model)) {
			models.unshift({ id: s.model, name: s.model, vision: true });
		}
		return models;
	}

	async getClient(modelId: string | undefined): Promise<AiModelClient> {
		const s = getAiSettings().anthropic;
		let id = modelId || s.model;
		if (!id) {
			id = (await this.listModels())[0]?.id;
		}
		if (!id) {
			throw new ProviderError("No Anthropic model available. Set drawio-ai.anthropic.model.");
		}
		return new AnthropicClient({ id, name: id, vision: true }, await this.apiKey());
	}
}

class AnthropicClient implements AiModelClient {
	public readonly providerId = "anthropic" as const;

	constructor(public readonly model: ModelInfo, private readonly key: string) {}

	async *stream(request: ChatRequest, token: CancellationToken): AsyncIterable<StreamEvent> {
		const s = getAiSettings().anthropic;
		const abort = abortSignalFor(token);
		try {
			const response = await fetch(`${s.baseUrl}/v1/messages`, {
				method: "POST",
				signal: abort.signal,
				headers: {
					"content-type": "application/json",
					"x-api-key": this.key,
					"anthropic-version": API_VERSION,
				},
				body: JSON.stringify({
					model: this.model.id,
					max_tokens: s.maxTokens,
					system: request.system,
					messages: request.messages.map(toAnthropicMessage).filter((m) => m.content.length > 0),
					tools: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						input_schema: t.inputSchema,
					})),
					stream: true,
				}),
			});
			await throwForStatus(response, "Anthropic");

			const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
			for await (const msg of readSse(response)) {
				const data = JSON.parse(msg.data);
				switch (data.type) {
					case "content_block_start":
						if (data.content_block?.type === "tool_use") {
							toolBlocks.set(data.index, {
								id: data.content_block.id,
								name: data.content_block.name,
								json: "",
							});
						}
						break;
					case "content_block_delta":
						if (data.delta?.type === "text_delta") {
							yield { type: "text", text: data.delta.text };
						} else if (data.delta?.type === "input_json_delta") {
							const block = toolBlocks.get(data.index);
							if (block) block.json += data.delta.partial_json;
						}
						break;
					case "content_block_stop": {
						const block = toolBlocks.get(data.index);
						if (block) {
							toolBlocks.delete(data.index);
							yield {
								type: "toolCall",
								id: block.id,
								name: block.name,
								input: parseToolInput(block.json),
							};
						}
						break;
					}
					case "error":
						throw new ProviderError(`Anthropic: ${data.error?.message ?? "stream error"}`);
				}
			}
		} finally {
			abort.dispose();
		}
	}
}

function toAnthropicMessage(msg: ChatMessage): { role: string; content: any[] } {
	const content: any[] = [];
	for (const p of msg.parts) {
		if (p.type === "text") {
			if (p.text) content.push({ type: "text", text: p.text });
		} else if (p.type === "image") {
			content.push({
				type: "image",
				source: { type: "base64", media_type: p.image.mimeType, data: p.image.base64 },
			});
		} else if (p.type === "toolCall") {
			content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
		} else {
			const inner: any[] = [{ type: "text", text: p.text || "(empty)" }];
			if (p.image) {
				inner.push({
					type: "image",
					source: { type: "base64", media_type: p.image.mimeType, data: p.image.base64 },
				});
			}
			content.push({
				type: "tool_result",
				tool_use_id: p.callId,
				content: inner,
				is_error: p.isError || undefined,
			});
		}
	}
	return { role: msg.role, content };
}
