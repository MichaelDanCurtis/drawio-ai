/**
 * Model architecture: a normalized description of transformer-style models
 * (from a Hugging Face config.json or GGUF metadata), parameter counts per
 * module from tensor headers (or estimated from the config), and the block
 * diagram: inputs → embedding → N × block (attention, MLP / MoE, norms) → head.
 */
import type { MapEdge, MapGraph, MapNode, MapRow } from "../../types";
import { fmtCount, fmtInt, ML_STYLES } from "./shared";
import { GGUF_FILE_TYPES, GgufArraySummary, GgufFile, numel, OnnxModel, ONNX_TYPES, TensorInfo, TreeEnsemble } from "./modelFormats";

export interface MoeSpec {
	experts: number;
	topK?: number;
	shared?: number;
	expertIntermediate?: number;
	sharedIntermediate?: number;
	denseLayers?: number;
}

export interface ArchSpec {
	source: string;
	name?: string;
	modelType?: string;
	architecture?: string;
	family: "decoder" | "encoder" | "encoder-decoder" | "vision";
	hidden?: number;
	layers?: number;
	decoderLayers?: number;
	heads?: number;
	kvHeads?: number;
	headDim?: number;
	intermediate?: number;
	act?: string;
	vocab?: number;
	context?: number;
	norm?: string;
	positional?: string;
	ropeTheta?: number;
	ropeScaling?: string;
	slidingWindow?: number;
	tied?: boolean;
	gated?: boolean;
	moe?: MoeSpec;
	/** Multi-head latent attention (DeepSeek): low-rank compressed keys/values. */
	mla?: { kvRank: number; qRank?: number; ropeDim?: number; vHeadDim?: number };
	numLabels?: number;
	head?: "lm" | "mlm" | "classifier" | "token-classifier" | "qa" | "features";
	image?: { size?: number; patch?: number; channels?: number };
	vision?: ArchSpec;
	dtype?: string;
	quantization?: string;
	adapter?: string;
	notes: string[];
}

const num = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?(e\d+)?$/i.test(v) ? Number(v) : Array.isArray(v) && typeof v[0] === "number" ? Math.max(...(v as number[])) : undefined;
	return n !== undefined && Number.isFinite(n) ? n : undefined;
};

const GATED_FAMILIES = /llama|mistral|mixtral|qwen|gemma|phi3|phi4|deepseek|olmo|granite|internlm|cohere|exaone|glm|yi\b|smollm|minicpm|hunyuan|ernie4|gpt_oss|arcee|apertus|seed_oss/i;
const ENCODERS = /^(bert|roberta|xlm-roberta|deberta|deberta-v2|distilbert|electra|albert|mpnet|camembert|modernbert|xlm|ernie|nomic_bert|bge|e5|xlmr)$/i;
const VISION = /^(vit|deit|beit|dinov2|clip_vision_model|siglip_vision_model|siglip2_vision_model|vit_mae|vision|swin|convnext|pixtral|qwen2_vl|qwen2_5_vl|idefics3_vision|intern_vit|radio)/i;

/** transformers' defaults for config fields that `to_diff_dict` leaves out. */
const TYPE_DEFAULTS: Record<string, Record<string, unknown>> = {
	llama: { hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, intermediate_size: 11008, vocab_size: 32000, hidden_act: "silu", rms_norm_eps: 1e-6, rope_theta: 10000, max_position_embeddings: 2048, tie_word_embeddings: false },
	mistral: { hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, intermediate_size: 14336, vocab_size: 32000, hidden_act: "silu", rms_norm_eps: 1e-6, rope_theta: 10000, max_position_embeddings: 32768, tie_word_embeddings: false },
	qwen2: { hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 32, intermediate_size: 22016, vocab_size: 151936, hidden_act: "silu", rms_norm_eps: 1e-6, rope_theta: 10000, max_position_embeddings: 32768 },
	clip_vision_model: { hidden_size: 768, num_hidden_layers: 12, num_attention_heads: 12, intermediate_size: 3072, image_size: 224, patch_size: 32, num_channels: 3, hidden_act: "quick_gelu", layer_norm_eps: 1e-5 },
	siglip_vision_model: { hidden_size: 768, num_hidden_layers: 12, num_attention_heads: 12, intermediate_size: 3072, image_size: 224, patch_size: 16, num_channels: 3, hidden_act: "gelu_pytorch_tanh", layer_norm_eps: 1e-6 },
};

