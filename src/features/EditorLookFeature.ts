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
/** A map tour presentation mode can play (see standalone/src/renderer/presentation.js). */
export type PresentationTour = DesktopPresentationToursAction["tours"][number];

export class EditorLookFeature {
	public readonly dispose = Disposable.fn();

	/** The diagram's map tours, for presentation mode to offer (set by the Mapper). */
	public toursOf: ((editor: DrawioEditor) => Promise<PresentationTour[]>) | undefined;

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
		// A page that has just loaded was built with the look of the moment its HTML was made
		// (it is not made again when VS Code reloads a webview): bring it up to date.
		const loaded = client.onEditorToolsLoaded.sub(({ state }) => {
			const look = editor.config.look;
			// (with draw.io's themes that keep their own toolbar the page ignores what does not apply)
			if (state.icons !== look.icons || state.toolbar !== look.toolbar || state.matrix !== look.matrix) {
				client.setEditorPrefs({ iconStyle: look.icons, toolbar: look.toolbar, matrix: look.matrix });
			}
		});
		editor.webviewPanel.onDidDispose(() => {
			sub.dispose();
			loaded.dispose();
			stopPrefs();
		});
	}

	private async onCommand(editor: DrawioEditor, command: string): Promise<void> {
		switch (command) {
			case "present":
				editor.drawioClient.setPresenting(true);
				await this.sendTours(editor);
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

	/** Gives presentation mode the diagram's tours; with `play`, that tour goes first and starts. */
	private async sendTours(editor: DrawioEditor, play?: { mapId: string; title: string }): Promise<void> {
		let tours: PresentationTour[] = [];
		try {
			tours = (await this.toursOf?.(editor)) ?? [];
		} catch {
			// no maps to read: presentation mode works without tours
		}
		if (play) {
			const chosen = (t: PresentationTour) => (t.mapId === play.mapId && t.title === play.title ? 0 : 1);
			tours = [...tours].sort((a, b) => chosen(a) - chosen(b));
		}
		editor.drawioClient.setPresentationTours(tours, !!play);
	}

	/** Why presentation mode cannot start in this editor, or undefined when it can. */
	private async presentable(editor: DrawioEditor): Promise<{ presenting: boolean } | string> {
		if (!editor.config.look.editorTools) {
			return "Presentation mode is one of the editor tools. Turn on the setting Draw.AI › Look: Editor Tools.";
		}
		const state = await editor.drawioClient.editorLookState();
		return state ?? "Presentation mode is not available in this editor: it is still loading, it only shows the diagram (a read-only view), or it uses an online draw.io.";
	}

	/** Starts presentation mode in `editor` (when it is not on) and, with `tour`, plays that map tour. */
	public async present(editor: DrawioEditor, tour?: { mapId: string; title: string }): Promise<boolean> {
		const state = await this.presentable(editor);
		if (typeof state === "string") {
			void vscode.window.showInformationMessage(state);
			return false;
		}
		editor.webviewPanel.reveal();
		if (!state.presenting) {
			editor.drawioClient.setPresenting(true);
		}
		await this.sendTours(editor, tour);
		return true;
	}

	/** Draw.AI: Presentation Mode. Starts it in the diagram used last, or leaves it. */
	private async togglePresentation(): Promise<void> {
		const editor = this.editorService.targetDrawioEditor;
		if (!editor) {
			void vscode.window.showInformationMessage("Open a diagram first: presentation mode shows the diagram used last.");
			return;
		}
		const state = await this.presentable(editor);
		if (typeof state === "string") {
			void vscode.window.showInformationMessage(state);
			return;
		}
		editor.webviewPanel.reveal();
		editor.drawioClient.setPresenting(!state.presenting);
		if (!state.presenting) {
			await this.sendTours(editor);
		}
	}
}
