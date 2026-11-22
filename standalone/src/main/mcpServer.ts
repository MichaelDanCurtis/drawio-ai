import { randomBytes } from "crypto";
import * as http from "http";
import type { DiagramToolbox, ToolResult } from "../../../src/features/ai/DiagramToolbox";
import { createMcpListener, McpTool } from "../../../src/features/ai/mcp";
import { SYSTEM_PROMPT } from "../../../src/features/ai/systemPrompt";
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

function toolReference(tools: McpTool[]): string {
	return [
		"Tool reference. This client gets shortened tool descriptions and, for large tools, only parameter names and types; these are the full versions.",
		...tools.flatMap(longDescriptions).map(([where, text]) => `- ${where}: ${text}`),
		...tools.filter((t) => compactTool(t).reducedSchema).map((t) => `\n${t.name} parameters (JSON Schema):\n${JSON.stringify(t.inputSchema)}`),
	].join("\n");
}

export function standaloneInstructions(fileName: string | undefined, compact = false): string {
	return [
		`These tools edit the draw.io diagram${fileName ? ` "${fileName}"` : ""} that is open in the OmniDraw app, live: the user watches every change happen and can keep or revert your edits. Change the diagram ONLY through these drawio_* tools; never edit .drawio, .drawio.svg or .drawio.png files on disk (the open editor would not show it and the user's review would be skipped).`,
		SYSTEM_PROMPT.replace("embedded in VS Code", "in the OmniDraw app").split("\n\nAnswering:")[0],
		compact ? toolReference(standaloneTools()) : undefined,
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Model Context Protocol endpoint for one window's diagram, on 127.0.0.1 with a
 * random bearer token. The window's ACP session gets it in `session/new`.
 */
export class WindowMcpServer {
	public readonly token = randomBytes(24).toString("hex");
	private server: http.Server | undefined;
	private port = 0;
	/** Summaries of finished tool calls, for the chat transcript. */
	public onToolResult: ((name: string, result: ToolResult) => void) | undefined;
	/** Short tool descriptions (full text in the instructions), for agents that drop long ones. */
	public compactDescriptions = false;

	constructor(
		private readonly toolbox: DiagramToolbox,
		private readonly fileName: () => string | undefined,
		/** The window's Mapper: its maps become mapper_* tools. */
		private readonly mapper?: () => MapperService
	) {}

	/** Runs a tool the way the endpoint does (the desktop-wide endpoint routes calls here). */
	public async call(name: string, args: unknown): Promise<ToolResult> {
		const result = this.mapper && MAPPER_TOOL_NAMES.has(name) ? await callMapperTool(this.mapper(), name, args) : await this.toolbox.invoke(name, args as any, { scoped: true });
		this.onToolResult?.(name, result);
		return result;
	}

	public get url(): string {
		return `http://127.0.0.1:${this.port}/mcp`;
	}

	public async start(): Promise<void> {
		const mapperTools = this.mapper ? MAPPER_TOOLS.map(({ run, ...t }) => t) : [];
		const tools = [...standaloneTools(), ...mapperTools];
		const compact = compactTools(tools);
		const listener = createMcpListener({
			token: () => this.token,
			port: () => this.port,
			deps: {
				serverVersion: "0.1.0",
				tools: () => (this.compactDescriptions ? compact : tools),
				instructions: async () => standaloneInstructions(this.fileName(), this.compactDescriptions),
				callTool: async (name, args) => this.call(name, args),
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
