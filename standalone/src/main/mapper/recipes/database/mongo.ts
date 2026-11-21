/**
 * MongoDB: listCollections, listIndexes and a $sample of each collection. Field
 * types and presence come from the sampled documents (top level, plus one level
 * of nesting as `a.b`); references are guessed from ObjectId fields whose name
 * matches another collection (userId, user_id, user, items.productId...) and
 * from DBRefs. Only read commands are sent.
 */
import { MapperError } from "../../types";
import { checkAborted, closeQuietly, CONNECT_TIMEOUT_MS, connectionError, ConnSpec, onAbort, QUERY_TIMEOUT_MS } from "./connection";
import type { Engine, IntrospectOptions, RawCatalog } from "./engines";
import type { DbColumn, DbModel, DbRelation, DbTable } from "./model";

const SYSTEM_DBS = new Set(["admin", "local", "config"]);
const MAX_FIELDS = 200;
const MAX_COLLECTIONS = 1000;

export function mongoDbFromUrl(url: string): string | undefined {
	const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?#]*)/i.exec(url);
	const db = m?.[1] ? decodeURIComponent(m[1]) : "";
	return db || undefined;
}

function mongoUrl(spec: ConnSpec): string {
	if (spec.url) return spec.url;
	const auth = spec.user ? `${encodeURIComponent(spec.user)}:${encodeURIComponent(spec.password ?? "")}@` : "";
	return `mongodb://${auth}${spec.host}:${spec.port}/${spec.user ? "?authSource=admin" : ""}`;
}

