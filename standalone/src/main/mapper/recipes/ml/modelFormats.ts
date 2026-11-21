/**
 * Readers for model files, header/metadata only: safetensors headers, GGUF
 * metadata and tensor infos, ONNX graphs (a small protobuf reader that skips
 * weight bytes), XGBoost JSON and LightGBM text/JSON models. Nothing here
 * loads weights or runs code from the files (pickles are never opened).
 */
import * as fs from "fs";
import { MapperError } from "../../types";

/** Random access to bytes of a file (read in chunks) or of a buffer. */
export class ByteSource {
	private cache = Buffer.alloc(0);
	private cacheStart = 0;
	private constructor(private fd: number | undefined, private buf: Buffer | undefined, public readonly size: number) {}

	static file(p: string): ByteSource {
		const fd = fs.openSync(p, "r");
		return new ByteSource(fd, undefined, fs.fstatSync(fd).size);
	}

	static buffer(b: Buffer, size = b.length): ByteSource {
		return new ByteSource(undefined, b, size);
	}

	/** Bytes [pos, pos+len). Throws a RangeError past what is available. */
	bytes(pos: number, len: number): Buffer {
		if (len < 0 || pos < 0) throw new RangeError("negative read");
		if (this.buf) {
			if (pos + len > this.buf.length) throw new RangeError(`read past ${this.buf.length} bytes`);
			return this.buf.subarray(pos, pos + len);
		}
		if (pos + len > this.size) throw new RangeError(`read past the end of the file`);
		if (pos >= this.cacheStart && pos + len <= this.cacheStart + this.cache.length) return this.cache.subarray(pos - this.cacheStart, pos - this.cacheStart + len);
		const want = Math.min(Math.max(len, 1 << 20), this.size - pos);
		const b = Buffer.alloc(want);
		const n = fs.readSync(this.fd!, b, 0, want, pos);
		this.cache = b.subarray(0, n);
		this.cacheStart = pos;
		if (n < len) throw new RangeError("short read");
		return this.cache.subarray(0, len);
	}

	close(): void {
		if (this.fd !== undefined) fs.closeSync(this.fd);
		this.fd = undefined;
	}
}

export interface TensorInfo {
	name: string;
	shape: number[];
	dtype: string;
}

export const numel = (shape: number[]) => shape.reduce((a, b) => a * b, 1);

// ---------------------------------------------------------------- safetensors

export interface SafetensorsHeader {
	tensors: TensorInfo[];
	metadata: Record<string, string>;
	headerBytes: number;
}

/** Parses the JSON header of a safetensors file: u64 little-endian length, then JSON. */
export function parseSafetensorsHeader(src: ByteSource): SafetensorsHeader {
	const n = Number(src.bytes(0, 8).readBigUInt64LE(0));
	if (!Number.isSafeInteger(n) || n <= 1 || n > 200_000_000) throw new MapperError("Not a safetensors file (bad header length).");
	const json = JSON.parse(src.bytes(8, n).toString("utf8"));
	const tensors: TensorInfo[] = [];
	let metadata: Record<string, string> = {};
	for (const [name, v] of Object.entries<any>(json)) {
		if (name === "__metadata__") metadata = v ?? {};
		else if (v && Array.isArray(v.shape)) tensors.push({ name, shape: v.shape.map(Number), dtype: String(v.dtype ?? "?") });
	}
	return { tensors, metadata, headerBytes: n + 8 };
}

// ---------------------------------------------------------------- GGUF

export const GGML_TYPES: Record<number, string> = {
	0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K",
	16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M", 30: "BF16", 34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4",
};

export const GGUF_FILE_TYPES: Record<number, string> = {
	0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K",
	19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "TQ1_0", 37: "TQ2_0", 38: "MXFP4_MOE",
};

/** An array value too long to keep: its element type and length. */
export interface GgufArraySummary {
	arrayOf: number;
	length: number;
	head: unknown[];
}

export interface GgufFile {
	version: number;
	metadata: Record<string, unknown>;
	tensors: TensorInfo[];
}

