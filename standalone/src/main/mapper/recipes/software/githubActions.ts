import * as yaml from "js-yaml";
import { digDeeperRequest, FOLDER_FIELD, folderInput, readFiles } from "../common";
import type { MapEdge, MapGraph, MapNode, Recipe } from "../../types";

const WORKFLOW_STYLE =
	"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#f6f8fa;strokeColor=#57606a;";
const TRIGGER_STYLE = "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;";
const JOB_STYLE =
	"swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;rounded=1;arcSize=4;";
const EXTERNAL_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;fontColor=#555555;";
const NEEDS_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#9673a6;";
const TRIGGER_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;strokeColor=#b38f00;fontSize=10;";
const CALL_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;dashed=1;strokeColor=#57606a;fontSize=10;";

interface Workflow {
	file: string;
	name: string;
	doc: any;
}

/** `on:` can be a string, a list or a map. */
function triggersOf(doc: any): Record<string, any> {
	const on = doc?.on ?? doc?.[true as any]; // YAML 1.1 reads a bare `on:` key as true
	if (!on) return {};
	if (typeof on === "string") return { [on]: null };
	if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [String(t), null]));
	return typeof on === "object" ? on : {};
}

function triggerLabel(event: string, config: any): string {
	if (event === "schedule" && Array.isArray(config)) return `schedule\n${config.map((c: any) => c?.cron).filter(Boolean).join(", ")}`;
	if ((event === "push" || event === "pull_request" || event === "pull_request_target") && config && typeof config === "object") {
		const branches = config.branches ?? config["branches-ignore"];
		const tags = config.tags;
		const filt = [branches ? `branches: ${[].concat(branches).join(", ")}` : "", tags ? `tags: ${[].concat(tags).join(", ")}` : ""].filter(Boolean).join("; ");
		return filt ? `${event}\n${filt}` : event;
	}
	return event;
}

