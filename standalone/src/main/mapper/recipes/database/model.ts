/**
 * The engine-neutral schema model every database introspector produces, and the
 * map drawn from it: tables as ERD tables, schemas as containers, foreign keys as
 * crow's-foot edges. Nothing here knows about connections, so it is tested from
 * recorded catalog rows (test/fixtures/database).
 */
import { slug } from "../common";
import type { MapEdge, MapGraph, MapNode, MapRow } from "../../types";

export type EngineId = "postgres" | "mysql" | "mssql" | "oracle" | "sqlite" | "mongodb";

export const ENGINES: { id: EngineId; label: string }[] = [
	{ id: "postgres", label: "PostgreSQL (also Supabase, Neon, RDS, Cloud SQL)" },
	{ id: "mysql", label: "MySQL / MariaDB" },
	{ id: "mssql", label: "SQL Server / Azure SQL" },
	{ id: "oracle", label: "Oracle" },
	{ id: "sqlite", label: "SQLite (file)" },
	{ id: "mongodb", label: "MongoDB" },
];

export const ENGINE_NAMES: Record<EngineId, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mssql: "SQL Server",
	oracle: "Oracle",
	sqlite: "SQLite",
	mongodb: "MongoDB",
};

export interface DbColumn {
	name: string;
	type: string;
	nullable: boolean;
	/** MongoDB: share of sampled documents that have the field (0..100). */
	presence?: number;
}

export interface DbTable {
	schema: string;
	name: string;
	kind: "table" | "view" | "collection";
	columns: DbColumn[];
	/** Primary key columns in key order. */
	primaryKey: string[];
	/** Unique constraints / unique indexes (column lists). */
	uniques: string[][];
	/** Columns that lead a non-unique index. */
	indexed?: string[];
	comment?: string;
	/** Estimated rows / documents, when the catalog knows it cheaply. */
	rows?: number;
	/** Extra details for the facts (e.g. a MongoDB view's source). */
	note?: string;
}

export interface DbRelation {
	name?: string;
	/** The referencing (child) table. */
	schema: string;
	table: string;
	columns: string[];
	/** The referenced (parent) table. */
	refSchema: string;
	refTable: string;
	refColumns: string[];
	/** Guessed from data (MongoDB), not declared. */
	inferred?: boolean;
}

export interface DbModel {
	engine: EngineId;
	/** Database name (for SQLite: the file name). Never a host or a connection string. */
	database: string;
	/** Server version, short. */
	version?: string;
	tables: DbTable[];
	relations: DbRelation[];
	/** Schemas that were skipped by default (system / platform schemas). */
	skippedSchemas?: string[];
	warnings: string[];
}

// ----- styles -----

const TABLE_BASE =
	"swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;rounded=1;arcSize=4;";
export const DB_STYLES = {
	table: TABLE_BASE + "fillColor=#dae8fc;strokeColor=#6c8ebf;",
	view: TABLE_BASE + "fillColor=#d5e8d4;strokeColor=#82b366;dashed=1;fontStyle=3;",
	collection: TABLE_BASE + "fillColor=#ffe6cc;strokeColor=#d79b00;",
	external: "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;fontColor=#555555;fontStyle=2;",
	schema:
		"rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#f8f9fb;strokeColor=#8b95a1;dashed=1;",
};

/**
 * Crow's-foot relation from the referenced (parent) table to the referencing
 * (child) one: "one" at the parent end (start), "many" at the child end (end).
 * The parent end is "zero or one" when the foreign key columns are nullable, and
 * the child end is "zero or one" when the foreign key columns are unique (1:1).
 */
export function relationStyle(opts: { nullable: boolean; oneToOne: boolean; inferred?: boolean }): string {
	return [
		"edgeStyle=entityRelationEdgeStyle",
		"html=1",
		"rounded=0",
		"fontSize=10",
		`startArrow=${opts.nullable ? "ERzeroToOne" : "ERmandOne"}`,
		"startFill=0",
		`endArrow=${opts.oneToOne ? "ERzeroToOne" : "ERmany"}`,
		"endFill=0",
		opts.inferred ? "dashed=1;strokeColor=#d79b00" : "strokeColor=#6b7280",
	].join(";") + ";";
}

// ----- graph -----

/** More tables than this: still all mapped, but each shows its key columns only. */
export const LARGE_SCHEMA = 150;
const LARGE_MAX_ROWS = 12;

export const tableId = (schema: string, name: string) => `db:${slug(schema)}.${slug(name)}`;

