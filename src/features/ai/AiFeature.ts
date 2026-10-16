import * as vscode from "vscode";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import { SECRET_KEYS } from "./aiSettings";
import { ChatViewProvider } from "./ChatViewProvider";
import { registerChatParticipant, registerLanguageModelTools } from "./copilotIntegration";
import { DiagramAgent } from "./DiagramAgent";
import { DiagramToolbox } from "./DiagramToolbox";
import { ProviderRegistry } from "./providers/ProviderRegistry";

export class AiFeature {
	public readonly dispose = Disposable.fn();

	private readonly registry = new ProviderRegistry(this.context.secrets);
	private readonly toolbox = new DiagramToolbox(() => this.targetEditor());
	private readonly agent = new DiagramAgent(this.toolbox);
	private readonly chatView = new ChatViewProvider(
		this.context,
		this.registry,
		this.agent,
		() => this.targetEditor()
	);

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly editorService: DrawioEditorService
	) {
		const track = (d: vscode.Disposable | vscode.Disposable[]) =>
			(Array.isArray(d) ? d : [d]).forEach((x) => this.dispose.track(x));

		track(
			vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this.chatView, {
				webviewOptions: { retainContextWhenHidden: true },
			})
		);
		track(
			registerChatParticipant({
				agent: this.agent,
				toolbox: this.toolbox,
				getDiagram: () => {
					const editor = this.targetEditor();
					if (!editor) return undefined;
					return {
						fileName: fileName(editor),
						selection: { cellIds: editor.drawioClient.currentSelection },
						setBusy: (busy, text) => editor.drawioClient.aiSetStatus(busy, text),
						reviewPending: () => !!editor.drawioClient.pendingReview,
					};
				},
			})
		);
		track(registerLanguageModelTools(this.toolbox));

		this.dispose.track({
			dispose: autorun(() => {
				void this.editorService.lastActiveDrawioEditor;
				void this.editorService.activeDrawioEditor;
				this.chatView.onActiveDiagramChanged();
				this.onTargetReviewChanged();
			}),
		});
		this.dispose.track(
			this.editorService.onEditorOpened.sub(({ editor }) => this.hookEditor(editor))
		);
		for (const editor of this.editorService.openedEditors) {
			this.hookEditor(editor);
		}

		track([
			vscode.commands.registerCommand("drawio-ai.openChat", () => this.chatView.reveal()),
			vscode.commands.registerCommand("drawio-ai.newChat", () => this.chatView.newChat()),
			vscode.commands.registerCommand("drawio-ai.askAboutSelection", () => {
				const editor = this.targetEditor();
				if (editor) {
					editor.webviewPanel.reveal();
					editor.drawioClient.aiOpenPrompt();
				} else {
					void this.chatView.reveal();
				}
			}),
			vscode.commands.registerCommand("drawio-ai.lassoSelect", () => {
				const editor = this.targetEditor();
				if (editor) {
					editor.webviewPanel.reveal();
					editor.drawioClient.aiSetLassoMode(true);
				}
			}),
			vscode.commands.registerCommand("drawio-ai.selectModel", () =>
				this.chatView.pickProviderAndModel()
			),
			vscode.commands.registerCommand("drawio-ai.setApiKey", () => this.setApiKey()),
			vscode.commands.registerCommand("drawio-ai.acceptChanges", () =>
				this.targetEditor()?.drawioClient.aiResolveReview("accept")
			),
			vscode.commands.registerCommand("drawio-ai.rejectChanges", () =>
				this.targetEditor()?.drawioClient.aiResolveReview("reject")
			),
		]);
	}

	private onTargetReviewChanged(): void {
		const pending = !!this.targetEditor()?.drawioClient.pendingReview;
		void vscode.commands.executeCommand("setContext", "drawio-ai.reviewPending", pending);
		this.chatView.onActiveDiagramChanged();
	}

	/** The diagram the AI acts on: the focused one, else the one used most recently. */
	private targetEditor(): DrawioEditor | undefined {
		const active = this.editorService.activeDrawioEditor;
		if (active) return active;
		const last = this.editorService.lastActiveDrawioEditor;
		return last && this.editorService.openedEditors.has(last) ? last : undefined;
	}

	private hookEditor(editor: DrawioEditor): void {
		let lastLasso: { cellIds: string[]; region?: AiRect } | undefined;
		const subs = [
			editor.drawioClient.onSelectedCellsChanged.sub(() => {
				if (editor === this.targetEditor()) this.chatView.onActiveDiagramChanged();
			}),
			editor.drawioClient.onAiReview.sub(() => {
				if (editor === this.targetEditor()) this.onTargetReviewChanged();
			}),
			editor.drawioClient.onAiLasso.sub((evt) => {
				this.chatView.setLassoActive(evt.lassoModeEnabled);
				if (!evt.lassoModeEnabled && (evt.cellIds.length > 0 || evt.region)) {
					lastLasso = { cellIds: evt.cellIds, region: evt.region };
				}
			}),
			editor.drawioClient.onAiAsk.sub((evt) => {
				const viaLasso =
					!!lastLasso &&
					lastLasso.cellIds.length === evt.cellIds.length &&
					lastLasso.cellIds.every((id) => evt.cellIds.includes(id));
				lastLasso = undefined;
				void this.chatView.reveal();
				void this.chatView.send(evt.prompt, {
					cellIds: evt.cellIds,
					region: evt.region,
					viaLasso,
				});
			}),
		];
		editor.webviewPanel.onDidDispose(() => subs.forEach((s) => s.dispose()));
	}

	private async setApiKey(): Promise<void> {
		const pick = await vscode.window.showQuickPick(
			[
				{ label: "Anthropic", key: SECRET_KEYS.anthropic },
				{
					label: "OpenAI-compatible",
					description: "OpenAI, Azure OpenAI, OpenRouter, …",
					key: SECRET_KEYS.openai,
				},
			],
			{ title: "Set API key for" }
		);
		if (!pick) return;
		const value = await vscode.window.showInputBox({
			title: `${pick.label} API key`,
			prompt: "Stored in VS Code's secret storage. Leave empty to remove.",
			password: true,
			ignoreFocusOut: true,
		});
		if (value === undefined) return;
		if (value.trim()) {
			await this.context.secrets.store(pick.key, value.trim());
		} else {
			await this.context.secrets.delete(pick.key);
		}
		await this.chatView.refreshModels();
	}
}

function fileName(editor: DrawioEditor): string {
	return decodeURIComponent(editor.uri.path.split("/").pop() ?? "");
}