class Cursor {
	constructor(public src: ByteSource, public pos = 0) {}
	take(n: number): Buffer {
		const b = this.src.bytes(this.pos, n);
		this.pos += n;
		return b;
	}
	u8 = () => this.take(1).readUInt8(0);
	i8 = () => this.take(1).readInt8(0);
	u16 = () => this.take(2).readUInt16LE(0);
	i16 = () => this.take(2).readInt16LE(0);
	u32 = () => this.take(4).readUInt32LE(0);
	i32 = () => this.take(4).readInt32LE(0);
	u64 = () => Number(this.take(8).readBigUInt64LE(0));
	i64 = () => Number(this.take(8).readBigInt64LE(0));
	f32 = () => this.take(4).readFloatLE(0);
	f64 = () => this.take(8).readDoubleLE(0);
	str = () => {
		const n = this.u64();
		if (n > 50_000_000) throw new MapperError("GGUF string too long; the file looks corrupt.");
		return this.take(n).toString("utf8");
	};
}

const GGUF_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function ggufValue(c: Cursor, type: number, depth = 0): unknown {
	switch (type) {
		case 0: return c.u8();
		case 1: return c.i8();
		case 2: return c.u16();
		case 3: return c.i16();
		case 4: return c.u32();
		case 5: return c.i32();
		case 6: return c.f32();
		case 7: return c.u8() !== 0;
		case 8: return c.str();
		case 10: return c.u64();
		case 11: return c.i64();
		case 12: return c.f64();
		case 9: {
			const of = c.u32();
			const n = c.u64();
			if (depth > 3) throw new MapperError("GGUF arrays nested too deeply.");
			if (n <= 64) return Array.from({ length: n }, () => ggufValue(c, of, depth + 1));
			// Long arrays (tokenizer vocabularies, merges): keep the length and a few values.
			const head: unknown[] = [];
			if (GGUF_SIZES[of] !== undefined) {
				for (let i = 0; i < 4; i++) head.push(ggufValue(c, of, depth + 1));
				c.pos += (n - 4) * GGUF_SIZES[of];
			} else {
				for (let i = 0; i < n; i++) {
					const v = ggufValue(c, of, depth + 1);
					if (i < 4) head.push(v);
				}
			}
			return { arrayOf: of, length: n, head } satisfies GgufArraySummary;
		}
		default:
			throw new MapperError(`Unknown GGUF value type ${type}.`);
	}
}

/** Reads the GGUF header: metadata key/values and tensor infos (names, shapes, types). */
export function parseGguf(src: ByteSource): GgufFile {
	const c = new Cursor(src);
	if (c.take(4).toString("latin1") !== "GGUF") throw new MapperError("Not a GGUF file.");
	const version = c.u32();
	if (version < 2 || version > 3) throw new MapperError(`GGUF version ${version} is not supported.`);
	const tensorCount = c.u64();
	const kvCount = c.u64();
	if (tensorCount > 1_000_000 || kvCount > 100_000) throw new MapperError("GGUF header counts look corrupt.");
	const metadata: Record<string, unknown> = {};
	for (let i = 0; i < kvCount; i++) {
		const key = c.str();
		metadata[key] = ggufValue(c, c.u32());
	}
	const tensors: TensorInfo[] = [];
	for (let i = 0; i < tensorCount; i++) {
		const name = c.str();
		const dims = c.u32();
		const shape = Array.from({ length: dims }, () => c.u64()).reverse();
		const type = c.u32();
		c.u64(); // offset
		tensors.push({ name, shape, dtype: GGML_TYPES[type] ?? `type${type}` });
	}
	return { version, metadata, tensors };
}

// ---------------------------------------------------------------- ONNX (protobuf)

