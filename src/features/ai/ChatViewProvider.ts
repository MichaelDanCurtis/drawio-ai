import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";
import { getAiSettings } from "./aiSettings";
import type { DiagramAgent } from "./DiagramAgent";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import type { ChatMessage, ModelInfo, ProviderId } from "./providers/types";
import { describeContext, SelectionContext } from "./systemPrompt";
import html from "./chatView.html";

type TranscriptItem =
	| { kind: "user"; text: string; scope?: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; id: string; summary: string; status: "running" | "ok" | "error" }
	| { kind: "error"; text: string; action?: { title: string; command: string } };

interface Conversation {
	messages: ChatMessage[];
	transcript: TranscriptItem[];
	version: number;
	running?: vscode.CancellationTokenSource;
}

const MODEL_STATE_KEY = "drawio-ai.selectedModel";
let versionCounter = 0;

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = "drawio-ai.chatView";

	private view: vscode.WebviewView | undefined;
	private readonly conversations = new Map<string, Conversation>();
	private readonly detached: Conversation = newConversation();
	private models: ModelInfo[] = [];
	private modelsError: string | undefined;
	private modelsLoading = false;
	private lassoActive = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly registry: ProviderRegistry,
		private readonly agent: DiagramAgent,
		private readonly getEditor: () => DrawioEditor | undefined
	) {}

	// ----- selection of provider / model -----

	private get selected(): { providerId: ProviderId; modelId?: string } {
		return (
			this.context.globalState.get(MODEL_STATE_KEY) ?? {
				providerId: getAiSettings().defaultProvider,
			}
		);
	}

	private async setSelected(value: { providerId: ProviderId; modelId?: string }) {
		await this.context.globalState.update(MODEL_STATE_KEY, value);
	}

	public async refreshModels(): Promise<void> {
		this.modelsLoading = true;
		this.modelsError = undefined;
		this.postState();
		try {
			this.models = await this.registry.get(this.selected.providerId).listModels();
			if (this.models.length === 0) {
				this.modelsError =
					this.selected.providerId === "vscode-lm"
						? "No models — sign in to Copilot"
						: "No models found";
			}
		} catch (e: any) {
			this.models = [];
			this.modelsError = String(e?.message ?? e);
		} finally {
			this.modelsLoading = false;
			this.postState();
		}
	}

	public async pickProviderAndModel(): Promise<void> {
		const provider = await vscode.window.showQuickPick(
			this.registry.providers.map((p) => ({ label: p.label, id: p.id })),
			{ title: "Draw.io AI provider" }
		);
		if (!provider) return;
		await this.setSelected({ providerId: provider.id });
		await this.refreshModels();
		if (this.models.length > 0) {
			const model = await vscode.window.showQuickPick(
				this.models.map((m) => ({ label: m.name, description: m.id, id: m.id })),
				{ title: "Model" }
			);
			if (model) await this.setSelected({ providerId: provider.id, modelId: model.id });
		}
		this.postState();
	}

	// ----- conversations -----

	private conversation(editor = this.getEditor()): Conversation {
		if (!editor) return this.detached;
		const key = editor.uri.toString();
		let c = this.conversations.get(key);
		if (!c) {
			c = newConversation();
			this.conversations.set(key, c);
		}
		return c;
	}

	public onActiveDiagramChanged(): void {
		this.postState();
	}

	public setLassoActive(active: boolean): void {
		this.lassoActive = active;
		this.postState();
	}

	public newChat(): void {
		const c = this.conversation();
		c.running?.cancel();
		c.messages = [];
		c.transcript = [];
		c.version = ++versionCounter;
		this.postState();
	}

	public async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
		this.view?.webview.postMessage({ type: "focusInput" });
	}

	// ----- webview -----

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [] };
		const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
			b.toString(16).padStart(2, "0")
		).join("");
		view.webview.html = (html as string)
			.replace(/\$\$nonce\$\$/g, nonce)
			.replace(/\$\$cspSource\$\$/g, view.webview.cspSource);

		view.onDidDispose(() => (this.view = undefined));
		view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
	}

	private async onMessage(msg: any): Promise<void> {
		switch (msg?.type) {
			case "ready":
				this.postState();
				if (this.models.length === 0 && !this.modelsLoading) void this.refreshModels();
				break;
			case "send":
				if (typeof msg.text === "string") await this.send(msg.text);
				break;
			case "stop":
				this.conversation().running?.cancel();
				break;
			case "newChat":
				this.newChat();
				break;
			case "lasso":
				this.getEditor()?.drawioClient.aiSetLassoMode(!this.lassoActive);
				break;
			case "askInDiagram":
				this.getEditor()?.drawioClient.aiOpenPrompt();
				break;
			case "review":
				if (msg.decision === "accept" || msg.decision === "reject") {
					this.getEditor()?.drawioClient.aiResolveReview(msg.decision);
				}
				break;
			case "pickProvider":
				await this.setSelected({ providerId: msg.providerId });
				this.models = [];
				await this.refreshModels();
				if (this.models[0]) {
					await this.setSelected({ providerId: msg.providerId, modelId: this.models[0].id });
					this.postState();
				}
				break;
			case "pickModel":
				await this.setSelected({ providerId: this.selected.providerId, modelId: msg.modelId });
				this.postState();
				break;
			case "command":
				if (typeof msg.command === "string" && msg.command.startsWith("drawio-ai.")) {
					await vscode.commands.executeCommand(msg.command);
				}
				break;
		}
	}

	private postState(): void {
		if (!this.view) return;
		const editor = this.getEditor();
		const c = this.conversation(editor);
		const selected = this.selected;
		this.view.webview.postMessage({
			type: "state",
			state: {
				file: editor ? decodeURIComponent(editor.uri.path.split("/").pop() ?? "") : undefined,
				selectionCount: editor?.drawioClient.currentSelection.length ?? 0,
				lassoActive: this.lassoActive,
				busy: !!c.running,
				transcript: c.transcript,
				transcriptVersion: c.version,
				providers: this.registry.providers.map((p) => ({ id: p.id, label: p.label })),
				providerId: selected.providerId,
				models: this.models,
				modelId: selected.modelId ?? this.models[0]?.id,
				modelsError: this.modelsError,
				modelsLoading: this.modelsLoading,
				review: editor?.drawioClient.pendingReview?.summary,
			},
		});
	}

	private push(c: Conversation, item: TranscriptItem): void {
		c.transcript.push(item);
		if (c === this.conversation()) this.view?.webview.postMessage({ type: "append", item });
	}

	// ----- running the agent -----

	public async send(text: string, origin?: SelectionContext): Promise<void> {
		const editor = this.getEditor();
		const c = this.conversation(editor);
		if (c.running) {
			this.push(c, { kind: "error", text: "Still working on the previous request — press Stop first." });
			return;
		}

		const selection: SelectionContext = origin ?? {
			cellIds: editor?.drawioClient.currentSelection ?? [],
		};
		const scope =
			selection.cellIds.length > 0
				? `${selection.viaLasso ? "◌ lasso" : "◉"} ${selection.cellIds.length} selected`
				: selection.region
				? "◌ empty area"
				: undefined;
		this.push(c, { kind: "user", text, scope });

		if (!editor) {
			this.push(c, {
				kind: "error",
				text: "Open a draw.io diagram first.",
				action: { title: "New Diagram", command: "drawio-ai.newDiagram" },
			});
			return;
		}

		const cts = new vscode.CancellationTokenSource();
		c.running = cts;
		this.view?.webview.postMessage({ type: "busy", busy: true });
		const isCurrent = () => c === this.conversation();
		let assistant: { kind: "assistant"; text: string } | undefined;
		const settings = getAiSettings();

		try {
			const { providerId, modelId } = this.selected;
			const client = await this.registry.get(providerId).getClient(modelId);
			editor.drawioClient.aiSetStatus(true, `${client.model.name} is editing…`);

			const { messages, error } = await this.agent.run({
				client,
				history: c.messages,
				userText: text,
				context: describeContext(decodeURIComponent(editor.uri.path.split("/").pop() ?? ""), selection),
				maxRounds: settings.maxToolRounds,
				token: cts.token,
				onRoundStart: () => (assistant = undefined),
				sink: {
					text: (chunk) => {
						if (!assistant) {
							assistant = { kind: "assistant", text: "" };
							c.transcript.push(assistant);
						}
						assistant.text += chunk;
						if (isCurrent()) this.view?.webview.postMessage({ type: "appendText", text: chunk });
					},
					toolStart: (call) => {
						assistant = undefined;
						this.push(c, { kind: "tool", id: call.id, summary: toolLabel(call.name), status: "running" });
					},
					toolEnd: (call, result) => {
						const item = c.transcript.find((t) => t.kind === "tool" && t.id === call.id);
						if (item && item.kind === "tool") {
							item.summary = result.summary;
							item.status = result.isError ? "error" : "ok";
						}
						if (isCurrent()) {
							this.view?.webview.postMessage({
								type: "tool",
								id: call.id,
								summary: result.summary,
								status: result.isError ? "error" : "ok",
							});
						}
					},
				},
			});
			c.messages.push(...messages);
			if (error) throw error;
			if (cts.token.isCancellationRequested) {
				this.push(c, { kind: "error", text: "Stopped." });
			}
		} catch (e: any) {
			const message = String(e?.message ?? e);
			const needsKey = /API key|401|403/i.test(message);
			this.push(c, {
				kind: "error",
				text: message,
				action: needsKey ? { title: "Set API Key", command: "drawio-ai.setApiKey" } : undefined,
			});
		} finally {
			c.running = undefined;
			cts.dispose();
			editor.drawioClient.aiSetStatus(false);
			if (isCurrent()) this.view?.webview.postMessage({ type: "busy", busy: false });
		}
	}
}

function newConversation(): Conversation {
	return { messages: [], transcript: [], version: ++versionCounter };
}

function toolLabel(name: string): string {
	switch (name) {
		case "drawio_get_diagram": return "Reading diagram…";
		case "drawio_apply_operations": return "Editing diagram…";
		case "drawio_find_cells": return "Searching cells…";
		case "drawio_select_cells": return "Selecting…";
		case "drawio_render_image": return "Rendering preview…";
		case "drawio_search_shapes": return "Searching shape libraries…";
		case "drawio_style_reference": return "Looking up styles…";
		default: return `${name}…`;
	}
}
