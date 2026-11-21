// Tests for the database mappers: graph building from recorded catalog rows per
// engine (test/fixtures/database/*.json), crow's-foot styles, secret scrubbing,
// large schemas, dbt lineage, and the rendered XML.
//
// Live tests against real databases run only with MAPPER_DB_LIVE=1 and the
// containers from test/fixtures/database/live/containers.sh; each engine is skipped
// when its port does not answer. MAPPER_DB_RECORD=1 also rewrites the fixtures.
// Run from standalone/: node --test test/database.test.js
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const { renderGraph } = require("../src/main/mapper/render");
const { databaseRecipes } = require("../src/main/mapper/recipes/database");
const { databaseSchemaRecipe, resultFromRaw, resultFromModel, ENGINE_IMPL, SCHEMA_FIELDS } = require("../src/main/mapper/recipes/database/schema");
const { scrubSecrets, connSpecFromInput, secretsOfConnectionString } = require("../src/main/mapper/recipes/database/connection");
const { relationStyle, LARGE_SCHEMA } = require("../src/main/mapper/recipes/database/model");
const { inferFields, guessCollection } = require("../src/main/mapper/recipes/database/mongo");
const { oracleConnectParams } = require("../src/main/mapper/recipes/database/oracle");
const { dbtLineageRecipe, manifestToGraph } = require("../src/main/mapper/recipes/database/dbt");
const { checkModelXml } = require("./helpers/xml");

const FIX = path.join(__dirname, "fixtures/database");
const NOW = "2026-01-01T00:00:00.000Z";
const loadRaw = (engine) => JSON.parse(fs.readFileSync(path.join(FIX, `${engine}.json`), "utf8"));
const ctx = (cwd = os.tmpdir()) => ({ cwd, progress: () => {}, signal: new AbortController().signal, exec: async () => assert.fail("no commands") });

// ----- helpers to look at a result -----

function view(result) {
	const g = result.graph;
	const node = (pred) => g.nodes.find(pred);
	const table = (name) => node((n) => n.data?.table?.toLowerCase() === name && n.kind !== "db:external-table");
	const rows = (name) => Object.fromEntries(table(name).rows.map((r) => [r.text.toLowerCase(), r]));
	const edge = (fromTable, toTable) => {
		const from = g.nodes.find((n) => n.data?.table?.toLowerCase() === fromTable);
		const to = table(toTable);
		return g.edges.find((e) => e.from === from?.id && e.to === to?.id);
	};
	return { g, node, table, rows, edge };
}

/** What every SQL engine's shop schema must look like on the map. */
function checkShop(result, { engine, viewName = "order_totals", rowsKnown = true } = {}) {
	const { g, table, rows, edge } = view(result);
	for (const t of ["customers", "customer_profiles", "addresses", "products", "orders", "order_items", "employees"]) assert.ok(table(t), `${engine}: table ${t}`);
	// Composite PK whose columns are also FKs.
	const oi = rows("order_items");
	assert.equal(oi.order_id.key, "PK,FK", `${engine}: order_items.order_id is PK,FK`);
	assert.equal(oi.product_id.key, "PK,FK");
	assert.equal(oi.quantity.key, undefined);
	assert.equal(rows("customers").email.key, "UK", `${engine}: unique email`);
	assert.equal(rows("customers").id.key, "PK");
	assert.equal(rows("orders").status.key, "IDX", `${engine}: indexed status`);
	assert.match(rows("orders").shipping_address_id.detail, /null$/, `${engine}: nullable FK shows null`);
	assert.doesNotMatch(rows("orders").customer_id.detail, /null$/);
	// FK edges go from the referenced table to the referencing one, labelled with the columns.
	const mandatory = edge("customers", "orders");
	assert.ok(mandatory, `${engine}: customers → orders`);
	assert.match(mandatory.label.toLowerCase(), /customer_id/);
	assert.match(mandatory.style, /edgeStyle=entityRelationEdgeStyle/);
	assert.match(mandatory.style, /startArrow=ERmandOne/);
	assert.match(mandatory.style, /endArrow=ERmany/);
	assert.match(edge("addresses", "orders").style, /startArrow=ERzeroToOne/, `${engine}: optional FK`);
	assert.match(edge("customers", "customer_profiles").style, /endArrow=ERzeroToOne/, `${engine}: 1:1`);
	assert.ok(edge("employees", "employees"), `${engine}: self reference`);
	assert.equal(edge("orders", "order_items").kind, "fk");
	// The view, drawn differently.
	const v = table(viewName);
	assert.ok(v, `${engine}: view`);
	assert.equal(v.kind, "db:view");
	assert.match(v.style, /dashed=1/);
	assert.notEqual(v.style, table("orders").style);
	if (rowsKnown) assert.ok(g.nodes.every((n) => n.kind !== "db:table" || n.data.engine === engine));
	for (const n of g.nodes.filter((n) => n.shape === "table")) assert.deepEqual(Object.keys(n.data).filter((k) => !["engine", "database", "schema", "table", "objectType", "rows", "comment"].includes(k)), []);
	assert.ok(g.legend.some((l) => /read-only/i.test(l)));
	checkModelXml(renderGraph(g, { recipe: databaseSchemaRecipe.id }).xml);
}

