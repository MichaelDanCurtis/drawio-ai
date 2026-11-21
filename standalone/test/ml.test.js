// Unit tests for the Machine Learning mappers: pipelines (DVC, KFP, Azure ML,
// SageMaker, Airflow, Metaflow), MLflow (file store and a mocked REST server),
// the ML lifecycle scan, and model architectures (HF config + safetensors,
// GGUF, ONNX, XGBoost, LightGBM, and a real Hub model when online).
// Run from standalone/: node --test test/ml.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const { renderGraph } = require("../src/main/mapper/render");
const { checkModelXml } = require("./helpers/xml");
const { catalog } = require("../src/main/mapper/registry");
const { mlRecipes } = require("../src/main/mapper/recipes/ml");
const { mlPipelineRecipe, scanPipelines } = require("../src/main/mapper/recipes/ml/pipeline");
const { parsePipelineFile } = require("../src/main/mapper/recipes/ml/pipelineParsers");
const { mlflowRecipe, collectMlflow, pickKeyMetric } = require("../src/main/mapper/recipes/ml/mlflow");
const { lifecycleRecipe, scanLifecycle } = require("../src/main/mapper/recipes/ml/lifecycle");
const { modelRecipe, mapLocalModel, mapHubModel, normalizeHfId } = require("../src/main/mapper/recipes/ml/model");
const { onnxToGraph, moduleOf } = require("../src/main/mapper/recipes/ml/modelArch");
const { parseOnnx, ByteSource } = require("../src/main/mapper/recipes/ml/modelFormats");

