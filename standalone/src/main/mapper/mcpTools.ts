import type { McpTool } from "../../../../src/features/ai/mcp";
import { catalog } from "./registry";
import type { MapperService } from "./service";
import { MapperError } from "./types";

/**
 * The Mapper as MCP tools: for the app's own agents (each window's MCP server)
 * and for Claude Code / Codex connected to the desktop app. Lookups first, so an
 * agent can ask the map before grepping (floorplan's query CLI, as tools).
 */
interface MapperTool extends McpTool {
	run(service: MapperService, args: any): Promise<unknown>;
}

const mapId = { type: "string", description: "Map id from mapper_maps. Default: the newest map of this diagram." };
const nodeIds = { type: "array", items: { type: "string" }, description: "Node ids (mapperId) from the map." };

export const MAPPER_TOOLS: MapperTool[] = [
	{
		name: "mapper_maps",
		readOnly: true,
		description: "List the maps of the open diagram (made with the Mapper): id, what was mapped, page, counts of shapes, descriptions, findings by severity, tours. Start here.",
		inputSchema: { type: "object", properties: {} },
		run: async (s) => ({ onPage: (await s.pageRecords()).map((r) => r.id), maps: s.records().map((r) => s.summary(r)) }),
	},
	{
		name: "mapper_list_recipes",
		readOnly: true,
		description: "What the Mapper can map (software, databases, Azure/AWS/GCP, ML): recipe ids, descriptions and their input fields.",
		inputSchema: { type: "object", properties: { category: { type: "string", enum: ["software", "database", "azure", "aws", "gcp", "ml"] } } },
		run: async (_s, a) => catalog().recipes.filter((r) => !a.category || r.category === a.category).map((r) => ({ id: r.id, title: r.title, description: r.description, fields: r.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, options: f.options?.map((o) => o.value), secret: !!(f.secret || f.type === "password") })) })),
	},
	{
		name: "mapper_run",
		readOnly: false,
		description:
			"Map something into the open diagram (read-only collection; drawn on its own page as a pending change the user keeps or reverts, with health badges). Get recipe ids and fields from mapper_list_recipes. Secret fields (passwords, connection strings, tokens) are used for this run only and never stored or returned.",
		inputSchema: { type: "object", properties: { recipe: { type: "string" }, input: { type: "object", additionalProperties: { type: "string" } } }, required: ["recipe"] },
		run: async (s, a) => {
			const out = await s.run(String(a.recipe), a.input ?? {});
			return { map: s.summary(out.record), drawnOn: out.drawn?.page, healthBadges: out.badges, warnings: out.result.warnings ?? [] };
		},
	},
	{
		name: "mapper_find",
		readOnly: true,
		description: "Find nodes on the maps by words in their name, kind, ids, data, files or description. Returns node ids to use with mapper_show and mapper_path.",
		inputSchema: { type: "object", properties: { query: { type: "string" }, mapId }, required: ["query"] },
		run: async (s, a) => s.find(String(a.query), a.mapId),
	},
	{
		name: "mapper_show",
		readOnly: true,
		description: "Everything a map knows about one node: where it sits, what it contains, what it uses and what uses it (with edge labels), its data, files, description and findings.",
		inputSchema: { type: "object", properties: { nodeId: { type: "string" }, mapId }, required: ["nodeId"] },
		run: async (s, a) => s.show(String(a.nodeId), a.mapId),
	},
	{
		name: "mapper_path",
		readOnly: true,
		description: "The shortest chain of connections between two nodes of a map, hop by hop with each connection's label and direction.",
		inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, mapId }, required: ["from", "to"] },
		run: async (s, a) => s.path(String(a.from), String(a.to), a.mapId),
	},
	{
		name: "mapper_findings",
		readOnly: true,
		description: "Health findings of a map (severity, the shapes concerned, evidence, suggested fix) and what was checked. Dismissed findings are left out.",
		inputSchema: { type: "object", properties: { mapId, severity: { type: "string", enum: ["high", "medium", "low", "info"] } } },
		run: async (s, a) => {
			const f = s.findings(s.record(a.mapId));
			return a.severity ? { ...f, findings: f.findings.filter((x) => x.severity === a.severity) } : f;
		},
	},
	{
		name: "mapper_worksheet",
		readOnly: true,
		description:
			"The facts to write plain-English descriptions from, per node: kind, where it sits, what uses it and what it uses, files and key data. Read the files when you need to. Paged: pass offset from `next`. only: 'missing' (default) or a list of node ids.",
		inputSchema: { type: "object", properties: { mapId, only: { description: "'missing' or node ids" }, offset: { type: "number" }, limit: { type: "number" } } },
		run: async (s, a) => s.worksheet(s.record(a.mapId), { only: a.only ?? "missing", offset: a.offset, limit: Math.min(100, a.limit ?? 40) }),
	},
	{
		name: "mapper_set_descriptions",
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
		run: async (s, a) => s.setDescriptions(s.record(a.mapId), a.items ?? [], a.audience === "developer" ? "developer" : "everyone"),
	},
	{
		name: "mapper_recent_changes",
		readOnly: false,
		description: "Files changed in git since a map was made (committed and uncommitted), mapped to its shapes, with the commits. draw: true also tags those shapes with green 'changed' badges on the Changes layer.",
		inputSchema: { type: "object", properties: { mapId, draw: { type: "boolean" } } },
		run: async (s, a) => s.recentChanges(s.record(a.mapId), { draw: !!a.draw }),
	},
	{
		name: "mapper_refresh",
		readOnly: false,
		description: "Map the same thing again onto a new page, keeping descriptions and tours of nodes that still exist, and tag what is new or changed. Maps that need a secret (a database password) must be refreshed by the user from the app.",
		inputSchema: { type: "object", properties: { mapId } },
		run: async (s, a) => {
			const out = await s.refresh(s.record(a.mapId));
			return { map: s.summary(out.record), drawnOn: out.drawn?.page, diff: out.diff };
		},
	},
	{
		name: "mapper_set_tour",
		readOnly: false,
		description:
			"Save a guided tour through a map: ordered steps, each with a short title, a one-or-two sentence caption and the node ids to show. Consecutive steps should be connected on the map. The user plays it in presentation mode (F5).",
		inputSchema: {
			type: "object",
			properties: {
				mapId,
				title: { type: "string" },
				steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, caption: { type: "string" }, nodeIds }, required: ["caption", "nodeIds"] } },
			},
			required: ["title", "steps"],
		},
		run: async (s, a) => s.setTour(s.record(a.mapId), String(a.title ?? "Tour"), (a.steps ?? []).map((x: any) => ({ title: String(x.title ?? ""), caption: String(x.caption ?? ""), nodeIds: x.nodeIds ?? [] }))),
	},
	{
		name: "mapper_answer",
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
		run: async (s, a) => s.answer(String(a.question), String(a.answer), a.steps ?? []),
	},
];

