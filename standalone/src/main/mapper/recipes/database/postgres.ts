/**
 * PostgreSQL (and Supabase, Neon, RDS, Cloud SQL...): pg_catalog queries inside a
 * READ ONLY transaction that is rolled back. Works through transaction poolers
 * (no startup options; the timeout is SET LOCAL).
 */
import { MapperError } from "../../types";
import { checkAborted, closeQuietly, CONNECT_TIMEOUT_MS, connectionError, ConnSpec, onAbort, QUERY_TIMEOUT_MS } from "./connection";
import { Engine, IntrospectOptions, num, RawCatalog, str, TableSet, truthy } from "./engines";
import type { DbModel, DbRelation } from "./model";

/** Never mapped. */
const SYSTEM = ["pg_catalog", "information_schema", "pg_toast"];
/** Platform schemas (Supabase, PostGIS, TimescaleDB...): skipped unless asked for. */
export const PG_PLATFORM_SCHEMAS = [
	"auth",
	"storage",
	"realtime",
	"_realtime",
	"extensions",
	"graphql",
	"graphql_public",
	"vault",
	"pgsodium",
	"pgsodium_masks",
	"supabase_functions",
	"supabase_migrations",
	"net",
	"cron",
	"pgbouncer",
	"_analytics",
	"tiger",
	"tiger_data",
	"topology",
	"timescaledb_information",
	"timescaledb_experimental",
	"_timescaledb_catalog",
	"_timescaledb_internal",
	"_timescaledb_config",
	"_timescaledb_cache",
	"_timescaledb_functions",
	"repack",
	"pglogical",
];

// $1: schemas to include ('{}' = all), $2: schemas to exclude, $3: system schemas.
const SCHEMA_FILTER = `n.nspname <> ALL($3::text[]) AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
  AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[])) AND n.nspname <> ALL($2::text[])`;

export const PG_QUERIES = {
	info: `SELECT current_database() AS database, current_setting('server_version') AS version`,
	schemas: `SELECT n.nspname AS schema FROM pg_namespace n WHERE n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`,
	tables: `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, obj_description(c.oid, 'pg_class') AS comment,
  CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${SCHEMA_FILTER}
ORDER BY 1, 2`,
	columns: `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, a.attnum AS position,
  format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${SCHEMA_FILTER}
ORDER BY 1, 2, a.attnum`,
	constraints: `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype::text AS type,
  ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
  rn.nspname AS ref_schema, rc.relname AS ref_table,
  ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class rc ON rc.oid = con.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype IN ('p','u','f') AND NOT c.relispartition AND ${SCHEMA_FILTER}
ORDER BY 1, 2, 3`,
	indexes: `SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
  ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','m') AND NOT c.relispartition AND ${SCHEMA_FILTER}
ORDER BY 1, 2, 3`,
};