const FIX = path.join(__dirname, "fixtures/ml");
const ctx = (cwd = FIX) => ({ cwd, progress: () => {}, signal: new AbortController().signal, exec: async () => assert.fail("the ML mappers run no commands") });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ml-${name}-`));
const draws = (graph, recipe) => {
	const { xml } = renderGraph(graph, { recipe });
	checkModelXml(xml);
	return xml;
};
const edge = (g, from, to) => g.edges.find((e) => e.from === from && e.to === to);

// ---------------------------------------------------------------- pipelines

test("pipeline scan: every supported format in one repository, one container per pipeline", async () => {
	const r = await mlPipelineRecipe.collect({ folder: path.join(FIX, "pipelines") }, ctx());
	const g = r.graph;
	const frameworks = g.nodes.filter((n) => n.kind === "ml:pipeline").map((n) => n.data.framework).sort();
	assert.deepEqual(frameworks, ["Airflow", "Azure ML", "DVC", "Kubeflow (kfp-2.7.0)", "Metaflow", "SageMaker Pipelines"]);
	assert.match(r.summary, /6 pipeline\(s\)/);
	assert.match(r.summary, /Prefect left to the agent/);
	// Everything else sits inside its pipeline's container.
	const containers = new Set(g.nodes.filter((n) => n.kind === "ml:pipeline").map((n) => n.id));
	for (const n of g.nodes.filter((n) => n.kind !== "ml:pipeline")) assert.ok(n.parent, `${n.id} has no container`);
	for (const n of g.nodes.filter((n) => n.parent && containers.has(n.parent))) assert.ok(n.data.pipeline);
	assert.equal(g.direction, "right");
	assert.match(r.facts, /## Pipelines the Mapper could not parse deterministically[\s\S]*Prefect: prefect\/flow\.py/);
	const xml = draws(g, "ml.pipeline");
	assert.match(xml, /shape=cylinder3/, "datasets are cylinders");
	assert.match(xml, /shape=cube/, "models are cubes");
	assert.match(xml, /shape=document/, "metrics are documents");
	assert.match(mlPipelineRecipe.agentPrompt({}, r), /Complete it[\s\S]*Prefect/);
	assert.match(mlPipelineRecipe.digDeeper([{ label: "train", data: { step: "train" } }], "what data?"), /what data\?[\s\S]*"step":"train"/);
});

test("DVC: stage → artifact → stage, code deps and params as rows, metrics as documents", async () => {
	const r = await mlPipelineRecipe.collect({ file: path.join(FIX, "pipelines/dvc/dvc.yaml") }, ctx());
	const g = r.graph;
	assert.equal(g.title, "DVC pipeline · dvc.yaml");
	assert.ok(!g.nodes.some((n) => n.kind === "ml:pipeline"), "a single pipeline needs no container");
	const node = (id) => g.nodes.find((n) => n.id === id);
	assert.deepEqual(node("s:prepare").rows.map((x) => x.text), ["$ python src/prepare.py data/data.xml", "src/prepare.py", "prepare.seed", "prepare.split"]);
	assert.equal(node("a:model.pkl").kind, "ml:model");
	assert.equal(node("a:eval/metrics.json").kind, "ml:metrics");
	assert.equal(node("a:data/data.xml").kind, "ml:data");
	for (const [a, b] of [
		["a:data/data.xml", "s:prepare"],
		["s:prepare", "a:data/prepared"],
		["a:data/prepared", "s:featurize"],
		["a:data/features", "s:train"], // dep data/features/train.pkl is inside the out data/features
		["s:train", "a:model.pkl"],
		["a:model.pkl", "s:evaluate"],
		["s:evaluate", "a:eval/metrics.json"],
	])
		assert.ok(edge(g, a, b), `${a} → ${b}`);
	assert.ok(!g.nodes.some((n) => n.id === "a:src/train.py"), "code files are rows, not artifacts");
	draws(g, "ml.pipeline");
});

test("Kubeflow IR: tasks, typed artifacts, parameter passing, a condition group, no redundant dependsOn", () => {
	const text = fs.readFileSync(path.join(FIX, "pipelines/kfp/pipeline.yaml"), "utf8");
	const [p] = parsePipelineFile("kfp/pipeline.yaml", text).pipelines;
	assert.equal(p.name, "churn-training");
	const node = (id) => p.nodes.find((n) => n.id === id);
	assert.equal(node("t:train:model").kind, "ml:model");
	assert.equal(node("t:preprocess:train_data").kind, "ml:data");
	assert.equal(node("t:evaluate:metrics").kind, "ml:metrics");
	assert.equal(node("t:condition-1").kind, "ml:group");
	assert.match(node("t:condition-1").label, /if evaluate-auc > 0\.8/);
	assert.equal(node("t:condition-1/deploy").parent, "t:condition-1");
	assert.equal(node("t:train").data.image, "gcr.io/my-project/trainer:1.4");
	assert.ok(node("t:train").rows.some((r) => r.text === "learning_rate = 0.05"));
	const has = (a, b) => p.edges.some((e) => e.from === a && e.to === b);
	assert.ok(has("t:preprocess:train_data", "t:train"));
	assert.ok(has("t:train:model", "t:evaluate"));
	assert.ok(has("t:preprocess:test_data", "t:evaluate"));
	assert.ok(has("t:train:model", "t:condition-1"));
	assert.equal(p.edges.find((e) => e.from === "t:evaluate" && e.to === "t:condition-1").label, "auc");
	assert.ok(!has("t:preprocess", "t:train"), "dependentTasks already carried by data are not drawn again");
});

test("Azure ML pipeline job: ${{parent.jobs…}} bindings, pipeline inputs/outputs, local component files", () => {
	const root = path.join(FIX, "pipelines");
	const text = fs.readFileSync(path.join(root, "azureml/pipeline.yml"), "utf8");
	const [p] = parsePipelineFile("azureml/pipeline.yml", text, root).pipelines;
	assert.equal(p.name, "nyc-taxi-training");
	const node = (id) => p.nodes.find((n) => n.id === id);
	assert.match(node("j:prep_job").data.command, /python prep\.py/, "command read from ./prep.yml");
	assert.equal(node("o:train_job.model_output").kind, "ml:model");
	assert.equal(node("o:train_job.model_output").data.pipelineOutput, "trained_model");
	const has = (a, b, label) => p.edges.some((e) => e.from === a && e.to === b && (label === undefined || e.label === label));
	assert.ok(has("in:raw_data", "j:prep_job"));
	assert.ok(has("o:prep_job.prep_data", "j:train_job", "training_data"));
	assert.ok(has("o:train_job.model_output", "j:score_job", "model"));
	assert.ok(has("j:score_job", "o:score_job.score_report"));
	assert.match(node("params").label, /test_split_ratio = 0\.2/);
});

test("SageMaker definition: property references become artifacts, condition branches, register step", () => {
	const text = fs.readFileSync(path.join(FIX, "pipelines/sagemaker/pipeline-definition.json"), "utf8");
	const [p] = parsePipelineFile("sagemaker/pipeline-definition.json", text).pipelines;
	const has = (a, b, label) => p.edges.some((e) => e.from === a && e.to === b && (label === undefined || e.label === label));
	assert.ok(has("p:InputDataUrl", "s:AbaloneProcess"));
	assert.ok(has("s:AbaloneProcess:out:train", "s:AbaloneTrain"));
	assert.ok(has("s:AbaloneTrain:model", "s:AbaloneEval"));
	assert.ok(has("s:AbaloneEval:pf:EvaluationReport", "s:AbaloneMSECond"));
	assert.ok(has("s:AbaloneMSECond", "s:AbaloneRegisterModel", "true"));
	assert.ok(has("s:AbaloneMSECond", "s:AbaloneMSEFail", "false"));
	assert.ok(has("s:AbaloneTrain:model", "s:AbaloneRegisterModel"));
	assert.equal(p.nodes.find((n) => n.id === "s:AbaloneRegisterModel").kind, "ml:register");
	assert.match(p.nodes.find((n) => n.id === "params").label, /MseThreshold = 6/);
});

test("Airflow (static scan): operators, TaskFlow, >> / << with lists, XCom data passing", () => {
	const text = fs.readFileSync(path.join(FIX, "pipelines/airflow/dags/train_dag.py"), "utf8");
	const [p] = parsePipelineFile("airflow/dags/train_dag.py", text).pipelines;
	assert.equal(p.name, "churn_training");
	const ids = p.nodes.filter((n) => n.kind === "ml:step").map((n) => n.id.slice(2)).sort();
	assert.deepEqual(ids, ["end", "evaluate", "extract_events", "gate", "notify_failure", "register", "start", "train_model", "validate_data"]);
	const has = (a, b) => p.edges.some((e) => e.from === `t:${a}` && e.to === `t:${b}`);
	for (const [a, b] of [
		["start", "extract_events"],
		["extract_events", "validate_data"],
		["validate_data", "train_model"],
		["train_model", "evaluate"], // evaluate(train.output)
		["evaluate", "gate"], // quality_gate(metrics)
		["gate", "register"], // gate >> [register_model(), notify]
		["gate", "notify_failure"],
		["notify_failure", "end"],
	])
		assert.ok(has(a, b), `${a} >> ${b}`);
	assert.equal(p.edges.length, 8);
	const extract = p.nodes.find((n) => n.id === "t:extract_events");
	assert.equal(extract.data.operator, "BashOperator");
	assert.match(extract.data.bash_command, /jobs\/extract\.py/);
	assert.match(p.nodes.find((n) => n.id === "params").label, /@daily/);
});

test("pipeline recipe: frameworks without a parser go to the agent with source excerpts", async () => {
	const r = await mlPipelineRecipe.collect({ folder: path.join(FIX, "pipelines/prefect") }, ctx());
	assert.equal(r.graph, undefined);
	assert.match(r.summary, /Prefect in 1 file/);
	assert.match(r.facts, /@flow\(name="nightly-train"\)/);
	assert.match(mlPipelineRecipe.agentPrompt({}, r), /cannot parse it deterministically[\s\S]*nightly-train/);
	const empty = tmp("empty");
	assert.match((await mlPipelineRecipe.collect({ folder: empty }, ctx(empty))).summary, /No ML pipeline definitions/);
});

// ---------------------------------------------------------------- MLflow

test("MLflow file store: experiments › top runs by the key metric, plus registered runs, → versions with stage and alias", async () => {
	const r = await mlflowRecipe.collect({ trackingUri: path.join(FIX, "mlruns"), maxRuns: "2" }, ctx());
	const g = r.graph;
	assert.match(r.summary, /3 top run\(s\), 1 registered model\(s\) with 2 version\(s\)/);
	const exp = g.nodes.find((n) => n.kind === "ml:mlflow:experiment");
	assert.match(exp.label, /churn-classifier\s+\(4 runs · best by val_auc ↑\)/);
	assert.ok(!g.nodes.some((n) => n.label.startsWith("Default")), "experiments without runs are not drawn");
	const runs = g.nodes.filter((n) => n.kind === "ml:mlflow:run");
	assert.deepEqual(runs.map((n) => n.label), ["✓ bold-hawk", "✓ calm-owl", "✓ old-cat"], "best two by val_auc, then old-cat because version 1 came from it");
	assert.ok(!runs.some((n) => /lazy-fox/.test(n.label)), "the failed low-scoring run is not among the top");
	assert.deepEqual(runs[0].rows.slice(0, 3).map((x) => x.text), ["★ val_auc = 0.91", "train_loss = 0.21", "val/loss = 0.31"], "latest value by step; nested metric keys");
	assert.equal(runs[0].data.modelFlavors, "python_function, sklearn");
	const v2 = g.nodes.find((n) => n.id === "model:churn-model/v2");
	assert.equal(v2.label, "v2\nProduction @champion");
	assert.equal(v2.data.runId, "0a1b2c3d4e5f60718293a4b5c6d7e8f9", "run id recovered from runs:/ source");
	assert.ok(edge(g, "run:0a1b2c3d4e5f60718293a4b5c6d7e8f9", "model:churn-model/v2"));
	assert.ok(edge(g, "run:3d4e5f60718293a4b5c6d7e8f9a0b1c2", "model:churn-model/v1"));
	draws(g, "ml.mlflow");
	assert.match(mlflowRecipe.agentPrompt({}, r), /best runs[\s\S]*"keyMetric"/);
});

test("MLflow: key metric choice prefers validation quality metrics; loss-like metrics rank lowest first", () => {
	const runs = [{ metrics: { train_loss: 1, val_accuracy: 0.8, epoch: 3 } }, { metrics: { train_loss: 1, val_accuracy: 0.9 } }];
	assert.deepEqual(pickKeyMetric(runs), { key: "val_accuracy", higherIsBetter: true });
	assert.deepEqual(pickKeyMetric([{ metrics: { rmse: 3, epoch: 1 } }]), { key: "rmse", higherIsBetter: false });
	assert.deepEqual(pickKeyMetric(runs, "train_loss"), { key: "train_loss", higherIsBetter: false });
});

function mlflowServer(token) {
	const seen = { auth: new Set(), calls: [] };
	const run = (id, name, rmse, start) => ({
		info: { run_id: id, experiment_id: "7", run_name: name, status: "FINISHED", start_time: start, end_time: start + 5000, user_id: "bob" },
		data: { metrics: [{ key: "rmse", value: rmse, step: 9 }, { key: "mae", value: rmse / 2 }], params: [{ key: "max_depth", value: String(Math.round(rmse * 10)) }], tags: [{ key: "mlflow.source.name", value: "train.py" }] },
	});
	const ids = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(32).slice(0, 32).replace(/^./, "a"));
	const runs = ids.map((id, i) => run(id, `run-${i}`, 1 + i * 0.5, 1000 + i));
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.auth.add(req.headers.authorization);
			const url = new URL(req.url, "http://x");
			seen.calls.push(`${req.method} ${url.pathname}`);
			const send = (status, obj) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(obj));
			};
			if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error_code: "UNAUTHENTICATED" });
			if (req.method !== "GET" && !url.pathname.endsWith("/search")) return send(405, { message: "the Mapper only reads" });
			switch (url.pathname) {
				case "/api/2.0/mlflow/experiments/search":
					return send(200, { experiments: [{ experiment_id: "7", name: "fraud", lifecycle_stage: "active", last_update_time: 9 }, { experiment_id: "8", name: "old", lifecycle_stage: "deleted" }] });
				case "/api/2.0/mlflow/runs/search": {
					const q = JSON.parse(body);
					assert.deepEqual(q.experiment_ids, ["7"]);
					return send(200, { runs: runs.slice(0, 5) }); // the sixth run is only reachable through runs/get
				}
				case "/api/2.0/mlflow/registered-models/search":
					return send(200, { registered_models: [{ name: "fraud-model", aliases: [{ alias: "champion", version: "2" }] }] });
				case "/api/2.0/mlflow/model-versions/search":
					assert.equal(url.searchParams.get("filter"), "name='fraud-model'");
					return send(200, {
						model_versions: [
							{ name: "fraud-model", version: "1", run_id: ids[0], current_stage: "Archived", status: "READY", source: `mlflow-artifacts:/7/${ids[0]}/artifacts/model` },
							{ name: "fraud-model", version: "2", run_id: ids[5], current_stage: "None", status: "READY" },
						],
					});
				case "/api/2.0/mlflow/runs/get":
					return send(200, { run: runs.find((r) => r.info.run_id === url.searchParams.get("run_id")) });
				default:
					return send(404, {});
			}
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}`, ids })));
}