export const mongoEngine: Engine = {
	async introspect(spec: ConnSpec, opts: IntrospectOptions): Promise<RawCatalog> {
		const mod: any = await import("mongodb");
		const { MongoClient, BSON } = mod.MongoClient ? mod : mod.default;
		const size = Math.max(1, Math.min(5000, Math.floor(opts.sampleSize) || 200));
		const url = mongoUrl(spec);
		// Timeouts given in the connection string win.
		const has = (o: string) => new RegExp(`[?&]${o}=`, "i").test(url);
		const client = new MongoClient(url, {
			...(has("serverSelectionTimeoutMS") ? {} : { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS }),
			...(has("connectTimeoutMS") ? {} : { connectTimeoutMS: CONNECT_TIMEOUT_MS }),
			socketTimeoutMS: QUERY_TIMEOUT_MS + 5000,
			readPreference: "secondaryPreferred",
			appName: "Draw.AI Mapper (read-only)",
			maxPoolSize: 2,
			retryWrites: false,
			...(spec.tls === "on" ? { tls: true } : spec.tls === "on-trust" ? { tls: true, tlsAllowInvalidCertificates: true } : spec.tls === "off" ? { tls: false } : {}),
		});
		const stop = onAbort(opts.signal, () => client.close(true));
		try {
			checkAborted(opts.signal);
			opts.progress("Connecting to MongoDB…");
			await client.connect();
			const version = await client
				.db("admin")
				.command({ buildInfo: 1 })
				.then((r: any) => String(r?.version ?? ""), () => "");
			let names = opts.schemas.length ? opts.schemas : [spec.database ?? (spec.url ? mongoDbFromUrl(spec.url) : undefined)].filter((x): x is string => !!x);
			if (!names.length) {
				opts.progress("Listing databases…");
				try {
					const r = await client.db("admin").admin().listDatabases({ nameOnly: true });
					names = (r.databases ?? []).map((d: any) => String(d.name)).filter((n: string) => !SYSTEM_DBS.has(n));
				} catch (e: any) {
					throw new MapperError("Name the database to map (in the connection string or the Database field); this user may not list databases.");
				}
			}
			const databases: any[] = [];
			for (const dbName of names) {
				const db = client.db(dbName);
				checkAborted(opts.signal);
				const infos = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c: any) => !String(c.name).startsWith("system.")).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
				const collections: any[] = [];
				for (const info of infos.slice(0, MAX_COLLECTIONS)) {
					checkAborted(opts.signal);
					const name = String(info.name);
					const entry: any = { name, type: info.type ?? "collection" };
					if (info.type === "view") {
						entry.viewOn = info.options?.viewOn;
						entry.stages = (info.options?.pipeline ?? []).map((s: any) => Object.keys(s)[0]).filter(Boolean);
						collections.push(entry);
						continue;
					}
					opts.progress(`Sampling ${dbName}.${name}…`);
					const coll = db.collection(name);
					entry.count = await coll.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS }).catch(() => undefined);
					entry.indexes = (await coll.listIndexes().toArray().catch(() => [])).map((i: any) => ({ name: i.name, key: i.key, unique: !!i.unique }));
					const docs = await coll.aggregate([{ $sample: { size } }], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false }).toArray();
					entry.sample = docs.map((d: any) => BSON.EJSON.serialize(d, { relaxed: true }));
					if (info.options?.timeseries) entry.timeseries = true;
					collections.push(entry);
				}
				databases.push({ name: dbName, collections, truncated: infos.length > MAX_COLLECTIONS ? infos.length : undefined });
			}
			return { engine: "mongodb", info: { database: names.length === 1 ? names[0] : `${names.length} databases`, version, sampleSize: size }, databases };
		} catch (e) {
			if (opts.signal.aborted) throw new MapperError("Cancelled");
			if (e instanceof MapperError) throw e;
			throw connectionError(e, spec);
		} finally {
			stop();
			await closeQuietly(() => client.close());
		}
	},

	toModel(raw: RawCatalog, opts: { includeViews: boolean }): DbModel {
		const tables: DbTable[] = [];
		const relations: DbRelation[] = [];
		const warnings: string[] = [];
		for (const db of raw.databases ?? []) {
			const names = (db.collections ?? []).map((c: any) => String(c.name));
			if (db.truncated) warnings.push(`${db.name}: only the first ${MAX_COLLECTIONS} of ${db.truncated} collections were mapped.`);
			for (const c of db.collections ?? []) {
				if (c.type === "view") {
					if (!opts.includeViews) continue;
					tables.push({
						schema: db.name,
						name: c.name,
						kind: "view",
						columns: c.viewOn ? [{ name: `on ${c.viewOn}`, type: (c.stages ?? []).join(", ") || "pipeline", nullable: false }] : [],
						primaryKey: [],
						uniques: [],
						note: `View on ${c.viewOn ?? "?"}: ${(c.stages ?? []).join(", ")}`,
					});
					continue;
				}
				const docs: any[] = c.sample ?? [];
				const inferred = inferFields(docs);
				const t: DbTable = {
					schema: db.name,
					name: c.name,
					kind: "collection",
					columns: inferred.columns,
					primaryKey: inferred.columns.some((x) => x.name === "_id") ? ["_id"] : [],
					uniques: [],
					rows: typeof c.count === "number" ? c.count : undefined,
					note: `${docs.length} document(s) sampled${c.timeseries ? "; time series collection" : ""}.`,
				};
				for (const i of c.indexes ?? []) {
					const keys = Object.keys(i.key ?? {});
					if (!keys.length || i.name === "_id_") continue;
					if (i.unique) t.uniques.push(keys);
					else (t.indexed ??= []).push(keys[0]);
				}
				if (inferred.truncated) warnings.push(`${db.name}.${c.name}: more than ${MAX_FIELDS} distinct fields; the rest were left out.`);
				tables.push(t);
				for (const col of inferred.columns) {
					const targets = new Set<string>([...(inferred.dbrefs.get(col.name) ?? [])]);
					const guess = /objectId/.test(col.type) ? guessCollection(col.name, names) : undefined;
					if (guess) targets.add(guess);
					for (const target of targets) {
						const [refDb, refColl] = target.includes("\u0000") ? target.split("\u0000") : [db.name, target];
						if (refColl === c.name && col.name === "_id") continue;
						relations.push({ schema: db.name, table: c.name, columns: [col.name], refSchema: refDb, refTable: refColl, refColumns: ["_id"], inferred: true });
					}
				}
			}
		}
		return {
			engine: "mongodb",
			database: String(raw.info.database ?? ""),
			version: raw.info.version || undefined,
			tables,
			relations,
			warnings,
		};
	},
};