/** Builds the map from parsed workflows (exported for tests). */
export function workflowsToGraph(workflows: Workflow[], repoName: string): MapGraph {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const byName = new Map<string, string>();
	const byFile = new Map<string, string>();
	for (const wf of workflows) {
		const id = `wf:${wf.file}`;
		byName.set(wf.name, id);
		byFile.set(wf.file, id);
		byFile.set(wf.file.replace(/^\.github\/workflows\//, ""), id);
	}
	const triggers = new Map<string, string>();
	const external = new Map<string, string>();

	for (const wf of workflows) {
		const wfId = `wf:${wf.file}`;
		nodes.push({
			id: wfId,
			label: `${wf.name}  (${wf.file.split("/").pop()})`,
			kind: "gha:workflow",
			container: true,
			style: WORKFLOW_STYLE,
			data: { file: wf.file },
		});
		for (const [event, config] of Object.entries(triggersOf(wf.doc))) {
			if (event === "workflow_run") {
				for (const upstream of [].concat(config?.workflows ?? [])) {
					const from = byName.get(upstream);
					const types = [].concat(config?.types ?? []).join(", ");
					if (from) edges.push({ from, to: wfId, label: `workflow_run${types ? ` (${types})` : ""}`, kind: "trigger", style: TRIGGER_EDGE });
				}
				continue;
			}
			if (event === "workflow_call") continue; // drawn as calls from the callers
			const label = triggerLabel(event, config);
			let tid = triggers.get(label);
			if (!tid) {
				tid = `trigger:${label}`;
				triggers.set(label, tid);
				nodes.push({ id: tid, label, kind: "gha:trigger", style: TRIGGER_STYLE, width: 150, height: event === "schedule" || label.includes("\n") ? 52 : 36, data: { event } });
			}
			edges.push({ from: tid, to: wfId, kind: "trigger", style: TRIGGER_EDGE });
		}
		const jobs = wf.doc?.jobs && typeof wf.doc.jobs === "object" ? wf.doc.jobs : {};
		for (const [jobId, job] of Object.entries<any>(jobs)) {
			const id = `${wfId}#${jobId}`;
			const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
			const runsOn = job?.["runs-on"] !== undefined ? [].concat(job["runs-on"]).join(", ") : undefined;
			const env = typeof job?.environment === "string" ? job.environment : job?.environment?.name;
			const rows = steps.map((s) => ({
				text: String(s?.name ?? s?.uses ?? (typeof s?.run === "string" ? s.run.split("\n")[0] : "step")).slice(0, 70),
				detail: s?.uses && s?.name ? String(s.uses).replace(/@[0-9a-f]{40}$/, "@sha").slice(0, 50) : s?.run ? "run" : undefined,
			}));
			const header = [job?.name ?? jobId, runsOn ? `⟶ ${runsOn}` : "", env ? `🌐 ${env}` : ""].filter(Boolean).join("  ");
			if (job?.uses) {
				// A call to a reusable workflow.
				nodes.push({ id, label: `${job?.name ?? jobId}  (calls)`, kind: "gha:job", parent: wfId, data: { job: jobId, uses: String(job.uses) } });
				const local = String(job.uses).replace(/^\.\//, "");
				const target = byFile.get(local);
				if (target) {
					edges.push({ from: id, to: target, label: "calls", kind: "calls", style: CALL_EDGE });
				} else {
					let ext = external.get(job.uses);
					if (!ext) {
						ext = `ext:${job.uses}`;
						external.set(job.uses, ext);
						nodes.push({ id: ext, label: String(job.uses).replace(/@[0-9a-f]{40}$/, "@sha"), kind: "gha:external-workflow", style: EXTERNAL_STYLE, data: { uses: String(job.uses) } });
					}
					edges.push({ from: id, to: ext, label: "calls", kind: "calls", style: CALL_EDGE });
				}
			} else {
				nodes.push({
					id,
					label: header,
					kind: "gha:job",
					parent: wfId,
					shape: "table",
					style: JOB_STYLE,
					rows,
					data: { job: jobId, ...(runsOn ? { runsOn } : {}), ...(env ? { environment: env } : {}), ...(job?.if ? { if: String(job.if) } : {}) },
				});
			}
			for (const need of [].concat(job?.needs ?? [])) {
				if (jobs[need]) edges.push({ from: `${wfId}#${need}`, to: id, kind: "needs", style: NEEDS_EDGE });
			}
		}
	}
	return {
		title: `GitHub Actions · ${repoName}`,
		nodes,
		edges,
		direction: "right",
		legend: [
			`GitHub Actions of ${repoName}: ${workflows.length} workflow(s), ${nodes.filter((n) => n.kind === "gha:job").length} job(s).`,
			"Yellow: triggers. Purple: jobs with their steps; arrows are `needs`. Dashed: calls to reusable workflows and workflow_run triggers.",
		],
	};
}

export const githubActionsRecipe: Recipe = {
	id: "software.github-actions",
	category: "software",
	title: "GitHub Actions workflows",
	description: "Workflows, their triggers, jobs and steps, `needs` between jobs, reusable workflows and workflow_run chains, read from .github/workflows.",
	mode: "inventory",
	fields: [FOLDER_FIELD],
	async collect(input, ctx) {
		const root = folderInput(input, ctx.cwd);
		ctx.progress("Reading .github/workflows…");
		const files = readFiles(root, { match: (rel) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel), maxDepth: 3 });
		const warnings: string[] = [];
		const workflows: Workflow[] = [];
		for (const f of files) {
			try {
				const doc: any = yaml.load(f.text);
				workflows.push({ file: f.rel, name: String(doc?.name ?? f.rel.split("/").pop()!.replace(/\.ya?ml$/i, "")), doc });
			} catch (e: any) {
				warnings.push(`${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`);
			}
		}
		if (workflows.length === 0) {
			return { summary: `No workflows in ${root}/.github/workflows.`, warnings };
		}
		const graph = workflowsToGraph(workflows, root.split(/[\\/]/).pop() ?? root);
		return {
			graph,
			summary: `${workflows.length} workflow(s), ${graph.nodes.filter((n) => n.kind === "gha:job").length} job(s)`,
			warnings,
			facts: workflows.map((w) => `## ${w.name} (${w.file})\n${yaml.dump(w.doc, { lineWidth: 160 }).slice(0, 6000)}`).join("\n\n"),
		};
	},
	agentPrompt: () =>
		"Review the GitHub Actions map on this page: point out risky patterns (unpinned third-party actions, broad permissions, secrets passed to untrusted code, pull_request_target misuse, missing concurrency on deploys) with short notes next to the jobs they concern.",
	digDeeper: (shapes, question) => digDeeperRequest("GitHub Actions workflows and jobs (read the workflow files they come from)", shapes, question),
};
