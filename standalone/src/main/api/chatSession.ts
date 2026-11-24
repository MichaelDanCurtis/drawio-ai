import type * as acp from "@agentclientprotocol/sdk";
import type { ChatSession, SessionHandlers, SessionInfo } from "../acpSession";
import { apiAgentId, type ApiAccess } from "./access";
import { ApiError, type ApiChat, type ApiImage, type ApiModel, type ApiProvider, type ApiToolResult } from "./chat";

/**
 * The diagram chat answered by a provider's model over its API instead of an agent program.
 *
 * To the chat it looks like an agent's session (acpSession.ts): it has models to pick from,
 * takes a request, says what it writes and which tools it calls, and asks before a tool that
 * changes something. What differs is where the work happens: there is no process, folder or
 * endpoint. The app offers the model the window's tools and runs them itself; the provider is
 * sent the request, the images attached to it and what the tools answer, and nothing else.
 *
 * (No Electron here: the chat gives it the app's API access and the window's tools.)
 */

/** A tool of the window's as a model is offered it. */
export interface ChatTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** false: it changes the diagram, writes a file or collects a map. The user is asked first. */
	readOnly: boolean;
	/** For a tool that reads with some arguments and changes with others: whether this call changes something. */
	changes?(args: Record<string, unknown>): boolean;
	/** It answers with a picture: a model that takes none is not offered it. */
	picture?: boolean;
}

export interface ChatTools {
	list(): ChatTool[];
	/** Runs one. `signal`: Stop was pressed. */
	call(name: string, args: unknown, signal: AbortSignal): Promise<ApiToolResult>;
}

/** Something only the user can put right, in Settings → Agents & models → API keys: a key, or which models are switched on. */
export class ApiSetupError extends Error {}

/** A provider as the chat lists it beside the agents. `detail` says in two words why it cannot be used as it is. */
export interface ApiChatAgent {
	id: string;
	label: string;
	hasKey: boolean;
	detail?: string;
	problem?: string;
}

/** The providers for the chat's list, the ones with a key first: usable when a key is kept. (The keychain is not asked.) */
export function apiChatAgents(access: ApiAccess): ApiChatAgent[] {
	const listed = access.providers.map((p): ApiChatAgent => {
		const hasKey = access.hasKey(p.id);
		const rejected = access.wasRejected(p.id);
		return {
			id: apiAgentId(p.id),
			label: p.label,
			hasKey,
			...(!hasKey
				? { detail: "no key", problem: `Add your ${p.company} API key in Settings → Agents & models → API keys to use it.` }
				: rejected
				? { detail: "key not accepted", problem: `${p.company} did not accept the saved API key. Check it in Settings → Agents & models → API keys.` }
				: {}),
		};
	});
	return [...listed.filter((a) => a.hasKey), ...listed.filter((a) => !a.hasKey)];
}

/** Numbers the tool calls of every session: a chat keeps its lines when its session is replaced, and finds them by these. */
let calls = 0;

/** `work`, or undefined as soon as `signal` says Stop (what `work` still does then is left to finish by itself). */
function unlessStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const stop = () => resolve(undefined);
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				resolve(value);
			},
			(e) => {
				signal.removeEventListener("abort", stop);
				reject(e);
			}
		);
	});
}

const ALLOW = "allow";
const ALLOW_CHAT = "allow_chat";
const OPTIONS: acp.PermissionOption[] = [
	{ optionId: ALLOW, name: "Allow", kind: "allow_once" },
	{ optionId: ALLOW_CHAT, name: "Always allow in this chat", kind: "allow_always" },
	{ optionId: "deny", name: "Deny", kind: "reject_once" },
];

