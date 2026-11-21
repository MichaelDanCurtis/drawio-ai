/**
 * "dbt lineage": sources → seeds / snapshots / models → exposures from a dbt
 * project's compiled target/manifest.json, grouped by source and model folder,
 * coloured by materialization. Reads one file; never runs dbt.
 */
import * as fs from "fs";
import * as path from "path";
import { agentRequest, digDeeperRequest, FOLDER_FIELD, folderInput, slug } from "../common";
import { MapperError } from "../../types";
import type { CollectResult, MapEdge, MapGraph, MapNode, Recipe } from "../../types";

const BOX = "rounded=1;whiteSpace=wrap;html=1;fontSize=11;";
export const DBT_STYLES: Record<string, string> = {
	source: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=8;fontSize=11;fillColor=#f5f5f5;strokeColor=#666666;",
	seed: BOX + "fillColor=#fff2cc;strokeColor=#d6b656;",
	snapshot: BOX + "fillColor=#ffe6cc;strokeColor=#d79b00;",
	table: BOX + "fillColor=#dae8fc;strokeColor=#6c8ebf;",
	view: BOX + "fillColor=#d5e8d4;strokeColor=#82b366;",
	incremental: BOX + "fillColor=#e1d5e7;strokeColor=#9673a6;",
	materialized_view: BOX + "fillColor=#d5e8d4;strokeColor=#82b366;strokeWidth=2;",
	ephemeral: BOX + "dashed=1;fillColor=#ffffff;strokeColor=#999999;fontColor=#555555;",
	other: BOX + "fillColor=#f5f5f5;strokeColor=#666666;",
	exposure: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;size=12;fontSize=11;fillColor=#f8cecc;strokeColor=#b85450;",
	group: "rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=none;strokeColor=#8b95a1;dashed=1;",
};
const EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#6b7280;";
const EXPOSURE_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;dashed=1;strokeColor=#b85450;";

const LINEAGE_TYPES = new Set(["model", "seed", "snapshot", "analysis"]);

/** Builds the lineage map from a parsed manifest (exported for tests). */
export function manifestToGraph(manifest: any, opts: { now?: string } = {}): { graph: MapGraph; facts: string; counts: Record<string, number> } {
	const project = String(manifest?.metadata?.project_name ?? "dbt project");
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const ids = new Set<string>();
	const groups = new Map<string, MapNode>();
	const counts: Record<string, number> = { source: 0, model: 0, seed: 0, snapshot: 0, exposure: 0, test: 0 };
	const tests = new Map<string, number>();
	const facts: string[] = [`# dbt project ${project}`, ""];

	const group = (id: string, label: string) => {
		if (!groups.has(id)) {
			const g: MapNode = { id: `group:${slug(id)}`, label, kind: "dbt:group", container: true, style: DBT_STYLES.group };
			groups.set(id, g);
			nodes.push(g);
		}
		return groups.get(id)!.id;
	};

	for (const n of Object.values<any>(manifest?.nodes ?? {})) {
		if (n?.resource_type === "test") for (const d of n.depends_on?.nodes ?? []) tests.set(d, (tests.get(d) ?? 0) + 1);
	}

	for (const s of Object.values<any>(manifest?.sources ?? {})) {
		counts.source++;
		const id = String(s.unique_id);
		ids.add(id);
		nodes.push({
			id: slug(id),
			label: `${s.source_name}.${s.name}`,
			kind: "dbt:source",
			parent: group(`source:${s.source_name}`, `source: ${s.source_name}`),
			style: DBT_STYLES.source,
			width: 170,
			height: 60,
			data: { uniqueId: id, resourceType: "source", schema: String(s.schema ?? ""), relation: String(s.identifier ?? s.name ?? ""), package: String(s.package_name ?? "") },
		});
		facts.push(`- source ${s.source_name}.${s.name} (${s.schema}.${s.identifier ?? s.name})${s.description ? `: ${String(s.description).slice(0, 200)}` : ""}`);
	}

	for (const n of Object.values<any>(manifest?.nodes ?? {})) {
		if (!LINEAGE_TYPES.has(n?.resource_type)) continue;
		const type = String(n.resource_type);
		counts[type] = (counts[type] ?? 0) + 1;
		const id = String(n.unique_id);
		ids.add(id);
		const mat = type === "model" ? String(n.config?.materialized ?? "view") : type;
		const fqn: string[] = Array.isArray(n.fqn) ? n.fqn : [];
		const folder = type === "model" ? (fqn.length > 2 ? fqn.slice(1, -1).join("/") : "models") : `${type}s`;
		const pkg = String(n.package_name ?? "");
		const t = tests.get(id) ?? 0;
		nodes.push({
			id: slug(id),
			label: `${n.alias ?? n.name}\n${mat}${t ? ` · ${t} test${t > 1 ? "s" : ""}` : ""}`,
			kind: `dbt:${type}`,
			parent: group(`${pkg}:${folder}`, pkg && pkg !== project ? `${pkg}: ${folder}` : folder),
			style: DBT_STYLES[mat] ?? DBT_STYLES[type] ?? DBT_STYLES.other,
			width: 170,
			height: 52,
			data: {
				uniqueId: id,
				resourceType: type,
				materialized: mat,
				schema: String(n.schema ?? ""),
				relation: String(n.alias ?? n.name ?? ""),
				path: String(n.original_file_path ?? ""),
				package: pkg,
				...(t ? { tests: String(t) } : {}),
			},
		});
		const cols = Object.keys(n.columns ?? {});
		facts.push(
			`- ${type} ${n.name} [${mat}] ${n.original_file_path ?? ""}${n.description ? `: ${String(n.description).slice(0, 200)}` : ""}${cols.length ? `\n  columns: ${cols.slice(0, 40).join(", ")}` : ""}\n  depends on: ${(n.depends_on?.nodes ?? []).join(", ") || "-"}`
		);
	}

	for (const e of Object.values<any>(manifest?.exposures ?? {})) {
		counts.exposure++;
		const id = String(e.unique_id);
		ids.add(id);
		nodes.push({
			id: slug(id),
			label: `${e.label ?? e.name}\n${e.type ?? "exposure"}`,
			kind: "dbt:exposure",
			parent: group("exposures", "exposures"),
			style: DBT_STYLES.exposure,
			width: 170,
			height: 52,
			data: { uniqueId: id, resourceType: "exposure", type: String(e.type ?? ""), maturity: String(e.maturity ?? ""), ...(e.url ? { url: String(e.url) } : {}) },
		});
		facts.push(`- exposure ${e.name} (${e.type ?? ""}) depends on: ${(e.depends_on?.nodes ?? []).join(", ")}`);
	}

	const addEdges = (n: any, style: string) => {
		for (const d of new Set<string>(n.depends_on?.nodes ?? [])) if (ids.has(d) && ids.has(n.unique_id)) edges.push({ from: slug(d), to: slug(String(n.unique_id)), kind: "lineage", style });
	};
	for (const n of Object.values<any>(manifest?.nodes ?? {})) if (LINEAGE_TYPES.has(n?.resource_type)) addEdges(n, EDGE);
	for (const e of Object.values<any>(manifest?.exposures ?? {})) addEdges(e, EXPOSURE_EDGE);

	counts.test = [...tests.values()].reduce((a, b) => a + b, 0);
	const total = nodes.filter((n) => !n.container).length;
	const legend = [
		`dbt lineage of ${project}${manifest?.metadata?.dbt_version ? ` (dbt ${manifest.metadata.dbt_version})` : ""}: ${counts.source} source(s), ${counts.model} model(s), ${counts.seed} seed(s), ${counts.snapshot} snapshot(s), ${counts.exposure} exposure(s).`,
		"Cylinders: sources. Blue: table, green: view, purple: incremental, dashed: ephemeral, yellow: seeds, orange: snapshots, red hexagons: exposures.",
		`Read from target/manifest.json ${opts.now ?? new Date().toISOString()}${manifest?.metadata?.generated_at ? ` (compiled ${manifest.metadata.generated_at})` : ""}.`,
	];
	if (total > 400) legend.push(`${total} nodes: ask the agent to dig deeper into one folder at a time.`);
	return { graph: { title: `dbt · ${project}`, nodes, edges, direction: "right", legend }, facts: facts.join("\n"), counts };
}