test("MLflow REST (mock server): read-only calls, bearer token, rmse ranks ascending, registered runs fetched, no token in the output", async () => {
	const token = "s3cr3t-token-123";
	const { server, seen, base, ids } = await mlflowServer(token);
	try {
		const r = await mlflowRecipe.collect({ trackingUri: base, token, maxRuns: "2" }, ctx());
		const g = r.graph;
		assert.deepEqual([...seen.auth], [`Bearer ${token}`]);
		assert.ok(seen.calls.every((c) => c.startsWith("GET ") || c.endsWith("/search")), `only GET and search: ${seen.calls.join(", ")}`);
		assert.ok(seen.calls.includes("GET /api/2.0/mlflow/runs/get"), "the run behind version 2 was fetched");
		const runs = g.nodes.filter((n) => n.kind === "ml:mlflow:run").map((n) => n.label);
		assert.deepEqual(runs, ["✓ run-0", "✓ run-1", "✓ run-5"], "lowest rmse first, plus the registered run");
		assert.match(g.nodes.find((n) => n.kind === "ml:mlflow:experiment").label, /best by rmse ↓/);
		assert.ok(!g.nodes.some((n) => n.label.includes("old")), "deleted experiments are skipped");
		assert.equal(g.nodes.find((n) => n.id === "model:fraud-model/v2").label, "v2\n@champion");
		assert.ok(edge(g, `run:${ids[5]}`, "model:fraud-model/v2"));
		assert.ok(edge(g, `run:${ids[0]}`, "model:fraud-model/v1"));
		const xml = draws(g, "ml.mlflow");
		for (const out of [xml, r.facts, r.summary, JSON.stringify(g)]) assert.ok(!out.includes(token), "the token never reaches the map or the agent");
		// Without the token: a clear error.
		await assert.rejects(mlflowRecipe.collect({ trackingUri: base }, ctx()), (e) => /refused access \(401\)/.test(e.message) && /token/.test(e.hint));
		// Credentials in the URL are used, never shown.
		const viaUrl = await collectMlflow({ trackingUri: base.replace("http://", `http://user:${token}@`), token }, ctx(), {});
		assert.ok(!viaUrl.uri.includes(token));
	} finally {
		server.close();
	}
});

