/**
 * Health findings of a mapped schema, from the catalog facts alone: tables without
 * a primary key, foreign keys without an index (on engines that do not create one),
 * nullable foreign keys, tables outside an otherwise related schema, and MongoDB
 * collections referenced by other documents but indexed on _id only.
 */
import type { CheckCoverage, MapFinding, MapGraph } from "../../types";
import { DbModel, DbRelation, DbTable, ENGINE_NAMES, tableId } from "./model";

const SEVERITY_ORDER: Record<MapFinding["severity"], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Findings whose shapes are on the map, one per id, most severe first. */
export function keepOnMap(findings: MapFinding[], graph: MapGraph | undefined): MapFinding[] {
	if (!graph) return [];
	const ids = new Set(graph.nodes.map((n) => n.id));
	const seen = new Set<string>();
	const out: MapFinding[] = [];
	for (const f of findings) {
		const nodeIds = [...new Set(f.nodeIds.filter((id) => ids.has(id)))];
		if (!nodeIds.length || seen.has(f.id)) continue;
		seen.add(f.id);
		out.push({ ...f, nodeIds });
	}
	return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}

/** Engines that do not index foreign key columns by themselves (MySQL / InnoDB does). */
const NO_AUTO_FK_INDEX = new Set(["postgres", "mssql", "oracle", "sqlite"]);

const qualified = (t: { schema: string; name: string }, multiSchema: boolean) => (multiSchema ? `${t.schema}.${t.name}` : t.name);