/** Normalizes a Hugging Face config.json (also multimodal ones with text_config / vision_config). */
export function fromHfConfig(cfg: any, forcedFamily?: ArchSpec["family"]): ArchSpec {
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const v = num(cfg?.[k]);
			if (v !== undefined) return v;
		}
		return undefined;
	};
	const notes: string[] = [];
	// Multimodal: describe the language model, with the vision tower as a branch.
	if (cfg?.text_config && typeof cfg.text_config === "object" && !forcedFamily) {
		const text = fromHfConfig({ ...cfg.text_config, architectures: cfg.architectures, torch_dtype: cfg.text_config.torch_dtype ?? cfg.torch_dtype ?? cfg.dtype, quantization_config: cfg.quantization_config, _name_or_path: cfg._name_or_path });
		text.modelType = String(cfg.model_type ?? text.modelType ?? "");
		if (cfg.vision_config) text.vision = fromHfConfig({ ...cfg.vision_config, model_type: cfg.vision_config.model_type ?? "vision" }, "vision");
		if (cfg.image_token_index !== undefined || cfg.image_token_id !== undefined) text.notes.push("image features are merged into the token sequence at image tokens");
		return text;
	}
	const modelType = String(cfg?.model_type ?? "");
	// Configs nested in multimodal ones are often saved without their defaults.
	const defaults = TYPE_DEFAULTS[modelType];
	if (defaults) cfg = { ...defaults, ...cfg };
	const architecture = Array.isArray(cfg?.architectures) ? String(cfg.architectures[0]) : undefined;
	const hidden = pick("hidden_size", "n_embd", "d_model", "dim", "model_dim", "embed_dim", "width");
	const heads = pick("num_attention_heads", "n_head", "num_heads", "n_heads", "encoder_attention_heads", "attention_heads");
	const kvHeads = pick("num_key_value_heads", "n_kv_heads", "num_kv_heads", "multi_query_group_num", "n_head_kv") ?? (cfg?.multi_query === true ? 1 : undefined);
	const act = String(cfg?.hidden_act ?? cfg?.activation_function ?? cfg?.hidden_activation ?? cfg?.feed_forward_proj ?? cfg?.activation ?? cfg?.ffn_act ?? "") || undefined;
	let intermediate = pick("intermediate_size", "n_inner", "ffn_dim", "d_ff", "ffn_hidden_size", "encoder_ffn_dim", "mlp_dim", "inner_dim");
	if (intermediate === undefined && hidden && /gpt2|gpt_neo|gptj|opt|bloom|falcon|mpt|gpt_bigcode|codegen/i.test(modelType)) intermediate = 4 * hidden;
	const vocab = pick("vocab_size", "padded_vocab_size", "n_vocab");
	const image = { size: pick("image_size", "img_size"), patch: pick("patch_size", "spatial_patch_size"), channels: pick("num_channels", "in_channels", "in_chans") };
	const decoderLayers = pick("num_decoder_layers", "decoder_layers", "n_decoder_layers");
	const isEncDec = cfg?.is_encoder_decoder === true || (decoderLayers !== undefined && cfg?.is_decoder !== true);
	const family: ArchSpec["family"] =
		forcedFamily ??
		(isEncDec
			? "encoder-decoder"
			: VISION.test(modelType) || (image.size && image.patch && !vocab)
			? "vision"
			: ENCODERS.test(modelType) || (architecture && /For(MaskedLM|SequenceClassification|TokenClassification|QuestionAnswering|MultipleChoice)$/.test(architecture) && !/Causal|Llama|Qwen|Mistral|Gemma|Phi|GPT/.test(architecture))
			? "encoder"
			: "decoder");
	const experts = pick("num_local_experts", "num_experts", "n_routed_experts", "moe_num_experts", "num_experts_per_layer");
	const moe: MoeSpec | undefined =
		experts && experts > 1
			? {
					experts,
					topK: pick("num_experts_per_tok", "moe_top_k", "top_k", "num_selected_experts", "experts_per_token", "moe_k"),
					shared: pick("n_shared_experts", "num_shared_experts") ?? (pick("shared_expert_intermediate_size") ? 1 : undefined),
					expertIntermediate: pick("moe_intermediate_size", "expert_intermediate_size", "moe_ffn_hidden_size") ?? intermediate,
					sharedIntermediate: pick("shared_expert_intermediate_size"),
					denseLayers: pick("first_k_dense_replace", "first_k_dense", "num_dense_layers"),
			  }
			: undefined;
	if (moe && Array.isArray(cfg?.mlp_only_layers) && cfg.mlp_only_layers.length) notes.push(`dense MLP instead of MoE in layers ${cfg.mlp_only_layers.join(", ")}`);
	if (moe && num(cfg?.decoder_sparse_step) && num(cfg.decoder_sparse_step)! > 1) notes.push(`MoE every ${cfg.decoder_sparse_step} layers`);
	const ropeScaling = cfg?.rope_scaling && typeof cfg.rope_scaling === "object" ? `${cfg.rope_scaling.rope_type ?? cfg.rope_scaling.type ?? "scaled"}${cfg.rope_scaling.factor ? ` ×${cfg.rope_scaling.factor}` : ""}` : undefined;
	const positional =
		cfg?.alibi || /bloom|mpt/.test(modelType)
			? "ALiBi"
			: cfg?.relative_attention_num_buckets
			? "relative position buckets"
			: cfg?.rope_theta !== undefined || cfg?.rotary_emb_base !== undefined || cfg?.rope_scaling || cfg?.rotary_dim !== undefined || cfg?.rotary_pct !== undefined || GATED_FAMILIES.test(modelType) || /gpt_neox|gptj|falcon|phi|stablelm|starcoder2|persimmon|codegen/i.test(modelType)
			? "RoPE"
			: /gpt2|gpt_neo|opt|bert|roberta|electra|vit|deit|clip|siglip|whisper|bart|mbart/i.test(modelType) || family === "encoder"
			? "learned"
			: undefined;
	const norm = cfg?.rms_norm_eps !== undefined || /rms/i.test(String(cfg?.normalization_type ?? cfg?.norm_type ?? "")) || /^t5|mt5|umt5/.test(modelType) ? "RMSNorm" : "LayerNorm";
	const layerTypes: string[] = Array.isArray(cfg?.layer_types) ? cfg.layer_types.map(String) : [];
	if (layerTypes.length) {
		const counts = layerTypes.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
		notes.push(`layer types: ${[...counts].map(([t, n]) => `${n} × ${t}`).join(", ")}`);
	}
	const labels = cfg?.id2label && typeof cfg.id2label === "object" ? Object.keys(cfg.id2label).length : pick("num_labels");
	const head: ArchSpec["head"] = !architecture
		? family === "decoder"
			? "lm"
			: "features"
		: /ForCausalLM|LMHeadModel|ForConditionalGeneration|ForSeq2SeqLM|ForImageTextToText/.test(architecture)
		? "lm"
		: /MaskedLM|ForPreTraining/.test(architecture)
		? "mlm"
		: /TokenClassification/.test(architecture)
		? "token-classifier"
		: /QuestionAnswering/.test(architecture)
		? "qa"
		: /Classification/.test(architecture)
		? "classifier"
		: "features";
	const q = cfg?.quantization_config;
	return {
		source: "config.json",
		name: cfg?._name_or_path ? String(cfg._name_or_path) : undefined,
		modelType: modelType || undefined,
		architecture,
		family,
		hidden,
		layers: pick("num_hidden_layers", "n_layer", "num_layers", "n_layers", "encoder_layers", "depth", "num_encoder_layers"),
		decoderLayers: isEncDec ? decoderLayers ?? pick("num_layers") : undefined,
		heads,
		kvHeads: kvHeads ?? heads,
		headDim: pick("head_dim", "kv_channels", "attention_head_dim") ?? (hidden && heads ? Math.round(hidden / heads) : undefined),
		intermediate,
		act,
		vocab,
		context: pick("max_position_embeddings", "n_positions", "n_ctx", "max_seq_len", "seq_length", "max_sequence_length", "max_target_positions"),
		norm,
		positional,
		ropeTheta: pick("rope_theta", "rotary_emb_base"),
		ropeScaling,
		slidingWindow: cfg?.use_sliding_window === false ? undefined : pick("sliding_window"),
		tied: cfg?.tie_word_embeddings !== false,
		mla: num(cfg?.kv_lora_rank) ? { kvRank: num(cfg.kv_lora_rank)!, qRank: num(cfg.q_lora_rank), ropeDim: num(cfg.qk_rope_head_dim), vHeadDim: num(cfg.v_head_dim) } : undefined,
		gated: /silu|swish|swiglu|geglu|gated|glu/i.test(act ?? "") || (GATED_FAMILIES.test(modelType) && !/gelu_new|relu$/.test(act ?? "")),
		moe,
		numLabels: labels,
		head,
		image: image.size || image.patch ? image : undefined,
		dtype: cfg?.torch_dtype ?? cfg?.dtype ? String(cfg.torch_dtype ?? cfg.dtype) : undefined,
		quantization: q ? `${q.quant_method ?? "quantized"}${q.bits ? ` ${q.bits}-bit` : q.load_in_4bit ? " 4-bit" : q.load_in_8bit ? " 8-bit" : ""}` : undefined,
		notes,
	};
}

