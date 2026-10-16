import { workspace } from "vscode";
import type { ProviderId } from "./providers/types";

const SECTION = "drawio-ai";

export const SECRET_KEYS = {
	anthropic: "drawio-ai.anthropic.apiKey",
	openai: "drawio-ai.openai.apiKey",
} as const;

export function getAiSettings() {
	const c = workspace.getConfiguration(SECTION);
	return {
		defaultProvider: c.get<ProviderId>("provider", "vscode-lm"),
		maxToolRounds: Math.max(1, c.get<number>("maxToolRounds", 16)),
		flashChanges: c.get<boolean>("flashChanges", true),
		selectChangedCells: c.get<boolean>("selectChangedCells", false),
		maxCellsInContext: Math.max(20, c.get<number>("maxCellsInContext", 400)),
		anthropic: {
			baseUrl: trimSlash(c.get<string>("anthropic.baseUrl", "https://api.anthropic.com")),
			model: c.get<string>("anthropic.model", ""),
			maxTokens: c.get<number>("anthropic.maxTokens", 8192),
		},
		openai: {
			baseUrl: trimSlash(c.get<string>("openai.baseUrl", "https://api.openai.com/v1")),
			model: c.get<string>("openai.model", ""),
			authHeader: c.get<"bearer" | "api-key">("openai.authHeader", "bearer"),
			supportsImages: c.get<boolean>("openai.supportsImages", true),
		},
	};
}

export type AiSettings = ReturnType<typeof getAiSettings>;

function trimSlash(s: string): string {
	return s.replace(/\/+$/, "");
}