test("MLflow: database stores and missing URIs give actionable errors", async () => {
	await assert.rejects(collectMlflow({ trackingUri: "sqlite:///mlflow.db" }, ctx(), {}), (e) => /database stores/.test(e.message) && /mlflow server/.test(e.hint));
	const empty = tmp("nomlruns");
	await assert.rejects(collectMlflow({}, ctx(empty), {}), /MLFLOW_TRACKING_URI is not set/);
	const viaEnv = await collectMlflow({}, ctx(empty), { MLFLOW_TRACKING_URI: `file://${path.join(FIX, "mlruns")}` });
	assert.equal(viaEnv.kind, "file");
});

// ---------------------------------------------------------------- lifecycle

test("ML lifecycle: evidence per stage, links from imports / artifacts / tools / CI, gaps flagged", async () => {
	const root = path.join(FIX, "lifecycle-repo");
	const r = await lifecycleRecipe.collect({ folder: root }, ctx(root));
	const g = r.graph;
	const comp = (id) => g.nodes.find((n) => n.id === id);
	assert.equal(comp("code:data/ingest.py").parent, "stage:data");
	assert.equal(comp("code:src/features/build_features.py").parent, "stage:features");
	assert.equal(comp("code:src/train.py").parent, "stage:training");
	assert.match(comp("code:src/train.py").label, /scikit-learn · XGBoost/);
	assert.equal(comp("code:src/evaluate.py").parent, "stage:evaluation");
	assert.equal(comp("code:serve/app.py").parent, "stage:deployment");
	assert.equal(comp("tool:features:Feast_feature_store").parent, "stage:features");
	assert.equal(comp("tool:registry:MLflow_Model_Registry").parent, "stage:registry");
	assert.equal(comp("tool:tracking:MLflow_tracking").parent, "stage:tracking");
	assert.equal(comp("tool:deployment:KServe_InferenceService").parent, "stage:deployment");
	assert.ok(!g.nodes.some((n) => /test_train/.test(n.id)), "tests are not lifecycle components");
	const has = (a, b, label) => g.edges.some((e) => e.from === a && e.to === b && (label === undefined || e.label === label));
	assert.ok(has("code:data/ingest.py", "code:src/features/build_features.py", "events.parquet"), "artifact written then read");
	assert.ok(has("code:src/train.py", "code:src/evaluate.py", "model.joblib"));
	assert.ok(has("code:src/train.py", "tool:tracking:MLflow_tracking", "logs"));
	assert.ok(has("code:src/train.py", "tool:registry:MLflow_Model_Registry", "registers"));
	assert.ok(has("tool:registry:MLflow_Model_Registry", "code:serve/app.py", "loads"), "models:/ URI");
	assert.ok(has("tool:data:SQL_database", "code:data/ingest.py", "reads"));
	assert.ok(has("code:serve/app.py", "tool:deployment:Docker_image", "packaged in"), "uvicorn serve.app:app in the Dockerfile");
	const ci = comp("tool:orchestration:GitHub_Actions");
	assert.equal(ci.data.runs, "data/ingest.py, src/train.py, src/evaluate.py", "python -m src.train and file paths in CI");
	assert.equal(ci.label, "GitHub Actions\nruns ingest.py, train.py, evaluate.py");
	// The lane order and the gap.
	assert.ok(has("stage:data", "stage:features") && has("stage:registry", "stage:deployment") && has("stage:deployment", "stage:monitoring"));
	assert.equal(comp("gap:monitoring").parent, "stage:monitoring");
	assert.match(r.summary, /6\/7 lifecycle stages with evidence.*gaps: monitoring/);
	assert.match(r.facts, /## Monitoring — NO EVIDENCE \(gap\)/);
	const xml = draws(g, "ml.lifecycle");
	assert.match(xml, /mapperKind="ml:lifecycle:gap"/);
	assert.match(lifecycleRecipe.agentPrompt({}, r), /red gap box/);
	// Layout: stages left to right.
	const { layoutGraph } = require("../src/main/mapper/layout");
	const boxes = layoutGraph(g).boxes;
	assert.ok(boxes.get("stage:data").x < boxes.get("stage:training").x && boxes.get("stage:training").x < boxes.get("stage:monitoring").x);
	assert.ok(boxes.get("stage:orchestration").y > boxes.get("stage:data").y, "cross-cutting orchestration sits below the lanes");
});

// ---------------------------------------------------------------- models

const BYTES = { F32: 4, F16: 2, BF16: 2, I64: 8 };
function writeSafetensors(file, tensors) {
	let offset = 0;
	const header = { __metadata__: { format: "pt" } };
	for (const t of tensors) {
		const size = t.shape.reduce((a, b) => a * b, 1) * BYTES[t.dtype];
		header[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + size] };
		offset += size;
	}
	let json = JSON.stringify(header);
	json += " ".repeat((8 - (json.length % 8)) % 8);
	const len = Buffer.alloc(8);
	len.writeBigUInt64LE(BigInt(json.length));
	fs.writeFileSync(file, Buffer.concat([len, Buffer.from(json), Buffer.alloc(offset)]));
}