/** Normalizes GGUF metadata (llama.cpp's key names). */
export function fromGguf(g: GgufFile): ArchSpec {
	const m = g.metadata;
	const arch = String(m["general.architecture"] ?? "unknown");
	const k = (key: string) => num(m[`${arch}.${key}`]);
	const tokens = m["tokenizer.ggml.tokens"] as GgufArraySummary | unknown[] | undefined;
	const vocab = Array.isArray(tokens) ? tokens.length : tokens && typeof tokens === "object" ? (tokens as GgufArraySummary).length : k("vocab_size");
	const experts = k("expert_count");
	const hidden = k("embedding_length");
	const heads = k("attention.head_count");
	const gated = g.tensors.some((t) => /ffn_gate(_exps)?\.weight$/.test(t.name));
	const fileType = num(m["general.file_type"]);
	return {
		source: "GGUF",
		name: m["general.name"] ? String(m["general.name"]) : undefined,
		modelType: arch,
		architecture: arch,
		family: /bert|nomic-bert|jina-bert/.test(arch) ? "encoder" : /t5/.test(arch) ? "encoder-decoder" : "decoder",
		hidden,
		layers: k("block_count"),
		heads,
		kvHeads: k("attention.head_count_kv") ?? heads,
		headDim: k("attention.key_length") ?? (hidden && heads ? Math.round(hidden / heads) : undefined),
		intermediate: k("feed_forward_length"),
		act: gated ? "silu (gated)" : undefined,
		vocab,
		context: k("context_length"),
		norm: m[`${arch}.attention.layer_norm_rms_epsilon`] !== undefined ? "RMSNorm" : "LayerNorm",
		positional: m[`${arch}.rope.freq_base`] !== undefined || m[`${arch}.rope.dimension_count`] !== undefined ? "RoPE" : undefined,
		ropeTheta: k("rope.freq_base"),
		ropeScaling: m[`${arch}.rope.scaling.type`] ? `${m[`${arch}.rope.scaling.type`]}${k("rope.scaling.factor") ? ` ×${k("rope.scaling.factor")}` : ""}` : undefined,
		slidingWindow: k("attention.sliding_window"),
		tied: !g.tensors.some((t) => t.name === "output.weight"),
		gated,
		moe: experts && experts > 1 ? { experts, topK: k("expert_used_count"), shared: k("expert_shared_count"), expertIntermediate: k("expert_feed_forward_length") ?? k("feed_forward_length"), denseLayers: k("leading_dense_block_count") } : undefined,
		head: "lm",
		quantization: fileType !== undefined ? GGUF_FILE_TYPES[fileType] ?? `file type ${fileType}` : undefined,
		notes: [],
	};
}

// ---------------------------------------------------------------- parameters

export interface LayerStats {
	attention: number;
	cross: number;
	mlp: number;
	experts: number;
	router: number;
	shared: number;
	norm: number;
	other: number;
	expertIds: Set<string>;
}

export interface PartStats {
	total: number;
	embed: number;
	finalNorm: number;
	head: number;
	other: number;
	layers: Map<number, LayerStats>;
}

export type PartName = "main" | "encoder" | "decoder" | "vision" | "projector";

export interface ParamBreakdown {
	exact: boolean;
	partial?: boolean;
	total: number;
	dtypes: Record<string, number>;
	parts: Record<PartName, PartStats>;
	tensorCount: number;
}

const emptyPart = (): PartStats => ({ total: 0, embed: 0, finalNorm: 0, head: 0, other: 0, layers: new Map() });
const emptyLayer = (): LayerStats => ({ attention: 0, cross: 0, mlp: 0, experts: 0, router: 0, shared: 0, norm: 0, other: 0, expertIds: new Set() });

export function partOf(name: string): PartName {
	if (/(^|\.)(vision_tower|vision_model|visual|vision_encoder|image_encoder|vpm|vision)\./.test(name)) return "vision";
	if (/(^|\.)(multi_modal_projector|mm_projector|merger|connector|projector|mlp1)\./.test(name)) return "projector";
	if (/(^|\.)encoder\./.test(name)) return "encoder";
	if (/(^|\.)decoder\./.test(name)) return "decoder";
	return "main";
}

const LAYER = /(?:^|\.)(?:layers?|h|blocks?|blk|block|resblocks)\.(\d+)\./;

export function moduleOf(rest: string): keyof Omit<LayerStats, "expertIds"> {
	const r = rest.toLowerCase();
	if (/norm|(^|[._])ln_?\d*([._]|$)|layernorm|layer_norm/.test(r)) return "norm";
	if (/cross_attn|encoder_attn|encdecattention|crossattention/.test(r)) return "cross";
	if (/shared_expert|shexp/.test(r)) return "shared";
	if (/experts?[._]|_exps\b|\.exps\./.test(r)) return "experts";
	if (/(^|\.)(gate|router)(\.weight|\.bias)?$|ffn_gate_inp|\.router\./.test(r)) return "router";
	if (/attn|attention/.test(r) || /(^|\.)(q|k|v|o|wq|wk|wv|query|key|value|qkv)(_proj)?(\.|$)/.test(r)) return "attention";
	if (/mlp|ffn|feed_forward|densereludense|fc\d|c_fc|c_proj|intermediate|output\.dense|(^|\.)(w1|w2|w3|wi|wo|wi_0|wi_1)(\.|$)|gate_proj|up_proj|down_proj|gate_up_proj/.test(r)) return "mlp";
	return "other";
}

/** Parameter counts per part, per layer and per module, from tensor names and shapes. */
export function breakdownFromTensors(tensors: TensorInfo[], partial = false): ParamBreakdown {
	const parts: Record<PartName, PartStats> = { main: emptyPart(), encoder: emptyPart(), decoder: emptyPart(), vision: emptyPart(), projector: emptyPart() };
	const dtypes: Record<string, number> = {};
	let total = 0;
	let tensorCount = 0;
	for (const t of tensors) {
		// Saved buffers that are not parameters (causal masks, rotary frequencies).
		if (/(\.attn\.(masked_)?bias|inv_freq|position_ids)$/.test(t.name) && !/\.(c_attn|q_proj|k_proj|v_proj)\./.test(t.name) && (t.shape.length !== 1 || /inv_freq|position_ids/.test(t.name))) continue;
		const n = numel(t.shape);
		tensorCount++;
		total += n;
		dtypes[t.dtype] = (dtypes[t.dtype] ?? 0) + n;
		const part = parts[partOf(t.name)];
		part.total += n;
		const m = LAYER.exec(t.name);
		if (m) {
			const idx = Number(m[1]);
			if (!part.layers.has(idx)) part.layers.set(idx, emptyLayer());
			const layer = part.layers.get(idx)!;
			const rest = t.name.slice(m.index + m[0].length);
			const mod = moduleOf(rest);
			layer[mod] += n;
			const e = /experts?\.(\d+)\./.exec(rest);
			if (mod === "experts" && e) layer.expertIds.add(e[1]);
		} else if (/embed|wte|wpe|tok_embeddings|word_embeddings|position_embeddings|token_embd|(^|\.)shared\.weight|patch_embed|token_type|class_embedding|cls_token|pos_embed/.test(t.name)) part.embed += n;
		else if (/lm_head|(^|\.)output\.weight$|classifier|(^|\.)score\.|(^|\.)cls\.|pooler|(^|\.)head\./.test(t.name)) part.head += n;
		else if (/norm|ln_f|layernorm/i.test(t.name)) part.finalNorm += n;
		else part.other += n;
	}
	return { exact: !partial, partial, total, dtypes, parts, tensorCount };
}

export interface BlockType {
	moe: boolean;
	count: number;
	first: number;
	stats?: LayerStats;
}

