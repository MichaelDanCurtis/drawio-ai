import type { CancellationToken } from "vscode";

export interface ImageData {
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	base64: string;
}

export type ChatPart =
	| { type: "text"; text: string }
	| { type: "image"; image: ImageData }
	| { type: "toolCall"; id: string; name: string; input: unknown }
	| {
			type: "toolResult";
			callId: string;
			name: string;
			text: string;
			image?: ImageData;
			isError?: boolean;
	  };

export interface ChatMessage {
	role: "user" | "assistant";
	parts: ChatPart[];
}

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export type StreamEvent =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; input: unknown };

export interface ModelInfo {
	id: string;
	name: string;
	vision: boolean;
}

export interface ChatRequest {
	system: string;
	messages: ChatMessage[];
	tools: ToolSpec[];
}

export interface AiModelClient {
	readonly providerId: ProviderId;
	readonly model: ModelInfo;
	stream(request: ChatRequest, token: CancellationToken): AsyncIterable<StreamEvent>;
}

export type ProviderId = "vscode-lm" | "anthropic" | "openai";

export interface AiProvider {
	readonly id: ProviderId;
	readonly label: string;
	/** False when credentials are missing. */
	isConfigured(): Promise<boolean>;
	listModels(): Promise<ModelInfo[]>;
	getClient(modelId: string | undefined): Promise<AiModelClient>;
}

export class ProviderError extends Error {}

export function parseToolInput(raw: string): unknown {
	if (!raw.trim()) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		return { __invalidJson: raw };
	}
}