/** For TLS choices other than "auto" the form decides, not the URL's sslmode. */
function pgConfig(spec: ConnSpec): any {
	const base: any = {
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
		query_timeout: QUERY_TIMEOUT_MS,
		application_name: "OmniDraw Mapper (read-only)",
	};
	const ssl = spec.tls === "on" ? { rejectUnauthorized: true } : spec.tls === "on-trust" ? { rejectUnauthorized: false } : spec.tls === "off" ? false : undefined;
	if (spec.url) {
		let url = spec.url;
		if (ssl !== undefined) {
			try {
				const u = new URL(url);
				for (const p of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(p);
				url = u.toString();
			} catch {
				// not a URL (key=value form): leave it
			}
		}
		return { ...base, connectionString: url, ...(ssl !== undefined ? { ssl } : {}) };
	}
	return { ...base, host: spec.host, port: spec.port, database: spec.database ?? "postgres", user: spec.user, password: spec.password, ...(ssl !== undefined ? { ssl } : {}) };
}

export const postgresEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		// Loaded on first use (the bundler keeps the literal require).
		const pg: any = require("pg");
		const Client = (pg as any).Client ?? (pg as any).default?.Client;
		const client = new Client(pgConfig(spec));
		client.on("error", () => undefined); // a dropped connection rejects the running query; nothing else to do
		const stop = onAbort(opts.signal, () => client.end());
		try {
			checkAborted(opts.signal);
			opts.progress("Connecting to PostgreSQL…");
			await client.connect();
			checkAborted(opts.signal);
			await client.query("BEGIN TRANSACTION READ ONLY");
			await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
			const q = async (sql: string, params: any[] = []) => {
				checkAborted(opts.signal);
				return (await client.query(sql, params)).rows as Record<string, any>[];
			};
			const info = (await q(PG_QUERIES.info))[0] ?? {};
			const all = (await q(PG_QUERIES.schemas, [SYSTEM])).map((r) => str(r.schema));
			const exclude = opts.schemas.length ? [] : PG_PLATFORM_SCHEMAS;
			const params = [opts.schemas, exclude, SYSTEM];
			opts.progress("Reading tables and columns…");
			const tables = await q(PG_QUERIES.tables, params);
			const columns = await q(PG_QUERIES.columns, params);
			opts.progress("Reading keys and indexes…");
			const constraints = await q(PG_QUERIES.constraints, params);
			const indexes = await q(PG_QUERIES.indexes, params);
			await client.query("ROLLBACK").catch(() => undefined);
			return {
				engine: "postgres",
				info: { database: str(info.database), version: str(info.version).split(" ")[0], requestedSchemas: opts.schemas, skippedSchemas: all.filter((s) => exclude.includes(s)) },
				tables,
				columns,
				constraints,
				indexes,
			};
		} catch (e) {
			if (opts.signal.aborted) throw new MapperError("Cancelled");
			throw connectionError(e, spec);
		} finally {
			stop();
			await closeQuietly(() => client.end());
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const set = new TableSet();
		const KIND: Record<string, "table" | "view"> = { r: "table", p: "table", f: "table", v: "view", m: "view" };
		for (const r of raw.tables ?? []) {
			const t = set.add({ schema: str(r.schema), name: str(r.name), kind: KIND[str(r.kind)] ?? "table", columns: [], primaryKey: [], uniques: [] });
			if (r.comment) t.comment = str(r.comment);
			const rows = num(r.row_estimate);
			if (rows !== undefined && t.kind === "table") t.rows = rows;
			if (str(r.kind) === "m") t.note = "Materialized view.";
			if (str(r.kind) === "f") t.note = "Foreign table.";
		}
		for (const c of raw.columns ?? []) {
			set.get(str(c.schema), str(c.table))?.columns.push({ name: str(c.name), type: str(c.type), nullable: truthy(c.nullable) });
		}
		const relations: DbRelation[] = [];
		const arr = (v: any): string[] => (Array.isArray(v) ? v.map(str) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : []);
		for (const c of raw.constraints ?? []) {
			const t = set.get(str(c.schema), str(c.table));
			if (!t) continue;
			const cols = arr(c.columns);
			if (c.type === "p") t.primaryKey = cols;
			else if (c.type === "u") t.uniques.push(cols);
			else if (c.type === "f")
				relations.push({ name: str(c.name), schema: t.schema, table: t.name, columns: cols, refSchema: str(c.ref_schema), refTable: str(c.ref_table), refColumns: arr(c.ref_columns) });
		}
		for (const i of raw.indexes ?? []) {
			const t = set.get(str(i.schema), str(i.table));
			const cols = arr(i.columns);
			if (!t || !cols.length || truthy(i.is_primary)) continue;
			if (truthy(i.is_unique)) {
				if (!t.uniques.some((u) => u.join() === cols.join())) t.uniques.push(cols);
			} else (t.indexed ??= []).push(cols[0]);
		}
		const tables = set.list(opts.includeViews);
		const kept = new Set(tables.map((t) => `${t.schema}\u0000${t.name}`));
		return {
			engine: "postgres",
			database: str(raw.info.database),
			version: str(raw.info.version) || undefined,
			tables,
			relations: relations.filter((r) => kept.has(`${r.schema}\u0000${r.table}`)),
			skippedSchemas: raw.info.skippedSchemas ?? [],
			warnings: [],
		};
	},
};