/** A value as its schema describes it: an object or a list that came as JSON text is read. */
function asDescribed(schema: unknown, value: unknown): unknown {
	const says = (schema && typeof schema === "object" ? schema : {}) as { type?: unknown; properties?: Record<string, unknown>; items?: unknown };
	if (typeof value === "string" && (says.type === "object" || says.type === "array")) {
		try {
			const read = JSON.parse(value);
			if (says.type === "array" ? !Array.isArray(read) : !read || typeof read !== "object" || Array.isArray(read)) return value;
			value = read;
		} catch {
			// as it came: the tool says what is wrong with it
			return value;
		}
	}
	if (says.type === "array" && Array.isArray(value) && says.items) return value.map((v) => asDescribed(says.items, v));
	if (says.type === "object" && value && typeof value === "object" && !Array.isArray(value) && says.properties) {
		const properties = says.properties;
		return Object.fromEntries(Object.entries(value).map(([name, v]) => [name, Object.hasOwn(properties, name) ? asDescribed(properties[name], v) : v]));
	}
	return value;
}

/**
 * A tool's arguments as the tool takes them. A model may send an object or a list as JSON
 * text (Gemini is told to for an object of any shape, see gemini.ts): such text is read here,
 * at any depth. A tool that takes nothing gets nothing, whatever the model sent along.
 */
export function toolArguments(schema: Record<string, unknown>, args: unknown): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || !Object.keys(properties).length) return {};
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	return asDescribed({ ...schema, type: "object" }, args) as Record<string, unknown>;
}

/**
 * How long a conversation may grow, in characters of what was said, called and answered (about
 * a quarter as many tokens), before it is continued from a summary. The whole conversation goes
 * to the provider with every request: one that only grows costs more each time, and ends with
 * the provider refusing it. Well below what the models take, so that the summary can be asked for.
 */
export const SUMMARISE_AT = 240_000;
/** What a picture counts for in that measure. */
const PICTURE_SIZE = 6_000;
/** The longest summary that is carried over. */
const SUMMARY_MAX = 12_000;

/** What the model is asked when the conversation has grown long. Its answer is for itself: the user does not see it. */
export const SUMMARY_REQUEST =
	"This is not a request from the user. This conversation has grown long, and it will go on from a summary in place of its full text. Write that summary now, for yourself, as plain text of at most 400 words: what the user asked for and decided, what you did to the diagram and why, what is still open, and the names and ids you will need. The diagram itself can be read again with the tools, so do not copy it. Do not call any tool, and do not address the user.";

/** How a summary is handed to the conversation that goes on from it. */
export function withSummary(summary: string, request: string): string {
	return `<earlier_in_this_chat>\nThe conversation so far, in your own summary (its full text is not kept). Read the diagram again before you change it.\n\n${summary}\n</earlier_in_this_chat>\n\n${request}`;
}

export class ApiChatSession implements ChatSession {
	private started = false;
	private closed = false;
	/** The conversation, once a request has opened it; and the model it is held with (or the one picked for it). */
	private chat: ApiChat | undefined;
	private model: ApiModel | undefined;
	/** The request under way. */
	private stop: AbortController | undefined;
	/** Tools the user allowed for the rest of this chat. */
	private allowed = new Set<string>();
	/** The conversation being opened (a provider asked for its models, the keychain for the key). */
	private opening: Promise<ApiChat> | undefined;
	/** How much the conversation holds (see SUMMARISE_AT), and what the request under way adds to it. */
	private size = 0;
	private adding = 0;
	/** The size at which a summary is asked for next (moved on when one could not be had). */
	private summariseAt: number;
	/** What the model summed up of the conversation before this one; and its words while it writes one. */
	private summary: string | undefined;
	private summarising: string | undefined;

	constructor(
		private readonly o: {
			access: ApiAccess;
			provider: ApiProvider;
			/** What the model is told it is here for. */
			system(): string;
			tools: ChatTools;
			handlers: SessionHandlers;
			/** Tests: another size at which the conversation is summed up (SUMMARISE_AT). */
			summariseAt?: number;
		}
	) {
		this.summariseAt = o.summariseAt ?? SUMMARISE_AT;
	}