/** Bounded protobuf reader over a ByteSource; skipped fields are never read. */
class Proto {
	constructor(public src: ByteSource, public pos: number, public end: number) {}
	get done() {
		return this.pos >= this.end;
	}
	varint(): number {
		let result = 0;
		let mul = 1;
		for (let i = 0; i < 10; i++) {
			const b = this.src.bytes(this.pos++, 1)[0];
			result += (b & 0x7f) * mul;
			if (!(b & 0x80)) return result;
			mul *= 128;
		}
		throw new MapperError("Bad protobuf varint; not an ONNX model?");
	}
	/** Next field: number, wire type, and for length-delimited fields their bounds. */
	next(): { field: number; wt: number; start: number; len: number } {
		const tag = this.varint();
		const field = Math.floor(tag / 8);
		const wt = tag & 7;
		let start = this.pos;
		let len = 0;
		if (wt === 0) {
			this.varint();
			len = this.pos - start;
			this.pos = start; // the caller reads it
		} else if (wt === 1) len = 8;
		else if (wt === 5) len = 4;
		else if (wt === 2) {
			len = this.varint();
			start = this.pos;
		} else throw new MapperError(`Unsupported protobuf wire type ${wt}; not an ONNX model?`);
		if (start + len > this.end) throw new MapperError("Truncated protobuf message; not an ONNX model?");
		return { field, wt, start, len };
	}
	skip(f: { wt: number; start: number; len: number }) {
		this.pos = f.start + f.len;
	}
	string(f: { start: number; len: number }): string {
		this.pos = f.start + f.len;
		return this.src.bytes(f.start, f.len).toString("utf8");
	}
	sub(f: { start: number; len: number }): Proto {
		this.pos = f.start + f.len;
		return new Proto(this.src, f.start, f.start + f.len);
	}
}

export interface OnnxNode {
	name: string;
	op: string;
	domain?: string;
	inputs: string[];
	outputs: string[];
}

export interface OnnxValue {
	name: string;
	elemType?: number;
	shape?: (number | string)[];
}

export interface OnnxModel {
	irVersion?: number;
	producer?: string;
	producerVersion?: string;
	opsets: { domain: string; version: number }[];
	graphName?: string;
	nodes: OnnxNode[];
	initializers: TensorInfo[];
	inputs: OnnxValue[];
	outputs: OnnxValue[];
	metadata: Record<string, string>;
}

export const ONNX_TYPES: Record<number, string> = { 1: "float32", 2: "uint8", 3: "int8", 4: "uint16", 5: "int16", 6: "int32", 7: "int64", 8: "string", 9: "bool", 10: "float16", 11: "float64", 12: "uint32", 13: "uint64", 16: "bfloat16", 17: "float8e4m3", 21: "uint4", 22: "int4" };

function onnxValueInfo(p: Proto): OnnxValue {
	const v: OnnxValue = { name: "" };
	while (!p.done) {
		const f = p.next();
		if (f.field === 1 && f.wt === 2) v.name = p.string(f);
		else if (f.field === 2 && f.wt === 2) {
			const type = p.sub(f);
			while (!type.done) {
				const tf = type.next();
				if (tf.field !== 1 || tf.wt !== 2) {
					type.skip(tf);
					continue;
				}
				const tensor = type.sub(tf);
				while (!tensor.done) {
					const xf = tensor.next();
					if (xf.field === 1 && xf.wt === 0) v.elemType = tensor.varint();
					else if (xf.field === 2 && xf.wt === 2) {
						const shape = tensor.sub(xf);
						v.shape = [];
						while (!shape.done) {
							const df = shape.next();
							if (df.field !== 1 || df.wt !== 2) {
								shape.skip(df);
								continue;
							}
							const dim = shape.sub(df);
							let d: number | string = "?";
							while (!dim.done) {
								const ef = dim.next();
								if (ef.field === 1 && ef.wt === 0) d = dim.varint();
								else if (ef.field === 2 && ef.wt === 2) d = dim.string(ef);
								else dim.skip(ef);
							}
							v.shape.push(d);
						}
					} else tensor.skip(xf);
				}
			}
		} else p.skip(f);
	}
	return v;
}

