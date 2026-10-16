import type { SecretStorage } from "vscode";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAiProvider } from "./OpenAiProvider";
import { AiProvider, ProviderId } from "./types";
import { VsCodeLmProvider } from "./VsCodeLmProvider";

export class ProviderRegistry {
	public readonly providers: readonly AiProvider[];

	constructor(secrets: SecretStorage) {
		this.providers = [
			new VsCodeLmProvider(),
			new AnthropicProvider(secrets),
			new OpenAiProvider(secrets),
		];
	}

	get(id: ProviderId): AiProvider {
		const p = this.providers.find((p) => p.id === id);
		if (!p) {
			throw new Error(`Unknown provider ${id}`);
		}
		return p;
	}
}
