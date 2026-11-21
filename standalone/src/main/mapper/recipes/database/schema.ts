/**
 * "Database schema (ERD)": connects read-only to PostgreSQL, MySQL, SQL Server,
 * Oracle, SQLite or MongoDB, reads the catalog with fixed queries and draws the
 * tables, keys and relations. No host, user, password or connection string ever
 * reaches the map, the facts, the summary or the messages.
 */
import { agentRequest, digDeeperRequest } from "../common";
import { MapperError } from "../../types";
import type { CollectResult, FieldDef, MapInput, Recipe } from "../../types";
import { abortable, connectionError, connSpecFromInput, isOn, scrubSecrets } from "./connection";
import type { Engine, RawCatalog } from "./engines";
import { schemaFindings } from "./findings";
import { DbModel, ENGINE_NAMES, ENGINES, EngineId, LARGE_SCHEMA, listInput, modelFacts, modelToGraph } from "./model";
import { mongoEngine } from "./mongo";
import { mssqlEngine } from "./mssql";
import { mysqlEngine } from "./mysql";
import { oracleEngine } from "./oracle";
import { postgresEngine } from "./postgres";
import { sqliteEngine } from "./sqlite";

export const ENGINE_IMPL: Record<EngineId, Engine> = {
	postgres: postgresEngine,
	mysql: mysqlEngine,
	mssql: mssqlEngine,
	oracle: oracleEngine,
	sqlite: sqliteEngine,
	mongodb: mongoEngine,
};

const SERVERS = ["postgres", "mysql", "mssql", "oracle", "mongodb"];

export const SCHEMA_FIELDS: FieldDef[] = [
	{ id: "engine", label: "Database", type: "select", required: true, default: "postgres", options: ENGINES.map((e) => ({ value: e.id, label: e.label })) },
	{ id: "file", label: "SQLite file", type: "file", help: "Opened read-only.", showIf: { field: "engine", values: ["sqlite"] } },
	{
		id: "connectWith",
		label: "Connect with",
		type: "select",
		default: "url",
		options: [
			{ value: "url", label: "Connection string" },
			{ value: "fields", label: "Host and credentials" },
		],
		showIf: { field: "engine", values: SERVERS },
	},
	{
		id: "connectionString",
		label: "Connection string",
		type: "password",
		secret: true,
		placeholder: "postgres://user:password@host:5432/db",
		help: "Never stored, shown on the map or sent to the agent. Postgres / MySQL / MongoDB URLs, SQL Server \"Server=…;Database=…\" strings, Oracle oracle://user:password@host:1521/service. A read-only user is enough.",
		showIf: { field: "connectWith", values: ["url"] },
	},
	{ id: "host", label: "Host", type: "text", placeholder: "localhost", showIf: { field: "connectWith", values: ["fields"] } },
	{ id: "port", label: "Port", type: "text", placeholder: "the engine's default", showIf: { field: "connectWith", values: ["fields"] } },
	{
		id: "database",
		label: "Database",
		type: "text",
		help: "Oracle: the service name (e.g. FREEPDB1). MongoDB: leave empty to map every database you can list.",
		showIf: { field: "connectWith", values: ["fields"] },
	},
	{ id: "user", label: "User", type: "text", showIf: { field: "connectWith", values: ["fields"] } },
	{ id: "password", label: "Password", type: "password", secret: true, showIf: { field: "connectWith", values: ["fields"] } },
	{
		id: "tls",
		label: "TLS",
		type: "select",
		default: "auto",
		options: [
			{ value: "auto", label: "As in the connection string / driver default" },
			{ value: "on", label: "Required" },
			{ value: "on-trust", label: "Required, trust the server certificate (self-signed)" },
			{ value: "off", label: "Off (local databases)" },
		],
		showIf: { field: "engine", values: SERVERS },
	},
	{
		id: "schemas",
		label: "Schemas to map",
		type: "text",
		placeholder: "all non-system schemas",
		help: "Comma-separated. PostgreSQL / SQL Server: schemas; MySQL: databases (default: the connected one); Oracle: owners; MongoDB: databases.",
		showIf: { field: "engine", values: SERVERS },
	},
	{ id: "includeViews", label: "Include views", type: "checkbox", default: "true" },
	{ id: "sampleSize", label: "Documents sampled per collection", type: "text", default: "200", showIf: { field: "engine", values: ["mongodb"] } },
];

