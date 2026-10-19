import * as vscode from "vscode";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import { getAiSettings, SECRET_KEYS } from "./aiSettings";
import { ChatViewProvider, DEFAULT_IMAGE_PROMPT } from "./ChatViewProvider";
import { analyze, codeRefs, DiagramKind, detectKind, Entity, formatAnalysis, SourceFile } from "./codeAnalysis";
import { registerChatParticipant, registerLanguageModelTools } from "./copilotIntegration";
import { DiagramAgent } from "./DiagramAgent";
import { DiagramToolbox } from "./DiagramToolbox";
import { ProviderRegistry } from "./providers/ProviderRegistry";
import { readImage } from "./images";
import { formatIssues, LintIssue } from "./lint";
import type { ImageData } from "./providers/types";
import { describeTemplate } from "./templates/profile";
import { CreateTemplateArgs, TemplateService } from "./templates/TemplateService";
import { path } from "../../utils/path";
import { linkData, splitLines } from "./codeLinks";
import { CodeLinkService } from "./CodeLinkService";
import { McpService } from "./McpService";
import { exportDiagramToWorkspace } from "./exportDiagram";
import { importForAgent } from "../importDiagram";

const CODE_GLOB = /\.(tsx?|jsx?|mjs|cjs|py|java|cs|kt|go|sql|prisma|tf|ya?ml)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".venv", "venv", "__pycache__", "target", "bin", "obj", ".next", ".terraform", "coverage", ".drawio-ai"]);
const MAX_CODE_FILES = 800;
const MAX_FILE_BYTES = 300_000;

interface FromCodeArgs {
	paths?: string[];
	kind?: DiagramKind;
	target?: "current" | "new";
	/** Diagram file to create/use (skips the prompts). */
	file?: string;
	/** Only return the analysis text (tests). */
	analyzeOnly?: boolean;
}

interface FromImageArgs {
	prompt?: string;
	target?: "current" | "new";
	file?: string;
}

export class AiFeature {
	public readonly dispose = Disposable.fn();

