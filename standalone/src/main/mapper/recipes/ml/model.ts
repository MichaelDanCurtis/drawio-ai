/**
 * The "Model architecture" recipe: a local model folder or file (Hugging Face
 * config.json + safetensors headers, GGUF, ONNX, XGBoost / LightGBM), or a
 * public Hugging Face model id whose config.json and safetensors headers are
 * fetched read-only (HTTP range requests: weights are never downloaded).
 */
import * as fs from "fs";
import * as path from "path";
import { agentRequest, digDeeperRequest } from "../common";
import type { CollectContext, CollectResult, MapGraph, MapInput, Recipe } from "../../types";
import { MapperError } from "../../types";
import { ArchSpec, archToGraph, breakdownFromTensors, estimateTotal, fillFromTensors, fromGguf, fromHfConfig, onnxToGraph, ParamBreakdown, treesToGraph } from "./modelArch";
import { ByteSource, parseGguf, parseLightgbm, parseOnnx, parseSafetensorsHeader, parseXgboostJson, TensorInfo } from "./modelFormats";
import { fmtCount, httpRequest, redactUrl } from "./shared";

export interface ModelResult {
	graph: MapGraph;
	summary: string;
	facts: Record<string, unknown>;
	warnings: string[];
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, "utf8"));

function loraNote(adapter: any): string {
	const targets = Array.isArray(adapter?.target_modules) ? adapter.target_modules.join(", ") : String(adapter?.target_modules ?? "");
	return `${adapter?.peft_type ?? "LoRA"} adapter${adapter?.r ? ` r=${adapter.r}` : ""}${adapter?.lora_alpha ? ` α=${adapter.lora_alpha}` : ""}${targets ? `\non ${targets}` : ""}${adapter?.base_model_name_or_path ? `\nbase: ${adapter.base_model_name_or_path}` : ""}`;
}

/** Spec + params → the result every source ends in. */
function finishTransformer(spec: ArchSpec, params: ParamBreakdown | undefined, raw: unknown, warnings: string[], where: string, tensors?: TensorInfo[]): ModelResult {
	if (tensors) fillFromTensors(spec, tensors);
	if (!spec.hidden && !spec.layers) warnings.push("The config does not name the usual sizes (hidden size, layers); the diagram is a generic outline.");
	const graph = archToGraph(spec, params);
	const total = params?.total ?? estimateTotal(spec);
	return {
		graph,
		summary: `${spec.name ?? spec.architecture ?? spec.modelType ?? "model"}: ${spec.family}, ${spec.layers ?? "?"} layers, ${params?.exact ? "" : "≈ "}${fmtCount(total)} params${spec.moe ? `, MoE ${spec.moe.experts} experts (top-${spec.moe.topK ?? "?"})` : ""}`,
		facts: {
			source: where,
			normalized: { ...spec, vision: spec.vision ? { ...spec.vision } : undefined },
			parameters: params
				? {
						total: params.total,
						exact: params.exact,
						dtypes: params.dtypes,
						parts: Object.fromEntries(
							Object.entries(params.parts)
								.filter(([, v]) => v.total)
								.map(([k, v]) => [k, { total: v.total, embedding: v.embed, head: v.head, layers: v.layers.size, perLayerFirst: v.layers.size ? { ...[...v.layers.values()][0], expertIds: undefined } : undefined }])
						),
				  }
				: { estimatedTotal: Math.round(total) },
			config: raw,
		},
		warnings,
	};
}

function localSafetensors(dir: string, warnings: string[]): TensorInfo[] | undefined {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".safetensors"));
	if (!files.length) return undefined;
	const tensors: TensorInfo[] = [];
	for (const f of files.slice(0, 400)) {
		const src = ByteSource.file(path.join(dir, f));
		try {
			tensors.push(...parseSafetensorsHeader(src).tensors);
		} catch (e: any) {
			warnings.push(`${f}: ${e?.message ?? e}`);
		} finally {
			src.close();
		}
	}
	return tensors.length ? tensors : undefined;
}