// ----- fixtures (recorded from the live databases) -----

describe("schema maps from recorded catalog rows", () => {
	test("PostgreSQL: two schemas as containers, platform schema skipped but referenced as a stub", () => {
		const r = resultFromRaw(loadRaw("postgres"), { includeViews: true, now: NOW });
		checkShop(r, { engine: "postgres" });
		const { g, table, node } = view(r);
		assert.ok(node((n) => n.id === "schema:public" && n.container), "public container");
		assert.ok(node((n) => n.id === "schema:billing" && n.container), "billing container");
		assert.equal(table("invoices").parent, "schema:billing");
		assert.equal(table("orders").parent, "schema:public");
		const stub = node((n) => n.kind === "db:external-table");
		assert.equal(stub?.label, "auth.users", "FK into a skipped schema becomes a stub");
		assert.ok(g.edges.some((e) => e.from === stub.id && e.label === "auth_user_id"));
		assert.ok(g.legend.some((l) => /Skipped system schemas: auth/.test(l)));
		assert.equal(table("customers").data.comment, "People who buy things");
		assert.match(view(r).rows("orders").id.detail, /^bigint$/);
		assert.match(r.summary, /8 table\(s\), 1 view\(s\), 9 foreign key\(s\) in 2 schema\(s\) · PostgreSQL 16/);
		assert.match(r.facts, /FK orders_customer_id_fkey: \(customer_id\) → public\.customers\(id\)/);
	});

	test("PostgreSQL without views", () => {
		const r = resultFromRaw(loadRaw("postgres"), { includeViews: false, now: NOW });
		assert.ok(!r.graph.nodes.some((n) => n.kind === "db:view"));
	});

	test("MySQL: databases are schemas", () => {
		const r = resultFromRaw(loadRaw("mysql"), { includeViews: true, now: NOW });
		checkShop(r, { engine: "mysql" });
		const { table } = view(r);
		assert.equal(table("invoices").parent, "schema:shop_billing");
		assert.match(view(r).rows("products").price.detail, /^decimal\(10,2\)$/);
	});

	test("SQL Server: sys.* rows, nvarchar lengths and identity", () => {
		const r = resultFromRaw(loadRaw("mssql"), { includeViews: true, now: NOW });
		checkShop(r, { engine: "mssql" });
		const rows = view(r).rows("customers");
		assert.equal(rows.email.detail, "nvarchar(255)");
		assert.equal(rows.id.detail, "int identity");
		assert.equal(view(r).table("invoices").parent, "schema:sales");
	});

	test("Oracle: owner, NUMBER / VARCHAR2 types", () => {
		const r = resultFromRaw(loadRaw("oracle"), { includeViews: true, now: NOW });
		checkShop(r, { engine: "oracle" });
		const rows = view(r).rows("customers");
		assert.equal(rows.email.detail, "VARCHAR2(255 CHAR)");
		assert.equal(rows.id.detail, "NUMBER(10)");
		assert.equal(view(r).table("customers").data.schema, "SHOP");
		assert.ok(!r.graph.nodes.some((n) => n.container), "one owner: no containers");
	});

	test("SQLite: pragma rows", () => {
		const r = resultFromRaw(loadRaw("sqlite"), { includeViews: true, now: NOW });
		checkShop(r, { engine: "sqlite" });
		assert.equal(view(r).table("orders").data.database, "shop.db");
	});

	test("MongoDB: fields with presence, guessed references and DBRefs", () => {
		const r = resultFromRaw(loadRaw("mongodb"), { includeViews: true, now: NOW });
		const { g, table, rows, edge } = view(r);
		for (const c of ["customers", "orders", "products", "payments", "reviews"]) assert.equal(table(c)?.kind, "db:collection", c);
		assert.equal(rows("customers")._id.key, "PK");
		assert.equal(rows("customers").email.key, "UK");
		assert.equal(rows("customers")["address.city"].detail, "string");
		assert.match(rows("customers").vip.detail, /^bool · 67%$/);
		assert.match(rows("orders").couponcode.detail, /· 33%$/);
		assert.equal(rows("orders").customerid.key, "FK");
		const ref = edge("customers", "orders");
		assert.ok(ref, "orders.customerId → customers");
		assert.equal(ref.kind, "ref");
		assert.match(ref.style, /dashed=1/);
		assert.ok(edge("products", "orders"), "orders.items[].productId → products");
		assert.ok(edge("orders", "payments"), "payments.order DBRef → orders");
		assert.ok(edge("customers", "reviews") && edge("products", "reviews"), "reviews.customer, reviews.product_id");
		assert.equal(table("big_orders").kind, "db:view");
		assert.match(r.summary, /5 collection\(s\), 1 view\(s\), 5 guessed reference\(s\) in 1 database\(s\) · MongoDB 7/);
		checkModelXml(renderGraph(g, { recipe: databaseSchemaRecipe.id }).xml);
	});
});