/** Fills sizes a config left out from the tensor shapes of the main stack. */
export function fillFromTensors(spec: ArchSpec, tensors: TensorInfo[]): void {
	const text = tensors.filter((t) => partOf(t.name) === "main" || (spec.family === "encoder" && partOf(t.name) === "encoder"));
	const embed = text.find((t) => /(embed_tokens|wte|tok_embeddings|word_embeddings|token_embd)\.weight$/.test(t.name) && t.shape.length === 2);
	if (embed) {
		spec.hidden ??= Math.min(...embed.shape);
		spec.vocab ??= Math.max(...embed.shape);
	}
	if (!spec.layers) {
		const ids = new Set(text.map((t) => LAYER.exec(t.name)?.[1]).filter(Boolean));
		if (ids.size) spec.layers = ids.size;
	}
	const up = text.find((t) => /(up_proj|fc1|c_fc|w1|ffn_up)\.weight$/.test(t.name) && !/expert/.test(t.name) && t.shape.length === 2);
	if (up && !spec.intermediate) spec.intermediate = up.shape.find((x) => x !== spec.hidden) ?? up.shape[0];
	if (spec.hidden && spec.heads && !spec.headDim) spec.headDim = Math.round(spec.hidden / spec.heads);
}

/** Groups a stack's layers into runs of the same kind (dense / MoE), with average module sizes. */
export function blockTypes(spec: ArchSpec, layersCount: number, part?: PartStats): BlockType[] {
	if (part && part.layers.size) {
		const idx = [...part.layers.keys()].sort((a, b) => a - b);
		const types: BlockType[] = [];
		for (const i of idx) {
			const l = part.layers.get(i)!;
			const moe = l.experts > 0 || l.router > 0;
			const last = types[types.length - 1];
			if (last && last.moe === moe) {
				last.count++;
				const s = last.stats!;
				for (const k of ["attention", "cross", "mlp", "experts", "router", "shared", "norm", "other"] as const) s[k] += l[k];
				for (const e of l.expertIds) s.expertIds.add(e);
			} else types.push({ moe, count: 1, first: i, stats: { ...l, expertIds: new Set(l.expertIds) } });
		}
		for (const t of types) for (const k of ["attention", "cross", "mlp", "experts", "router", "shared", "norm", "other"] as const) t.stats![k] = Math.round(t.stats![k] / t.count);
		// Alternating dense/MoE layers (MoE every k layers) collapse to one block with both kinds noted.
		if (types.length > 4) {
			const moeCount = types.filter((t) => t.moe).reduce((a, t) => a + t.count, 0);
			const avg = (moe: boolean) => types.find((t) => t.moe === moe)?.stats;
			return [{ moe: moeCount > 0, count: idx.length, first: idx[0], stats: avg(true) ?? avg(false) }];
		}
		return types;
	}
	if (spec.moe?.denseLayers && spec.moe.denseLayers > 0 && spec.moe.denseLayers < layersCount)
		return [
			{ moe: false, count: spec.moe.denseLayers, first: 0 },
			{ moe: true, count: layersCount - spec.moe.denseLayers, first: spec.moe.denseLayers },
		];
	return [{ moe: !!spec.moe, count: layersCount, first: 0 }];
}

/** Rough per-module sizes from the config when there are no tensor headers. */
export function estimate(spec: ArchSpec): { embed: number; attention: number; mlp: number; experts: number; shared: number; router: number; norm: number; head: number; posEmbed: number } {
	const h = spec.hidden ?? 0;
	const heads = spec.heads ?? 0;
	const hd = spec.headDim ?? (heads ? h / heads : 0);
	const kv = spec.kvHeads ?? heads;
	const inter = spec.intermediate ?? 4 * h;
	const mats = spec.gated ? 3 : 2;
	const expertInter = spec.moe?.expertIntermediate ?? inter;
	return {
		embed: (spec.vocab ?? 0) * h,
		posEmbed: spec.positional === "learned" ? (spec.context ?? 0) * h : 0,
		attention: h * heads * hd * 2 + 2 * h * kv * hd,
		mlp: mats * h * inter,
		experts: spec.moe ? spec.moe.experts * mats * h * expertInter : 0,
		shared: spec.moe?.shared ? spec.moe.shared * mats * h * (spec.moe.sharedIntermediate ?? expertInter) : 0,
		router: spec.moe ? h * spec.moe.experts : 0,
		norm: (spec.norm === "RMSNorm" ? 1 : 2) * 2 * h,
		head: spec.tied ? 0 : (spec.vocab ?? 0) * h,
	};
}

export function estimateTotal(spec: ArchSpec): number {
	const e = estimate(spec);
	const layers = spec.layers ?? 0;
	const dec = spec.family === "encoder-decoder" ? spec.decoderLayers ?? layers : 0;
	let blocks = 0;
	for (const b of blockTypes(spec, layers)) blocks += b.count * (e.attention + e.norm + (b.moe ? e.experts + e.shared + e.router : e.mlp));
	blocks += dec * (2 * e.attention + 1.5 * e.norm + e.mlp);
	const vision = spec.vision ? estimateTotal(spec.vision) : 0;
	return e.embed + e.posEmbed + blocks + e.head + vision;
}

// ---------------------------------------------------------------- the block diagram

const STYLE = {
	io: "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontStyle=1;",
	embed: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;rounded=1;arcSize=4;",
	attn: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;rounded=1;arcSize=4;",
	mlp: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;rounded=1;arcSize=4;",
	moe: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;rounded=1;arcSize=4;",
	head: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;rounded=1;arcSize=4;",
	norm: "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;",
	router: "rhombus;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=10;",
	block: "rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#fafafa;strokeColor=#6b7280;strokeWidth=2;dashed=0;",
	stack: "rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=none;strokeColor=#9ca3af;dashed=1;",
	edge: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#4b5563;fontSize=10;",
	side: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;dashed=1;strokeColor=#6b7280;fontSize=10;",
};

class Diagram {
	nodes: MapNode[] = [];
	edges: MapEdge[] = [];
	node(n: MapNode): string {
		this.nodes.push(n);
		return n.id;
	}
	table(id: string, label: string, rows: MapRow[], style: string, data: Record<string, string>, parent?: string): string {
		return this.node({ id, label, kind: data.kind ?? "ml:model:module", parent, shape: "table", style, rows: rows.filter((r) => r.text), data });
	}
	box(id: string, label: string, style: string, data: Record<string, string>, parent?: string, size?: { w?: number; h?: number }): string {
		return this.node({ id, label, kind: data.kind ?? "ml:model:module", parent, style, data, width: size?.w, height: size?.h });
	}
	edge(from: string, to: string, label?: string, style = STYLE.edge) {
		this.edges.push({ from, to, label, kind: "flow", style });
	}
}

const p = (n: number | undefined, exact: boolean) => (n ? `${exact ? "" : "≈ "}${fmtCount(n)} params` : "");

function attentionKind(spec: ArchSpec): string {
	if (spec.mla) return "Multi-head latent attention (MLA)";
	const h = spec.heads ?? 0;
	const kv = spec.kvHeads ?? h;
	if (!h) return "Self-attention";
	if (kv === 1 && h > 1) return "Self-attention (MQA)";
	if (kv < h) return `Self-attention (GQA ${h / kv}:1)`;
	return "Self-attention (MHA)";
}

