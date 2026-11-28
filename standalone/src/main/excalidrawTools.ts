// The tools an agent has for the Excalidraw drawing of one window, on the app's side: the
// check of what a model sent (src/excalidraw/tools.ts), the hand-over to the editor page (which
// carries a call out: src/renderer/excalidraw/ai.ts), and the endpoint and words a chat needs.
import type { ToolResult } from "../../../src/features/ai/DiagramToolbox";
import type { McpTool } from "../../../src/features/ai/mcp";
import type { SelectionContext } from "../../../src/features/ai/systemPrompt";
import { EXCALIDRAW_TOOLS, idList, inputObject, parseMermaid, parseOperations, parseSceneQuery, ToolInputError } from "../excalidraw/tools";
import { ADDITIONS_NOTE, toolReference, ToolEndpoint, type ChatTool } from "./mcpServer";

/** What the tools need of the window. */
export interface DrawingHost {
	fileName(): string | undefined;
	/** Has the editor page carry out a tool call. Rejects with a PageToolError when the page says the call cannot be done as asked. */
	page(name: string, args: unknown, signal?: AbortSignal): Promise<any>;
	/** excalidraw_export: writes the drawing to a file (asking before it replaces one). */
	exportForTool(request: { format: string; path?: string; overwrite?: boolean }): Promise<{ path: string; bytes: number }>;
}

/** The editor could not do what was asked, and why is for the model to read (and try again). */
export class PageToolError extends Error {}

const MCP_TOOLS: McpTool[] = EXCALIDRAW_TOOLS.map(({ picture, ...t }) => t);

const HOW_TO = `How to work:
1. Read before writing: call excalidraw_get_scene (scope "selection" when the user has selected elements, otherwise "all") unless the current state was already returned in this turn.
2. Plan the whole change, then apply it with as FEW excalidraw_apply_operations calls as possible. Give new elements an id of your own (e.g. "api", "db") so that arrows in the same call can name them.
3. When the user selected elements, the request is about THOSE: change only them (and arrows between them) unless told otherwise. "These", "this", "them", "it" refer to the selection.
4. If a call fails, nothing was changed. Read the errors, fix the operations and send the whole list again.
5. A shape's words are its \`label\`. Never put a text element on top of a shape to label it. Connect shapes with arrows that name them (start, end), not with coordinates: such an arrow stays attached.
6. For a flowchart of more than a few boxes, excalidraw_from_mermaid lays it out for you; then adjust it with excalidraw_apply_operations.
7. Preserve what the user did not ask to change: keep ids, positions, colours and labels of untouched elements.
8. After a larger change, if excalidraw_render_image is available, use it to check that nothing overlaps.
9. When images are attached (sketches, whiteboard photos, screenshots), recreate their content as real, editable shapes and arrows, not as an embedded picture.
10. Your edits are shown to the user as pending changes (outlined) that they keep or revert. That is their decision; keep working normally and never ask them to accept. If they reverted something, read the drawing again rather than assuming your earlier edits are still there.

Layout and style:
- Coordinates are in pixels, x right, y down. A typical box is 160x80; leave 60-100px between boxes so arrows have room.
- Flows read left-to-right or top-to-bottom. Label every arrow whose meaning is not obvious.
- It is a hand-drawn canvas: keep the defaults (hand-drawn font and lines) unless asked for a clean look (roughness 0, fontFamily "normal").
- Use one fill colour per kind of thing, from Excalidraw's palette: #ffc9c9 (red), #ffec99 (yellow), #b2f2bb (green), #a5d8ff (blue), #d0bfff (violet), #ffd8a8 (orange); strokes #1e1e1e, #e03131, #f08c00, #2f9e44, #1971c2, #6741d9. Keep text short.`;

const ANSWERING = `Answering:
- For pure questions ("what does this show?") answer from excalidraw_get_scene without editing.
- After editing, reply with a brief summary of what changed (1-3 sentences). Do not dump JSON to the user.
- If a request is ambiguous and a wrong guess would be destructive (e.g. deleting many elements), ask first; otherwise make a reasonable choice and mention it.`;