/** A local folder or file. */
export function mapLocalModel(target: string): ModelResult {
	if (!fs.existsSync(target)) throw new MapperError(`${target} does not exist.`);
	const warnings: string[] = [];
	const stat = fs.statSync(target);
	let file = stat.isFile() ? target : undefined;
	const dir = stat.isDirectory() ? target : path.dirname(target);
	if (!file) {
		const names = fs.readdirSync(dir);
		const has = (re: RegExp) => names.filter((n) => re.test(n));
		const config = names.includes("config.json") ? readJsonSafe(path.join(dir, "config.json")) : undefined;
		if (config && (config.model_type || config.architectures || config.hidden_size || config.n_embd || config.d_model || config.text_config)) {
			const spec = fromHfConfig(config);
			spec.source = `config.json${has(/\.safetensors$/).length ? " + safetensors headers" : ""} in ${dir}`;
			if (names.includes("adapter_config.json")) spec.adapter = loraNote(readJsonSafe(path.join(dir, "adapter_config.json")));
			if (has(/\.(bin|pt|pth|ckpt)$/).length && !has(/\.safetensors$/).length) warnings.push("Weights are pickled PyTorch files, which the Mapper does not open; parameter counts are estimated from the config.");
			const tensors = localSafetensors(dir, warnings);
			return finishTransformer(spec, tensors && breakdownFromTensors(tensors), config, warnings, dir, tensors);
		}
		if (names.includes("adapter_config.json")) {
			const adapter = readJsonSafe(path.join(dir, "adapter_config.json"));
			throw new MapperError(`${dir} holds only an adapter (${loraNote(adapter).replace(/\n/g, ", ")}).`, `Map the base model (${adapter?.base_model_name_or_path ?? "see adapter_config.json"}) as a Hugging Face id instead; the adapter is then noted on it.`);
		}
		const pick = has(/\.gguf$/i)[0] ?? has(/\.onnx$/i)[0] ?? has(/^model\.json$|xgb.*\.json$|\.ubj$/i)[0] ?? has(/^model\.txt$|lgb.*\.(txt|json)$|lightgbm.*\.(txt|json)$/i)[0] ?? has(/\.safetensors$/)[0];
		if (!pick) {
			const pickles = has(/\.(pkl|pickle|joblib|bin|pt|pth|h5|keras)$/i);
			throw new MapperError(
				`No model file the Mapper can read in ${dir}.`,
				pickles.length ? `Found ${pickles.slice(0, 3).join(", ")}: pickled / framework files are not opened because loading them can run code. Ask the agent to describe the model from its training code.` : "Choose a folder with config.json (Hugging Face), a .gguf, .onnx, XGBoost model.json or LightGBM model.txt."
			);
		}
		file = path.join(dir, pick);
		const others = names.filter((n) => /\.(gguf|onnx)$/i.test(n) && n !== pick);
		if (others.length) warnings.push(`Also found ${others.slice(0, 4).join(", ")}; map them by choosing the file.`);
	}
	const base = path.basename(file);
	if (/\.gguf$/i.test(base)) {
		const src = ByteSource.file(file);
		try {
			const g = parseGguf(src);
			const spec = fromGguf(g);
			spec.source = `GGUF header of ${base}`;
			// Long arrays (vocabularies) are summarized by their length.
			const meta = Object.fromEntries(Object.entries(g.metadata).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) && "length" in (v as any) ? `[${(v as any).length} values]` : v]));
			return finishTransformer(spec, breakdownFromTensors(g.tensors), { ggufVersion: g.version, metadata: meta }, warnings, file, g.tensors);
		} finally {
			src.close();
		}
	}
	if (/\.onnx$/i.test(base)) {
		const src = ByteSource.file(file);
		try {
			const m = parseOnnx(src);
			const graph = onnxToGraph(m, base);
			const params = m.initializers.reduce((a, t) => a + t.shape.reduce((x, y) => x * y, 1), 0);
			return {
				graph,
				summary: `ONNX ${base}: ${m.nodes.length} ops, ${fmtCount(params)} params`,
				facts: { file, producer: m.producer, producerVersion: m.producerVersion, irVersion: m.irVersion, opsets: m.opsets, inputs: m.inputs.filter((i) => !m.initializers.some((t) => t.name === i.name)), outputs: m.outputs, metadata: m.metadata, opCounts: m.nodes.reduce((acc: Record<string, number>, n) => ((acc[n.op] = (acc[n.op] ?? 0) + 1), acc), {}) },
				warnings,
			};
		} finally {
			src.close();
		}
	}
	if (/\.safetensors$/i.test(base)) {
		const src = ByteSource.file(file);
		try {
			const h = parseSafetensorsHeader(src);
			const params = breakdownFromTensors(h.tensors);
			const spec = guessSpecFromTensors(h.tensors);
			spec.source = `safetensors header of ${base} (no config.json: sizes inferred from tensor shapes)`;
			warnings.push("No config.json next to the weights: sizes are inferred from tensor shapes; head counts are unknown.");
			return finishTransformer(spec, params, { metadata: h.metadata }, warnings, file, h.tensors);
		} finally {
			src.close();
		}
	}
	const text = fs.readFileSync(file, "utf8");
	let trees = parseLightgbm(text);
	if (!trees && /\.json$/i.test(base)) trees = parseXgboostJson(JSON.parse(text));
	if (trees) return { graph: treesToGraph(trees, base), summary: `${trees.library} ${base}: ${trees.trees} trees, ${trees.featureCount ?? trees.features.length} features`, facts: { file, ...trees }, warnings };
	if (base === "config.json") return mapLocalModel(dir);
	throw new MapperError(`${base} is not a model format the Mapper reads.`, "Supported: Hugging Face folders (config.json), .safetensors, .gguf, .onnx, XGBoost JSON and LightGBM text/JSON models.");
}