	/** The model a request goes to: the one picked or in use, else the one picked last, else the first the provider listed. */
	private current(): ApiModel | undefined {
		if (this.model) return this.model;
		const models = this.o.access.models(this.o.provider.id);
		const preferred = this.o.access.preferred(this.o.provider.id);
		return models.find((m) => m.value === preferred) ?? models[0];
	}

	/** The models to pick from: the ones switched on in Settings, and the one in use even when it no longer is. */
	private offered(): ApiModel[] {
		const models = this.o.access.models(this.o.provider.id);
		return this.model && !models.some((m) => m.value === this.model!.value) ? [this.model, ...models] : models;
	}

	public get label(): string {
		return this.current()?.name ?? this.o.provider.label;
	}

	/** What the chat reads a session's state from, in an agent session's terms: the models are its one option. */
	public get info(): SessionInfo | undefined {
		if (!this.started) return undefined;
		const current = this.current();
		const models = this.offered();
		const option = current && { id: "model", name: "Model", category: "model", type: "select", currentValue: current.value, options: models.map((m) => ({ value: m.value, name: m.name })) };
		return {
			sessionId: apiAgentId(this.o.provider.id),
			agentName: this.o.provider.label,
			configOptions: (option ? [option] : []) as acp.SessionConfigOption[],
			authMethods: [],
			images: current?.images !== false,
		};
	}

	private noKey(): ApiSetupError {
		return new ApiSetupError(`There is no ${this.o.provider.company} API key. Add one in Settings → Agents & models → API keys.`);
	}

	/**
	 * Ready when a key is kept. Nothing is asked of the keychain or the provider here: a window
	 * that opens with this chat must not bring up a keychain prompt. The key is read when a
	 * request is sent.
	 */
	public async start(): Promise<SessionInfo> {
		if (!this.o.access.hasKey(this.o.provider.id)) throw this.noKey();
		this.started = true;
		return this.info!;
	}

	public async authenticate(): Promise<SessionInfo> {
		throw new Error("An API key needs no sign-in.");
	}

	public async setMode(): Promise<void> {
		// (a model used through its API has no modes)
	}

	/**
	 * Picks another model. A conversation is held with one model: what a model wrote and thought
	 * is not something another can go on from, so the next request starts a new one.
	 */
	public async setConfigOption(configId: string, value: string): Promise<acp.SessionConfigOption[] | undefined> {
		if (configId !== "model") return undefined;
		const next = this.offered().find((m) => m.value === value);
		if (!next) throw new Error("That model is not offered any more.");
		if (next.value === this.current()?.value) {
			this.model = next;
			return this.info?.configOptions ?? undefined;
		}
		if (this.stop) throw new Error("press Stop first, then pick the model.");
		const held = !!this.chat && !this.chat.blank();
		this.chat = undefined;
		this.model = next;
		// (a summary is one model's own: the next one starts without it)
		this.summary = undefined;
		this.size = 0;
		this.summariseAt = this.o.summariseAt ?? SUMMARISE_AT;
		if (held) this.o.handlers.onNote?.(`Switched to ${next.name}: it starts a new conversation and does not know the earlier one.`);
		return this.info?.configOptions ?? undefined;
	}

