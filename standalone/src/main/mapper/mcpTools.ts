import { catalog } from "./registry";
import type { MapperService } from "./service";
import { MAPPER_TOOL_NAMES, MAPPER_TOOL_SCHEMAS, MapperToolSchema } from "./toolSchemas";
import { MapperError } from "./types";

/**
 * The Mapper as MCP tools: for the app's own agents (each window's MCP server)
 * and for Claude Code / Codex connected to the desktop app. Lookups first, so an
 * agent can ask the map before grepping (floorplan's query CLI, as tools).
 */
/** For a call that collects (mapper_run, mapper_refresh): stops it when the caller gives up. */
export interface MapperCallOptions {
	signal?: AbortSignal;
}

interface MapperTool extends MapperToolSchema {
	run(service: MapperService, args: any, opts?: MapperCallOptions): Promise<unknown>;
}

const RUN: Record<string, (service: MapperService, args: any, opts?: MapperCallOptions) => Promise<unknown>> = {
	mapper_maps: async (s) => ({ onPage: (await s.pageRecords()).map((r) => r.id), maps: s.records().map((r) => s.summary(r)) }),
	mapper_list_recipes: async (_s, a) => catalog().recipes.filter((r) => !a.category || r.category === a.category).map((r) => ({ id: r.id, title: r.title, description: r.description, fields: r.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, required: !!f.required, options: f.options?.map((o) => o.value), secret: !!(f.secret || f.type === "password") })) })),
	mapper_run: async (s, a, opts) => {
		const out = await s.run(String(a.recipe), a.input ?? {}, { signal: opts?.signal });
		return { map: s.summary(out.record), drawnOn: out.drawn?.page, healthBadges: out.badges, warnings: out.result.warnings ?? [] };
	},
	mapper_find: async (s, a) => s.find(String(a.query), a.mapId),
	mapper_show: async (s, a) => s.show(String(a.nodeId), a.mapId),
	mapper_path: async (s, a) => s.path(String(a.from), String(a.to), a.mapId),
	mapper_findings: async (s, a) => {
		const f = s.findings(s.record(a.mapId));
		return a.severity ? { ...f, findings: f.findings.filter((x) => x.severity === a.severity) } : f;
	},
	mapper_worksheet: async (s, a) => s.worksheet(s.record(a.mapId), { only: a.only ?? "missing", offset: a.offset, limit: Math.min(100, a.limit ?? 40) }),
	mapper_set_descriptions: async (s, a) => s.setDescriptions(s.record(a.mapId), a.items ?? [], a.audience === "developer" ? "developer" : "everyone"),
	mapper_recent_changes: async (s, a) => s.recentChanges(s.record(a.mapId), { draw: !!a.draw }),
	mapper_refresh: async (s, a, opts) => {
		const out = await s.refresh(s.record(a.mapId), {}, { signal: opts?.signal });
		return { map: s.summary(out.record), drawnOn: out.drawn?.page, diff: out.diff };
	},
	mapper_set_tour: async (s, a) => s.setTour(s.record(a.mapId), String(a.title ?? "Tour"), (a.steps ?? []).map((x: any) => ({ title: String(x.title ?? ""), caption: String(x.caption ?? ""), nodeIds: x.nodeIds ?? [] }))),
	mapper_answer: async (s, a) => s.answer(String(a.question), String(a.answer), a.steps ?? []),
};

export const MAPPER_TOOLS: MapperTool[] = MAPPER_TOOL_SCHEMAS.map((t) => ({ ...t, run: RUN[t.name] }));

export { MAPPER_TOOL_NAMES };

/** Runs a mapper tool; errors become tool errors the agent can act on. */
export async function callMapperTool(service: MapperService, name: string, args: unknown, opts?: MapperCallOptions): Promise<{ text: string; summary: string; isError?: boolean }> {
	const tool = MAPPER_TOOLS.find((t) => t.name === name);
	if (!tool) return { text: `Unknown tool ${name}`, summary: "Unknown tool", isError: true };
	try {
		const out = await tool.run(service, args ?? {}, opts);
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