/** The files a local model is read from, relative to the mapped folder (the folder, or the file's folder). */
export function localModelFiles(target: string): string[] {
	try {
		const stat = fs.statSync(target);
		if (stat.isFile()) return [path.basename(target)];
		return fs
			.readdirSync(target)
			.filter((n) => /^(config|adapter_config|generation_config|tokenizer_config)\.json$|\.(safetensors|gguf|onnx)$|^model\.(json|txt)$|^(xgb|lgb|lightgbm)[^/]*\.(json|txt|ubj)$/i.test(n) && fs.statSync(path.join(target, n)).isFile())
			.sort();
	} catch {
		return [];
	}
}

function readJsonSafe(p: string): any {
	try {
		return readJson(p);
	} catch {
		return undefined;
	}
}

/** Sizes from tensor shapes alone (embedding = vocab × hidden, layer count from indices). */
function guessSpecFromTensors(tensors: TensorInfo[]): ArchSpec {
	const embed = tensors.find((t) => /embed_tokens|wte|tok_embeddings|word_embeddings|token_embd/.test(t.name) && t.shape.length === 2);
	const layers = new Set(tensors.map((t) => /(?:layers?|h|blocks?|blk)\.(\d+)\./.exec(t.name)?.[1]).filter(Boolean));
	const up = tensors.find((t) => /(up_proj|fc1|c_fc|w1|ffn_up)\.weight$/.test(t.name) && t.shape.length === 2);
	const hidden = embed ? Math.min(...embed.shape) : undefined;
	return {
		source: "safetensors",
		family: "decoder",
		hidden,
		vocab: embed ? Math.max(...embed.shape) : undefined,
		layers: layers.size || undefined,
		intermediate: up ? up.shape.find((x) => x !== hidden) : undefined,
		gated: tensors.some((t) => /gate_proj|w3\.weight|ffn_gate/.test(t.name)),
		tied: !tensors.some((t) => /lm_head|^output\.weight$/.test(t.name)),
		norm: "Norm",
		head: "lm",
		notes: [],
	};
}

// ---------------------------------------------------------------- Hugging Face Hub

export const HF_ID = /^[A-Za-z0-9][\w.-]{0,95}(\/[A-Za-z0-9][\w.-]{0,95})?$/;

export function normalizeHfId(raw: string): string {
	const id = raw
		.trim()
		.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, "")
		.replace(/^hf:\/\//i, "")
		.replace(/\/(tree|blob|resolve)\/.*$/, "")
		.replace(/\/+$/, "");
	if (!HF_ID.test(id) || id.includes("..")) throw new MapperError(`"${raw}" is not a Hugging Face model id.`, "Use the form owner/model, e.g. Qwen/Qwen2.5-0.5B.");
	return id;
}

export interface HubOptions {
	base?: string;
	token?: string;
	revision?: string;
	signal?: AbortSignal;
	progress?: (t: string) => void;
	/** Max shards whose headers are read. */
	maxShards?: number;
	/** Set when mapping the base model of an adapter repository. */
	adapterNote?: string;
}

