/**
 * The end-to-end ML lifecycle of a repository: evidence per stage (data,
 * features, training, evaluation, registry, packaging & serving, monitoring,
 * plus experiment tracking and orchestration / CI/CD), found by reading the
 * code and config files, drawn as stage lanes left to right. The skeleton is
 * deterministic; the agent completes connections and confirms gaps.
 */
import * as path from "path";
import { agentRequest, digDeeperRequest, FOLDER_FIELD, folderInput, readFiles, slug } from "../common";
import type { MapEdge, MapGraph, MapNode, Recipe } from "../../types";
import { ML_STYLES, stripPyComments } from "./shared";

export type StageId = "data" | "features" | "training" | "evaluation" | "registry" | "deployment" | "monitoring" | "tracking" | "orchestration";

export const STAGES: { id: StageId; title: string; fill: string; stroke: string; main: boolean }[] = [
	{ id: "data", title: "Data sources & ingestion", fill: "#f1f8ee", stroke: "#82b366", main: true },
	{ id: "features", title: "Features", fill: "#eef8f8", stroke: "#3c9a9a", main: true },
	{ id: "training", title: "Training", fill: "#f6f0f8", stroke: "#9673a6", main: true },
	{ id: "evaluation", title: "Evaluation", fill: "#fffaeb", stroke: "#d6b656", main: true },
	{ id: "registry", title: "Model registry", fill: "#fdf2f2", stroke: "#b85450", main: true },
	{ id: "deployment", title: "Packaging & serving", fill: "#eef4fc", stroke: "#6c8ebf", main: true },
	{ id: "monitoring", title: "Monitoring", fill: "#fff5eb", stroke: "#d79b00", main: true },
	{ id: "tracking", title: "Experiment tracking", fill: "#f7f7f7", stroke: "#666666", main: false },
	{ id: "orchestration", title: "Orchestration & CI/CD", fill: "#f7f7f7", stroke: "#555555", main: false },
];
const STAGE = new Map(STAGES.map((s) => [s.id, s]));

interface ToolDef {
	tool: string;
	stage: StageId;
	/** Matches the file's path. */
	file?: RegExp;
	/** Matches the file's content. */
	text?: RegExp;
	/** Only Python (and notebook) files. */
	py?: boolean;
	/** Edge between code using the tool and the tool: "in" tool → code, "out" code → tool. */
	dir?: "in" | "out";
	verb?: string;
	/** Scan the tool's own files for the code files they run or package. */
	mentions?: "runs" | "packages";
	/** Needs both the path and the content to match (otherwise either does). */
	both?: boolean;
}

