import { randomBytes } from "crypto";
import * as http from "http";
import type { DiagramToolbox, ToolResult } from "../../../src/features/ai/DiagramToolbox";
import { createMcpListener, McpTool } from "../../../src/features/ai/mcp";
import { SYSTEM_PROMPT } from "../../../src/features/ai/systemPrompt";
import { toMcpTools, TOOL_SCHEMAS } from "../../../src/features/ai/toolSchemas";

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

export function standaloneInstructions(fileName: string | undefined): string {
	return [
		`These tools edit the draw.io diagram${fileName ? ` "${fileName}"` : ""} that is open in the Draw.AI desktop app, live: the user watches every change happen and can keep or revert your edits. Change the diagram ONLY through these drawio_* tools; never edit .drawio, .drawio.svg or .drawio.png files on disk (the open editor would not show it and the user's review would be skipped).`,
		SYSTEM_PROMPT.replace("embedded in VS Code", "in the Draw.AI desktop app").split("\n\nAnswering:")[0],
	].join("\n\n");
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

	constructor(private readonly toolbox: DiagramToolbox, private readonly fileName: () => string | undefined) {}

	public get url(): string {
		return `http://127.0.0.1:${this.port}/mcp`;
	}

	public async start(): Promise<void> {
		const tools = standaloneTools();
		const listener = createMcpListener({
			token: () => this.token,
			port: () => this.port,
			deps: {
				serverVersion: "0.1.0",
				tools: () => tools,
				instructions: async () => standaloneInstructions(this.fileName()),
				callTool: async (name, args) => {
					const result = await this.toolbox.invoke(name, args, { scoped: true });
					this.onToolResult?.(name, result);
					return result;
				},
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
