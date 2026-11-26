import { withRepositories } from "./recipes/common";
import * as fs from "fs";
import * as path from "path";
import type { CustomizedDrawioClient } from "../../../../src/DrawioClient/CustomizedDrawioClient";
import { applyDescriptions, Badge, drawBadges, drawMap, mapsOnPage } from "./draw";
import { answerGraph, checkDescriptions, checkTour, findNodes, findPath, showNode, worksheet } from "./query";
import { recipeById } from "./registry";
import { activeFindings, adoptRecords, createRecord, diffRecords, findingFingerprint, loadRecord, MapRecord, mapsDir, newMapId, saveRecord } from "./store";
import type { CollectContext, CollectResult, MapFinding, MapInput } from "./types";
import { MapperError } from "./types";

export const SEVERITY: Record<MapFinding["severity"], { fill: string; rank: number; label: string }> = {
	high: { fill: "#dc2626", rank: 3, label: "High" },
	medium: { fill: "#d97706", rank: 2, label: "Medium" },
	low: { fill: "#2563eb", rank: 1, label: "Low" },
	info: { fill: "#6b7280", rank: 0, label: "Info" },
};

export interface MapperHostContext {
	client: CustomizedDrawioClient;
	/** The diagram's folder: maps are stored in its `.drawai/maps`. */
	cwd(): string;
	/** The diagram file, to tell this diagram's maps from others in the folder. */
	diagram(): string | undefined;
	context(signal?: AbortSignal, progress?: (t: string) => void): CollectContext;
	/** Whether edits are shown being built (Settings → Editor): a map is one, too. */
	animate?(): boolean;
}

export interface RunOutcome {
	record: MapRecord;
	result: CollectResult;
	drawn?: { page: string; newPage: boolean; cells: number };
	badges: number;
}

/** Everything the Mapper does on one diagram window, shared by the dialog, the chat and the MCP tools. */
export class MapperService {
	constructor(private readonly host: MapperHostContext) {}

	private get cwd(): string {
		return this.host.cwd();
	}

	// ----- records -----