	private readonly registry = new ProviderRegistry(this.context.secrets);
	private readonly templates = new TemplateService();
	private readonly codeLinks: CodeLinkService = new CodeLinkService(
		() => this.editorService.openedEditors,
		async (editor, prompt, attachments) => {
			await this.chatView.reveal();
			await this.chatView.send(prompt, { cellIds: [] }, { editor, attachments });
		}
	);
	private readonly toolbox = new DiagramToolbox(
		() => this.targetEditor(),
		(editor) => this.templates.active(editor.uri),
		this.codeLinks,
		exportDiagramToWorkspace,
		(request) =>
			importForAgent(
				request,
				(uri, task) => this.editorService.withDrawioWebview(uri, task),
				() => {
					const editor = this.targetEditor();
					return editor ? vscode.Uri.joinPath(editor.uri, "..") : undefined;
				},
				(diagram) => this.whenTarget(diagram)
			)
	);
	private readonly agent = new DiagramAgent(this.toolbox);
	private readonly chatView = new ChatViewProvider(
		this.context,
		this.registry,
		this.agent,
		() => this.targetEditor(),
		async (editor) => {
			const t = await this.templates.active(editor?.uri);
			return t ? { name: t.manifest.name, prompt: describeTemplate(t) } : undefined;
		}
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
						systemExtra: () => this.templates.promptSection(editor.uri),
					};
				},
			})
		);
		track(registerLanguageModelTools(this.toolbox));
		track(this.templates);
		track(this.codeLinks);
		const mcp = new McpService(
			this.context,
			this.toolbox,
			() => this.targetEditor(),
			() => this.templates.promptSection(this.targetEditor()?.uri)
		);
		track(mcp);
		track(vscode.commands.registerCommand("drawio-ai.mcpSetup", (args?: { show?: boolean; enable?: boolean }) => mcp.setupCommand(args)));
		track(this.templates.onDidChange(() => void this.chatView.refreshTemplate()));
		track(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("drawio-ai.template")) void this.chatView.refreshTemplate();
			})
		);
		const watcher = vscode.workspace.createFileSystemWatcher("**/.drawio-ai/templates/**");
		track([
			watcher,
			watcher.onDidCreate(() => void this.chatView.refreshTemplate()),
			watcher.onDidDelete(() => void this.chatView.refreshTemplate()),
			watcher.onDidChange(() => void this.chatView.refreshTemplate()),
		]);

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
			vscode.commands.registerCommand("drawio-ai.markup", () => {
				const editor = this.targetEditor();
				if (editor) {
					editor.webviewPanel.reveal();
					editor.drawioClient.aiSetMarkupMode(true);
				} else {
					void vscode.window.showInformationMessage("Open a draw.io diagram to mark it up.");
				}
			}),
			vscode.commands.registerCommand("drawio-ai.createTemplate", (args?: CreateTemplateArgs) =>
				this.templates.create(this.targetEditor()?.uri, args ?? {}, (prompt, images) => this.draftRules(prompt, images))
			),
			vscode.commands.registerCommand("drawio-ai.checkCodeLinks", () => this.codeLinks.checkCommand(this.targetEditor())),
			vscode.commands.registerCommand("drawio-ai.selectTemplate", () => this.templates.select(this.targetEditor()?.uri)),
			vscode.commands.registerCommand("drawio-ai.reviewDiagram", (args?: { fix?: "all" | "none" }) => this.reviewDiagram(args)),
			vscode.commands.registerCommand("drawio-ai.diagramFromImage", (uri?: vscode.Uri, args?: FromImageArgs) =>
				this.diagramFromImage(uri instanceof vscode.Uri ? uri : undefined, args)
			),
			vscode.commands.registerCommand(
				"drawio-ai.diagramFromCode",
				(uri?: vscode.Uri | FromCodeArgs, uris?: vscode.Uri[]) =>
					uri instanceof vscode.Uri || uri === undefined
						? this.diagramFromCode({}, uris?.length ? uris : uri ? [uri] : undefined)
						: this.diagramFromCode(uri)
			),
		]);
	}

	// ----- design templates -----

	private async draftRules(prompt: string, images: ImageData[]): Promise<string> {
		const client = await this.chatView.currentClient();
		const usable = client.model.vision ? images : [];
		const cts = new vscode.CancellationTokenSource();
		let text = "";
		try {
			for await (const evt of client.stream(
				{
					system: "You write concise, concrete diagram style rules as Markdown bullet lists.",
					messages: [
						{
							role: "user",
							parts: [
								{
									type: "text",
									text:
										prompt +
										(images.length > usable.length ? "\n(Reference images exist but this model cannot see them.)" : ""),
								},
								...usable.map((image) => ({ type: "image" as const, image })),
							],
						},
					],
					tools: [],
				},
				cts.token
			)) {
				if (evt.type === "text") text += evt.text;
			}
		} finally {
			cts.dispose();
		}
		if (!text.trim()) throw new Error("the model returned no text");
		return text;
	}

	// ----- review / lint -----

	private async reviewDiagram(args?: { fix?: "all" | "none" }): Promise<LintIssue[] | undefined> {
		const editor = this.targetEditor();
		if (!editor) {
			void vscode.window.showInformationMessage("Open a draw.io diagram to review it.");
			return undefined;
		}
		const { issues, template } = await this.toolbox.lintEditor(editor);
		if (args?.fix === "none") return issues;
		const fix = async (selected: LintIssue[]) => {
			await this.chatView.reveal();
			await this.chatView.send(
				`Fix these diagram issues${template ? ` (design template "${template.manifest.name}")` : ""}:\n${formatIssues(selected)}\n\nKeep everything else unchanged, then run drawio_lint to confirm.`,
				{ cellIds: [] },
				{ editor }
			);
		};
		if (args?.fix === "all") {
			if (issues.length) await fix(issues);
			return issues;
		}
		if (issues.length === 0) {
			const action = await vscode.window.showInformationMessage(
				`No problems found${template ? ` (checked against template "${template.manifest.name}")` : ""}.`,
				"Ask AI for a Design Review"
			);
			if (action) {
				await this.chatView.reveal();
				await this.chatView.send(
					"Review this diagram's clarity, naming, structure and visual consistency. Suggest concrete improvements; only change things that are clearly broken.",
					{ cellIds: [] },
					{ editor }
				);
			}
			return issues;
		}

		type Item = vscode.QuickPickItem & { issue: LintIssue };
		const icon = { error: "$(error)", warning: "$(warning)", info: "$(info)" };
		const qp = vscode.window.createQuickPick<Item>();
		qp.title = `Diagram review: ${issues.length} issue${issues.length === 1 ? "" : "s"}${template ? ` · template "${template.manifest.name}"` : ""}`;
		qp.placeholder = "Pick the issues the AI should fix (fixes show up as pending changes). Moving through the list highlights the shapes.";
		qp.canSelectMany = true;
		qp.matchOnDescription = true;
		qp.items = issues.map((issue) => ({ label: `${icon[issue.severity]} ${issue.message}`, description: issue.rule, issue }));
		qp.selectedItems = qp.items.filter((i) => i.issue.severity !== "info");
		qp.onDidChangeActive((active) => {
			const ids = active[0]?.issue.cellIds ?? [];
			if (ids.length) void editor.drawioClient.aiSetSelection(ids, true).catch(() => undefined);
		});
		const picked = await new Promise<readonly Item[] | undefined>((resolve) => {
			qp.onDidAccept(() => {
				resolve(qp.selectedItems);
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		});
		qp.dispose();
		if (picked?.length) await fix(picked.map((p) => p.issue));
		return issues;
	}

	// ----- sketch / screenshot → diagram -----

	private async diagramFromImage(uri: vscode.Uri | undefined, args: FromImageArgs = {}): Promise<void> {
		if (!uri) {
			const picked = await vscode.window.showOpenDialog({
				title: "Turn a sketch, whiteboard photo or screenshot into a diagram",
				filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
				openLabel: "Convert",
			});
			uri = picked?.[0];
			if (!uri) return;
		}
		let image: ImageData | undefined;
		try {
			image = await readImage(uri);
		} catch (e: any) {
			void vscode.window.showErrorMessage(String(e?.message ?? e));
			return;
		}
		if (!image) {
			void vscode.window.showErrorMessage("Unsupported image type (use PNG, JPEG, GIF or WebP).");
			return;
		}
		const extra =
			args.prompt ??
			(await vscode.window.showInputBox({
				title: "Diagram from image",
				prompt: "Anything specific? e.g. \"use AWS icons\", \"only the left half\" (optional)",
				ignoreFocusOut: true,
			}));
		if (extra === undefined) return;
		const base = uri.path.split("/").pop()!.replace(/\.[^.]+$/, "");
		const editor = await this.diagramTarget(vscode.Uri.joinPath(uri, "..", `${base}.drawio`), args);
		if (!editor) return;
		await this.chatView.reveal();
		await this.chatView.send(extra.trim() ? `${DEFAULT_IMAGE_PROMPT}\n\n${extra.trim()}` : DEFAULT_IMAGE_PROMPT, { cellIds: [] }, { images: [image], editor });
	}

	// ----- code → diagram -----

	private async diagramFromCode(args: FromCodeArgs, uris?: vscode.Uri[]): Promise<string | void> {
		let targets = uris ?? args.paths?.map((p) => vscode.Uri.file(p));
		if (!targets?.length) {
			targets = await vscode.window.showOpenDialog({
				title: "Diagram from code: pick source folders or files",
				canSelectFiles: true,
				canSelectFolders: true,
				canSelectMany: true,
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
				openLabel: "Analyze",
			});
			if (!targets?.length) return;
		}
		const { files, root } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "Draw.AI: reading source files…" },
			() => collectSources(targets!)
		);
		if (files.length === 0) {
			void vscode.window.showWarningMessage(
				"No supported source files found (TypeScript/JavaScript, Python, Java, C#, Kotlin, Go, SQL, Prisma, Terraform, Kubernetes/docker-compose YAML)."
			);
			return;
		}

		let kind = args.kind;
		if (!kind) {
			const detected = detectKind(files);
			const labels: Record<DiagramKind, string> = {
				dependencies: "Module dependencies",
				classes: "Class diagram",
				erd: "Database ERD",
				infrastructure: "Infrastructure / deployment",
			};
			const pick = await vscode.window.showQuickPick(
				(Object.keys(labels) as DiagramKind[]).map((k) => ({
					label: labels[k],
					description: k === detected ? "suggested" : undefined,
					value: k,
				})).sort((a, b) => Number(b.value === detected) - Number(a.value === detected)),
				{ title: `Diagram from ${files.length} file${files.length === 1 ? "" : "s"}: what kind of diagram?` }
			);
			if (!pick) return;
			kind = pick.value;
		}

		const analysis = analyze(files, kind);
		const text = formatAnalysis(analysis);
		if (args.analyzeOnly) return text;
		if (analysis.entities.length === 0) {
			void vscode.window.showWarningMessage(`Found nothing to draw as a ${kind} diagram in the selected files.`);
			return;
		}

		const label = targets.length === 1 ? targets[0].path.split("/").pop()! : `${targets.length} items`;
		const editor = await this.diagramTarget(vscode.Uri.joinPath(root, `${label.replace(/\.[^.]+$/, "")}-${kind}.drawio`), args);
		if (!editor) return;
		await this.chatView.reveal();
		await this.chatView.send(
			`Create a ${kind === "erd" ? "database ERD" : kind === "classes" ? "class diagram" : kind === "infrastructure" ? "infrastructure diagram" : "module dependency diagram"} of ${label} from the attached code analysis. Place it in empty space on the page.`,
			{ cellIds: [] },
			{ editor, attachments: [{ name: `code analysis of ${label} (${files.length} files, ${analysis.entities.length} entities)`, text }] }
		);
		await this.linkShapesToCode(editor, codeRefs(analysis), root, files).catch((e) => console.error("Draw.AI: linking shapes failed", e));
	}

	/** Turns `codeRef` attributes (and exact name matches) into code links (double-click → source). */
	private async linkShapesToCode(editor: DrawioEditor, refs: Map<string, Entity>, root: vscode.Uri, files: SourceFile[]): Promise<number> {
		const model = await editor.drawioClient.aiGetModel({ scope: "page", includeStyles: false, maxCells: 20000 });
		const ops: AiOp[] = [];
		const linked = new Set<string>();
		const lines = new Map(files.map((f) => [f.path, splitLines(f.text)]));
		const link = (e: Entity): Record<string, string> => {
			const rel = path.relative(editor.uri.fsPath, path.join(root.fsPath, e.file)).replace(/\\/g, "/");
			return linkData(rel, lines.get(e.file) ?? [], e.line - 1, (e.endLine ?? e.line) - 1);
		};
		for (const c of model.cells) {
			const ref = c.data?.codeRef;
			const e = ref ? refs.get(ref) : undefined;
			if (!ref) continue;
			ops.push({ op: "update", id: c.id, data: { codeRef: null, ...(e ? link(e) : {}) } });
			if (e) linked.add(ref);
		}
		const firstLine = (s: string) => s.split("\n")[0].replace(/^[«<]\w+[»>]\s*/, "").trim();
		for (const [ref, e] of refs) {
			if (linked.has(ref)) continue;
			const candidates = model.cells.filter(
				(c) => c.kind !== "edge" && !c.data?.hedietLinkedDataV1_path && !c.data?.codeRef && firstLine(c.label) === e.name
			);
			if (candidates.length === 1) ops.push({ op: "update", id: candidates[0].id, data: link(e) });
		}
		if (ops.length === 0) return 0;
		const settings = getAiSettings();
		await editor.drawioClient.aiApplyOps(ops, { atomic: false, selectResult: false, flash: false, review: settings.reviewChanges });
		this.codeLinks.schedule(editor, 100);
		return ops.length;
	}

	/** The diagram to draw into: the current one, or a new file. */
	private async diagramTarget(suggested: vscode.Uri, opts: { target?: "current" | "new"; file?: string }): Promise<DrawioEditor | undefined> {
		const current = this.targetEditor();
		let target = opts.target;
		if (!opts.file && current && !target) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: `Add to ${fileName(current)}`, target: "current" as const },
					{ label: "New diagram…", target: "new" as const },
				],
				{ title: "Where should the diagram go?" }
			);
			if (!pick) return undefined;
			target = pick.target;
		}
		if (current && !opts.file && target !== "new") return current;

		const uri = opts.file
			? vscode.Uri.file(opts.file)
			: await vscode.window.showSaveDialog({ defaultUri: suggested, filters: { Diagrams: ["drawio"] }, saveLabel: "Create" });
		if (!uri) return undefined;
		const exists = await vscode.workspace.fs.stat(uri).then(
			() => true,
			() => false
		);
		if (!exists) await vscode.workspace.fs.writeFile(uri, new Uint8Array());
		await vscode.commands.executeCommand("vscode.openWith", uri, "drawio-ai-text");
		for (let i = 0; i < 300; i++) {
			const editor = [...this.editorService.openedEditors].find((e) => e.uri.toString() === uri.toString());
			if (editor) return editor;
			await new Promise((r) => setTimeout(r, 100));
		}
		void vscode.window.showErrorMessage(`Could not open ${uri.fsPath} in the draw.io editor.`);
		return undefined;
	}

	private onTargetReviewChanged(): void {
		const pending = !!this.targetEditor()?.drawioClient.pendingReview;
		void vscode.commands.executeCommand("setContext", "drawio-ai.reviewPending", pending);
		this.chatView.onActiveDiagramChanged();
	}

	/** The diagram the AI acts on: the focused one, else the one used most recently. */
	/**
	 * Waits until the tools work on the given diagram, e.g. one that was just opened,
	 * and its draw.io has loaded, so that the next tool call does not reach it too early.
	 */
	private async whenTarget(diagram: vscode.Uri, timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const editor = this.targetEditor();
			if (editor?.uri.toString() === diagram.toString()) {
				return editor.drawioClient.whenLoaded(deadline - Date.now());
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}

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
					!evt.source &&
					!!lastLasso &&
					lastLasso.cellIds.length === evt.cellIds.length &&
					lastLasso.cellIds.every((id) => evt.cellIds.includes(id));
				lastLasso = undefined;
				void this.chatView.reveal();
				void this.chatView.send(
					evt.prompt,
					{
						cellIds: evt.cellIds,
						region: evt.region,
						viaLasso,
						source: evt.source === "markup" || evt.source === "image" ? evt.source : undefined,
						markCount: evt.markCount,
					},
					{ images: evt.images, editor }
				);
			}),
		];
		subs.push(this.codeLinks.hook(editor));
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