export const dbtLineageRecipe: Recipe = {
	id: "database.dbt-lineage",
	category: "database",
	title: "dbt lineage",
	description: "Sources, seeds, snapshots, models and exposures of a dbt project with their materializations and dependencies, read from target/manifest.json (run `dbt compile` or `dbt docs generate` first).",
	mode: "inventory",
	fields: [
		{ ...FOLDER_FIELD, label: "dbt project folder" },
		{ id: "manifest", label: "Manifest", type: "text", default: "target/manifest.json", help: "Relative to the project folder." },
	],
	async collect(input, ctx): Promise<CollectResult> {
		const root = folderInput(input, ctx.cwd);
		const file = path.resolve(root, (input.manifest || "target/manifest.json").trim());
		if (!fs.existsSync(file)) throw new MapperError(`No ${path.relative(root, file) || "manifest.json"} in ${path.basename(root)}.`, "Run `dbt compile` (or `dbt docs generate`) in the project first.");
		ctx.progress("Reading the dbt manifest…");
		let manifest: any;
		try {
			manifest = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (e: any) {
			throw new MapperError(`${path.basename(file)} is not valid JSON: ${String(e?.message ?? e).split("\n")[0]}`);
		}
		const { graph, facts, counts } = manifestToGraph(manifest);
		if (!graph.nodes.some((n) => !n.container)) return { summary: "The manifest has no sources, models or exposures.", warnings: [] };
		return {
			graph,
			facts,
			summary: `${counts.model} model(s), ${counts.source} source(s), ${counts.seed + counts.snapshot} seed(s)/snapshot(s), ${counts.exposure} exposure(s)`,
			warnings: [],
		};
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"This page maps a dbt project's lineage. Explain the layers on the map (staging, intermediate, marts...) with a short note per folder, and flag issues next to the models they concern: models without tests, marts reading sources directly, long chains of views, unused models (nothing downstream and no exposure). Read the model SQL in the repository; do not run dbt.",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("dbt models and sources (read their SQL and YAML under the project folder; do not run dbt)", shapes, question),
};
