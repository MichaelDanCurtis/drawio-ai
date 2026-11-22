import * as vscode from "vscode";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../DrawioEditorService";
import { registerFailableCommand } from "../utils/registerFailableCommand";

/**
 * The host of the editor tools the diagram editor shares with the desktop app (the toolbar
 * buttons, the look, presentation mode: see editorLook.ts). The tools are draw.io plugins in
 * the editor's page; this answers their buttons and keeps the open editors in step with the
 * settings.
 */
export class EditorLookFeature {
	public readonly dispose = Disposable.fn();

	constructor(
		private readonly editorService: DrawioEditorService,
		private readonly extensionId: string
	) {
		this.dispose.track(editorService.onEditorOpened.sub(({ editor }) => this.hookEditor(editor)));
		for (const editor of editorService.openedEditors) {
			this.hookEditor(editor);
		}
		this.dispose.track(registerFailableCommand("drawio-ai.present", () => this.togglePresentation()));
		// For tests and bug reports: what the editor tools of the diagram used last show.
		this.dispose.track(
			vscode.commands.registerCommand("drawio-ai.editorLookState", () => this.editorService.targetDrawioEditor?.drawioClient.editorLookState())
		);
	}

	private hookEditor(editor: DrawioEditor): void {
		const client = editor.drawioClient;
		const sub = client.onEditorCommand.sub(({ command }) => void this.onCommand(editor, command));
		// Icons, the matrix and the toolbar's place change in the open editor: nothing is loaded
		// again, so zoom and undo stay. (A new page starts with them: DrawioClientFactory.)
		let sent: string | undefined;
		const stopPrefs = autorun(
			() => {
				const look = editor.config.look;
				const prefs = { iconStyle: look.icons, toolbar: look.toolbar, matrix: look.matrix };
				const key = JSON.stringify(prefs);
				if (sent !== undefined && sent !== key) {
					client.setEditorPrefs(prefs);
				}
				sent = key;
			},
			{ name: "Editor look" }
		);
		editor.webviewPanel.onDidDispose(() => {
			sub.dispose();
			stopPrefs();
		});
	}

	private async onCommand(editor: DrawioEditor, command: string): Promise<void> {
		switch (command) {
			case "present":
				editor.drawioClient.setPresenting(true);
				break;
			case "exitPresentation":
				editor.drawioClient.setPresenting(false);
				break;
			case "settings":
				await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.extensionId} look`);
				break;
			case "toggleChat":
				await vscode.commands.executeCommand("drawio-ai.openChat");
				break;
			default:
				// A button the desktop app has and the extension does not (yet).
				break;
		}
	}

	/** Draw.AI: Presentation Mode. Starts it in the diagram used last, or leaves it. */
	private async togglePresentation(): Promise<void> {
		const editor = this.editorService.targetDrawioEditor;
		if (!editor) {
			void vscode.window.showInformationMessage("Open a diagram first: presentation mode shows the diagram used last.");
			return;
		}
		if (!editor.config.look.editorTools) {
			void vscode.window.showInformationMessage("Presentation mode is one of the editor tools. Turn on the setting Draw.AI › Look: Editor Tools.");
			return;
		}
		const state = await editor.drawioClient.editorLookState();
		if (!state) {
			void vscode.window.showInformationMessage("Presentation mode is not ready in this editor: it is still loading, or it only shows the diagram (a read-only view).");
			return;
		}
		editor.webviewPanel.reveal();
		editor.drawioClient.setPresenting(!state.presenting);
	}
}
