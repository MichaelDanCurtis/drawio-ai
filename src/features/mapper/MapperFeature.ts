import * as vscode from "vscode";
import * as fs from "fs";
import * as nodePath from "path";
import { randomBytes } from "crypto";
import { Disposable } from "@hediet/std/disposable";
import { autorun } from "mobx";
import type { DrawioEditor, DrawioEditorService } from "../../DrawioEditorService";
import type { MapperService } from "../../../standalone/src/main/mapper/service";
import type { MapRecord } from "../../../standalone/src/main/mapper/store";
import type { MapFinding, MapInput } from "../../../standalone/src/main/mapper/types";
import { MAPPER_TOOL_NAMES, MAPPER_TOOL_SCHEMAS } from "../ai/allTools";
import type { ExtraTools, ToolResult } from "../ai/DiagramToolbox";
import type { SelectionContext } from "../ai/systemPrompt";
import { OMNI_DIR } from "../editorLook";
import type { EditorLookFeature, PresentationTour } from "../EditorLookFeature";
import { mapperPageHtml, MAPPER_PAGE, pageNonce } from "./mapperPage";
import { ChangedShapes, MapsViewProvider } from "./MapsView";
import { collects, runConfirmation, splitFacts } from "./requests";

type Runtime = typeof import("./runtime");

/** The inputs remembered per recipe (never secrets), in the extension's own storage. */
const INPUTS_KEY = "drawio-ai.mapper.inputs";

/** How a tour is played here: the desktop app's F5 starts a debugger in VS Code. */
const PLAY_TOUR = 'open the Maps view (Draw.AI in the activity bar) and click the tour, or run "Draw.AI: Presentation Mode" and pick it at the bottom';

export interface MapperDeps {
	context: vscode.ExtensionContext;
	editorService: DrawioEditorService;
	look: EditorLookFeature;
	/** Sends a request about `editor`'s diagram to the Draw.AI agent in VS Code's chat. */
	ask(text: string, editor: DrawioEditor, extras?: { attachments?: { name: string; text: string }[]; selection?: SelectionContext }): Promise<boolean>;
}

export interface MapRunArgs {
	recipe: string;
	input?: MapInput;
}

/**
 * The Mapper in VS Code: the Map Something panel (the desktop app's page in a webview), the
 * Maps view with each map's findings and tours, the map tools for the agent, and commands.
 * The Mapper only reads: see standalone/src/main/mapper/readOnly.ts.
 */
export class MapperFeature {
	public readonly dispose = Disposable.fn();

	private runtimePromise: Promise<Runtime> | undefined;
	private readonly services = new WeakMap<DrawioEditor, MapperService>();
	private readonly panels = new Map<DrawioEditor, vscode.WebviewPanel>();
	/** Diagrams whose panel is being opened (the Mapper loads on first use). */
	private readonly opening = new Set<DrawioEditor>();
	/** What each panel's page reported when it had loaded (tests): the files a webview could read from the extension's folder. */
	private readonly panelPages = new WeakMap<vscode.WebviewPanel, { ready: boolean; loaded?: unknown }>();
	/** What "Recent changes" found last, per map id (shown in the Maps view until VS Code closes). */
	private readonly changes = new Map<string, ChangedShapes>();
	private readonly view: MapsViewProvider;

