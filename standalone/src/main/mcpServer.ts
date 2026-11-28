import { randomBytes } from "crypto";
import * as http from "http";
import type { DiagramToolbox, ToolResult } from "../../../src/features/ai/DiagramToolbox";
import { createMcpListener, McpTool } from "../../../src/features/ai/mcp";
import { describeContext, SYSTEM_PROMPT, type SelectionContext } from "../../../src/features/ai/systemPrompt";
import { toMcpTools, TOOL_SCHEMAS } from "../../../src/features/ai/toolSchemas";
import { callMapperTool, MAPPER_TOOL_NAMES, MAPPER_TOOLS } from "./mapper/mcpTools";
import type { MapperService } from "./mapper/service";

/** Tools that need VS Code (workspace search, code links, imports into the workspace) are left out. */
const UNAVAILABLE = new Set(["drawio_code_links", "drawio_import", "drawio_get_attachment"]);

export function standaloneTools(): McpTool[] {
	return toMcpTools()
		.filter((t) => {
			const schema = TOOL_SCHEMAS.find((s) => s.name === t.name);
			return !UNAVAILABLE.has(t.name) && (!schema?.workspace || t.name === "drawio_style_reference");
		})
		.map((t) => {
			// One window = one diagram: no `file` argument.
			const { file, ...properties } = ((t.inputSchema as any).properties ?? {}) as Record<string, unknown>;
			return { ...t, inputSchema: { ...t.inputSchema, properties } };
		});
}

/**
 * Antigravity CLI (agy 1.5) silently leaves out MCP tools whose definition is large: in our
 * runs every tool up to ~690 bytes of JSON (name, description, schema) was offered to the
 * model and every one from ~720 bytes was not ("tool … is not enabled for server").
 * For it, long descriptions are cut to their first sentences, and schemas still too big
 * are reduced to their parameters' types; the full text and schemas go into the server
 * instructions, which it reads. DiagramToolbox validates the input either way.
 */
const COMPACT_DESCRIPTION_MAX = 220;
const COMPACT_TOOL_MAX = 640;

const toolSize = (t: McpTool) => JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }).length;

/** Just the parameters' names and types (and enums, when they fit). */
function skeleton(schema: any, withEnums: boolean): any {
	const prop = (v: any): any => {
		const out: any = { type: v?.type ?? "object" };
		if (withEnums && Array.isArray(v?.enum)) out.enum = v.enum;
		if (v?.type === "array") out.items = { type: v.items?.type ?? "object" };
		return out;
	};
	return {
		type: "object",
		properties: Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([k, v]) => [k, prop(v)])),
		...(schema?.required ? { required: schema.required } : {}),
	};
}

function shorten(text: string, pointer: string): string {
	const budget = COMPACT_DESCRIPTION_MAX - pointer.length;
	let short = "";
	for (const s of text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? []) {
		if ((short + s).trim().length > budget) break;
		short += s;
	}
	return (short.trim() || text.slice(0, budget - 1).trimEnd() + "…") + pointer;
}