/** The type of a value in relaxed Extended JSON. */
export function ejsonType(v: any): string {
	if (v === null || v === undefined) return "null";
	if (Array.isArray(v)) {
		const inner = [...new Set(v.slice(0, 50).map(ejsonType))];
		return `array<${inner.length === 0 ? "" : inner.length > 2 ? "mixed" : inner.join("|")}>`;
	}
	switch (typeof v) {
		case "string":
			return "string";
		case "boolean":
			return "bool";
		case "number":
			return Number.isInteger(v) ? "int" : "double";
		case "object": {
			if ("$oid" in v) return "objectId";
			if ("$date" in v) return "date";
			if ("$numberDecimal" in v) return "decimal";
			if ("$numberLong" in v) return "long";
			if ("$numberDouble" in v) return "double";
			if ("$numberInt" in v) return "int";
			if ("$uuid" in v) return "uuid";
			if ("$binary" in v) return v.$binary?.subType === "04" ? "uuid" : "binData";
			if ("$timestamp" in v) return "timestamp";
			if ("$regularExpression" in v) return "regex";
			if ("$ref" in v && "$id" in v) return "dbref";
			if ("$minKey" in v || "$maxKey" in v) return "minMaxKey";
			if ("$code" in v) return "javascript";
			if ("$symbol" in v) return "symbol";
			return "object";
		}
		default:
			return typeof v;
	}
}

const isPlainObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v) && ejsonType(v) === "object";

/** Field types (most frequent first) and presence in the sample; DBRef targets per field. */
export function inferFields(docs: any[]): { columns: DbColumn[]; dbrefs: Map<string, Set<string>>; truncated: boolean } {
	const stats = new Map<string, { docs: number; types: Map<string, number> }>();
	const dbrefs = new Map<string, Set<string>>();
	let truncated = false;
	const see = (path: string, type: string, seenInDoc: Set<string>) => {
		let s = stats.get(path);
		if (!s) {
			if (stats.size >= MAX_FIELDS) {
				truncated = true;
				return;
			}
			s = { docs: 0, types: new Map() };
			stats.set(path, s);
		}
		if (!seenInDoc.has(path)) {
			seenInDoc.add(path);
			s.docs++;
		}
		s.types.set(type, (s.types.get(type) ?? 0) + 1);
	};
	const noteRef = (path: string, v: any) => {
		const values = Array.isArray(v) ? v : [v];
		for (const x of values)
			if (x && typeof x === "object" && "$ref" in x && "$id" in x) {
				if (!dbrefs.has(path)) dbrefs.set(path, new Set());
				dbrefs.get(path)!.add(x.$db ? `${x.$db}\u0000${x.$ref}` : String(x.$ref));
			}
	};
	for (const doc of docs) {
		if (!isPlainObject(doc)) continue;
		const seen = new Set<string>();
		for (const [k, v] of Object.entries(doc)) {
			see(k, ejsonType(v), seen);
			noteRef(k, v);
			const nested = isPlainObject(v) ? [v] : Array.isArray(v) ? v.filter(isPlainObject) : [];
			const prefix = Array.isArray(v) ? `${k}[]` : k;
			const seenNested = new Set<string>();
			for (const o of nested.slice(0, 50))
				for (const [k2, v2] of Object.entries(o as object)) {
					const p = `${prefix}.${k2}`;
					const t = ejsonType(v2);
					// Count each nested path once per document, its types once per value.
					if (!seenNested.has(p + "\u0000" + t)) {
						seenNested.add(p + "\u0000" + t);
						see(p, t, seen);
					}
					noteRef(p, v2);
				}
		}
	}
	const n = docs.length || 1;
	const columns: DbColumn[] = [...stats.entries()].map(([name, s]) => {
		const types = [...s.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
		const presence = Math.round((s.docs / n) * 100);
		return { name, type: types.length > 3 ? `mixed (${types.slice(0, 2).join("|")}…)` : types.join("|"), nullable: presence < 100 || types.includes("null"), presence };
	});
	// _id first, then in order of first appearance.
	columns.sort((a, b) => (a.name === "_id" ? -1 : b.name === "_id" ? 1 : 0));
	return { columns, dbrefs, truncated };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** userId / user_id / user / items[].productId / customer._id → the collection it names, if any. */
export function guessCollection(field: string, collections: string[]): string | undefined {
	const parts = field.replace(/\[\]/g, "").split(".");
	let last = parts[parts.length - 1];
	if (last === "_id" || last === "id") {
		if (parts.length < 2) return undefined; // the document's own id
		last = parts[parts.length - 2];
	}
	const base = last.replace(/(_ids?|Ids?|IDs?)$/, "");
	if (!base) return undefined;
	const b = norm(base);
	const candidates = new Set([b, `${b}s`, `${b}es`, b.replace(/y$/, "ies"), b.replace(/s$/, "")]);
	const byNorm = new Map(collections.map((c) => [norm(c), c]));
	for (const c of candidates) if (byNorm.has(c)) return byNorm.get(c);
	return undefined;
}