	constructor(private readonly deps: MapperDeps) {
		const track = (d: vscode.Disposable | vscode.Disposable[]) => (Array.isArray(d) ? d : [d]).forEach((x) => this.dispose.track(x));

		this.view = new MapsViewProvider(() => this.viewData());
		const tree = vscode.window.createTreeView("drawio-ai.maps", { treeDataProvider: this.view, showCollapseAll: true });
		track(tree);
		track(this.view);
		track(tree.onDidChangeVisibility((e) => e.visible && this.view.refresh()));
		// The view shows the maps of the diagram used last.
		this.dispose.track({
			dispose: autorun(() => {
				void this.deps.editorService.targetDrawioEditor;
				this.view.refresh();
			}),
		});
		this.dispose.track({ dispose: () => [...this.panels.values()].forEach((p) => p.dispose()) });

		// A renamed or moved diagram keeps its maps.
		track(vscode.workspace.onDidRenameFiles((e) => void this.adopt(e.files)));

		// Presentation mode offers the diagram's tours.
		this.deps.look.toursOf = (editor) => this.tours(editor);

		const command = (id: string, run: (...args: any[]) => unknown) =>
			vscode.commands.registerCommand(id, async (...args: any[]) => {
				try {
					return await run(...args);
				} catch (e: any) {
					void vscode.window.showErrorMessage(`Draw.AI Mapper: ${String(e?.message ?? e)}`);
					return { error: String(e?.message ?? e) };
				}
			});
		track([
			command("drawio-ai.mapSomething", (arg?: { category?: string } | string) => this.mapSomething(typeof arg === "string" ? arg : arg?.category)),
			command("drawio-ai.maps.refreshView", () => this.view.refresh()),
			command("drawio-ai.maps.show", (arg?: unknown) => this.showMap(arg)),
			command("drawio-ai.maps.describe", (arg?: unknown) => this.describe(arg, "everyone")),
			command("drawio-ai.maps.describeForDevelopers", (arg?: unknown) => this.describe(arg, "developer")),
			command("drawio-ai.maps.recentChanges", (arg?: unknown) => this.recentChanges(arg)),
			command("drawio-ai.maps.refresh", (arg?: unknown) => this.refreshMap(arg)),
			command("drawio-ai.maps.buildTour", (arg?: unknown, focus?: string) => this.buildTour(arg, focus)),
			command("drawio-ai.maps.ask", (question?: unknown) => this.askMap(typeof question === "string" ? question : undefined)),
			command("drawio-ai.maps.digDeeper", (question?: unknown) => this.digDeeper(typeof question === "string" ? question : undefined)),
			command("drawio-ai.maps.playTour", (arg?: unknown) => this.playTour(arg)),
			command("drawio-ai.maps.showFinding", (arg?: unknown) => this.showFinding(arg)),
			command("drawio-ai.maps.fixFinding", (arg?: unknown) => this.fixFinding(arg)),
			command("drawio-ai.maps.dismissFinding", (arg?: unknown) => this.dismissFinding(arg)),
			command("drawio-ai.maps.showShapes", (arg?: unknown) => this.showShapes(arg)),
			// Not in the command palette: for tests and automation.
			vscode.commands.registerCommand("drawio-ai.maps.run", (args: MapRunArgs) => this.runForCommand(args)),
			vscode.commands.registerCommand("drawio-ai.maps.tool", (args: { name: string; args?: unknown }) => this.callTool(args?.name, args?.args)),
			vscode.commands.registerCommand("drawio-ai.maps.state", () => this.state()),
		]);
		track(this.registerLanguageModelTools());
	}

	// ----- the Mapper for one diagram -----

	private runtime(): Promise<Runtime> {
		this.runtimePromise ??= import("./runtime").then((rt) => {
			rt.setToolSource("of the Draw.AI extension");
			return rt;
		});
		return this.runtimePromise;
	}

	private target(): DrawioEditor {
		const editor = this.deps.editorService.targetDrawioEditor;
		if (!editor) {
			throw new Error("Open a draw.io diagram first: the Mapper draws into the diagram used last.");
		}
		return editor;
	}

	/**
	 * Whether the extension can read and write next to this file: a local file, or one on a
	 * remote machine (WSL, SSH, a container) when the extension runs there.
	 */
	private onDisk(uri: vscode.Uri): boolean {
		return uri.scheme === "file" || (uri.scheme === "vscode-remote" && this.deps.context.extension.extensionKind === vscode.ExtensionKind.Workspace);
	}

	/** Maps are kept next to the diagram (`.drawai/maps`), so the diagram must be a file on disk. */
	private fileOf(editor: DrawioEditor): string {
		if (!this.onDisk(editor.uri)) {
			throw new Error("The Mapper keeps its maps next to the diagram: save the diagram as a file in a folder first.");
		}
		return editor.uri.fsPath;
	}

	/** After a rename or move: the records of the diagram's maps go with it. */
	private async adopt(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
		try {
			for (const { oldUri, newUri } of files) {
				if (!this.onDisk(oldUri) || !this.onDisk(newUri)) continue;
				const from = nodePath.dirname(oldUri.fsPath);
				if (!fs.existsSync(nodePath.join(from, ".drawai", "maps"))) continue;
				const rt = await this.runtime();
				if (rt.adoptRecords({ cwd: from, diagram: oldUri.fsPath }, { cwd: nodePath.dirname(newUri.fsPath), diagram: newUri.fsPath })) this.view.refresh();
			}
		} catch {
			// the maps stay with the old name: nothing is lost
		}
	}