interface StackOptions {
	id: string;
	title: string;
	spec: ArchSpec;
	layers: number;
	part?: PartStats;
	exact: boolean;
	causal: boolean;
	cross?: boolean;
}

/** Draws one stack of repeated blocks; returns the ids of the first and last blocks (for edges) and of the cross-attention nodes. */
function drawStack(d: Diagram, o: StackOptions): { first: string; last: string; cross: string[] } {
	const s = o.spec;
	const e = estimate(s);
	const types = blockTypes(s, o.layers, o.part);
	const ids: string[] = [];
	const cross: string[] = [];
	types.forEach((t, ti) => {
		const bid = `${o.id}:block${ti}`;
		const st = t.stats;
		const kind = t.moe ? "MoE" : "";
		const perLayer = st ? st.attention + st.cross + st.mlp + st.experts + st.router + st.shared + st.norm + st.other : e.attention + e.norm + (t.moe ? e.experts + e.shared + e.router : e.mlp) + (o.cross ? e.attention : 0);
		const range = types.length > 1 ? `  (layers ${t.first}–${t.first + t.count - 1})` : "";
		d.node({
			id: bid,
			label: `${o.title}${kind ? ` (${kind})` : ""} × ${t.count}${range}  ·  ${p(perLayer, o.exact && !!st)}/layer`,
			kind: "ml:model:block",
			container: true,
			style: STYLE.block,
			data: { module: `${o.title} block`, layers: String(t.count), firstLayer: String(t.first), paramsPerLayer: String(perLayer), moe: String(t.moe) },
		});
		ids.push(bid);
		const n1 = d.box(`${bid}:norm1`, `${s.norm ?? "Norm"}`, STYLE.norm, { module: "input norm", norm: s.norm ?? "" }, bid, { w: 130, h: 32 });
		const heads = s.heads ?? 0;
		const kv = s.kvHeads ?? heads;
		const hd = s.headDim ?? 0;
		const h = s.hidden ?? 0;
		const mla = s.mla;
		const attnRows: MapRow[] = mla
			? [
					{ text: heads ? `${heads} heads` : "" },
					{ text: `keys/values compressed to rank ${fmtInt(mla.kvRank)}${mla.ropeDim ? ` (+${mla.ropeDim} RoPE dims)` : ""}` },
					{ text: mla.qRank ? `queries via rank ${fmtInt(mla.qRank)}` : "full-rank queries" },
					{ text: mla.vHeadDim ? `value head dim ${mla.vHeadDim}` : "" },
			  ]
			: [
					{ text: heads ? `${heads} query heads · ${kv} key/value heads` : "" },
					{ text: hd ? `head dim ${hd}` : "" },
					{ text: h && heads && hd ? `q ${fmtInt(h)}→${fmtInt(heads * hd)} · k,v ${fmtInt(h)}→${fmtInt(kv * hd)} · o ${fmtInt(heads * hd)}→${fmtInt(h)}` : "" },
			  ];
		attnRows.push(
			{ text: s.positional === "RoPE" ? `RoPE${s.ropeTheta ? ` θ=${fmtInt(s.ropeTheta)}` : ""}${s.ropeScaling ? ` (${s.ropeScaling})` : ""}` : s.positional && s.positional !== "learned" ? s.positional : "" },
			{ text: o.causal ? "causal mask" : "bidirectional" },
			{ text: s.slidingWindow ? `sliding window ${fmtInt(s.slidingWindow)}` : "" },
			{ text: p(st?.attention ?? e.attention, o.exact && !!st), detail: "per layer" }
		);
		const attn = d.table(`${bid}:attn`, attentionKind(s), attnRows, STYLE.attn, { module: "self-attention", heads: String(heads), kvHeads: String(kv), headDim: String(hd), params: String(st?.attention ?? e.attention) }, bid);
		d.edge(n1, attn);
		let prev = attn;
		if (o.cross) {
			const nx = d.box(`${bid}:normx`, `${s.norm ?? "Norm"}`, STYLE.norm, { module: "cross-attention norm" }, bid, { w: 130, h: 32 });
			const x = d.table(`${bid}:cross`, "Cross-attention", [{ text: heads ? `${heads} heads over the encoder output` : "over the encoder output" }, { text: p(st?.cross || e.attention, o.exact && !!st), detail: "per layer" }], STYLE.attn, { module: "cross-attention", params: String(st?.cross || e.attention) }, bid);
			d.edge(prev, nx);
			d.edge(nx, x);
			cross.push(x);
			prev = x;
		}
		const n2 = d.box(`${bid}:norm2`, `${s.norm ?? "Norm"}`, STYLE.norm, { module: "post-attention norm" }, bid, { w: 130, h: 32 });
		d.edge(prev, n2);
		const act = s.act ? s.act.replace(/_/g, " ") : "";
		if (t.moe && s.moe) {
			const m = s.moe;
			const expertCount = st?.expertIds.size || m.experts;
			const router = d.box(`${bid}:router`, `Router\ntop-${m.topK ?? "k"} of ${expertCount}`, STYLE.router, { module: "router", experts: String(expertCount), topK: String(m.topK ?? ""), params: String(st?.router ?? e.router) }, bid, { w: 120, h: 70 });
			d.edge(n2, router);
			const inter = m.expertIntermediate ?? s.intermediate;
			const expertRows: MapRow[] = [
				{ text: h && inter ? `each ${fmtInt(h)} → ${fmtInt(inter)} → ${fmtInt(h)}${s.gated ? " (gated)" : ""}` : "" },
				{ text: act ? `activation ${act}` : "" },
				{ text: m.topK ? `${m.topK} active per token` : "" },
				{ text: p(st?.experts ?? e.experts, o.exact && !!st), detail: "per layer, all experts" },
				{ text: m.topK && (st?.experts ?? e.experts) ? `${p(((st?.experts ?? e.experts) * m.topK) / expertCount, o.exact && !!st)} active` : "", detail: "per layer" },
			];
			const experts = d.table(`${bid}:experts`, `Experts × ${expertCount}`, expertRows, STYLE.moe, { module: "experts", experts: String(expertCount), intermediate: String(inter ?? ""), params: String(st?.experts ?? e.experts) }, bid);
			d.edge(router, experts, m.topK ? `top-${m.topK}` : undefined);
			if (m.shared || st?.shared) {
				const sharedInter = m.sharedIntermediate ?? inter;
				const shared = d.table(`${bid}:shared`, `Shared expert${(m.shared ?? 1) > 1 ? `s × ${m.shared}` : ""}`, [{ text: h && sharedInter ? `${fmtInt(h)} → ${fmtInt(sharedInter)} → ${fmtInt(h)}` : "" }, { text: "always active" }, { text: p(st?.shared ?? e.shared, o.exact && !!st), detail: "per layer" }], STYLE.mlp, { module: "shared experts", params: String(st?.shared ?? e.shared) }, bid);
				d.edge(n2, shared);
			}
		} else {
			const inter = s.intermediate;
			const mlpRows: MapRow[] = [
				{ text: h && inter ? `${fmtInt(h)} → ${fmtInt(inter)} → ${fmtInt(h)}` : "" },
				{ text: act ? `activation ${act}` : "" },
				{ text: s.gated ? "gate · up · down projections" : "up · down projections" },
				{ text: p(st?.mlp ?? e.mlp, o.exact && !!st), detail: "per layer" },
			];
			const mlp = d.table(`${bid}:mlp`, s.gated ? `MLP (gated ${/gelu/i.test(act) ? "GeGLU" : "SwiGLU"})` : act ? `MLP (${act})` : "MLP", mlpRows, STYLE.mlp, { module: "mlp", intermediate: String(inter ?? ""), activation: act, params: String(st?.mlp ?? e.mlp) }, bid);
			d.edge(n2, mlp);
		}
	});
	for (let i = 0; i + 1 < ids.length; i++) d.edge(ids[i], ids[i + 1]);
	return { first: ids[0], last: ids[ids.length - 1], cross };
}

