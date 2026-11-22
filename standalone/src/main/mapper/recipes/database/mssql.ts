/**
 * SQL Server / Azure SQL: sys.* catalog views, with ApplicationIntent=ReadOnly
 * (routes to a readable secondary where there is one) inside a transaction that
 * is rolled back.
 */
import { MapperError } from "../../types";
import { checkAborted, closeQuietly, CONNECT_TIMEOUT_MS, connectionError, ConnSpec, onAbort, QUERY_TIMEOUT_MS } from "./connection";
import { Engine, groupConstraints, IntrospectOptions, num, RawCatalog, str, TableSet, truthy } from "./engines";
import type { DbModel, DbRelation } from "./model";

// @schemas: comma list, '' = all user schemas.
const FILTER = (alias: string) =>
	`${alias}.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest') AND (@schemas = N'' OR CHARINDEX(N',' + ${alias}.name + N',', N',' + @schemas + N',') > 0)`;

export const MSSQL_QUERIES = {
	info: `SELECT DB_NAME() AS db, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition`,
	tables: `SELECT s.name AS table_schema, o.name AS table_name, RTRIM(o.type) AS type, CAST(ep.value AS nvarchar(4000)) AS comment,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS row_estimate
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${FILTER("s")}
ORDER BY s.name, o.name`,
	columns: `SELECT s.name AS table_schema, o.name AS table_name, c.name AS column_name, c.column_id AS position, TYPE_NAME(c.user_type_id) AS type,
  c.max_length AS max_length, c.precision AS precision, c.scale AS scale, c.is_nullable AS is_nullable, c.is_identity AS is_identity
FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${FILTER("s")}
ORDER BY s.name, o.name, c.column_id`,
	indexes: `SELECT s.name AS table_schema, o.name AS table_name, i.name AS index_name, i.is_primary_key AS is_primary_key, i.is_unique AS is_unique,
  c.name AS column_name, ic.key_ordinal AS position
FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE i.type > 0 AND ic.is_included_column = 0 AND ic.key_ordinal > 0 AND o.is_ms_shipped = 0 AND ${FILTER("s")}
ORDER BY s.name, o.name, i.name, ic.key_ordinal`,
	foreignKeys: `SELECT fk.name AS fk_name, s.name AS table_schema, t.name AS table_name, pc.name AS column_name,
  rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column, fkc.constraint_column_id AS position
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.objects t ON t.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE ${FILTER("s")}
ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`,
};

function mssqlConfig(sql: any, spec: ConnSpec): any {
	let config: any;
	if (spec.url) {
		config = sql.ConnectionPool.parseConnectionString(spec.url);
	} else {
		config = { server: spec.host, port: spec.port, database: spec.database, user: spec.user, password: spec.password, options: {} };
	}
	config.options = { ...(config.options ?? {}), readOnlyIntent: true, appName: "OmniDraw Mapper (read-only)" };
	if (spec.tls === "on") Object.assign(config.options, { encrypt: true, trustServerCertificate: false });
	if (spec.tls === "on-trust") Object.assign(config.options, { encrypt: true, trustServerCertificate: true });
	if (spec.tls === "off") Object.assign(config.options, { encrypt: false });
	config.connectionTimeout = CONNECT_TIMEOUT_MS;
	config.requestTimeout = QUERY_TIMEOUT_MS;
	config.pool = { max: 1, min: 0 };
	return config;
}

export function mssqlType(c: Record<string, any>): string {
	const t = str(c.type);
	const len = num(c.max_length) ?? 0;
	if (["varchar", "char", "varbinary", "binary"].includes(t)) return `${t}(${len === -1 ? "max" : len})`;
	if (["nvarchar", "nchar"].includes(t)) return `${t}(${len === -1 ? "max" : len / 2})`;
	if (["decimal", "numeric"].includes(t)) return `${t}(${c.precision},${c.scale})`;
	if (["datetime2", "time", "datetimeoffset"].includes(t) && num(c.scale) !== 7) return `${t}(${c.scale})`;
	return t + (truthy(c.is_identity) ? " identity" : "");
}

