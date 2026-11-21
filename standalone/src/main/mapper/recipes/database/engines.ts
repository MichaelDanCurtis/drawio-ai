/** What every engine module provides: fixed catalog queries, and rows → model. */
import type { ConnSpec } from "./connection";
import type { DbModel, DbTable, EngineId } from "./model";

export interface IntrospectOptions {
	/** Schemas / owners / MongoDB databases to map; empty = all non-system ones. */
	schemas: string[];
	includeViews: boolean;
	/** MongoDB: documents sampled per collection. */
	sampleSize: number;
	signal: AbortSignal;
	progress(text: string): void;
}

/**
 * The catalog rows as the fixed queries return them (keys lower-cased). Stored as
 * JSON fixtures, so the model can be tested without a server.
 */
export interface RawCatalog {
	engine: EngineId;
	info: Record<string, any>;
	[part: string]: any;
}

export interface Engine {
	introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog>;
	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel;
}

/** Row helpers shared by the SQL engines. */
export const str = (v: any): string => (v === null || v === undefined ? "" : Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
export const num = (v: any): number | undefined => {
	if (v === null || v === undefined || v === "") return undefined;
	const n = typeof v === "bigint" ? Number(v) : Number(v);
	return Number.isFinite(n) ? n : undefined;
};
export const truthy = (v: any): boolean => v === true || v === 1 || v === "1" || v === "YES" || v === "Y" || v === "t" || v === "true";

export function lowerKeys(row: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = typeof v === "bigint" ? Number(v) : v;
	return out;
}

/** Collects table / constraint rows into DbTables keyed by schema + name. */
export class TableSet {
	readonly byKey = new Map<string, DbTable>();
	key = (schema: string, name: string) => `${schema}\u0000${name}`;
	add(t: DbTable): DbTable {
		const k = this.key(t.schema, t.name);
		if (!this.byKey.has(k)) this.byKey.set(k, t);
		return this.byKey.get(k)!;
	}
	get(schema: string, name: string): DbTable | undefined {
		return this.byKey.get(this.key(schema, name));
	}
	list(includeViews: boolean): DbTable[] {
		return [...this.byKey.values()].filter((t) => includeViews || t.kind !== "view");
	}
}

/** Groups multi-row constraints (one row per column) by schema + table + name, ordered by position. */
export function groupConstraints<T extends Record<string, any>>(rows: T[], keyOf: (r: T) => string, posOf: (r: T) => number): T[][] {
	const groups = new Map<string, T[]>();
	for (const r of rows) {
		const k = keyOf(r);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(r);
	}
	return [...groups.values()].map((g) => g.sort((a, b) => posOf(a) - posOf(b)));
}
