/**
 * MLflow tracking and model registry: experiments › their best runs › the
 * registered model versions built from them. Reads a tracking server over the
 * REST API (GET / search calls only) or a local `mlruns` file store.
 */
import * as fs from "fs";
import * as path from "path";
import { agentRequest, digDeeperRequest, slug, loadYaml } from "../common";
import type { CheckCoverage, CollectContext, MapEdge, MapFinding, MapGraph, MapInput, MapNode, MapRow, Recipe } from "../../types";
import { MapperError } from "../../types";
import { firstLine, fmtNum, httpRequest, keepOnMap, ML_STYLES, redactUrl } from "./shared";

export interface MlRun {
	id: string;
	name: string;
	experimentId: string;
	status: string;
	start?: number;
	end?: number;
	user?: string;
	metrics: Record<string, number>;
	params: Record<string, string>;
	tags: Record<string, string>;
}

export interface MlExperiment {
	id: string;
	name: string;
	artifactLocation?: string;
	runs: MlRun[];
	totalRuns: number;
	keyMetric?: { key: string; higherIsBetter: boolean };
}

export interface MlModelVersion {
	name: string;
	version: string;
	runId?: string;
	source?: string;
	stage?: string;
	status?: string;
	aliases: string[];
	created?: number;
}

export interface MlRegisteredModel {
	name: string;
	description?: string;
	versions: MlModelVersion[];
	totalVersions: number;
}

export interface MlflowStore {
	uri: string;
	kind: "rest" | "file";
	experiments: MlExperiment[];
	models: MlRegisteredModel[];
	warnings: string[];
}

export interface MlflowOptions {
	maxRuns: number;
	metric?: string;
	experimentFilter?: string;
}

const RUN_STATUS: Record<string, string> = { "1": "RUNNING", "2": "SCHEDULED", "3": "FINISHED", "4": "FAILED", "5": "KILLED" };
const LOWER_IS_BETTER = /loss|error|rmse|mae|mse|mape|perplexity|\bppl\b|wer|cer|logloss|latency|nll/i;
/** Tie-breaker between equally common quality metrics. */
const PRIORITY = ["auc", "roc_auc", "f1", "accuracy", "acc", "r2", "map", "ndcg", "bleu", "rouge", "precision", "recall", "rmse", "mse", "mae", "loss", "error"];
const QUALITY = /(accuracy|\bacc\b|f1|auc|roc|r2|precision|recall|\bmap\b|ndcg|bleu|rouge|score|loss|rmse|mae|mse|error|perplexity)/i;

/** The metric runs are ranked by: the user's, else the most common quality metric, preferring validation/test ones. */
export function pickKeyMetric(runs: MlRun[], preferred?: string): { key: string; higherIsBetter: boolean } | undefined {
	const counts = new Map<string, number>();
	for (const r of runs) for (const k of Object.keys(r.metrics)) counts.set(k, (counts.get(k) ?? 0) + 1);
	if (preferred) return { key: preferred, higherIsBetter: !LOWER_IS_BETTER.test(preferred) };
	if (counts.size === 0) return undefined;
	const priority = (k: string) => {
		const i = PRIORITY.findIndex((p) => new RegExp(`(^|[_/.-])${p}($|[_/.-])`, "i").test(k));
		return i < 0 ? 0 : PRIORITY.length - i;
	};
	const score = (k: string) => (counts.get(k) ?? 0) * 100 + (QUALITY.test(k) ? 10000 : 0) + (/^(val|valid|validation|test|eval)[_/.-]/i.test(k) ? 5000 : 0) + (/train/i.test(k) ? -3000 : 0) + priority(k);
	const key = [...counts.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
	return { key, higherIsBetter: !LOWER_IS_BETTER.test(key) };
}

/** Best runs first by the key metric (runs without it last, newest first among equals). */
export function rankRuns(runs: MlRun[], key?: { key: string; higherIsBetter: boolean }): MlRun[] {
	return [...runs].sort((a, b) => {
		if (key) {
			const va = a.metrics[key.key];
			const vb = b.metrics[key.key];
			const ha = Number.isFinite(va);
			const hb = Number.isFinite(vb);
			if (ha !== hb) return ha ? -1 : 1;
			if (ha && hb && va !== vb) return key.higherIsBetter ? vb - va : va - vb;
		}
		return (b.start ?? 0) - (a.start ?? 0);
	});
}

/** The run a model version was built from: run_id, else a run id inside its source URI. */
export function versionRunId(v: { runId?: string; source?: string }): string | undefined {
	if (v.runId) return v.runId;
	const s = v.source ?? "";
	return /runs:\/([0-9a-f]{32})\b/.exec(s)?.[1] ?? /\/([0-9a-f]{32})\/artifacts\b/.exec(s)?.[1];
}

/** Keeps the top runs of each experiment plus every run a registered version comes from. */
function selectRuns(store: MlflowStore, opts: MlflowOptions): void {
	const registered = new Set(store.models.flatMap((m) => m.versions.map(versionRunId).filter(Boolean) as string[]));
	for (const e of store.experiments) {
		e.keyMetric = pickKeyMetric(e.runs, opts.metric);
		const ranked = rankRuns(e.runs, e.keyMetric);
		const keep = new Set(ranked.slice(0, opts.maxRuns));
		for (const r of ranked) if (registered.has(r.id)) keep.add(r);
		e.runs = ranked.filter((r) => keep.has(r));
	}
}

// ---------------------------------------------------------------- local file store

const readText = (p: string): string | undefined => {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
};
const readYaml = (p: string): any => {
	const t = readText(p);
	if (t === undefined) return undefined;
	try {
		return loadYaml(t);
	} catch {
		return undefined;
	}
};
const dirs = (p: string): string[] => {
	try {
		return fs
			.readdirSync(p, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
};

/** Files below `dir` as key → content; nested folders give keys with "/". */
function keyFiles(dir: string, prefix = "", depth = 0, out: Record<string, string> = {}): Record<string, string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isDirectory() && depth < 6) keyFiles(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1, out);
		else if (e.isFile()) out[`${prefix}${e.name}`] = readText(path.join(dir, e.name)) ?? "";
	}
	return out;
}