function onnxTensorInfo(p: Proto): TensorInfo {
	const t: TensorInfo = { name: "", shape: [], dtype: "?" };
	while (!p.done) {
		const f = p.next();
		if (f.field === 1 && f.wt === 0) t.shape.push(p.varint());
		else if (f.field === 1 && f.wt === 2) {
			const packed = p.sub(f);
			while (!packed.done) t.shape.push(packed.varint());
		} else if (f.field === 2 && f.wt === 0) t.dtype = ONNX_TYPES[p.varint()] ?? "?";
		else if (f.field === 8 && f.wt === 2) t.name = p.string(f);
		else p.skip(f); // raw_data and typed data are skipped, never read
	}
	return t;
}

function onnxNode(p: Proto): OnnxNode {
	const n: OnnxNode = { name: "", op: "", inputs: [], outputs: [] };
	while (!p.done) {
		const f = p.next();
		if (f.wt !== 2) {
			if (f.wt === 0) p.varint();
			else p.skip(f);
			continue;
		}
		if (f.field === 1) n.inputs.push(p.string(f));
		else if (f.field === 2) n.outputs.push(p.string(f));
		else if (f.field === 3) n.name = p.string(f);
		else if (f.field === 4) n.op = p.string(f);
		else if (f.field === 7) n.domain = p.string(f);
		else p.skip(f);
	}
	return n;
}

/** Reads an ONNX ModelProto: graph nodes, initializer shapes, inputs and outputs. */
export function parseOnnx(src: ByteSource): OnnxModel {
	const m: OnnxModel = { opsets: [], nodes: [], initializers: [], inputs: [], outputs: [], metadata: {} };
	const top = new Proto(src, 0, src.size);
	let sawGraph = false;
	while (!top.done) {
		const f = top.next();
		if (f.wt === 0) {
			const v = top.varint();
			if (f.field === 1) m.irVersion = v;
			continue;
		}
		if (f.wt !== 2) {
			top.skip(f);
			continue;
		}
		if (f.field === 2) m.producer = top.string(f);
		else if (f.field === 3) m.producerVersion = top.string(f);
		else if (f.field === 8) {
			const o = top.sub(f);
			const opset = { domain: "", version: 0 };
			while (!o.done) {
				const of = o.next();
				if (of.field === 1 && of.wt === 2) opset.domain = o.string(of);
				else if (of.field === 2 && of.wt === 0) opset.version = o.varint();
				else o.skip(of);
			}
			m.opsets.push(opset);
		} else if (f.field === 14) {
			const e = top.sub(f);
			let k = "";
			let v = "";
			while (!e.done) {
				const ef = e.next();
				if (ef.field === 1 && ef.wt === 2) k = e.string(ef);
				else if (ef.field === 2 && ef.wt === 2) v = e.string(ef);
				else e.skip(ef);
			}
			if (k) m.metadata[k] = v.slice(0, 500);
		} else if (f.field === 7) {
			sawGraph = true;
			const g = top.sub(f);
			while (!g.done) {
				const gf = g.next();
				if (gf.wt !== 2) {
					if (gf.wt === 0) g.varint();
					else g.skip(gf);
					continue;
				}
				if (gf.field === 1) m.nodes.push(onnxNode(g.sub(gf)));
				else if (gf.field === 2) m.graphName = g.string(gf);
				else if (gf.field === 5) m.initializers.push(onnxTensorInfo(g.sub(gf)));
				else if (gf.field === 11) m.inputs.push(onnxValueInfo(g.sub(gf)));
				else if (gf.field === 12) m.outputs.push(onnxValueInfo(g.sub(gf)));
				else g.skip(gf);
			}
		} else top.skip(f);
	}
	if (!sawGraph) throw new MapperError("No graph in this file; not an ONNX model?");
	return m;
}

// ---------------------------------------------------------------- gradient-boosted trees

export interface TreeEnsemble {
	library: "XGBoost" | "LightGBM";
	version?: string;
	booster?: string;
	objective?: string;
	trees: number;
	classes?: number;
	features: string[];
	featureCount?: number;
	avgNodes?: number;
	maxDepth?: number;
	avgLeaves?: number;
	baseScore?: string;
}