function headInfo(s: ArchSpec): { title: string; out: string; width?: number } {
	switch (s.head) {
		case "lm":
			return { title: "LM head", out: "Next-token logits" };
		case "mlm":
			return { title: "MLM head", out: "Masked-token logits" };
		case "classifier":
			return { title: "Classification head", out: `Class logits${s.numLabels ? ` (${s.numLabels} labels)` : ""}` };
		case "token-classifier":
			return { title: "Token classification head", out: `Per-token labels${s.numLabels ? ` (${s.numLabels})` : ""}` };
		case "qa":
			return { title: "Span head", out: "Answer start / end logits" };
		default:
			return { title: "Pooler / output", out: s.family === "vision" ? "Image embeddings" : "Hidden states (embeddings)" };
	}
}

/** The whole block diagram for a normalized spec, with parameter counts. */
export function archToGraph(spec: ArchSpec, params?: ParamBreakdown, title?: string): MapGraph {
	const d = new Diagram();
	const exact = !!params?.exact;
	const e = estimate(spec);
	const h = spec.hidden ?? 0;
	// The stack's layers: "model.layers.N" (main), or "encoder.layer.N" for encoder-only models.
	const main = params ? (spec.family !== "encoder-decoder" && !params.parts.main.layers.size && params.parts.encoder.layers.size ? params.parts.encoder : params.parts.main) : undefined;
	const textParts = params ? [params.parts.main, params.parts.encoder, params.parts.decoder] : [];
	const embedParams = textParts.reduce((a, x) => a + x.embed, 0) || e.embed + e.posEmbed;
	const textIn =
		spec.family === "vision"
			? d.box("in:image", `Image ${spec.image?.size ?? "?"}×${spec.image?.size ?? "?"}×${spec.image?.channels ?? 3}`, STYLE.io, { kind: "ml:model:input", module: "input" }, undefined, { w: 180, h: 44 })
			: d.table("in:tokens", "Input tokens", [{ text: spec.vocab ? `vocabulary ${fmtInt(spec.vocab)}` : "" }, { text: spec.context ? `context ${fmtInt(spec.context)}` : "" }], STYLE.embed.replace("#d5e8d4", "#f5f5f5").replace("#82b366", "#666666"), { kind: "ml:model:input", module: "input" });
	let embed: string;
	if (spec.family === "vision") {
		const patches = spec.image?.size && spec.image?.patch ? (spec.image.size / spec.image.patch) ** 2 : undefined;
		embed = d.table("embed", "Patch embedding", [{ text: spec.image?.patch ? `${spec.image.patch}×${spec.image.patch} patches → ${fmtInt(h)}` : "" }, { text: patches ? `${fmtInt(patches)} patches${spec.positional === "learned" ? " + position embeddings" : ""}` : "" }, { text: p(embedParams, exact) }], STYLE.embed, { module: "embedding", params: String(embedParams) });
	} else {
		embed = d.table(
			"embed",
			"Token embedding",
			[
				{ text: spec.vocab && h ? `${fmtInt(spec.vocab)} × ${fmtInt(h)}` : "" },
				{ text: spec.positional === "learned" ? `+ learned positions${spec.context ? ` ${fmtInt(spec.context)} × ${fmtInt(h)}` : ""}` : spec.positional ? `positions: ${spec.positional} (in attention)` : "" },
				{ text: p(embedParams, exact) },
			],
			STYLE.embed,
			{ module: "embedding", vocab: String(spec.vocab ?? ""), hidden: String(h), params: String(embedParams) }
		);
	}
	d.edge(textIn, embed);
	let last = embed;
	const layers = spec.layers ?? 0;
	if (spec.vision) {
		// The vision tower and its projector feed image features into the language model.
		const v = spec.vision;
		const vIn = d.box("vision:in", `Image${v.image?.size ? ` ${v.image.size}×${v.image.size}` : ""}`, STYLE.io, { kind: "ml:model:input", module: "image input" }, undefined, { w: 160, h: 44 });
		const vEmbed = d.table("vision:embed", "Patch embedding", [{ text: v.image?.patch ? `${v.image.patch}×${v.image.patch} patches → ${fmtInt(v.hidden ?? 0)}` : "" }, { text: p(params?.parts.vision.embed || undefined, exact) }], STYLE.embed, { module: "vision patch embedding" });
		d.edge(vIn, vEmbed);
		const vStack = drawStack(d, { id: "vision", title: "Vision encoder block", spec: v, layers: v.layers ?? 0, part: params?.parts.vision, exact, causal: false });
		d.edge(vEmbed, vStack.first);
		const proj = d.table("projector", "Projector", [{ text: v.hidden && h ? `${fmtInt(v.hidden)} → ${fmtInt(h)}` : "" }, { text: p(params?.parts.projector.total || undefined, exact) }], STYLE.head, { module: "multimodal projector", params: String(params?.parts.projector.total ?? "") });
		d.edge(vStack.last, proj);
		d.edge(proj, embed, "image features", STYLE.side);
	}
	if (spec.family === "encoder-decoder") {
		const enc = drawStack(d, { id: "encoder", title: "Encoder block", spec, layers, part: params?.parts.encoder, exact, causal: false });
		d.edge(embed, enc.first);
		const encNorm = d.box("encoder:norm", `${spec.norm ?? "Norm"} (encoder final)`, STYLE.norm, { module: "encoder final norm" }, undefined, { w: 190, h: 32 });
		d.edge(enc.last, encNorm);
		const dec = drawStack(d, { id: "decoder", title: "Decoder block", spec, layers: spec.decoderLayers ?? layers, part: params?.parts.decoder, exact, causal: true, cross: true });
		d.edge(embed, dec.first, "shifted targets");
		for (const x of dec.cross.slice(0, 1)) d.edge(encNorm, x, "encoder states", STYLE.side);
		last = dec.last;
	} else {
		const stack = drawStack(d, { id: "stack", title: spec.family === "decoder" ? "Decoder block" : spec.family === "vision" ? "Encoder block" : "Encoder block", spec, layers, part: main, exact, causal: spec.family === "decoder" });
		d.edge(embed, stack.first);
		last = stack.last;
	}
	const finalNorm = d.box("norm:final", `${spec.norm ?? "Norm"} (final)`, STYLE.norm, { module: "final norm" }, undefined, { w: 160, h: 32 });
	d.edge(last, finalNorm);
	const hi = headInfo(spec);
	const headParams = textParts.reduce((a, x) => a + x.head, 0) || e.head;
	const headRows: MapRow[] = [
		{ text: spec.head === "lm" || spec.head === "mlm" ? (h && spec.vocab ? `${fmtInt(h)} → ${fmtInt(spec.vocab)}` : "") : spec.numLabels && h ? `${fmtInt(h)} → ${spec.numLabels}` : "" },
		{ text: (spec.head === "lm" || spec.head === "mlm") && spec.tied ? "tied to the token embedding" : p(headParams || undefined, exact) },
	];
	const head = d.table("head", hi.title, headRows, STYLE.head, { module: "head", params: String(headParams), tied: String(!!spec.tied) });
	d.edge(finalNorm, head);
	const out = d.box("out", hi.out, STYLE.io, { kind: "ml:model:output", module: "output" }, undefined, { w: 200, h: 44 });
	d.edge(head, out);
	if (spec.adapter) {
		const lora = d.node({ id: "adapter", label: spec.adapter, kind: "ml:model:adapter", shape: "note", style: ML_STYLES.params, width: 240, data: { module: "adapter" } });
		d.edge(lora, "stack:block0", "adapts", STYLE.side);
	}
	const total = params?.total ?? estimateTotal(spec);
	let active: number | undefined;
	if (spec.moe?.topK) {
		const st = main ? [...main.layers.values()].reduce((a, l) => a + l.experts, 0) : undefined;
		const expertsAll = st ?? e.experts * blockTypes(spec, layers).filter((b) => b.moe).reduce((a, b) => a + b.count, 0);
		active = total - expertsAll * (1 - spec.moe.topK / spec.moe.experts);
	}
	const name = spec.name ?? spec.architecture ?? spec.modelType ?? "model";
	const dtypes = params ? Object.entries(params.dtypes).sort((a, b) => b[1] - a[1]).map(([t]) => t) : [];
	return {
		title: title ?? `Model · ${name}`,
		nodes: d.nodes,
		edges: d.edges.filter((x) => d.nodes.some((n) => n.id === x.from) && d.nodes.some((n) => n.id === x.to)),
		direction: "down",
		legend: [
			`${name}${spec.architecture && spec.architecture !== name ? ` (${spec.architecture})` : ""}: ${exact ? "" : "≈ "}${fmtCount(total)} parameters${active ? `, ≈ ${fmtCount(active)} active per token` : ""} — ${params ? (params.partial ? "partly from tensor headers" : `exact, from ${params.tensorCount} tensor headers`) : "estimated from the config"}.`,
			`${spec.family}${spec.layers ? ` · ${spec.layers}${spec.family === "encoder-decoder" ? ` + ${spec.decoderLayers ?? spec.layers}` : ""} layers` : ""}${h ? ` · hidden ${fmtInt(h)}` : ""}${spec.context ? ` · context ${fmtInt(spec.context)}` : ""}${dtypes.length ? ` · ${dtypes.slice(0, 3).join("/")}` : spec.dtype ? ` · ${spec.dtype}` : ""}${spec.quantization ? ` · ${spec.quantization}` : ""}.`,
			`Source: ${spec.source}. Repeated blocks are drawn once with × N; parameter counts are per layer inside blocks.`,
			...spec.notes.map((n) => `Note: ${n}.`),
		],
	};
}