function rowsOf(t: DbTable, fkCols: Set<string>, compact: boolean): MapRow[] {
	const pk = new Set(t.primaryKey);
	const uk = new Set(t.uniques.flat());
	const idx = new Set(t.indexed ?? []);
	const rows = t.columns.map((c): MapRow & { important: boolean } => {
		const isPk = pk.has(c.name);
		const isFk = fkCols.has(c.name);
		const key: MapRow["key"] = isPk && isFk ? "PK,FK" : isPk ? "PK" : isFk ? "FK" : uk.has(c.name) ? "UK" : idx.has(c.name) ? "IDX" : undefined;
		const detail =
			c.presence !== undefined
				? `${c.type}${c.presence < 100 ? ` · ${c.presence}%` : ""}`
				: `${c.type}${c.nullable ? " null" : ""}`;
		return { text: c.name, key, detail: detail.trim() || undefined, important: isPk || isFk || uk.has(c.name) };
	});
	const strip = (r: MapRow & { important: boolean }): MapRow => {
		const { important: _i, ...row } = r;
		if (!row.key) delete row.key;
		if (!row.detail) delete row.detail;
		return row;
	};
	if (!compact || rows.length <= LARGE_MAX_ROWS) return rows.map(strip);
	// Large schemas: keys first, then the leading columns, and a count of the rest.
	const keep = new Set(rows.filter((r) => r.important).slice(0, LARGE_MAX_ROWS));
	for (const r of rows) if (keep.size < LARGE_MAX_ROWS) keep.add(r);
	const shown = rows.filter((r) => keep.has(r)).map(strip);
	shown.push({ text: `… ${rows.length - shown.length} more columns` });
	return shown;
}

export interface GraphOptions {
	/** ISO timestamp for the legend (tests pass a fixed one). */
	now?: string;
}

/** Builds the ERD map. Containers per schema only when there is more than one. */
export function modelToGraph(model: DbModel, opts: GraphOptions = {}): MapGraph {
	const engine = ENGINE_NAMES[model.engine];
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const schemas = [...new Set(model.tables.map((t) => t.schema))].sort((a, b) => a.localeCompare(b));
	const multiSchema = schemas.length > 1;
	const large = model.tables.length > LARGE_SCHEMA;
	const known = new Map(model.tables.map((t) => [`${t.schema}\u0000${t.name}`, t]));
	const schemaWord = model.engine === "mongodb" ? "database" : model.engine === "oracle" ? "owner" : "schema";

	if (multiSchema) {
		for (const s of schemas) {
			nodes.push({ id: `schema:${slug(s)}`, label: `${s}`, kind: `db:${schemaWord}`, container: true, style: DB_STYLES.schema, data: { schema: s, engine: model.engine, database: model.database } });
		}
	}

	const fkColsByTable = new Map<string, Set<string>>();
	for (const r of model.relations) {
		const k = `${r.schema}\u0000${r.table}`;
		if (!fkColsByTable.has(k)) fkColsByTable.set(k, new Set());
		for (const c of r.columns) fkColsByTable.get(k)!.add(c);
	}

	const sorted = [...model.tables].sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
	for (const t of sorted) {
		const style = t.kind === "view" ? DB_STYLES.view : t.kind === "collection" ? DB_STYLES.collection : DB_STYLES.table;
		const data: Record<string, string> = { engine: model.engine, database: model.database, schema: t.schema, table: t.name, objectType: t.kind };
		if (t.rows !== undefined && t.rows >= 0) data.rows = String(t.rows);
		if (t.comment) data.comment = t.comment.slice(0, 300);
		nodes.push({
			id: tableId(t.schema, t.name),
			label: t.kind === "view" ? `${t.name} (view)` : t.name,
			kind: `db:${t.kind}`,
			parent: multiSchema ? `schema:${slug(t.schema)}` : undefined,
			shape: "table",
			style,
			rows: rowsOf(t, fkColsByTable.get(`${t.schema}\u0000${t.name}`) ?? new Set(), large),
			data,
		});
	}

	// Referenced tables that were not mapped (another schema, no access): small stubs.
	const stubs = new Set<string>();
	for (const r of model.relations) {
		const child = known.get(`${r.schema}\u0000${r.table}`);
		if (!child) continue;
		const parentKey = `${r.refSchema}\u0000${r.refTable}`;
		const parentId = tableId(r.refSchema, r.refTable);
		if (!known.has(parentKey) && !stubs.has(parentId)) {
			stubs.add(parentId);
			nodes.push({
				id: parentId,
				label: `${r.refSchema}.${r.refTable}`,
				kind: "db:external-table",
				style: DB_STYLES.external,
				data: { engine: model.engine, database: model.database, schema: r.refSchema, table: r.refTable, objectType: "not mapped" },
			});
		}
		const nullable = r.columns.some((c) => child.columns.find((x) => x.name === c)?.nullable ?? false);
		const sameCols = (cols: string[]) => cols.length === r.columns.length && cols.every((c) => r.columns.includes(c));
		const oneToOne = sameCols(child.primaryKey) || child.uniques.some(sameCols);
		edges.push({
			from: parentId,
			to: tableId(r.schema, r.table),
			label: r.columns.join(", "),
			kind: r.inferred ? "ref" : "fk",
			style: relationStyle({ nullable, oneToOne, inferred: r.inferred }),
		});
	}

	const count = (k: DbTable["kind"]) => model.tables.filter((t) => t.kind === k).length;
	const what =
		model.engine === "mongodb"
			? `${count("collection")} collection(s)${count("view") ? `, ${count("view")} view(s)` : ""}`
			: `${count("table")} table(s)${count("view") ? `, ${count("view")} view(s)` : ""}`;
	const declared = model.relations.filter((r) => !r.inferred).length;
	const inferred = model.relations.length - declared;
	const legend = [
		`${engine}${model.version ? ` ${model.version}` : ""} · database ${model.database}`,
		`${what} in ${schemas.length} ${schemaWord}(s); ${declared ? `${declared} foreign key(s)` : model.engine === "mongodb" ? "" : "no foreign keys"}${inferred ? `${declared ? ", " : ""}${inferred} reference(s) guessed from sampled documents (dashed)` : ""}.`.replace("; .", "."),
		`Mapped read-only ${opts.now ?? new Date().toISOString()}.`,
		model.engine === "mongodb"
			? "Orange: collections with fields seen in sampled documents (type · share of documents that have it). PK = _id, FK = guessed reference."
			: "Blue: tables. Green, dashed: views. Edges are foreign keys from the referenced table to the referencing one (crow's foot = many; circle = optional).",
	];
	if (stubs.size) legend.push(`Grey, dashed: ${stubs.size} referenced table(s) outside the mapped ${schemaWord}s.`);
	if (model.skippedSchemas?.length) legend.push(`Skipped system ${schemaWord}s: ${model.skippedSchemas.slice(0, 12).join(", ")}${model.skippedSchemas.length > 12 ? ", …" : ""}.`);
	if (large) legend.push(`Large schema (${model.tables.length} objects): every table is mapped, but each shows its key columns and at most ${LARGE_MAX_ROWS} rows. Ask the agent to dig deeper into a subject area.`);

	return {
		title: `${engine} · ${model.database}`,
		nodes,
		edges,
		direction: "down",
		legend,
	};
}

