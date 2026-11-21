import * as fs from "fs";
import * as path from "path";
import { agentRequest, digDeeperRequest, readFiles } from "../common";
import type { CollectResult, MapGraph, MapInput, Recipe } from "../../types";
import { MapperError } from "../../types";
import { AGENT_FRAMEWORKS, assemblePipelines, ParsedPipeline, parsePipelineFile } from "./pipelineParsers";

/** What a scan found: parsed pipelines plus files of frameworks only the agent can map. */
export interface PipelineScan {
	root: string;
	pipelines: ParsedPipeline[];
	agentOnly: { framework: string; files: string[] }[];
	warnings: string[];
	excerpts: { file: string; text: string }[];
}

const CANDIDATE = /(^|\/)(dvc\.ya?ml|[^/]+\.(ya?ml|json|py))$/i;

export function scanPipelines(target: string, progress: (t: string) => void = () => undefined): PipelineScan {
	if (!fs.existsSync(target)) throw new MapperError(`${target} does not exist.`);
	const isFile = fs.statSync(target).isFile();
	const root = isFile ? path.dirname(target) : target;
	const files = isFile
		? [{ rel: path.basename(target), abs: target, text: fs.readFileSync(target, "utf8") }]
		: readFiles(root, { match: (rel) => CANDIDATE.test(rel) && !/(^|\/)(package(-lock)?|tsconfig|\.?eslintrc|composer|renovate)\.json$/i.test(rel), maxFiles: 4000, maxBytes: 3_000_000 });
	progress(`Reading ${files.length} candidate file(s)…`);
	const pipelines: ParsedPipeline[] = [];
	const warnings: string[] = [];
	const agentOnly = new Map<string, string[]>();
	const excerpts: { file: string; text: string }[] = [];
	for (const f of files) {
		const { pipelines: found, error } = parsePipelineFile(f.rel, f.text, root);
		if (error) warnings.push(error);
		pipelines.push(...found);
		for (const p of found) warnings.push(...p.warnings);
		if (found.length === 0 && /\.(py|ya?ml)$/i.test(f.rel)) {
			for (const fw of AGENT_FRAMEWORKS) {
				if (!fw.test(f.rel, f.text)) continue;
				if (!agentOnly.has(fw.name)) agentOnly.set(fw.name, []);
				agentOnly.get(fw.name)!.push(f.rel);
				if (excerpts.length < 12) excerpts.push({ file: f.rel, text: f.text.slice(0, 5000) });
				break;
			}
		}
	}
	return { root, pipelines, agentOnly: [...agentOnly].map(([framework, files]) => ({ framework, files })), warnings, excerpts };
}

export function pipelinesToGraph(scan: PipelineScan): MapGraph {
	const { nodes, edges } = assemblePipelines(scan.pipelines);
	const name = scan.root.split(/[\\/]/).pop() ?? scan.root;
	const frameworks = [...new Set(scan.pipelines.map((p) => p.framework))];
	const one = scan.pipelines.length === 1 ? scan.pipelines[0] : undefined;
	return {
		title: one ? `${one.framework} pipeline · ${one.name}` : `ML pipelines · ${name}`,
		nodes,
		edges,
		direction: "right",
		legend: [
			`${scan.pipelines.length} pipeline(s) in ${name}: ${frameworks.join(", ")}.`,
			"Purple: steps (rows: command / image / params). Green cylinders: data. Red cubes: models. Yellow documents: metrics and reports.",
			"Solid arrows: data passing; dashed: order-only dependencies and parameters.",
			...(scan.agentOnly.length ? [`Not drawn (ask the agent): ${scan.agentOnly.map((a) => `${a.framework} (${a.files.length})`).join(", ")}.`] : []),
		],
	};
}

