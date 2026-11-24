import type * as vscode from "vscode";
import type { CreatorAgent, CreatorImage, CreatorPorts, CreatorSession, CreatorTools } from "../../../standalone/src/main/workshop/creator";

/**
 * The Shape Creator in VS Code: the icon is drawn by a model VS Code itself offers (GitHub
 * Copilot's, or any other the user has added), through VS Code's language-model API. The
 * extension has no agent program to start and keeps no API key: VS Code asks the user, the
 * first time, whether Draw.AI may use the model, and the request is the user's own click.
 *
 * The model gets the Creator's two tools and nothing else (see CREATOR_TOOLS: one shows it a
 * picture of an SVG, one hands a finished icon in). They are answered here, by the Workshop:
 * nothing is run, no file is read, and the diagram is not touched until the user inserts.
 *
 * `api` is the part of the `vscode` module this needs, handed in so that the loop can be
 * tested without VS Code.
 */

export const LM_AGENT = "vscode-lm";

/** How many times the model may come back with tool calls in one request (a look, a hand-in, per variation, with room to retry). */
export const MAX_ROUNDS = 16;

const SYSTEM = "You draw icons as SVG for a diagramming app. You have two tools: one shows you a picture of an SVG, one hands a finished icon in. Follow the request's rules for the SVG exactly.";

type Api = Pick<typeof vscode, "lm" | "LanguageModelChatMessage" | "LanguageModelTextPart" | "LanguageModelToolCallPart" | "LanguageModelToolResultPart" | "CancellationTokenSource">;

export interface LmCreatorTool {
	name: string;
	description: string;
	inputSchema: object;
}

export class LmCreator {
	private models: vscode.LanguageModelChat[] = [];
	private asked = false;

	constructor(
		private readonly api: Api,
		private readonly tools: readonly LmCreatorTool[],
		/** The model picked last, kept by the extension. */
		private readonly preferred: { get(): string | undefined; set(id: string): void },
		/** The models on offer changed: the page is told. */
		private readonly changed: () => void
	) {}

	/** Asks VS Code which models there are (it does not ask the user anything, and sends nothing). */
	public async refresh(): Promise<void> {
		let models: vscode.LanguageModelChat[] = [];
		try {
			models = await this.api.lm.selectChatModels();
		} catch {
			// none
		}
		this.asked = true;
		const before = this.models.map((m) => m.id).join("\n");
		this.models = models;
		if (before !== models.map((m) => m.id).join("\n")) this.changed();
	}

	public get ports(): CreatorPorts {
		return {
			agents: () => this.agents(),
			open: async (o) => this.open(o),
		};
	}

	private agents(): CreatorAgent[] {
		// (the list is asked for the first time when the Creator is first looked at)
		if (!this.asked) void this.refresh();
		const models = this.models.map((m) => ({ value: m.id, name: nameOf(m) }));
		const picked = this.preferred.get();
		return [
			{
				id: LM_AGENT,
				kind: "api",
				label: "VS Code's models",
				ready: models.length > 0,
				missing: "none available",
				...(models.length ? {} : { problem: "VS Code offers no language model yet. Sign in to GitHub Copilot, or add another model provider in VS Code's chat, and it will be listed here." }),
				models,
				...(models.length ? { model: models.some((m) => m.value === picked) ? picked : models[0].value } : {}),
			},
		];
	}

	private async open(o: { agent: string; model?: string; tools: CreatorTools; onText(text: string): void }): Promise<CreatorSession> {
		if (o.agent !== LM_AGENT) throw new Error("That is not something Draw.AI can draw with here.");
		if (!this.models.length) await this.refresh();
		const picked = this.preferred.get();
		const model = this.models.find((m) => m.id === o.model) ?? this.models.find((m) => m.id === picked) ?? this.models[0];
		if (!model) throw new Error("VS Code offers no language model yet. Sign in to GitHub Copilot, or add another model provider in VS Code's chat.");
		if (o.model && model.id === o.model) this.preferred.set(model.id);
		return openLmSession(this.api, model, this.tools, o.tools, o.onText);
	}
}