export const MAPPER_TOOL_NAMES = new Set(MAPPER_TOOLS.map((t) => t.name));

/** Runs a mapper tool; errors become tool errors the agent can act on. */
export async function callMapperTool(service: MapperService, name: string, args: unknown): Promise<{ text: string; summary: string; isError?: boolean }> {
	const tool = MAPPER_TOOLS.find((t) => t.name === name);
	if (!tool) return { text: `Unknown tool ${name}`, summary: "Unknown tool", isError: true };
	try {
		const out = await tool.run(service, args ?? {});
		const text = JSON.stringify(out, null, 1);
		return { text: text.length > 120_000 ? text.slice(0, 120_000) + "\n… (truncated; page or filter)" : text, summary: summaryFor(name, out) };
	} catch (e: any) {
		return { text: String(e?.message ?? e), summary: `${name} failed`, isError: true };
	}
}

function summaryFor(name: string, out: any): string {
	switch (name) {
		case "mapper_run":
			return `Mapped: ${out?.map?.summary ?? ""}`.slice(0, 120);
		case "mapper_set_descriptions":
			return `Described ${out?.accepted ?? 0} shape(s)`;
		case "mapper_findings":
			return `${out?.findings?.length ?? 0} finding(s)`;
		case "mapper_recent_changes":
			return `${out?.shapes?.length ?? 0} shape(s) changed`;
		case "mapper_set_tour":
			return out?.saved ? "Saved a tour" : "Tour not saved";
		case "mapper_answer":
			return out?.drawn ? `Drew the answer on "${out.page}"` : "Answer not drawn";
		default:
			return name.replace(/^mapper_/, "Map: ").replace(/_/g, " ");
	}
}

export { MapperError };