export function schemaFindings(model: DbModel, graph: MapGraph): { findings: MapFinding[]; checked: CheckCoverage[] } {
	const findings: MapFinding[] = [];
	const checked: CheckCoverage[] = [];
	const engine = ENGINE_NAMES[model.engine];
	const multi = new Set(model.tables.map((t) => t.schema)).size > 1;
	const byKey = new Map(model.tables.map((t) => [`${t.schema}\u0000${t.name}`, t]));
	const tableOf = (r: DbRelation) => byKey.get(`${r.schema}\u0000${r.table}`);
	const name = (t: DbTable) => qualified(t, multi);

	if (model.engine === "mongodb") {
		// Collections other documents point at by reference fields, with no index besides _id.
		const collections = model.tables.filter((t) => t.kind === "collection");
		let examined = 0;
		for (const t of collections) {
			const refs = model.relations.filter((r) => r.schema === t.schema && r.table === t.name);
			if (!refs.length) continue;
			examined++;
			if ((t.indexed ?? []).length || t.uniques.length) continue;
			const fields = [...new Set(refs.flatMap((r) => r.columns))];
			findings.push({
				id: `unindexed-references:${tableId(t.schema, t.name)}`,
				kind: "unindexed-references",
				severity: "low",
				title: `${name(t)} has reference fields but no index besides _id`,
				detail: `${t.schema}.${t.name}: ${fields.slice(0, 6).join(", ")} ${fields.length === 1 ? "looks like a reference" : "look like references"} (guessed from sampled documents), and the only index is on _id${t.rows !== undefined ? ` (~${t.rows} documents)` : ""}. Lookups by ${fields[0]} scan the whole collection.`,
				nodeIds: [tableId(t.schema, t.name)],
				fix: `If ${t.name} is queried by ${fields[0]}, create an index on it (db.${t.name}.createIndex({ "${fields[0].replace(/\[\]/g, "")}": 1 })).`,
			});
		}
		checked.push({ check: "Collections referenced by other documents without an index", scanned: examined, note: "collections with guessed reference fields" });
		return { findings: keepOnMap(findings, graph), checked };
	}

	const tables = model.tables.filter((t) => t.kind === "table");
	const declared = model.relations.filter((r) => !r.inferred && tableOf(r)?.kind === "table");

	// Tables without a primary key.
	for (const t of tables) {
		if (t.primaryKey.length) continue;
		findings.push({
			id: `missing-primary-key:${tableId(t.schema, t.name)}`,
			kind: "missing-primary-key",
			severity: "medium",
			title: `${name(t)} has no primary key`,
			detail: `${t.schema}.${t.name} (${t.columns.length} column(s)${t.uniques.length ? `, unique: ${t.uniques.map((u) => u.join("+")).join("; ")}` : ""}) declares no primary key${t.rows !== undefined && t.rows >= 0 ? `; ~${t.rows} rows` : ""}. Rows cannot be addressed reliably, and replication / ORMs often need one.`,
			nodeIds: [tableId(t.schema, t.name)],
			fix: `Add a primary key to ${t.schema}.${t.name}${t.uniques.length ? ` (the unique ${t.uniques[0].join(", ")} may serve)` : " (a surrogate id column if no natural key exists)"}.`,
		});
	}
	checked.push({ check: "Tables without a primary key", scanned: tables.length });

	// Foreign keys without an index on their leading column.
	const hasIndexInfo = model.tables.some((t) => (t.indexed ?? []).length || t.uniques.length);
	if (NO_AUTO_FK_INDEX.has(model.engine) && hasIndexInfo) {
		for (const r of declared) {
			const t = tableOf(r)!;
			const lead = r.columns[0];
			const covered = t.primaryKey[0] === lead || t.uniques.some((u) => u[0] === lead) || (t.indexed ?? []).includes(lead);
			if (covered) continue;
			findings.push({
				id: `unindexed-foreign-key:${tableId(t.schema, t.name)}:${r.columns.join(",")}`,
				kind: "unindexed-foreign-key",
				severity: "low",
				title: `${name(t)}.${r.columns.join(", ")} references ${r.refTable} without an index`,
				detail: `Foreign key ${r.name ? `${r.name} ` : ""}(${r.columns.join(", ")}) → ${r.refSchema}.${r.refTable}(${r.refColumns.join(", ")}): no index starts with ${lead}. ${engine} does not create one for foreign keys, so joins on it and deletes / updates of ${r.refTable} scan ${t.name}.`,
				nodeIds: [tableId(t.schema, t.name), tableId(r.refSchema, r.refTable)],
				fix: `CREATE INDEX ON ${t.schema}.${t.name} (${r.columns.join(", ")}); — if ${t.name} is joined or ${r.refTable} rows are deleted.`,
			});
		}
		checked.push({ check: "Foreign keys without an index", scanned: declared.length, note: `${engine} does not index foreign keys automatically` });
	}

	// Nullable foreign keys (optional relations: often intended).
	for (const r of declared) {
		const t = tableOf(r)!;
		const nullable = r.columns.filter((c) => t.columns.find((x) => x.name === c)?.nullable);
		if (!nullable.length) continue;
		findings.push({
			id: `nullable-foreign-key:${tableId(t.schema, t.name)}:${r.columns.join(",")}`,
			kind: "nullable-foreign-key",
			severity: "info",
			title: `${name(t)}.${nullable.join(", ")} is an optional reference to ${r.refTable}`,
			detail: `${t.schema}.${t.name}.${nullable.join(", ")} (foreign key to ${r.refSchema}.${r.refTable}) allows NULL, so a ${t.name} row may have no ${r.refTable}.`,
			nodeIds: [tableId(t.schema, t.name)],
			fix: `If every ${t.name} row must have a ${r.refTable}, make ${nullable.join(", ")} NOT NULL (after back-filling existing NULLs).`,
		});
	}
	checked.push({ check: "Nullable foreign key columns", scanned: declared.length });

	// Tables with no relations in schemas where most tables have them.
	const related = new Set<string>();
	for (const r of model.relations) {
		related.add(`${r.schema}\u0000${r.table}`);
		related.add(`${r.refSchema}\u0000${r.refTable}`);
	}
	let orphanScanned = 0;
	for (const schema of new Set(tables.map((t) => t.schema))) {
		const mine = tables.filter((t) => t.schema === schema);
		const linked = mine.filter((t) => related.has(`${t.schema}\u0000${t.name}`));
		if (mine.length < 4 || linked.length / mine.length < 0.6) continue;
		orphanScanned += mine.length;
		for (const t of mine.filter((x) => !related.has(`${x.schema}\u0000${x.name}`))) {
			findings.push({
				id: `orphan-table:${tableId(t.schema, t.name)}`,
				kind: "orphan-table",
				severity: "info",
				title: `${name(t)} has no relations`,
				detail: `${t.schema}.${t.name} neither references nor is referenced by another table, while ${linked.length} of ${mine.length} tables in ${schema} are related. It may be a lookup or log table, unused, or missing a foreign key.`,
				nodeIds: [tableId(t.schema, t.name)],
				fix: `Check whether ${t.name} is still used; if one of its columns refers to another table, declare that foreign key.`,
			});
		}
	}
	checked.push({ check: "Tables with no relations in a related schema", scanned: orphanScanned, note: "schemas with 4+ tables, most of them related" });

	return { findings: keepOnMap(findings, graph), checked };
}