function tinyLlamaTensors() {
	const t = [{ name: "model.embed_tokens.weight", shape: [100, 64], dtype: "BF16" }];
	for (let i = 0; i < 2; i++) {
		const L = `model.layers.${i}`;
		t.push(
			{ name: `${L}.self_attn.q_proj.weight`, shape: [64, 64], dtype: "BF16" },
			{ name: `${L}.self_attn.k_proj.weight`, shape: [32, 64], dtype: "BF16" },
			{ name: `${L}.self_attn.v_proj.weight`, shape: [32, 64], dtype: "BF16" },
			{ name: `${L}.self_attn.o_proj.weight`, shape: [64, 64], dtype: "BF16" },
			{ name: `${L}.mlp.gate_proj.weight`, shape: [128, 64], dtype: "BF16" },
			{ name: `${L}.mlp.up_proj.weight`, shape: [128, 64], dtype: "BF16" },
			{ name: `${L}.mlp.down_proj.weight`, shape: [64, 128], dtype: "BF16" },
			{ name: `${L}.input_layernorm.weight`, shape: [64], dtype: "BF16" },
			{ name: `${L}.post_attention_layernorm.weight`, shape: [64], dtype: "BF16" },
			{ name: `${L}.self_attn.rotary_emb.inv_freq`, shape: [8], dtype: "F32" } // a buffer, not a parameter
		);
	}
	t.push({ name: "model.norm.weight", shape: [64], dtype: "BF16" }, { name: "lm_head.weight", shape: [100, 64], dtype: "BF16" });
	return t;
}
// 6400 embedding + 2 × (12288 attention + 24576 MLP + 128 norms) + 64 final norm + 6400 head
const TINY_TOTAL = 86848;

test("model (HF folder): config.json + synthetic safetensors → block diagram with exact parameter counts", async () => {
	const dir = tmp("hf");
	fs.copyFileSync(path.join(FIX, "models/tiny-llama/config.json"), path.join(dir, "config.json"));
	writeSafetensors(path.join(dir, "model.safetensors"), tinyLlamaTensors());
	const r = await modelRecipe.collect({ folder: dir }, ctx(dir));
	const g = r.graph;
	assert.equal(g.direction, "down");
	assert.match(r.summary, /acme\/tiny-llama-test: decoder, 2 layers, 86\.8K params/);
	assert.match(g.legend[0], /86\.8K parameters — exact, from 21 tensor headers/);
	const node = (id) => g.nodes.find((n) => n.id === id);
	assert.equal(node("stack:block0").label, "Decoder block × 2  ·  37.0K params/layer");
	assert.equal(node("stack:block0").data.paramsPerLayer, "36992");
	const attn = node("stack:block0:attn");
	assert.equal(attn.label, "Self-attention (GQA 2:1)");
	assert.deepEqual(attn.rows.map((x) => x.text), ["4 query heads · 2 key/value heads", "head dim 16", "q 64→64 · k,v 64→32 · o 64→64", "RoPE θ=500,000 (llama3 ×8)", "causal mask", "12.3K params"]);
	assert.equal(node("stack:block0:mlp").label, "MLP (gated SwiGLU)");
	assert.equal(node("stack:block0:mlp").data.params, "24576");
	assert.deepEqual(node("head").rows.map((x) => x.text), ["64 → 100", "6.4K params"], "untied head");
	assert.equal(node("embed").rows[0].text, "100 × 64");
	// The flow: input → embedding → blocks → final norm → head → output.
	for (const [a, b] of [["in:tokens", "embed"], ["embed", "stack:block0"], ["stack:block0", "norm:final"], ["norm:final", "head"], ["head", "out"], ["stack:block0:norm1", "stack:block0:attn"], ["stack:block0:norm2", "stack:block0:mlp"]]) assert.ok(edge(g, a, b), `${a} → ${b}`);
	const facts = JSON.parse(r.facts);
	assert.equal(facts.parameters.total, TINY_TOTAL);
	assert.equal(facts.parameters.exact, true);
	draws(g, "ml.model");
	// Without weights: estimated from the config, and marked as such.
	const est = mapLocalModel(path.join(FIX, "models/tiny-llama"));
	assert.match(est.graph.legend[0], /≈ 86\.8K parameters — estimated from the config/, "estimate matches the exact count for a plain Llama");
});