describe("building blocks", () => {
	test("crow's-foot styles use draw.io's ER marker names", () => {
		const s = relationStyle({ nullable: false, oneToOne: false });
		assert.match(s, /edgeStyle=entityRelationEdgeStyle;/);
		assert.match(s, /startArrow=ERmandOne;/);
		assert.match(s, /endArrow=ERmany;/);
		assert.match(relationStyle({ nullable: true, oneToOne: false }), /startArrow=ERzeroToOne;/);
		assert.match(relationStyle({ nullable: false, oneToOne: true }), /endArrow=ERzeroToOne;/);
		// The names draw.io knows (EditorUi marker images).
		const drawio = path.resolve(__dirname, "../../drawio/src/main/webapp/js/grapheditor/EditorUi.js");
		if (fs.existsSync(drawio)) {
			const src = fs.readFileSync(drawio, "utf8");
			for (const m of ["ERmandOne", "ERmany", "ERzeroToOne"]) assert.ok(src.includes(`'${m}'`), m);
		}
	});

	test("MongoDB inference: types, presence, one nesting level, arrays of subdocuments", () => {
		const oid = (h) => ({ $oid: h.padEnd(24, "0") });
		const { columns, dbrefs } = inferFields([
			{ _id: oid("1"), userId: oid("a"), tags: ["x"], meta: { a: 1, b: { deep: true } }, lines: [{ skuId: oid("s"), n: 2 }], ref: { $ref: "things", $id: oid("t") } },
			{ _id: oid("2"), userId: null, price: 1.5, when: { $date: "2024-01-01T00:00:00Z" } },
		]);
		const col = Object.fromEntries(columns.map((c) => [c.name, c]));
		assert.equal(columns[0].name, "_id");
		assert.equal(col.userId.type, "objectId|null");
		assert.equal(col.userId.presence, 100);
		assert.equal(col.tags.type, "array<string>");
		assert.equal(col["meta.a"].type, "int");
		assert.equal(col["meta.b"].type, "object", "only one level of nesting");
		assert.ok(!col["meta.b.deep"]);
		assert.equal(col["lines[].skuId"].type, "objectId");
		assert.equal(col.price.presence, 50);
		assert.equal(col.when.type, "date");
		assert.deepEqual([...dbrefs.get("ref")], ["things"]);
		const colls = ["users", "categories", "order_items", "boxes"];
		assert.equal(guessCollection("userId", colls), "users");
		assert.equal(guessCollection("user_id", colls), "users");
		assert.equal(guessCollection("user", colls), "users");
		assert.equal(guessCollection("categoryIds", colls), "categories");
		assert.equal(guessCollection("lines[].orderItemId", colls), "order_items");
		assert.equal(guessCollection("box._id", colls), "boxes");
		assert.equal(guessCollection("_id", colls), undefined);
		assert.equal(guessCollection("ownerId", colls), undefined);
	});

	test("large schemas: every table mapped, key columns only, noted in the legend", () => {
		const n = LARGE_SCHEMA + 50;
		const tables = Array.from({ length: n }, (_, i) => ({
			schema: "s",
			name: `t${i}`,
			kind: "table",
			columns: [{ name: "id", type: "int", nullable: false }, ...(i ? [{ name: "parent_id", type: "int", nullable: true }] : []), ...Array.from({ length: 30 }, (_, k) => ({ name: `c${k}`, type: "text", nullable: true }))],
			primaryKey: ["id"],
			uniques: [],
		}));
		const relations = tables.slice(1).map((t, i) => ({ schema: "s", table: t.name, columns: ["parent_id"], refSchema: "s", refTable: `t${Math.floor(i / 3)}`, refColumns: ["id"] }));
		const r = resultFromModel({ engine: "postgres", database: "big", tables, relations, warnings: [] }, { now: NOW });
		assert.equal(r.graph.nodes.filter((x) => x.kind === "db:table").length, n);
		const t5 = r.graph.nodes.find((x) => x.data?.table === "t5");
		assert.ok(t5.rows.length <= 13);
		assert.deepEqual(t5.rows.slice(0, 2).map((x) => x.key), ["PK", "FK"]);
		assert.match(t5.rows[t5.rows.length - 1].text, /more columns/);
		assert.ok(r.graph.legend.some((l) => /Large schema/.test(l)));
		assert.ok(r.warnings.some((w) => /all are mapped/.test(w)));
		const t0 = Date.now();
		const { xml } = renderGraph(r.graph, { recipe: "database.schema" });
		checkModelXml(xml);
		assert.ok(Date.now() - t0 < 10_000, "layout stays fast");
	});

	test("empty databases give a summary, not an empty map", () => {
		const r = resultFromModel({ engine: "mysql", database: "empty", tables: [], relations: [], warnings: [] });
		assert.equal(r.graph, undefined);
		assert.match(r.summary, /No tables found/);
	});

	test("form: showIf only points at fields that exist; secrets are flagged", () => {
		const ids = new Set(SCHEMA_FIELDS.map((f) => f.id));
		for (const f of SCHEMA_FIELDS) if (f.showIf) assert.ok(ids.has(f.showIf.field), f.id);
		const secret = SCHEMA_FIELDS.filter((f) => f.secret).map((f) => f.id);
		assert.deepEqual(secret.sort(), ["connectionString", "password"]);
		for (const id of secret) assert.equal(SCHEMA_FIELDS.find((f) => f.id === id).type, "password");
		assert.deepEqual(databaseRecipes.map((r) => r.id), ["database.schema", "database.dbt-lineage"]);
	});
});

