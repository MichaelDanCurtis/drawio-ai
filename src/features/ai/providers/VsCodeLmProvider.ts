import * as vscode from "vscode";
import {
	AiModelClient,
	AiProvider,
	ChatMessage,
	ChatRequest,
	ModelInfo,
	ProviderError,
	StreamEvent,
} from "./types";

const DataPart: any = (vscode as any).LanguageModelDataPart;

/** Models exposed through VS Code's Language Model API (GitHub Copilot and any other registered vendor). */
export class VsCodeLmProvider implements AiProvider {
	public readonly id = "vscode-lm" as const;
	public readonly label = "VS Code / Copilot models";

	async isConfigured(): Promise<boolean> {
		return (await vscode.lm.selectChatModels()).length > 0;
	}

	async listModels(): Promise<ModelInfo[]> {
		const models = await vscode.lm.selectChatModels();
		return models.map(toModelInfo);
	}

	async getClient(modelId: string | undefined): Promise<AiModelClient> {
		const models = await vscode.lm.selectChatModels();
		const model = models.find((m) => m.id === modelId) ?? models[0];
		if (!model) {
			throw new ProviderError(
				"No VS Code language models are available. Sign in to GitHub Copilot, or switch the provider to Anthropic/OpenAI and set an API key."
			);
		}
		return new VsCodeLmClient(model);
	}
}

function toModelInfo(m: vscode.LanguageModelChat): ModelInfo {
	const caps = (m as any).capabilities;
	return {
		id: m.id,
		name: `${m.name}${m.vendor ? ` · ${m.vendor}` : ""}`,
		vision: !!DataPart && !!caps?.supportsImageToText,
	};
}

export class VsCodeLmClient implements AiModelClient {
	public readonly providerId = "vscode-lm" as const;
	public readonly model: ModelInfo;

	constructor(private readonly chat: vscode.LanguageModelChat) {
		this.model = toModelInfo(chat);
	}

	async *stream(
		request: ChatRequest,
		token: vscode.CancellationToken
	): AsyncIterable<StreamEvent> {
		const messages = toLmMessages(request, this.model.vision);
		let response: vscode.LanguageModelChatResponse;
		try {
			response = await this.chat.sendRequest(
				messages,
				{
					justification: "Draw.io AI edits your diagram.",
					tools: request.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				},
				token
			);
		} catch (e) {
			if (e instanceof vscode.LanguageModelError) {
				throw new ProviderError(`${this.chat.name}: ${e.message}`);
			}
			throw e;
		}

		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				yield { type: "text", text: part.value };
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				yield { type: "toolCall", id: part.callId, name: part.name, input: part.input };
			}
		}
	}
}

function toLmMessages(request: ChatRequest, vision: boolean): vscode.LanguageModelChatMessage[] {
	// The LM API has no stable system role; the instructions lead the first user turn.
	const result: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(request.system),
	];
	for (const msg of request.messages) {
		result.push(toLmMessage(msg, vision));
	}
	return result;
}

function toLmMessage(msg: ChatMessage, vision: boolean): vscode.LanguageModelChatMessage {
	if (msg.role === "assistant") {
		const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
		for (const p of msg.parts) {
			if (p.type === "text" && p.text) {
				parts.push(new vscode.LanguageModelTextPart(p.text));
			} else if (p.type === "toolCall") {
				parts.push(
					new vscode.LanguageModelToolCallPart(p.id, p.name, asObject(p.input))
				);
			}
		}
		return vscode.LanguageModelChatMessage.Assistant(parts);
	}

	const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
	for (const p of msg.parts) {
		if (p.type === "text" && p.text) {
			parts.push(new vscode.LanguageModelTextPart(p.text));
		} else if (p.type === "toolResult") {
			const content: unknown[] = [new vscode.LanguageModelTextPart(p.text)];
			if (p.image && vision && DataPart?.image) {
				content.push(DataPart.image(base64ToBytes(p.image.base64), p.image.mimeType));
			}
			parts.push(new vscode.LanguageModelToolResultPart(p.callId, content));
		}
	}
	return vscode.LanguageModelChatMessage.User(parts);
}

function asObject(input: unknown): object {
	return input && typeof input === "object" ? input : {};
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