function ggufBytes() {
	const parts = [];
	const u32 = (v) => {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(v);
		parts.push(b);
	};
	const u64 = (v) => {
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(BigInt(v));
		parts.push(b);
	};
	const f32 = (v) => {
		const b = Buffer.alloc(4);
		b.writeFloatLE(v);
		parts.push(b);
	};
	const str = (s) => {
		u64(Buffer.byteLength(s));
		parts.push(Buffer.from(s));
	};
	const kvs = [
		["general.architecture", 8, "llama"],
		["general.name", 8, "Tiny MoE"],
		["general.file_type", 4, 15],
		["llama.block_count", 4, 2],
		["llama.context_length", 4, 4096],
		["llama.embedding_length", 4, 64],
		["llama.feed_forward_length", 4, 128],
		["llama.attention.head_count", 4, 4],
		["llama.attention.head_count_kv", 4, 2],
		["llama.expert_count", 4, 4],
		["llama.expert_used_count", 4, 2],
		["llama.rope.freq_base", 6, 10000],
		["llama.attention.layer_norm_rms_epsilon", 6, 1e-5],
		["tokenizer.ggml.tokens", 9, Array.from({ length: 100 }, (_, i) => `tok${i}`)],
		["tokenizer.ggml.scores", 9, Array.from({ length: 100 }, () => 0)],
	];
	const tensors = [["token_embd.weight", [64, 100], 1]];
	for (let i = 0; i < 2; i++) {
		tensors.push(
			[`blk.${i}.attn_norm.weight`, [64], 0],
			[`blk.${i}.attn_q.weight`, [64, 64], 12],
			[`blk.${i}.attn_k.weight`, [64, 32], 12],
			[`blk.${i}.attn_v.weight`, [64, 32], 12],
			[`blk.${i}.attn_output.weight`, [64, 64], 12],
			[`blk.${i}.ffn_norm.weight`, [64], 0],
			[`blk.${i}.ffn_gate_inp.weight`, [64, 4], 0],
			[`blk.${i}.ffn_gate_exps.weight`, [64, 128, 4], 12],
			[`blk.${i}.ffn_up_exps.weight`, [64, 128, 4], 12],
			[`blk.${i}.ffn_down_exps.weight`, [128, 64, 4], 14]
		);
	}
	tensors.push(["output_norm.weight", [64], 0], ["output.weight", [64, 100], 14]);
	parts.push(Buffer.from("GGUF"));
	u32(3);
	u64(tensors.length);
	u64(kvs.length);
	for (const [k, type, v] of kvs) {
		str(k);
		u32(type);
		if (type === 8) str(v);
		else if (type === 4) u32(v);
		else if (type === 6) f32(v);
		else if (type === 9) {
			const strings = typeof v[0] === "string";
			u32(strings ? 8 : 6);
			u64(v.length);
			for (const x of v) strings ? str(x) : f32(x);
		}
	}
	for (const [name, dims, type] of tensors) {
		str(name);
		u32(dims.length);
		for (const d of dims) u64(d);
		u32(type);
		u64(0);
	}
	return Buffer.concat(parts);
}

test("model (GGUF): header metadata, MoE experts and router, quantization, exact counts from tensor infos", async () => {
	const dir = tmp("gguf");
	const file = path.join(dir, "tiny-moe.Q4_K_M.gguf");
	fs.writeFileSync(file, ggufBytes());
	const r = await modelRecipe.collect({ file }, ctx(dir));
	const g = r.graph;
	const node = (id) => g.nodes.find((n) => n.id === id);
	assert.match(r.summary, /Tiny MoE: decoder, 2 layers, 234\.8K params, MoE 4 experts \(top-2\)/);
	assert.match(g.legend[1], /Q4_K_M/);
	assert.match(g.legend[0], /234\.8K parameters, ≈ 136\.5K active per token — exact/);
	assert.equal(node("stack:block0").label, "Decoder block (MoE) × 2  ·  111.0K params/layer");
	assert.equal(node("stack:block0:router").label, "Router\ntop-2 of 4");
	assert.equal(node("stack:block0:experts").data.params, "98304");
	assert.equal(node("stack:block0:attn").label, "Self-attention (GQA 2:1)");
	assert.equal(node("embed").rows[0].text, "100 × 64", "vocabulary size from the (skipped) token array");
	assert.ok(edge(g, "stack:block0:router", "stack:block0:experts"));
	const facts = JSON.parse(r.facts);
	assert.equal(facts.parameters.total, 234816);
	assert.equal(facts.config.metadata["tokenizer.ggml.tokens"], "[100 values]");
	draws(g, "ml.model");
});

// A minimal protobuf encoder for ONNX test models.
const pb = {
	varint(n) {
		const out = [];
		do {
			let b = n % 128;
			n = Math.floor(n / 128);
			if (n > 0) b |= 0x80;
			out.push(b);
		} while (n > 0);
		return Buffer.from(out);
	},
	key: (field, wt) => pb.varint(field * 8 + wt),
	int: (field, v) => Buffer.concat([pb.key(field, 0), pb.varint(v)]),
	bytes: (field, b) => Buffer.concat([pb.key(field, 2), pb.varint(b.length), b]),
	str: (field, s) => pb.bytes(field, Buffer.from(s)),
	msg: (field, ...parts) => pb.bytes(field, Buffer.concat(parts)),
};
const onnxNode = (op, name, inputs, outputs) => pb.msg(1, ...inputs.map((i) => pb.str(1, i)), ...outputs.map((o) => pb.str(2, o)), pb.str(3, name), pb.str(4, op));
const onnxInit = (name, dims) => pb.msg(5, ...dims.map((d) => pb.int(1, d)), pb.int(2, 1), pb.str(8, name), pb.bytes(9, Buffer.alloc(dims.reduce((a, b) => a * b, 1) * 4)));
const onnxValue = (field, name, dims) =>
	pb.msg(field, pb.str(1, name), pb.msg(2, pb.msg(1, pb.int(1, 1), pb.msg(2, ...dims.map((d) => (typeof d === "number" ? pb.msg(1, pb.int(1, d)) : pb.msg(1, pb.str(2, d))))))));
const onnxModel = (graphParts) => Buffer.concat([pb.int(1, 8), pb.str(2, "pytorch"), pb.str(3, "2.3.0"), pb.msg(7, ...graphParts), pb.msg(8, pb.str(1, ""), pb.int(2, 17))]);

