/**
 * MySQL / MariaDB: information_schema inside START TRANSACTION READ ONLY, rolled back.
 * In MySQL a schema is a database: by default the connected database, else all
 * non-system ones.
 */
import { MapperError } from "../../types";
import { checkAborted, closeQuietly, CONNECT_TIMEOUT_MS, connectionError, ConnSpec, onAbort, QUERY_TIMEOUT_MS } from "./connection";
import { Engine, groupConstraints, IntrospectOptions, lowerKeys, num, RawCatalog, str, TableSet, truthy } from "./engines";
import type { DbModel, DbRelation } from "./model";

const SYSTEM = "'mysql','information_schema','performance_schema','sys'";
// ? (twice): comma list of schemas, '' = all non-system ones.
const FILTER = (col: string) => `${col} NOT IN (${SYSTEM}) AND (? = '' OR FIND_IN_SET(${col}, ?) > 0)`;

export const MYSQL_QUERIES = {
	info: "SELECT DATABASE() AS db, VERSION() AS version",
	tables: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type, TABLE_COMMENT AS comment, TABLE_ROWS AS row_estimate
FROM information_schema.TABLES WHERE ${FILTER("TABLE_SCHEMA")} ORDER BY TABLE_SCHEMA, TABLE_NAME`,
	columns: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS position,
  COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key
FROM information_schema.COLUMNS WHERE ${FILTER("TABLE_SCHEMA")} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
	keys: `SELECT kcu.TABLE_SCHEMA AS table_schema, kcu.TABLE_NAME AS table_name, kcu.CONSTRAINT_NAME AS constraint_name, tc.CONSTRAINT_TYPE AS constraint_type,
  kcu.COLUMN_NAME AS column_name, kcu.ORDINAL_POSITION AS position,
  kcu.REFERENCED_TABLE_SCHEMA AS ref_schema, kcu.REFERENCED_TABLE_NAME AS ref_table, kcu.REFERENCED_COLUMN_NAME AS ref_column
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND tc.TABLE_NAME = kcu.TABLE_NAME AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${FILTER("kcu.TABLE_SCHEMA")}
ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
	indexes: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SEQ_IN_INDEX AS position
FROM information_schema.STATISTICS WHERE INDEX_NAME <> 'PRIMARY' AND ${FILTER("TABLE_SCHEMA")}
ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
};

function mysqlConfig(spec: ConnSpec): any {
	const ssl = spec.tls === "on" ? { rejectUnauthorized: true } : spec.tls === "on-trust" ? { rejectUnauthorized: false } : undefined;
	const base: any = { connectTimeout: CONNECT_TIMEOUT_MS, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: false, dateStrings: true, ...(ssl ? { ssl } : {}) };
	if (spec.url) return { ...base, uri: spec.url };
	return { ...base, host: spec.host, port: spec.port, user: spec.user, password: spec.password, database: spec.database };
}

export const mysqlEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		const mysql: any = await import("mysql2/promise");
		let conn: any;
		const stop = onAbort(opts.signal, () => conn?.destroy());
		try {
			checkAborted(opts.signal);
			opts.progress("Connecting to MySQL…");
			conn = await (mysql.createConnection ?? mysql.default.createConnection)(mysqlConfig(spec));
			checkAborted(opts.signal);
			await conn.query("SET SESSION TRANSACTION READ ONLY");
			await conn.query("START TRANSACTION READ ONLY");
			const q = async (sql: string, params: any[] = []) => {
				checkAborted(opts.signal);
				const [rows] = await conn.query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
				return (rows as any[]).map(lowerKeys);
			};
			const info = (await q(MYSQL_QUERIES.info))[0] ?? {};
			const schemas = opts.schemas.length ? opts.schemas.join(",") : str(info.db);
			const params = [schemas, schemas];
			opts.progress("Reading tables and columns…");
			const tables = await q(MYSQL_QUERIES.tables, params);
			const columns = await q(MYSQL_QUERIES.columns, params);
			opts.progress("Reading keys and indexes…");
			const keys = await q(MYSQL_QUERIES.keys, params);
			const indexes = await q(MYSQL_QUERIES.indexes, params);
			await conn.query("ROLLBACK").catch(() => undefined);
			return { engine: "mysql", info: { database: str(info.db), version: str(info.version), schemas }, tables, columns, keys, indexes };
		} catch (e) {
			if (opts.signal.aborted) throw new MapperError("Cancelled");
			throw connectionError(e, spec);
		} finally {
			stop();
			if (conn) await closeQuietly(() => conn.end());
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const set = new TableSet();
		for (const r of raw.tables ?? []) {
			const t = set.add({ schema: str(r.table_schema), name: str(r.table_name), kind: /VIEW/.test(str(r.table_type)) ? "view" : "table", columns: [], primaryKey: [], uniques: [] });
			if (r.comment && t.kind === "table") t.comment = str(r.comment);
			const rows = num(r.row_estimate);
			if (rows !== undefined && t.kind === "table") t.rows = rows;
		}
		for (const c of raw.columns ?? []) {
			set.get(str(c.table_schema), str(c.table_name))?.columns.push({ name: str(c.column_name), type: str(c.column_type), nullable: truthy(c.is_nullable) });
		}
		const relations: DbRelation[] = [];
		const keyGroups = groupConstraints(raw.keys ?? [], (r: any) => `${r.table_schema}\u0000${r.table_name}\u0000${r.constraint_name}`, (r: any) => num(r.position) ?? 0);
		for (const g of keyGroups) {
			const first = g[0];
			const t = set.get(str(first.table_schema), str(first.table_name));
			if (!t) continue;
			if (first.constraint_type === "PRIMARY KEY") t.primaryKey = g.map((r) => str(r.column_name));
			else if (first.ref_table)
				relations.push({
					name: str(first.constraint_name),
					schema: t.schema,
					table: t.name,
					columns: g.map((r) => str(r.column_name)),
					refSchema: str(first.ref_schema),
					refTable: str(first.ref_table),
					refColumns: g.map((r) => str(r.ref_column)),
				});
		}
		const idxGroups = groupConstraints(raw.indexes ?? [], (r: any) => `${r.table_schema}\u0000${r.table_name}\u0000${r.index_name}`, (r: any) => num(r.position) ?? 0);
		for (const g of idxGroups) {
			const t = set.get(str(g[0].table_schema), str(g[0].table_name));
			const cols = g.map((r) => str(r.column_name)).filter(Boolean);
			if (!t || !cols.length) continue;
			if (num(g[0].non_unique) === 0) t.uniques.push(cols);
			else (t.indexed ??= []).push(cols[0]);
		}
		const tables = set.list(opts.includeViews);
		const kept = new Set(tables.map((t) => `${t.schema}\u0000${t.name}`));
		const version = str(raw.info.version);
		return {
			engine: "mysql",
			database: str(raw.info.database) || str(raw.info.schemas) || "(server)",
			version: /mariadb/i.test(version) ? `${version.split("-")[0]} (MariaDB)` : version.split("-")[0] || undefined,
			tables,
			relations: relations.filter((r) => kept.has(`${r.schema}\u0000${r.table}`)),
			warnings: [],
		};
	},
};
