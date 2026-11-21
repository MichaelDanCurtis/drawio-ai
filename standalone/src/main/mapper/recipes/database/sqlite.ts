/**
 * SQLite: the file is opened read-only (node:sqlite) with PRAGMA query_only, and
 * read through sqlite_master and the table-valued pragma functions.
 */
import * as fs from "fs";
import * as path from "path";
import { MapperError } from "../../types";
import { checkAborted, ConnSpec } from "./connection";
import { Engine, groupConstraints, IntrospectOptions, num, RawCatalog, str, TableSet } from "./engines";
import type { DbModel, DbRelation } from "./model";

export const SQLITE_QUERIES = {
	version: "SELECT sqlite_version() AS version",
	tables: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
	columns: "SELECT cid, name, type, \"notnull\" AS not_null, pk FROM pragma_table_info(?)",
	foreignKeys: "SELECT id, seq, \"table\" AS ref_table, \"from\" AS col, \"to\" AS ref_col FROM pragma_foreign_key_list(?)",
	indexes: "SELECT name, \"unique\" AS is_unique, origin FROM pragma_index_list(?)",
	indexColumns: "SELECT seqno, name FROM pragma_index_info(?)",
};

export const sqliteEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		const file = spec.file!;
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MapperError(`${path.basename(file)} is not a file.`);
		let DatabaseSync: any;
		try {
			DatabaseSync = (await import("node:sqlite")).DatabaseSync;
		} catch {
			throw new MapperError("SQLite support needs a newer runtime (node:sqlite is not available).");
		}
		checkAborted(opts.signal);
		opts.progress(`Reading ${path.basename(file)}…`);
		let db: any;
		try {
			db = new DatabaseSync(file, { readOnly: true });
			db.exec("PRAGMA query_only = ON");
			const all = (sql: string, ...params: any[]) => db.prepare(sql).all(...params) as Record<string, any>[];
			const version = str(all(SQLITE_QUERIES.version)[0]?.version);
			const tables = all(SQLITE_QUERIES.tables);
			const columns: any[] = [];
			const foreignKeys: any[] = [];
			const indexes: any[] = [];
			for (const t of tables) {
				checkAborted(opts.signal);
				for (const c of all(SQLITE_QUERIES.columns, t.name)) columns.push({ table: t.name, ...c });
				if (t.type !== "table") continue;
				for (const f of all(SQLITE_QUERIES.foreignKeys, t.name)) foreignKeys.push({ table: t.name, ...f });
				for (const i of all(SQLITE_QUERIES.indexes, t.name)) {
					const cols = all(SQLITE_QUERIES.indexColumns, i.name).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => c.name);
					indexes.push({ table: t.name, name: i.name, is_unique: i.is_unique, origin: i.origin, columns: cols });
				}
			}
			return { engine: "sqlite", info: { database: path.basename(file), version }, tables, columns, foreignKeys, indexes };
		} catch (e: any) {
			if (e instanceof MapperError) throw e;
			throw new MapperError(`Could not read ${path.basename(file)}: ${String(e?.message ?? e).split("\n")[0]}`, /not a database|malformed/i.test(String(e?.message)) ? "Is it a SQLite database file?" : undefined);
		} finally {
			try {
				db?.close();
			} catch {
				// already closed
			}
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const set = new TableSet();
		const schema = "main";
		for (const r of raw.tables ?? []) set.add({ schema, name: str(r.name), kind: r.type === "view" ? "view" : "table", columns: [], primaryKey: [], uniques: [] });
		const pks = new Map<string, { name: string; pk: number }[]>();
		for (const c of raw.columns ?? []) {
			const t = set.get(schema, str(c.table));
			if (!t) continue;
			// Primary key columns are NOT NULL in effect only for INTEGER PRIMARY KEY / WITHOUT ROWID; show what is declared.
			t.columns.push({ name: str(c.name), type: str(c.type) || "any", nullable: !num(c.not_null) && !(num(c.pk) && /^integer$/i.test(str(c.type))) });
			if (num(c.pk)) {
				if (!pks.has(t.name)) pks.set(t.name, []);
				pks.get(t.name)!.push({ name: str(c.name), pk: num(c.pk)! });
			}
		}
		for (const [name, cols] of pks) set.get(schema, name)!.primaryKey = cols.sort((a, b) => a.pk - b.pk).map((c) => c.name);
		for (const i of raw.indexes ?? []) {
			const t = set.get(schema, str(i.table));
			const cols: string[] = (i.columns ?? []).map(str).filter(Boolean);
			if (!t || !cols.length || i.origin === "pk") continue;
			if (num(i.is_unique)) t.uniques.push(cols);
			else (t.indexed ??= []).push(cols[0]);
		}
		const relations: DbRelation[] = [];
		for (const g of groupConstraints(raw.foreignKeys ?? [], (r: any) => `${r.table}\u0000${r.id}`, (r: any) => num(r.seq) ?? 0)) {
			const t = set.get(schema, str(g[0].table));
			if (!t) continue;
			const refTable = str(g[0].ref_table);
			// `REFERENCES parent` without columns means the parent's primary key.
			const refPk = set.get(schema, refTable)?.primaryKey ?? [];
			relations.push({
				schema,
				table: t.name,
				columns: g.map((r) => str(r.col)),
				refSchema: schema,
				refTable,
				refColumns: g.map((r, i) => str(r.ref_col) || refPk[i] || ""),
			});
		}
		const tables = set.list(opts.includeViews);
		const kept = new Set(tables.map((t) => t.name));
		return {
			engine: "sqlite",
			database: str(raw.info.database),
			version: str(raw.info.version) || undefined,
			tables,
			relations: relations.filter((r) => kept.has(r.table)),
			warnings: [],
		};
	},
};
