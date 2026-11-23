/**
 * Deterministic parsers for ML pipeline definitions: DVC, Kubeflow / Vertex
 * (compiled KFP IR, and Argo workflows), Azure ML pipeline jobs, SageMaker
 * pipeline definitions, Airflow DAGs and Metaflow flows (static scans).
 * Each produces a ParsedPipeline: steps, artifacts and their edges.
 */
import * as fs from "fs";
import * as path from "path";
import { slug, loadYaml, loadYamlAll } from "../common";
import type { MapEdge, MapNode, MapRow } from "../../types";
import { artifactType, ArtifactType, firstLine, kwargs, logicalLines, matchBracket, ML_STYLES, pyString, splitTopLevel, stripPyComments, styleFor } from "./shared";

export interface ParsedPipeline {
	name: string;
	framework: string;
	file: string;
	nodes: MapNode[];
	edges: MapEdge[];
	warnings: string[];
}

/** Builds one pipeline's nodes with ids local to it; `finish` scopes them under a prefix. */
export class PipelineBuilder {
	nodes: MapNode[] = [];
	edges: MapEdge[] = [];
	warnings: string[] = [];
	private ids = new Set<string>();
	private edgeKeys = new Set<string>();

	constructor(public name: string, public framework: string, public file: string) {}

	has(local: string): boolean {
		return this.ids.has(local);
	}

	private add(n: MapNode): void {
		if (this.ids.has(n.id)) return;
		this.ids.add(n.id);
		this.nodes.push(n);
	}

	/** The definition file, plus files the entry names (code a step runs, a file it writes), relative to the scanned folder. */
	private filesFor(extra?: string[]): string[] {
		return [...new Set([this.file, ...(extra ?? [])])];
	}

	step(local: string, label: string, opts: { rows?: MapRow[]; data?: Record<string, string>; parent?: string; kind?: string; files?: string[] } = {}): void {
		const rows = (opts.rows ?? []).filter((r) => r.text);
		this.add({
			id: local,
			label,
			kind: opts.kind ?? "ml:step",
			parent: opts.parent,
			...(rows.length ? { shape: "table" as const, rows, style: ML_STYLES.stepTable } : { style: ML_STYLES.step }),
			data: { framework: this.framework, file: this.file, step: label, ...(opts.data ?? {}) },
			files: this.filesFor(opts.files),
		});
	}

	artifact(local: string, label: string, type: ArtifactType, opts: { data?: Record<string, string>; parent?: string; files?: string[] } = {}): void {
		this.add({
			id: local,
			label,
			kind: `ml:${type}`,
			parent: opts.parent,
			style: styleFor(type),
			width: Math.max(110, Math.min(220, label.length * 7 + 30)),
			height: type === "data" ? 60 : 50,
			data: { framework: this.framework, file: this.file, ...(opts.data ?? {}) },
			files: this.filesFor(opts.files),
		});
	}

	group(local: string, label: string, parent?: string, data: Record<string, string> = {}): void {
		this.add({ id: local, label, kind: "ml:group", container: true, parent, style: ML_STYLES.group, data: { framework: this.framework, file: this.file, ...data } });
	}

	note(local: string, text: string, parent?: string): void {
		this.add({ id: local, label: text, kind: "ml:params", shape: "note", parent, style: ML_STYLES.params, width: 220, data: { file: this.file }, files: this.filesFor() });
	}

	condition(local: string, label: string, parent?: string, data: Record<string, string> = {}): void {
		this.add({ id: local, label, kind: "ml:condition", parent, style: ML_STYLES.condition, width: 220, height: 80, data: { framework: this.framework, file: this.file, ...data }, files: this.filesFor() });
	}

	edge(from: string, to: string, label?: string, kind = "dataflow"): void {
		if (from === to) return;
		const key = `${from}\u0000${to}\u0000${label ?? ""}`;
		if (this.edgeKeys.has(key)) return;
		this.edgeKeys.add(key);
		this.edges.push({ from, to, label, kind, style: kind === "dependsOn" || kind === "params" ? ML_STYLES.depEdge : kind === "condition" ? ML_STYLES.softEdge : ML_STYLES.flowEdge });
	}

	/** Whether any edge already joins the two (either direction of data passing through an artifact counts). */
	linked(from: string, to: string): boolean {
		const outs = new Set(this.edges.filter((e) => e.from === from).map((e) => e.to));
		return outs.has(to) || this.edges.some((e) => outs.has(e.from) && e.to === to);
	}

	finish(): ParsedPipeline {
		// Edges to nodes that never got created are dropped.
		const edges = this.edges.filter((e) => this.ids.has(e.from) && this.ids.has(e.to));
		return { name: this.name, framework: this.framework, file: this.file, nodes: this.nodes, edges, warnings: this.warnings };
	}
}

const asArray = (v: any): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------- DVC

/** `deps`/`outs` entries: "path" or { path: { cache: false } }. */
function dvcPaths(v: any): string[] {
	return asArray(v).flatMap((x) => (typeof x === "string" ? [x] : x && typeof x === "object" ? Object.keys(x) : []));
}

/** `params` entries: "a.b", or { "file.yaml": ["a", "b"] }. */
function dvcParams(v: any): string[] {
	return asArray(v).flatMap((x) =>
		typeof x === "string" ? [x] : x && typeof x === "object" ? Object.entries(x).flatMap(([file, keys]) => (asArray(keys).length ? asArray(keys).map((k) => `${file}:${k}`) : [file])) : []
	);
}

const CODE_FILE = /\.(py|r|sh|ipynb|jl|scala|java|js|ts|sql|rb|go)$/i;