export const mssqlEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		// Loaded on first use (the bundler keeps the literal require).
		const mod: any = require("mssql");
		const sql = mod.ConnectionPool ? mod : mod.default;
		const pool = new sql.ConnectionPool(mssqlConfig(sql, spec));
		pool.on("error", () => undefined);
		const stop = onAbort(opts.signal, () => pool.close());
		try {
			checkAborted(opts.signal);
			opts.progress("Connecting to SQL Server…");
			await pool.connect();
			checkAborted(opts.signal);
			const tx = new sql.Transaction(pool);
			await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
			const schemas = opts.schemas.join(",");
			const q = async (text: string) => {
				checkAborted(opts.signal);
				const req = new sql.Request(tx);
				req.input("schemas", sql.NVarChar(4000), schemas);
				return (await req.query(text)).recordset as Record<string, any>[];
			};
			const info = (await q(MSSQL_QUERIES.info))[0] ?? {};
			opts.progress("Reading tables and columns…");
			const tables = await q(MSSQL_QUERIES.tables);
			const columns = await q(MSSQL_QUERIES.columns);
			opts.progress("Reading keys and indexes…");
			const indexes = await q(MSSQL_QUERIES.indexes);
			const foreignKeys = await q(MSSQL_QUERIES.foreignKeys);
			await tx.rollback().catch(() => undefined);
			return { engine: "mssql", info: { database: str(info.db), version: str(info.version), azure: num(info.engine_edition) === 5 }, tables, columns, indexes, foreignKeys };
		} catch (e) {
			if (opts.signal.aborted) throw new MapperError("Cancelled");
			throw connectionError(e, spec);
		} finally {
			stop();
			await closeQuietly(() => pool.close());
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const set = new TableSet();
		for (const r of raw.tables ?? []) {
			const t = set.add({ schema: str(r.table_schema), name: str(r.table_name), kind: str(r.type) === "V" ? "view" : "table", columns: [], primaryKey: [], uniques: [] });
			if (r.comment) t.comment = str(r.comment);
			const rows = num(r.row_estimate);
			if (rows !== undefined && t.kind === "table") t.rows = rows;
		}
		for (const c of raw.columns ?? []) {
			set.get(str(c.table_schema), str(c.table_name))?.columns.push({ name: str(c.column_name), type: mssqlType(c), nullable: truthy(c.is_nullable) });
		}
		for (const g of groupConstraints(raw.indexes ?? [], (r: any) => `${r.table_schema}\u0000${r.table_name}\u0000${r.index_name}`, (r: any) => num(r.position) ?? 0)) {
			const t = set.get(str(g[0].table_schema), str(g[0].table_name));
			const cols = g.map((r) => str(r.column_name));
			if (!t) continue;
			if (truthy(g[0].is_primary_key)) t.primaryKey = cols;
			else if (truthy(g[0].is_unique)) t.uniques.push(cols);
			else (t.indexed ??= []).push(cols[0]);
		}
		const relations: DbRelation[] = [];
		for (const g of groupConstraints(raw.foreignKeys ?? [], (r: any) => `${r.table_schema}\u0000${r.table_name}\u0000${r.fk_name}`, (r: any) => num(r.position) ?? 0)) {
			const f = g[0];
			relations.push({
				name: str(f.fk_name),
				schema: str(f.table_schema),
				table: str(f.table_name),
				columns: g.map((r) => str(r.column_name)),
				refSchema: str(f.ref_schema),
				refTable: str(f.ref_table),
				refColumns: g.map((r) => str(r.ref_column)),
			});
		}
		const tables = set.list(opts.includeViews);
		const kept = new Set(tables.map((t) => `${t.schema}\u0000${t.name}`));
		return {
			engine: "mssql",
			database: str(raw.info.database),
			version: `${str(raw.info.version)}${raw.info.azure ? " (Azure SQL)" : ""}` || undefined,
			tables,
			relations: relations.filter((r) => kept.has(`${r.schema}\u0000${r.table}`)),
			warnings: [],
		};
	},
};