/** Latest value of a metric file ("timestamp value step" lines): highest step, then latest timestamp. */
function lastMetric(text: string): number | undefined {
	let best: { step: number; ts: number; v: number } | undefined;
	for (const line of text.split("\n")) {
		const [ts, v, step] = line.trim().split(/\s+/).map(Number);
		if (!Number.isFinite(v)) continue;
		const cur = { step: Number.isFinite(step) ? step : 0, ts: Number.isFinite(ts) ? ts : 0, v };
		if (!best || cur.step > best.step || (cur.step === best.step && cur.ts >= best.ts)) best = cur;
	}
	return best?.v;
}

/** The mlruns folder for a tracking URI that points at a local file store, or undefined. */
export function localStorePath(uri: string, cwd: string): string | undefined {
	let p = uri.trim();
	if (/^file:/i.test(p)) {
		try {
			p = decodeURIComponent(new URL(p).pathname);
		} catch {
			p = p.replace(/^file:\/\//i, "");
		}
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^(databricks|sqlite|postgresql|mysql|mssql)/i.test(p)) return undefined;
	p = path.resolve(cwd, p || ".");
	if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return undefined;
	if (path.basename(p) !== "mlruns" && fs.existsSync(path.join(p, "mlruns"))) p = path.join(p, "mlruns");
	return p;
}

export function readFileStore(root: string, opts: MlflowOptions, progress: (t: string) => void = () => undefined): MlflowStore {
	const warnings: string[] = [];
	const experiments: MlExperiment[] = [];
	for (const expDir of dirs(root)) {
		if (expDir === "models" || expDir.startsWith(".")) continue;
		const meta = readYaml(path.join(root, expDir, "meta.yaml"));
		if (!meta || meta.experiment_id === undefined) continue;
		if (meta.lifecycle_stage === "deleted") continue;
		const name = String(meta.name ?? expDir);
		if (opts.experimentFilter && !name.toLowerCase().includes(opts.experimentFilter.toLowerCase())) continue;
		progress(`Reading experiment ${name}…`);
		// Runs sit in <exp>/<run_id>/ (and in <exp>/runs/<run_id>/ in some layouts).
		const runDirs = [
			...dirs(path.join(root, expDir)).map((d) => path.join(root, expDir, d)),
			...dirs(path.join(root, expDir, "runs")).map((d) => path.join(root, expDir, "runs", d)),
		];
		const metas = runDirs
			.map((d) => ({ dir: d, meta: readYaml(path.join(d, "meta.yaml")) }))
			.filter((r) => r.meta && (r.meta.run_id || r.meta.run_uuid) && r.meta.lifecycle_stage !== "deleted");
		metas.sort((a, b) => Number(b.meta.start_time ?? 0) - Number(a.meta.start_time ?? 0));
		if (metas.length > 500) warnings.push(`${name}: ${metas.length} runs; only the 500 most recent were compared.`);
		const runs: MlRun[] = metas.slice(0, 500).map(({ dir, meta: m }) => {
			const metrics: Record<string, number> = {};
			for (const [k, v] of Object.entries(keyFiles(path.join(dir, "metrics")))) {
				const val = lastMetric(v);
				if (val !== undefined) metrics[k] = val;
			}
			const params = Object.fromEntries(Object.entries(keyFiles(path.join(dir, "params"))).map(([k, v]) => [k, v.trim()]));
			const tags = Object.fromEntries(Object.entries(keyFiles(path.join(dir, "tags"))).map(([k, v]) => [k, v.trim()]));
			const id = String(m.run_id ?? m.run_uuid);
			return {
				id,
				name: String(m.run_name ?? tags["mlflow.runName"] ?? id.slice(0, 8)),
				experimentId: String(m.experiment_id ?? meta.experiment_id),
				status: RUN_STATUS[String(m.status)] ?? String(m.status ?? ""),
				start: Number(m.start_time) || undefined,
				end: Number(m.end_time) || undefined,
				user: m.user_id ? String(m.user_id) : undefined,
				metrics,
				params,
				tags,
			};
		});
		experiments.push({ id: String(meta.experiment_id), name, artifactLocation: meta.artifact_location ? String(meta.artifact_location) : undefined, runs, totalRuns: metas.length });
	}
	const models: MlRegisteredModel[] = [];
	const modelsDir = path.join(root, "models");
	const walkModels = (dir: string, prefix: string, depth: number) => {
		for (const d of dirs(dir)) {
			const p = path.join(dir, d);
			const meta = readYaml(path.join(p, "meta.yaml"));
			if (!meta?.name) {
				if (depth < 2) walkModels(p, `${prefix}${d}/`, depth + 1);
				continue;
			}
			const aliasFiles = keyFiles(path.join(p, "aliases"));
			const aliasesByVersion = new Map<string, string[]>();
			for (const [alias, version] of Object.entries(aliasFiles)) {
				const v = version.trim();
				if (!aliasesByVersion.has(v)) aliasesByVersion.set(v, []);
				aliasesByVersion.get(v)!.push(alias);
			}
			const versions: MlModelVersion[] = dirs(p)
				.filter((v) => /^version-\d+$/.test(v))
				.map((v) => readYaml(path.join(p, v, "meta.yaml")))
				.filter((m) => m && m.version !== undefined)
				.map((m) => ({
					name: String(m.name ?? meta.name),
					version: String(m.version),
					runId: m.run_id ? String(m.run_id) : undefined,
					source: m.source ? String(m.source) : undefined,
					stage: m.current_stage && m.current_stage !== "None" ? String(m.current_stage) : undefined,
					status: m.status ? String(m.status) : undefined,
					aliases: aliasesByVersion.get(String(m.version)) ?? [],
					created: Number(m.creation_timestamp) || undefined,
				}));
			models.push({ name: String(meta.name), description: meta.description ? String(meta.description) : undefined, versions, totalVersions: versions.length });
		}
	};
	walkModels(modelsDir, "", 0);
	const store: MlflowStore = { uri: root, kind: "file", experiments, models, warnings };
	trimVersions(store);
	selectRuns(store, opts);
	return store;
}

/** The latest versions, plus every version that has a stage or an alias. */
function trimVersions(store: MlflowStore): void {
	for (const m of store.models) {
		const sorted = [...m.versions].sort((a, b) => Number(b.version) - Number(a.version));
		m.totalVersions = Math.max(m.totalVersions, sorted.length);
		m.versions = sorted.filter((v, i) => i < 6 || v.stage || v.aliases.length).sort((a, b) => Number(a.version) - Number(b.version));
	}
}

// ---------------------------------------------------------------- REST

function restRun(r: any): MlRun {
	const info = r?.info ?? {};
	const data = r?.data ?? {};
	const kv = (list: any[]) => Object.fromEntries((list ?? []).map((x: any) => [String(x.key), String(x.value)]));
	const tags = kv(data.tags);
	const id = String(info.run_id ?? info.run_uuid ?? "");
	return {
		id,
		name: String(info.run_name ?? tags["mlflow.runName"] ?? id.slice(0, 8)),
		experimentId: String(info.experiment_id ?? ""),
		status: String(info.status ?? ""),
		start: Number(info.start_time) || undefined,
		end: Number(info.end_time) || undefined,
		user: info.user_id ? String(info.user_id) : undefined,
		metrics: Object.fromEntries((data.metrics ?? []).map((m: any) => [String(m.key), Number(m.value)])),
		params: kv(data.params),
		tags,
	};
}

export interface RestAuth {
	token?: string;
}

function authHeaders(auth: RestAuth): Record<string, string> {
	const t = auth.token?.trim();
	if (!t) return {};
	if (/^(Bearer|Basic)\s/i.test(t)) return { Authorization: t };
	if (t.includes(":")) return { Authorization: `Basic ${Buffer.from(t).toString("base64")}` };
	return { Authorization: `Bearer ${t}` };
}

export async function readRestStore(base: string, auth: RestAuth, opts: MlflowOptions, ctx: Pick<CollectContext, "progress" | "signal">): Promise<MlflowStore> {
	const root = base.replace(/\/+$/, "");
	const headers = authHeaders(auth);
	const warnings: string[] = [];
	const call = async (method: "GET" | "POST", endpoint: string, body?: unknown, query?: Record<string, string>) => {
		const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
		const r = await httpRequest(`${root}/api/2.0/mlflow/${endpoint}${qs}`, { method, body, headers, timeoutMs: 20_000, signal: ctx.signal });
		if (r.status === 401 || r.status === 403) throw new MapperError(`The MLflow server at ${redactUrl(root)} refused access (${r.status}).`, "Give a token (or user:password) in the token field.");
		return r;
	};
	ctx.progress(`Listing experiments on ${redactUrl(root)}…`);
	const rawExperiments: any[] = [];
	let token: string | undefined;
	for (let page = 0; page < 5; page++) {
		const r = await call("POST", "experiments/search", { max_results: 200, ...(token ? { page_token: token } : {}) });
		if (r.status === 404 && page === 0) {
			// MLflow < 1.28 only has experiments/list.
			const old = await call("GET", "experiments/list");
			if (!old.ok) throw new MapperError(`${redactUrl(root)} does not look like an MLflow tracking server (HTTP ${old.status}).`);
			rawExperiments.push(...(old.json?.experiments ?? []));
			break;
		}
		if (!r.ok) throw new MapperError(`MLflow experiments/search failed (HTTP ${r.status}): ${firstLine(r.json?.message ?? r.text, 200)}`);
		rawExperiments.push(...(r.json?.experiments ?? []));
		token = r.json?.next_page_token;
		if (!token) break;
	}
	const experiments: MlExperiment[] = [];
	const wanted = rawExperiments.filter((e) => e?.lifecycle_stage !== "deleted" && (!opts.experimentFilter || String(e?.name ?? "").toLowerCase().includes(opts.experimentFilter.toLowerCase())));
	if (wanted.length > 40) warnings.push(`${wanted.length} experiments; only the 40 most recently updated were read.`);
	wanted.sort((a, b) => Number(b.last_update_time ?? 0) - Number(a.last_update_time ?? 0));
	for (const e of wanted.slice(0, 40)) {
		ctx.progress(`Reading runs of ${e.name}…`);
		const window = Math.max(50, opts.maxRuns * 5);
		const body: any = { experiment_ids: [String(e.experiment_id)], max_results: window, run_view_type: "ACTIVE_ONLY" };
		body.order_by = opts.metric ? [`metrics.\`${opts.metric}\` ${LOWER_IS_BETTER.test(opts.metric) ? "ASC" : "DESC"}`] : ["attributes.start_time DESC"];
		const r = await call("POST", "runs/search", body);
		if (!r.ok) {
			warnings.push(`${e.name}: runs/search failed (HTTP ${r.status}).`);
			continue;
		}
		const runs = (r.json?.runs ?? []).map(restRun);
		experiments.push({ id: String(e.experiment_id), name: String(e.name), artifactLocation: e.artifact_location, runs, totalRuns: r.json?.next_page_token ? Math.max(runs.length, window) : runs.length });
	}
	ctx.progress("Reading the model registry…");
	const models: MlRegisteredModel[] = [];
	token = undefined;
	const rawModels: any[] = [];
	for (let page = 0; page < 3; page++) {
		const r = await call("GET", "registered-models/search", undefined, { max_results: "100", ...(token ? { page_token: token } : {}) });
		if (!r.ok) {
			warnings.push(`Model registry not readable (HTTP ${r.status}); only experiments are drawn.`);
			break;
		}
		rawModels.push(...(r.json?.registered_models ?? []));
		token = r.json?.next_page_token;
		if (!token) break;
	}
	if (rawModels.length > 30) warnings.push(`${rawModels.length} registered models; only 30 were read.`);
	for (const m of rawModels.slice(0, 30)) {
		const aliases = new Map<string, string[]>();
		for (const a of m.aliases ?? []) {
			const v = String(a.version);
			if (!aliases.has(v)) aliases.set(v, []);
			aliases.get(v)!.push(String(a.alias));
		}
		const r = await call("GET", "model-versions/search", undefined, { filter: `name='${String(m.name).replace(/'/g, "\\'")}'`, max_results: "200" });
		const raw: any[] = r.ok ? r.json?.model_versions ?? [] : m.latest_versions ?? [];
		const versions = raw.map((v) => ({
			name: String(v.name ?? m.name),
			version: String(v.version),
			runId: v.run_id ? String(v.run_id) : undefined,
			source: v.source ? String(v.source) : undefined,
			stage: v.current_stage && v.current_stage !== "None" ? String(v.current_stage) : undefined,
			status: v.status ? String(v.status) : undefined,
			aliases: [...new Set([...(aliases.get(String(v.version)) ?? []), ...(v.aliases ?? []).map(String)])],
			created: Number(v.creation_timestamp) || undefined,
		}));
		models.push({ name: String(m.name), description: m.description, versions, totalVersions: versions.length });
	}
	const store: MlflowStore = { uri: redactUrl(root), kind: "rest", experiments, models, warnings };
	trimVersions(store);
	// Runs behind registered versions that are not among the runs read.
	const known = new Set(experiments.flatMap((e) => e.runs.map((r) => r.id)));
	const missing = [...new Set(models.flatMap((m) => m.versions.map(versionRunId)).filter((id): id is string => !!id && !known.has(id)))].slice(0, 25);
	for (const id of missing) {
		const r = await call("GET", "runs/get", undefined, { run_id: id });
		if (!r.ok || !r.json?.run) continue;
		const run = restRun(r.json.run);
		const exp = experiments.find((e) => e.id === run.experimentId);
		if (exp) exp.runs.push(run);
	}
	selectRuns(store, opts);
	return store;
}

// ---------------------------------------------------------------- graph

const RUN_STYLE: Record<string, string> = {
	FINISHED: "#d5e8d4;strokeColor=#82b366",
	FAILED: "#f8cecc;strokeColor=#b85450",
	KILLED: "#f5f5f5;strokeColor=#999999",
	RUNNING: "#dae8fc;strokeColor=#6c8ebf",
};
const runStyle = (status: string) =>
	`swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;rounded=1;arcSize=4;fillColor=${RUN_STYLE[status] ?? "#dae8fc;strokeColor=#6c8ebf"};`;
const STATUS_MARK: Record<string, string> = { FINISHED: "✓", FAILED: "✗", KILLED: "■", RUNNING: "▶", SCHEDULED: "…" };
const EXPERIMENT_STYLE = ML_STYLES.pipeline;
const REGISTRY_STYLE =
	"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#fdf2f2;strokeColor=#b85450;";
const REGISTER_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#b85450;fontSize=10;";

const iso = (ms?: number) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, "Z") : "");