	/**
	 * Opens the conversation: the model, then the key (read last: it is the one kept now).
	 * Asking the provider for its models or the keychain for the key can take a while, and Stop
	 * does not wait for it (see `prompt`): the user may pick another model meanwhile. The
	 * conversation is opened with the model that is picked when the key is there.
	 */
	private async open(): Promise<ApiChat> {
		const { access, provider } = this.o;
		for (;;) {
			if (this.chat) return this.chat;
			if (!access.hasKey(provider.id)) throw this.noKey();
			// (a key that was kept before its models could be listed: ask now; and once more when the key
			// was replaced while the provider was asked, which drops that answer)
			let failed: Awaited<ReturnType<ApiAccess["load"]>>;
			for (let tries = 0; tries < 2 && !failed && !access.listed(provider.id); tries++) failed = await access.load(provider.id);
			const model = this.current();
			if (!model) {
				if (access.listed(provider.id)) throw new ApiSetupError(`Every ${provider.company} model is switched off in Settings → Agents & models → API keys. Switch one on to use it.`);
				if (failed?.badKey) throw new ApiSetupError(failed.problem);
				throw new Error(failed?.problem ?? `${provider.company} listed no models for this key.`);
			}
			const kept = await access.keyFor(provider);
			if ("problem" in kept) throw new ApiSetupError(kept.problem);
			// (another model was picked while the keychain was asked: that one, not the one this began with)
			if (this.chat || this.current()?.value !== model.value) continue;
			const sees = model.images !== false;
			this.model = model;
			this.chat = provider.chat({
				apiKey: kept.key,
				model: model.value,
				system: this.o.system(),
				tools: this.o.tools
					.list()
					.filter((t) => sees || !t.picture)
					.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
				callTool: (name, args) => this.callTool(name, args),
				onText: (text) => {
					// (a summary is written for the model itself: it is kept, not shown)
					if (this.summarising !== undefined) return void (this.summarising += text);
					this.adding += text.length;
					this.tell({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
				},
				images: sees,
				baseURL: access.baseURL(provider.id),
			});
			return this.chat;
		}
	}

	private tell(update: acp.SessionUpdate): void {
		if (!this.closed) this.o.handlers.onUpdate(update);
	}

	/** Runs a tool the model called: shown in the chat, asked about first when it changes something. */
	private async callTool(name: string, args: unknown): Promise<ApiToolResult> {
		const signal = this.stop?.signal ?? AbortSignal.abort();
		// (a request that is over calls nothing more: nothing is shown, asked or run for it)
		if (signal.aborted || this.closed) return { text: "The user stopped the request.", isError: true };
		if (this.summarising !== undefined) return { text: "No tool is to be called for the summary: write it from what you know.", isError: true };
		const tool = this.o.tools.list().find((t) => t.name === name);
		if (!tool) return { text: `There is no tool called ${name}.`, isError: true };
		const input = toolArguments(tool.inputSchema, args);
		const toolCallId = `${apiAgentId(this.o.provider.id)}:${++calls}`;
		const ended = (ok: boolean) => this.tell({ sessionUpdate: "tool_call_update", toolCallId, title: name, status: ok ? "completed" : "failed" });
		this.tell({ sessionUpdate: "tool_call", toolCallId, title: name, rawInput: input, status: "pending" });
		if ((tool.changes ? tool.changes(input) : !tool.readOnly) && !this.allowed.has(name)) {
			const outcome = await this.o.handlers.requestPermission({ sessionId: apiAgentId(this.o.provider.id), toolCall: { toolCallId, title: name, rawInput: input }, options: OPTIONS }, signal);
			const chosen = outcome.outcome === "selected" ? outcome.optionId : undefined;
			if (chosen === ALLOW_CHAT) this.allowed.add(name);
			if (chosen !== ALLOW && chosen !== ALLOW_CHAT) {
				ended(false);
				return { text: signal.aborted ? "The user stopped the request." : "The user did not allow this call. Do not make it again unless they ask for it; say what you left undone.", isError: true };
			}
		}
		if (signal.aborted || this.closed) {
			ended(false);
			return { text: "The user stopped the request.", isError: true };
		}
		let result: ApiToolResult;
		try {
			result = await this.o.tools.call(name, input, signal);
		} catch (e: any) {
			result = { text: String(e?.message ?? e), isError: true };
		}
		ended(!result.isError);
		this.adding += JSON.stringify(input).length + result.text.length + (result.image ? PICTURE_SIZE : 0);
		return { text: result.text, ...(result.image ? { image: result.image } : {}), ...(result.isError ? { isError: true } : {}) };
	}

	public async prompt(blocks: acp.ContentBlock[]): Promise<acp.StopReason> {
		if (this.closed) return "cancelled";
		if (this.stop) throw new Error("Still working on the previous request.");
		const mine = (this.stop = new AbortController());
		const { access, provider } = this.o;
		try {
			// (opening can take a while, a provider asked for its models or a keychain prompt: Stop does not wait for it)
			let chat = await unlessStopped((this.opening ??= this.open().finally(() => (this.opening = undefined))), mine.signal);
			if (!chat || mine.signal.aborted) return "cancelled";
			// (grown long: it goes on from the model's own summary, in a conversation that starts with it)
			if (!chat.blank() && this.size >= this.summariseAt) {
				if ((await this.summarise(chat, mine.signal)) === "cancelled") return "cancelled";
				chat = await unlessStopped((this.opening ??= this.open().finally(() => (this.opening = undefined))), mine.signal);
				if (!chat || mine.signal.aborted) return "cancelled";
			}
			const request = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
			const images = blocks.flatMap((b): ApiImage[] => (b.type === "image" ? [{ mimeType: b.mimeType, base64: b.data }] : []));
			const held = !chat.blank();
			// (a conversation that starts, or was made to start over, holds nothing: what there is of the one before goes with the request)
			if (!held) this.size = 0;
			const text = !held && this.summary ? withSummary(this.summary, request) : request;
			this.adding = text.length + images.length * PICTURE_SIZE;
			try {
				const stopped = await chat.send(text, images, mine.signal);
				// (the provider answered: it accepts the key. A request that was stopped says nothing about that.)
				if (stopped !== "cancelled") access.noteRejected(provider.id, false);
				// (a request that was stopped or declined is forgotten whole by the conversation: it adds nothing)
				if (!chat.blank() && (stopped === "end_turn" || stopped === "max_tokens")) this.size += this.adding;
				return stopped;
			} catch (e) {
				if (e instanceof ApiError && e.badKey) {
					access.noteRejected(provider.id);
					throw new ApiSetupError(e.message);
				}
				// (a request the provider calls malformed makes the conversation start over, see chat.ts: say so)
				if (held && chat.blank()) this.o.handlers.onNote?.(`${this.label} no longer knows the earlier requests of this chat: the conversation with it started over.`);
				throw e;
			}
		} finally {
			if (this.stop === mine) this.stop = undefined;
		}
	}

	/**
	 * Has the model sum the conversation up, and drops the conversation for one that starts with
	 * that summary. When no summary can be had (the model declines, writes next to nothing, the
	 * provider fails) the conversation goes on as it is, and a summary is tried again when it
	 * has grown by a quarter.
	 */
	private async summarise(chat: ApiChat, signal: AbortSignal): Promise<"cancelled" | undefined> {
		this.summarising = "";
		let stopped: string | undefined;
		try {
			stopped = await chat.send(SUMMARY_REQUEST, [], signal);
		} catch {
			// as it is
		}
		const summary = (this.summarising ?? "").trim().slice(0, SUMMARY_MAX);
		this.summarising = undefined;
		if (stopped === "cancelled" || signal.aborted) return "cancelled";
		if (stopped !== "end_turn" || summary.length < 80) {
			// (what the model did answer stays in the conversation, as any finished exchange does)
			if (stopped === "end_turn" || stopped === "max_tokens") this.size += SUMMARY_REQUEST.length + summary.length;
			// (a conversation the provider made start over while asked is short again: the next request sees that)
			this.summariseAt = Math.round(this.size * 1.25);
			return undefined;
		}
		this.summary = summary;
		this.chat = undefined;
		this.summariseAt = this.o.summariseAt ?? SUMMARISE_AT;
		this.o.handlers.onNote?.(`This chat had grown long: ${this.label} summed it up for itself and goes on from that summary, so each request costs less. It reads the diagram again as it needs to.`);
		return undefined;
	}

	public cancel(): void {
		this.stop?.abort();
	}

	public dispose(): void {
		this.closed = true;
		this.stop?.abort();
		this.chat = undefined;
		this.allowed.clear();
	}
}
