import * as yaml from "js-yaml";
import { digDeeperRequest, FOLDER_FIELD, folderInput, readFiles } from "../common";
import type { CheckCoverage, MapEdge, MapFinding, MapGraph, MapNode, Recipe } from "../../types";
import { keepOnMap, lineMatching } from "./health";

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
	/** The file's text, for line numbers in findings. */
	text?: string;
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
			files: [wf.file],
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
				nodes.push({ id: tid, label, kind: "gha:trigger", style: TRIGGER_STYLE, width: 150, height: event === "schedule" || label.includes("\n") ? 52 : 36, data: { event }, files: [] });
			}
			const trigger = nodes.find((n) => n.id === tid);
			if (trigger?.files && !trigger.files.includes(wf.file)) trigger.files.push(wf.file);
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
				nodes.push({ id, label: `${job?.name ?? jobId}  (calls)`, kind: "gha:job", parent: wfId, data: { job: jobId, uses: String(job.uses) }, files: [wf.file] });
				const local = String(job.uses).replace(/^\.\//, "");
				const target = byFile.get(local);
				if (target) {
					edges.push({ from: id, to: target, label: "calls", kind: "calls", style: CALL_EDGE });
				} else {
					let ext = external.get(job.uses);
					if (!ext) {
						ext = `ext:${job.uses}`;
						external.set(job.uses, ext);
						nodes.push({ id: ext, label: String(job.uses).replace(/@[0-9a-f]{40}$/, "@sha"), kind: "gha:external-workflow", style: EXTERNAL_STYLE, data: { uses: String(job.uses) }, files: [] });
					}
					const extNode = nodes.find((n) => n.id === ext);
					if (extNode?.files && !extNode.files.includes(wf.file)) extNode.files.push(wf.file);
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
					files: [wf.file],
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

const FIRST_PARTY = /^(actions|github)\//i;
const PINNED = /@[0-9a-f]{40}$/i;
/** Event fields an outsider controls (issue / PR titles, branch names, commit messages...). */
const UNTRUSTED =
	/\$\{\{\s*(github\.event\.(issue\.(title|body)|pull_request\.(title|body|head\.(ref|label))|comment\.body|review\.body|review_comment\.body|discussion\.(title|body)|pages\.[^}]*\.page_name|commits\.[^}]*\.(message|author\.(email|name))|head_commit\.(message|author\.(email|name))|workflow_run\.(head_branch|head_commit\.message|display_title))|github\.head_ref)\s*\}\}/;
