import { MAPPER_TOOL_SCHEMAS } from "../../../standalone/src/main/mapper/toolSchemas";
import type { McpTool } from "./mcp";
import { toMcpTools } from "./toolSchemas";

export { MAPPER_TOOL_NAMES, MAPPER_TOOL_SCHEMAS } from "../../../standalone/src/main/mapper/toolSchemas";

/**
 * Every tool the extension serves over MCP (its own server and the agent bridge): the diagram
 * tools, then the Mapper's. No vscode import: the agent bridge runs outside VS Code.
 */
export function allMcpTools(): McpTool[] {
	return [...toMcpTools(), ...MAPPER_TOOL_SCHEMAS.map(({ name, title, description, inputSchema, readOnly }) => ({ name, title, description, inputSchema, readOnly }))];
}