test("model (ONNX): ops, weights and graph I/O from a hand-encoded protobuf; weight bytes are skipped", async () => {
	const dir = tmp("onnx");
	const file = path.join(dir, "mlp.onnx");
	fs.writeFileSync(
		file,
		onnxModel([
			onnxNode("MatMul", "/fc1/MatMul", ["x", "W1"], ["h"]),
			onnxNode("Add", "/fc1/Add", ["h", "B1"], ["h2"]),
			onnxNode("Relu", "/act/Relu", ["h2"], ["h3"]),
			onnxNode("MatMul", "/fc2/MatMul", ["h3", "W2"], ["y"]),
			pb.str(2, "tiny_mlp"),
			onnxInit("W1", [4, 8]),
			onnxInit("B1", [8]),
			onnxInit("W2", [8, 2]),
			onnxValue(11, "x", ["batch", 4]),
			onnxValue(11, "W1", [4, 8]), // initializers listed as inputs (old exporters) are not graph inputs
			onnxValue(12, "y", ["batch", 2]),
		])
	);
	const src = ByteSource.file(file);
	const m = parseOnnx(src);
	src.close();
	assert.equal(m.producer, "pytorch");
	assert.deepEqual(m.opsets, [{ domain: "", version: 17 }]);
	assert.deepEqual(m.initializers.map((t) => [t.name, t.shape, t.dtype]), [["W1", [4, 8], "float32"], ["B1", [8], "float32"], ["W2", [8, 2], "float32"]]);
	assert.deepEqual(m.inputs[0], { name: "x", elemType: 1, shape: ["batch", 4] });
	const r = await modelRecipe.collect({ file }, ctx(dir));
	const g = r.graph;
	assert.match(r.summary, /4 ops, 56 params/);
	assert.deepEqual(g.nodes.filter((n) => n.kind === "ml:onnx:node").map((n) => n.label).sort(), ["Add", "MatMul", "MatMul", "Relu"]);
	assert.ok(g.nodes.some((n) => n.label === "x [batch, 4] float32"));
	assert.ok(!g.nodes.some((n) => n.label.startsWith("W1 [")), "initializer inputs are weights, not inputs");
	assert.equal(g.edges.length, 5, "x → MatMul → Add → Relu → MatMul → y");
	draws(g, "ml.model");
});

test("model (ONNX, large): ops grouped by name scope, repeated layers collapsed to × N", () => {
	const nodes = [onnxNode("Gather", "/model/embed_tokens/Gather", ["ids", "E"], ["t0"])];
	let prev = "t0";
	const inits = [onnxInit("E", [50, 8])];
	for (let i = 0; i < 10; i++) {
		const L = `/model/layers.${i}`;
		const ops = [
			["MatMul", `${L}/self_attn/q_proj/MatMul`, `Wq${i}`],
			["MatMul", `${L}/self_attn/k_proj/MatMul`, `Wk${i}`],
			["Softmax", `${L}/self_attn/Softmax`],
			["MatMul", `${L}/self_attn/o_proj/MatMul`, `Wo${i}`],
			["Add", `${L}/Add`],
			["MatMul", `${L}/mlp/up_proj/MatMul`, `Wu${i}`],
			["Relu", `${L}/mlp/act_fn/Relu`],
			["MatMul", `${L}/mlp/down_proj/MatMul`, `Wd${i}`],
		];
		ops.forEach(([op, name, w], k) => {
			const out = `l${i}_${k}`;
			nodes.push(onnxNode(op, name, w ? [prev, w] : [prev], [out]));
			if (w) inits.push(onnxInit(w, [8, 8]));
			prev = out;
		});
	}
	nodes.push(onnxNode("MatMul", "/lm_head/MatMul", [prev, "H"], ["logits"]));
	inits.push(onnxInit("H", [8, 50]));
	const dir = tmp("onnx-big");
	const file = path.join(dir, "big.onnx");
	fs.writeFileSync(file, onnxModel([...nodes, ...inits, onnxValue(11, "ids", ["batch", "seq"]), onnxValue(12, "logits", ["batch", "seq", 50])]));
	const src = ByteSource.file(file);
	const m = parseOnnx(src);
	src.close();
	assert.equal(m.nodes.length, 82);
	const g = onnxToGraph(m, "big.onnx");
	const q = g.nodes.find((n) => n.label === "model/layers/N/self_attn/q_proj × 10");
	assert.ok(q, g.nodes.map((n) => n.label).join(" | "));
	assert.ok(q.rows.some((r) => r.text === "MatMul × 1"));
	assert.ok(q.rows.some((r) => r.text === "64 params per repeat"));
	assert.ok(g.nodes.length < 20, `grouped: ${g.nodes.length} shapes for 82 ops`);
	assert.match(g.legend[0], /82 ops, 52 weight tensors, 4\.0K parameters/);
	draws(g, "ml.model");
});

test("model (trees): XGBoost JSON and LightGBM text", async () => {
	const x = mapLocalModel(path.join(FIX, "models/trees/xgb-model.json"));
	assert.match(x.summary, /XGBoost xgb-model\.json: 3 trees, 4 features/);
	const ens = x.graph.nodes.find((n) => n.id === "ensemble");
	assert.deepEqual(ens.rows.map((r) => r.text), ["3 trees", "max depth 2", "≈ 4 nodes per tree", "base score 5E-1"]);
	assert.equal(x.graph.nodes.find((n) => n.id === "out").label, "Probability");
	draws(x.graph, "ml.model");
	const l = mapLocalModel(path.join(FIX, "models/trees/model.txt"));
	assert.match(l.summary, /LightGBM model\.txt: 2 trees, 3 features/);
	assert.deepEqual(l.graph.nodes.find((n) => n.id === "in:features").rows.map((r) => r.text), ["sqft", "bedrooms", "age"]);
	assert.ok(l.graph.nodes.find((n) => n.id === "ensemble").rows.some((r) => r.text === "≈ 4 leaves per tree"));
	draws(l.graph, "ml.model");
});

