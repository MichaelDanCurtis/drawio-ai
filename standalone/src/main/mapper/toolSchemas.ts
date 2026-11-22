import type { McpTool } from "../../../../src/features/ai/mcp";

/**
 * What the Mapper's tools are called and take: data only, nothing imported, so the VS Code
 * extension's manifest (package.json languageModelTools, the Draw.AI agent) can be generated
 * from it without loading the recipes. What each tool does is in mcpTools.ts.
 */
export interface MapperToolSchema extends McpTool {
	title: string;
}

const mapId = { type: "string", description: "Map id from mapper_maps. Default: the newest map of this diagram." };
const nodeIds = { type: "array", items: { type: "string" }, description: "Node ids (mapperId) from the map." };

export const MAPPER_TOOL_SCHEMAS: MapperToolSchema[] = [
	{
		name: "mapper_maps",
		title: "List Maps",
		readOnly: true,
		description: "List the maps of the open diagram (made with the Mapper): id, what was mapped, page, counts of shapes, descriptions, findings by severity, tours. Start here.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "mapper_list_recipes",
		title: "List What Can Be Mapped",
		readOnly: true,
		description: "What the Mapper can map (software, databases, Azure/AWS/GCP, ML): recipe ids, descriptions and their input fields.",
		inputSchema: { type: "object", properties: { category: { type: "string", enum: ["software", "database", "azure", "aws", "gcp", "ml"] } } },
	},
	{
		name: "mapper_run",
		title: "Map Something",
		readOnly: false,
		description:
			"Map something into the open diagram (read-only collection; drawn on its own page as a pending change the user keeps or reverts, with health badges). Get recipe ids and fields from mapper_list_recipes. Secret fields (passwords, connection strings, tokens) are used for this run only and never stored or returned.",
		inputSchema: { type: "object", properties: { recipe: { type: "string" }, input: { type: "object", additionalProperties: { type: "string" } } }, required: ["recipe"] },
	},
	{
		name: "mapper_find",
		title: "Find on Maps",
		readOnly: true,
		description: "Find nodes on the maps by words in their name, kind, ids, data, files or description. Returns node ids to use with mapper_show and mapper_path.",
		inputSchema: { type: "object", properties: { query: { type: "string" }, mapId }, required: ["query"] },
	},
	{
		name: "mapper_show",
		title: "Show Map Node",
		readOnly: true,
		description: "Everything a map knows about one node: where it sits, what it contains, what it uses and what uses it (with edge labels), its data, files, description and findings.",
		inputSchema: { type: "object", properties: { nodeId: { type: "string" }, mapId }, required: ["nodeId"] },
	},
	{
		name: "mapper_path",
		title: "Path Between Map Nodes",
		readOnly: true,
		description: "The shortest chain of connections between two nodes of a map, hop by hop with each connection's label and direction.",
		inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, mapId }, required: ["from", "to"] },
	},
	{
		name: "mapper_findings",
		title: "Map Findings",
		readOnly: true,
		description: "Health findings of a map (severity, the shapes concerned, evidence, suggested fix) and what was checked. Dismissed findings are left out.",
		inputSchema: { type: "object", properties: { mapId, severity: { type: "string", enum: ["high", "medium", "low", "info"] } } },
	},
	{
		name: "mapper_worksheet",
		title: "Map Description Worksheet",
		readOnly: true,
		description:
			"The facts to write plain-English descriptions from, per node: kind, where it sits, what uses it and what it uses, files and key data. Read the files when you need to. Paged: pass offset from `next`. only: 'missing' (default) or a list of node ids.",
		inputSchema: { type: "object", properties: { mapId, only: { description: "'missing' or node ids" }, offset: { type: "number" }, limit: { type: "number" } } },
	},
	{
		name: "mapper_set_descriptions",
		title: "Describe Map Shapes",
		readOnly: false,
		description:
			"Save plain-English descriptions for existing nodes of a map; they show as the shapes' tooltips. One or two sentences each, verb first, saying what it does today from evidence (who uses it, what it uses, its code), not from its name; call out stubs and placeholders. audience 'everyone' (no jargon, default) or 'developer'. Unknown node ids are refused: this never adds or removes shapes. Returns problems to fix and how many nodes still lack a description.",
		inputSchema: {
			type: "object",
			properties: {
				mapId,
				audience: { type: "string", enum: ["everyone", "developer"] },
				items: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, description: { type: "string" } }, required: ["nodeId", "description"] } },
			},
			required: ["items"],
		},
	},
	{
		name: "mapper_recent_changes",
		title: "Recent Changes on Map",
		readOnly: false,
		description: "Files changed in git since a map was made (committed and uncommitted), mapped to its shapes, with the commits. draw: true also tags those shapes with green 'changed' badges on the Changes layer.",
		inputSchema: { type: "object", properties: { mapId, draw: { type: "boolean" } } },
	},
	{
		name: "mapper_refresh",
		title: "Refresh Map",
		readOnly: false,
		description: "Map the same thing again onto a new page, keeping descriptions and tours of nodes that still exist, and tag what is new or changed. Maps that need a secret (a database password) must be refreshed by the user from the app.",
		inputSchema: { type: "object", properties: { mapId } },
	},
	{
		name: "mapper_set_tour",
		title: "Save Map Tour",
		readOnly: false,
		description:
			"Save a guided tour through a map: ordered steps, each with a short title, a one-or-two sentence caption and the node ids to show. Consecutive steps should be connected on the map. The user plays it in presentation mode.",
		inputSchema: {
			type: "object",
			properties: {
				mapId,
				title: { type: "string" },
				steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, caption: { type: "string" }, nodeIds }, required: ["caption", "nodeIds"] } },
			},
			required: ["title", "steps"],
		},
	},
	{
		name: "mapper_answer",
		title: "Answer from Maps",
		readOnly: false,
		description:
			"Answer the user's question about the maps as a picture: draws a new page with only the nodes your answer refers to, numbered in reading order, each with an optional short note, plus your answer as a note. Look things up with mapper_find / mapper_show / mapper_path first.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string" },
				answer: { type: "string" },
				steps: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, note: { type: "string" }, mapId: { type: "string" } }, required: ["nodeId"] } },
			},
			required: ["question", "answer", "steps"],
		},
	},
];

export const MAPPER_TOOL_NAMES = new Set(MAPPER_TOOL_SCHEMAS.map((t) => t.name));