function modelFlavors(tags: Record<string, string>): string | undefined {
	const h = tags["mlflow.log-model.history"];
	if (!h) return undefined;
	try {
		const list = JSON.parse(h);
		return [...new Set(list.flatMap((m: any) => Object.keys(m?.flavors ?? {})))].join(", ") || undefined;
	} catch {
		return undefined;
	}
}

export function mlflowToGraph(store: MlflowStore): MapGraph {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const runNode = new Map<string, string>();
	const shown = store.experiments.filter((e) => e.runs.length > 0);
	for (const e of shown) {
		const eid = `exp:${slug(e.id)}`;
		const km = e.keyMetric ? ` · best by ${e.keyMetric.key} ${e.keyMetric.higherIsBetter ? "↑" : "↓"}` : "";
		nodes.push({ id: eid, label: `${e.name}  (${e.totalRuns} run${e.totalRuns === 1 ? "" : "s"}${km})`, kind: "ml:mlflow:experiment", container: true, style: EXPERIMENT_STYLE, data: { experimentId: e.id, experiment: e.name, ...(e.artifactLocation ? { artifactLocation: e.artifactLocation } : {}), ...(e.keyMetric ? { keyMetric: e.keyMetric.key } : {}) } });
		for (const r of e.runs) {
			const id = `run:${slug(r.id)}`;
			runNode.set(r.id, id);
			const metricKeys = Object.keys(r.metrics).sort((a, b) => (a === e.keyMetric?.key ? -1 : b === e.keyMetric?.key ? 1 : a.localeCompare(b)));
			const rows: MapRow[] = [
				...metricKeys.slice(0, 5).map((k) => ({ text: `${k === e.keyMetric?.key ? "★ " : ""}${k} = ${fmtNum(r.metrics[k])}`, detail: k === e.keyMetric?.key ? "key metric" : undefined })),
				...(metricKeys.length > 5 ? [{ text: `… ${metricKeys.length - 5} more metrics` }] : []),
				...Object.keys(r.params)
					.sort()
					.slice(0, 5)
					.map((k) => ({ text: `${k} = ${firstLine(r.params[k], 30)}`, detail: "param" })),
			];
			const flavors = modelFlavors(r.tags);
			nodes.push({
				id,
				label: `${STATUS_MARK[r.status] ?? ""} ${r.name}`.trim(),
				kind: "ml:mlflow:run",
				parent: eid,
				shape: "table",
				style: runStyle(r.status),
				rows: rows.length ? rows : [{ text: "no metrics or params logged" }],
				data: {
					runId: r.id,
					experimentId: e.id,
					status: r.status,
					...(r.start ? { started: iso(r.start) } : {}),
					...(r.start && r.end ? { durationSec: String(Math.round((r.end - r.start) / 1000)) } : {}),
					...(r.user ? { user: r.user } : {}),
					...(r.tags["mlflow.source.name"] ? { sourceScript: r.tags["mlflow.source.name"] } : {}),
					...(r.tags["mlflow.source.git.commit"] ? { gitCommit: r.tags["mlflow.source.git.commit"] } : {}),
					...(r.tags["mlflow.parentRunId"] ? { parentRunId: r.tags["mlflow.parentRunId"] } : {}),
					...(flavors ? { modelFlavors: flavors } : {}),
				},
			});
		}
		// Nested runs (hyperparameter sweeps) point to their parent.
		for (const r of e.runs) {
			const parent = r.tags["mlflow.parentRunId"];
			if (parent && runNode.has(parent)) edges.push({ from: runNode.get(parent)!, to: runNode.get(r.id)!, label: "child", kind: "nested", style: ML_STYLES.softEdge });
		}
	}
	for (const m of store.models) {
		const mid = `model:${slug(m.name)}`;
		nodes.push({ id: mid, label: `${m.name}  (registered model, ${m.totalVersions} version${m.totalVersions === 1 ? "" : "s"})`, kind: "ml:mlflow:registered-model", container: true, style: REGISTRY_STYLE, data: { registeredModel: m.name, ...(m.description ? { description: m.description.slice(0, 300) } : {}) } });
		for (const v of m.versions) {
			const vid = `${mid}/v${slug(v.version)}`;
			const tags = [v.stage, ...v.aliases.map((a) => `@${a}`)].filter(Boolean).join(" ");
			nodes.push({
				id: vid,
				label: `v${v.version}${tags ? `\n${tags}` : ""}`,
				kind: "ml:mlflow:model-version",
				parent: mid,
				style: ML_STYLES.model,
				width: 120,
				height: tags ? 60 : 48,
				data: { registeredModel: m.name, version: v.version, ...(v.stage ? { stage: v.stage } : {}), ...(v.aliases.length ? { aliases: v.aliases.join(", ") } : {}), ...(v.status ? { status: v.status } : {}), ...(v.source ? { artifactUri: v.source } : {}), ...(versionRunId(v) ? { runId: versionRunId(v)! } : {}), ...(v.created ? { created: iso(v.created) } : {}) },
			});
			const run = versionRunId(v);
			if (run && runNode.has(run)) edges.push({ from: runNode.get(run)!, to: vid, label: "registered", kind: "registered", style: REGISTER_EDGE });
		}
	}
	const runs = shown.reduce((a, e) => a + e.runs.length, 0);
	return {
		title: `MLflow · ${store.kind === "rest" ? store.uri.replace(/^https?:\/\//, "") : path.basename(path.dirname(store.uri)) + "/" + path.basename(store.uri)}`,
		nodes,
		edges,
		direction: "right",
		legend: [
			`MLflow ${store.kind === "rest" ? "tracking server" : "file store"} ${store.uri}: ${shown.length} experiment(s), ${runs} run(s) shown, ${store.models.length} registered model(s).`,
			"Each experiment shows its best runs by its key metric (★); green finished, red failed. Red cubes: model versions with stage and @aliases; arrows: the run a version was registered from.",
			...(store.experiments.length > shown.length ? [`${store.experiments.length - shown.length} experiment(s) without runs are not drawn.`] : []),
		],
	};
}