const PR_HEAD = /github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref|refs\/pull\//;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Risky patterns in the workflows, on the job shapes of the graph (exported for tests). */
export function workflowFindings(workflows: Workflow[], graph: MapGraph): { findings: MapFinding[]; checked: CheckCoverage[] } {
	const findings: MapFinding[] = [];
	let uses = 0;
	let prTarget = 0;
	let jobsSeen = 0;
	let runs = 0;
	for (const wf of workflows) {
		const text = wf.text ?? "";
		const at = (re: RegExp) => {
			const line = text ? lineMatching(text, re) : undefined;
			return `${wf.file}${line ? `:${line}` : ""}`;
		};
		const triggers = triggersOf(wf.doc);
		const isPrTarget = "pull_request_target" in triggers;
		if (isPrTarget) prTarget++;
		const wfPerms = wf.doc?.permissions;
		const jobs = wf.doc?.jobs && typeof wf.doc.jobs === "object" ? wf.doc.jobs : {};
		for (const [jobId, job] of Object.entries<any>(jobs)) {
			const node = `wf:${wf.file}#${jobId}`;
			const jobName = String(job?.name ?? jobId);
			const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
			jobsSeen++;
			// Actions and reusable workflows of other repositories, by tag or branch instead of a commit.
			const refs = [...(job?.uses ? [String(job.uses)] : []), ...steps.filter((st) => typeof st?.uses === "string").map((st) => String(st.uses))];
			for (const ref of refs) {
				if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
				uses++;
				if (FIRST_PARTY.test(ref) || PINNED.test(ref)) continue;
				const action = ref.split("@")[0];
				findings.push({
					id: `unpinned-action:${node}:${action}`,
					kind: "unpinned-action",
					severity: "medium",
					title: `${jobName} uses ${action} by a movable ref (${ref.includes("@") ? `@${ref.split("@").pop()}` : "no ref"})`,
					detail: `${at(new RegExp(`uses:\\s*["']?${esc(ref)}`))}: a third-party action pinned to a tag or branch can be changed by its owner and run with this job's token and secrets.`,
					nodeIds: [node],
					fix: `Pin ${action} to a full commit SHA (uses: ${action}@<40-character sha> # ${ref.split("@")[1] ?? "version"}) and let Dependabot update it.`,
				});
			}
			// pull_request_target runs with secrets and a write token: checking out the PR's code runs it with them.
			if (isPrTarget) {
				const checkout = steps.find(
					(st) =>
						(typeof st?.uses === "string" && /^actions\/checkout@/i.test(st.uses) && PR_HEAD.test(String(st?.with?.ref ?? ""))) ||
						(typeof st?.run === "string" && /gh pr checkout|git\s+(fetch|checkout|pull)\b/.test(st.run) && (PR_HEAD.test(st.run) || /gh pr checkout/.test(st.run)))
				);
				if (checkout) {
					findings.push({
						id: `pr-target-checkout:${node}`,
						kind: "pr-target-checkout",
						severity: "high",
						title: `${jobName} checks out pull request code under pull_request_target`,
						detail: `${at(PR_HEAD)}: the workflow runs on pull_request_target (with secrets and a write token) and checks out the pull request's head, so code from a fork runs with them.`,
						nodeIds: [node],
						fix: "Use the pull_request trigger for building and testing PR code, or keep pull_request_target jobs to trusted metadata only (labels, comments) without checking out or running the PR's code.",
					});
				}
			}
			// Token permissions.
			const perms = job?.permissions ?? wfPerms;
			const usesSecrets = /\$\{\{\s*secrets\./.test(JSON.stringify(job ?? {})) || job?.secrets === "inherit";
			if (perms === "write-all" || (usesSecrets && perms === undefined)) {
				const broad = perms === "write-all";
				findings.push({
					id: `token-permissions:${node}`,
					kind: "token-permissions",
					severity: "medium",
					title: broad ? `${jobName} runs with permissions: write-all` : `${jobName} uses secrets with the default token permissions`,
					detail: broad
						? `${at(/permissions:\s*write-all/)}: the GITHUB_TOKEN of this job can write to every scope of the repository.`
						: `${wf.file}: neither the job nor the workflow declares permissions, so the GITHUB_TOKEN gets the repository default (often read/write) next to the job's secrets.`,
					nodeIds: [node],
					fix: `Declare the least permissions the job needs, e.g. \`permissions: { contents: read }\` on the workflow and only the extra scopes on ${jobName}.`,
				});
			}
			// Untrusted event data expanded straight into a shell script.
			for (const st of steps) {
				const script = typeof st?.run === "string" ? st.run : typeof st?.with?.script === "string" && /github-script/.test(String(st?.uses ?? "")) ? st.with.script : undefined;
				if (script === undefined) continue;
				runs++;
				const m = UNTRUSTED.exec(script);
				if (!m) continue;
				findings.push({
					id: `script-injection:${node}`,
					kind: "script-injection",
					severity: "high",
					title: `${jobName} puts ${m[1]} into a script`,
					detail: `${at(new RegExp(esc(m[0])))}: \${{ ${m[1]} }} is expanded into the script before it runs, so a crafted title, branch name or comment becomes shell code.`,
					nodeIds: [node],
					fix: `Pass the value through an environment variable (env: VALUE: \${{ ${m[1]} }}) and use "$VALUE" in the script.`,
				});
				break;
			}
		}
	}
	const checked: CheckCoverage[] = [
		{ check: "Third-party actions pinned to a commit SHA", scanned: uses, note: "action and reusable-workflow references (actions/* and github/* are first-party)" },
		{ check: "pull_request_target workflows checking out pull request code", scanned: prTarget, note: "workflows triggered by pull_request_target" },
		{ check: "Token permissions (write-all, or unset on jobs that use secrets)", scanned: jobsSeen, note: "jobs" },
		{ check: "Untrusted event data in run scripts", scanned: runs, note: "run / github-script steps" },
	];
	return { findings: keepOnMap(findings, graph), checked };
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
				workflows.push({ file: f.rel, name: String(doc?.name ?? f.rel.split("/").pop()!.replace(/\.ya?ml$/i, "")), doc, text: f.text });
			} catch (e: any) {
				warnings.push(`${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`);
			}
		}
		if (workflows.length === 0) {
			return { summary: `No workflows in ${root}/.github/workflows.`, warnings };
		}
		const graph = workflowsToGraph(workflows, root.split(/[\\/]/).pop() ?? root);
		const { findings, checked } = workflowFindings(workflows, graph);
		return {
			graph,
			findings,
			checked,
			summary: `${workflows.length} workflow(s), ${graph.nodes.filter((n) => n.kind === "gha:job").length} job(s)`,
			warnings,
			facts: workflows.map((w) => `## ${w.name} (${w.file})\n${yaml.dump(w.doc, { lineWidth: 160 }).slice(0, 6000)}`).join("\n\n"),
		};
	},
	agentPrompt: () =>
		"Review the GitHub Actions map on this page: point out risky patterns (unpinned third-party actions, broad permissions, secrets passed to untrusted code, pull_request_target misuse, missing concurrency on deploys) with short notes next to the jobs they concern.",
	digDeeper: (shapes, question) => digDeeperRequest("GitHub Actions workflows and jobs (read the workflow files they come from)", shapes, question),
};
