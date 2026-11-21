import { activeFindings, MapRecord } from "./store";
import type { MapEdge, MapGraph, MapNode } from "./types";

/**
 * Lookups over stored maps, for the agent (MCP tools) and the app: find, show,
 * path, the description worksheet and its validation, tours and Ask pages.
 * No Electron: unit-testable.
 */

export interface NodeRef {
	mapId: string;
	id: string;
	label: string;
	kind: string;
}

const lc = (s: string) => s.toLowerCase();
const ref = (r: MapRecord, n: MapNode): NodeRef => ({ mapId: r.id, id: n.id, label: n.label, kind: n.kind });

/** Nodes whose label, kind, id, data or files contain every word of the query. */
export function findNodes(records: MapRecord[], query: string, limit = 50): NodeRef[] {
	const words = lc(query).split(/\s+/).filter(Boolean);
	const out: NodeRef[] = [];
	for (const r of records) {
		for (const n of r.graph.nodes) {
			const hay = lc([n.label, n.kind, n.id, ...Object.values(n.data ?? {}), ...(n.files ?? []), r.descriptions[n.id]?.description ?? ""].join(" "));
			if (words.every((w) => hay.includes(w))) out.push(ref(r, n));
			if (out.length >= limit) return out;
		}
	}
	return out;
}

/** Everything the map knows about one node: where it sits, what it uses, what uses it, findings. */
export function showNode(r: MapRecord, id: string) {
	const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
	const n = byId.get(id);
	if (!n) return undefined;
	const chain: string[] = [];
	for (let p = n.parent, guard = 0; p && byId.has(p) && guard < 30; p = byId.get(p)!.parent, guard++) chain.push(byId.get(p)!.label);
	const label = (x: string) => byId.get(x)?.label ?? x;
	const edge = (e: MapEdge, other: string) => ({ id: other, label: label(other), via: e.label ?? e.kind ?? "" });
	return {
		mapId: r.id,
		id: n.id,
		label: n.label,
		kind: n.kind,
		inside: chain.reverse(),
		contains: r.graph.nodes.filter((c) => c.parent === n.id).map((c) => ({ id: c.id, label: c.label, kind: c.kind })),
		uses: r.graph.edges.filter((e) => e.from === n.id).map((e) => edge(e, e.to)),
		usedBy: r.graph.edges.filter((e) => e.to === n.id).map((e) => edge(e, e.from)),
		rows: n.rows?.map((x) => `${x.key ? x.key + " " : ""}${x.text}${x.detail ? ` (${x.detail})` : ""}`),
		data: n.data,
		files: n.files,
		description: r.descriptions[n.id]?.description,
		findings: activeFindings(r).filter((f) => f.nodeIds.includes(n.id)),
	};
}

/** Shortest chain of edges between two nodes (either direction), with each hop's label. */
export function findPath(r: MapRecord, from: string, to: string, maxHops = 12): { id: string; label: string; via?: string; dir?: "→" | "←" }[] | undefined {
	const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
	if (!byId.has(from) || !byId.has(to)) return undefined;
	const adj = new Map<string, { to: string; via?: string; dir: "→" | "←" }[]>();
	const add = (a: string, b: string, via: string | undefined, dir: "→" | "←") => {
		if (!adj.has(a)) adj.set(a, []);
		adj.get(a)!.push({ to: b, via, dir });
	};
	for (const e of r.graph.edges) {
		add(e.from, e.to, e.label ?? e.kind, "→");
		add(e.to, e.from, e.label ?? e.kind, "←");
	}
	const prev = new Map<string, { from: string; via?: string; dir: "→" | "←" }>();
	const queue = [from];
	const depth = new Map([[from, 0]]);
	while (queue.length) {
		const cur = queue.shift()!;
		if (cur === to) break;
		if (depth.get(cur)! >= maxHops) continue;
		for (const nb of adj.get(cur) ?? []) {
			if (depth.has(nb.to)) continue;
			depth.set(nb.to, depth.get(cur)! + 1);
			prev.set(nb.to, { from: cur, via: nb.via, dir: nb.dir });
			queue.push(nb.to);
		}
	}
	if (!depth.has(to)) return undefined;
	const steps: { id: string; label: string; via?: string; dir?: "→" | "←" }[] = [];
	for (let cur: string | undefined = to; cur; ) {
		const p = prev.get(cur);
		steps.unshift({ id: cur, label: byId.get(cur)!.label, via: p?.via, dir: p?.dir });
		cur = p?.from;
	}
	return steps;
}