	/** This diagram's maps, newest first. */
	public records(): MapRecord[] {
		let names: string[] = [];
		try {
			names = fs.readdirSync(mapsDir(this.cwd)).filter((n) => n.endsWith(".json"));
		} catch {
			return [];
		}
		const diagram = this.host.diagram();
		return names
			.map((n) => loadRecord(this.cwd, n.replace(/\.json$/, "")))
			.filter((r): r is MapRecord => !!r && (!diagram || !r.diagram || r.diagram === path.basename(diagram)))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * After Save As: the records of the diagram's maps belong to the new file. In
	 * another folder they are copied there (the old file keeps its own); in the same
	 * folder they are re-associated with the new name.
	 */
	public adoptRecords(from: { cwd: string; diagram?: string }, to: { cwd: string; diagram: string }): number {
		return adoptRecords(from, to);
	}

	public record(id: string | undefined): MapRecord {
		const r = id ? loadRecord(this.cwd, id) : undefined;
		if (r) return r;
		if (!id) {
			const latest = this.records()[0];
			if (latest) return latest;
			throw new MapperError("This diagram has no maps yet. Make one with Map → Map Something… (or mapper_run).");
		}
		throw new MapperError(`No map ${id} next to this diagram. mapper_maps lists them.`);
	}

	/** The maps drawn on the page shown in the editor. */
	public async pageRecords(): Promise<MapRecord[]> {
		const page = await mapsOnPage(this.host.client);
		return [...page.maps.keys()].map((id) => loadRecord(this.cwd, id)).filter((r): r is MapRecord => !!r);
	}

	private save(r: MapRecord): void {
		r.diagram = this.host.diagram() ? path.basename(this.host.diagram()!) : undefined;
		saveRecord(this.cwd, r);
	}

	// ----- running a map -----

	/** Collects (read-only), draws the map with its health badges, and stores its record. */
	public async run(recipeId: string, input: MapInput, opts: { signal?: AbortSignal; progress?: (t: string) => void; previous?: MapRecord } = {}): Promise<RunOutcome> {
		const recipe = recipeById(recipeId);
		if (!recipe) throw new MapperError(`Unknown map ${recipeId}. mapper_list_recipes lists them.`);
		const progress = opts.progress ?? (() => undefined);
		const ctx = this.host.context(opts.signal, progress);
		if (!recipe.collect) throw new MapperError(`${recipe.title} is drawn by the agent, not collected.`);
		progress("Collecting (read-only)…");
		// (a repository given where a folder goes is downloaded first: the recipe reads a folder, as always)
		const from = await withRepositories(recipe.fields, input, ctx);
		if (opts.signal?.aborted) throw new MapperError("Cancelled");
		const result = await recipe.collect(from.input, ctx);
		if (opts.signal?.aborted) throw new MapperError("Cancelled");
		if (from.root && from.source) {
			// (what the user reads names the repository, not the folder it was downloaded to)
			const named = (text: string) => text.split(from.root!).join(from.source!);
			result.root ??= from.root;
			result.source ??= from.source;
			result.summary = named(result.summary);
			if (result.warnings) result.warnings = result.warnings.map(named);
			if (result.graph?.title) result.graph.title = named(result.graph.title);
		}
		const root = result.root ?? ["folder", "file"].map((k) => String(input[k] ?? "").trim()).find(Boolean);
		if (root && result.graph) for (const n of result.graph.nodes) n.data = { mapRoot: root, ...(n.data ?? {}) };
		const record = createRecord({ id: newMapId(), recipe, input, result, root, git: root ? await this.gitState(root, ctx) : undefined, previous: opts.previous });
		let drawn: RunOutcome["drawn"];
		let badges = 0;
		if (result.graph && result.graph.nodes.length > 0) {
			progress(`Drawing ${result.graph.nodes.length} shapes…`);
			const descriptions = Object.fromEntries(Object.entries(record.descriptions).map(([k, v]) => [k, v.description]));
			drawn = await drawMap(this.host.client, result.graph, recipe.id, { mapId: record.id, descriptions, forceNewPage: !!opts.previous, animate: this.host.animate?.() });
			record.page = drawn.page;
			badges = await this.drawHealth(record);
		}
		this.save(record);
		return { record, result, drawn, badges };
	}

	private async gitState(root: string, ctx: CollectContext): Promise<MapRecord["git"]> {
		const dir = fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root);
		try {
			const head = await ctx.exec("git", ["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
			if (head.code !== 0) return undefined;
			const branch = await ctx.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
			return { head: head.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() : undefined };
		} catch {
			return undefined;
		}
	}

	// ----- health -----

	/** Severity badges on the shapes with findings, on the map's "Health" layer. */
	public async drawHealth(record: MapRecord): Promise<number> {
		const findings = activeFindings(record);
		const byNode = new Map<string, MapFinding[]>();
		for (const f of findings) for (const id of f.nodeIds) (byNode.get(id) ?? byNode.set(id, []).get(id)!).push(f);
		const badges: Badge[] = [...byNode].map(([nodeId, list]) => {
			const worst = list.reduce((a, b) => (SEVERITY[b.severity].rank > SEVERITY[a.severity].rank ? b : a));
			return {
				nodeId,
				text: list.length > 1 ? `! ${list.length}` : "!",
				fill: SEVERITY[worst.severity].fill,
				tooltip: list.map((f) => `${SEVERITY[f.severity].label}: ${f.title}${f.fix ? ` — Fix: ${f.fix}` : ""}`).join("\n"),
				data: { findingIds: list.map((f) => f.id).join(" "), severity: worst.severity },
			};
		});
		return drawBadges(this.host.client, record.id, "finding-badge", "Health", badges);
	}

	public findings(record: MapRecord) {
		const active = activeFindings(record);
		const order = (f: MapFinding) => -SEVERITY[f.severity].rank;
		return {
			mapId: record.id,
			title: record.title,
			findings: [...active].sort((a, b) => order(a) - order(b)),
			dismissed: record.findings.length - active.length,
			checked: record.checked,
		};
	}

	public async dismiss(record: MapRecord, findingId: string, on = true): Promise<void> {
		const f = record.findings.find((x) => x.id === findingId);
		if (!f) throw new MapperError(`No finding ${findingId} on this map.`);
		if (on) record.dismissed[f.id] = findingFingerprint(f);
		else delete record.dismissed[f.id];
		this.save(record);
		await this.drawHealth(record).catch(() => undefined);
	}

	// ----- descriptions -----

	public worksheet(record: MapRecord, opts: Parameters<typeof worksheet>[1]) {
		return worksheet(record, opts);
	}

	/** Validates and stores the agent's descriptions, and shows them as the shapes' tooltips. */
	public async setDescriptions(record: MapRecord, items: { nodeId: string; description: string }[], audience: "everyone" | "developer") {
		const check = checkDescriptions(record, items, audience);
		const at = new Date().toISOString();
		for (const a of check.accepted) record.descriptions[a.nodeId] = { description: a.description, audience, at };
		this.save(record);
		let applied = 0;
		try {
			applied = await applyDescriptions(this.host.client, record.id, check.accepted);
		} catch (e: any) {
			check.problems.push(`saved, but not shown on the diagram: ${e?.message ?? e}`);
		}
		return { accepted: check.accepted.length, applied, problems: check.problems, remaining: worksheet(record, { only: "missing", limit: 0 }).total };
	}

	// ----- recent changes -----

	/** Files changed in git since the map was made (committed and not), mapped to its shapes. */
	public async recentChanges(record: MapRecord, opts: { draw?: boolean } = {}) {
		if (!record.root) throw new MapperError("This map was not made from a folder, so it has no files to compare.");
		const dir = fs.existsSync(record.root) && fs.statSync(record.root).isDirectory() ? record.root : path.dirname(record.root);
		const ctx = this.host.context();
		const git = async (args: string[]) => {
			const r = await ctx.exec("git", args, { cwd: dir, timeoutMs: 30_000 });
			if (r.code !== 0) throw new MapperError(`git ${args[0]} failed in ${dir}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
			return r.stdout;
		};
		const changed = new Map<string, string>();
		// (the record is a file next to the diagram: only a commit hash goes into git's arguments)
		const since = /^[0-9a-f]{7,64}$/i.test(record.git?.head ?? "") ? record.git!.head : undefined;
		if (since) for (const f of (await git(["diff", "--name-only", "--relative", `${since}..HEAD`])).split("\n").filter(Boolean)) changed.set(f, "committed");
		for (const line of (await git(["status", "--short", "--untracked-files=all", "."])).split("\n").filter(Boolean)) {
			const p = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
			changed.set(p, line.startsWith("??") ? "new file" : "uncommitted");
		}
		const commits = since
			? (await git(["log", "--format=%h%x09%an%x09%ar%x09%s", "--relative", `${since}..HEAD`, "-n", "30", "--", "."]))
					.split("\n")
					.filter(Boolean)
					.map((l) => {
						const [hash, author, when, subject] = l.split("\t");
						return { hash, author, when, subject };
					})
			: [];
		const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
		const files = [...changed.keys()].map(norm);
		const shapes: { nodeId: string; label: string; files: string[]; how: string[] }[] = [];
		for (const n of record.graph.nodes) {
			// a service's folder counts too (data.dir), unless it is the whole repository
			const dir = typeof n.data?.dir === "string" && !/^\.?\/?$/.test(n.data.dir) ? n.data.dir.replace(/\/?$/, "/") : undefined;
			const own = [...(n.files ?? []), n.data?.file, n.data?.path, dir].filter((x): x is string => !!x).map(norm);
			if (!own.length) continue;
			const hit = files.filter((f) => own.some((o) => f === o || f.startsWith(o.endsWith("/") ? o : o + "/")));
			if (hit.length) shapes.push({ nodeId: n.id, label: n.label, files: hit, how: [...new Set(hit.map((f) => changed.get(f) ?? "changed"))] });
		}
		let badges = 0;
		if (opts.draw) {
			badges = await drawBadges(
				this.host.client,
				record.id,
				"change-badge",
				"Changes",
				shapes.map((s) => ({
					nodeId: s.nodeId,
					text: s.how.includes("new file") ? "new" : "changed",
					fill: "#16a34a",
					tooltip: `Changed since the map was made${since ? ` (${since.slice(0, 7)})` : ""}:\n${s.files.slice(0, 12).join("\n")}`,
				}))
			);
		}
		return { mapId: record.id, since: since?.slice(0, 7), changedFiles: files.length, unmappedFiles: files.filter((f) => !shapes.some((s) => s.files.includes(f))).slice(0, 40), shapes, commits, badges };
	}

	// ----- refresh -----

	/** Runs a map again (same inputs; secrets must be given again) onto a new page and marks what changed. */
	public async refresh(record: MapRecord, secrets: MapInput = {}, opts: { signal?: AbortSignal; progress?: (t: string) => void } = {}) {
		const recipe = recipeById(record.recipe);
		if (!recipe) throw new MapperError(`The recipe ${record.recipe} no longer exists.`);
		const missing = recipe.fields.filter((f) => (f.secret || f.type === "password") && f.required && !secrets[f.id]);
		if (missing.length) throw new MapperError(`Refreshing needs ${missing.map((f) => f.label).join(", ")} again (secrets are never stored).`);
		const out = await this.run(recipe.id, { ...record.input, ...secrets }, { ...opts, previous: record });
		const diff = diffRecords(record, out.record);
		const label = (id: string) => record.graph.nodes.find((n) => n.id === id)?.label ?? id;
		await drawBadges(this.host.client, out.record.id, "change-badge", "Changes", [
			...diff.added.map((nodeId) => ({ nodeId, text: "new", fill: "#16a34a", tooltip: "New since the previous map" })),
			...diff.changed.map((nodeId) => ({ nodeId, text: "changed", fill: "#2563eb", tooltip: "Changed since the previous map" })),
		]).catch(() => undefined);
		return { ...out, diff: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.map(label) } };
	}

	// ----- tours and answers -----

	public setTour(record: MapRecord, title: string, steps: { title: string; caption: string; nodeIds: string[] }[]) {
		const check = checkTour(record, steps);
		if (check.problems.length) return { saved: false, ...check };
		// A tour saved again under its title replaces the old one; ids stay unique among the tours kept.
		const kept = record.tours.filter((t) => t.title !== title);
		const taken = new Set(kept.map((t) => t.id));
		let n = kept.length + 1;
		while (taken.has(`t${n}`)) n++;
		const id = `t${n}`;
		record.tours = [...kept, { id, title: title || "Tour", steps }];
		this.save(record);
		return { saved: true, tourId: id, ...check };
	}

	/** Draws an answer as a page of just the shapes it refers to, numbered in reading order. */
	public async answer(question: string, answer: string, steps: { nodeId: string; note?: string; mapId?: string }[]) {
		const records = this.records();
		const { graph, problems } = answerGraph(records, question, answer, steps);
		if (graph.nodes.length === 0) return { drawn: false, problems: problems.length ? problems : ["no steps refer to mapped shapes"] };
		const drawn = await drawMap(this.host.client, graph, "mapper.ask", { forceNewPage: true, animate: this.host.animate?.() });
		return { drawn: true, page: drawn.page, shapes: graph.nodes.length, problems };
	}

	// ----- lookups -----

	public find(query: string, mapId?: string) {
		const records = mapId ? [this.record(mapId)] : this.records();
		return findNodes(records, query);
	}

	public show(nodeId: string, mapId?: string) {
		const records = mapId ? [this.record(mapId)] : this.records();
		for (const r of records) {
			const s = showNode(r, nodeId);
			if (s) return s;
		}
		throw new MapperError(`No node ${nodeId}${mapId ? ` on map ${mapId}` : ""}. mapper_find searches by name.`);
	}

	public path(from: string, to: string, mapId?: string) {
		const r = this.record(mapId);
		const p = findPath(r, from, to);
		if (!p) throw new MapperError(`No connection between ${from} and ${to} on map ${r.id}.`);
		return p;
	}

	public summary(r: MapRecord) {
		const active = activeFindings(r);
		return {
			id: r.id,
			recipe: r.recipe,
			title: r.title,
			page: r.page,
			made: r.createdAt,
			summary: r.summary,
			shapes: r.graph.nodes.length,
			described: Object.keys(r.descriptions).length,
			findings: Object.fromEntries((["high", "medium", "low", "info"] as const).map((s) => [s, active.filter((f) => f.severity === s).length])),
			tours: r.tours.map((t) => ({ id: t.id, title: t.title, steps: t.steps.length })),
			root: r.root,
			refreshedFrom: r.previous,
		};
	}
}
