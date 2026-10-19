import type { DrawioEditor } from "../../DrawioEditorService";
import { getAiSettings } from "./aiSettings";
import { lintDiagram } from "./lint";
import type { LoadedTemplate } from "./templates/profile";
import type { ImageData, ToolSpec } from "./providers/types";
import { getStyleReference } from "./styleReference";
import { TOOL_SCHEMAS } from "./toolSchemas";

export interface ToolResult {
	text: string;
	image?: ImageData;
	isError?: boolean;
	/** Short human-readable summary for chat UIs. */
	summary: string;
}

class ToolInputError extends Error {}

const MAX_XML_CHARS = 80_000;

/**
 * Implements the diagram tools against whichever draw.io editor is active
 * (or was last active), so tools keep working while the chat has focus.
 */
export class DiagramToolbox {
	constructor(
		private readonly getEditor: () => DrawioEditor | undefined,
		private readonly getTemplate: (editor: DrawioEditor) => Promise<LoadedTemplate | undefined> = async () => undefined,
		private readonly codeLinks?: {
			report(editor: DrawioEditor, ids?: string[]): Promise<{ text: string; summary: string }>;
			refresh(editor: DrawioEditor, ids: string[]): Promise<{ updated: string[]; skipped: string[] }>;
		}
	) {}

	public specs(options: { vision: boolean }): ToolSpec[] {
		return TOOL_SCHEMAS.filter((t) => options.vision || !t.requiresVision).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));
	}

	public async invoke(name: string, rawInput: unknown): Promise<ToolResult> {
		const editor = this.getEditor();
		if (!editor) {
			return {
				isError: true,
				summary: "No diagram open",
				text: "No draw.io diagram is open in VS Code. Ask the user to open or create a .drawio file.",
			};
		}
		try {
			const input = normalizeInput(rawInput);
			switch (name) {
				case "drawio_get_diagram":
					return await this.getDiagram(editor, input);
				case "drawio_apply_operations":
					return await this.applyOperations(editor, input);
				case "drawio_find_cells":
					return await this.findCells(editor, input);
				case "drawio_select_cells":
					return await this.selectCells(editor, input);
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

	private async getDiagram(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const scope = input.scope === "selection" ? "selection" : "page";
		const model = await editor.drawioClient.aiGetModel({
			scope,
			includeStyles: input.includeStyles !== false,
			maxCells: clampNumber(input.maxCells, 1, 5000) ?? getAiSettings().maxCellsInContext,
		});
		const template = await this.getTemplate(editor);
		const notes = [
			"Geometry x/y are relative to the cell's parent container.",
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
					: `Read diagram (${model.totalCells} cells)`,
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
		const createdOrChanged = [...new Set(result.results.flatMap((r) => r.ids ?? []))];
		const payload = {
			ok: failed.length === 0,
			rolledBack: result.rolledBack,
			applied: result.rolledBack ? 0 : okCount,
			failed: failed.map((f) => ({ index: f.index, op: f.op, error: f.error })),
			idMap: result.idMap,
			affectedIds: createdOrChanged.slice(0, 200),
			...(settings.reviewChanges && !result.rolledBack && okCount > 0
				? {
						note: "Applied and shown to the user as pending changes they can keep or revert. Keep working normally; do not ask them to accept.",
				  }
				: {}),
		};
		const summary =
			failed.length === 0
				? `Applied ${okCount} edit${okCount === 1 ? "" : "s"}`
				: result.rolledBack
				? `Rolled back: ${failed[0].error?.slice(0, 60)}`
				: `Applied ${okCount}, ${failed.length} failed`;
		return { text: JSON.stringify(payload), summary, isError: failed.length > 0 };
	}

	/** Lint the whole page (with the active template); used by the tool and the review command. */
	public async lintEditor(editor: DrawioEditor) {
		const [model, template] = await Promise.all([
			editor.drawioClient.aiGetModel({ scope: "page", includeStyles: true, maxCells: 20000 }),
			this.getTemplate(editor),
		]);
		return { issues: lintDiagram(model, template), template };
	}

	private async lint(editor: DrawioEditor, input: Record<string, any>): Promise<ToolResult> {
		const { issues, template } = await this.lintEditor(editor);
		const ids: string[] = Array.isArray(input.ids) ? input.ids.map(String) : [];
		const shown = ids.length ? issues.filter((i) => i.cellIds.length === 0 || i.cellIds.some((id) => ids.includes(id))) : issues;
		return {
			text: JSON.stringify({
				template: template?.manifest.name ?? null,
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
		const model = await editor.drawioClient.aiGetModel({ scope: "page", includeStyles: true, maxCells: 20000 });
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
			text: JSON.stringify({ total: matches.length, matches: shown }),
			summary: `Found ${matches.length} cell${matches.length === 1 ? "" : "s"}`,
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

function clampNumber(v: unknown, min: number, max: number): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}