export function parseDvc(doc: any, file: string): ParsedPipeline | undefined {
	const stages = doc?.stages;
	if (!stages || typeof stages !== "object") return undefined;
	const dir = path.posix.dirname(file);
	const b = new PipelineBuilder(dir === "." ? "dvc.yaml" : dir, "DVC", file);
	const outs = new Map<string, string>();
	const entries = Object.entries<any>(stages).map(([name, st]) => [name, st?.do ?? st] as [string, any]);
	/** A stage path (relative to dvc.yaml and its wdir) relative to the scanned folder. */
	const rel = (st: any, p: string) => path.posix.normalize(path.posix.join(dir, typeof st?.wdir === "string" ? st.wdir : "", p)).replace(/\/$/, "");
	for (const [name, st] of entries) {
		const kinds: [any, ArtifactType | undefined][] = [
			[st?.outs, undefined],
			[st?.metrics, "metrics"],
			[st?.plots, "metrics"],
		];
		for (const [list, forced] of kinds) {
			for (const p of dvcPaths(list)) {
				const id = `a:${p}`;
				outs.set(p.replace(/\/$/, ""), id);
				b.artifact(id, p, forced ?? artifactType(p), { data: { path: p, producedBy: name }, files: [rel(st, p)] });
			}
		}
	}
	const outFor = (p: string): string | undefined => {
		const clean = p.replace(/\/$/, "");
		if (outs.has(clean)) return outs.get(clean);
		for (const [o, id] of outs) if (clean.startsWith(o + "/")) return id;
		return undefined;
	};
	for (const [name, rawSt] of Object.entries<any>(stages)) {
		const st = rawSt?.do ?? rawSt;
		const id = `s:${name}`;
		const deps = dvcPaths(st?.deps);
		const code = deps.filter((d) => CODE_FILE.test(d) && !outFor(d));
		const params = dvcParams(st?.params);
		const cmd = asArray(st?.cmd).map(String);
		const rows: MapRow[] = [
			...cmd.slice(0, 2).map((c) => ({ text: `$ ${firstLine(c, 60)}` })),
			...code.slice(0, 4).map((c) => ({ text: c, detail: "code" })),
			...params.slice(0, 8).map((p) => ({ text: p, detail: "param" })),
		];
		if (params.length > 8) rows.push({ text: `… ${params.length - 8} more params` });
		const foreach = rawSt?.foreach !== undefined ? "foreach" : rawSt?.matrix !== undefined ? "matrix" : "";
		b.step(id, foreach ? `${name}  (${foreach})` : name, {
			files: code.map((c) => rel(st, c)),
			rows,
			data: { stage: name, ...(cmd.length ? { cmd: cmd.join(" && ").slice(0, 500) } : {}), ...(code.length ? { code: code.join(", ") } : {}), ...(params.length ? { params: params.join(", ").slice(0, 500) } : {}), ...(st?.wdir ? { wdir: String(st.wdir) } : {}) },
		});
		for (const d of deps) {
			const out = outFor(d);
			if (out) {
				b.edge(out, id);
			} else if (!CODE_FILE.test(d)) {
				const ext = `a:${d}`;
				b.artifact(ext, d, artifactType(d), { data: { path: d, role: "input" }, files: [rel(st, d)] });
				b.edge(ext, id);
			}
		}
		for (const p of [...dvcPaths(st?.outs), ...dvcPaths(st?.metrics), ...dvcPaths(st?.plots)]) b.edge(id, `a:${p}`);
	}
	return b.finish();
}

// ---------------------------------------------------------------- Kubeflow / Vertex (KFP IR)

/** The pipeline spec inside a KFP IR file, a Vertex PipelineJob, or undefined. */
export function kfpSpec(doc: any): any {
	const spec = doc?.pipelineSpec ?? doc?.pipeline_spec ?? doc;
	return spec?.root?.dag?.tasks && typeof spec.root.dag.tasks === "object" ? spec : undefined;
}

const kfpType = (def: any): string => String(def?.artifactType?.schemaTitle ?? def?.artifactType?.instanceSchema ?? "system.Artifact");