// ----- plain-English descriptions -----

/** Words that mean nothing to someone who doesn't write code (floorplan's "everyone" audience). */
const JARGON = /\b(api|sdk|orm|crud|rpc|grpc|dto|middleware|endpoint|handler|singleton|repository|schema|payload|serializ\w*|async|callback|webhook|lambda|vpc|subnet|cidr|k8s|kubernetes|pod|ingress|iam|arn|nat|dns|tls|jwt|oauth|cron|regex|json|yaml|sql|nosql|etl|ci\/cd|pipeline)\b/i;

export interface WorksheetEntry {
	id: string;
	label: string;
	kind: string;
	inside?: string;
	uses?: string[];
	usedBy?: string[];
	files?: string[];
	facts?: string;
	current?: string;
}

/**
 * What the agent needs to describe each shape from evidence rather than names:
 * where it sits, who uses it and what it uses, its files and key facts.
 * `only` limits it to nodes without a description (or listed ids).
 */
export function worksheet(r: MapRecord, opts: { only?: "missing" | string[]; offset?: number; limit?: number } = {}): { entries: WorksheetEntry[]; total: number; next?: number } {
	const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
	let nodes = r.graph.nodes.filter((n) => n.kind !== "legend");
	if (opts.only === "missing") nodes = nodes.filter((n) => !r.descriptions[n.id]);
	else if (Array.isArray(opts.only)) {
		const want = new Set(opts.only);
		nodes = nodes.filter((n) => want.has(n.id));
	}
	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? 60;
	const page = nodes.slice(offset, offset + limit);
	const name = (id: string) => byId.get(id)?.label ?? id;
	const entries = page.map((n): WorksheetEntry => {
		const facts = [
			...Object.entries(n.data ?? {})
				.filter(([k]) => !["mapRoot"].includes(k))
				.slice(0, 12)
				.map(([k, v]) => `${k}=${String(v).slice(0, 120)}`),
			...(n.rows ?? []).slice(0, 12).map((x) => `${x.key ? x.key + " " : ""}${x.text}${x.detail ? ` ${x.detail}` : ""}`),
		].join("; ");
		return {
			id: n.id,
			label: n.label,
			kind: n.kind,
			inside: n.parent ? name(n.parent) : undefined,
			uses: r.graph.edges.filter((e) => e.from === n.id).slice(0, 15).map((e) => `${name(e.to)}${e.label ? ` (${e.label})` : ""}`),
			usedBy: r.graph.edges.filter((e) => e.to === n.id).slice(0, 15).map((e) => `${name(e.from)}${e.label ? ` (${e.label})` : ""}`),
			files: n.files?.slice(0, 8),
			facts: facts || undefined,
			current: r.descriptions[n.id]?.description,
		};
	});
	return { entries, total: nodes.length, next: offset + limit < nodes.length ? offset + limit : undefined };
}

export interface DescriptionCheck {
	accepted: { nodeId: string; description: string }[];
	problems: string[];
}

/**
 * Checks the agent's descriptions before anything is written: known node ids only
 * (shapes are never added or removed this way), one sentence, no placeholder text,
 * and no jargon for the "everyone" audience.
 */
export function checkDescriptions(r: MapRecord, items: { nodeId: string; description: string }[], audience: "everyone" | "developer"): DescriptionCheck {
	const ids = new Set(r.graph.nodes.map((n) => n.id));
	const accepted: DescriptionCheck["accepted"] = [];
	const problems: string[] = [];
	for (const it of items ?? []) {
		const d = String(it?.description ?? "").replace(/\s+/g, " ").trim();
		const id = String(it?.nodeId ?? "");
		if (!ids.has(id)) {
			const near = [...ids].find((x) => lc(x).includes(lc(id)) || lc(id).includes(lc(x)));
			problems.push(`${id}: no such node${near ? ` (did you mean "${near}"?)` : ""}; nodes are never added this way`);
			continue;
		}
		if (d.length < 12) problems.push(`${id}: too short`);
		else if (d.length > 280) problems.push(`${id}: longer than one or two sentences (${d.length} characters)`);
		else if (/\b(todo|tbd|lorem|placeholder)\b/i.test(d)) problems.push(`${id}: placeholder text`);
		else if (audience === "everyone" && JARGON.test(d)) problems.push(`${id}: uses jargon ("${d.match(JARGON)![0]}") for the everyone audience; say what it does for people instead`);
		else accepted.push({ nodeId: id, description: d });
	}
	return { accepted, problems };
}