function nameOf(m: vscode.LanguageModelChat): string {
	return `${m.name}${m.vendor ? ` · ${m.vendor}` : ""}`;
}

/** Whether the model takes pictures, as far as VS Code says, and VS Code can hand it one. */
function sees(api: Api, m: vscode.LanguageModelChat): boolean {
	return !!(api as any).LanguageModelDataPart?.image && !!(m as any).capabilities?.supportsImageToText;
}

/**
 * One conversation with a model, for drawing and for the changes asked of what it drew. A
 * request that is stopped or fails is forgotten whole (half of one, a tool call without its
 * answer, is a conversation a model refuses from then on): the next one starts from what was
 * there before it, or from nothing.
 */
export function openLmSession(api: Api, model: vscode.LanguageModelChat, offered: readonly LmCreatorTool[], tools: CreatorTools, onText: (text: string) => void): CreatorSession {
	const vision = sees(api, model);
	const picture = (image: CreatorImage) => (api as any).LanguageModelDataPart.image(Buffer.from(image.base64, "base64"), image.mimeType);
	let messages: vscode.LanguageModelChatMessage[] = [];
	let stop: vscode.CancellationTokenSource | undefined;
	let closed = false;
	return {
		label: `VS Code · ${nameOf(model)}`,
		images: vision,
		fresh: () => messages.length === 0,
		prompt: async (text, images) => {
			if (closed) return "cancelled";
			const mine = (stop = new api.CancellationTokenSource());
			const kept = messages;
			// (VS Code's API has no system role: what the model is here for leads the first request)
			const said: vscode.LanguageModelChatMessage[] = [...kept];
			said.push(api.LanguageModelChatMessage.User([new api.LanguageModelTextPart(kept.length ? text : `${SYSTEM}\n\n${text}`), ...(vision ? images.map(picture) : [])] as any));
			try {
				for (let round = 0; round < MAX_ROUNDS; round++) {
					const response = await model.sendRequest(said, { justification: "Draw.AI's Shape Creator draws the icon you described.", tools: offered.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }, mine.token);
					const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
					const calls: vscode.LanguageModelToolCallPart[] = [];
					for await (const part of response.stream) {
						if (part instanceof api.LanguageModelTextPart) {
							parts.push(part);
							if (!closed && part.value) onText(part.value);
						} else if (part instanceof api.LanguageModelToolCallPart) {
							parts.push(part);
							calls.push(part);
						}
					}
					if (mine.token.isCancellationRequested || closed) return "cancelled";
					if (parts.length) said.push(api.LanguageModelChatMessage.Assistant(parts));
					if (!calls.length) {
						messages = said;
						return "end_turn";
					}
					const answers: vscode.LanguageModelToolResultPart[] = [];
					for (const call of calls) {
						const known = offered.some((t) => t.name === call.name);
						const result = known ? await tools.call(call.name, call.input).catch((e: any) => ({ text: String(e?.message ?? e), isError: true as const })) : { text: `There is no tool called ${call.name}.`, isError: true as const };
						const content: unknown[] = [new api.LanguageModelTextPart(result.text)];
						if ("image" in result && result.image && vision) content.push(picture(result.image));
						answers.push(new api.LanguageModelToolResultPart(call.callId, content as any));
					}
					if (mine.token.isCancellationRequested || closed) return "cancelled";
					said.push(api.LanguageModelChatMessage.User(answers));
				}
				// (it went on calling tools: what it handed in is kept, the conversation is not)
				return "max_turn_requests";
			} catch (e: any) {
				if (mine.token.isCancellationRequested || closed) return "cancelled";
				throw new Error(`${model.name}: ${String(e?.message ?? e).split("\n")[0]}`);
			} finally {
				if (stop === mine) stop = undefined;
				mine.dispose();
			}
		},
		cancel: () => stop?.cancel(),
		dispose: () => {
			closed = true;
			stop?.cancel();
		},
	};
}