/** Long descriptions anywhere in a tool (its own, its parameters'), as [path, full text]. */
function longDescriptions(t: McpTool): [string, string][] {
	const found: [string, string][] = [];
	if (t.description.length > COMPACT_DESCRIPTION_MAX) found.push([t.name, t.description]);
	const walk = (node: any, path: string) => {
		if (!node || typeof node !== "object") return;
		if (typeof node.description === "string" && node.description.length > COMPACT_DESCRIPTION_MAX) found.push([`${t.name} ${path}`, node.description]);
		for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}${path ? "." : ""}${k}`);
		if (node.items) walk(node.items, `${path}[]`);
	};
	walk(t.inputSchema, "");
	return found;
}

function compactTool(t: McpTool): { tool: McpTool; reducedSchema: boolean } {
	const compactSchema = (node: any): any => {
		if (!node || typeof node !== "object" || Array.isArray(node)) return node;
		const out: any = { ...node };
		if (typeof out.description === "string" && out.description.length > COMPACT_DESCRIPTION_MAX) out.description = shorten(out.description, " (More in the instructions.)");
		if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, compactSchema(v)]));
		if (out.items) out.items = compactSchema(out.items);
		return out;
	};
	let tool: McpTool = {
		...t,
		description: t.description.length > COMPACT_DESCRIPTION_MAX ? shorten(t.description, " Full reference in the server instructions.") : t.description,
		inputSchema: compactSchema(t.inputSchema),
	};
	let reducedSchema = false;
	for (const withEnums of [true, false]) {
		if (toolSize(tool) <= COMPACT_TOOL_MAX) break;
		tool = { ...tool, inputSchema: skeleton(t.inputSchema, withEnums) };
		reducedSchema = true;
	}
	if (reducedSchema && !tool.description.includes("server instructions")) {
		tool = { ...tool, description: shorten(tool.description, " Full parameter schema in the server instructions.") };
	}
	return { tool, reducedSchema };
}

export function compactTools(tools: McpTool[]): McpTool[] {
	return tools.map((t) => compactTool(t).tool);
}

/** For a client that gets shortened tools: what was shortened, in full. */
export function toolReference(tools: McpTool[]): string {
	return [
		"Tool reference. This client gets shortened tool descriptions and, for large tools, only parameter names and types; these are the full versions.",
		...tools.flatMap(longDescriptions).map(([where, text]) => `- ${where}: ${text}`),
		...tools.filter((t) => compactTool(t).reducedSchema).map((t) => `\n${t.name} parameters (JSON Schema):\n${JSON.stringify(t.inputSchema)}`),
	].join("\n");
}

/** `extraTools`: the Mapper's tools, which the compact client's full reference must cover too. */
export function standaloneInstructions(fileName: string | undefined, compact = false, extraTools: McpTool[] = []): string {
	return [
		`These tools edit the draw.io diagram${fileName ? ` "${fileName}"` : ""} that is open in the OmniDraw app, live: the user watches every change happen and can keep or revert your edits. Change the diagram ONLY through these drawio_* tools; never edit .drawio, .drawio.svg or .drawio.png files on disk (the open editor would not show it and the user's review would be skipped).`,
		SYSTEM_PROMPT.replace("embedded in VS Code", "in the OmniDraw app").split("\n\nAnswering:")[0],
		compact ? toolReference([...standaloneTools(), ...extraTools]) : undefined,
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * While a request is under way the user can add to it in the chat. There is no way to speak to
 * a model in the middle of its work but through what its tools answer: the addition is put at
 * the end of the next answer, marked as the user's.
 */
export function userUpdate(text: string): string {
	return `<user_update>\nThe user added this in the chat while you were working. It is part of their request: take it into account from here on.\n\n${text}\n</user_update>`;
}

/** The tools the chat offers a model, by name, description and schema (a window adds the Mapper's when it has one). */
export function chatToolList(mapper: boolean): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
	return [...standaloneTools(), ...(mapper ? MAPPER_TOOLS : [])].map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> }));
}

/** What the one who answers is told about such additions, so that it takes them for the user's words. */
export const ADDITIONS_NOTE =
	"While you work, the user may add to the request. An addition arrives as the last thing in the answer of one of OmniDraw's tools, inside <user_update> tags. It is typed by the user into this chat: follow it as part of the request.";

/**
 * A tool's own answer never holds those tags: what a diagram, a mapped folder or a database
 * says is read by the model as data, and must not pass for the user's words.
 */
export function withoutUpdateTags(text: string): string {
	return text.replace(/<(\s*\/?\s*user_update)/gi, "&lt;$1");
}

/**
 * What a model used through its API is told it is here for. (An agent program reads
 * `standaloneInstructions` from the endpoint; this model has no endpoint, and only these tools.)
 */