// ----- tours -----

/** Checks a tour: known node ids, captions present; warns when steps jump between unrelated parts. */
export function checkTour(r: MapRecord, steps: { title: string; caption: string; nodeIds: string[] }[]): { problems: string[]; warnings: string[] } {
	const ids = new Set(r.graph.nodes.map((n) => n.id));
	const problems: string[] = [];
	const warnings: string[] = [];
	if (!Array.isArray(steps) || steps.length === 0) problems.push("a tour needs at least one step");
	(steps ?? []).forEach((s, i) => {
		if (!s?.caption?.trim()) problems.push(`step ${i + 1}: caption is empty`);
		const unknown = (s?.nodeIds ?? []).filter((id) => !ids.has(id));
		if (!s?.nodeIds?.length) problems.push(`step ${i + 1}: no nodeIds`);
		if (unknown.length) problems.push(`step ${i + 1}: unknown node(s) ${unknown.join(", ")}`);
	});
	if (!problems.length) {
		for (let i = 1; i < steps.length; i++) {
			const a = new Set(steps[i - 1].nodeIds);
			const b = new Set(steps[i].nodeIds);
			const linked = [...a].some((x) => b.has(x)) || r.graph.edges.some((e) => (a.has(e.from) && b.has(e.to)) || (b.has(e.from) && a.has(e.to)));
			if (!linked) warnings.push(`steps ${i} → ${i + 1} are not directly connected on the map`);
		}
	}
	return { problems, warnings };
}

// ----- Ask: an answer drawn as a small map -----

/**
 * A page with just the nodes an answer refers to, in step order, numbered, plus
 * the edges between them and a note with the answer.
 */
export function answerGraph(records: MapRecord[], question: string, answer: string, steps: { nodeId: string; note?: string; mapId?: string }[]): { graph: MapGraph; problems: string[] } {
	const problems: string[] = [];
	const nodes: MapNode[] = [];
	const seen = new Map<string, string>();
	const find = (id: string, mapId?: string) => {
		for (const r of records) {
			if (mapId && r.id !== mapId) continue;
			const n = r.graph.nodes.find((x) => x.id === id);
			if (n) return { r, n };
		}
		return undefined;
	};
	steps.forEach((s, i) => {
		const hit = find(s.nodeId, s.mapId);
		if (!hit) {
			problems.push(`step ${i + 1}: unknown node ${s.nodeId}`);
			return;
		}
		const key = `${hit.r.id}:${hit.n.id}`;
		if (seen.has(key)) return;
		const newId = `ask${i + 1}`;
		seen.set(key, newId);
		const { parent: _p, container: _c, rows, ...rest } = hit.n;
		nodes.push({
			...rest,
			id: newId,
			label: `${i + 1}. ${hit.n.label}${s.note ? `\n${s.note}` : ""}`,
			shape: hit.n.shape === "table" ? "box" : hit.n.shape,
			height: hit.n.shape === "icon" ? undefined : s.note ? 76 : undefined,
			width: hit.n.shape === "icon" ? undefined : 220,
			data: { ...(hit.n.data ?? {}), sourceMap: hit.r.id, sourceNode: hit.n.id, step: String(i + 1) },
		});
	});
	const edges: MapEdge[] = [];
	for (const r of records) {
		for (const e of r.graph.edges) {
			const a = seen.get(`${r.id}:${e.from}`);
			const b = seen.get(`${r.id}:${e.to}`);
			if (a && b && a !== b) edges.push({ ...e, from: a, to: b });
		}
	}
	// Keep the reading order even where the map has no edge between consecutive steps.
	for (let i = 1; i < nodes.length; i++) {
		const a = nodes[i - 1].id;
		const b = nodes[i].id;
		if (!edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))) {
			edges.push({ from: a, to: b, kind: "step", style: "endArrow=open;dashed=1;html=1;strokeColor=#9ca3af;" });
		}
	}
	return {
		graph: {
			title: `Ask · ${question.slice(0, 60)}`,
			nodes,
			edges,
			direction: "right",
			legend: [`Q: ${question}`, answer],
		},
		problems,
	};
}
