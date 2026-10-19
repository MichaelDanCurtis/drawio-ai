import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";
import { getAiSettings } from "./aiSettings";
import type { ExportRequest } from "./exportDiagram";
import type { ImportRequest } from "../importDiagram";
import { lintDiagram } from "./lint";
import type { LoadedTemplate } from "./templates/profile";
import type { ImageData, ToolSpec } from "./providers/types";
import { getStyleReference } from "./styleReference";
import { PAGE_ACTIONS, TOOL_SCHEMAS } from "./toolSchemas";

export interface ToolResult {
	text: string;
	image?: ImageData;
	isError?: boolean;
	/** Short human-readable summary for chat UIs. */
	summary: string;
}

class ToolInputError extends Error {}

/** Diagrams beyond the focused one: what external agents (MCP) and `file` arguments need. */
export interface DiagramWorkspace {
	/** Resolves a `file` argument to an open editor, opening it (and, when `reveal`, showing it) as needed. */
	open(file: string, options: { reveal: boolean }): Promise<DrawioEditor>;
	list(input: Record<string, any>): Promise<ToolResult>;
	search(input: Record<string, any>): Promise<ToolResult>;
	create(input: Record<string, any>): Promise<ToolResult>;
}

export interface InvokeOptions {
	/** Called with the editor a tool acts on, before it runs. */
	onTarget?(editor: DrawioEditor): void;
	/** The caller's conversation belongs to the focused diagram (chat panel, @drawio): ignore `file`, no workspace tools. */
	scoped?: boolean;
}

const MAX_XML_CHARS = 80_000;

/** Asks the user to allow something drastic (a modal in VS Code, whichever surface called the tool). */
export type Confirm = (message: string, action: string) => Promise<boolean>;