// ----- secrets -----

describe("secrets never leave the collector", () => {
	const PASSWORD = "Sup3r-S3cret!pw";
	const USER = "acme_admin";
	const HOST = "db-prod-7.internal.acme.example";

	test("scrubbing removes credentials, hosts and IPs from driver messages", () => {
		const url = `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:5432/sales?sslmode=require`;
		const secrets = secretsOfConnectionString(url);
		for (const msg of [
			`password authentication failed for user "${USER}"`,
			`getaddrinfo ENOTFOUND ${HOST}`,
			`connect ECONNREFUSED 10.1.2.3:5432`,
			`connect ECONNREFUSED [fd00::1:5]:5432 at 12:30:45`,
			`bad url ${url}`,
			`Login failed. Server=${HOST},1433;User Id=${USER};Password=${PASSWORD};`,
		]) {
			const out = scrubSecrets(msg, secrets);
			for (const s of [PASSWORD, encodeURIComponent(PASSWORD), USER, HOST, "10.1.2.3", "fd00::1:5"]) assert.ok(!out.includes(s), `${s} in ${out}`);
		}
		assert.match(scrubSecrets("at 12:30:45", []), /12:30:45/, "times survive");
		const ado = secretsOfConnectionString(`Server=tcp:${HOST},1433;Database=x;User Id=${USER};Password="${PASSWORD}";Encrypt=true`);
		for (const s of [HOST, USER, PASSWORD]) assert.ok(ado.includes(s), s);
		assert.deepEqual(oracleConnectParams({ url: `oracle://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:1521/ORCL`, tls: "auto" }), { user: USER, password: PASSWORD, connectString: `${HOST}:1521/ORCL` });
		assert.equal(oracleConnectParams({ url: `${USER}/${PASSWORD}@${HOST}:1521/ORCL`, tls: "on" }).connectString, `tcps://${HOST}:1521/ORCL`);
	});

	const unreachable = [
		["postgres", { connectWith: "url", connectionString: `postgres://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/sales` }],
		["mysql", { connectWith: "fields", host: "127.0.0.1", port: "1", user: USER, password: PASSWORD, database: "sales" }],
		["mssql", { connectWith: "url", connectionString: `Server=127.0.0.1,1;Database=sales;User Id=${USER};Password=${PASSWORD};Encrypt=false` }],
		["oracle", { connectWith: "url", connectionString: `oracle://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/ORCL` }],
		["mongodb", { connectWith: "url", connectionString: `mongodb://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/sales?serverSelectionTimeoutMS=500` }],
	];
	for (const [engine, input] of unreachable) {
		test(`${engine}: a connection error names no secret`, { timeout: 40_000 }, async () => {
			const err = await databaseSchemaRecipe.collect({ engine, tls: "off", ...input }, ctx()).then(
				() => assert.fail("must not connect"),
				(e) => e
			);
			assert.equal(err.constructor.name, "MapperError", String(err));
			const text = `${err.message} ${err.hint ?? ""}`;
			for (const s of [PASSWORD, encodeURIComponent(PASSWORD), USER, "127.0.0.1", input.connectionString ?? "\u0000"]) assert.ok(!text.includes(s), `${engine}: "${s}" in "${text}"`);
			assert.ok(err.hint, `${engine}: a hint (${err.message})`);
		});
	}

	test("missing inputs are reported plainly", () => {
		assert.throws(() => connSpecFromInput({ engine: "postgres", connectWith: "url" }, ctx()), /connection string/);
		assert.throws(() => connSpecFromInput({ engine: "postgres", connectWith: "fields" }, ctx()), /host/);
		assert.throws(() => connSpecFromInput({ engine: "sqlite" }, ctx()), /SQLite/);
		assert.throws(() => connSpecFromInput({ engine: "nope" }, ctx()), /Unknown/);
	});

	test("cancelling stops the run", async () => {
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(databaseSchemaRecipe.collect({ engine: "postgres", connectWith: "url", connectionString: "postgres://u:p@127.0.0.1:1/x" }, { ...ctx(), signal: ac.signal }), /Cancelled/);
	});
});