	private async service(editor: DrawioEditor): Promise<MapperService> {
		const rt = await this.runtime();
		this.fileOf(editor);
		let service = this.services.get(editor);
		if (!service) {
			service = new rt.MapperService({
				client: editor.drawioClient,
				cwd: () => nodePath.dirname(this.fileOf(editor)),
				diagram: () => this.fileOf(editor),
				context: (signal, progress) => this.collectContext(rt, editor, signal, progress),
			});
			this.services.set(editor, service);
		}
		return service;
	}

	/**
	 * What recipes collect with: the read-only command runner in the diagram's folder. The
	 * commands (git, cloud CLIs) run in the workspace, so it has to be trusted.
	 */
	private collectContext(rt: Runtime, editor: DrawioEditor, signal?: AbortSignal, progress?: (text: string) => void) {
		if (!vscode.workspace.isTrusted) {
			throw new rt.MapperError("The Mapper runs read-only tools (git, cloud CLIs) in this folder, so the workspace must be trusted first (Workspaces: Manage Workspace Trust).");
		}
		return rt.createContext({ cwd: nodePath.dirname(this.fileOf(editor)), env: process.env, signal, progress });
	}

	/** Sends a request to the agent; the facts a map collected go along as an attachment, not as chat text. */
	private ask(editor: DrawioEditor, request: string, extras: { selection?: SelectionContext } = {}): Promise<boolean> {
		const { text, facts } = splitFacts(request);
		return this.deps.ask(text, editor, {
			attachments: facts?.trim() ? [{ name: "map-facts", text: facts }] : undefined,
			selection: extras.selection ?? { cellIds: [] },
		});
	}

	// ----- the Map Something panel -----

	private async mapSomething(category?: string): Promise<void> {
		const editor = this.target();
		const open = this.panels.get(editor);
		if (open) {
			open.reveal();
			if (category) void open.webview.postMessage({ type: "selectCategory", category });
			return;
		}
		// (the Mapper loads on first use: a second click meanwhile must not open a second panel)
		if (this.opening.has(editor)) return;
		this.opening.add(editor);
		try {
			await this.openPanel(editor, category);
		} finally {
			this.opening.delete(editor);
		}
	}

