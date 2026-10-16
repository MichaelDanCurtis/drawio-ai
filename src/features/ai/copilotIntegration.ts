import * as vscode from "vscode";
import type { DiagramAgent } from "./DiagramAgent";
import type { DiagramToolbox } from "./DiagramToolbox";
import type { ChatMessage } from "./providers/types";
import { VsCodeLmClient } from "./providers/VsCodeLmProvider";
import { describeContext, SelectionContext } from "./systemPrompt";
import { getAiSettings } from "./aiSettings";
import { TOOL_SCHEMAS } from "./toolSchemas";

const COMMAND_PROMPTS: Record<string, string> = {
	layout:
		"Tidy up the layout: remove overlaps, align related shapes, make edges readable. Keep all content and styles. Use a layout op when it fits the diagram type, otherwise move shapes explicitly.",
	explain: "Explain what this diagram shows. Do not modify it.",
	selection: "Apply the following change ONLY to the selected items:",
	style: "Improve the visual style consistently (colours per concept, fonts, edge styles) without changing structure:",
};

export interface ParticipantDeps {
	agent: DiagramAgent;
	toolbox: DiagramToolbox;
	getDiagram():
		| {
				fileName: string;
				selection: SelectionContext;
				setBusy(busy: boolean, text?: string): void;
				reviewPending(): boolean;
		  }
		| undefined;
}

/** `@drawio` in Copilot Chat, driven by whichever model the user picked in the chat UI. */
export function registerChatParticipant(deps: ParticipantDeps): vscode.Disposable {
	const participant = vscode.chat.createChatParticipant(
		"drawio-ai.participant",
		async (request, context, response, token) => {
			const diagram = deps.getDiagram();
			if (!diagram) {
				response.markdown("Open a draw.io diagram (`.drawio`, `.drawio.svg`, `.drawio.png`) first, then ask again.");
				response.button({ command: "drawio-ai.newDiagram", title: "New Diagram" });
				return;
			}

			const prefix = request.command ? COMMAND_PROMPTS[request.command] : undefined;
			const userText = [prefix, request.prompt].filter(Boolean).join("\n") || "Continue.";

			diagram.setBusy(true, `${request.model.name} is editing…`);
			try {
				const { error } = await deps.agent.run({
					client: new VsCodeLmClient(request.model),
					history: historyFromContext(context),
					userText,
					context: describeContext(diagram.fileName, diagram.selection),
					maxRounds: getAiSettings().maxToolRounds,
					token,
					sink: {
						text: (t) => response.markdown(t),
						toolStart: (call) => response.progress(progressLabel(call.name)),
						toolEnd: () => {},
					},
				});
				if (error) {
					response.markdown(`\n\n**Error:** ${String((error as any)?.message ?? error)}`);
				}
				if (diagram.reviewPending()) {
					response.button({ command: "drawio-ai.acceptChanges", title: "Accept Changes" });
					response.button({ command: "drawio-ai.rejectChanges", title: "Reject Changes" });
				}
			} finally {
				diagram.setBusy(false);
			}
			return {};
		}
	);
	participant.iconPath = new vscode.ThemeIcon("sparkle");
	return participant;
}

function progressLabel(tool: string): string {
	switch (tool) {
		case "drawio_get_diagram": return "Reading the diagram…";
		case "drawio_apply_operations": return "Editing the diagram…";
		case "drawio_search_shapes": return "Searching shape libraries…";
		case "drawio_render_image": return "Checking the rendered result…";
		default: return "Working…";
	}
}

function historyFromContext(context: vscode.ChatContext): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			out.push({ role: "user", parts: [{ type: "text", text: turn.prompt }] });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ""))
				.join("");
			if (text) {
				out.push({ role: "assistant", parts: [{ type: "text", text }] });
			}
		}
	}
	return out;
}

/** Exposes the same tools to Copilot agent mode and any other LM tool consumer. */
export function registerLanguageModelTools(toolbox: DiagramToolbox): vscode.Disposable[] {
	const DataPart: any = (vscode as any).LanguageModelDataPart;
	return TOOL_SCHEMAS.map((schema) =>
		vscode.lm.registerTool<Record<string, unknown>>(schema.name, {
			prepareInvocation: () => ({
				invocationMessage: progressLabel(schema.name),
			}),
			invoke: async (options) => {
				const result = await toolbox.invoke(schema.name, options.input);
				const content: unknown[] = [new vscode.LanguageModelTextPart(result.text)];
				if (result.image && DataPart?.image) {
					const bytes = Uint8Array.from(atob(result.image.base64), (c) => c.charCodeAt(0));
					content.push(DataPart.image(bytes, result.image.mimeType));
				}
				return new vscode.LanguageModelToolResult(content as vscode.LanguageModelTextPart[]);
			},
		})
	);
}