export function chatSystemPrompt(mapper: boolean): string {
	return [
		SYSTEM_PROMPT.replace("embedded in VS Code", "in the OmniDraw app"),
		mapper
			? "Maps: the Mapper draws software, databases, cloud environments and ML systems into the diagram from facts it collects read-only. The mapper_* tools work with the maps of this diagram: start with mapper_maps, look things up with mapper_find, mapper_show and mapper_path, and make a new map with mapper_run (mapper_list_recipes says what it needs). Never repeat passwords, tokens or connection strings in an answer."
			: undefined,
		"Tools that change something (the diagram, a file, a map) ask the user first. When the user does not allow one, do not call it again unless they ask for it, and say what you left undone.",
		ADDITIONS_NOTE,
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Tools that change something with some arguments only: whether a call does. (Listing the
 * pages, or showing one, changes nothing. `mapper_recent_changes` is not here although it
 * draws only when asked to: it runs git in the mapped folder either way, which is beyond the
 * diagram.)
 */
const READS_TOO: Record<string, (args: Record<string, unknown>) => boolean> = {
	drawio_pages: (a) => a.action !== "list" && a.action !== "select",
};

/** A tool as a model used through its API is offered it (see api/chatSession.ts). */
export type ChatTool = McpTool & { picture?: boolean; changes?(args: Record<string, unknown>): boolean };

/**
 * The tools of one window's document, and the endpoint an agent reaches them through: Model
 * Context Protocol on 127.0.0.1 with a random bearer token, which the window's ACP session
 * gets in `session/new`. A draw.io diagram's tools are WindowMcpServer's below; an Excalidraw
 * drawing's are ExcalidrawEndpoint's (excalidrawTools.ts). What the chat needs of either is here.
 */
export abstract class ToolEndpoint {
	public readonly token = randomBytes(24).toString("hex");
	private server: http.Server | undefined;
	private port = 0;
	/** Summaries of finished tool calls, for the chat transcript. */
	public onToolResult: ((name: string, result: ToolResult) => void) | undefined;
	/** Short tool descriptions (full text in the instructions), for agents that drop long ones. */
	public compactDescriptions = false;
	/** What the user added in the chat while a request is under way, once: it goes at the end of the next answer to the chat's own call. */
	public additions: (() => () => string | undefined) | undefined;

	/** What the document is called in a sentence: "diagram", "drawing". */
	public abstract readonly noun: string;
	/** The tools, whole. */
	protected abstract tools(): McpTool[];
	/** What an agent program reads from the endpoint about these tools (`compact`: with the full reference of what was shortened). */
	protected abstract instructions(compact: boolean): string;
	/** Runs one tool. */
	protected abstract invoke(name: string, args: unknown, opts: { signal?: AbortSignal }): Promise<ToolResult>;
	/** This window's tools, whole, as a model used through its API is offered them. */
	public abstract chatTools(): ChatTool[];
	/** What a model used through its API is told it is here for (it has no endpoint to read instructions from, only these tools). */
	public abstract chatSystemPrompt(): string;
	/** What an agent program is told with its first request: where it is, and which tools to use. */
	public abstract firstPromptNote(fileName: string | undefined): string;
	/** What is open and what the user selected, as a request is told it. */
	public abstract describeContext(fileName: string, selection: SelectionContext): string;
	/** Whether this window has the Mapper's tools. */
	public get maps(): boolean {
		return false;
	}

	/**
	 * Runs a tool the way the endpoint does (the desktop-wide endpoint routes calls here, and a
	 * model used through its API has the app run them). `signal`: the caller gave up; a map
	 * being collected stops.
	 */
	public async call(name: string, args: unknown, opts: { signal?: AbortSignal; chat?: boolean } = {}): Promise<ToolResult> {
		// (asked for as the call begins: it is for the request under way now, whenever the tool is done)
		const take = opts.chat ? this.additions?.() : undefined;
		let result: ToolResult = await this.invoke(name, args, { ...(opts.signal ? { signal: opts.signal } : {}) });
		this.onToolResult?.(name, result);
		// (`chat`: the call is the window's own chat's, an agent's over the endpoint or a model's the app
		// runs. What the user typed while it works goes to it here. Never to another caller.)
		if (typeof result.text === "string" && /user_update/i.test(result.text)) result = { ...result, text: withoutUpdateTags(result.text) };
		const added = take?.();
		if (added) result = { ...result, text: `${result.text}\n\n${userUpdate(added)}` };
		return result;
	}

	public get url(): string {
		return `http://127.0.0.1:${this.port}/mcp`;
	}

	public async start(): Promise<void> {
		const tools = this.tools();
		const compact = compactTools(tools);
		const listener = createMcpListener({
			token: () => this.token,
			port: () => this.port,
			deps: {
				serverVersion: "0.1.0",
				tools: () => (this.compactDescriptions ? compact : tools),
				instructions: async () => this.instructions(this.compactDescriptions),
				callTool: async (name, args) => this.call(name, args, { chat: true }),
			},
		});
		this.server = http.createServer(listener);
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		this.port = (this.server.address() as any).port;
	}

	public dispose(): void {
		this.server?.close();
	}
}

/** What an agent program is told with its first request about a draw.io diagram. */
function diagramFirstPromptNote(fileName: string | undefined): string {
	return [
		`You are working inside the OmniDraw app. The user has the draw.io diagram ${fileName ? `"${fileName}"` : "(not saved yet)"} open next to this chat.`,
		"Read and change it ONLY with the drawio_* tools of the \"omnidraw\" MCP server (drawio_get_diagram, drawio_apply_operations, drawio_search_shapes, drawio_render_image, drawio_lint, ...). They edit the open diagram live and the user can keep or revert your changes. Never edit diagram files on disk or with shell commands.",
		ADDITIONS_NOTE,
		"Reply with a brief summary of what you changed.",
	].join("\n");
}

/** The tools of one window's draw.io diagram (and its maps). */
export class WindowMcpServer extends ToolEndpoint {
	public readonly noun = "diagram";

	constructor(
		private readonly toolbox: DiagramToolbox,
		private readonly fileName: () => string | undefined,
		/** The window's Mapper: its maps become mapper_* tools. */
		private readonly mapper?: () => MapperService
	) {
		super();
	}

	private mapperTools(): McpTool[] {
		return this.mapper ? MAPPER_TOOLS.map(({ run, ...t }) => t) : [];
	}

	protected tools(): McpTool[] {
		return [...standaloneTools(), ...this.mapperTools()];
	}

	protected instructions(compact: boolean): string {
		return standaloneInstructions(this.fileName(), compact, this.mapperTools());
	}

	protected async invoke(name: string, args: unknown, opts: { signal?: AbortSignal }): Promise<ToolResult> {
		return this.mapper && MAPPER_TOOL_NAMES.has(name) ? callMapperTool(this.mapper(), name, args, { signal: opts.signal }) : this.toolbox.invoke(name, args as any, { scoped: true, ...(opts.signal ? { signal: opts.signal } : {}) });
	}

	public chatTools(): ChatTool[] {
		return [...standaloneTools().map((t) => (TOOL_SCHEMAS.find((s) => s.name === t.name)?.requiresVision ? { ...t, picture: true } : t)), ...this.mapperTools()].map((t) => (READS_TOO[t.name] ? { ...t, changes: READS_TOO[t.name] } : t));
	}

	public chatSystemPrompt(): string {
		return chatSystemPrompt(this.maps);
	}

	public firstPromptNote(fileName: string | undefined): string {
		return diagramFirstPromptNote(fileName);
	}

	public describeContext(fileName: string, selection: SelectionContext): string {
		return describeContext(fileName, selection);
	}

	public get maps(): boolean {
		return !!this.mapper;
	}
}