/** Registered models none of whose versions is in Production or carries an alias (exported for tests). */
export function mlflowFindings(store: MlflowStore, graph: MapGraph): { findings: MapFinding[]; checked: CheckCoverage[] } {
	const findings: MapFinding[] = [];
	for (const m of store.models) {
		if (!m.versions.length) continue;
		if (m.versions.some((v) => /^production$/i.test(v.stage ?? "") || v.aliases.length)) continue;
		const staged = m.versions.filter((v) => v.stage).map((v) => `v${v.version} ${v.stage}`);
		findings.push({
			id: `no-serving-version:model:${slug(m.name)}`,
			kind: "no-serving-version",
			severity: "info",
			title: `${m.name} has no version in Production or with an alias`,
			detail: `${m.totalVersions} version(s) registered (latest v${m.versions[m.versions.length - 1].version})${staged.length ? `; staged: ${staged.join(", ")}` : ""}; none is in the Production stage or tagged with an alias such as @champion, so it is not clear which one serves.`,
			nodeIds: [`model:${slug(m.name)}`],
			fix: `Mark the version that serves: set an alias (e.g. client.set_registered_model_alias("${m.name}", "champion", <version>)) and load it as models:/${m.name}@champion.`,
		});
	}
	return { findings: keepOnMap(findings, graph), checked: [{ check: "Registered models without a version in Production or with an alias", scanned: store.models.filter((m) => m.versions.length).length, note: "registered models read" }] };
}