// ---------------------------------------------------------------- ONNX graphs

const ioLabel = (v: { name: string; elemType?: number; shape?: (number | string)[] }) => `${v.name}${v.shape ? ` [${v.shape.join(", ")}]` : ""}${v.elemType ? ` ${ONNX_TYPES[v.elemType] ?? ""}` : ""}`;

/** Segments of a node's scope, e.g. "/model/layers.0/self_attn/q_proj/MatMul" → model, layers, 0, self_attn, q_proj. */
function scopeOf(n: { name: string; op: string; outputs: string[] }): string[] {
	const raw = n.name || n.outputs[0] || n.op;
	const segs = raw.replace(/^\/+/, "").split("/").flatMap((s) => s.split(".")).filter(Boolean);
	return segs.length > 1 ? segs.slice(0, -1) : segs;
}

export function onnxToGraph(m: OnnxModel, fileName: string, maxNodes = 60): MapGraph {
	const d = new Diagram();
	const inits = new Map(m.initializers.map((t) => [t.name, t]));
	const totalParams = m.initializers.reduce((a, t) => a + numel(t.shape), 0);
	const inputs = m.inputs.filter((i) => !inits.has(i.name));
	const producer = new Map<string, number>();
	m.nodes.forEach((n, i) => n.outputs.forEach((o) => producer.set(o, i)));
	const opsetText = m.opsets.map((o) => `${o.domain || "ai.onnx"} v${o.version}`).join(", ");
	// One group per node when small, else groups by name scope with repeated layers collapsed.
	let groupOf: (i: number) => string;
	const groupInfo = new Map<string, { label: string; nodes: number[]; repeats: Set<string> }>();
	if (m.nodes.length <= maxNodes) {
		groupOf = (i) => `n${i}`;
		m.nodes.forEach((n, i) => groupInfo.set(`n${i}`, { label: n.op, nodes: [i], repeats: new Set() }));
	} else {
		const scopes = m.nodes.map(scopeOf);
		const keyAt = (segs: string[], depth: number) => {
			const out: string[] = [];
			const reps: string[] = [];
			for (let k = 0; k < segs.length && out.length < depth + reps.length; k++) {
				if (/^\d+$/.test(segs[k])) {
					out.push("#");
					reps.push(segs[k]);
				} else out.push(segs[k]);
			}
			// A layer number right after the prefix is always part of the key.
			const next = segs[out.length];
			if (next !== undefined && /^\d+$/.test(next)) {
				out.push("#");
				reps.push(next);
			}
			return { key: out.join("/"), reps };
		};
		let depth = 1;
		for (let dd = 1; dd <= 6; dd++) {
			const keys = new Set(scopes.map((s) => keyAt(s, dd).key));
			if (keys.size <= 40) depth = dd;
			else break;
		}
		const keys = scopes.map((s) => keyAt(s, depth));
		groupOf = (i) => `g:${keys[i].key}`;
		keys.forEach((k, i) => {
			const id = `g:${k.key}`;
			if (!groupInfo.has(id)) groupInfo.set(id, { label: k.key.replace(/#/g, "N"), nodes: [], repeats: new Set() });
			const g = groupInfo.get(id)!;
			g.nodes.push(i);
			if (k.reps.length) g.repeats.add(k.reps[0]);
		});
	}
	// Too many groups even so: keep the biggest.
	const groups = [...groupInfo.entries()].sort((a, b) => b[1].nodes.length - a[1].nodes.length);
	const shown = new Set(groups.slice(0, 80).map(([id]) => id));
	const hidden = groups.length - shown.size;
	for (const [id, g] of groups) {
		if (!shown.has(id)) continue;
		const ops = new Map<string, number>();
		const weights = new Set<string>();
		for (const i of g.nodes) {
			ops.set(m.nodes[i].op, (ops.get(m.nodes[i].op) ?? 0) + 1);
			for (const inp of m.nodes[i].inputs) if (inits.has(inp)) weights.add(inp);
		}
		const params = [...weights].reduce((a, w) => a + numel(inits.get(w)!.shape), 0);
		const reps = g.repeats.size;
		if (g.nodes.length === 1 && m.nodes.length <= maxNodes) {
			const n = m.nodes[g.nodes[0]];
			const w = [...weights].map((x) => inits.get(x)!);
			d.node({
				id,
				label: n.op,
				kind: "ml:onnx:node",
				...(w.length ? { shape: "table" as const, rows: [...w.slice(0, 4).map((t) => ({ text: `${t.name.split(/[/.]/).slice(-2).join(".")} [${t.shape.join("×")}]`, detail: t.dtype })), ...(w.length > 4 ? [{ text: `… ${w.length - 4} more weights` }] : [])], style: STYLE.attn } : { style: ML_STYLES.step }),
				data: { op: n.op, name: n.name, inputs: n.inputs.join(", ").slice(0, 400), outputs: n.outputs.join(", ").slice(0, 400), ...(params ? { params: String(params) } : {}) },
			});
		} else {
			const topOps = [...ops].sort((a, b) => b[1] - a[1]).slice(0, 5);
			d.node({
				id,
				label: `${g.label}${reps > 1 ? ` × ${reps}` : ""}`,
				kind: "ml:onnx:group",
				shape: "table",
				style: reps > 1 ? STYLE.mlp : STYLE.attn,
				rows: [
					...topOps.map(([op, c]) => ({ text: `${op} × ${reps > 1 ? Math.round(c / reps) : c}`, detail: reps > 1 ? "per repeat" : undefined })),
					...(ops.size > 5 ? [{ text: `… ${ops.size - 5} more op types` }] : []),
					...(params ? [{ text: `${fmtCount(reps > 1 ? params / reps : params)} params${reps > 1 ? " per repeat" : ""}` }] : []),
				],
				data: { scope: g.label, nodes: String(g.nodes.length), ...(reps > 1 ? { repeats: String(reps) } : {}), ops: [...ops].map(([o, c]) => `${o}:${c}`).join(" ").slice(0, 400), params: String(params) },
			});
		}
	}
	const seen = new Set<string>();
	const link = (from: string, to: string, label?: string) => {
		const k = `${from}\u0000${to}`;
		if (from === to || seen.has(k) || !shown.has(from) && !from.startsWith("io:") || !shown.has(to) && !to.startsWith("io:")) return;
		seen.add(k);
		d.edge(from, to, label);
	};
	inputs.forEach((v, i) => d.box(`io:in${i}`, ioLabel(v), STYLE.io, { kind: "ml:model:input", tensor: v.name }, undefined, { w: Math.min(280, Math.max(140, ioLabel(v).length * 7 + 20)), h: 40 }));
	m.outputs.forEach((v, i) => d.box(`io:out${i}`, ioLabel(v), STYLE.io, { kind: "ml:model:output", tensor: v.name }, undefined, { w: Math.min(280, Math.max(140, ioLabel(v).length * 7 + 20)), h: 40 }));
	const inputIdx = new Map(inputs.map((v, i) => [v.name, i]));
	m.nodes.forEach((n, i) => {
		const to = groupOf(i);
		for (const inp of n.inputs) {
			if (inputIdx.has(inp)) link(`io:in${inputIdx.get(inp)}`, to);
			const src = producer.get(inp);
			if (src !== undefined) link(groupOf(src), to);
		}
	});
	m.outputs.forEach((v, i) => {
		const src = producer.get(v.name);
		if (src !== undefined) link(groupOf(src), `io:out${i}`);
	});
	return {
		title: `ONNX · ${m.graphName || fileName}`,
		nodes: d.nodes,
		edges: d.edges,
		direction: "down",
		legend: [
			`${fileName}: ${m.nodes.length} ops, ${m.initializers.length} weight tensors, ${fmtCount(totalParams)} parameters.`,
			`${m.producer ? `Exported by ${m.producer} ${m.producerVersion ?? ""}`.trim() + ". " : ""}${opsetText ? `Opsets: ${opsetText}.` : ""}`,
			m.nodes.length > maxNodes ? `Ops are grouped by their name scope; repeated layers are drawn once (× N).${hidden ? ` ${hidden} small group(s) not drawn.` : ""}` : "One shape per op; tables list the weights they use.",
		],
	};
}

// ---------------------------------------------------------------- tree ensembles

export function treesToGraph(t: TreeEnsemble, fileName: string): MapGraph {
	const d = new Diagram();
	const feats = t.features.length ? t.features : [];
	const inp = d.table("in:features", `Input features (${t.featureCount ?? feats.length})`, [...feats.slice(0, 15).map((f) => ({ text: f })), ...(feats.length > 15 ? [{ text: `… ${feats.length - 15} more` }] : []), ...(feats.length === 0 ? [{ text: "feature names not saved" }] : [])], STYLE.embed, { kind: "ml:model:input", module: "features", features: feats.join(", ").slice(0, 1000) });
	const ens = d.table(
		"ensemble",
		`${t.library} gradient-boosted trees`,
		[
			{ text: `${fmtInt(t.trees)} trees`, detail: t.booster },
			{ text: t.maxDepth ? `max depth ${t.maxDepth}` : "" },
			{ text: t.avgNodes ? `≈ ${t.avgNodes} nodes per tree` : "" },
			{ text: t.avgLeaves ? `≈ ${t.avgLeaves} leaves per tree` : "" },
			{ text: t.classes && t.classes > 1 ? `${t.classes} classes (one tree per class per round)` : "" },
			{ text: t.baseScore ? `base score ${t.baseScore}` : "" },
		],
		STYLE.mlp,
		{ module: "ensemble", library: t.library, trees: String(t.trees), ...(t.version ? { version: t.version } : {}) }
	);
	const obj = d.box("objective", `Objective\n${t.objective ?? "?"}`, STYLE.head.replace(/^swimlane;.*?html=1;/, "rounded=1;whiteSpace=wrap;html=1;"), { module: "objective", objective: t.objective ?? "" }, undefined, { w: 190, h: 50 });
	const out = d.box("out", /binary|logistic|cross_?entropy|sigmoid/i.test(t.objective ?? "") ? "Probability" : /multi|softmax/i.test(t.objective ?? "") ? "Class probabilities" : /rank/i.test(t.objective ?? "") ? "Ranking score" : "Prediction", STYLE.io, { kind: "ml:model:output", module: "output" }, undefined, { w: 170, h: 44 });
	d.edge(inp, ens);
	d.edge(ens, obj, "sum of leaf values");
	d.edge(obj, out);
	return { title: `${t.library} · ${fileName}`, nodes: d.nodes, edges: d.edges, direction: "down", legend: [`${fileName}: ${t.library}${t.version ? ` ${t.version}` : ""}, ${fmtInt(t.trees)} trees, ${t.featureCount ?? feats.length} features.`] };
}
