import { Disposable } from "@hediet/std/disposable";
import { EventEmitter } from "@hediet/std/events";
import { autorun, computed, observable, ObservableSet } from "mobx";
import { extname } from "path";
import {
	commands,
	ProgressLocation,
	QuickPickItem, QuickPickItemKind, StatusBarAlignment,
	TextDocument,
	Uri,
	ViewColumn,
	WebviewPanel,
	window,
	workspace
} from "vscode";
import { Config, DiagramConfig, ResolvedDrawioTheme } from "./Config";
import {
	CustomizedDrawioClient,
	DrawioClientFactory,
	DrawioClientOptions,
} from "./DrawioClient";
import { DrawioBinaryDocument } from "./DrawioEditorProviderBinary";
import { registerFailableCommand } from "./utils/registerFailableCommand";

const drawioChangeThemeCommand = "drawio-ai.changeTheme";

const showError = (e: any) => window.showErrorMessage(String(e?.message ?? e));

export class DrawioEditorService {
	public readonly dispose = Disposable.fn();

	private readonly onEditorOpenedEmitter = new EventEmitter<{
		editor: DrawioEditor;
	}>();
	public readonly onEditorOpened = this.onEditorOpenedEmitter.asEvent();

	public readonly openedEditors = new ObservableSet<DrawioEditor>();

	@computed
	get activeDrawioEditor(): DrawioEditor | undefined {
		return [...this.openedEditors].find((e) => e.isActive);
	}

	@observable private _lastActiveDrawioEditor: DrawioEditor | undefined;
	get lastActiveDrawioEditor(): DrawioEditor | undefined {
		return this._lastActiveDrawioEditor;
	}

	private readonly statusBar = this.dispose.track(
		window.createStatusBarItem(StatusBarAlignment.Right)
	);

	constructor(
		private readonly config: Config,
		private readonly drawioClientFactory: DrawioClientFactory
	) {
		autorun(() => {
			const a = this.activeDrawioEditor;
			if (a) {
				this._lastActiveDrawioEditor = a;
			}
			commands.executeCommand(
				"setContext",
				"drawio-ai.active",
				!!a
			);
		});

		this.dispose.track(
			registerFailableCommand(drawioChangeThemeCommand, () => {
				const activeDrawioEditor = this.activeDrawioEditor;
				if (!activeDrawioEditor) {
					return;
				}
				activeDrawioEditor.handleChangeThemeCommand();
			})
		);

		this.dispose.track(
			registerFailableCommand("drawio-ai.convert", () => {
				const activeDrawioEditor = this.activeDrawioEditor;
				if (!activeDrawioEditor) {
					return;
				}
				activeDrawioEditor.handleConvertCommand();
			})
		);

		this.dispose.track(
			registerFailableCommand(
				"drawio-ai.reload-webview",
				() => {
					for (const e of this.openedEditors) {
						e.drawioClient.reloadWebview();
					}
				}
			)
		);

		this.dispose.track(
			registerFailableCommand("drawio-ai.export", () => {
				const activeDrawioEditor = this.activeDrawioEditor;
				if (!activeDrawioEditor) {
					return;
				}
				return activeDrawioEditor.handleExportCommand();
			})
		);

		this.dispose.track(
			registerFailableCommand("drawio-ai.exportVisio", () => {
				const editor = this.activeDrawioEditor ?? this.lastActiveDrawioEditor;
				if (!editor) {
					window.showInformationMessage("Open a draw.io diagram to export it to Visio.");
					return;
				}
				return editor.exportToVisio();
			})
		);

		this.dispose.track({
			dispose: autorun(
				() => {
					const activeEditor = this.activeDrawioEditor;
					this.statusBar.command = drawioChangeThemeCommand;

					if (activeEditor) {
						this.statusBar.text = `Theme: ${activeEditor.config.resolvedTheme.toString()}`;
						this.statusBar.show();
					} else {
						this.statusBar.hide();
					}
				},
				{ name: "Update UI" }
			),
		});
	}

	/**
	 * Throws when files cannot be handed to draw.io for the given location: only
	 * the draw.io bundled with the extension is used, never the online app.
	 */
	public assertBundledDrawio(forUri: Uri | undefined): void {
		const mode = forUri ? this.config.getDiagramConfig(forUri).mode : { kind: "offline" as const };
		if (mode.kind !== "offline") {
			throw new Error(
				`This needs the draw.io that is bundled with the extension, but the setting "drawio-ai.offline" is off (draw.io is loaded from ${mode.url}). Turn it on to convert files.`
			);
		}
	}

