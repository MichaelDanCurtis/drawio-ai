import * as vscode from "vscode";

/**
 * Draw.io Integration (the extension Draw.AI is forked from) registers its own
 * default editor for the same files. With both enabled, VS Code opens diagrams
 * in Draw.io Integration, where Draw.AI's lasso, review and AI tools never load.
 */
export const UPSTREAM_EXTENSION = { id: "hediet.vscode-drawio", name: "Draw.io Integration" };

/** Earlier builds of Draw.AI under other ids: they register the same commands and editors. */
export const OLD_BUILDS = ["drawio-ai.draw-ai", "drawio-ai.vscode-drawio-ai"];

/** Draw.AI's editor for each draw.io file pattern (package.json `customEditors`). */
export const DRAWIO_EDITOR_ASSOCIATIONS: Readonly<Record<string, string>> = {
	"*.drawio": "drawio-ai-text",
	"*.dio": "drawio-ai-text",
	"*.drawio.svg": "drawio-ai-text",
	"*.dio.svg": "drawio-ai-text",
	"*.drawio.png": "drawio-ai",
	"*.dio.png": "drawio-ai",
};

const OTHER_EDITOR = /^hediet\.vscode-drawio/;
const DONT_SHOW_KEY = "drawio-ai.conflictNotice.dismissed";
export const USE_FOR_DIAGRAMS_COMMAND = "drawio-ai.useForDiagrams";

function associations(): Record<string, string> {
	const value = vscode.workspace.getConfiguration("workbench").get<unknown>("editorAssociations");
	if (Array.isArray(value)) {
		// Older array form: [{ filenamePattern, viewType }].
		return Object.fromEntries(value.filter((a) => a?.filenamePattern && a?.viewType).map((a) => [a.filenamePattern, a.viewType]));
	}
	return value && typeof value === "object" ? { ...(value as Record<string, string>) } : {};
}

/** Whether every draw.io file type is already set to open in Draw.AI. */
export function drawAiOpensDiagrams(): boolean {
	const current = associations();
	return Object.entries(DRAWIO_EDITOR_ASSOCIATIONS).every(([pattern, viewType]) => current[pattern] === viewType);
}

/** A diagram that is open in Draw.io Integration's editor, if any (Draw.AI's tools cannot reach it). */
export function diagramOpenInOtherEditor(): vscode.Uri | undefined {
	for (const group of vscode.window?.tabGroups?.all ?? []) {
		for (const tab of group.tabs) {
			const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
			if (input?.viewType && OTHER_EDITOR.test(input.viewType) && input.uri) {
				return input.uri;
			}
		}
	}
	return undefined;
}

/**
 * `Draw.AI: Use Draw.AI for Diagram Files`: makes Draw.AI the editor for draw.io
 * files (user settings), then reopens diagrams that are open in the other editor.
 */
export async function useDrawAiForDiagrams(): Promise<{ reopened: number; skippedDirty: number }> {
	await vscode.workspace
		.getConfiguration("workbench")
		.update("editorAssociations", { ...associations(), ...DRAWIO_EDITOR_ASSOCIATIONS }, vscode.ConfigurationTarget.Global);
	let reopened = 0;
	let skippedDirty = 0;
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
			if (!input?.viewType || !OTHER_EDITOR.test(input.viewType) || !input.uri) continue;
			if (tab.isDirty) {
				// Closing would ask about unsaved changes; leave it to the user.
				skippedDirty++;
				continue;
			}
			const viewType = input.viewType.endsWith("-text") ? "drawio-ai-text" : "drawio-ai";
			await vscode.window.tabGroups.close(tab);
			await vscode.commands.executeCommand("vscode.openWith", input.uri, viewType, { viewColumn: group.viewColumn });
			reopened++;
		}
	}
	return { reopened, skippedDirty };
}

export function registerUseForDiagramsCommand(): vscode.Disposable {
	return vscode.commands.registerCommand(USE_FOR_DIAGRAMS_COMMAND, async () => {
		const { reopened, skippedDirty } = await useDrawAiForDiagrams();
		const parts = ["Draw.io files now open in Draw.AI."];
		if (reopened) parts.push(`Reopened ${reopened} diagram${reopened === 1 ? "" : "s"}.`);
		if (skippedDirty) parts.push(`Save or close ${skippedDirty} diagram${skippedDirty === 1 ? "" : "s"} with unsaved changes in the other editor, then open again.`);
		void vscode.window.showInformationMessage(parts.join(" "));
		return { reopened, skippedDirty };
	});
}

/**
 * Called first thing on activation: explains conflicts with other draw.io
 * extensions before they make Draw.AI look broken or slow.
 */
export function warnAboutConflictingExtensions(context: vscode.ExtensionContext): void {
	const self = context.extension.id.toLowerCase();
	const oldBuilds = OLD_BUILDS.filter((id) => id !== self)
		.map((id) => vscode.extensions.getExtension(id))
		.filter((e): e is vscode.Extension<unknown> => !!e);
	if (oldBuilds.length) {
		void vscode.window
			.showErrorMessage(
				`An older Draw.AI build is also enabled (${oldBuilds.map((e) => e.id).join(", ")}). It registers the same commands and editors as this Draw.AI, so one of them cannot start. Uninstall the older build.`,
				"Show Older Build"
			)
			.then((choice) => choice && vscode.commands.executeCommand("extension.open", oldBuilds[0].id));
	}

	if (!vscode.extensions.getExtension(UPSTREAM_EXTENSION.id) || drawAiOpensDiagrams() || context.globalState.get(DONT_SHOW_KEY)) {
		return;
	}
	void vscode.window
		.showWarningMessage(
			`${UPSTREAM_EXTENSION.name} (${UPSTREAM_EXTENSION.id}) is also enabled. Both open draw.io files, and VS Code may use ${UPSTREAM_EXTENSION.name}, where Draw.AI's lasso, review and AI tools are not available. Draw.AI includes everything ${UPSTREAM_EXTENSION.name} does.`,
			"Use Draw.AI for Diagrams",
			`Show ${UPSTREAM_EXTENSION.name}`,
			"Don't Show Again"
		)
		.then(async (choice) => {
			if (choice === "Use Draw.AI for Diagrams") {
				await vscode.commands.executeCommand(USE_FOR_DIAGRAMS_COMMAND);
			} else if (choice === `Show ${UPSTREAM_EXTENSION.name}`) {
				await vscode.commands.executeCommand("extension.open", UPSTREAM_EXTENSION.id);
			} else if (choice === "Don't Show Again") {
				await context.globalState.update(DONT_SHOW_KEY, true);
			}
		});
}