function pipelineFacts(scan: PipelineScan): string {
	const parts: string[] = [`# ML pipelines in ${scan.root}`];
	for (const p of scan.pipelines) {
		parts.push(`\n## ${p.name} (${p.framework}, ${p.file})`);
		for (const n of p.nodes) {
			if (n.kind === "ml:params") continue;
			const d = Object.entries(n.data ?? {})
				.filter(([k]) => !["framework", "file", "pipeline"].includes(k))
				.map(([k, v]) => `${k}=${v.length > 160 ? v.slice(0, 160) + "…" : v}`)
				.join("; ");
			parts.push(`- [${n.kind}] ${n.label.replace(/\n/g, " ")}${d ? ` — ${d}` : ""}`);
		}
		const label = new Map(p.nodes.map((n) => [n.id, n.label.replace(/\n.*/s, "")]));
		if (p.edges.length) parts.push(`Edges: ${p.edges.map((e) => `${label.get(e.from)} → ${label.get(e.to)}${e.label ? ` (${e.label})` : ""}`).join("; ")}`);
	}
	if (scan.agentOnly.length) {
		parts.push("\n## Pipelines the Mapper could not parse deterministically");
		for (const a of scan.agentOnly) parts.push(`- ${a.framework}: ${a.files.join(", ")}`);
		for (const e of scan.excerpts) parts.push(`\n### ${e.file} (first ${e.text.length} chars)\n\`\`\`\n${e.text}\n\`\`\``);
	}
	return parts.join("\n");
}

export const mlPipelineRecipe: Recipe = {
	id: "ml.pipeline",
	category: "ml",
	title: "ML pipeline",
	description:
		"Steps, datasets, models and metrics of ML pipelines read from their definitions: DVC (dvc.yaml), Kubeflow / Vertex compiled pipelines, Azure ML pipeline jobs, SageMaker pipeline definitions, Airflow DAGs and Metaflow flows. Prefect, Dagster, ZenML, Kedro and Flyte are handed to the agent.",
	mode: "inventory",
	fields: [
		{ id: "folder", label: "Repository or folder", type: "folder", help: "Scanned for pipeline definitions. Read locally; nothing is uploaded except what you then send to the agent." },
		{ id: "file", label: "…or a single pipeline file", type: "file", help: "dvc.yaml, a compiled KFP pipeline (YAML/JSON), an Azure ML pipeline job, a SageMaker definition JSON or an Airflow DAG." },
	],
	async collect(input: MapInput, ctx): Promise<CollectResult> {
		const target = (input.file || input.folder || ctx.cwd).trim();
		ctx.progress("Looking for pipeline definitions…");
		const scan = scanPipelines(target, (t) => ctx.progress(t));
		const facts = pipelineFacts(scan);
		if (scan.pipelines.length === 0) {
			if (scan.agentOnly.length) {
				return {
					summary: `No pipeline definition the Mapper can parse; found ${scan.agentOnly.map((a) => `${a.framework} in ${a.files.length} file(s)`).join(", ")}. Ask the agent to map them.`,
					facts,
					warnings: scan.warnings,
				};
			}
			return { summary: `No ML pipeline definitions found in ${target}.`, warnings: scan.warnings };
		}
		const graph = pipelinesToGraph(scan);
		const steps = graph.nodes.filter((n) => n.kind === "ml:step" || n.kind === "ml:register" || n.kind === "ml:condition").length;
		const artifacts = graph.nodes.filter((n) => /^ml:(data|model|metrics|artifact)$/.test(n.kind)).length;
		return {
			graph,
			summary: `${scan.pipelines.length} pipeline(s) (${[...new Set(scan.pipelines.map((p) => p.framework))].join(", ")}): ${steps} step(s), ${artifacts} artifact(s)${scan.agentOnly.length ? `; ${scan.agentOnly.map((a) => a.framework).join(", ")} left to the agent` : ""}`,
			facts,
			warnings: scan.warnings,
		};
	},
	agentPrompt(_input, result) {
		if (result && !result.graph && result.facts) {
			return agentRequest(
				"Map the ML pipelines described in the facts below (the Mapper detected the framework but cannot parse it deterministically). Read the listed source files, then draw each pipeline left to right: steps as rounded boxes, datasets as cylinders, models as cubes, metrics as documents, with arrows for data passing and dashed arrows for order-only dependencies. One container per pipeline, labelled with its name, framework and file.",
				result.facts
			);
		}
		return agentRequest(
			"The ML pipeline map on this page was drawn from the pipeline definitions. Complete it: for each step, read the code it runs and add a short note on what it does (inputs read, outputs written, model/framework used); add data sources and sinks the definitions do not declare (buckets, tables, feature stores); flag steps without caching, missing evaluation gates before registration/deployment, and hard-coded paths or credentials. Map any pipelines listed as not drawn.",
			result?.facts
		);
	},
	digDeeper: (shapes, question) =>
		digDeeperRequest(
			"ML pipeline steps and artifacts (find the code each step runs — its command, component, image or function — and trace what data it reads and writes and which model it trains or uses)",
			shapes,
			question
		),
};