/** Markdown facts for the agent: the schema without any connection details. */
export function modelFacts(model: DbModel, maxChars = 55_000): string {
	const out: string[] = [`# ${ENGINE_NAMES[model.engine]} database ${model.database}${model.version ? ` (${model.version})` : ""}`, ""];
	const rels = new Map<string, DbRelation[]>();
	for (const r of model.relations) {
		const k = `${r.schema}\u0000${r.table}`;
		if (!rels.has(k)) rels.set(k, []);
		rels.get(k)!.push(r);
	}
	const sorted = [...model.tables].sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
	for (const t of sorted) {
		const head = `## ${t.schema}.${t.name} (${t.kind}${t.rows !== undefined && t.rows >= 0 ? `, ~${t.rows} rows` : ""})`;
		const lines = [head];
		if (t.comment) lines.push(`> ${t.comment.slice(0, 300)}`);
		if (t.note) lines.push(t.note);
		if (t.primaryKey.length) lines.push(`PK: ${t.primaryKey.join(", ")}`);
		for (const u of t.uniques) lines.push(`Unique: ${u.join(", ")}`);
		lines.push(
			t.columns
				.map((c) => `- ${c.name}: ${c.type}${c.presence !== undefined ? ` (in ${c.presence}% of sampled documents)` : c.nullable ? " null" : " not null"}`)
				.join("\n")
		);
		for (const r of rels.get(`${t.schema}\u0000${t.name}`) ?? [])
			lines.push(`${r.inferred ? "Guessed reference" : "FK"}${r.name ? ` ${r.name}` : ""}: (${r.columns.join(", ")}) → ${r.refSchema}.${r.refTable}(${r.refColumns.join(", ")})`);
		out.push(lines.join("\n"), "");
		if (out.join("\n").length > maxChars) {
			out.push(`… ${sorted.length - sorted.indexOf(t) - 1} more objects not listed.`);
			break;
		}
	}
	return out.join("\n");
}

/** "a, b , c" → ["a","b","c"]. */
export function listInput(s: string | undefined): string[] {
	return (s ?? "")
		.split(/[,\s]+/)
		.map((x) => x.trim())
		.filter(Boolean);
}
