/**
 * Oracle (thin mode, no client libraries): ALL_* dictionary views inside
 * SET TRANSACTION READ ONLY, rolled back. Owners default to all users that are
 * not Oracle-maintained (12c+).
 */
import { MapperError } from "../../types";
import { checkAborted, closeQuietly, CONNECT_TIMEOUT_MS, connectionError, ConnSpec, onAbort, QUERY_TIMEOUT_MS } from "./connection";
import { Engine, groupConstraints, IntrospectOptions, lowerKeys, num, RawCatalog, str, TableSet } from "./engines";
import type { DbModel, DbRelation } from "./model";

// :schemas: comma list of owners, NULL ('' in Oracle) = all non-Oracle-maintained users.
const FILTER = (col: string) =>
	`((:schemas IS NULL AND ${col} IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')) OR INSTR(',' || :schemas || ',', ',' || ${col} || ',') > 0)`;

export const ORACLE_QUERIES = {
	info: `SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS db_name, SYS_CONTEXT('USERENV', 'CON_NAME') AS con_name FROM dual`,
	version: `SELECT version_full FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1`,
	tables: `SELECT t.owner, t.table_name, 'TABLE' AS kind, t.num_rows, c.comments
FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
WHERE t.dropped = 'NO' AND t.nested = 'NO' AND t.secondary = 'N' AND t.table_name NOT LIKE 'BIN$%' AND (t.iot_type IS NULL OR t.iot_type = 'IOT') AND ${FILTER("t.owner")}
UNION ALL
SELECT v.owner, v.view_name, 'VIEW', NULL, c.comments
FROM all_views v LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
WHERE ${FILTER("v.owner")}
ORDER BY 1, 2`,
	columns: `SELECT owner, table_name, column_name, column_id, data_type, data_length, char_length, char_used, data_precision, data_scale, nullable
FROM all_tab_columns WHERE table_name NOT LIKE 'BIN$%' AND ${FILTER("owner")}
ORDER BY owner, table_name, column_id`,
	constraints: `SELECT c.owner, c.table_name, c.constraint_name, c.constraint_type, cc.column_name, cc.position,
  r.owner AS r_owner, r.table_name AS r_table_name, rcc.column_name AS r_column_name
FROM all_constraints c
JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name
LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
LEFT JOIN all_cons_columns rcc ON rcc.owner = r.owner AND rcc.constraint_name = r.constraint_name AND rcc.position = cc.position
WHERE c.constraint_type IN ('P', 'U', 'R') AND c.table_name NOT LIKE 'BIN$%' AND ${FILTER("c.owner")}
ORDER BY c.owner, c.table_name, c.constraint_name, cc.position`,
	indexes: `SELECT i.table_owner, i.table_name, i.index_name, i.uniqueness, ic.column_name, ic.column_position
FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
WHERE i.index_type NOT IN ('LOB') AND i.table_name NOT LIKE 'BIN$%' AND ${FILTER("i.table_owner")}
ORDER BY i.table_owner, i.table_name, i.index_name, ic.column_position`,
};

