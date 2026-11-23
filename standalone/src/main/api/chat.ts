/**
 * Models reached through a provider's API (Anthropic, OpenAI, Kimi) with the user's own key,
 * as an alternative to an agent program. This file is what the app sees of them: a provider
 * lists its models and opens a chat; a chat keeps its conversation and runs the tools the app
 * gives it until the model is done. (No Electron here, and no key storage: see keys.ts.)
 */

export type ApiProviderId = "anthropic" | "openai" | "kimi";

/** A tool the app offers the model (JSON Schema for its arguments). */
export interface ApiTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** What a tool answers. */
export interface ApiToolResult {
	text: string;
	image?: { mimeType: string; base64: string };
	isError?: boolean;
}

export interface ApiImage {
	mimeType: string;
	base64: string;
}

export interface ApiModel {
	value: string;
	name: string;
	/** false: the provider says this model takes no pictures (it is given words only). */
	images?: false;
}

/** Why a request ended: the model finished, was stopped, declined, or ran out of room. */
export type ApiStop = "end_turn" | "cancelled" | "refusal" | "max_tokens";

export interface ApiChatOptions {
	apiKey: string;
	model: string;
	/** What the model is here for (kept short: the request itself says what to do). */
	system: string;
	tools: ApiTool[];
	callTool(name: string, args: unknown): Promise<ApiToolResult>;
	/** What the model writes while it works, piece by piece. */
	onText(text: string): void;
	/** false: the model takes no pictures. One a tool returns is left out, and the model is told so. */
	images?: boolean;
	/** Another address for the provider's API (tests). */
	baseURL?: string;
}

/** One conversation with a model. */
export interface ApiChat {
	/**
	 * Sends a request and runs the model's tool calls until it is done. `signal` stops it. A
	 * request that is stopped, declined or fails is forgotten whole: half of one (a tool call
	 * without its answer) is a conversation the API refuses from then on.
	 */
	send(text: string, images: ApiImage[], signal: AbortSignal): Promise<ApiStop>;
	/** Nothing of an earlier request is kept: none was finished, or what there was has been forgotten. */
	blank(): boolean;
}

export interface ApiProvider {
	id: ApiProviderId;
	/** "Anthropic API". */
	label: string;
	/** Who issues the key, for the Settings page ("Anthropic"), and what a key starts with. */
	company: string;
	keyHint: string;
	/** The models this key can use, the ones to offer first at the top. */
	models(apiKey: string, options?: { baseURL?: string; signal?: AbortSignal }): Promise<ApiModel[]>;
	chat(options: ApiChatOptions): ApiChat;
}

/** How many times the model may come back with tool calls in one request. */
export const MAX_TOOL_ROUNDS = 24;

/** What a tool's answer says in place of a picture, for a model that takes none. */
export const NO_PICTURE = "(This model takes no pictures, so the picture is not shown to it.)";

/** A provider's own words, safe to show: one line, and never the key (a provider may quote it back). */
export function quoted(message: unknown, apiKey: string): string {
	const text = String(message ?? "");
	// (replaced before the line is cut: a key that straddles the cut would leave its beginning behind)
	return (apiKey ? text.split(apiKey).join("(the key)") : text).split("\n")[0].slice(0, 300);
}

/** What the provider itself said went wrong (an SDK's error puts the status and the whole answer in front of it). */
export function providerSaid(e: unknown): string {
	const body = (e as { error?: { message?: unknown; error?: { message?: unknown } } })?.error;
	const own = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : undefined;
	return own ?? String((e as { message?: unknown })?.message ?? e).replace(/^\d{3}\s+/, "");
}

/** An error with words for the user: what went wrong with the provider, and what to do. */
export class ApiError extends Error {
	/** `badKey`: the provider did not accept the key itself (such a key is not kept). */
	constructor(message: string, public readonly badKey = false) {
		super(message);
	}
}