/** Model → map, facts, summary (exported for tests with recorded catalog rows). */
export function resultFromModel(model: DbModel, opts: { now?: string; secrets?: string[] } = {}): CollectResult {
	const tables = model.tables.filter((t) => t.kind !== "view").length;
	const views = model.tables.length - tables;
	const schemas = new Set(model.tables.map((t) => t.schema)).size;
	const word = model.engine === "mongodb" ? "collection" : "table";
	const warnings = [...model.warnings];
	if (model.tables.length > LARGE_SCHEMA) warnings.push(`${model.tables.length} objects: all are mapped, each with its key columns only, to keep the map usable.`);
	const scrub = (s: string) => scrubSecrets(s, opts.secrets ?? []);
	if (model.tables.length === 0) {
		return {
			summary: `No ${word}s found in ${ENGINE_NAMES[model.engine]} database ${model.database}.`,
			warnings: [...warnings, "Check the schemas to map, and that the user may read them."].map(scrub),
		};
	}
	const declared = model.relations.filter((r) => !r.inferred).length;
	const guessed = model.relations.length - declared;
	const rel = [declared ? `${declared} foreign key(s)` : "", guessed ? `${guessed} guessed reference(s)` : ""].filter(Boolean).join(", ");
	const graph = modelToGraph(model, { now: opts.now });
	const { findings, checked } = schemaFindings(model, graph);
	return {
		graph,
		findings,
		checked,
		facts: modelFacts(model),
		summary: `${tables} ${word}(s)${views ? `, ${views} view(s)` : ""}${rel ? `, ${rel}` : ""} in ${schemas} ${model.engine === "mongodb" ? "database" : "schema"}(s) · ${ENGINE_NAMES[model.engine]}${model.version ? ` ${model.version}` : ""}`,
		warnings: warnings.map(scrub),
	};
}

export function resultFromRaw(raw: RawCatalog, opts: { includeViews: boolean; now?: string; secrets?: string[] }): CollectResult {
	return resultFromModel(ENGINE_IMPL[raw.engine].toModel(raw, { includeViews: opts.includeViews }), opts);
}

export const databaseSchemaRecipe: Recipe = {
	id: "database.schema",
	category: "database",
	title: "Database schema (ERD)",
	description:
		"Tables, columns, keys and foreign keys of PostgreSQL (Supabase, Neon, RDS), MySQL / MariaDB, SQL Server / Azure SQL, Oracle and SQLite, or MongoDB collections with fields and references inferred from sampled documents. Read-only session, catalog queries only.",
	mode: "inventory",
	fields: SCHEMA_FIELDS,
	async collect(input: MapInput, ctx): Promise<CollectResult> {
		const spec = connSpecFromInput(input, ctx);
		const includeViews = isOn(input.includeViews, true);
		let raw: RawCatalog;
		try {
			raw = await abortable(ctx.signal, ENGINE_IMPL[spec.engine].introspect(spec, {
				schemas: listInput(input.schemas),
				includeViews,
				sampleSize: Number(input.sampleSize || 200),
				signal: ctx.signal,
				progress: ctx.progress,
			}));
		} catch (e: any) {
			// Belt and braces: whatever the engine threw, nothing secret goes out.
			if (e instanceof MapperError) throw new MapperError(scrubSecrets(e.message, spec.secrets), e.hint && scrubSecrets(e.hint, spec.secrets));
			throw connectionError(e, spec);
		}
		ctx.progress("Drawing the schema…");
		return resultFromRaw(raw, { includeViews, secrets: spec.secrets });
	},
	agentPrompt(input: MapInput, result: CollectResult | undefined): string {
		const engine = ENGINE_NAMES[(input.engine as EngineId) || "postgres"] ?? "database";
		return agentRequest(
			`This page maps a ${engine} schema (drawn by the Mapper from the catalog, read-only). Explain its domain model on the map: group the tables into subject areas (a labelled, lightly coloured container or background behind each group, moving tables only as much as needed), add one short note per area saying what it stores and how the areas relate, and flag notable design issues next to the tables they concern (tables without a primary key, columns that look like references but have no foreign key, nullable keys that look mandatory, duplicated data). You have no database connection: work from the map and the facts below, and the repository if one is open.`,
			result?.facts
		);
	},
	digDeeper(shapes, question) {
		return digDeeperRequest(
			"database tables / collections (there is no database connection: search the open repository read-only for the table names in ORM models, migrations, SQL and queries)",
			shapes,
			question.trim() || "where are they used in the code? Note next to each table which modules or services read and write it, and the main queries."
		);
	},
};