/** oracle://user:pass@host:port/service, user/pass@host:port/service, or fields. */
export function oracleConnectParams(spec: ConnSpec): { user?: string; password?: string; connectString: string } {
	const withTls = (cs: string) => (spec.tls === "on" || spec.tls === "on-trust") && !/^tcps:\/\//i.test(cs) && !/^\s*\(/.test(cs) ? `tcps://${cs.replace(/^tcp:\/\//i, "")}` : cs;
	if (spec.url) {
		const uri = /^oracle:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(.+)$/i.exec(spec.url);
		if (uri) return { user: uri[1] ? decodeURIComponent(uri[1]) : undefined, password: uri[2] ? decodeURIComponent(uri[2]) : undefined, connectString: withTls(uri[3]) };
		const ez = /^([^/@\s]+)\/([^@\s]+)@(.+)$/.exec(spec.url);
		if (ez) return { user: ez[1], password: ez[2], connectString: withTls(ez[3].replace(/^\/\//, "")) };
		throw new MapperError("Oracle connection strings must include the user, e.g. oracle://user:password@host:1521/service or user/password@host:1521/service.");
	}
	return { user: spec.user, password: spec.password, connectString: withTls(`${spec.host}:${spec.port}/${spec.database ?? "FREEPDB1"}`) };
}

export function oracleType(c: Record<string, any>): string {
	const t = str(c.data_type);
	if (/^(N?VARCHAR2|N?CHAR)$/.test(t)) return `${t}(${num(c.char_length) ?? num(c.data_length)}${c.char_used === "C" && !t.startsWith("N") ? " CHAR" : ""})`;
	if (t === "NUMBER") {
		const p = num(c.data_precision);
		const s = num(c.data_scale);
		if (p === undefined) return s === 0 ? "INTEGER" : "NUMBER";
		return s ? `NUMBER(${p},${s})` : `NUMBER(${p})`;
	}
	if (t === "RAW") return `RAW(${num(c.data_length)})`;
	return t;
}

export const oracleEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		// Loaded on first use (the bundler keeps the literal require).
		const mod: any = require("oracledb");
		const oracledb = mod.getConnection ? mod : mod.default;
		const params = oracleConnectParams(spec);
		let conn: any;
		const stop = onAbort(opts.signal, () => conn?.break?.().finally(() => conn?.close()));
		try {
			checkAborted(opts.signal);
			opts.progress("Connecting to Oracle…");
			conn = await oracledb.getConnection({
				...params,
				connectTimeout: Math.ceil(CONNECT_TIMEOUT_MS / 1000),
				transportConnectTimeout: Math.ceil(CONNECT_TIMEOUT_MS / 1000),
				...(spec.tls === "on-trust" ? { sslServerDNMatch: false } : {}),
			});
			conn.callTimeout = QUERY_TIMEOUT_MS;
			checkAborted(opts.signal);
			await conn.execute("SET TRANSACTION READ ONLY");
			const schemas = opts.schemas.map((s) => (/^".*"$/.test(s) ? s.slice(1, -1) : s.toUpperCase())).join(",");
			const q = async (sql: string, binds: Record<string, any> = {}) => {
				checkAborted(opts.signal);
				const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
				return ((r.rows ?? []) as Record<string, any>[]).map(lowerKeys);
			};
			const info = (await q(ORACLE_QUERIES.info))[0] ?? {};
			const version = await q(ORACLE_QUERIES.version).then((r) => str(r[0]?.version_full), () => "");
			const b = { schemas: schemas || null };
			opts.progress("Reading tables and columns…");
			const tables = await q(ORACLE_QUERIES.tables, b);
			const columns = await q(ORACLE_QUERIES.columns, b);
			opts.progress("Reading keys and indexes…");
			const constraints = await q(ORACLE_QUERIES.constraints, b);
			const indexes = await q(ORACLE_QUERIES.indexes, b);
			await conn.rollback().catch(() => undefined);
			return { engine: "oracle", info: { database: str(info.con_name) || str(info.db_name), version }, tables, columns, constraints, indexes };
		} catch (e) {
			if (opts.signal.aborted) throw new MapperError("Cancelled");
			throw connectionError(e, spec);
		} finally {
			stop();
			if (conn) await closeQuietly(() => conn.close());
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const set = new TableSet();
		for (const r of raw.tables ?? []) {
			const t = set.add({ schema: str(r.owner), name: str(r.table_name), kind: r.kind === "VIEW" ? "view" : "table", columns: [], primaryKey: [], uniques: [] });
			if (r.comments) t.comment = str(r.comments);
			const rows = num(r.num_rows);
			if (rows !== undefined && t.kind === "table") t.rows = rows;
		}
		for (const c of raw.columns ?? []) {
			set.get(str(c.owner), str(c.table_name))?.columns.push({ name: str(c.column_name), type: oracleType(c), nullable: c.nullable === "Y" });
		}
		const relations: DbRelation[] = [];
		for (const g of groupConstraints(raw.constraints ?? [], (r: any) => `${r.owner}\u0000${r.table_name}\u0000${r.constraint_name}`, (r: any) => num(r.position) ?? 0)) {
			const f = g[0];
			const t = set.get(str(f.owner), str(f.table_name));
			if (!t) continue;
			const cols = g.map((r) => str(r.column_name));
			if (f.constraint_type === "P") t.primaryKey = cols;
			else if (f.constraint_type === "U") t.uniques.push(cols);
			else if (f.constraint_type === "R" && f.r_table_name)
				relations.push({ name: str(f.constraint_name), schema: t.schema, table: t.name, columns: cols, refSchema: str(f.r_owner), refTable: str(f.r_table_name), refColumns: g.map((r) => str(r.r_column_name)) });
		}
		for (const g of groupConstraints(raw.indexes ?? [], (r: any) => `${r.table_owner}\u0000${r.table_name}\u0000${r.index_name}`, (r: any) => num(r.column_position) ?? 0)) {
			const t = set.get(str(g[0].table_owner), str(g[0].table_name));
			const cols = g.map((r) => str(r.column_name));
			if (!t || cols.some((c) => c.startsWith("SYS_NC"))) continue;
			if (cols.join() === t.primaryKey.join()) continue;
			if (g[0].uniqueness === "UNIQUE") {
				if (!t.uniques.some((u) => u.join() === cols.join())) t.uniques.push(cols);
			} else (t.indexed ??= []).push(cols[0]);
		}
		const tables = set.list(opts.includeViews);
		const kept = new Set(tables.map((t) => `${t.schema}\u0000${t.name}`));
		return {
			engine: "oracle",
			database: str(raw.info.database),
			version: str(raw.info.version) || undefined,
			tables,
			relations: relations.filter((r) => kept.has(`${r.schema}\u0000${r.table}`)),
			warnings: [],
		};
	},
};