/** What an agent program reads from the endpoint about the drawing's tools. */
export function excalidrawInstructions(fileName: string | undefined, compact = false): string {
	return [
		`These tools edit the Excalidraw drawing${fileName ? ` "${fileName}"` : ""} that is open in the OmniDraw app, live: the user watches every change happen and can keep or revert your edits. Change the drawing ONLY through these excalidraw_* tools; never edit .excalidraw files on disk (the open editor would not show it and the user's review would be skipped).`,
		HOW_TO,
		compact ? toolReference(MCP_TOOLS) : undefined,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** What a model used through its API is told it is here for. */
export function excalidrawSystemPrompt(): string {
	return [
		"You are OmniDraw's drawing assistant, an expert at clear hand-drawn diagrams. You edit the user's open Excalidraw drawing LIVE through tools; the user watches the changes happen.",
		HOW_TO,
		ANSWERING,
		"Tools that change something (the drawing, a file) ask the user first. When the user does not allow one, do not call it again unless they ask for it, and say what you left undone.",
		ADDITIONS_NOTE,
	].join("\n\n");
}

export function excalidrawContext(fileName: string, selection: SelectionContext): string {
	const ids = selection.cellIds;
	return [
		`Open Excalidraw drawing: ${fileName}`,
		ids.length > 0
			? `The user selected ${ids.length} element(s) with ids: ${ids.slice(0, 80).join(", ")}${ids.length > 80 ? ", ..." : ""}. Scope your changes to these unless told otherwise.`
			: "Nothing is selected; the request applies to the whole drawing.",
	].join("\n");
}

const failed = (text: string, summary = "Failed"): ToolResult => ({ isError: true, summary, text: `Error: ${text}` });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Runs the tools of one window's drawing. */
export class ExcalidrawToolbox {
	constructor(private readonly host: DrawingHost) {}

	public async invoke(name: string, rawInput: unknown, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
		try {
			const input = inputObject(rawInput);
			const page = (args: unknown) => this.host.page(name, args, options.signal);
			switch (name) {
				case "excalidraw_get_scene": {
					const scene = await page(parseSceneQuery(input));
					return { text: JSON.stringify(scene), summary: `Read ${plural(scene.returned, "element")}${scene.truncated ? ` of ${scene.total}` : ""}` };
				}
				case "excalidraw_apply_operations": {
					const operations = parseOperations(input.operations);
					const result = await page({ operations, select: input.select === true });
					const count = (op: string) => operations.filter((o) => o.op === op).length;
					const parts = [count("add") ? `added ${count("add")}` : "", count("update") ? `changed ${count("update")}` : "", count("delete") ? `deleted ${count("delete")}` : ""].filter(Boolean);
					return { text: JSON.stringify(result), summary: parts.join(", ").replace(/^./, (c) => c.toUpperCase()) };
				}
				case "excalidraw_select": {
					const ids = idList(input.ids, "ids");
					if (!ids) throw new ToolInputError("ids is missing: the elements to select (an empty list clears the selection).");
					const result = await page({ ids });
					return { text: JSON.stringify(result), summary: ids.length ? `Selected ${plural(result.selected.length, "element")}` : "Cleared the selection" };
				}
				case "excalidraw_render_image": {
					const ids = idList(input.ids, "ids");
					const picture = await page({ ...(ids?.length ? { ids } : {}) });
					return { text: `Rendered ${plural(picture.elements, "element")} as a PNG.`, image: { mimeType: picture.mimeType, base64: picture.base64 }, summary: "Rendered a preview" };
				}
				case "excalidraw_from_mermaid": {
					const result = await page(parseMermaid(input));
					return { text: JSON.stringify(result), summary: `Added ${plural(result.added, "element")} from Mermaid` };
				}
				case "excalidraw_export": {
					if (input.format !== "png" && input.format !== "svg" && input.format !== "excalidraw") throw new ToolInputError('format must be "png", "svg" or "excalidraw".');
					if (input.path !== undefined && (typeof input.path !== "string" || !input.path.trim() || input.path.length > 2000)) throw new ToolInputError("path must be a file path.");
					const written = await this.host.exportForTool({ format: input.format, ...(typeof input.path === "string" ? { path: input.path.trim() } : {}), overwrite: input.overwrite === true });
					return { text: JSON.stringify(written), summary: `Exported ${written.path.split(/[\\/]/).pop()}` };
				}
			}
			return failed(`${name} is not one of this drawing's tools.`, "Unknown tool");
		} catch (e: any) {
			if (e instanceof ToolInputError) return failed(e.message, "Invalid input");
			return failed(String(e?.message ?? e));
		}
	}
}

/** The endpoint and the words of a chat beside an Excalidraw drawing. */
export class ExcalidrawEndpoint extends ToolEndpoint {
	public readonly noun = "drawing";

	constructor(private readonly toolbox: ExcalidrawToolbox, private readonly fileName: () => string | undefined) {
		super();
	}

	protected tools(): McpTool[] {
		return MCP_TOOLS;
	}

	protected instructions(compact: boolean): string {
		return excalidrawInstructions(this.fileName(), compact);
	}

	protected invoke(name: string, args: unknown, opts: { signal?: AbortSignal }): Promise<ToolResult> {
		return this.toolbox.invoke(name, args, opts);
	}

	public chatTools(): ChatTool[] {
		return EXCALIDRAW_TOOLS.map(({ picture, ...t }) => (picture ? { ...t, picture: true } : t));
	}

	public chatSystemPrompt(): string {
		return excalidrawSystemPrompt();
	}

	public firstPromptNote(fileName: string | undefined): string {
		return [
			`You are working inside the OmniDraw app. The user has the Excalidraw drawing ${fileName ? `"${fileName}"` : "(not saved yet)"} open next to this chat.`,
			'Read and change it ONLY with the excalidraw_* tools of the "omnidraw" MCP server (excalidraw_get_scene, excalidraw_apply_operations, excalidraw_from_mermaid, excalidraw_render_image, ...). They edit the open drawing live and the user can keep or revert your changes. Never edit drawing files on disk or with shell commands.',
			ADDITIONS_NOTE,
			"Reply with a brief summary of what you changed.",
		].join("\n");
	}

	public describeContext(fileName: string, selection: SelectionContext): string {
		return excalidrawContext(fileName, selection);
	}
}