const confirmWithDialog: Confirm = async (message, action) =>
	(await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;

const REVIEW_NOTE = "Applied and shown to the user as pending changes they can keep or revert. Keep working normally; do not ask them to accept.";

/**
 * Implements the diagram tools against whichever draw.io editor is active
 * (or was last active), so tools keep working while the chat has focus.
 */
export class DiagramToolbox {
	private readonly applyListeners = new Set<(editor: DrawioEditor) => void>();

	/** Called after every drawio_apply_operations batch that changed the diagram. */
	public onDidApplyOperations(listener: (editor: DrawioEditor) => void): { dispose(): void } {
		this.applyListeners.add(listener);
		return { dispose: () => void this.applyListeners.delete(listener) };
	}

	constructor(
		private readonly getEditor: () => DrawioEditor | undefined,
		private readonly getTemplate: (editor: DrawioEditor) => Promise<LoadedTemplate | undefined> = async () => undefined,
		private readonly codeLinks?: {
			report(editor: DrawioEditor, ids?: string[]): Promise<{ text: string; summary: string }>;
			refresh(editor: DrawioEditor, ids: string[]): Promise<{ updated: string[]; skipped: string[] }>;
		},
		private readonly exporter?: (editor: DrawioEditor, request: ExportRequest) => Promise<{ text: string; summary: string }>,
		private readonly importer?: (request: ImportRequest) => Promise<{ text: string; summary: string }>,
		private readonly attachments?: (id: string) => Promise<ToolResult>,
		private readonly diagrams?: DiagramWorkspace,
		private readonly confirm: Confirm = confirmWithDialog
	) {}

	/**
	 * Tools for the chat panel and @drawio, whose conversation belongs to one diagram:
	 * without `file` or the workspace tools, so they cannot wander off to other files.
	 * (Copilot agent mode and MCP agents get every tool.)
	 */
	public specs(options: { vision: boolean }): ToolSpec[] {
		const forPanel = new Set(["drawio_style_reference", "drawio_import", "drawio_get_attachment"]);
		return TOOL_SCHEMAS.filter((t) => (options.vision || !t.requiresVision) && (!t.workspace || forPanel.has(t.name))).map((t) => {
			const { file, ...properties } = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
			return { name: t.name, description: t.description, inputSchema: { ...t.inputSchema, properties } };
		});
	}

	public async invoke(name: string, rawInput: unknown, options: InvokeOptions = {}): Promise<ToolResult> {
		if (name === "drawio_import") {
			// Needs no open diagram: it creates one.
			return this.importFile(rawInput);
		}
		if (name === "drawio_get_attachment") {
			// Works without an open diagram: it only reads what the request stored.
			if (!this.attachments) {
				return { isError: true, summary: "No attachments", text: "Attachments are not available." };
			}
			try {
				return await this.attachments(String(normalizeInput(rawInput).id ?? ""));
			} catch (e: any) {
				return { isError: true, summary: "Failed", text: `Error: ${e?.message ?? e}` };
			}
		}
		let input: Record<string, any>;
		let editor: DrawioEditor | undefined;
		try {
			input = normalizeInput(rawInput);
			const schema = TOOL_SCHEMAS.find((t) => t.name === name);
			if (schema?.workspace && name !== "drawio_style_reference") {
				if (!this.diagrams || options.scoped) throw new ToolInputError(`${name} is not available here.`);
				if (name === "drawio_list_diagrams") return await this.diagrams.list(input);
				if (name === "drawio_search_diagrams") return await this.diagrams.search(input);
				if (name === "drawio_create") return await this.diagrams.create(input);
			}
			const file = !options.scoped && typeof input.file === "string" && input.file.trim() ? input.file.trim() : undefined;
			if (file) {
				if (!this.diagrams) throw new ToolInputError("`file` is not supported here; omit it to use the open diagram.");
				editor = await this.diagrams.open(file, { reveal: !!schema?.mutates });
			} else {
				editor = this.getEditor();
			}
		} catch (e: any) {
			return { isError: true, summary: `Failed: ${String(e?.message ?? e).slice(0, 80)}`, text: `Error: ${e?.message ?? e}` };
		}
		if (!editor) {
			return {
				isError: true,
				summary: "No diagram open",
				text: this.diagrams
					? "No draw.io diagram is open in VS Code. Pass `file` with a diagram's path (drawio_list_diagrams lists them), create one with drawio_create, or ask the user to open one."
					: "No draw.io diagram is open in VS Code. Ask the user to open or create a .drawio file.",
			};
		}
		options.onTarget?.(editor);
		try {
			switch (name) {
				case "drawio_get_diagram":
					return await this.getDiagram(editor, input);
				case "drawio_apply_operations":
					return await this.applyOperations(editor, input);
				case "drawio_find_cells":
					return await this.findCells(editor, input);
				case "drawio_select_cells":
					return await this.selectCells(editor, input);
				case "drawio_pages":
					return await this.pages(editor, input);
				case "drawio_render_image":
					return await this.renderImage(editor, input);
				case "drawio_search_shapes":
					return await this.searchShapes(editor, input);
				case "drawio_style_reference": {
					const topic = String(input.topic ?? "all");
					return { text: getStyleReference(topic), summary: `Style reference: ${topic}` };
				}
				case "drawio_get_xml": {
					const xml = await editor.drawioClient.getXml();
					const truncated = xml.length > MAX_XML_CHARS;
					return {
						text: truncated ? xml.slice(0, MAX_XML_CHARS) + "\n<!-- truncated -->" : xml,
						summary: `Read XML (${Math.round(xml.length / 1024)} KB)`,
					};
				}
				case "drawio_lint":
					return await this.lint(editor, input);
				case "drawio_code_links": {
					if (!this.codeLinks) throw new ToolInputError("Code links are not available.");
					const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
					const refresh = ids(input.refresh);
					const refreshed = refresh.length ? await this.codeLinks.refresh(editor, refresh) : undefined;
					const report = await this.codeLinks.report(editor, ids(input.ids));
					return refreshed
						? { text: JSON.stringify({ refreshed, ...JSON.parse(report.text) }), summary: `Re-linked ${refreshed.updated.length} shape${refreshed.updated.length === 1 ? "" : "s"}` }
						: report;
				}
				case "drawio_export": {
					if (!this.exporter) throw new ToolInputError("Export is not available.");
					return await this.exporter(editor, {
						format: String(input.format ?? ""),
						path: typeof input.path === "string" ? input.path : undefined,
						currentPageOnly: input.currentPageOnly === true,
						overwrite: input.overwrite === true,
					});
				}
				case "drawio_get_template": {
					const t = await this.getTemplate(editor);
					if (!t) {
						return { text: "No design template is active for this repository. Use general good practice.", summary: "No template" };
					}
					return {
						text: JSON.stringify({
							name: t.manifest.name,
							enforce: t.manifest.enforce,
							rules: t.rules,
							profile: t.manifest.profile,
							hint: "Use profile.shapes[].style / profile.library[].style verbatim for new shapes of that kind.",
						}),
						summary: `Template "${t.manifest.name}"`,
					};
				}
				default:
					throw new ToolInputError(`Unknown tool "${name}"`);
			}
		} catch (e: any) {
			return {
				isError: true,
				summary: `Failed: ${String(e?.message ?? e).slice(0, 80)}`,
				text: `Error: ${e?.message ?? e}`,
			};
		}
	}

	private async importFile(rawInput: unknown): Promise<ToolResult> {
		try {
			if (!this.importer) throw new ToolInputError("Import is not available.");
			const input = normalizeInput(rawInput);
			return await this.importer({ path: typeof input.path === "string" ? input.path : "", open: input.open !== false });
		} catch (e: any) {
			return {
				isError: true,
				summary: `Failed: ${String(e?.message ?? e).slice(0, 80)}`,
				text: `Error: ${e?.message ?? e}`,
			};
		}
	}

	private async getDiagram(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const scope = input.scope === "selection" ? "selection" : "page";
		const model = await editor.drawioClient.aiGetModel({
			scope,
			includeStyles: input.includeStyles !== false,
			maxCells: clampNumber(input.maxCells, 1, 5000) ?? getAiSettings().maxCellsInContext,
			page: pageArg(input),
		});
		const template = await this.getTemplate(editor);
		const notes = [
			"Geometry x/y are relative to the cell's parent container.",
			!model.page.current
				? `This is page "${model.page.name}", which the editor does not show; drawio_apply_operations edits the page shown. To edit this one, drawio_pages select it first.`
				: model.page.count > 1
				? `The diagram has ${model.page.count} pages; this is "${model.page.name}", the one shown. drawio_pages lists them.`
				: undefined,
			template
				? `The repository's design template "${template.manifest.name}" is active: follow it (drawio_get_template has the rules and styles).`
				: undefined,
			model.truncated
				? `Truncated: showing ${model.cells.length} of ${model.totalCells} cells. Use drawio_find_cells or scope "selection" to narrow down.`
				: undefined,
			scope === "selection" && model.selection.length === 0
				? "Nothing is selected, so the whole page is returned."
				: undefined,
		].filter(Boolean);
		return {
			text: JSON.stringify({ ...model, notes }),
			summary:
				scope === "selection" && model.selection.length > 0
					? `Read ${model.selection.length} selected item(s)`
					: !model.page.current
					? `Read page "${model.page.name}" (${model.totalCells} cells)`
					: `Read diagram (${model.totalCells} cells)`,
		};
	}

	private async pages(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const action = String(input.action ?? "").trim() as (typeof PAGE_ACTIONS)[number];
		if (!PAGE_ACTIONS.includes(action)) {
			throw new ToolInputError(`\`action\` must be one of: ${PAGE_ACTIONS.join(", ")}.`);
		}
		const index = typeof input.index === "number" ? input.index : typeof input.index === "string" && input.index.trim() ? Number(input.index) : undefined;
		const review = getAiSettings().reviewChanges;
		let request: Omit<AiPagesAction, "action"> = {
			op: action,
			page: pageArg(input),
			name: typeof input.name === "string" ? input.name : undefined,
			index: index !== undefined && Number.isFinite(index) ? index : undefined,
			select: input.select !== false,
			review,
		};
		const client = editor.drawioClient;
		if (action === "delete") {
			// Resolve the page first: the user decides about deleting anything they made.
			const probe = await client.aiPages({ ...request, dryRun: true });
			if (probe.error || !probe.page) throw new ToolInputError(probe.error ?? "No such page.");
			const target = probe.page;
			if (target.cells > 0 && !probe.aiAdded) {
				const what = target.cells === 1 ? "1 shape or connector" : `${target.cells} shapes and connectors`;
				const ok = await this.confirm(
					`The AI wants to delete the page "${target.name}" with ${what} on it. Undo in the diagram brings it back.`,
					"Delete Page"
				);
				if (!ok) throw new ToolInputError(`The user chose not to delete page "${target.name}". Leave it as it is.`);
			}
			request = { ...request, page: target.id };
		}
		const result = await client.aiPages(request);
		if (result.error) throw new ToolInputError(result.error);

		const page = result.page;
		const shown = result.pages.find((p) => p.current);
		const showing = (p: AiPageInfo) => `"${p.name}" is shown now, so drawio_apply_operations edits it.`;
		const notes = [
			(action === "add" || action === "duplicate") && page
				? page.current
					? showing(page)
					: `The editor still shows "${shown?.name}". Select "${page.name}" before editing it.`
				: undefined,
			action === "select" && page ? showing(page) : undefined,
			action === "delete" && page
				? `Deleted "${page.name}" (${page.cells} cells)${shown ? `; the editor shows "${shown.name}"` : ""}. The user can bring it back with Undo.`
				: undefined,
			review && ["add", "duplicate", "rename", "move"].includes(action) ? REVIEW_NOTE : undefined,
		].filter(Boolean);
		const name = page ? `"${page.name}"` : "";
		const summary =
			action === "list"
				? `${result.pages.length} page${result.pages.length === 1 ? "" : "s"}`
				: action === "add"
				? `Added page ${name}`
				: action === "duplicate"
				? `Duplicated page as ${name}`
				: action === "rename"
				? `Renamed page to ${name}`
				: action === "move"
				? `Moved page ${name} to position ${(page?.index ?? 0) + 1}`
				: action === "select"
				? `Showing page ${name}`
				: `Deleted page ${name}`;
		return {
			text: JSON.stringify({ pages: result.pages, ...(action !== "list" && page ? { page } : {}), ...(notes.length ? { notes } : {}) }),
			summary,
		};
	}

	private async applyOperations(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		let ops = input.ops;
		if (typeof ops === "string") {
			ops = JSON.parse(ops);
		}
		if (!Array.isArray(ops) || ops.length === 0) {
			throw new ToolInputError("`ops` must be a non-empty array of operations.");
		}
		ops.forEach((op: any, i: number) => {
			if (!op || typeof op !== "object" || typeof op.op !== "string") {
				throw new ToolInputError(`ops[${i}] must be an object with a string "op" field.`);
			}
		});

		const settings = getAiSettings();
		const result = await editor.drawioClient.aiApplyOps(ops as AiOp[], {
			atomic: input.atomic !== false,
			selectResult: input.selectResult ?? settings.selectChangedCells,
			flash: settings.flashChanges,
			review: settings.reviewChanges,
		});

		const failed = result.results.filter((r) => !r.ok);
		const okCount = result.results.length - failed.length;
		if (!result.rolledBack && okCount > 0) {
			for (const listener of [...this.applyListeners]) {
				try {
					listener(editor);
				} catch (e) {
					console.error("Draw.AI: apply listener failed", e);
				}
			}
		}
		const createdOrChanged = [...new Set(result.results.flatMap((r) => r.ids ?? []))];
		const payload = {
			ok: failed.length === 0,
			rolledBack: result.rolledBack,
			applied: result.rolledBack ? 0 : okCount,
			failed: failed.map((f) => ({ index: f.index, op: f.op, error: f.error })),
			idMap: result.idMap,
			affectedIds: createdOrChanged.slice(0, 200),
			...(settings.reviewChanges && !result.rolledBack && okCount > 0 ? { note: REVIEW_NOTE } : {}),
		};
		const summary =
			failed.length === 0
				? `Applied ${okCount} edit${okCount === 1 ? "" : "s"}`
				: result.rolledBack
				? `Rolled back: ${failed[0].error?.slice(0, 60)}`
				: `Applied ${okCount}, ${failed.length} failed`;
		return { text: JSON.stringify(payload), summary, isError: failed.length > 0 };
	}

	/** Lint a whole page (by default the one shown, with the active template); used by the tool and the review command. */
	public async lintEditor(editor: DrawioEditor, page?: string) {
		const [model, template] = await Promise.all([
			editor.drawioClient.aiGetModel({ scope: "page", includeStyles: true, maxCells: 20000, page }),
			this.getTemplate(editor),
		]);
		return { issues: lintDiagram(model, template), template, page: model.page };
	}

	private async lint(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const { issues, template, page } = await this.lintEditor(editor, pageArg(input));
		const ids: string[] = Array.isArray(input.ids) ? input.ids.map(String) : [];
		const shown = ids.length ? issues.filter((i) => i.cellIds.length === 0 || i.cellIds.some((id) => ids.includes(id))) : issues;
		return {
			text: JSON.stringify({
				template: template?.manifest.name ?? null,
				...(page.current ? {} : { page: page.name }),
				issueCount: shown.length,
				issues: shown,
				hint: shown.length
					? "Fix errors and warnings that relate to your task; mention template violations the user asked for instead of silently reverting them."
					: undefined,
			}),
			summary: shown.length === 0 ? "No lint issues" : `${shown.length} lint issue${shown.length === 1 ? "" : "s"}`,
		};
	}

	private async findCells(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const model = await editor.drawioClient.aiGetModel({ scope: "page", includeStyles: true, maxCells: 20000, page: pageArg(input) });
		const limit = clampNumber(input.limit, 1, 500) ?? 50;
		const query = typeof input.query === "string" ? input.query.trim() : "";
		let matcher: (s: string) => boolean = () => true;
		if (query) {
			const re = /^\/(.+)\/([a-z]*)$/.exec(query);
			if (re) {
				const regex = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
				matcher = (s) => regex.test(s);
			} else {
				const q = query.toLowerCase();
				matcher = (s) => s.toLowerCase().includes(q);
			}
		}
		const matches = model.cells.filter(
			(c) =>
				matcher(c.label) &&
				(!input.kind || c.kind === input.kind) &&
				(!input.styleContains || (c.style ?? "").includes(String(input.styleContains)))
		);
		const shown = matches.slice(0, limit).map((c) => ({
			id: c.id,
			kind: c.kind,
			label: c.label,
			parent: c.parent,
			geometry: c.geometry,
			source: c.source,
			target: c.target,
		}));
		return {
			text: JSON.stringify({ ...(model.page.current ? {} : { page: model.page.name }), total: matches.length, matches: shown }),
			summary: `Found ${matches.length} cell${matches.length === 1 ? "" : "s"}${model.page.current ? "" : ` on "${model.page.name}"`}`,
		};
	}

	private async selectCells(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const ids: string[] = Array.isArray(input.ids) ? input.ids.map(String) : [];
		await editor.drawioClient.aiSetSelection(ids, input.reveal !== false);
		return { text: JSON.stringify({ selected: ids }), summary: `Selected ${ids.length} item(s)` };
	}

	private async renderImage(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const ids: string[] = Array.isArray(input.ids) ? input.ids.map(String) : [];
		const dataUrl = await editor.drawioClient.aiExportImage(ids, 1200);
		const prefix = "data:image/png;base64,";
		if (!dataUrl?.startsWith(prefix)) {
			return { text: "Could not render the diagram (it may be empty).", summary: "Render failed", isError: true };
		}
		return {
			text: "Rendered PNG attached.",
			image: { mimeType: "image/png", base64: dataUrl.slice(prefix.length) },
			summary: "Rendered diagram",
		};
	}

	private async searchShapes(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const query = String(input.query ?? "").trim();
		if (!query) {
			throw new ToolInputError("`query` is required.");
		}
		const { shapes, error } = await editor.drawioClient.aiSearchShapes(query, clampNumber(input.limit, 1, 25) ?? 8);
		if (error && shapes.length === 0) {
			return { text: `Shape search failed: ${error}`, summary: "Shape search failed", isError: true };
		}
		return {
			text: JSON.stringify({
				query,
				shapes,
				hint: "Use `style` with addShape (width/height as given, or scaled proportionally). Use `xml` with insertXml for multi-cell templates.",
			}),
			summary: `Found ${shapes.length} shape${shapes.length === 1 ? "" : "s"} for "${query}"`,
		};
	}
}

function normalizeInput(raw: unknown): Record<string, any> {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			throw new ToolInputError("Tool input must be a JSON object.");
		}
	}
	if (raw && typeof raw === "object" && "__invalidJson" in (raw as any)) {
		throw new ToolInputError("Tool input was not valid JSON. Resend the call with valid JSON arguments.");
	}
	return (raw ?? {}) as Record<string, any>;
}

/** The optional `page` argument (an id or name). */
function pageArg(input: Record<string, any>): string | undefined {
	return typeof input.page === "string" && input.page.trim() ? input.page.trim() : undefined;
}

function clampNumber(v: unknown, min: number, max: number): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}