	private async openPanel(editor: DrawioEditor, category?: string): Promise<void> {
		const rt = await this.runtime();
		const service = await this.service(editor);
		const omni = vscode.Uri.joinPath(this.deps.context.extensionUri, OMNI_DIR);
		const template = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(omni, MAPPER_PAGE))).toString("utf8");
		if (!this.deps.editorService.openedEditors.has(editor)) return; // closed meanwhile
		const panel = vscode.window.createWebviewPanel(
			"drawio-ai.mapper",
			`Map Something: ${fileName(editor)}`,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [omni] }
		);
		this.panels.set(editor, panel);
		const page: { ready: boolean; loaded?: unknown } = { ready: false };
		this.panelPages.set(panel, page);
		// (a map can still be running when the panel or the diagram is closed: a closed panel has no webview to post to)
		let closed = false;
		const post = (msg: unknown) => {
			if (!closed) void panel.webview.postMessage(msg);
		};
		const state = this.deps.context.globalState;
		const core = new rt.MapperDialogCore({
			post,
			cwd: () => nodePath.dirname(this.fileOf(editor)),
			ready: () => this.deps.editorService.openedEditors.has(editor),
			service: () => service,
			context: (signal, progress) => this.collectContext(rt, editor, signal, progress),
			askAgent: (text) => void this.ask(editor, text),
			showChat: () => undefined,
			loadInputs: () => ({ ...state.get<Record<string, MapInput>>(INPUTS_KEY, {}) }),
			saveInputs: (all) => void state.update(INPUTS_KEY, all),
			pick: async (kind, current) => {
				const picked = await vscode.window.showOpenDialog({
					defaultUri: vscode.Uri.file(current || nodePath.dirname(this.fileOf(editor))),
					canSelectFolders: kind === "folder",
					canSelectFiles: kind === "file",
					canSelectMany: false,
					openLabel: "Choose",
				});
				return picked?.[0]?.fsPath;
			},
			look: () => ({ iconStyle: editor.config.look.icons, matrix: editor.config.look.matrix }),
			close: () => panel.dispose(),
		});
		const received = panel.webview.onDidReceiveMessage((msg) => {
			if (msg?.type === "ready") page.ready = true;
			if (msg?.type === "pageLoaded") {
				page.loaded = msg;
				return;
			}
			void core
				.onMessage(msg)
				.then(
					() => {
						if (msg?.type === "ready" && category) post({ type: "selectCategory", category });
					},
					(e) => post({ type: "failed", message: String(e?.message ?? e) })
				)
				.then(() => {
					if (msg?.type === "run") this.view.refresh();
				});
		});
		const editorClosed = editor.webviewPanel.onDidDispose(() => panel.dispose());
		panel.onDidDispose(() => {
			closed = true;
			core.abort();
			received.dispose();
			editorClosed.dispose();
			if (this.panels.get(editor) === panel) this.panels.delete(editor);
		});
		panel.webview.html = mapperPageHtml(template, {
			nonce: pageNonce((n) => randomBytes(n)),
			cspSource: panel.webview.cspSource,
			base: panel.webview.asWebviewUri(omni).toString(),
		});
	}

	// ----- the Maps view -----

	private async viewData(): Promise<{ records: MapRecord[]; changes: Map<string, ChangedShapes>; active: (r: MapRecord) => MapFinding[] } | undefined> {
		const editor = this.deps.editorService.targetDrawioEditor;
		if (!editor || !this.onDisk(editor.uri)) return undefined;
		const rt = await this.runtime();
		const service = await this.service(editor);
		return { records: service.records(), changes: this.changes, active: rt.activeFindings };
	}

	/** The map an action is about: the one clicked, else the biggest on the page shown, else the user picks. */
	private async pickRecord(service: MapperService, arg: unknown): Promise<MapRecord | undefined> {
		// (the Maps view passes its node, tests and other commands a map id)
		const id = typeof arg === "string" ? arg : arg && typeof arg === "object" && typeof (arg as { mapId?: unknown }).mapId === "string" ? (arg as { mapId: string }).mapId : undefined;
		if (id) return service.record(id);
		const onPage = await service.pageRecords().catch(() => [] as MapRecord[]);
		if (onPage.length) return onPage.sort((a, b) => b.graph.nodes.length - a.graph.nodes.length)[0];
		const all = service.records();
		if (!all.length) {
			void vscode.window.showInformationMessage("This diagram has no maps yet.", "Map Something…").then((pick) => pick && vscode.commands.executeCommand("drawio-ai.mapSomething"));
			return undefined;
		}
		if (all.length === 1) return all[0];
		const pick = await vscode.window.showQuickPick(
			all.map((r) => ({ label: r.title, description: r.page, detail: r.summary, record: r })),
			{ placeHolder: "Which map?" }
		);
		return pick?.record;
	}

	private async withRecord<T>(arg: unknown, run: (r: MapRecord, service: MapperService, editor: DrawioEditor, rt: Runtime) => Promise<T>): Promise<T | undefined> {
		const editor = this.target();
		const rt = await this.runtime();
		const service = await this.service(editor);
		const record = await this.pickRecord(service, arg);
		return record ? run(record, service, editor, rt) : undefined;
	}

	/** Selects a map's shapes in the editor, switching to the map's page when needed. */
	private async select(editor: DrawioEditor, r: MapRecord, nodeIds: string[]): Promise<number> {
		const rt = await this.runtime();
		const client = editor.drawioClient;
		let page = await rt.mapsOnPage(client);
		if (!page.maps.has(r.id) && r.page) {
			await client.aiPages({ op: "select", page: r.page });
			page = await rt.mapsOnPage(client);
		}
		const cells = page.maps.get(r.id);
		const ids = nodeIds.map((id) => cells?.get(id)?.cellId).filter((x): x is string => !!x);
		editor.webviewPanel.reveal(undefined, true);
		if (!ids.length) {
			if (nodeIds.length) void vscode.window.showInformationMessage("Those shapes are not on the diagram any more.");
			return 0;
		}
		await client.aiSetSelection(ids, true);
		return ids.length;
	}

	private showMap(arg: unknown) {
		return this.withRecord(arg, (r, _s, editor) => this.select(editor, r, []));
	}

	private describe(arg: unknown, audience: "everyone" | "developer") {
		return this.withRecord(arg, (r, _s, editor, rt) => this.ask(editor, rt.describePrompt(r, audience)));
	}

	private recentChanges(arg: unknown) {
		return this.withRecord(arg, async (r, service) => {
			const c = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading what changed since "${r.title}" was made…` }, () =>
				service.recentChanges(r, { draw: true })
			);
			this.changes.set(r.id, { since: c.since, changedFiles: c.changedFiles, shapes: c.shapes });
			this.view.refresh();
			void vscode.window
				.showInformationMessage(
					c.shapes.length
						? `${c.shapes.length} shape${c.shapes.length === 1 ? "" : "s"} changed since "${r.title}" was made${c.since ? ` (${c.since})` : ""}: green badges are on the Changes layer.`
						: `Nothing on "${r.title}" changed${c.since ? ` since ${c.since}` : ""} (${c.changedFiles} changed file${c.changedFiles === 1 ? "" : "s"}, none on the map).`,
					...(c.shapes.length ? ["Show in Maps"] : [])
				)
				.then((pick) => pick && vscode.commands.executeCommand("drawio-ai.maps.focus"));
			return { shapes: c.shapes.length, changedFiles: c.changedFiles, badges: c.badges };
		});
	}

	private refreshMap(arg: unknown) {
		return this.withRecord(arg, async (r, service, _editor, rt) => {
			const recipe = rt.recipeById(r.recipe);
			if (recipe?.fields.some((f) => (f.secret || f.type === "password") && f.required)) {
				void vscode.window.showInformationMessage(`"${r.title}" needs a password or token again (they are never stored): map it again from Map Something.`);
				await this.mapSomething(recipe.category);
				return undefined;
			}
			const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Mapping "${r.title}" again`, cancellable: true }, (progress, token) => {
				const ac = new AbortController();
				token.onCancellationRequested(() => ac.abort());
				return service.refresh(r, {}, { signal: ac.signal, progress: (text) => progress.report({ message: text }) });
			});
			this.view.refresh();
			void vscode.window.showInformationMessage(
				`Mapped "${r.title}" again onto "${out.drawn?.page ?? "a new page"}": ${out.diff.added} new, ${out.diff.changed} changed, ${out.diff.removed.length} removed (badges on the Changes layer). Descriptions and tours carried over.`
			);
			return { mapId: out.record.id, diff: out.diff };
		});
	}

	private buildTour(arg: unknown, focus?: string) {
		return this.withRecord(arg, async (r, _s, editor, rt) => {
			const about = focus ?? (await vscode.window.showInputBox({ title: `A tour of "${r.title}"`, prompt: "What should the tour show? Leave it empty for how the map fits together.", placeHolder: "e.g. how an order gets from the web app to the database" }));
			if (about === undefined) return false;
			return this.ask(editor, rt.tourPrompt(r, about, PLAY_TOUR));
		});
	}

	private async askMap(question?: string): Promise<boolean> {
		const editor = this.target();
		const rt = await this.runtime();
		const service = await this.service(editor);
		if (!service.records().length) {
			void vscode.window.showInformationMessage("This diagram has no maps yet.", "Map Something…").then((pick) => pick && vscode.commands.executeCommand("drawio-ai.mapSomething"));
			return false;
		}
		const q = question ?? (await vscode.window.showInputBox({ title: "Ask the map", prompt: "The agent looks the answer up in this diagram's maps and draws it as a new page.", placeHolder: "e.g. what can reach the orders database?" }));
		if (!q?.trim()) return false;
		return this.ask(editor, rt.askPrompt(q));
	}

	/** Asks the agent to investigate the selected mapped shapes further (read-only). */
	private async digDeeper(question?: string): Promise<boolean> {
		const editor = this.target();
		const rt = await this.runtime();
		const shapes = await rt.mappedSelection(editor.drawioClient).catch(() => []);
		if (!shapes.length) {
			void vscode.window.showInformationMessage("Select shapes on a map first: Dig Deeper works on shapes the Mapper drew.");
			return false;
		}
		const q = question ?? (await vscode.window.showInputBox({ title: `Dig deeper into ${shapes.length} shape${shapes.length === 1 ? "" : "s"}`, prompt: "What do you want to know? Leave it empty for a general look.", placeHolder: "e.g. what depends on these?" }));
		if (q === undefined) return false;
		// The recipe most of the selection comes from decides how to dig.
		const counts = new Map<string, number>();
		for (const s of shapes) counts.set(s.recipe, (counts.get(s.recipe) ?? 0) + 1);
		const recipe = rt.recipeById([...counts].sort((a, b) => b[1] - a[1])[0][0]);
		const data = shapes.map((s) => ({ label: s.label, data: Object.fromEntries(Object.entries(s.data).filter(([k]) => k !== "mapper")) }));
		const text = recipe?.digDeeper ? recipe.digDeeper(data, q) : rt.digDeeperRequest("mapped items", data, q);
		return this.ask(editor, text, { selection: { cellIds: [...editor.drawioClient.currentSelection] } });
	}

	// ----- findings -----

	private findingOf(arg: unknown): { mapId: string; findingId: string } {
		const a = arg as { mapId?: string; findingId?: string } | undefined;
		if (!a?.mapId || !a.findingId) throw new Error("Pick a finding in the Maps view.");
		return { mapId: a.mapId, findingId: a.findingId };
	}

	private async showFinding(arg: unknown) {
		const { mapId, findingId } = this.findingOf(arg);
		const editor = this.target();
		const r = (await this.service(editor)).record(mapId);
		return this.select(editor, r, r.findings.find((f) => f.id === findingId)?.nodeIds ?? []);
	}

	private async fixFinding(arg: unknown) {
		const { mapId, findingId } = this.findingOf(arg);
		const editor = this.target();
		const rt = await this.runtime();
		const r = (await this.service(editor)).record(mapId);
		const finding = r.findings.find((f) => f.id === findingId);
		if (!finding) throw new Error("That finding is not on the map any more.");
		return this.ask(editor, rt.fixFindingPrompt(r, finding));
	}

	private async dismissFinding(arg: unknown) {
		const { mapId, findingId } = this.findingOf(arg);
		const editor = this.target();
		const service = await this.service(editor);
		const r = service.record(mapId);
		const title = r.findings.find((f) => f.id === findingId)?.title ?? findingId;
		await service.dismiss(r, findingId);
		this.view.refresh();
		void vscode.window.showInformationMessage(`Dismissed "${title}". It comes back if it changes.`, "Undo").then(async (pick) => {
			if (!pick) return;
			await service.dismiss(service.record(mapId), findingId, false);
			this.view.refresh();
		});
		return true;
	}

	private async showShapes(arg: unknown) {
		const a = arg as { mapId?: string; nodeIds?: string[] } | undefined;
		if (!a?.mapId) throw new Error("Pick a shape in the Maps view.");
		const editor = this.target();
		return this.select(editor, (await this.service(editor)).record(a.mapId), a.nodeIds ?? []);
	}

	// ----- tours -----

	/** The diagram's map tours, for presentation mode to offer and play. */
	private async tours(editor: DrawioEditor): Promise<PresentationTour[]> {
		if (!this.onDisk(editor.uri)) return [];
		const service = await this.service(editor);
		return service.records().flatMap((r) => r.tours.map((t) => ({ mapId: r.id, title: t.title, steps: t.steps })));
	}

	private async playTour(arg: unknown) {
		const a = arg as { mapId?: string; tourId?: string; title?: string } | undefined;
		if (!a?.mapId) throw new Error("Pick a tour in the Maps view.");
		const editor = this.target();
		const r = (await this.service(editor)).record(a.mapId);
		const tour = r.tours.find((t) => t.id === a.tourId && (a.title === undefined || t.title === a.title)) ?? r.tours.find((t) => t.title === a.title) ?? r.tours[0];
		if (!tour) throw new Error(`"${r.title}" has no tour yet. Build one: right-click the map in the Maps view.`);
		// Presentation mode plays the tours of the page shown.
		await this.select(editor, r, []);
		return this.deps.look.present(editor, { mapId: r.id, title: tour.title });
	}

	// ----- the tools -----

	/**
	 * Runs one of the Mapper's tools on the diagram used last (VS Code's chat, the MCP server,
	 * `@drawio`, tests). `signal` stops a map being collected; with `confirm`, a tool that
	 * collects asks the user first (callers that have no confirmation of their own).
	 */
	public async callTool(name: string, args: unknown, opts: { signal?: AbortSignal; confirm?: boolean } = {}): Promise<ToolResult> {
		if (!MAPPER_TOOL_NAMES.has(name)) return { text: `Unknown tool ${name}`, summary: "Unknown tool", isError: true };
		try {
			const editor = this.deps.editorService.targetDrawioEditor;
			if (!editor) {
				return { text: "No draw.io diagram is open in VS Code. Ask the user to open or create a .drawio file: the Mapper draws into the diagram used last.", summary: "No diagram open", isError: true };
			}
			if (opts.confirm && collects(name)) {
				const ask = runConfirmation(name, args);
				const yes = name === "mapper_run" ? "Map It" : "Map It Again";
				if ((await vscode.window.showWarningMessage(ask.title, { modal: true, detail: ask.message.replace(/`/g, "") }, yes)) !== yes) {
					return { text: "The user did not allow this map. Do not try again unless they ask.", summary: "Not allowed", isError: true };
				}
			}
			const rt = await this.runtime();
			const service = await this.service(editor);
			const out = await rt.callMapperTool(service, name, args, { signal: opts.signal });
			if (!MAPPER_TOOL_SCHEMAS.find((t) => t.name === name)?.readOnly) this.view.refresh();
			return { text: out.text, summary: out.summary, isError: out.isError };
		} catch (e: any) {
			return { text: `Error: ${String(e?.message ?? e)}`, summary: `${name} failed`, isError: true };
		}
	}

	/** The Mapper's tools for the diagram toolbox: the MCP server (the agent there asks its own user), and `@drawio`, which does not. */
	public readonly tools: ExtraTools = {
		specs: () => MAPPER_TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
		has: (name) => MAPPER_TOOL_NAMES.has(name),
		invoke: (name, input, options) => this.callTool(name, input, { confirm: !!options.scoped }),
	};

	private registerLanguageModelTools(): vscode.Disposable[] {
		return MAPPER_TOOL_SCHEMAS.map((schema) =>
			vscode.lm.registerTool<Record<string, unknown>>(schema.name, {
				prepareInvocation: (options) => {
					// Mapping runs read-only commands and may connect to a database: the user says yes first.
					const ask = collects(schema.name) ? runConfirmation(schema.name, options.input) : undefined;
					return {
						invocationMessage: `${schema.title}…`,
						confirmationMessages: ask ? { title: ask.title, message: new vscode.MarkdownString(ask.message) } : undefined,
					};
				},
				invoke: async (options, token) => {
					// Stopping the chat request stops the map.
					const ac = new AbortController();
					const stop = token.onCancellationRequested(() => ac.abort());
					try {
						const result = await this.callTool(schema.name, options.input, { signal: ac.signal });
						return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
					} finally {
						stop.dispose();
					}
				},
			})
		);
	}

	// ----- for tests and automation -----

	private async runForCommand(args: MapRunArgs) {
		try {
			const editor = this.target();
			const service = await this.service(editor);
			const out = await service.run(String(args?.recipe), args?.input ?? {});
			this.view.refresh();
			return { mapId: out.record.id, summary: out.result.summary, page: out.drawn?.page, cells: out.drawn?.cells ?? 0, findings: out.record.findings.length, badges: out.badges, warnings: out.result.warnings ?? [] };
		} catch (e: any) {
			return { error: String(e?.message ?? e) };
		}
	}

	private async state() {
		const editor = this.deps.editorService.targetDrawioEditor;
		if (!editor || !this.onDisk(editor.uri)) return { maps: [], panelOpen: false };
		const service = await this.service(editor);
		return {
			maps: service.records().map((r) => service.summary(r)),
			panelOpen: this.panels.has(editor),
			panelPage: this.panels.has(editor) ? this.panelPages.get(this.panels.get(editor)!) : undefined,
			view: await this.view.snapshot(),
		};
	}
}

function fileName(editor: DrawioEditor): string {
	return decodeURIComponent(editor.uri.path.split("/").pop() ?? "");
}