// ----- SQLite end to end (no server needed) -----

let sqlite;
try {
	sqlite = require("node:sqlite");
} catch {
	sqlite = undefined;
}

/** Writes the shop schema to a new SQLite file. */
function makeSqliteShop(file) {
	const db = new sqlite.DatabaseSync(file);
	db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE customer_profiles (customer_id INTEGER PRIMARY KEY REFERENCES customers(id), bio TEXT);
CREATE TABLE addresses (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), line1 TEXT NOT NULL, city TEXT NOT NULL);
CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), shipping_address_id INTEGER REFERENCES addresses(id), status TEXT NOT NULL DEFAULT 'new', placed_at TEXT);
CREATE INDEX orders_status_idx ON orders(status);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products, quantity INTEGER NOT NULL, PRIMARY KEY (order_id, product_id)) WITHOUT ROWID;
CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, manager_id INTEGER REFERENCES employees(id));
CREATE VIEW order_totals AS SELECT o.id AS order_id, SUM(oi.quantity * p.price) AS total FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id GROUP BY o.id;
INSERT INTO customers (email, name, created_at) VALUES ('a@example.com', 'Ada', '2024-01-01');`);
	db.close();
}

test("SQLite end to end: reads the file read-only and leaves it unchanged", { skip: !sqlite && "node:sqlite is not available" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapper-sqlite-"));
	const file = path.join(dir, "shop.db");
	makeSqliteShop(file);
	const before = fs.readFileSync(file);
	const raw = await ENGINE_IMPL.sqlite.introspect(connSpecFromInput({ engine: "sqlite", file: "shop.db" }, { cwd: dir }), { schemas: [], includeViews: true, sampleSize: 0, signal: new AbortController().signal, progress: () => {} });
	if (process.env.MAPPER_DB_RECORD === "1") fs.writeFileSync(path.join(FIX, "sqlite.json"), JSON.stringify(raw, null, "\t") + "\n");
	const r = await databaseSchemaRecipe.collect({ engine: "sqlite", file }, ctx(dir));
	checkShop(r, { engine: "sqlite" });
	assert.ok(!JSON.stringify(r).includes(dir), "the file's folder is not on the map");
	assert.deepEqual(fs.readFileSync(file), before, "file unchanged");
	await assert.rejects(databaseSchemaRecipe.collect({ engine: "sqlite", file: path.join(dir, "missing.db") }, ctx(dir)), /missing\.db is not a file/);
	fs.writeFileSync(path.join(dir, "junk.db"), "not a database at all, just text padding padding padding padding padding padding padding padding padding padding");
	await assert.rejects(databaseSchemaRecipe.collect({ engine: "sqlite", file: path.join(dir, "junk.db") }, ctx(dir)), /junk\.db/);
});

// ----- dbt -----

test("dbt lineage: sources → models → exposures, materializations, tests, folders", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapper-dbt-"));
	fs.mkdirSync(path.join(dir, "target"));
	fs.copyFileSync(path.join(FIX, "dbt-manifest.json"), path.join(dir, "target/manifest.json"));
	const r = await dbtLineageRecipe.collect({ folder: dir }, ctx(dir));
	assert.equal(r.summary, "3 model(s), 2 source(s), 1 seed(s)/snapshot(s), 1 exposure(s)");
	const g = r.graph;
	const node = (uid) => g.nodes.find((n) => n.data?.uniqueId === uid);
	assert.equal(node("model.shop.stg_orders").data.materialized, "view");
	assert.equal(node("model.shop.fct_orders").data.materialized, "incremental");
	assert.match(node("model.shop.fct_orders").label, /incremental · 2 tests/);
	assert.match(node("model.shop.int_ephemeral").style, /dashed=1/);
	assert.match(node("source.shop.stripe.charges").style, /cylinder3/);
	const parent = (uid) => g.nodes.find((n) => n.id === node(uid).parent)?.label;
	assert.equal(parent("model.shop.stg_orders"), "staging");
	assert.equal(parent("model.shop.fct_orders"), "marts/core");
	assert.equal(parent("source.shop.stripe.charges"), "source: stripe");
	const has = (a, b) => g.edges.some((e) => e.from === node(a).id && e.to === node(b).id);
	assert.ok(has("source.shop.stripe.charges", "model.shop.stg_orders"));
	assert.ok(has("model.shop.stg_orders", "model.shop.fct_orders"));
	assert.ok(has("seed.shop.country_codes", "model.shop.fct_orders"));
	assert.ok(has("model.shop.fct_orders", "exposure.shop.revenue_dashboard"));
	assert.ok(!JSON.stringify(r).includes("owner@example.com"), "exposure owners are not mapped");
	checkModelXml(renderGraph(g, { recipe: dbtLineageRecipe.id }).xml);
	await assert.rejects(dbtLineageRecipe.collect({ folder: os.tmpdir(), manifest: "nope/manifest.json" }, ctx()), /dbt compile|No nope/);
	assert.ok(manifestToGraph({}).graph.nodes.length === 0);
});

// ----- live databases (Docker) -----

const LIVE = process.env.MAPPER_DB_LIVE === "1";
const RECORD = process.env.MAPPER_DB_RECORD === "1";
const seed = require("./fixtures/database/live/seed");
const PORTS = { postgres: 55432, mysql: 53306, mongodb: 57017, oracle: 51521, mssql: 51433 };
const ADMIN = {
	postgres: { user: "postgres", password: "AdminPw_pg_7731" },
	mysql: { user: "root", password: "AdminPw_my_7731" },
	mongodb: { user: "root", password: "AdminPw_mo_7731" },
	oracle: { user: "shop", password: "ShopPw_or_7731" },
	mssql: { user: "sa", password: "AdminPw_ms_7731!" },
};

function portOpen(port) {
	return new Promise((resolve) => {
		const s = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
		s.once("connect", () => (s.destroy(), resolve(true)));
		s.once("error", () => resolve(false));
		s.once("timeout", () => (s.destroy(), resolve(false)));
	});
}

/** Runs the recipe the way the app does, then checks no connection detail leaked. */
async function liveRun(engine, input, secrets) {
	const progress = [];
	const r = await databaseSchemaRecipe.collect({ engine, ...input }, { ...ctx(), progress: (t) => progress.push(t) });
	assert.ok(progress.length > 0);
	const everything = JSON.stringify(r) + renderGraph(r.graph, { recipe: databaseSchemaRecipe.id }).xml + databaseSchemaRecipe.agentPrompt({ engine }, r);
	for (const s of secrets) assert.ok(!everything.includes(s), `${engine}: "${s}" leaked into the result`);
	if (RECORD) {
		const spec = connSpecFromInput({ engine, ...input }, ctx());
		const raw = await ENGINE_IMPL[engine].introspect(spec, { schemas: (input.schemas ?? "").split(",").filter(Boolean), includeViews: true, sampleSize: 200, signal: new AbortController().signal, progress: () => {} });
		if (engine === "mongodb") for (const d of raw.databases) for (const c of d.collections) c.sample?.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		fs.writeFileSync(path.join(FIX, `${engine}.json`), JSON.stringify(raw, null, "\t") + "\n");
	}
	return r;
}

describe("live databases (MAPPER_DB_LIVE=1)", { skip: !LIVE && "set MAPPER_DB_LIVE=1 with the containers running" }, () => {
	test("PostgreSQL", { timeout: 120_000 }, async (t) => {
		if (!(await portOpen(PORTS.postgres))) return t.skip("no PostgreSQL on " + PORTS.postgres);
		const { Client } = require("pg");
		const admin = new Client({ host: "127.0.0.1", port: PORTS.postgres, ...ADMIN.postgres, database: "postgres" });
		await admin.connect();
		if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'shop'")).rowCount) await admin.query("CREATE DATABASE shop");
		await admin.end();
		const shop = new Client({ host: "127.0.0.1", port: PORTS.postgres, ...ADMIN.postgres, database: "shop" });
		await shop.connect();
		for (const s of seed.postgres.statements) await shop.query(s);
		await shop.end();
		const url = `postgresql://${seed.READER.user}:${seed.READER.password}@127.0.0.1:${PORTS.postgres}/shop`;
		const r = await liveRun("postgres", { connectWith: "url", connectionString: url, tls: "off", includeViews: "true" }, [url, seed.READER.password, seed.READER.user, "127.0.0.1"]);
		checkShop(r, { engine: "postgres" });
		// Host and credentials form, one schema, no views.
		const r2 = await databaseSchemaRecipe.collect(
			{ engine: "postgres", connectWith: "fields", host: "127.0.0.1", port: String(PORTS.postgres), database: "shop", user: seed.READER.user, password: seed.READER.password, tls: "off", schemas: "billing", includeViews: "false" },
			ctx()
		);
		assert.deepEqual(r2.graph.nodes.filter((n) => n.shape === "table").map((n) => n.label), ["invoices"]);
		assert.ok(r2.graph.nodes.some((n) => n.kind === "db:external-table" && n.label === "public.orders"));
		// Wrong password: a clean error.
		await assert.rejects(
			databaseSchemaRecipe.collect({ engine: "postgres", connectWith: "url", connectionString: url.replace(seed.READER.password, "wrong-pw-123"), tls: "off" }, ctx()),
			(e) => !e.message.includes("wrong-pw-123") && !e.message.includes(seed.READER.user) && /user name and password/.test(e.hint)
		);
	});

	test("MySQL", { timeout: 120_000 }, async (t) => {
		if (!(await portOpen(PORTS.mysql))) return t.skip("no MySQL on " + PORTS.mysql);
		const mysql = require("mysql2/promise");
		const admin = await mysql.createConnection({ host: "127.0.0.1", port: PORTS.mysql, ...ADMIN.mysql });
		for (const s of seed.mysql.statements) await admin.query(s);
		await admin.end();
		const input = { connectWith: "fields", host: "127.0.0.1", port: String(PORTS.mysql), user: seed.READER.user, password: seed.READER.password, tls: "auto", schemas: "shop,shop_billing" };
		const r = await liveRun("mysql", input, [seed.READER.password, seed.READER.user, "127.0.0.1"]);
		checkShop(r, { engine: "mysql" });
		// Default: the connected database only.
		const r2 = await databaseSchemaRecipe.collect({ engine: "mysql", connectWith: "url", connectionString: `mysql://${seed.READER.user}:${seed.READER.password}@127.0.0.1:${PORTS.mysql}/shop_billing` }, ctx());
		assert.deepEqual(r2.graph.nodes.filter((n) => n.shape === "table").map((n) => n.label), ["invoices"]);
	});

	test("MongoDB", { timeout: 120_000 }, async (t) => {
		if (!(await portOpen(PORTS.mongodb))) return t.skip("no MongoDB on " + PORTS.mongodb);
		const { MongoClient, ObjectId, DBRef } = require("mongodb");
		const admin = new MongoClient(`mongodb://${ADMIN.mongodb.user}:${ADMIN.mongodb.password}@127.0.0.1:${PORTS.mongodb}/?authSource=admin`);
		await admin.connect();
		await seed.mongo(admin, { ObjectId, DBRef });
		await admin.close();
		const url = `mongodb://${seed.READER.user}:${seed.READER.password}@127.0.0.1:${PORTS.mongodb}/shop?authSource=shop`;
		const r = await liveRun("mongodb", { connectWith: "url", connectionString: url, sampleSize: "50" }, [url, seed.READER.password, seed.READER.user, "127.0.0.1"]);
		const { edge, rows } = view(r);
		assert.ok(edge("customers", "orders") && edge("products", "orders") && edge("orders", "payments"));
		assert.equal(rows("customers").email.key, "UK");
	});

	test("Oracle", { timeout: 180_000 }, async (t) => {
		if (!(await portOpen(PORTS.oracle))) return t.skip("no Oracle on " + PORTS.oracle);
		const oracledb = require("oracledb");
		const admin = await oracledb.getConnection({ ...ADMIN.oracle, connectString: `127.0.0.1:${PORTS.oracle}/FREEPDB1` });
		for (const s of seed.oracle.statements) await admin.execute(s);
		await admin.close();
		const input = { connectWith: "fields", host: "127.0.0.1", port: String(PORTS.oracle), database: "FREEPDB1", user: ADMIN.oracle.user, password: ADMIN.oracle.password, tls: "off" };
		const r = await liveRun("oracle", input, [ADMIN.oracle.password, "127.0.0.1"]);
		checkShop(r, { engine: "oracle" });
	});

	test("SQL Server (Azure SQL Edge on arm64)", { timeout: 180_000 }, async (t) => {
		if (!(await portOpen(PORTS.mssql))) return t.skip("no SQL Server on " + PORTS.mssql);
		const sql = require("mssql");
		const base = { server: "127.0.0.1", port: PORTS.mssql, options: { encrypt: true, trustServerCertificate: true } };
		let pool = await new sql.ConnectionPool({ ...base, ...ADMIN.mssql, database: "master" }).connect();
		await pool.request().query("IF DB_ID('shop') IS NULL CREATE DATABASE shop");
		await pool.close();
		pool = await new sql.ConnectionPool({ ...base, ...ADMIN.mssql, database: "shop" }).connect();
		for (const s of seed.mssql.statements) await pool.request().query(s);
		await pool.close();
		const cs = `Server=127.0.0.1,${PORTS.mssql};Database=shop;User Id=${seed.READER.user};Password=${seed.READER.password};Encrypt=true`;
		const r = await liveRun("mssql", { connectWith: "url", connectionString: cs, tls: "on-trust" }, [cs, seed.READER.password, seed.READER.user, "127.0.0.1"]);
		checkShop(r, { engine: "mssql" });
	});
});