test("model: pickles are never opened; ids are validated; module names are classified", () => {
	const dir = tmp("pickle");
	fs.writeFileSync(path.join(dir, "model.pkl"), "not really a pickle");
	assert.throws(() => mapLocalModel(dir), (e) => /No model file/.test(e.message) && /can run code/.test(e.hint));
	assert.equal(normalizeHfId("https://huggingface.co/Qwen/Qwen2.5-0.5B/tree/main"), "Qwen/Qwen2.5-0.5B");
	for (const bad of ["../etc/passwd", "a/b/c", "http://evil.example/x", "Qwen/../x"]) assert.throws(() => normalizeHfId(bad), /not a Hugging Face model id/);
	const cases = {
		"self_attn.q_proj.weight": "attention",
		"post_attention_layernorm.weight": "norm",
		"attn_norm.weight": "norm",
		"mlp.c_proj.weight": "mlp",
		"attn.c_proj.weight": "attention",
		"block_sparse_moe.experts.3.w1.weight": "experts",
		"block_sparse_moe.gate.weight": "router",
		"mlp.shared_expert.up_proj.weight": "shared",
		"ffn_gate_exps.weight": "experts",
		"ffn_gate_inp.weight": "router",
		"layer.1.DenseReluDense.wo.weight": "mlp",
		"layer.0.SelfAttention.o.weight": "attention",
		"layer.1.EncDecAttention.q.weight": "cross",
		"attention.output.dense.weight": "attention",
		"intermediate.dense.weight": "mlp",
	};
	for (const [name, mod] of Object.entries(cases)) assert.equal(moduleOf(name), mod, name);
});

function hubServer() {
	const dir = tmp("hub");
	writeSafetensors(path.join(dir, "model.safetensors"), tinyLlamaTensors());
	const weights = fs.readFileSync(path.join(dir, "model.safetensors"));
	const seen = { ranges: [], fullDownloads: 0, auth: new Set() };
	const server = http.createServer((req, res) => {
		seen.auth.add(req.headers.authorization);
		const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
		if (p.startsWith("/acme/gated/")) {
			res.writeHead(401);
			return res.end("{}");
		}
		if (p === "/acme/tiny/resolve/main/config.json") {
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(fs.readFileSync(path.join(FIX, "models/tiny-llama/config.json")));
		}
		if (p === "/acme/tiny/resolve/main/model.safetensors") {
			const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
			if (!m) {
				seen.fullDownloads++;
				res.writeHead(200, { "Content-Length": weights.length });
				return res.end(weights);
			}
			seen.ranges.push(req.headers.range);
			const chunk = weights.subarray(Number(m[1]), Number(m[2]) + 1);
			res.writeHead(206, { "Content-Length": chunk.length, "Content-Range": `bytes ${m[1]}-${m[2]}/${weights.length}` });
			return res.end(chunk);
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test("model (Hub, mocked): config.json and safetensors headers via range requests only; gated models need a token", async () => {
	const { server, seen, base } = await hubServer();
	try {
		const r = await mapHubModel("acme/tiny", { base, token: "hf_secret" });
		assert.equal(r.facts.parameters.total, TINY_TOTAL);
		assert.match(r.graph.legend[2], /huggingface\.co\/acme\/tiny config\.json \+ safetensors headers/);
		assert.equal(seen.fullDownloads, 0, "weights are never downloaded");
		assert.equal(seen.ranges[0], "bytes=0-7");
		assert.equal(seen.ranges.length, 2);
		assert.deepEqual([...seen.auth], ["Bearer hf_secret"]);
		assert.ok(!JSON.stringify(r).includes("hf_secret"));
		await assert.rejects(mapHubModel("acme/gated", { base }), (e) => /gated or private/.test(e.message) && /token/.test(e.hint));
		await assert.rejects(mapHubModel("acme/missing", { base }), /has no config\.json/);
	} finally {
		server.close();
	}
});

test("model (Hub, real): Qwen/Qwen2.5-0.5B config.json + safetensors header (skipped offline)", async (t) => {
	const online = await fetch("https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B", { signal: AbortSignal.timeout(5000) })
		.then((r) => r.ok)
		.catch(() => false);
	if (!online) return t.skip("huggingface.co is not reachable");
	const r = await modelRecipe.collect({ hfModel: "Qwen/Qwen2.5-0.5B" }, ctx());
	const facts = JSON.parse(r.facts);
	assert.equal(facts.parameters.total, 494032768, "Qwen2.5-0.5B has 494,032,768 parameters");
	const g = r.graph;
	assert.equal(g.nodes.find((n) => n.id === "stack:block0").label.split("  ·  ")[0], "Decoder block × 24");
	assert.equal(g.nodes.find((n) => n.id === "stack:block0:attn").label, "Self-attention (GQA 7:1)");
	assert.deepEqual(g.nodes.find((n) => n.id === "head").rows.map((x) => x.text), ["896 → 151,936", "tied to the token embedding"]);
	draws(g, "ml.model");
});

// ---------------------------------------------------------------- catalog

test("catalog: the four ML recipes, secrets marked, prompts and dig-deeper present", () => {
	assert.deepEqual(mlRecipes.map((r) => r.id), ["ml.pipeline", "ml.mlflow", "ml.lifecycle", "ml.model"]);
	const c = catalog();
	for (const id of ["ml.pipeline", "ml.mlflow", "ml.lifecycle", "ml.model"]) {
		const r = c.recipes.find((x) => x.id === id);
		assert.equal(r.category, "ml");
		assert.ok(r.canAskAgent);
	}
	for (const r of mlRecipes) {
		assert.equal(typeof r.digDeeper, "function");
		for (const f of r.fields.filter((f) => f.type === "password")) assert.equal(f.secret, true, `${r.id}.${f.id}`);
	}
});