class Hub {
	private base: string;
	private headers: Record<string, string>;
	constructor(private id: string, private o: HubOptions) {
		this.base = (o.base ?? "https://huggingface.co").replace(/\/+$/, "");
		this.headers = o.token?.trim() ? { Authorization: `Bearer ${o.token.trim()}` } : {};
	}
	url(file: string): string {
		return `${this.base}/${this.id}/resolve/${encodeURIComponent(this.o.revision?.trim() || "main")}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}
	async json(file: string): Promise<any | undefined> {
		const r = await httpRequest(this.url(file), { headers: this.headers, timeoutMs: 20_000, signal: this.o.signal });
		if (r.status === 404) return undefined;
		if (r.status === 401 || r.status === 403) throw new MapperError(`${this.id} is gated or private (HTTP ${r.status}).`, "Accept its license on huggingface.co and give a read token in the token field.");
		if (!r.ok) throw new MapperError(`Could not read ${file} of ${this.id} (HTTP ${r.status}).`);
		if (r.json === undefined) throw new MapperError(`${file} of ${this.id} is not JSON.`);
		return r.json;
	}
	/** Bytes [start, end] via an HTTP range request; refuses to download a whole file. */
	async range(file: string, start: number, end: number): Promise<Buffer | undefined> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 30_000);
		const onAbort = () => ctrl.abort();
		this.o.signal?.addEventListener("abort", onAbort);
		try {
			const res = await fetch(this.url(file), { headers: { ...this.headers, Range: `bytes=${start}-${end}` }, signal: ctrl.signal, redirect: "follow" });
			if (res.status === 404) {
				await res.body?.cancel();
				return undefined;
			}
			const len = Number(res.headers.get("content-length") ?? NaN);
			if (res.status !== 206 && !(res.status === 200 && Number.isFinite(len) && len <= end - start + 1)) {
				await res.body?.cancel();
				throw new MapperError(`The Hub did not serve a byte range of ${file} (HTTP ${res.status}); not downloading the whole file.`);
			}
			const b = Buffer.from(await res.arrayBuffer());
			return b.subarray(0, end - start + 1);
		} catch (e: any) {
			if (e instanceof MapperError) throw e;
			if (this.o.signal?.aborted) throw new MapperError("Cancelled");
			throw new MapperError(`Could not read ${file} of ${this.id}: ${e?.cause?.code ?? e?.message ?? e}`);
		} finally {
			clearTimeout(timer);
			this.o.signal?.removeEventListener("abort", onAbort);
		}
	}
	async safetensorsHeader(file: string): Promise<TensorInfo[] | undefined> {
		const first = await this.range(file, 0, 7);
		if (!first || first.length < 8) return undefined;
		const n = Number(first.readBigUInt64LE(0));
		if (!Number.isSafeInteger(n) || n <= 1 || n > 100_000_000) throw new MapperError(`${file} has a bad safetensors header.`);
		const rest = await this.range(file, 8, 8 + n - 1);
		if (!rest) return undefined;
		return parseSafetensorsHeader(ByteSource.buffer(Buffer.concat([first, rest]))).tensors;
	}
}

/** A public (or token-accessible) Hugging Face model, read-only and header-only. */
export async function mapHubModel(rawId: string, o: HubOptions = {}): Promise<ModelResult> {
	const id = normalizeHfId(rawId);
	const hub = new Hub(id, o);
	const warnings: string[] = [];
	o.progress?.(`Reading ${id} config.json…`);
	const config = await hub.json("config.json");
	let adapter: any;
	if (!config) {
		adapter = await hub.json("adapter_config.json");
		const baseId = adapter?.base_model_name_or_path;
		if (!adapter || !baseId || !HF_ID.test(String(baseId))) throw new MapperError(`${id} has no config.json (revision ${o.revision || "main"}).`, "GGUF-only and other repositories without config.json: download the file and map it locally.");
		o.progress?.(`${id} is an adapter; reading its base model ${baseId}…`);
		const base = await mapHubModel(String(baseId), { ...o, adapterNote: loraNote(adapter) });
		base.graph.title = `Model · ${id} (adapter on ${baseId})`;
		return { ...base, summary: `${id}: adapter on ${base.summary}`, facts: { ...base.facts, adapter } };
	}
	const spec = fromHfConfig(config);
	spec.name = id;
	if (o.adapterNote) spec.adapter = o.adapterNote;
	let params: ParamBreakdown | undefined;
	let tensors: TensorInfo[] = [];
	try {
		o.progress?.("Reading safetensors headers (no weights)…");
		const index = await hub.json("model.safetensors.index.json");
		if (index?.weight_map) {
			const shards = [...new Set(Object.values<string>(index.weight_map))];
			const max = o.maxShards ?? 24;
			// A few shards at a time: two small range requests each.
			const todo = shards.slice(0, max);
			for (let i = 0; i < todo.length; i += 6) {
				o.progress?.(`Reading safetensors headers ${i + 1}–${Math.min(todo.length, i + 6)} of ${todo.length}…`);
				for (const list of await Promise.all(todo.slice(i, i + 6).map((shard) => hub.safetensorsHeader(shard)))) tensors.push(...(list ?? []));
			}
			if (shards.length > max) {
				warnings.push(`${shards.length} weight shards; headers of the first ${max} were read, the rest of the counts come from the index size.`);
				params = breakdownFromTensors(tensors, true);
				const bytes = Number(index.metadata?.total_size);
				const per = /32/.test(spec.dtype ?? "") ? 4 : /8/.test(spec.dtype ?? "") ? 1 : 2;
				if (Number.isFinite(bytes)) params.total = Math.round(bytes / per);
			} else params = breakdownFromTensors(tensors);
		} else {
			tensors = (await hub.safetensorsHeader("model.safetensors")) ?? [];
			if (tensors.length) params = breakdownFromTensors(tensors);
			else warnings.push(`${id} has no safetensors weights; parameter counts are estimated from the config.`);
		}
	} catch (e: any) {
		if (e instanceof MapperError && /Cancelled|gated/.test(e.message)) throw e;
		warnings.push(`Safetensors headers not read (${e?.message ?? e}); parameter counts are estimated from the config.`);
	}
	spec.source = `huggingface.co/${id}${o.revision && o.revision !== "main" ? `@${o.revision}` : ""} config.json${params ? " + safetensors headers" : ""}`;
	return finishTransformer(spec, params, config, warnings, `${redactUrl(hub.url("config.json"))}`, tensors);
}

export async function collectModel(input: MapInput, ctx: Pick<CollectContext, "progress" | "signal">, hubBase?: string): Promise<ModelResult> {
	const local = (input.file || input.folder || "").trim();
	if (local && input.hfModel?.trim()) {
		throw new MapperError("Choose either a local model (folder or file) or a Hugging Face model id, not both.");
	}
	if (local) {
		ctx.progress(`Reading ${local}…`);
		return mapLocalModel(local);
	}
	if (input.hfModel?.trim()) return mapHubModel(input.hfModel, { base: hubBase, token: input.hfToken, revision: input.revision, signal: ctx.signal, progress: (t) => ctx.progress(t) });
	throw new MapperError("Choose a model folder or file, or enter a Hugging Face model id.");
}

export const modelRecipe: Recipe = {
	id: "ml.model",
	category: "ml",
	title: "Model architecture",
	description:
		"Block diagram of a model — inputs, embedding, N × block (attention heads / KV heads, MLP or mixture-of-experts, norms), output head — with parameter counts. Reads Hugging Face config.json and safetensors headers (local or from the Hub, no weights downloaded), GGUF, ONNX, XGBoost and LightGBM models.",
	mode: "inventory",
	fields: [
		{ id: "folder", label: "Model folder", type: "folder", help: "A Hugging Face model folder (config.json, *.safetensors) or a folder with a .gguf / .onnx / XGBoost / LightGBM model." },
		{ id: "file", label: "…or a model file", type: "file", help: ".gguf, .onnx, .safetensors, XGBoost model.json, LightGBM model.txt. Only headers are read; pickles are never opened." },
		{ id: "hfModel", label: "…or a Hugging Face model id", type: "text", placeholder: "Qwen/Qwen2.5-0.5B", help: "Reads config.json and the safetensors headers over HTTPS (range requests; weights are not downloaded)." },
		{ id: "revision", label: "Revision (Hugging Face)", type: "text", default: "main" },
		{ id: "hfToken", label: "Hugging Face token (gated models only)", type: "password", secret: true, help: "Read-only token; never stored or shown to the agent." },
	],
	async collect(input, ctx): Promise<CollectResult> {
		const r = await collectModel(input, ctx);
		const local = (input.file || input.folder || "").trim();
		if (local && !input.hfModel?.trim()) {
			const files = localModelFiles(local);
			// The model's files stand for every block of the diagram (its weights and config change together).
			if (files.length) for (const n of r.graph.nodes) if (!n.container) n.files = files;
		}
		return { graph: r.graph, summary: r.summary, warnings: r.warnings, facts: JSON.stringify(r.facts, (_k, v) => (v instanceof Set ? [...v] : v), 1).slice(0, 50_000) };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"The model architecture diagram on this page was drawn from the model's config and tensor headers. Check it against the model's code or model card (e.g. its modeling_*.py in transformers, or the paper) and annotate what the config alone cannot show: attention variants (sliding-window / global layer pattern, QK-norm, attention sinks), positional encoding and long-context scaling, MoE routing (shared experts, load balancing), normalization placement, tokenizer and special tokens, and any vision/audio towers. Add short notes next to the blocks they concern; do not redraw what is correct.",
			result?.facts
		),
	digDeeper: (shapes, question) => digDeeperRequest("modules of the model architecture (find the code that implements them, e.g. the model's modeling file, and explain shapes, parameter counts and design choices)", shapes, question),
};
