import type { CancellationToken } from "vscode";
import type { DiagramToolbox, ToolResult } from "./DiagramToolbox";
import type { AiModelClient, ChatMessage, ChatPart } from "./providers/types";
import { SYSTEM_PROMPT } from "./systemPrompt";

export interface AgentSink {
	text(chunk: string): void;
	toolStart(call: { id: string; name: string; input: unknown }): void;
	toolEnd(call: { id: string; name: string }, result: ToolResult): void;
}

export interface AgentRun {
	client: AiModelClient;
	/** Prior conversation; not mutated. */
	history: readonly ChatMessage[];
	userText: string;
	/** Per-turn context (open file, selection); sent with this turn only. */
	context: string;
	sink: AgentSink;
	token: CancellationToken;
	maxRounds: number;
	onRoundStart?(round: number): void;
}

/**
 * Tool-calling loop shared by the chat panel and the @drawio participant.
 * Every assistant tool call is always answered by a tool result (even on
 * cancellation or error) so the persisted history never contains orphans.
 */
export class DiagramAgent {
	constructor(private readonly toolbox: DiagramToolbox) {}

	/** Returns the messages produced by this turn (user turn included); never throws. */
	public async run(run: AgentRun): Promise<{ messages: ChatMessage[]; error?: unknown }> {
		const produced: ChatMessage[] = [
			{
				role: "user",
				parts: [{ type: "text", text: `<context>\n${run.context}\n</context>\n\n${run.userText}` }],
			},
		];
		const tools = this.toolbox.specs({ vision: run.client.model.vision });

		for (let round = 0; round < run.maxRounds; round++) {
			if (run.token.isCancellationRequested) {
				break;
			}
			run.onRoundStart?.(round);

			const assistantParts: ChatPart[] = [];
			let text = "";
			const calls: { id: string; name: string; input: unknown }[] = [];
			try {
				for await (const evt of run.client.stream(
					{ system: SYSTEM_PROMPT, messages: [...compact(run.history), ...produced], tools },
					run.token
				)) {
					if (evt.type === "text") {
						text += evt.text;
						run.sink.text(evt.text);
					} else {
						calls.push({ id: evt.id, name: evt.name, input: evt.input });
					}
				}
			} catch (e) {
				if (text) {
					produced.push({ role: "assistant", parts: [{ type: "text", text }] });
				}
				if (run.token.isCancellationRequested) {
					break;
				}
				return { messages: produced, error: e };
			}

			if (text) {
				assistantParts.push({ type: "text", text });
			}
			for (const c of calls) {
				assistantParts.push({ type: "toolCall", ...c });
			}
			if (assistantParts.length === 0) {
				assistantParts.push({ type: "text", text: "(no response)" });
			}
			produced.push({ role: "assistant", parts: assistantParts });

			if (calls.length === 0) {
				return { messages: produced };
			}

			const results: ChatPart[] = [];
			for (const call of calls) {
				let result: ToolResult;
				if (run.token.isCancellationRequested) {
					result = { text: "Cancelled by the user.", summary: "Cancelled", isError: true };
				} else {
					run.sink.toolStart(call);
					result = await this.toolbox.invoke(call.name, call.input);
					run.sink.toolEnd(call, result);
				}
				results.push({
					type: "toolResult",
					callId: call.id,
					name: call.name,
					text: result.text,
					image: result.image,
					isError: result.isError,
				});
			}
			produced.push({ role: "user", parts: results });
		}

		if (!run.token.isCancellationRequested) {
			const note = `\n\n_Stopped after ${run.maxRounds} tool rounds. Say "continue" to keep going._`;
			run.sink.text(note);
			produced.push({ role: "assistant", parts: [{ type: "text", text: note.trim() }] });
		}
		return { messages: produced };
	}
}

const KEEP_FULL_TURNS = 2;
const MAX_OLD_RESULT_CHARS = 1500;

/** Shrinks tool results and drops images from older turns to save tokens. */
function compact(history: readonly ChatMessage[]): ChatMessage[] {
	const userTurnStarts = history
		.map((m, i) => (m.role === "user" && m.parts.some((p) => p.type === "text") ? i : -1))
		.filter((i) => i >= 0);
	const cutoff = userTurnStarts[userTurnStarts.length - KEEP_FULL_TURNS] ?? 0;
	return history.map((m, i) =>
		i >= cutoff
			? m
			: {
					role: m.role,
					parts: m.parts.map((p) =>
						p.type === "toolResult"
							? {
									...p,
									image: undefined,
									text:
										p.text.length > MAX_OLD_RESULT_CHARS
											? p.text.slice(0, MAX_OLD_RESULT_CHARS) + "…[older result truncated; re-read the diagram for current state]"
											: p.text,
							  }
							: p
					),
			  }
	);
}
