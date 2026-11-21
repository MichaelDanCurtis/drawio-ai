import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CheckCoverage, CollectResult, MapFinding, MapGraph, MapInput, MapNode, Recipe } from "./types";

/**
 * What the Mapper knows about a map it drew, kept next to the diagram in
 * `.drawai/maps/<id>.json` (shared through git like the diagram itself). The
 * shapes carry `mapId` and `mapperId`, so a map's record is found from its page.
 * Inspired by floorplan's stored model: descriptions, findings, tours and
 * fingerprints survive a refresh; only what changed needs another look.
 */
export interface MapRecord {
	version: 1;
	id: string;
	recipe: string;
	title: string;
	/** Name of the page the map was drawn on. */
	page?: string;
	/** The inputs, without secrets (password fields are left out). */
	input: MapInput;
	/** The folder or file that was mapped, when there is one. */
	root?: string;
	createdAt: string;
	updatedAt: string;
	/** Git state of `root` when the map was made (for Recent changes). */
	git?: { head?: string; branch?: string };
	summary: string;
	graph: MapGraph;
	/** Per node: a hash of what the map shows about it, to tell changed nodes on refresh. */
	fingerprints: Record<string, string>;
	findings: MapFinding[];
	checked: CheckCoverage[];
	/** Dismissed findings: id → the finding's hash when dismissed (it comes back if it changes). */
	dismissed: Record<string, string>;
	descriptions: Record<string, MapDescription>;
	tours: MapTour[];
	/** The map this one refreshed, if any. */
	previous?: string;
	/** File name of the diagram the map belongs to (several diagrams can share a folder). */
	diagram?: string;
}

export interface MapDescription {
	description: string;
	audience: "everyone" | "developer";
	at: string;
}

export interface MapTour {
	id: string;
	title: string;
	steps: { title: string; caption: string; nodeIds: string[] }[];
}

export const mapsDir = (cwd: string) => path.join(cwd, ".drawai", "maps");

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export function nodeFingerprint(n: MapNode): string {
	const data = Object.fromEntries(Object.entries(n.data ?? {}).filter(([k]) => k !== "mapRoot").sort(([a], [b]) => a.localeCompare(b)));
	return hash({ label: n.label, kind: n.kind, parent: n.parent ?? null, data, rows: n.rows ?? null, files: n.files ?? null });
}

export function findingFingerprint(f: MapFinding): string {
	return hash({ kind: f.kind, severity: f.severity, title: f.title, detail: f.detail ?? null, nodeIds: [...f.nodeIds].sort() });
}

export function newMapId(): string {
	return `m${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** The record for a fresh map run (secret fields removed from the inputs). */
export function createRecord(opts: {
	id?: string;
	recipe: Recipe;
	input: MapInput;
	result: CollectResult;
	page?: string;
	root?: string;
	git?: MapRecord["git"];
	previous?: MapRecord;
	now?: Date;
}): MapRecord {
	const now = (opts.now ?? new Date()).toISOString();
	const secret = new Set(opts.recipe.fields.filter((f) => f.secret || f.type === "password").map((f) => f.id));
	const graph = opts.result.graph ?? { title: opts.recipe.title, nodes: [], edges: [] };
	const ids = new Set(graph.nodes.map((n) => n.id));
	// Descriptions carry over to nodes that still exist; the agent re-checks changed ones.
	const descriptions: Record<string, MapDescription> = {};
	for (const [id, d] of Object.entries(opts.previous?.descriptions ?? {})) if (ids.has(id)) descriptions[id] = d;
	return {
		version: 1,
		id: opts.id ?? newMapId(),
		recipe: opts.recipe.id,
		title: graph.title,
		page: opts.page,
		input: Object.fromEntries(Object.entries(opts.input).filter(([k]) => !secret.has(k))),
		root: opts.root,
		createdAt: now,
		updatedAt: now,
		git: opts.git,
		summary: opts.result.summary,
		graph,
		fingerprints: Object.fromEntries(graph.nodes.map((n) => [n.id, nodeFingerprint(n)])),
		findings: (opts.result.findings ?? []).filter((f) => f.nodeIds.some((id) => ids.has(id))),
		checked: opts.result.checked ?? [],
		dismissed: { ...(opts.previous?.dismissed ?? {}) },
		descriptions,
		tours: (opts.previous?.tours ?? [])
			.map((t) => ({ ...t, steps: t.steps.filter((s) => s.nodeIds.every((id) => ids.has(id))) }))
			.filter((t) => t.steps.length > 0),
		previous: opts.previous?.id,
	};
}

export function saveRecord(cwd: string, record: MapRecord): string {
	const dir = mapsDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	record.updatedAt = new Date().toISOString();
	const file = path.join(dir, `${record.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 1));
	fs.renameSync(tmp, file);
	return file;
}

export function loadRecord(cwd: string, id: string): MapRecord | undefined {
	if (!/^[\w-]+$/.test(id)) return undefined;
	try {
		const r = JSON.parse(fs.readFileSync(path.join(mapsDir(cwd), `${id}.json`), "utf8"));
		return r?.version === 1 && r.id === id ? (r as MapRecord) : undefined;
	} catch {
		return undefined;
	}
}

/** Findings still showing: dismissed ones stay hidden until they change. */
export function activeFindings(record: MapRecord): MapFinding[] {
	return record.findings.filter((f) => record.dismissed[f.id] !== findingFingerprint(f));
}

/** What changed between two runs of a map, by node id and fingerprint. */
export function diffRecords(before: MapRecord, after: MapRecord): { added: string[]; removed: string[]; changed: string[] } {
	const added: string[] = [];
	const changed: string[] = [];
	for (const [id, fp] of Object.entries(after.fingerprints)) {
		const old = before.fingerprints[id];
		if (old === undefined) added.push(id);
		else if (old !== fp) changed.push(id);
	}
	const removed = Object.keys(before.fingerprints).filter((id) => !(id in after.fingerprints));
	return { added, removed, changed };
}
