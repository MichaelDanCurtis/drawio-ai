import { anthropicProvider } from "./anthropic";
import type { ApiProvider } from "./chat";
import { kimiProvider } from "./kimi";
import { openAiProvider } from "./openai";

/** The providers whose models the app can use with the user's own API key. */
export const API_PROVIDERS: ApiProvider[] = [anthropicProvider, openAiProvider, kimiProvider];
