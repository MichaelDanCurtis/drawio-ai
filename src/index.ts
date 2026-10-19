import * as vscode from "vscode";
import { MobxConsoleLogger } from "@knuddels/mobx-logger";
import * as mobx from "mobx";
import { Extension } from "./Extension";
import * as inlineEditor from "./inline-editor/extension";
import { createMarkdownCodeBlockEditorsApi } from "./codeblock-editor/markdownCodeBlockEditor";
import { registerUseForDiagramsCommand, warnAboutConflictingExtensions } from "./features/conflictingExtensions";

if (process.env.DEV === "1") {
	new MobxConsoleLogger(mobx);
}

export function activate(context: vscode.ExtensionContext) {
	// First: an older Draw.AI build makes the registrations below fail, and
	// Draw.io Integration takes over diagrams; both look like Draw.AI hanging.
	warnAboutConflictingExtensions(context);
	context.subscriptions.push(registerUseForDiagramsCommand());

	const extension = new Extension(context);
	context.subscriptions.push(extension);

	inlineEditor.activate(context);

	return {
		// VS Code's markdown preview looks this up on the extension exports.
		extendMarkdownIt,
		// VS Code's experimental Markdown editor looks this up for the
		// `markdown.codeBlockEditorProviders` contribution (Insiders only).
		markdownCodeBlockEditors: createMarkdownCodeBlockEditorsApi(
			context,
			extension.config,
			extension.log
		),
	};
}

export function deactivate() {}

export function extendMarkdownIt(md: any) {
	return inlineEditor.extendMarkdownIt(md);
}