const SQL_DB = /create_engine\(|psycopg2?\.connect|pymysql\.connect|pd\.read_sql|read_sql_query|sqlalchemy\.create_engine/;

export const TOOLS: ToolDef[] = [
	// Data sources
	{ tool: "DVC-tracked data", stage: "data", file: /\.dvc$/, dir: "in", verb: "reads" },
	{ tool: "Amazon S3", stage: "data", py: true, text: /s3:\/\/|boto3\.(client|resource)\(\s*['"]s3['"]|\bs3fs\b/, dir: "in", verb: "reads" },
	{ tool: "Google Cloud Storage", stage: "data", py: true, text: /gs:\/\/|from google\.cloud import storage|gcsfs/, dir: "in", verb: "reads" },
	{ tool: "Azure Blob / ADLS", stage: "data", py: true, text: /abfss?:\/\/|azure\.storage\.blob|adlfs/, dir: "in", verb: "reads" },
	{ tool: "BigQuery", stage: "data", py: true, text: /bigquery\.Client\(|from google\.cloud import bigquery|pandas_gbq|read_gbq\(/, dir: "in", verb: "reads" },
	{ tool: "Snowflake", stage: "data", py: true, text: /snowflake\.connector|snowflake\.snowpark/, dir: "in", verb: "reads" },
	{ tool: "SQL database", stage: "data", py: true, text: SQL_DB, dir: "in", verb: "reads" },
	{ tool: "Kafka", stage: "data", py: true, text: /KafkaConsumer|confluent_kafka|aiokafka/, dir: "in", verb: "consumes" },
	{ tool: "Spark", stage: "data", py: true, text: /SparkSession|spark\.read\.|pyspark\.sql/, dir: "in", verb: "reads" },
	{ tool: "Hugging Face Datasets", stage: "data", py: true, text: /\bload_dataset\(|from datasets import/, dir: "in", verb: "loads" },
	{ tool: "Great Expectations", stage: "data", file: /(^|\/)great_expectations\.ya?ml$/, text: /\bimport great_expectations\b|\bgreat_expectations checkpoint\b/, dir: "out", verb: "validates" },
	{ tool: "dbt", stage: "data", file: /(^|\/)dbt_project\.ya?ml$/ },
	// Features
	{ tool: "Feast feature store", stage: "features", file: /(^|\/)feature_store\.ya?ml$/, text: /\bfrom feast\b|\bimport feast\b/, dir: "in", verb: "features" },
	{ tool: "Tecton", stage: "features", py: true, text: /\bimport tecton\b|\bfrom tecton\b/, dir: "in", verb: "features" },
	{ tool: "Hopsworks feature store", stage: "features", py: true, text: /\bimport hopsworks\b|\bhsfs\b/, dir: "in", verb: "features" },
	{ tool: "Databricks feature store", stage: "features", py: true, text: /FeatureStoreClient|FeatureEngineeringClient/, dir: "in", verb: "features" },
	{ tool: "SageMaker Feature Store", stage: "features", py: true, text: /sagemaker\.feature_store|FeatureGroup\(/, dir: "in", verb: "features" },
	{ tool: "Vertex AI Feature Store", stage: "features", py: true, text: /aiplatform\.(Featurestore|FeatureOnlineStore|FeatureView)/, dir: "in", verb: "features" },
	// Training configuration and managed training
	{ tool: "Hydra config", stage: "training", file: /(^|\/)conf(ig)?s?\/[^/]+\.ya?ml$/, text: /^defaults:\s*$/m, both: true },
	{ tool: "Hydra config", stage: "training", py: true, text: /@hydra\.main/, dir: "in", verb: "configures" },
	{ tool: "DeepSpeed / Accelerate config", stage: "training", file: /(ds_config|deepspeed|accelerate_config|fsdp)[^/]*\.(json|ya?ml)$/i },
	{ tool: "SageMaker training job", stage: "training", py: true, text: /sagemaker\.estimator|from sagemaker\.(pytorch|tensorflow|sklearn|huggingface|xgboost)\b|\bEstimator\(/, dir: "out", verb: "launches" },
	{ tool: "Vertex AI training", stage: "training", py: true, text: /aiplatform\.(CustomTrainingJob|CustomJob|CustomContainerTrainingJob|HyperparameterTuningJob)/, dir: "out", verb: "launches" },
	{ tool: "Azure ML job", stage: "training", text: /commandJob\.schema\.json|sweepJob\.schema\.json|azure\.ai\.ml\b[\s\S]*\bcommand\(/, dir: "out", verb: "launches" },
	// Experiment tracking
	{ tool: "MLflow tracking", stage: "tracking", py: true, text: /mlflow\.(log_|start_run|autolog|set_experiment|set_tracking_uri|\w+\.autolog)/, dir: "out", verb: "logs" },
	{ tool: "MLflow tracking", stage: "tracking", file: /(^|\/)MLproject$/ },
	{ tool: "Weights & Biases", stage: "tracking", py: true, text: /\bimport wandb\b|wandb\.init\(|WandbLogger/, dir: "out", verb: "logs" },
	{ tool: "Comet", stage: "tracking", py: true, text: /\bcomet_ml\b|CometLogger/, dir: "out", verb: "logs" },
	{ tool: "Neptune", stage: "tracking", py: true, text: /\bimport neptune\b|NeptuneLogger/, dir: "out", verb: "logs" },
	{ tool: "ClearML", stage: "tracking", py: true, text: /\bfrom clearml\b|\bimport clearml\b/, dir: "out", verb: "logs" },
	{ tool: "TensorBoard", stage: "tracking", py: true, text: /SummaryWriter\(|TensorBoardLogger|callbacks\.TensorBoard/, dir: "out", verb: "logs" },
	{ tool: "DVCLive", stage: "tracking", py: true, text: /\bfrom dvclive\b|\bimport dvclive\b/, dir: "out", verb: "logs" },
	{ tool: "Aim", stage: "tracking", py: true, text: /\bfrom aim import\b/, dir: "out", verb: "logs" },
	// Evaluation tools
	{ tool: "Deepchecks", stage: "evaluation", py: true, text: /\bdeepchecks\b/, dir: "out", verb: "checks" },
	{ tool: "lm-evaluation-harness", stage: "evaluation", py: true, text: /\blm_eval\b/, dir: "out", verb: "benchmarks" },
	// Registry
	{ tool: "MLflow Model Registry", stage: "registry", py: true, text: /register_model\(|registered_model_name\s*=|transition_model_version_stage|set_registered_model_alias|create_model_version\(/, dir: "out", verb: "registers" },
	{ tool: "MLflow Model Registry", stage: "registry", py: true, text: /['"]models:\/[^'"]+['"]/, dir: "in", verb: "loads" },
	{ tool: "SageMaker Model Registry", stage: "registry", py: true, text: /ModelPackageGroupName|RegisterModel\(|\.register\([^)]*model_package_group_name/, dir: "out", verb: "registers" },
	{ tool: "Vertex AI Model Registry", stage: "registry", py: true, text: /aiplatform\.Model\.upload\(|Model\.upload\(/, dir: "out", verb: "registers" },
	{ tool: "Azure ML model registry", stage: "registry", py: true, text: /ml_client\.models\.create_or_update|ml_client\.models\.get/, dir: "out", verb: "registers" },
	{ tool: "Hugging Face Hub", stage: "registry", py: true, text: /push_to_hub\(|HfApi\(\)\.upload|upload_folder\(/, dir: "out", verb: "pushes" },
	{ tool: "Hugging Face Hub", stage: "registry", py: true, text: /\.from_pretrained\(\s*['"][\w.-]+\/[\w.-]+['"]|hf_hub_download\(/, dir: "in", verb: "pulls" },
	{ tool: "W&B model registry", stage: "registry", py: true, text: /link_model\(|log_artifact\([^)]*type\s*=\s*['"]model['"]/, dir: "out", verb: "registers" },
	// Packaging
	{ tool: "Docker image", stage: "deployment", file: /(^|\/)(Dockerfile|Containerfile)([.-][^/]*)?$/, mentions: "packages" },
	{ tool: "MLflow model package", stage: "deployment", file: /(^|\/)MLmodel$/ },
	{ tool: "BentoML", stage: "deployment", file: /(^|\/)bentofile\.ya?ml$/, text: /\bimport bentoml\b|@bentoml\.service/, dir: "out", verb: "serves" },
	{ tool: "Cog", stage: "deployment", file: /(^|\/)cog\.ya?ml$/ },
	{ tool: "TorchServe", stage: "deployment", text: /torch-model-archiver|torchserve\b|BaseHandler\)/, dir: "out", verb: "serves" },
	{ tool: "Triton Inference Server", stage: "deployment", file: /(^|\/)config\.pbtxt$/, text: /tritonclient/, dir: "out", verb: "calls" },
	{ tool: "ONNX export", stage: "deployment", py: true, text: /torch\.onnx\.export|tf2onnx|skl2onnx|convert_sklearn\(/, dir: "out", verb: "exports" },
	// Serving
	{ tool: "KServe InferenceService", stage: "deployment", text: /kind:\s*InferenceService\b/ },
	{ tool: "Seldon Core", stage: "deployment", text: /kind:\s*SeldonDeployment\b|apiVersion:\s*mlops\.seldon\.io/ },
	{ tool: "SageMaker endpoint", stage: "deployment", text: /AWS::SageMaker::Endpoint\b|aws_sagemaker_endpoint\b|create_endpoint\(|\.deploy\([^)]*instance_type/, dir: "out", verb: "deploys" },
	{ tool: "Vertex AI endpoint", stage: "deployment", text: /google_vertex_ai_endpoint\b|aiplatform\.Endpoint\b|endpoint\.deploy\(/, dir: "out", verb: "deploys" },
	{ tool: "Azure ML online endpoint", stage: "deployment", text: /managedOnline(Endpoint|Deployment)\.schema\.json|kubernetesOnline(Endpoint|Deployment)\.schema\.json|ManagedOnlineEndpoint\(/, dir: "out", verb: "deploys" },
	{ tool: "Ray Serve", stage: "deployment", py: true, text: /@serve\.deployment|from ray import serve/, dir: "out", verb: "serves" },
	{ tool: "vLLM / TGI", stage: "deployment", text: /\bvllm\b|text-generation-inference/, dir: "out", verb: "serves" },
	{ tool: "Kubernetes deployment", stage: "deployment", file: /\.ya?ml$/, text: /^kind:\s*Deployment\s*$/m, both: true },
	// Monitoring
	{ tool: "Evidently", stage: "monitoring", py: true, text: /\bfrom evidently\b|\bimport evidently\b/, dir: "out", verb: "monitors" },
	{ tool: "whylogs / WhyLabs", stage: "monitoring", py: true, text: /\bwhylogs\b|\bwhylabs\b/, dir: "out", verb: "monitors" },
	{ tool: "Prometheus metrics", stage: "monitoring", file: /(^|\/)prometheus\.ya?ml$/, text: /\bprometheus_client\b|prometheus_fastapi_instrumentator/, dir: "out", verb: "exports" },
	{ tool: "Grafana dashboards", stage: "monitoring", file: /grafana[^/]*\/.*\.json$|dashboards?\/[^/]+\.json$/i },
	{ tool: "NannyML", stage: "monitoring", py: true, text: /\bnannyml\b/, dir: "out", verb: "monitors" },
	{ tool: "Alibi Detect", stage: "monitoring", py: true, text: /\balibi_detect\b/, dir: "out", verb: "monitors" },
	{ tool: "Arize / Fiddler", stage: "monitoring", py: true, text: /\barize\b|\bfiddler\b/, dir: "out", verb: "monitors" },
	{ tool: "SageMaker Model Monitor", stage: "monitoring", text: /DefaultModelMonitor|ModelQualityMonitor|DataCaptureConfig/, dir: "out", verb: "monitors" },
	{ tool: "Vertex AI model monitoring", stage: "monitoring", py: true, text: /ModelDeploymentMonitoringJob/, dir: "out", verb: "monitors" },
	// Orchestration
	{ tool: "DVC pipeline", stage: "orchestration", file: /(^|\/)dvc\.ya?ml$/, mentions: "runs" },
	{ tool: "Airflow", stage: "orchestration", py: true, text: /\bfrom airflow\b|\bimport airflow\b/, mentions: "runs" },
	{ tool: "Kubeflow Pipelines", stage: "orchestration", text: /\bfrom kfp\b|\bimport kfp\b|pipelineInfo:[\s\S]*root:\s*\n\s+dag:/, mentions: "runs" },
	{ tool: "Prefect", stage: "orchestration", py: true, text: /\bfrom prefect\b/, mentions: "runs" },
	{ tool: "Dagster", stage: "orchestration", py: true, text: /\bfrom dagster\b/, mentions: "runs" },
	{ tool: "Metaflow", stage: "orchestration", py: true, text: /\bFlowSpec\b/, mentions: "runs" },
	{ tool: "ZenML", stage: "orchestration", py: true, text: /\bfrom zenml\b/, mentions: "runs" },
	{ tool: "Kedro", stage: "orchestration", file: /(^|\/)conf\/base\/catalog\.ya?ml$/, text: /\bfrom kedro\b/, mentions: "runs" },
	{ tool: "Flyte", stage: "orchestration", py: true, text: /\bfrom flytekit\b/, mentions: "runs" },
	{ tool: "Argo Workflows", stage: "orchestration", text: /^kind:\s*(Cluster)?Workflow(Template)?\s*$/m, mentions: "runs" },
	{ tool: "SageMaker Pipelines", stage: "orchestration", text: /sagemaker\.workflow\.pipeline\b|"Steps"\s*:\s*\[\s*\{\s*"Name"/, mentions: "runs" },
	{ tool: "Azure ML pipelines", stage: "orchestration", text: /pipelineJob\.schema\.json|azure\.ai\.ml\.dsl/, mentions: "runs" },
	{ tool: "Vertex AI Pipelines", stage: "orchestration", py: true, text: /aiplatform\.PipelineJob/, mentions: "runs" },
	{ tool: "Makefile targets", stage: "orchestration", file: /(^|\/)Makefile$/, text: /^(train|evaluate|deploy|serve|features|data)\s*:/m, mentions: "runs" },
	// CI/CD
	{ tool: "GitHub Actions", stage: "orchestration", file: /^\.github\/workflows\/[^/]+\.ya?ml$/, mentions: "runs" },
	{ tool: "GitLab CI", stage: "orchestration", file: /(^|\/)\.gitlab-ci\.ya?ml$/, mentions: "runs" },
	{ tool: "Jenkins", stage: "orchestration", file: /(^|\/)Jenkinsfile$/, mentions: "runs" },
	{ tool: "Azure Pipelines", stage: "orchestration", file: /(^|\/)azure-pipelines[^/]*\.ya?ml$/, mentions: "runs" },
	{ tool: "CircleCI", stage: "orchestration", file: /^\.circleci\/config\.ya?ml$/, mentions: "runs" },
	{ tool: "CML", stage: "orchestration", text: /iterative\/setup-cml|\bcml (comment|send-comment|runner)\b/ },
];

/** Signals that a code file belongs to a stage: its name, and what it calls. */
const CODE_SIGNALS: Record<Exclude<StageId, "tracking" | "orchestration">, { name: RegExp; text: RegExp[] }> = {
	data: {
		name: /(^|[\/_.-])(ingest\w*|etl|extract\w*|load_data|download\w*|fetch\w*|data_?prep\w*|prepare\w*|preprocess\w*|clean\w*|make_dataset|dataset\w*|collect\w*|scrape\w*|data)([\/_.-]|$)/i,
		text: [/pd\.read_(csv|parquet|json|excel|sql|table)\(/, SQL_DB, /spark\.read\./, /\bload_dataset\(/, /boto3|download_file\(|requests\.get\(/, /\.to_(csv|parquet|feather)\(/, /train_test_split\(/, /great_expectations|pandera/],
	},
	features: {
		name: /(^|[\/_.-])(features?|featur\w*|feature_engineering|transform\w*|encod\w*|vectori[sz]\w*)([\/_.-]|$)/i,
		text: [/ColumnTransformer|OneHotEncoder|StandardScaler|MinMaxScaler|LabelEncoder|PolynomialFeatures/, /TfidfVectorizer|CountVectorizer|HashingVectorizer/, /FeatureView\(|Entity\(|get_historical_features|get_online_features/, /feature_engineering|build_features|make_features/],
	},
	training: {
		name: /(^|[\/_.-])(train\w*|fit\w*|finetun\w*|fine_tun\w*|pretrain\w*|sweep\w*|tun(e|ing)\w*|hpo)([\/_.-]|$)/i,
		text: [/\.fit\(/, /trainer\.train\(|\bTrainer\(|SFTTrainer|Seq2SeqTrainer/, /optimizer\.step\(|loss\.backward\(|accelerator\.backward/, /xgb\.train\(|lgb\.train\(|CatBoost(Classifier|Regressor)\(/, /model\.compile\(|GridSearchCV|RandomizedSearchCV|optuna\.create_study/, /pl\.Trainer\(|lightning\.(pytorch\.)?Trainer\(/],
	},
	evaluation: {
		name: /(^|[\/_.-])(eval\w*|validat\w*|metrics?|benchmark\w*|scor(e|ing)|test_model|backtest\w*)([\/_.-]|$)/i,
		text: [/sklearn\.metrics|classification_report|confusion_matrix/, /roc_auc_score|f1_score|accuracy_score|mean_squared_error|mean_absolute_error|r2_score|precision_recall/, /evaluate\.load\(|mlflow\.evaluate\(|\blm_eval\b|deepchecks/, /model\.evaluate\(|trainer\.evaluate\(/],
	},
	registry: {
		name: /(^|[\/_.-])(regist\w*|promot\w*|publish\w*|release\w*)([\/_.-]|$)/i,
		text: [/register_model\(|registered_model_name\s*=|transition_model_version_stage|set_registered_model_alias/, /push_to_hub\(|ModelPackageGroupName|Model\.upload\(|ml_client\.models\.create_or_update|link_model\(/],
	},
	deployment: {
		name: /(^|[\/_.-])(serv(e|er|ing)\w*|app|api|predict\w*|infer\w*|handler|endpoint\w*|deploy\w*|main)([\/_.-]|$)/i,
		text: [/FastAPI\(|Flask\(__name__\)|@app\.(get|post|route)\(|@router\.(get|post)\(/, /\bgradio\b|\bstreamlit\b|bentoml|@serve\.deployment/, /\.deploy\(|InferenceSession\(|tritonclient|kserve/, /pyfunc\.load_model\(|joblib\.load\(|torch\.load\(|load_model\(|from_pretrained\(/, /def\s+(predict|inference|init|run)\s*\(/],
	},
	monitoring: {
		name: /(^|[\/_.-])(monitor\w*|drift\w*|alert\w*|observ\w*|dashboard\w*)([\/_.-]|$)/i,
		text: [/evidently|whylogs|nannyml|alibi_detect|arize|fiddler/, /DataDriftPreset|DataDriftTable|ks_2samp|population_stability|\bpsi\b/, /prometheus_client|Histogram\(|Gauge\(/],
	},
};

const FRAMEWORKS: [string, RegExp][] = [
	["PyTorch", /\bimport torch\b|\bfrom torch\b/],
	["Lightning", /\b(pytorch_)?lightning\b/],
	["TensorFlow", /\bimport tensorflow\b|\bfrom tensorflow\b/],
	["Keras", /\bimport keras\b|\bfrom keras\b|tf\.keras/],
	["JAX", /\bimport jax\b|\bfrom flax\b/],
	["Transformers", /\bfrom transformers\b|\bimport transformers\b/],
	["PEFT", /\bfrom peft\b/],
	["TRL", /\bfrom trl\b/],
	["scikit-learn", /\bfrom sklearn\b|\bimport sklearn\b/],
	["XGBoost", /\bimport xgboost\b|\bfrom xgboost\b/],
	["LightGBM", /\bimport lightgbm\b|\bfrom lightgbm\b/],
	["CatBoost", /\bcatboost\b/],
	["statsmodels", /\bstatsmodels\b/],
	["Prophet", /\bfrom prophet\b|\bfbprophet\b/],
	["Spark ML", /pyspark\.ml\b/],
	["spaCy", /\bimport spacy\b/],
	["Optuna", /\bimport optuna\b/],
	["Hydra", /@hydra\.main/],
	["DeepSpeed", /\bdeepspeed\b/],
	["Accelerate", /\bfrom accelerate\b/],
];

interface SourceFile {
	rel: string;
	text: string;
	py: boolean;
}

interface Component {
	id: string;
	stage: StageId;
	label: string;
	sub?: string;
	kind: "code" | "tool";
	files: string[];
	evidence: string[];
	score: number;
	/** Code files an orchestrator or CI runs (kept as data: edges from a cross-cutting lane would pull it to the front). */
	runs?: string[];
}

export interface LifecycleScan {
	root: string;
	components: Component[];
	edges: MapEdge[];
	gaps: StageId[];
	overflow: Map<StageId, string[]>;
	fileCount: number;
}

/** Code cells of a notebook as one Python text. */
function notebookCode(text: string): string {
	try {
		const nb = JSON.parse(text);
		return (nb.cells ?? [])
			.filter((c: any) => c.cell_type === "code")
			.map((c: any) => (Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "")))
			.join("\n\n");
	} catch {
		return "";
	}
}

const FILES = /\.(py|ipynb|ya?ml|json|toml|cfg|pbtxt|tf|sh|properties|dvc)$|(^|\/)(Dockerfile[^/]*|Containerfile|Makefile|Jenkinsfile|MLproject|MLmodel)$/i;
const SKIP = /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|yarn\.lock|\.eslintrc[^/]*|setup\.py|conftest\.py|__init__\.py|noxfile\.py|tasks\.py)$|(^|\/)(tests?|docs?)\//i;

/** Python module names a file can be imported as. */
function moduleNames(rel: string): string[] {
	const parts = rel.replace(/\.py$/, "").split("/");
	if (parts[parts.length - 1] === "__init__") parts.pop();
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("."));
	return out;
}

function importsOf(text: string, rel: string): string[] {
	const out: string[] = [];
	const dir = path.posix.dirname(rel).split("/").filter((p) => p !== ".");
	for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+\(?([\w\s,*]+)\)?/gm)) {
		let base = m[2];
		if (m[1]) base = [...dir.slice(0, dir.length - (m[1].length - 1)), ...(m[2] ? m[2].split(".") : [])].join(".");
		out.push(base);
		for (const name of m[3].split(",").map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== "*")) out.push(`${base}.${name}`);
	}
	for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) out.push(...m[1].split(",").map((s) => s.trim()));
	return out;
}

const ARTIFACT_LITERAL = /['"]([\w./{}-]*\.(?:pkl|pickle|joblib|pt|pth|onnx|h5|keras|safetensors|ckpt|parquet|csv|feather|npy|npz|jsonl|tfrecords?|bin))['"]/g;
const WRITES = /to_(csv|parquet|json|pickle|feather)\(|\bdump\(|\.save\(|save_model\(|torch\.save\(|np\.save|savez|export\(|log_artifact|write|open\([^)]*['"][wa]b?['"]/;
const READS = /read_(csv|parquet|json|pickle|feather)|\bload\(|load_model\(|torch\.load\(|np\.load|open\(|from_pretrained|InferenceSession\(|joblib\.load/;

export function scanLifecycle(root: string, progress: (t: string) => void = () => undefined): LifecycleScan {
	progress("Reading the repository…");
	const raw = readFiles(root, { match: (rel) => FILES.test(rel) && !SKIP.test(rel), maxFiles: 5000, maxBytes: 1_500_000, dotDirs: (n) => n === ".github" || n === ".circleci" || n === ".gitlab" });
	const files: SourceFile[] = raw.map((f) => {
		if (/\.ipynb$/i.test(f.rel)) return { rel: f.rel, text: notebookCode(f.text), py: true };
		return { rel: f.rel, text: /\.py$/i.test(f.rel) ? stripPyComments(f.text) : f.text, py: /\.py$/i.test(f.rel) };
	});
	progress(`Looking for ML lifecycle evidence in ${files.length} file(s)…`);

	// Code components: each Python file goes to the stage it shows most evidence of.
	const codeOf = new Map<string, Component>();
	const scored: Component[] = [];
	for (const f of files) {
		if (!f.py || !f.text.trim()) continue;
		let best: { stage: StageId; score: number; evidence: string[] } | undefined;
		for (const [stage, sig] of Object.entries(CODE_SIGNALS) as [StageId, { name: RegExp; text: RegExp[] }][]) {
			const evidence: string[] = [];
			let score = 0;
			if (sig.name.test(f.rel)) {
				score += 3;
				evidence.push(`file name`);
			}
			for (const re of sig.text) {
				const m = re.exec(f.text);
				if (m) {
					score += 2;
					evidence.push(m[0].slice(0, 40));
				}
			}
			if (!best || score > best.score) best = { stage, score, evidence };
		}
		if (!best || best.score < 4) continue;
		const frameworks = FRAMEWORKS.filter(([, re]) => re.test(f.text)).map(([n]) => n);
		const c: Component = {
			id: `code:${slug(f.rel)}`,
			stage: best.stage,
			label: path.posix.basename(f.rel),
			sub: frameworks.slice(0, 3).join(" · ") || undefined,
			kind: "code",
			files: [f.rel],
			evidence: best.evidence,
			score: best.score,
		};
		codeOf.set(f.rel, c);
		scored.push(c);
	}
	// Keep the strongest per stage.
	const overflow = new Map<StageId, string[]>();
	const kept: Component[] = [];
	for (const s of STAGES) {
		const mine = scored.filter((c) => c.stage === s.id).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
		kept.push(...mine.slice(0, 10));
		if (mine.length > 10) {
			overflow.set(s.id, mine.slice(10).map((c) => c.files[0]));
			for (const c of mine.slice(10)) codeOf.delete(c.files[0]);
		}
	}

	// Tools.
	const tools = new Map<string, Component>();
	const edges: MapEdge[] = [];
	const edgeKeys = new Set<string>();
	const addEdge = (from: string, to: string, label: string | undefined, kind: string, style = ML_STYLES.flowEdge) => {
		const key = `${from}\u0000${to}`;
		if (from === to || edgeKeys.has(key)) return;
		edgeKeys.add(key);
		edges.push({ from, to, label, kind, style });
	};
	/** Code components a file mentions, in the order it mentions them. */
	const mentionTargets = (text: string): Component[] =>
		[...codeOf.values()]
			.map((c) => {
				const rel = c.files[0];
				const mod = rel.replace(/\.(py|ipynb)$/, "").replace(/\//g, ".").replace(/[.]/g, "\\.");
				// The path, the file name, or the module (python -m pkg.mod, uvicorn pkg.mod:app).
				const hits = [
					text.indexOf(rel),
					new RegExp(`(^|[\\s/"'=])${path.posix.basename(rel).replace(/[.]/g, "\\.")}\\b`).exec(text)?.index ?? -1,
					/\.py$/.test(rel) ? new RegExp(`(^|[\\s"'=])${mod}(:\\w+|[\\s"']|$)`, "m").exec(text)?.index ?? -1 : -1,
				].filter((i) => i >= 0);
				return { c, pos: hits.length ? Math.min(...hits) : -1 };
			})
			.filter((x) => x.pos >= 0)
			.sort((a, b) => a.pos - b.pos)
			.map((x) => x.c);
	for (const f of files) {
		for (const def of TOOLS) {
			if (def.py && !f.py) continue;
			const byFile = def.file?.test(f.rel) ?? false;
			if (def.both ? !byFile || !def.text?.test(f.text) : !byFile && !def.text?.test(f.text)) continue;
			const key = `${def.stage}:${def.tool}`;
			let t = tools.get(key);
			if (!t) {
				t = { id: `tool:${slug(key)}`, stage: def.stage, label: def.tool, kind: "tool", files: [], evidence: [], score: 0 };
				tools.set(key, t);
			}
			if (!t.files.includes(f.rel)) t.files.push(f.rel);
			const code = codeOf.get(f.rel);
			if (code && def.dir) {
				if (def.dir === "in") addEdge(t.id, code.id, def.verb, "uses", ML_STYLES.depEdge);
				else addEdge(code.id, t.id, def.verb, "uses", ML_STYLES.depEdge);
			}
			if (def.mentions) {
				for (const target of mentionTargets(f.text)) {
					if (target.files[0] === f.rel) continue;
					if (def.mentions === "runs") {
						t.runs ??= [];
						if (!t.runs.includes(target.files[0])) t.runs.push(target.files[0]);
					}
					else addEdge(target.id, t.id, "packaged in", "packages", ML_STYLES.softEdge);
				}
			}
		}
	}
	for (const t of tools.values()) t.sub = t.runs?.length ? `runs ${t.runs.slice(0, 3).map((r) => path.posix.basename(r)).join(", ")}${t.runs.length > 3 ? ", …" : ""}` : t.files.length === 1 ? t.files[0] : `${t.files.length} files`;

	// Imports between code components.
	const modIndex = new Map<string, string | null>();
	for (const f of files) {
		if (!/\.py$/.test(f.rel)) continue;
		for (const m of moduleNames(f.rel)) modIndex.set(m, modIndex.has(m) && modIndex.get(m) !== f.rel ? null : f.rel);
	}
	for (const f of files) {
		const importer = codeOf.get(f.rel);
		if (!importer || !/\.py$/.test(f.rel)) continue;
		for (const imp of importsOf(f.text, f.rel)) {
			const target = modIndex.get(imp);
			const comp = target ? codeOf.get(target) : undefined;
			if (comp && comp !== importer) addEdge(comp.id, importer.id, "import", "import", ML_STYLES.depEdge);
		}
	}
	// Artifacts written by one file and read by another.
	const writers = new Map<string, Set<string>>();
	const readers = new Map<string, Set<string>>();
	for (const f of files) {
		if (!codeOf.has(f.rel)) continue;
		for (const m of f.text.matchAll(ARTIFACT_LITERAL)) {
			const lit = m[1].replace(/^\.\//, "");
			const lineStart = f.text.lastIndexOf("\n", m.index!) + 1;
			const lineEnd = f.text.indexOf("\n", m.index!);
			const line = f.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
			const map = WRITES.test(line) ? writers : READS.test(line) ? readers : undefined;
			if (!map) continue;
			if (!map.has(lit)) map.set(lit, new Set());
			map.get(lit)!.add(f.rel);
		}
	}
	let artifactEdges = 0;
	for (const [lit, ws] of writers) {
		for (const w of ws)
			for (const r of readers.get(lit) ?? []) {
				if (w === r || artifactEdges >= 60) continue;
				addEdge(codeOf.get(w)!.id, codeOf.get(r)!.id, path.posix.basename(lit), "artifact");
				artifactEdges++;
			}
	}
	const components = [...kept.filter((c) => codeOf.has(c.files[0])), ...tools.values()];
	const present = new Set(components.map((c) => c.stage));
	const gaps = STAGES.filter((s) => s.main && !present.has(s.id)).map((s) => s.id);
	return { root, components, edges, gaps, overflow, fileCount: files.length };
}

export function lifecycleToGraph(scan: LifecycleScan): MapGraph {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [...scan.edges];
	const name = scan.root.split(/[\\/]/).pop() ?? scan.root;
	const present = new Set(scan.components.map((c) => c.stage));
	const mainStages = STAGES.filter((s) => s.main);
	for (const s of STAGES) {
		if (!s.main && !present.has(s.id)) continue;
		const sid = `stage:${s.id}`;
		nodes.push({
			id: sid,
			label: s.title,
			kind: "ml:lifecycle:stage",
			container: true,
			style: `rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=${s.fill};strokeColor=${s.stroke};strokeWidth=2;`,
			data: { stage: s.id },
		});
		const mine = scan.components.filter((c) => c.stage === s.id);
		for (const c of mine) {
			nodes.push({
				id: c.id,
				label: c.sub ? `${c.label}\n${c.sub}` : c.label,
				kind: c.kind === "code" ? "ml:lifecycle:code" : "ml:lifecycle:tool",
				parent: sid,
				style:
					c.kind === "code"
						? `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${s.stroke};fontSize=11;`
						: `rounded=1;arcSize=40;whiteSpace=wrap;html=1;fillColor=${s.fill};strokeColor=${s.stroke};fontStyle=1;fontSize=11;`,
				width: Math.max(150, Math.min(240, Math.max(c.label.length, (c.sub ?? "").length) * 7 + 24)),
				height: c.sub ? 50 : 40,
				data: { stage: s.id, ...(c.kind === "code" ? { file: c.files[0] } : { tool: c.label, files: c.files.slice(0, 30).join(", "), ...(c.runs?.length ? { runs: c.runs.join(", ") } : {}) }), ...(c.evidence.length ? { evidence: c.evidence.join("; ") } : {}), ...(c.sub && c.kind === "code" ? { frameworks: c.sub } : {}) },
			});
		}
		const more = scan.overflow.get(s.id);
		if (more?.length) nodes.push({ id: `more:${s.id}`, label: `+ ${more.length} more file(s): ${more.slice(0, 6).join(", ")}${more.length > 6 ? ", …" : ""}`, kind: "ml:lifecycle:more", shape: "note", parent: sid, width: 220, data: { stage: s.id, files: more.join(", ") } });
		if (s.main && mine.length === 0) {
			nodes.push({ id: `gap:${s.id}`, label: `No evidence found\n(gap — or not in this repo)`, kind: "ml:lifecycle:gap", parent: sid, style: ML_STYLES.gap, width: 170, height: 48, data: { stage: s.id, gap: "true" } });
		}
	}
	// The lifecycle order, left to right.
	for (let i = 0; i + 1 < mainStages.length; i++) edges.push({ from: `stage:${mainStages[i].id}`, to: `stage:${mainStages[i + 1].id}`, kind: "lifecycle", style: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#c0c4cc;strokeWidth=3;" });
	const code = scan.components.filter((c) => c.kind === "code").length;
	const tools = scan.components.filter((c) => c.kind === "tool").length;
	return {
		title: `ML lifecycle · ${name}`,
		nodes,
		edges,
		direction: "right",
		legend: [
			`ML lifecycle of ${name}, from ${scan.fileCount} file(s): ${code} code file(s) and ${tools} tool(s) placed by the evidence found.`,
			"White boxes: code files (frameworks below the name). Pills: tools and platforms. Dashed: uses / imports; dotted grey: packaging; solid: artifacts written by one file and read by another. What orchestration / CI runs is listed on it.",
			scan.gaps.length ? `Gaps (no evidence): ${scan.gaps.map((g) => STAGE.get(g)!.title).join(", ")}.` : "Every stage has evidence.",
		],
	};
}

function lifecycleFacts(scan: LifecycleScan): string {
	const lines = [`# ML lifecycle evidence in ${scan.root}`];
	const label = new Map(scan.components.map((c) => [c.id, c.label]));
	for (const s of STAGES) {
		const mine = scan.components.filter((c) => c.stage === s.id);
		lines.push(`\n## ${s.title}${mine.length ? "" : " — NO EVIDENCE (gap)"}`);
		for (const c of mine) lines.push(`- ${c.kind === "code" ? "code" : "tool"}: ${c.label}${c.sub ? ` (${c.sub})` : ""} — files: ${c.files.slice(0, 12).join(", ")}${c.files.length > 12 ? ", …" : ""}${c.runs?.length ? ` — runs: ${c.runs.join(", ")}` : ""}${c.evidence.length ? ` — evidence: ${c.evidence.join("; ")}` : ""}`);
		const more = scan.overflow.get(s.id);
		if (more?.length) lines.push(`- also: ${more.join(", ")}`);
	}
	if (scan.edges.length) lines.push("\n## Links found", ...scan.edges.map((e) => `- ${label.get(e.from) ?? e.from} → ${label.get(e.to) ?? e.to}${e.label ? ` (${e.label})` : ""}`));
	return lines.join("\n");
}

export const lifecycleRecipe: Recipe = {
	id: "ml.lifecycle",
	category: "ml",
	title: "End-to-end ML lifecycle",
	description:
		"Data → features → training → evaluation → registry → serving → monitoring, with experiment tracking and orchestration / CI/CD: the code files and tools found for each stage, how they connect, and the gaps. The agent then completes the flow.",
	mode: "inventory",
	fields: [FOLDER_FIELD],
	async collect(input, ctx) {
		const root = folderInput(input, ctx.cwd);
		const scan = scanLifecycle(root, (t) => ctx.progress(t));
		if (scan.components.length === 0) return { summary: `No ML code or tooling found in ${root}.`, facts: lifecycleFacts(scan) };
		const graph = lifecycleToGraph(scan);
		const stages = STAGES.filter((s) => s.main && !scan.gaps.includes(s.id)).length;
		return {
			graph,
			summary: `${stages}/7 lifecycle stages with evidence, ${scan.components.length} component(s), ${scan.edges.length} link(s)${scan.gaps.length ? `; gaps: ${scan.gaps.join(", ")}` : ""}`,
			facts: lifecycleFacts(scan),
		};
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"The ML lifecycle map on this page was built from evidence in the repository (stage lanes left to right; code files and tools in each). Read the code and complete the flow: connect components the scan could not link (which data each training run reads, where the model artifact goes, what the serving code loads, what is monitored and what triggers retraining), name the datasets and models on the arrows, correct components placed in the wrong stage, and turn each red gap box into either the component that covers it (if it lives elsewhere, e.g. a platform) or a clear note that the stage is missing and why that matters.",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("parts of the ML lifecycle (read the files listed in their data; trace what data they read and write and which models they produce or load)", shapes, question),
};