	/**
	 * Runs a task in a draw.io webview of its own, e.g. to convert a file with
	 * draw.io's importers, and closes it afterwards. Open diagrams are never used:
	 * a large or broken file must not freeze or crash an editor with unsaved work.
	 */
	public async withDrawioWebview<T>(
		forUri: Uri,
		task: (client: CustomizedDrawioClient) => Promise<T>
	): Promise<T> {
		this.assertBundledDrawio(forUri);
		const name = forUri.path.split("/").pop();
		const panel = window.createWebviewPanel(
			"drawio-ai.converter",
			`Converting ${name}…`,
			{ viewColumn: ViewColumn.Active, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		let disposed = false;
		const closed = new Promise<never>((_, reject) =>
			panel.onDidDispose(() => {
				disposed = true;
				reject(new Error(`The conversion stopped because its panel was closed.`));
			})
		);
		closed.catch(() => undefined);
		try {
			const client = await this.drawioClientFactory.createDrawioClientInWebview(forUri, panel, { isReadOnly: false });
			client.onInit.sub(() => void client.loadXmlLike(""));
			return await Promise.race([task(client), closed]);
		} finally {
			if (!disposed) {
				panel.dispose();
			}
		}
	}

	public async createDrawioEditorInWebview(
		webviewPanel: WebviewPanel,
		document:
			| { kind: "text"; document: TextDocument }
			| { kind: "drawio"; document: DrawioBinaryDocument },
		options: DrawioClientOptions
	): Promise<DrawioEditor> {
		const instance =
			await this.drawioClientFactory.createDrawioClientInWebview(
				document.document.uri,
				webviewPanel,
				options
			);

		const config = this.config.getDiagramConfig(document.document.uri);
		const editor = new DrawioEditor(
			PrivateSymbol,
			webviewPanel,
			instance,
			document,
			config
		);

		this.openedEditors.add(editor);
		this.onEditorOpenedEmitter.emit({ editor });

		editor.webviewPanel.onDidDispose(() => {
			this.openedEditors.delete(editor);
		});

		return editor;
	}
}

const PrivateSymbol = Symbol();

/**
 * Represents a drawio editor in VS Code.
 * Wraps a `CustomizedDrawioClient` and a webview.
 */
export class DrawioEditor {
	public readonly dispose = Disposable.fn();

	@observable private _isActive = false;
	@observable private _hasFocus = false;

	private readonly knownDrawioFileExtensions: ReadonlyArray<string> = [
		".drawio",
		".dio",
		".drawio.svg",
		".drawio.png",
		".dio.svg",
		".dio.png",
	];

	public get fileExtension(): string {
		const currentFilePath = this.uri.path;
		// Just in case an extension is the prefix of another,
		// we want to return the longest.
		const sortedExtensionsByLengthDesc = this.knownDrawioFileExtensions
			.slice()
			.sort((a, b) => b.length - a.length);
		return (
			sortedExtensionsByLengthDesc.find((ext) =>
				currentFilePath.endsWith(ext)
			) || extname(currentFilePath)
		);
	}

	constructor(
		_constructorGuard: typeof PrivateSymbol,
		public readonly webviewPanel: WebviewPanel,
		public readonly drawioClient: CustomizedDrawioClient,
		public readonly document:
			| { kind: "text"; document: TextDocument }
			| { kind: "drawio"; document: DrawioBinaryDocument },
		public readonly config: DiagramConfig
	) {
		this._isActive = webviewPanel.active;
		this.dispose.track(
			webviewPanel.onDidChangeViewState(() => {
				this._isActive = webviewPanel.active;
			})
		);

		this.dispose.track(
			drawioClient.onFocusChanged.sub(({ hasFocus }) => {
				this._hasFocus = hasFocus;
			})
		);

		drawioClient.onInvokeCommand.sub(({ command }) => {
			if (command === "convert") {
				this.handleConvertCommand();
			} else if (command === "export") {
				this.handleExportCommand().catch(showError);
			} else if (command === "exportVisio") {
				this.exportToVisio().catch(showError);
			} else if (command === "importDiagram") {
				commands.executeCommand("drawio-ai.importDiagram");
			} else if (command === "save") {
				this.drawioClient.triggerOnSave();
			}
		});
	}

	public get isActive(): boolean {
		return this._isActive;
	}

	public get hasFocus(): boolean {
		return this._hasFocus;
	}

	public get uri(): Uri {
		return this.document.document.uri;
	}

	/**
	 * Supports `.drawio`, `.dio`, `.drawio.svg` `.drawio.png` and other extensions.
	 *
	 * @param newExtension Must start with a dot.
	 */
	public getUriWithExtension(newExtension: string): Uri {
		return this.uri.with({
			path: removeEnd(this.uri.path, this.fileExtension) + newExtension,
		});
	}

	public async convertTo(targetExtension: string): Promise<void> {
		if (this.document.document.isDirty) {
			await window.showErrorMessage("Save your diagram first!");
			return;
		}

		const targetUri = this.getUriWithExtension(targetExtension);
		if (await fileExists(targetUri)) {
			await window.showErrorMessage(
				`File "${targetUri.toString()}" already exists!`
			);
			return;
		}

		const buffer = await this.drawioClient.export(targetExtension);

		const sourceUri = this.document.document.uri;
		const oldContent = await workspace.fs.readFile(sourceUri);

		await workspace.fs.writeFile(sourceUri, buffer);
		try {
			await workspace.fs.rename(sourceUri, targetUri);
		} catch (e) {
			await workspace.fs.writeFile(sourceUri, oldContent);
			throw e;
		}
	}

	public async exportTo(targetExtension: string): Promise<void> {
		if (targetExtension === ".vsdx") {
			return this.exportToVisio();
		}
		// Exports the page that is visible in the editor
		const buffer = await this.drawioClient.export(targetExtension, true);
		const targetUri = await window.showSaveDialog({
			defaultUri: this.getUriWithExtension(targetExtension),
		});

		if (!targetUri) {
			return;
		}
		await workspace.fs.writeFile(targetUri, buffer);
	}

	/** Exports every page to a Microsoft Visio file chosen by the user. */
	public async exportToVisio(): Promise<void> {
		const targetUri = await window.showSaveDialog({
			defaultUri: this.getUriWithExtension(".vsdx"),
			filters: { "Microsoft Visio": ["vsdx"] },
		});
		if (!targetUri) {
			return;
		}
		const result = await window.withProgress(
			{ location: ProgressLocation.Notification, title: "Exporting to Visio…" },
			() => this.drawioClient.exportVsdx()
		);
		await workspace.fs.writeFile(targetUri, result.data);
		const name = targetUri.path.split("/").pop();
		const pages = `${result.pages} page${result.pages === 1 ? "" : "s"}`;
		if (result.warnings.length > 0) {
			window.showWarningMessage(`Exported ${pages} to ${name}. ${result.warnings.join(" ")}`);
		} else {
			window.showInformationMessage(`Exported ${pages} to ${name}.`);
		}
	}

	public async handleConvertCommand(): Promise<void> {
		const result = await window.showQuickPick(
			[
				{
					label: ".drawio.svg",
					description: "Converts the diagram to an editable SVG file",
				},
				{
					label: ".drawio",
					description: "Converts the diagram to a drawio file",
				},

				{
					label: ".drawio.png",
					description: "Converts the diagram to an editable png file",
				},
			].filter((x) => x.label !== this.fileExtension)
		);

		if (!result) {
			return;
		}
		await this.convertTo(result.label);
	}

	public async handleExportCommand(): Promise<void> {
		const result = await window.showQuickPick([
			{
				label: ".svg",
				description: "Exports the diagram to a SVG file",
			},
			{
				label: ".png",
				description: "Exports the diagram to a png file",
			},
			{
				label: ".drawio",
				description: "Exports the diagram to a drawio file",
			},
			{
				label: ".vsdx",
				description: "Exports all pages to a Microsoft Visio file",
			},
		]);

		if (!result) {
			return;
		}
		await this.exportTo(result.label);
	}

	public async handleChangeThemeCommand(): Promise<void> {
		const originalTheme = this.config.theme;
		const originalAppearance = this.config.appearance;
		const availableThemes = withFirstUnique(ResolvedDrawioTheme.getThemeNames(), originalTheme);

		const availableOptions: (QuickPickItem & { onSelect?: (preview: boolean) => void })[] = [];

		const curVsCodeAppearance = this.config.getVsCodeAppearance();

		const appearances = withFirstUnique(["automatic", "light", "dark"], originalAppearance);
		for (const appearance of appearances) {
			const appearanceLabel = appearance === "automatic" ? `always match VS Code theme '${curVsCodeAppearance}'` : appearance;

			availableOptions.push({
				kind: QuickPickItemKind.Separator,
				label: appearanceLabel,
			});
			for (const theme of availableThemes) {
				availableOptions.push({
					label: `${theme} - ${appearance}`,
					onSelect: () => {
						this.config.setTheme(theme);
						this.config.setAppearance(appearance);
					}
				});
			}
		}
		const result = await window.showQuickPick(
			availableOptions,
			{
				onDidSelectItem: async (item) => {
					(item as any).onSelect(true);
				},
			}
		);
		if (!result || !result.onSelect) {
			await this.config.setTheme(originalTheme);
			await this.config.setAppearance(originalAppearance);
			return;
		}
		result.onSelect(false);
	}
}

function withFirstUnique<T>(items: T[], firstItem: T): T[] {
	const filtered = items.filter(t => t !== firstItem);
	return [firstItem, ...filtered];
}

async function fileExists(uri: Uri): Promise<boolean> {
	try {
		await workspace.fs.stat(uri);
		return true;
	} catch (e) {
		return false;
	}
}

function removeEnd(value: string, end: string): string {
	if (!value.endsWith(end)) {
		throw new Error(`Value does not end with "${end}"!`);
	}
	return value.substr(0, value.length - end.length);
}