export function parseKfp(rawDoc: any, file: string): ParsedPipeline | undefined {
	const spec = kfpSpec(rawDoc);
	if (!spec) return undefined;
	const name = String(spec.pipelineInfo?.name ?? path.posix.basename(file).replace(/\.(ya?ml|json)$/i, ""));
	const b = new PipelineBuilder(name, spec.sdkVersion ? `Kubeflow (${spec.sdkVersion})` : "Kubeflow / Vertex", file);
	const components = spec.components ?? {};
	const executors = spec.deploymentSpec?.executors ?? {};
	const pending: { from: string; fallback: string; to: string; label?: string; kind?: string }[] = [];

	// Pipeline inputs.
	const rootIn = spec.root?.inputDefinitions ?? {};
	const inputParams = Object.entries<any>(rootIn.parameters ?? {}).map(([k, v]) => `${k}: ${String(v?.parameterType ?? v?.type ?? "").toLowerCase()}${v?.defaultValue !== undefined ? ` = ${JSON.stringify(v.defaultValue)}` : ""}`);
	if (inputParams.length) b.note("params", `Pipeline parameters\n${inputParams.slice(0, 12).join("\n")}${inputParams.length > 12 ? `\n… ${inputParams.length - 12} more` : ""}`);
	for (const [k, v] of Object.entries<any>(rootIn.artifacts ?? {})) b.artifact(`in:${k}`, k, artifactType(k, kfpType(v)), { data: { input: k, type: kfpType(v) } });

	const walk = (dag: any, scope: string, parent: string | undefined, depth: number) => {
		for (const [taskName, task] of Object.entries<any>(dag?.tasks ?? {})) {
			const local = `t:${scope}${taskName}`;
			const compName = task?.componentRef?.name;
			const comp = components[compName] ?? {};
			const label = String(task?.taskInfo?.name ?? taskName);
			if (comp.dag && depth < 6) {
				const loop = task?.parameterIterator || task?.artifactIterator ? "  (for each)" : "";
				const condition = String(task?.triggerPolicy?.condition ?? "").replace(/inputs\.parameter_values\[['"](?:pipelinechannel--)?([^'"]+)['"]\]/g, "$1");
				const cond = condition ? `  (if ${firstLine(condition, 40)})` : "";
				b.group(local, `${label}${loop}${cond}`, parent, { task: taskName, component: String(compName ?? "") });
				walk(comp.dag, `${scope}${taskName}/`, local, depth + 1);
			} else {
				const exec = executors[comp.executorLabel]?.container ?? {};
				const command = [...asArray(exec.command), ...asArray(exec.args)].map(String).join(" ");
				const consts = Object.entries<any>(task?.inputs?.parameters ?? {})
					.filter(([, v]) => v?.runtimeValue?.constant !== undefined || v?.runtimeValue?.constantValue !== undefined)
					.map(([k, v]) => ({ text: `${k} = ${firstLine(JSON.stringify(v.runtimeValue.constant ?? Object.values(v.runtimeValue.constantValue ?? {})[0]), 40)}`, detail: "param" }));
				const resources = exec.resources ? Object.entries<any>(exec.resources).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ") : "";
				b.step(local, label, {
					parent,
					rows: [...(exec.image ? [{ text: firstLine(exec.image, 60), detail: "image" }] : []), ...consts.slice(0, 6), ...(task?.cachingOptions?.enableCache === false ? [{ text: "cache off" }] : [])],
					data: { task: taskName, component: String(compName ?? ""), ...(exec.image ? { image: String(exec.image) } : {}), ...(command ? { command: command.slice(0, 600) } : {}), ...(resources ? { resources } : {}) },
				});
			}
			// What the task produces.
			for (const [outName, def] of Object.entries<any>(comp.outputDefinitions?.artifacts ?? {})) {
				const art = `${local}:${outName}`;
				b.artifact(art, outName, artifactType(outName, kfpType(def)), { parent, data: { producer: taskName, output: outName, type: kfpType(def) } });
				b.edge(local, art);
			}
			const outParams = Object.keys(comp.outputDefinitions?.parameters ?? {});
			// What it consumes.
			for (const [inName, inp] of Object.entries<any>(task?.inputs?.artifacts ?? {})) {
				const src = inp?.taskOutputArtifact;
				const input = inName.replace(/^pipelinechannel--/, "");
				if (src?.producerTask) pending.push({ from: `t:${scope}${src.producerTask}:${src.outputArtifactKey}`, fallback: `t:${scope}${src.producerTask}`, to: local, label: [src.outputArtifactKey, `${src.producerTask}-${src.outputArtifactKey}`].includes(input) ? undefined : input });
				else if (inp?.componentInputArtifact && depth === 0) pending.push({ from: `in:${inp.componentInputArtifact}`, fallback: "", to: local });
			}
			for (const [inName, inp] of Object.entries<any>(task?.inputs?.parameters ?? {})) {
				const src = inp?.taskOutputParameter;
				if (src?.producerTask) pending.push({ from: `t:${scope}${src.producerTask}`, fallback: "", to: local, label: src.outputParameterKey ?? inName, kind: "params" });
			}
			for (const dep of asArray(task?.dependentTasks)) pending.push({ from: `t:${scope}${dep}`, fallback: "", to: local, kind: "dependsOn" });
			if (outParams.length && comp.executorLabel) {
				const node = b.nodes.find((n) => n.id === local);
				if (node?.rows) node.rows.push(...outParams.slice(0, 4).map((p) => ({ text: p, detail: "output" })));
				else if (node) {
					node.shape = "table";
					node.style = ML_STYLES.stepTable;
					node.rows = outParams.slice(0, 4).map((p) => ({ text: p, detail: "output" }));
				}
			}
		}
	};
	walk(spec.root.dag, "", undefined, 0);
	// Data first, so that a plain dependency already carried by data is not drawn twice.
	pending.sort((x, y) => Number(x.kind === "dependsOn") - Number(y.kind === "dependsOn"));
	for (const p of pending) {
		const from = b.has(p.from) ? p.from : p.fallback;
		if (!from) continue;
		if (p.kind === "dependsOn" && b.linked(from, p.to)) continue;
		b.edge(from, p.to, p.label, p.kind ?? "dataflow");
	}
	return b.finish();
}

// ---------------------------------------------------------------- Argo Workflows (Kubeflow v1)

export function parseArgo(doc: any, file: string): ParsedPipeline | undefined {
	if (!/^(Cluster)?Workflow(Template)?$/.test(String(doc?.kind ?? "")) || !Array.isArray(doc?.spec?.templates)) return undefined;
	const templates = new Map<string, any>(doc.spec.templates.map((t: any) => [t?.name, t]));
	const entry = templates.get(doc.spec.entrypoint) ?? doc.spec.templates.find((t: any) => t?.dag || t?.steps);
	if (!entry) return undefined;
	const kubeflow = JSON.stringify(doc.metadata?.annotations ?? {}).includes("pipelines.kubeflow.org");
	const b = new PipelineBuilder(String(doc.metadata?.name ?? doc.metadata?.generateName ?? "workflow").replace(/-$/, ""), kubeflow ? "Kubeflow v1 (Argo)" : "Argo Workflows", file);
	const addTask = (name: string, templateName: string) => {
		const t = templates.get(templateName) ?? {};
		const c = t.container ?? t.script ?? {};
		b.step(`t:${name}`, name, {
			rows: [...(c.image ? [{ text: firstLine(c.image, 60), detail: "image" }] : []), ...(t.resource ? [{ text: `k8s ${t.resource.action ?? ""}`, detail: "resource" }] : [])],
			data: { task: name, template: String(templateName ?? ""), ...(c.image ? { image: String(c.image) } : {}), ...(c.command || c.args ? { command: [...asArray(c.command), ...asArray(c.args)].join(" ").slice(0, 500) } : {}) },
		});
		for (const a of asArray(t.outputs?.artifacts)) {
			if (!a?.name) continue;
			b.artifact(`t:${name}:${a.name}`, a.name, artifactType(a.name), { data: { producer: name } });
			b.edge(`t:${name}`, `t:${name}:${a.name}`);
		}
	};
	if (entry.dag) {
		for (const task of asArray(entry.dag.tasks)) addTask(task.name, task.template);
		for (const task of asArray(entry.dag.tasks)) {
			const deps = new Set<string>([...asArray(task.dependencies), ...String(task.depends ?? "").split(/[^\w-]+/).filter((d) => d && d !== "Succeeded" && d !== "Failed")]);
			const args = JSON.stringify(task.arguments ?? {});
			for (const m of args.matchAll(/tasks\.([\w-]+)\.outputs\.artifacts\.([\w-]+)/g)) {
				b.edge(`t:${m[1]}:${m[2]}`, `t:${task.name}`);
				deps.delete(m[1]);
			}
			for (const m of args.matchAll(/tasks\.([\w-]+)\.outputs\.(?:parameters\.([\w-]+)|result)/g)) {
				b.edge(`t:${m[1]}`, `t:${task.name}`, m[2] ?? "result", "params");
				deps.delete(m[1]);
			}
			for (const d of deps) if (templates.size && entry.dag.tasks.some((t: any) => t.name === d)) b.edge(`t:${d}`, `t:${task.name}`, undefined, "dependsOn");
		}
	} else if (entry.steps) {
		let prev: string[] = [];
		for (const group of asArray(entry.steps)) {
			const names = asArray(group).map((s: any) => s.name);
			for (const s of asArray(group)) addTask(s.name, s.template);
			for (const p of prev) for (const n of names) b.edge(`t:${p}`, `t:${n}`, undefined, "dependsOn");
			prev = names;
		}
	}
	return b.finish();
}