function mlflowFacts(store: MlflowStore): string {
	return JSON.stringify(
		{
			trackingUri: store.uri,
			experiments: store.experiments.map((e) => ({
				id: e.id,
				name: e.name,
				totalRuns: e.totalRuns,
				keyMetric: e.keyMetric,
				topRuns: e.runs.map((r) => ({ id: r.id, name: r.name, status: r.status, started: iso(r.start), metrics: r.metrics, params: r.params, source: r.tags["mlflow.source.name"], gitCommit: r.tags["mlflow.source.git.commit"], modelFlavors: modelFlavors(r.tags) })),
			})),
			registeredModels: store.models.map((m) => ({ name: m.name, totalVersions: m.totalVersions, versions: m.versions.map((v) => ({ version: v.version, stage: v.stage, aliases: v.aliases, status: v.status, runId: versionRunId(v), source: v.source })) })),
		},
		null,
		1
	);
}

export async function collectMlflow(input: MapInput, ctx: Pick<CollectContext, "progress" | "signal" | "cwd">, env: NodeJS.ProcessEnv = process.env): Promise<MlflowStore> {
	let uri = (input.trackingUri ?? "").trim() || env.MLFLOW_TRACKING_URI?.trim() || "";
	const opts: MlflowOptions = {
		maxRuns: Math.max(1, Math.min(50, parseInt(input.maxRuns || "5", 10) || 5)),
		metric: input.metric?.trim() || undefined,
		experimentFilter: input.experiment?.trim() || undefined,
	};
	let token = (input.token ?? "").trim();
	if (/^databricks/i.test(uri)) {
		const host = env.DATABRICKS_HOST?.trim();
		if (!host) throw new MapperError("The tracking URI is Databricks but DATABRICKS_HOST is not set.", "Enter the workspace URL (https://<workspace>.cloud.databricks.com) as the tracking URI and a personal access token.");
		uri = host.startsWith("http") ? host : `https://${host}`;
		token ||= env.DATABRICKS_TOKEN ?? "";
	}
	if (!uri) {
		const local = localStorePath("mlruns", ctx.cwd);
		if (!local) throw new MapperError("No tracking URI given, MLFLOW_TRACKING_URI is not set and there is no mlruns folder next to the diagram.", "Enter a tracking server URL (http://localhost:5000) or the path of an mlruns folder.");
		uri = local;
	}
	if (/^(sqlite|postgresql|mysql|mssql)/i.test(uri)) {
		throw new MapperError(`The Mapper does not read MLflow database stores (${uri.split(":")[0]}) directly.`, "Start `mlflow server --backend-store-uri <that URI>` and enter its http:// URL.");
	}
	if (/^https?:\/\//i.test(uri)) {
		if (!token) {
			const user = env.MLFLOW_TRACKING_USERNAME;
			const pass = env.MLFLOW_TRACKING_PASSWORD;
			token = env.MLFLOW_TRACKING_TOKEN ?? (user && pass ? `${user}:${pass}` : "");
		}
		// Credentials in the URL itself become the auth header, never part of what is shown.
		try {
			const u = new URL(uri);
			if (u.username && !token) token = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
			u.username = "";
			u.password = "";
			uri = u.toString();
		} catch {
			throw new MapperError(`${redactUrl(uri)} is not a valid URL.`);
		}
		return readRestStore(uri, { token }, opts, ctx);
	}
	const local = localStorePath(uri, ctx.cwd);
	if (!local) throw new MapperError(`${uri} is not an MLflow file store folder.`, "Point at the mlruns folder (or the folder that contains it).");
	ctx.progress(`Reading ${local}…`);
	return readFileStore(local, opts, (t) => ctx.progress(t));
}