function xgbDepth(tree: any): number {
	const left: number[] = tree?.left_children ?? [];
	const right: number[] = tree?.right_children ?? [];
	if (!left.length) return 0;
	let max = 0;
	const stack: [number, number][] = [[0, 0]];
	while (stack.length) {
		const [n, d] = stack.pop()!;
		max = Math.max(max, d);
		if (left[n] !== undefined && left[n] >= 0) stack.push([left[n], d + 1]);
		if (right[n] !== undefined && right[n] >= 0) stack.push([right[n], d + 1]);
	}
	return max;
}

/** XGBoost's JSON model format (save_model("model.json")). */
export function parseXgboostJson(doc: any): TreeEnsemble | undefined {
	const learner = doc?.learner;
	if (!learner?.gradient_booster) return undefined;
	const gb = learner.gradient_booster;
	const model = gb.model ?? gb.gbtree?.model ?? {};
	const trees: any[] = model.trees ?? [];
	const sample = trees.slice(0, 200);
	return {
		library: "XGBoost",
		version: Array.isArray(doc.version) ? doc.version.join(".") : undefined,
		booster: String(gb.name ?? ""),
		objective: learner.objective?.name ? String(learner.objective.name) : undefined,
		trees: Number(model.gbtree_model_param?.num_trees ?? trees.length) || trees.length,
		classes: Number(learner.learner_model_param?.num_class ?? 0) || undefined,
		features: (learner.feature_names ?? []).map(String),
		featureCount: Number(learner.learner_model_param?.num_feature) || undefined,
		avgNodes: sample.length ? Math.round(sample.reduce((a, t) => a + Number(t?.tree_param?.num_nodes ?? 0), 0) / sample.length) : undefined,
		maxDepth: sample.length ? Math.max(...sample.map(xgbDepth)) : undefined,
		baseScore: learner.learner_model_param?.base_score ? String(learner.learner_model_param.base_score) : undefined,
	};
}

/** LightGBM's text model (model.txt) or its dump_model() JSON. */
export function parseLightgbm(text: string): TreeEnsemble | undefined {
	const t = text.trimStart();
	if (t.startsWith("{")) {
		let doc: any;
		try {
			doc = JSON.parse(t);
		} catch {
			return undefined;
		}
		if (doc?.name !== "tree" || !Array.isArray(doc?.tree_info)) return undefined;
		const leaves = doc.tree_info.map((x: any) => Number(x?.num_leaves ?? 0));
		return {
			library: "LightGBM",
			version: doc.version,
			objective: doc.objective,
			trees: doc.tree_info.length,
			classes: Number(doc.num_class) || undefined,
			features: (doc.feature_names ?? []).map(String),
			featureCount: Number(doc.max_feature_idx) + 1 || undefined,
			avgLeaves: leaves.length ? Math.round(leaves.reduce((a: number, b: number) => a + b, 0) / leaves.length) : undefined,
		};
	}
	if (!/^tree\r?\nversion=/.test(t)) return undefined;
	const header = t.split(/\r?\nTree=0\r?\n/)[0];
	const kv = Object.fromEntries(
		header
			.split(/\r?\n/)
			.map((l) => /^([\w_]+)=(.*)$/.exec(l))
			.filter((m): m is RegExpExecArray => !!m)
			.map((m) => [m[1], m[2]])
	);
	const leaves = [...t.matchAll(/^num_leaves=(\d+)/gm)].map((m) => Number(m[1]));
	return {
		library: "LightGBM",
		version: kv.version,
		objective: kv.objective,
		trees: (t.match(/^Tree=\d+/gm) ?? []).length,
		classes: Number(kv.num_class) || undefined,
		features: kv.feature_names ? kv.feature_names.split(" ") : [],
		featureCount: kv.max_feature_idx !== undefined ? Number(kv.max_feature_idx) + 1 : undefined,
		avgLeaves: leaves.length ? Math.round(leaves.reduce((a, b) => a + b, 0) / leaves.length) : undefined,
	};
}
