import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";
import { getAiSettings } from "./aiSettings";
import type { DiagramAgent } from "./DiagramAgent";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import type { AiModelClient, ChatMessage, ImageData, ModelInfo, ProviderId } from "./providers/types";
import { describeContext, SelectionContext } from "./systemPrompt";
import html from "./chatView.html";
import { MAX_IMAGES, MAX_PICKED_IMAGE_BASE64, readImage, sanitizeImages } from "./images";
import { ChatStore, TranscriptItem } from "./chatStore";

interface Conversation {
	messages: ChatMessage[];
	transcript: TranscriptItem[];
	version: number;
	running?: vscode.CancellationTokenSource;
	/** Diagram URI, for conversations that belong to a diagram (and are persisted). */
	key?: string;
	/** Resolves once the saved chat for this diagram has been restored. */
	loading?: Promise<void>;
}

const MODEL_STATE_KEY = "drawio-ai.selectedModel";

export interface SendExtras {
	images?: ImageData[];
	/** Large hidden inputs (e.g. code analysis); the transcript only shows `name`. */
	attachments?: { name: string; text: string }[];
	/** Target diagram; defaults to the active one. */
	editor?: DrawioEditor;
}

export interface TemplateInfo {
	name: string;
	prompt: string;
}
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
	private templateName: string | undefined;
	private templateRequest = 0;
	private readonly store: ChatStore;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly registry: ProviderRegistry,
		private readonly agent: DiagramAgent,
		private readonly getEditor: () => DrawioEditor | undefined,
		private readonly getTemplate: (editor: DrawioEditor | undefined) => Promise<TemplateInfo | undefined> = async () => undefined
	) {
		const base = context.storageUri ?? context.globalStorageUri;
		this.store = new ChatStore(base && vscode.Uri.joinPath(base, "chats"));
	}

	/** The client for the provider/model picked in this panel. */
	public async currentClient(): Promise<AiModelClient> {
		const { providerId, modelId } = this.selected;
		return this.registry.get(providerId).getClient(modelId);
	}

	// ----- selection of provider / model -----

	/** Whether the panel uses VS Code's models (Copilot, ...) rather than the user's own API keys. */
	public usesVsCodeModels(): boolean {
		return this.selected.providerId === "vscode-lm";
	}

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
			{ title: "Draw.AI provider" }
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
			c = { ...newConversation(), key };
			c.loading = this.restore(c);
			this.conversations.set(key, c);
		}
		return c;
	}

	private async restore(c: Conversation): Promise<void> {
		if (!c.key || !getAiSettings().persistChat) return;
		const version = c.version;
		const stored = await this.store.load(c.key);
		// "New chat" while loading wins over the restored conversation.
		if (c.version !== version || !stored || (stored.messages.length === 0 && stored.transcript.length === 0)) return;
		const when = new Date(stored.savedAt);
		c.messages = [...stored.messages, ...c.messages];
		c.transcript = [
			...stored.transcript,
			{ kind: "note", text: `Restored conversation from ${isNaN(when.getTime()) ? "an earlier session" : when.toLocaleString()}` },
			...c.transcript,
		];
		c.version = ++versionCounter;
		if (c === this.conversation()) this.postState();
	}

	private persist(c: Conversation): void {
		if (c.key && getAiSettings().persistChat) void this.store.save(c.key, c.messages, c.transcript);
	}

	public onActiveDiagramChanged(): void {
		this.postState();
		void this.refreshTemplate();
	}

	public async refreshTemplate(): Promise<void> {
		const request = ++this.templateRequest;
		const info = await this.getTemplate(this.getEditor()).catch(() => undefined);
		if (request !== this.templateRequest || info?.name === this.templateName) return;
		this.templateName = info?.name;
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
		if (c.key) void this.store.delete(c.key);
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
			case "send": {
				const images = sanitizeImages(msg.images);
				if (typeof msg.text === "string" && (msg.text.trim() || images.length)) {
					await this.send(msg.text.trim() || DEFAULT_IMAGE_PROMPT, undefined, { images });
				}
				break;
			}
			case "pickImage": {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: true,
					openLabel: "Attach",
					filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
				});
				const images = await Promise.all(
					(picked ?? []).slice(0, MAX_IMAGES).map((uri) =>
						readImage(uri, MAX_PICKED_IMAGE_BASE64).catch((e) => {
							void vscode.window.showErrorMessage(String(e?.message ?? e));
							return undefined;
						})
					)
				);
				this.view?.webview.postMessage({ type: "addImages", images: images.filter(Boolean) });
				break;
			}
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
				template: this.templateName,
			},
		});
	}

	private push(c: Conversation, item: TranscriptItem): void {
		c.transcript.push(item);
		if (c === this.conversation()) this.view?.webview.postMessage({ type: "append", item });
	}

	// ----- running the agent -----

	public async send(text: string, origin?: SelectionContext, extras: SendExtras = {}): Promise<void> {
		const editor = extras.editor ?? this.getEditor();
		const c = this.conversation(editor);
		await c.loading;
		if (c.running) {
			this.push(c, { kind: "error", text: "Still working on the previous request — press Stop first." });
			return;
		}

		const selection: SelectionContext = origin ?? {
			cellIds: editor?.drawioClient.currentSelection ?? [],
		};
		const scope =
			selection.source === "markup"
				? `✎ ${selection.markCount ?? ""} mark${selection.markCount === 1 ? "" : "s"}`
				: selection.source === "image"
				? "🖼 image → diagram"
				: selection.cellIds.length > 0
				? `${selection.viaLasso ? "◌ lasso" : "◉"} ${selection.cellIds.length} selected`
				: selection.region
				? "◌ empty area"
				: undefined;
		const attached = [
			...(extras.images?.length ? [`🖼 ${extras.images.length} image${extras.images.length === 1 ? "" : "s"}`] : []),
			...(extras.attachments ?? []).map((a) => `📎 ${a.name}`),
		];
		this.push(c, { kind: "user", text, scope, attachments: attached.length ? attached : undefined });

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
			const client = await this.currentClient();
			const template = await this.getTemplate(editor).catch(() => undefined);
			editor.drawioClient.aiSetStatus(true, `${client.model.name} is editing…`);

			const { messages, error } = await this.agent.run({
				client,
				history: c.messages,
				userText: text,
				context: describeContext(decodeURIComponent(editor.uri.path.split("/").pop() ?? ""), selection),
				systemExtra: template?.prompt,
				images: extras.images,
				attachments: extras.attachments,
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
			this.persist(c);
			editor.drawioClient.aiSetStatus(false);
			if (isCurrent()) this.view?.webview.postMessage({ type: "busy", busy: false });
		}
	}
}

export const DEFAULT_IMAGE_PROMPT =
	"Recreate the attached sketch/screenshot as an editable diagram: same shapes, labels, connections and overall layout, using proper draw.io shapes (search the shape libraries for recognisable icons). Place it in empty space on the page, then render it to compare with the original.";

function newConversation(): Conversation {
	return { messages: [], transcript: [], version: ++versionCounter };
}

function toolLabel(name: string): string {
	switch (name) {
		case "drawio_get_diagram": return "Reading diagram…";
		case "drawio_apply_operations": return "Editing diagram…";
		case "drawio_find_cells": return "Searching cells…";
		case "drawio_select_cells": return "Selecting…";
		case "drawio_pages": return "Working on pages…";
		case "drawio_render_image": return "Rendering preview…";
		case "drawio_search_shapes": return "Searching shape libraries…";
		case "drawio_style_reference": return "Looking up styles…";
		case "drawio_lint": return "Checking the diagram…";
		case "drawio_get_template": return "Reading the design template…";
		case "drawio_code_links": return "Checking code links…";
		case "drawio_export": return "Exporting…";
		case "drawio_import": return "Importing…";
		case "drawio_get_attachment": return "Reading the attachment…";
		default: return `${name}…`;
	}
}