export const mlflowRecipe: Recipe = {
	id: "ml.mlflow",
	category: "ml",
	title: "MLflow tracking & model registry",
	description: "Experiments with their best runs (key metrics and params), and the registered model versions (stages, aliases) built from them. Reads a tracking server's REST API or a local mlruns folder.",
	mode: "inventory",
	fields: [
		{ id: "trackingUri", label: "Tracking URI", type: "text", placeholder: "http://localhost:5000, databricks, or a path to mlruns", help: "Empty: $MLFLOW_TRACKING_URI, else the mlruns folder next to the diagram. Only GET and search calls are made." },
		{ id: "token", label: "Token (optional)", type: "password", secret: true, help: "Bearer token, or user:password. Empty: $MLFLOW_TRACKING_TOKEN or $MLFLOW_TRACKING_USERNAME/PASSWORD. Never stored or shown to the agent." },
		{ id: "maxRuns", label: "Runs per experiment", type: "text", default: "5", help: "The best runs by the key metric, plus every run a registered model version comes from." },
		{ id: "metric", label: "Key metric (optional)", type: "text", placeholder: "val_accuracy", help: "Default: the most common quality metric of each experiment (loss/error metrics rank lowest-first)." },
		{ id: "experiment", label: "Experiment name filter (optional)", type: "text" },
	],
	async collect(input, ctx) {
		const store = await collectMlflow(input, ctx);
		if (store.experiments.length === 0 && store.models.length === 0) return { summary: `No experiments or registered models in ${store.uri}.`, warnings: store.warnings };
		const graph = mlflowToGraph(store);
		const { findings, checked } = mlflowFindings(store, graph);
		const runs = store.experiments.reduce((a, e) => a + e.runs.length, 0);
		const versions = store.models.reduce((a, m) => a + m.versions.length, 0);
		return {
			graph,
			summary: `${store.experiments.length} experiment(s), ${runs} top run(s), ${store.models.length} registered model(s) with ${versions} version(s)`,
			facts: mlflowFacts(store),
			warnings: store.warnings,
			findings,
			checked,
		};
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"The MLflow map on this page shows experiments, their best runs and the registered model versions. Annotate it: compare the top runs of each experiment (which params moved the key metric), point out the version currently serving (Production stage or champion-like alias) and whether it is still the best run, failed or unregistered promising runs, and missing lineage (versions without a run). If the code that logs these runs is in the workspace, link each experiment to the training script (mlflow.source.name).",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("MLflow experiments, runs and model versions (use the run ids, source scripts and git commits; read the training code and the logged params/metrics)", shapes, question),
};
