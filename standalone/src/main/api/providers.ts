import { anthropicProvider } from "./anthropic";
import type { ApiProvider } from "./chat";
import { geminiProvider } from "./gemini";
import { grokProvider } from "./grok";
import { kimiProvider } from "./kimi";
import { openAiProvider } from "./openai";
import { openRouterProvider } from "./openrouter";

/** The providers whose models the app can use with the user's own API key. */
export const API_PROVIDERS: ApiProvider[] = [anthropicProvider, openAiProvider, geminiProvider, grokProvider, kimiProvider, openRouterProvider];