/** Reads supported source files below the given files/folders (skipping build output and dependencies). */
async function collectSources(targets: vscode.Uri[]): Promise<{ files: SourceFile[]; root: vscode.Uri }> {
	const fs = vscode.workspace.fs;
	const found: vscode.Uri[] = [];
	const walk = async (uri: vscode.Uri, depth: number): Promise<void> => {
		if (found.length >= MAX_CODE_FILES || depth > 12) return;
		const stat = await fs.stat(uri).then(
			(s) => s,
			() => undefined
		);
		if (!stat) return;
		if (stat.type & vscode.FileType.Directory) {
			for (const [name, type] of await fs.readDirectory(uri)) {
				if (type & vscode.FileType.Directory ? SKIP_DIRS.has(name) || name.startsWith(".") : !CODE_GLOB.test(name) || /\.(d\.ts|min\.js)$/.test(name)) continue;
				await walk(vscode.Uri.joinPath(uri, name), depth + 1);
			}
		} else if (CODE_GLOB.test(uri.path) && stat.size <= MAX_FILE_BYTES) {
			found.push(uri);
		}
	};
	for (const t of targets) await walk(t, 0);

	const folder = vscode.workspace.getWorkspaceFolder(targets[0]);
	let root = folder?.uri;
	if (!root) {
		const dirs = targets.map((t) => t.path);
		let common = dirs[0];
		while (common && !dirs.every((d) => d === common || d.startsWith(common.endsWith("/") ? common : common + "/"))) {
			common = common.slice(0, common.lastIndexOf("/"));
		}
		root = targets[0].with({ path: common || "/" });
		const stat = await fs.stat(root).then(
			(s) => s,
			() => undefined
		);
		if (stat && !(stat.type & vscode.FileType.Directory)) root = vscode.Uri.joinPath(root, "..");
	}
	const prefix = root.path.endsWith("/") ? root.path : root.path + "/";
	const files: SourceFile[] = [];
	for (const uri of found) {
		const text = Buffer.from(await fs.readFile(uri)).toString("utf8");
		files.push({ path: uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : uri.path.split("/").pop()!, text });
	}
	return { files, root };
}