// ---------------------------------------------------------------- Azure ML pipeline jobs

export function isAzureMlPipeline(doc: any): boolean {
	return !!doc && typeof doc === "object" && doc.jobs && typeof doc.jobs === "object" && (/pipelineJob|pipelineComponent/i.test(String(doc.$schema ?? "")) || doc.type === "pipeline");
}

export function parseAzureMl(doc: any, file: string, root?: string): ParsedPipeline | undefined {
	if (!isAzureMlPipeline(doc)) return undefined;
	const b = new PipelineBuilder(String(doc.display_name ?? doc.name ?? doc.experiment_name ?? path.posix.basename(file)), "Azure ML", file);
	const valueText = (v: any) => (typeof v === "string" ? v : v && typeof v === "object" ? String(v.path ?? v.value ?? JSON.stringify(v)) : String(v ?? ""));
	for (const [k, v] of Object.entries<any>(doc.inputs ?? {})) {
		const type = typeof v === "object" && v ? String(v.type ?? "") : "";
		const text = valueText(v);
		if (type || /:\/\/|azureml:|\//.test(text)) b.artifact(`in:${k}`, k, artifactType(k, `${type} ${text}`), { data: { input: k, ...(type ? { type } : {}), path: text } });
	}
	const literalInputs = Object.entries<any>(doc.inputs ?? {})
		.filter(([k]) => !b.has(`in:${k}`))
		.map(([k, v]) => `${k} = ${firstLine(valueText(v), 40)}`);
	const settings = doc.settings ?? {};
	const notes = [...literalInputs, ...(settings.default_compute ? [`compute: ${settings.default_compute}`] : []), ...(settings.default_datastore ? [`datastore: ${settings.default_datastore}`] : [])];
	if (notes.length) b.note("params", `Pipeline inputs & settings\n${notes.slice(0, 12).join("\n")}`);
	const dir = root ? path.join(root, path.posix.dirname(file)) : undefined;
	const pipelineOutputs = new Map<string, string>();
	for (const [jobName, rawJob] of Object.entries<any>(doc.jobs)) {
		let job = rawJob ?? {};
		let component: any = typeof job.component === "object" ? job.component : undefined;
		// A local component file adds the command, environment and declared outputs.
		if (typeof job.component === "string" && /^\.{0,2}\/|\.ya?ml$/.test(job.component) && !job.component.startsWith("azureml:") && dir) {
			try {
				component = loadYaml(fs.readFileSync(path.resolve(dir, job.component), "utf8"));
			} catch {
				// not readable: just the reference
			}
		}
		const merged = { ...(component ?? {}), ...job };
		const type = String(merged.type ?? "command");
		const id = `j:${jobName}`;
		const rows: MapRow[] = [
			{ text: type, detail: "type" },
			...(typeof job.component === "string" ? [{ text: firstLine(job.component, 50), detail: "component" }] : []),
			...(merged.command ? [{ text: `$ ${firstLine(merged.command, 55)}` }] : []),
			...(merged.environment ? [{ text: firstLine(typeof merged.environment === "string" ? merged.environment : merged.environment.image ?? merged.environment.name ?? "inline", 50), detail: "env" }] : []),
			...(merged.compute ? [{ text: String(merged.compute), detail: "compute" }] : []),
			...(type === "sweep" && merged.objective ? [{ text: `${merged.objective.goal ?? ""} ${merged.objective.primary_metric ?? ""}`.trim(), detail: "objective" }] : []),
		];
		b.step(id, String(job.display_name ?? jobName), {
			files: typeof job.component === "string" && component && /\.ya?ml$/i.test(job.component) && !job.component.startsWith("azureml:") ? [path.posix.normalize(path.posix.join(path.posix.dirname(file), job.component))] : [],
			rows,
			data: { job: jobName, type, ...(typeof job.component === "string" ? { component: job.component } : {}), ...(merged.code ? { code: String(merged.code) } : {}), ...(merged.command ? { command: String(merged.command).slice(0, 600) } : {}) },
		});
		const declaredOutputs = new Set([...Object.keys(component?.outputs ?? {}), ...Object.keys(job.outputs ?? {})]);
		for (const out of declaredOutputs) {
			const v = job.outputs?.[out] ?? component?.outputs?.[out];
			const text = valueText(v);
			const bound = /\$\{\{\s*parent\.outputs\.([\w-]+)\s*\}\}/.exec(text)?.[1];
			const type = typeof v === "object" && v ? String(v.type ?? "") : "";
			const art = `o:${jobName}.${out}`;
			b.artifact(art, bound ? `${out}\n→ ${bound}` : out, artifactType(out, type), { data: { producer: jobName, output: out, ...(type ? { type } : {}), ...(bound ? { pipelineOutput: bound } : {}) } });
			b.edge(id, art);
			if (bound) pipelineOutputs.set(bound, art);
		}
		for (const [inName, v] of Object.entries<any>(job.inputs ?? {})) {
			const text = valueText(v);
			for (const m of text.matchAll(/\$\{\{\s*parent\.jobs\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/g)) {
				const art = `o:${m[1]}.${m[2]}`;
				if (!b.has(art)) b.artifact(art, m[2], artifactType(m[2]), { data: { producer: m[1], output: m[2] } });
				b.edge(`j:${m[1]}`, art);
				b.edge(art, id, m[2] === inName ? undefined : inName);
			}
			for (const m of text.matchAll(/\$\{\{\s*parent\.inputs\.([\w-]+)\s*\}\}/g)) if (b.has(`in:${m[1]}`)) b.edge(`in:${m[1]}`, id, m[1] === inName ? undefined : inName);
		}
	}
	return b.finish();
}

// ---------------------------------------------------------------- SageMaker pipelines

export function isSageMakerDefinition(doc: any): boolean {
	return !!doc && Array.isArray(doc.Steps) && doc.Steps.every((s: any) => s && typeof s.Name === "string" && typeof s.Type === "string");
}

function sagemakerImage(a: any): string | undefined {
	return (
		a?.AppSpecification?.ImageUri ??
		a?.AlgorithmSpecification?.TrainingImage ??
		a?.TrainingJobDefinition?.AlgorithmSpecification?.TrainingImage ??
		a?.PrimaryContainer?.Image ??
		a?.ModelPackageRequest?.InferenceSpecification?.Containers?.[0]?.Image ??
		a?.InferenceSpecification?.Containers?.[0]?.Image ??
		a?.TransformJobName
	);
}

const getRef = (v: any): string | undefined => (v && typeof v === "object" && typeof v.Get === "string" ? v.Get : undefined);

export function parseSageMaker(doc: any, file: string): ParsedPipeline | undefined {
	if (!isSageMakerDefinition(doc)) return undefined;
	const b = new PipelineBuilder(String(doc.PipelineName ?? path.posix.basename(file).replace(/\.json$/i, "")), "SageMaker Pipelines", file);
	const params: any[] = asArray(doc.Parameters);
	const dataParams = new Set(params.filter((p) => /^s3:\/\//.test(String(p?.DefaultValue ?? "")) || /data|input|uri|path/i.test(String(p?.Name ?? ""))).map((p) => String(p.Name)));
	for (const p of params) if (dataParams.has(String(p.Name))) b.artifact(`p:${p.Name}`, String(p.Name), artifactType(String(p.Name), String(p.DefaultValue ?? "")), { data: { parameter: String(p.Name), ...(p.DefaultValue !== undefined ? { default: String(p.DefaultValue) } : {}) } });
	const other = params.filter((p) => !dataParams.has(String(p.Name))).map((p) => `${p.Name}${p.DefaultValue !== undefined ? ` = ${firstLine(JSON.stringify(p.DefaultValue), 40)}` : ""}`);
	if (other.length) b.note("params", `Parameters\n${other.slice(0, 12).join("\n")}`);

	// A parameter reference shows its default value.
	const defaults = new Map(params.map((p) => [`Parameters.${p.Name}`, p.DefaultValue]));
	const paramValue = (v: any) => {
		const ref = getRef(v);
		if (!ref) return String(v);
		const d = defaults.get(ref);
		return d !== undefined ? `${d} (${ref.replace(/^Parameters\./, "param ")})` : ref;
	};
	const all: any[] = [];
	const flatten = (steps: any[]) => {
		for (const s of asArray(steps)) {
			all.push(s);
			flatten(s?.Arguments?.IfSteps);
			flatten(s?.Arguments?.ElseSteps);
		}
	};
	flatten(doc.Steps);
	const names = new Set(all.map((s) => String(s.Name)));

	for (const s of all) {
		const id = `s:${s.Name}`;
		const a = s.Arguments ?? {};
		if (s.Type === "Condition") {
			const conds = asArray(a.Conditions).map((c: any) => {
				const side = (v: any) => (getRef(v) ? String(getRef(v)).split(".").pop() : v?.["Std:JsonGet"] ? String(v["Std:JsonGet"].Path ?? "json") : JSON.stringify(v));
				return `${side(c?.LeftValue)} ${String(c?.Type ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${side(c?.RightValue)}`;
			});
			b.condition(id, `${s.Name}\n${firstLine(conds.join(" and "), 50)}`, undefined, { step: String(s.Name), type: "Condition", conditions: conds.join(" and ") });
			for (const t of asArray(a.IfSteps)) b.edge(id, `s:${t.Name}`, "true", "condition");
			for (const t of asArray(a.ElseSteps)) b.edge(id, `s:${t.Name}`, "false", "condition");
		} else {
			const image = sagemakerImage(a);
			const instance = a?.ProcessingResources?.ClusterConfig?.InstanceType ?? a?.ResourceConfig?.InstanceType ?? a?.TransformResources?.InstanceType;
			const code = asArray(a?.ProcessingInputs).find((i: any) => i?.InputName === "code")?.S3Input?.S3Uri;
			const rows: MapRow[] = [
				{ text: String(s.Type), detail: "type" },
				...(image && typeof image === "string" ? [{ text: firstLine(image.split("/").pop(), 50), detail: "image" }] : []),
				...(instance ? [{ text: paramValue(instance), detail: "instance" }] : []),
				...(typeof code === "string" ? [{ text: firstLine(code.split("/").pop(), 50), detail: "code" }] : []),
				...(a?.ModelPackageGroupName ? [{ text: String(getRef(a.ModelPackageGroupName) ?? a.ModelPackageGroupName), detail: "model group" }] : []),
				...(a?.ModelApprovalStatus ? [{ text: paramValue(a.ModelApprovalStatus), detail: "approval" }] : []),
			];
			b.step(id, String(s.Name), {
				kind: s.Type === "RegisterModel" ? "ml:register" : "ml:step",
				rows,
				data: { step: String(s.Name), type: String(s.Type), ...(typeof image === "string" ? { image } : {}), ...(typeof code === "string" ? { code } : {}) },
			});
			// Declared outputs, drawn even when nothing in the pipeline reads them.
			for (const o of asArray(a?.ProcessingOutputConfig?.Outputs)) {
				if (!o?.OutputName) continue;
				const art = `s:${s.Name}:out:${o.OutputName}`;
				b.artifact(art, String(o.OutputName), artifactType(String(o.OutputName)), { data: { producer: String(s.Name), output: String(o.OutputName), ...(typeof o.S3Output?.S3Uri === "string" ? { s3: o.S3Output.S3Uri } : {}) } });
				b.edge(id, art);
			}
			if (s.Type === "Training" || s.Type === "Tuning") {
				b.artifact(`s:${s.Name}:model`, `${s.Name} model`, "model", { data: { producer: String(s.Name), output: "ModelArtifacts" } });
				b.edge(id, `s:${s.Name}:model`);
			}
			for (const pf of asArray(s.PropertyFiles)) {
				if (!pf?.PropertyFileName) continue;
				b.artifact(`s:${s.Name}:pf:${pf.PropertyFileName}`, String(pf.PropertyFileName), "metrics", { data: { producer: String(s.Name), propertyFile: String(pf.PropertyFileName), ...(pf.FilePath ? { path: String(pf.FilePath) } : {}) } });
				b.edge(id, `s:${s.Name}:pf:${pf.PropertyFileName}`);
			}
		}
		// References to other steps' properties and to parameters.
		const refs: string[] = [];
		const scan = (v: any, depth: number) => {
			if (depth > 30 || v === null || typeof v !== "object") return;
			if (getRef(v)) refs.push(getRef(v)!);
			for (const [k, x] of Object.entries(v)) if (k !== "IfSteps" && k !== "ElseSteps") scan(x, depth + 1);
		};
		scan(a, 0);
		for (const r of refs) {
			const pm = /^Parameters\.(.+)$/.exec(r);
			if (pm) {
				if (b.has(`p:${pm[1]}`)) b.edge(`p:${pm[1]}`, id);
				continue;
			}
			const m = /^Steps\.([^.]+)\.(.*)$/.exec(r);
			if (!m || !names.has(m[1]) || m[1] === s.Name) continue;
			const [, producer, rest] = m;
			const out = /Outputs\[['"]?([^'"\]]+)['"]?\]/.exec(rest)?.[1];
			const pf = /^PropertyFiles\.([^.]+)/.exec(rest)?.[1];
			if (rest.startsWith("ModelArtifacts") || /S3ModelArtifacts/.test(rest)) b.edge(`s:${producer}:model`, id);
			else if (out && b.has(`s:${producer}:out:${out}`)) b.edge(`s:${producer}:out:${out}`, id);
			else if (pf) b.edge(`s:${producer}:pf:${pf}`, id);
			else b.edge(`s:${producer}`, id, firstLine(rest.split(".").slice(-1)[0], 30), "params");
		}
		for (const d of asArray(s.DependsOn)) if (names.has(String(d)) && !b.linked(`s:${d}`, id)) b.edge(`s:${d}`, id, undefined, "dependsOn");
	}
	return b.finish();
}

// ---------------------------------------------------------------- Airflow (static scan)

const NOT_CALLS = new Set(["if", "for", "while", "with", "def", "class", "return", "print", "len", "str", "int", "float", "dict", "list", "set", "tuple", "range", "isinstance", "getattr", "and", "or", "not", "in", "lambda", "elif", "assert", "yield"]);

interface PyCall {
	name: string;
	start: number;
	open: number;
	end: number;
	args: string;
}

/** Calls `Name(...)` in the source with their argument text. */
function pyCalls(src: string): PyCall[] {
	const out: PyCall[] = [];
	const re = /(?<![\w.])([A-Za-z_][\w.]*)\s*\(/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const name = m[1];
		if (NOT_CALLS.has(name)) continue;
		const before = src.slice(Math.max(0, m.index - 4), m.index);
		if (/def\s$/.test(before) || /class\s$/.test(src.slice(Math.max(0, m.index - 6), m.index))) continue;
		const open = m.index + m[0].length - 1;
		const end = matchBracket(src, open);
		out.push({ name, start: m.index, open, end, args: src.slice(open + 1, end) });
	}
	return out;
}

interface AirflowDag {
	id: string;
	start: number;
	schedule?: string;
}

export function looksLikeAirflow(text: string): boolean {
	return /\b(from|import)\s+airflow\b/.test(text) && /\bDAG\s*\(|@dag\b|@(?:\w+\.)?dag\s*\(/.test(text);
}

export function parseAirflow(text: string, file: string): ParsedPipeline[] {
	if (!looksLikeAirflow(text)) return [];
	const src = stripPyComments(text);
	const calls = pyCalls(src);
	const dags: AirflowDag[] = [];
	for (const c of calls) {
		if (c.name === "DAG" || c.name.endsWith(".DAG")) {
			const kw = kwargs(c.args);
			const first = splitTopLevel(c.args)[0];
			const id = pyString(kw.dag_id) ?? pyString(first) ?? `dag@${c.start}`;
			dags.push({ id, start: c.start, schedule: kw.schedule ?? kw.schedule_interval });
		}
	}
	for (const m of src.matchAll(/@(?:\w+\.)?dag\b(?:\s*\(([\s\S]*?)\))?\s*\n\s*def\s+(\w+)/g)) {
		const kw = kwargs(m[1] ?? "");
		dags.push({ id: pyString(kw.dag_id) ?? m[2], start: m.index!, schedule: kw.schedule ?? kw.schedule_interval });
	}
	if (dags.length === 0) return [];
	dags.sort((a, b) => a.start - b.start);
	const dagAt = (pos: number) => [...dags].reverse().find((d) => d.start <= pos) ?? dags[0];

	interface Task {
		id: string;
		dag: AirflowDag;
		operator: string;
		rows: MapRow[];
		data: Record<string, string>;
		start: number;
		end: number;
	}
	const tasks: Task[] = [];
	const vars = new Map<string, Task[]>();
	const varBefore = (pos: number): string | undefined => {
		const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
		return /^\s*([A-Za-z_]\w*)\s*=\s*$/.exec(src.slice(lineStart, pos))?.[1];
	};
	// Classic operators: any call with a top-level task_id.
	for (const c of calls) {
		const kw = kwargs(c.args);
		const taskId = pyString(kw.task_id);
		// Decorators such as @task(task_id="x") are TaskFlow tasks, handled below.
		if (!taskId || src[c.start - 1] === "@") continue;
		const operator = c.name.split(".").pop()!;
		if (operator === "TaskGroup") continue;
		const rows: MapRow[] = [{ text: operator, detail: "operator" }];
		const data: Record<string, string> = { task_id: taskId, operator };
		for (const key of ["python_callable", "bash_command", "image", "application", "sql", "entry_point", "notebook_path", "job_name", "training_config", "model_name", "endpoint_name", "pipeline_name", "trigger_dag_id"]) {
			if (kw[key] === undefined) continue;
			const v = pyString(kw[key]) ?? kw[key];
			data[key] = v.slice(0, 400);
			rows.push({ text: firstLine(v, 50), detail: key.replace(/_/g, " ") });
		}
		const t: Task = { id: taskId, dag: dagAt(c.start), operator, rows, data, start: c.start, end: c.end };
		tasks.push(t);
		const v = varBefore(c.start);
		if (v) vars.set(v, [t]);
	}
	// TaskFlow functions and where they are called.
	const flowFns = new Map<string, { taskId: string; flavor: string }>();
	for (const m of src.matchAll(/@(?:\w+\.)?task\b(?:\.(\w+))?(?:\s*\(([\s\S]*?)\))?\s*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)/g)) {
		const kw = kwargs(m[2] ?? "");
		flowFns.set(m[3], { taskId: pyString(kw.task_id) ?? m[3], flavor: m[1] ?? "python" });
	}
	const used = new Map<string, number>();
	const flowCalls: { task: Task; call: PyCall }[] = [];
	for (const c of calls) {
		const fn = flowFns.get(c.name.replace(/\.(override|expand|partial)$/, ""));
		if (!fn) continue;
		const n = used.get(fn.taskId) ?? 0;
		used.set(fn.taskId, n + 1);
		const t: Task = { id: n ? `${fn.taskId}__${n}` : fn.taskId, dag: dagAt(c.start), operator: `@task.${fn.flavor}`, rows: [{ text: `@task.${fn.flavor}`, detail: "TaskFlow" }], data: { task_id: fn.taskId, function: c.name }, start: c.start, end: c.end };
		tasks.push(t);
		flowCalls.push({ task: t, call: c });
		const v = varBefore(c.start);
		if (v) vars.set(v, [t]);
	}
	const taskAt = (start: number, end: number) => tasks.filter((t) => t.start >= start && t.start < end && !tasks.some((o) => o !== t && o.start < t.start && o.end >= t.end && o.start >= start));
	const deps: [Task, Task, string?][] = [];
	// TaskFlow data passing: f(g()) and f(x) where x holds g()'s result.
	for (const { task, call } of flowCalls) {
		for (const inner of flowCalls) if (inner.call.start > call.open && inner.call.end <= call.end) deps.push([inner.task, task, "XCom"]);
		for (const id of call.args.match(/\b[A-Za-z_]\w*\b/g) ?? []) for (const t of vars.get(id) ?? []) if (t !== task) deps.push([t, task, "XCom"]);
	}
	let unresolved = 0;
	const resolve = (expr: string, offset: number): Task[] => {
		const e = expr.trim();
		if (!e) return [];
		if (e.startsWith("[") || e.startsWith("(")) {
			const inner = e.slice(1, matchBracket(e, 0));
			return splitTopLevel(inner).flatMap((part) => resolve(part, offset + expr.indexOf(e) + 1 + inner.indexOf(part)));
		}
		if (/^[A-Za-z_]\w*$/.test(e)) {
			const r = vars.get(e);
			if (!r) unresolved++;
			return r ?? [];
		}
		const start = offset + expr.indexOf(e);
		const found = taskAt(start, start + e.length);
		if (!found.length) unresolved++;
		return found;
	};
	for (const line of logicalLines(src)) {
		if (/>>|<</.test(line.text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ""))) {
			// Split on >> and << outside brackets and strings.
			const parts: { expr: string; offset: number; op?: string }[] = [];
			let depth = 0;
			let last = 0;
			const t = line.text;
			for (let i = 0; i < t.length; i++) {
				const ch = t[i];
				if (ch === '"' || ch === "'") {
					const q = ch;
					let j = i + 1;
					while (j < t.length && t[j] !== q) j += t[j] === "\\" ? 2 : 1;
					i = j;
					continue;
				}
				if ("([{".includes(ch)) depth++;
				else if (")]}".includes(ch)) depth--;
				else if (depth === 0 && (t.startsWith(">>", i) || t.startsWith("<<", i))) {
					parts.push({ expr: t.slice(last, i), offset: line.start + last, op: t.slice(i, i + 2) });
					last = i + 2;
					i++;
				}
			}
			parts.push({ expr: t.slice(last), offset: line.start + last });
			for (let i = 0; i + 1 < parts.length; i++) {
				const left = resolve(parts[i].expr.replace(/^\s*[A-Za-z_]\w*\s*=(?!=)/, ""), parts[i].offset);
				const right = resolve(parts[i + 1].expr, parts[i + 1].offset);
				for (const a of left) for (const c of right) deps.push(parts[i].op === ">>" ? [a, c] : [c, a]);
			}
		}
		for (const m of line.text.matchAll(/([A-Za-z_]\w*)\.set_(downstream|upstream)\(([\s\S]*)\)/g)) {
			const a = vars.get(m[1]) ?? [];
			const others = resolve(m[3], line.start + m.index! + m[0].indexOf(m[3]));
			for (const x of a) for (const y of others) deps.push(m[2] === "downstream" ? [x, y] : [y, x]);
		}
		const chainM = /\b(chain|cross_downstream)\s*\(/.exec(line.text);
		if (chainM) {
			const open = line.text.indexOf("(", chainM.index);
			const inner = line.text.slice(open + 1, matchBracket(line.text, open));
			const groups = splitTopLevel(inner).map((p) => resolve(p, line.start + open + 1 + inner.indexOf(p)));
			if (chainM[1] === "chain") {
				for (let i = 0; i + 1 < groups.length; i++) {
					const [a, c] = [groups[i], groups[i + 1]];
					if (a.length === c.length && a.length > 1) a.forEach((x, k) => deps.push([x, c[k]]));
					else for (const x of a) for (const y of c) deps.push([x, y]);
				}
			} else if (groups.length === 2) for (const x of groups[0]) for (const y of groups[1]) deps.push([x, y]);
		}
	}
	const out: ParsedPipeline[] = [];
	for (const dag of dags) {
		const b = new PipelineBuilder(dag.id, "Airflow", file);
		const mine = tasks.filter((t) => t.dag === dag);
		if (!mine.length) continue;
		if (dag.schedule) b.note("params", `schedule: ${firstLine(pyString(dag.schedule) ?? dag.schedule, 40)}`);
		for (const t of mine) b.step(`t:${t.id}`, t.id, { rows: t.rows, data: { dag: dag.id, ...t.data } });
		for (const [a, c, label] of deps) if (a.dag === dag && c.dag === dag) b.edge(`t:${a.id}`, `t:${c.id}`, label, label ? "dataflow" : "dependsOn");
		if (unresolved) b.warnings.push(`${file}: ${unresolved} dependency operand(s) could not be resolved statically (loops, helper functions); the agent can complete them.`);
		out.push(b.finish());
	}
	return out;
}

// ---------------------------------------------------------------- Metaflow (static scan)

export function parseMetaflow(text: string, file: string): ParsedPipeline[] {
	if (!/\bFlowSpec\b/.test(text) || !/@step\b/.test(text)) return [];
	const src = stripPyComments(text);
	const out: ParsedPipeline[] = [];
	const classes = [...src.matchAll(/^class\s+(\w+)\s*\(\s*(?:\w+\.)?FlowSpec\s*\)\s*:/gm)];
	classes.forEach((cm, ci) => {
		const body = src.slice(cm.index!, ci + 1 < classes.length ? classes[ci + 1].index : src.length);
		const b = new PipelineBuilder(cm[1], "Metaflow", file);
		const defs = [...body.matchAll(/((?:^[ \t]+@[^\n]*\n)*)^[ \t]+def\s+(\w+)\s*\(\s*self\b/gm)];
		const steps = defs.filter((d) => /@step\b/.test(d[1]));
		steps.forEach((d, i) => {
			const decorators = [...d[1].matchAll(/@(\w+)/g)].map((x) => x[1]).filter((x) => x !== "step");
			b.step(`s:${d[2]}`, d[2], { rows: decorators.map((x) => ({ text: `@${x}`, detail: "decorator" })), data: { flow: cm[1], step: d[2] } });
			const end = i + 1 < steps.length ? steps[i + 1].index! : body.length;
			const stepBody = body.slice(d.index!, end);
			for (const n of stepBody.matchAll(/self\.next\(([\s\S]*?)\)\s*$/gm)) {
				const foreach = /foreach\s*=/.test(n[1]);
				for (const t of n[1].matchAll(/self\.(\w+)/g)) b.edge(`s:${d[2]}`, `s:${t[1]}`, foreach ? "foreach" : undefined, "dependsOn");
			}
		});
		if (steps.length) out.push(b.finish());
	});
	return out;
}

// ---------------------------------------------------------------- frameworks handed to the agent

export const AGENT_FRAMEWORKS: { name: string; test: (rel: string, text: string) => boolean }[] = [
	{ name: "Prefect", test: (_r, t) => /\bfrom\s+prefect\b|\bimport\s+prefect\b/.test(t) && /@flow\b|@task\b/.test(t) },
	{ name: "Dagster", test: (_r, t) => /\bfrom\s+dagster\b|\bimport\s+dagster\b/.test(t) && /@(asset|op|job|graph|multi_asset)\b|Definitions\(/.test(t) },
	{ name: "ZenML", test: (_r, t) => /\bfrom\s+zenml\b/.test(t) && /@(pipeline|step)\b/.test(t) },
	{ name: "Kedro", test: (r, t) => (/\bfrom\s+kedro\b/.test(t) && /\bnode\s*\(/.test(t)) || /(^|\/)conf\/base\/catalog\.ya?ml$/.test(r) },
	{ name: "Flyte", test: (_r, t) => /\bfrom\s+flytekit\b/.test(t) && /@(workflow|task)\b/.test(t) },
	{ name: "Kubeflow DSL (not compiled)", test: (_r, t) => /\bfrom\s+kfp\b|\bimport\s+kfp\b/.test(t) && /@(dsl\.)?pipeline\b/.test(t) },
	{ name: "SageMaker Pipelines SDK", test: (_r, t) => /sagemaker\.workflow\.pipeline\b/.test(t) },
	{ name: "Azure ML SDK pipelines", test: (_r, t) => /azure\.ai\.ml\.dsl\b/.test(t) && /@(dsl\.)?pipeline\b|\bpipeline\s*\(/.test(t) },
	{ name: "Ray workflows / Ray Train", test: (_r, t) => /\bfrom\s+ray\s+import\s+(workflow|train)\b|\bray\.workflow\b/.test(t) },
];

/** Parses one file into zero or more pipelines. YAML/JSON may hold several documents. */
export function parsePipelineFile(rel: string, text: string, root?: string): { pipelines: ParsedPipeline[]; error?: string } {
	const base = path.posix.basename(rel).toLowerCase();
	if (/\.py$/i.test(rel)) return { pipelines: [...parseAirflow(text, rel), ...parseMetaflow(text, rel)] };
	if (!/\.(ya?ml|json)$/i.test(rel)) return { pipelines: [] };
	// Cheap content checks before parsing anything.
	const isDvc = base === "dvc.yaml" || base === "dvc.yml";
	const maybe = isDvc || /\bdag\b[\s\S]*\btasks\b|"Steps"\s*:|\bjobs\b|kind:\s*(Cluster)?Workflow/.test(text);
	if (!maybe) return { pipelines: [] };
	let docs: any[];
	try {
		docs = /\.json$/i.test(rel) ? [JSON.parse(text)] : loadYamlAll(text);
	} catch (e: any) {
		return isDvc || /root:\s*\n\s+dag:|pipelineJob/.test(text) ? { pipelines: [], error: `${rel}: ${String(e?.message ?? e).split("\n")[0]}` } : { pipelines: [] };
	}
	const out: ParsedPipeline[] = [];
	for (const doc of docs) {
		if (!doc || typeof doc !== "object") continue;
		const p = isDvc ? parseDvc(doc, rel) : parseKfp(doc, rel) ?? parseAzureMl(doc, rel, root) ?? parseSageMaker(doc, rel) ?? parseArgo(doc, rel);
		if (p && p.nodes.length) out.push(p);
	}
	return { pipelines: out };
}

/** Gives every pipeline's ids a unique prefix and, when there are several, a container. */
export function assemblePipelines(pipelines: ParsedPipeline[]): { nodes: MapNode[]; edges: MapEdge[] } {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const several = pipelines.length > 1;
	pipelines.forEach((p, i) => {
		const prefix = several ? `p${i + 1}:` : "";
		const container = `pipeline:${slug(p.file)}#${slug(p.name)}`;
		if (several) nodes.push({ id: container, label: `${p.name}  ·  ${p.framework}  (${p.file})`, kind: "ml:pipeline", container: true, style: ML_STYLES.pipeline, data: { framework: p.framework, file: p.file, pipeline: p.name } });
		const scoped = (id: string) => `${prefix}${slug(id)}`;
		for (const n of p.nodes) nodes.push({ ...n, id: scoped(n.id), parent: n.parent ? scoped(n.parent) : several ? container : undefined, data: { ...(n.data ?? {}), pipeline: p.name } });
		for (const e of p.edges) edges.push({ ...e, from: scoped(e.from), to: scoped(e.to) });
	});
	return { nodes, edges };
}
