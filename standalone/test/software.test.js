// Unit tests for the software mappers: connectivity, data flow, modules, classes,
// API surface and the live Kubernetes map. Run from standalone/: node --test test/software.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("./helpers/ts");

const { renderGraph } = require("../src/main/mapper/render");
const { MapperError } = require("../src/main/mapper/types");
const { softwareRecipes } = require("../src/main/mapper/recipes/software");
const { parseAddress, isSecretKey, scrub, techOf, libraryTech } = require("../src/main/mapper/recipes/software/shared");
const { scanSystem, stripComments, entryPoints, hiddenCheckouts } = require("../src/main/mapper/recipes/software/systemScan");
const { modulesToGraph, classesToGraph, cycleMembers, moduleFindings } = require("../src/main/mapper/recipes/software/codeStructure");
const { openApiToGraph, parseGraphQL, graphqlToGraph } = require("../src/main/mapper/recipes/software/api");
const { hardcodedSecret, maskHint } = require("../src/main/mapper/recipes/software/health");
const { clusterToGraph } = require("../src/main/mapper/recipes/software/kubernetes");
const { checkModelXml } = require("./helpers/xml");

const SHOP = path.join(__dirname, "fixtures/software/shop");
/** The same kind of system with none of the planted issues. */
const CLEAN = path.join(__dirname, "fixtures/software/clean");
const recipe = (id) => softwareRecipes.find((r) => r.id === id);
const noExec = async () => assert.fail("no commands");
const ctxFor = (dir, exec = noExec) => ({ cwd: dir, progress: () => {}, signal: new AbortController().signal, exec });
/** Every fake secret in the fixtures: none of these may appear in anything the Mapper produces. */
const SECRETS = ["s3cr3tP4ssw0rd", "r3disPassXYZ", "fake_stripe_key_FAKE", "jwt-super-secret", "supersecret123", "m0ngoPassQQ", "envFilePassw0rd", "XXXXSECRETXXXX", "FAKEKEYabc123", "wJalrXUtnFEMI", "abcdef0123456789", "azhzU2VjcmV0", "k8s-plain-secret", "k8sPassLeak99", "tok-k8s-should"];
function assertNoSecrets(label, ...outputs) {
	const text = outputs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n");
	for (const s of SECRETS) assert.ok(!text.includes(s), `${label} leaks ${s}`);
}
const node = (g, id) => g.nodes.find((n) => n.id === id);
const edge = (g, from, to) => g.edges.find((e) => e.from === from && e.to === to);

/** Findings point at shapes that exist; every check reports what it scanned. */
function checkFindings(r, label) {
	const ids = new Set(r.graph.nodes.map((n) => n.id));
	assert.ok(Array.isArray(r.findings), `${label}: findings`);
	assert.ok(Array.isArray(r.checked) && r.checked.length, `${label}: checked`);
	for (const c of r.checked) assert.ok(c.check && Number.isInteger(c.scanned) && c.scanned >= 0, `${label}: ${JSON.stringify(c)}`);
	for (const f of r.findings) {
		assert.ok(f.id && f.kind && f.title && ["high", "medium", "low", "info"].includes(f.severity), `${label}: ${JSON.stringify(f)}`);
		assert.ok(f.nodeIds.length && f.nodeIds.every((id) => ids.has(id)), `${label}: ${f.id} points at ${f.nodeIds}`);
	}
	assert.equal(new Set(r.findings.map((f) => f.id)).size, r.findings.length, `${label}: ids are unique`);
}
const byKind = (r, kind) => r.findings.filter((f) => f.kind === kind);

/** Every node's files are relative paths (forward slashes) that exist under the mapped folder. */
function checkFiles(g, root, label) {
	let n = 0;
	for (const x of g.nodes) {
		for (const f of x.files ?? []) {
			n++;
			assert.ok(!f.startsWith("/") && !f.includes("\\") && !f.split("/").includes(".."), `${label}: ${x.id} ${f}`);
			assert.ok(fs.statSync(path.join(root, f)).isFile(), `${label}: ${x.id} ${f} exists`);
		}
	}
	assert.ok(n > 0, `${label}: some nodes carry files`);
}

test("addresses: scheme, host and port only — credentials, paths and queries are dropped", () => {
	assert.deepEqual(parseAddress("postgres://app:p%40ss@db.internal:5432/orders?sslmode=require&password=x"), { scheme: "postgres", hosts: [{ host: "db.internal", port: 5432 }], database: "orders" });
	assert.deepEqual(parseAddress("postgres://u:pa@ss@db:5432/x").hosts, [{ host: "db", port: 5432 }], "an @ in the password does not leak into the host");
	assert.deepEqual(parseAddress("jdbc:sqlserver://sql.example.net:1433;databaseName=shop;password=hunter2"), { scheme: "sqlserver", hosts: [{ host: "sql.example.net", port: 1433 }], database: "shop" });
	assert.deepEqual(parseAddress("Server=tcp:acme.database.windows.net,1433;Initial Catalog=sales;User ID=u;Password=hunter2;"), { scheme: "sqlserver", hosts: [{ host: "acme.database.windows.net", port: 1433 }], database: "sales" });
	assert.deepEqual(parseAddress("DefaultEndpointsProtocol=https;AccountName=acmestore;AccountKey=abc==;EndpointSuffix=core.windows.net").hosts, [{ host: "acmestore.blob.core.windows.net" }]);
	assert.equal(parseAddress("Endpoint=sb://acme-bus.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=zzz=").hosts[0].host, "acme-bus.servicebus.windows.net");
	assert.equal(parseAddress("https://sqs.eu-west-1.amazonaws.com/123456789012/orders-queue").resourceName, "orders-queue");
	assert.deepEqual(parseAddress("kafka-1:9092,kafka-2:9092", { bare: true }).hosts.map((h) => h.host), ["kafka-1", "kafka-2"]);
	assert.equal(parseAddress("kafka-1:9092"), undefined, "bare hosts only for address keys");
	assert.equal(parseAddress("https://hooks.slack.com/services/T0/B0/SECRETPATH").hosts[0].host, "hooks.slack.com");
	assert.ok(!JSON.stringify(parseAddress("https://hooks.slack.com/services/T0/B0/SECRETPATH")).includes("SECRETPATH"));
	for (const v of ["true", "{{ .Values.db }}", "$(DB_HOST)", "<your-host>", "just text", ""]) assert.equal(parseAddress(v, { bare: true }), undefined, v);
	assert.equal(techOf(parseAddress("rediss://cache.example.net:6380")).id, "redis");
	assert.equal(techOf(parseAddress("https://acme.documents.azure.com:443/")).id, "cosmos");
	assert.equal(techOf(parseAddress("db", { bare: true }), "POSTGRES_HOST").id, "postgres");
	for (const k of ["DB_PASSWORD", "API_KEY", "STRIPE_SECRET", "JWT_SECRET", "AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "spring.datasource.password", "SECRET_KEY_BASE"]) assert.ok(isSecretKey(k), k);
	for (const k of ["DATABASE_URL", "REDIS_HOST", "KAFKA_BROKERS", "AUTH_SERVICE_URL", "KEYCLOAK_URL", "AZURE_STORAGE_CONNECTION_STRING"]) assert.ok(!isSecretKey(k), k);
	assert.equal(scrub("postgres://u:hunter2@h/db password=abc sk_live_abcdefgh123"), "postgres://h/db password=*** ***");
	assert.equal(libraryTech("github.com/jackc/pgx/v5/pgxpool").tech.id, "postgres");
	assert.equal(libraryTech("org.springframework.kafka.core.KafkaTemplate").tech.id, "kafka");
	assert.equal(libraryTech("@aws-sdk/client-sqs").tech.id, "sqs");
	assert.equal(libraryTech("lodash"), undefined);
});

test("comments are blanked before reading code (examples in comments are not connections)", () => {
	const js = 'const a = "http://x//y"; // fetch("https://api.example-in-comment.com")\n/* boto3.client("s3") */ const b = 1;';
	const out = stripComments(js, "js");
	assert.equal(out.length, js.length);
	assert.match(out, /"http:\/\/x\/\/y"/);
	assert.ok(!out.includes("example-in-comment") && !out.includes("boto3"));
	assert.ok(!stripComments('x = 1  # redis://cache\n"""docstring pg"""\ny = "#not"', "py").includes("redis"));
});

test("connectivity: a compose service built on an anchor (<<: *app) keeps what it inherits", async () => {
	const os = require("os");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-compose-"));
	fs.writeFileSync(
		path.join(dir, "docker-compose.yml"),
		["x-app: &app", "  image: shop/app:1", "  depends_on: [db]", "  environment:", "    DATABASE_URL: postgres://db:5432/shop", "services:", "  web:", "    <<: *app", '    ports: ["8080:80"]', "  worker:", "    <<: *app", "  db:", "    image: postgres:16", ""].join("\n")
	);
	const r = await recipe("software.connectivity").collect({ folder: dir }, ctxFor(dir));
	assert.deepEqual(r.warnings, []);
	const g = r.graph;
	// both services reach the database they inherit from the anchor; without merge keys neither did
	assert.ok(edge(g, "svc:web", "res:compose:db") && edge(g, "svc:worker", "res:compose:db"), JSON.stringify(g.edges));
	assert.match(node(g, "res:compose:db").label, /PostgreSQL/);
	assert.ok(!JSON.stringify(g).includes("<<"), "a merge key was read as a setting of its own");
	// plain words stay words (only YAML 1.1 reads on / yes / no as booleans)
	const { loadYaml, loadYamlAll } = require("../src/main/mapper/recipes/common");
	assert.deepEqual(loadYaml("on: push\nname: yes\nbase: &b {a: 1}\njob: {<<: *b, c: 2}\n"), { on: "push", name: "yes", base: { a: 1 }, job: { a: 1, c: 2 } });
	assert.deepEqual(loadYamlAll("a: 1\n---\nb: 2\n"), [{ a: 1 }, { b: 2 }]);
	// and nothing but plain data is ever built
	assert.throws(() => loadYaml('x: !!js/function "function () {}"'), /unknown scalar tag/);
});

test("connectivity: services, stores, queues and APIs from compose, Kubernetes, .env and code — no secrets", async () => {
	const r = await recipe("software.connectivity").collect({ folder: SHOP }, ctxFor(SHOP));
	const g = r.graph;
	assert.ok(g, r.summary);
	assert.deepEqual(r.warnings, []);
	// Services: code packages merged with their compose service, Dockerfile and k8s workloads.
	const orders = node(g, "svc:orders");
	assert.equal(orders.container, true);
	assert.equal(orders.data.runtime, "Node.js");
	assert.equal(orders.data.dir, "services/orders");
	const facets = g.nodes.filter((n) => n.parent === "svc:orders").map((n) => n.label);
	assert.ok(facets.some((l) => /compose orders :8080→8080/.test(l)) && facets.some((l) => /Deployment orders ×3/.test(l)) && facets.some((l) => /Dockerfile :8080/.test(l)), facets.join(" | "));
	assert.equal(node(g, "svc:inventory").data.runtime, "Python");
	// Stores and brokers declared in compose, as cylinders / queues with their technology.
	assert.match(node(g, "res:compose:db").style, /cylinder3/);
	assert.match(node(g, "res:compose:db").label, /PostgreSQL[\s\S]*db: orders/);
	assert.equal(node(g, "res:compose:cache").kind, "software:cache");
	assert.equal(node(g, "res:compose:mongo").data.tech, "mongodb");
	assert.equal(node(g, "res:compose:kafka").container, true, "the broker holds its topics");
	assert.equal(node(g, "res:kafka:order-created").parent, "res:compose:kafka");
	// Connections with protocol and port.
	assert.equal(edge(g, "svc:orders", "res:compose:db").label, "postgres :5432");
	assert.equal(edge(g, "svc:orders", "res:compose:cache").label, "redis :6379");
	assert.equal(edge(g, "svc:orders", "svc:inventory").label, "http :8000");
	assert.equal(edge(g, "svc:inventory", "res:compose:mongo").label, "mongodb :27017");
	assert.equal(edge(g, "svc:orders", "res:kafka:order-created").label, "publishes");
	assert.equal(edge(g, "res:kafka:order-created", "svc:inventory").label, "consumed by");
	assert.ok(!edge(g, "svc:orders", "res:compose:kafka"), "the plain broker link is replaced by the topic links");
	assert.match(edge(g, "res:compose:kafka", "res:compose:zookeeper").label, /zk :2181/);
	assert.ok(edge(g, "svc:orders", "res:ext:api.stripe.com"), "external API from the ConfigMap and the code");
	assert.equal(node(g, "res:ext:api.stripe.com").parent, "group:external");
	assert.ok(edge(g, "svc:inventory", "res:ext:hooks.slack.com"), "webhook host kept, its secret path dropped");
	assert.equal(node(g, "res:azureblob_acmestore.blob.core.windows.net").data.tech, "azureblob");
	// Entry from outside: Ingress → orders; nginx published on :80.
	assert.equal(edge(g, "ing:shop/shop", "svc:orders").label, "/api/orders");
	assert.ok(edge(g, "clients", "ing:shop/shop") && edge(g, "clients", "res:compose:web"));
	assert.equal(edge(g, "res:compose:web", "svc:orders").label, "depends_on");
	// Secret settings: names known, values never read.
	assert.match(r.facts, /Secret settings exist \(values were not read\): .*STRIPE_API_KEY/);
	const { xml } = renderGraph(g, { recipe: "software.connectivity" });
	checkModelXml(xml);
	const prompt = recipe("software.connectivity").agentPrompt({ folder: SHOP }, r);
	assertNoSecrets("connectivity", r, xml, prompt);
	assert.match(prompt, /<facts collected read-only/);
	assert.match(recipe("software.connectivity").digDeeper([{ label: "orders", data: { dir: "services/orders" } }], ""), /Trace what this calls[\s\S]*services\/orders/);
});

test("health findings (connectivity): credentials, plain HTTP, health checks, privileged containers, unguarded write routes", async () => {
	const rec = recipe("software.connectivity");
	const r = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	checkFindings(r, "connectivity");
	// Hard-coded credentials: one per file and setting, located, value masked.
	const creds = byKind(r, "hardcoded-credential");
	assert.deepEqual(
		creds.map((f) => f.id),
		["DATABASE_URL", "JWT_SECRET", "MONGO_URL", "POSTGRES_PASSWORD", "REDIS_URL", "STRIPE_API_KEY"].map((k) => `hardcoded-credential:docker-compose.yml:${k}`)
	);
	const stripe = creds.find((f) => f.id.endsWith("STRIPE_API_KEY"));
	assert.deepEqual(stripe.nodeIds, ["svc:orders"]);
	assert.equal(stripe.severity, "medium");
	assert.match(stripe.detail, /^docker-compose\.yml:10 sets STRIPE_API_KEY to a literal value \(fa… \(40 chars\)\)/);
	assert.match(creds.find((f) => f.id.endsWith("DATABASE_URL")).detail, /docker-compose\.yml:6 puts a literal password in DATABASE_URL/);
	assert.deepEqual(creds.find((f) => f.id.endsWith("POSTGRES_PASSWORD")).nodeIds, ["res:compose:db"]);
	assert.ok(!creds.some((f) => /SLACK|AWS_SECRET|AZURE_STORAGE/.test(f.id)), ".env files hold local secrets and are not flagged");
	// Plain HTTP to a host outside the system (http://inventory:8000 is internal).
	const plain = byKind(r, "plaintext-http");
	assert.deepEqual(plain.map((f) => f.id), ["plaintext-http:svc:orders:api.parcel-partner.com"]);
	assert.deepEqual(plain[0].nodeIds, ["svc:orders", "res:ext:api.parcel-partner.com"]);
	assert.match(plain[0].detail, /k8s\/orders\.yaml \(orders: SHIPPING_API_URL\)/);
	// Health checks: compose app services, the awaited mongo (medium), the k8s Deployment.
	const health = Object.fromEntries(byKind(r, "missing-healthcheck").map((f) => [f.id, f]));
	assert.deepEqual(Object.keys(health).sort(), ["missing-healthcheck:res:compose:mongo:compose", "missing-healthcheck:svc:inventory:compose", "missing-healthcheck:svc:orders:compose", "missing-healthcheck:svc:orders:k8s"]);
	assert.equal(health["missing-healthcheck:res:compose:mongo:compose"].severity, "medium");
	assert.match(health["missing-healthcheck:res:compose:mongo:compose"].title, /inventory waits for mongo to be healthy/);
	assert.equal(health["missing-healthcheck:svc:orders:k8s"].severity, "low");
	assert.match(health["missing-healthcheck:svc:orders:k8s"].detail, /^k8s\/orders\.yaml:22: .*readinessProbe/);
	// Privileged container.
	const priv = byKind(r, "privileged-container");
	assert.equal(priv.length, 1);
	assert.equal(priv[0].severity, "high");
	assert.match(priv[0].detail, /^k8s\/orders\.yaml:38: privileged: true \(container orders\)/);
	// Write routes in services whose code has no auth at all.
	assert.deepEqual(byKind(r, "no-auth-guard").map((f) => [f.id, f.nodeIds[0]]), [
		["no-auth-guard:svc:inventory", "svc:inventory"],
		["no-auth-guard:svc:orders", "svc:orders"],
	]);
	assert.match(byKind(r, "no-auth-guard")[1].detail, /POST \/orders \(services\/orders\/src\/index\.ts:15\), DELETE \/orders\/:id/);
	assert.equal(r.findings[0].severity, "high", "most severe first");
	// Coverage of every check family.
	assert.deepEqual(
		r.checked.map((c) => c.check),
		["Hard-coded credentials in compose, Kubernetes and config files", "Plain-text HTTP to external hosts", "Health checks and readiness probes", "Privileged containers, host network / PID and Docker socket mounts", "HTTP write endpoints without authentication"]
	);
	assert.ok(r.checked.every((c) => c.scanned > 0), JSON.stringify(r.checked));
	// Stable across runs, and no secret anywhere.
	const again = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	assert.deepEqual(again.findings.map((f) => f.id), r.findings.map((f) => f.id));
	const { xml } = renderGraph(r.graph, { recipe: rec.id });
	assertNoSecrets("findings", r.findings, r.checked, r.facts, xml);
	// Data flow: the same checks; the route finding sits on the HTTP routes table.
	const df = await recipe("software.dataflow").collect({ folder: SHOP }, ctxFor(SHOP));
	checkFindings(df, "dataflow");
	assert.deepEqual(byKind(df, "no-auth-guard").map((f) => f.nodeIds[0]), ["svc:inventory#http", "svc:orders#http"]);
	assertNoSecrets("dataflow findings", df.findings);
});

test("health findings: a clean system has none, and still reports what was checked", async () => {
	for (const id of ["software.connectivity", "software.dataflow", "software.github-actions", "software.api", "software.modules"]) {
		const r = await recipe(id).collect({ folder: CLEAN }, ctxFor(CLEAN));
		checkFindings(r, `${id} (clean)`);
		assert.deepEqual(r.findings, [], `${id}: ${JSON.stringify(r.findings, null, 1)}`);
		assert.ok(r.checked.some((c) => c.scanned > 0), `${id}: something was checked`);
	}
	const c = await recipe("software.connectivity").collect({ folder: CLEAN }, ctxFor(CLEAN));
	assert.ok(c.checked.every((x) => x.scanned > 0), JSON.stringify(c.checked));
});

test("credentials: secret settings and URL / connection-string passwords with literal values; references and placeholders are not", () => {
	assert.equal(hardcodedSecret("API_KEY", "sk_live_abcdefghijklmnop").what, "value");
	assert.equal(hardcodedSecret("DATABASE_URL", "postgres://u:hunter2@db/x").what, "url-password");
	assert.equal(hardcodedSecret("ConnectionStrings:Main", "Server=db;Database=x;User Id=u;Password=hunter22;").what, "url-password");
	for (const [k, v] of [
		["API_KEY", "${API_KEY}"],
		["DB_PASSWORD", "{{ .Values.pw }}"],
		["JWT_SECRET", "<your-secret>"],
		["AUTH_ENABLED", "true"],
		["PASSWORD_MIN_LENGTH", "12"],
		["API_KEY_HEADER", "X-Api-Key"],
		["SECRET_FILE", "/run/secrets/db"],
		["DATABASE_URL", "postgres://u:${DB_PASSWORD}@db/x"],
		["DATABASE_URL", "postgres://db:5432/x"],
		["TOKEN", "changeme-here"],
		["LOG_LEVEL", "debug"],
	])
		assert.equal(hardcodedSecret(k, v), undefined, `${k}=${v}`);
	assert.equal(maskHint("supersecretvalue"), "su… (16 chars)");
	assert.equal(maskHint("short"), "*** (5 chars)");
	assert.ok(!JSON.stringify(hardcodedSecret("API_KEY", "sk_live_abcdefghijklmnop").hint).includes("abcdef"));
});

test("files: every shape carries the repository files it comes from (relative, existing)", async () => {
	const c = await recipe("software.connectivity").collect({ folder: SHOP }, ctxFor(SHOP));
	checkFiles(c.graph, SHOP, "connectivity");
	assert.deepEqual(node(c.graph, "svc:orders").files, [".env.example", "docker-compose.yml", "k8s/orders.yaml", "services/orders/Dockerfile", "services/orders/package.json", "services/orders/src/db.ts", "services/orders/src/index.ts"]);
	assert.deepEqual(node(c.graph, "svc:orders#f1").files, ["services/orders/Dockerfile"]);
	assert.ok(node(c.graph, "res:compose:db").files.includes("docker-compose.yml"));
	assert.deepEqual(node(c.graph, "res:kafka:order-created").files, ["services/inventory/app/main.py", "services/inventory/requirements.txt", "services/orders/package.json", "services/orders/src/index.ts"]);
	assert.deepEqual(node(c.graph, "ing:shop/shop").files, ["k8s/orders.yaml"]);
	const df = await recipe("software.dataflow").collect({ folder: SHOP }, ctxFor(SHOP));
	checkFiles(df.graph, SHOP, "dataflow");
	assert.deepEqual(node(df.graph, "svc:orders#http").files, ["services/orders/src/index.ts"]);
	assert.deepEqual(node(df.graph, "svc:orders#schedule").files, ["k8s/orders.yaml"]);
	for (const id of ["software.modules", "software.classes", "software.api", "software.github-actions"]) {
		const r = await recipe(id).collect({ folder: SHOP }, ctxFor(SHOP));
		checkFiles(r.graph, SHOP, id);
	}
	const m = await recipe("software.modules").collect({ folder: SHOP }, ctxFor(SHOP));
	assert.deepEqual(node(m.graph, "services/orders/src/db.ts").files, ["services/orders/src/db.ts"]);
	const cl = await recipe("software.classes").collect({ folder: SHOP }, ctxFor(SHOP));
	assert.deepEqual(node(cl.graph, "type:OrderRepository").files, ["services/orders/src/models.ts"]);
	const api = await recipe("software.api").collect({ folder: SHOP }, ctxFor(SHOP));
	assert.deepEqual(node(api.graph, "spec:api/openapi.yaml#op:POST:/orders").files, ["api/openapi.yaml"]);
	assert.deepEqual(node(api.graph, "gql:Query").files, ["api/schema.graphql"]);
});

test("health findings (GitHub Actions): unpinned actions, pull_request_target checkout, token permissions, script injection", async () => {
	const rec = recipe("software.github-actions");
	const r = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	checkFindings(r, "github-actions");
	const job = "wf:.github/workflows/ci.yml#test";
	const deploy = "wf:.github/workflows/ci.yml#deploy";
	assert.deepEqual(
		r.findings.map((f) => [f.severity, f.id]),
		[
			["high", `pr-target-checkout:${job}`],
			["high", `script-injection:${job}`],
			["medium", `token-permissions:${deploy}`],
			["medium", `token-permissions:${job}`],
			["medium", `unpinned-action:${job}:acme-tools/setup-thing`],
		]
	);
	const f = Object.fromEntries(r.findings.map((x) => [x.id, x]));
	assert.match(f[`pr-target-checkout:${job}`].detail, /^\.github\/workflows\/ci\.yml:12:/);
	assert.match(f[`script-injection:${job}`].title, /github\.event\.pull_request\.title/);
	assert.match(f[`script-injection:${job}`].detail, /^\.github\/workflows\/ci\.yml:15:/);
	assert.match(f[`token-permissions:${deploy}`].title, /write-all/);
	assert.match(f[`token-permissions:${job}`].title, /default token permissions/);
	assert.match(f[`unpinned-action:${job}:acme-tools/setup-thing`].detail, /^\.github\/workflows\/ci\.yml:13:/);
	assert.ok(!r.findings.some((x) => /aws-actions|actions\/checkout/.test(x.id)), "SHA-pinned and first-party actions are fine");
	assert.deepEqual(r.checked.map((c) => c.scanned), [3, 1, 2, 2]);
	assert.deepEqual(node(r.graph, job).files, [".github/workflows/ci.yml"]);
	assert.deepEqual((await rec.collect({ folder: SHOP }, ctxFor(SHOP))).findings.map((x) => x.id), r.findings.map((x) => x.id));
});

test("health findings (API, modules): endpoints without security, plain-text servers, import cycles", async () => {
	const api = await recipe("software.api").collect({ folder: SHOP }, ctxFor(SHOP));
	checkFindings(api, "api");
	assert.deepEqual(api.findings.map((f) => [f.severity, f.id, f.nodeIds[0]]), [
		["medium", "endpoint-without-security:api/legacy-swagger.json:PUT /items", "spec:api/legacy-swagger.json#op:PUT:/items"],
		["medium", "plaintext-http:api/legacy-swagger.json:legacy.acme-shop.com", "spec:api/legacy-swagger.json"],
	]);
	assert.ok(!api.findings.some((f) => f.id.includes("openapi.yaml")), "global security and an explicit security: [] on /health are fine");
	assert.deepEqual(api.checked.map((c) => c.scanned), [7, 2]);
	// Modules: a file-level cycle is one finding on its members; folder-level maps are not checked.
	const modules = new Map(["a.ts", "b.ts", "c.ts"].map((f) => [f, { file: f, lang: "js" }]));
	const edges = new Map([
		["a.ts", new Set(["b.ts"])],
		["b.ts", new Set(["a.ts", "c.ts"])],
	]);
	const { graph } = modulesToGraph({ modules, edges, externals: new Map(), unresolved: 0, languages: new Map([["js", 3]]) }, "x");
	const m = moduleFindings(graph);
	assert.deepEqual(m.findings.map((f) => [f.id, f.severity, f.nodeIds]), [["import-cycle:a.ts", "low", ["a.ts", "b.ts"]]]);
	assert.match(m.findings[0].detail, /a\.ts → b\.ts; b\.ts → a\.ts/);
	assert.deepEqual(m.checked, [{ check: "Import cycles between files", scanned: 3, note: "modules on the map" }]);
	const shop = await recipe("software.modules").collect({ folder: SHOP }, ctxFor(SHOP));
	checkFindings(shop, "modules");
	assert.deepEqual(shop.findings, []);
});

test("connectivity: tests / fixtures are skipped unless asked for, and an empty folder says so", async () => {
	const parent = __dirname;
	const without = scanSystem(parent);
	assert.ok(!without.services.some((s) => s.name === "orders"), "fixtures are not part of a repository's map");
	const withTests = scanSystem(parent, { includeTests: true });
	assert.ok(withTests.services.some((s) => s.name === "orders"));
	const empty = fs.mkdtempSync(path.join(require("os").tmpdir(), "empty-"));
	const r = await recipe("software.connectivity").collect({ folder: empty }, ctxFor(empty));
	assert.equal(r.graph, undefined);
	assert.match(r.summary, /No services/);
	await assert.rejects(recipe("software.connectivity").collect({ folder: path.join(empty, "nope") }, ctxFor(empty)), /not a folder/);
});

test("a repository of packages that nothing deploys: a Rust binary and a Python program count as entry points; what is left says what was there, and what was not read", async () => {
	const os = require("os");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-map-"));
	const put = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	};
	// (the shape of a real repository this failed on: a Cargo workspace with one binary, a Python package, no Dockerfile)
	put("edge/Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
	put("edge/crates/gateway-edge/Cargo.toml", '[package]\nname = "gateway-edge"\nversion = "0.1.0"\n');
	put("edge/crates/gateway-edge/src/main.rs", 'use axum::{routing::{get, post}, Router};\n\n#[tokio::main]\nasync fn main() {\n    let app = Router::new().route("/health", get(health)).route("/files/:id", get(read).put(write));\n}\n');
	put("service/pyproject.toml", '[project]\nname = "gateway-service"\n');
	put("service/src/gateway_service/__init__.py", '"""The service."""\n');

	// (a crate whose programs are all in src/bin: `bin` is build output anywhere else, and skipped there)
	put("tools/Cargo.toml", '[package]\nname = "tools"\nversion = "0.1.0"\n');
	put("tools/src/lib.rs", "pub fn shared() {}\n");
	put("tools/src/bin/migrate.rs", "// Moves the data.\n\nfn main() {\n}\n");
	put("tools/src/bin/seed/main.rs", "fn main() {}\n");
	put("tools/bin/built.rs", 'fn main() { router.route("/never", get(x)); }\n');

	const scan = scanSystem(root);
	const tools = scan.services.find((s) => s.dir === "tools");
	assert.deepEqual(tools?.entries.map((e) => [e.label, e.file, e.line]), [["binary migrate", "tools/src/bin/migrate.rs", 3], ["binary seed", "tools/src/bin/seed/main.rs", 1]]);
	for (const rel of ["tools/src/bin/migrate.rs", "tools/src/bin/seed/main.rs", "tools/bin/built.rs"]) fs.rmSync(path.join(root, rel));
	for (const rel of ["tools/src/lib.rs", "tools/Cargo.toml"]) fs.rmSync(path.join(root, rel));
	const edge = scanSystem(root).services.find((s) => s.dir === "edge/crates/gateway-edge");
	assert.ok(edge, "a package with a binary is a service");
	assert.deepEqual(edge.entries.map((e) => [e.kind, e.label, e.framework]), [["cli", "binary gateway-edge", "Rust"], ["http", "GET /health", "axum"], ["http", "GET /files/:id", "axum"], ["http", "PUT /files/:id", "axum"]]);
	assert.deepEqual(scan.libraries.sort(), ["edge", "service"]);
	const flow = await recipe("software.dataflow").collect({ folder: root }, ctxFor(root));
	assert.ok(flow.graph, "there is something to draw now");
	assert.match(flow.summary, /4 entry point\(s\)/);

	// the entry points of other kinds of program
	const kinds = (text, rel, lang) => entryPoints(text, rel, lang).map((e) => `${e.kind} ${e.label}`);
	assert.deepEqual(kinds("fn main() {\n}\n", "tools/src/bin/migrate.rs", "rs"), ["cli binary migrate"]);
	assert.deepEqual(kinds("fn main() {\n}\n", "tools/src/lib.rs", "rs"), [], "a function called main elsewhere is not a binary");
	assert.deepEqual(kinds('#[get("/users/{id}")]\nasync fn user() {}\n#[post("/users")]\nasync fn add() {}\n', "api/src/routes.rs", "rs"), ["http GET /users/{id}", "http POST /users"]);
	assert.deepEqual(kinds("print('hi')\n", "service/src/gateway_service/__main__.py", "py"), ["cli python -m gateway_service"]);
	assert.deepEqual(kinds("fn main() {}\n", "src/main.rs", "rs"), ["cli binary"], "a crate at the root has no folder to be named after");
	// every method of a route, also behind a handler written in place; a handler's own calls are not methods
	assert.deepEqual(kinds('let app = Router::new()\n    .route("/x", get(|| async { get(1); f() }).post(h))\n    .route(\n        "/y",\n        delete(remove),\n    )\n    .route("relative", get(h));\n', "api/src/app.rs", "rs"), ["http GET /x", "http POST /x", "http DELETE /y"]);
	// routes a crate builds in its own tests are not what it serves
	assert.deepEqual(kinds('pub fn app() -> Router { Router::new().route("/live", get(live)) }\n\n#[cfg(test)]\nmod tests {\n    fn fake() -> Router { Router::new().route("/fake", get(f)) }\n    #[get("/also-fake")]\n    fn g() {}\n}\n', "api/src/lib.rs", "rs"), ["http GET /live"]);
	// a large file of nothing but blank lines, comments blanked out or an unclosed call is read at once
	// (each of these took many seconds: the patterns looked again from every line, or to the end of the file)
	for (const [what, text] of [["blank lines", "\n".repeat(300_000)], ["blanked comments", "          \n".repeat(30_000)], ["unclosed routes", '.route("/a",get('.repeat(20_000)], ["unclosed attributes", '#[get(   '.repeat(30_000)]]) {
		const started = Date.now();
		entryPoints(text, "big/src/main.rs", "rs");
		assert.ok(Date.now() - started < 1500, `${what}: ${Date.now() - started} ms`);
	}

	// with the binary gone, nothing is a service: the message says what was read and which packages are there
	fs.rmSync(path.join(root, "edge/crates/gateway-edge/src/main.rs"));
	for (const id of ["software.dataflow", "software.connectivity"]) {
		const r = await recipe(id).collect({ folder: root }, ctxFor(root));
		assert.equal(r.graph, undefined);
		assert.match(r.summary, /^No services/);
		assert.match(r.summary, /1 code file\(s\) were read\. 3 package\(s\) are there \(edge, edge\/crates\/gateway-edge, service\), but none is deployed .*or has an entry point the Mapper recognises/);
	}

	// working copies kept in a hidden folder are not read, and the scan says so
	assert.equal(hiddenCheckouts(root), undefined);
	put(".claude/worktrees/real-run/.git", "gitdir: /elsewhere\n");
	put(".claude/worktrees/real-run/portal/package.json", '{"name":"portal"}');
	put(".claude/worktrees/real-run/portal/Dockerfile", "FROM node:22\n");
	put(".claude/worktrees/second/.git", "gitdir: /elsewhere\n");
	put(".claude/worktrees/not-a-copy/readme.md", "x");
	assert.deepEqual(hiddenCheckouts(root), { folder: ".claude/worktrees", names: ["real-run", "second"] });
	// a link to somewhere else is not followed, as in the scan itself: nothing outside the folder is listed
	const linked = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-map-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-elsewhere-"));
	fs.mkdirSync(path.join(outside, "private-project"));
	fs.writeFileSync(path.join(outside, "private-project", ".git"), "gitdir: /elsewhere\n");
	fs.symlinkSync(outside, path.join(linked, ".worktrees"));
	fs.mkdirSync(path.join(linked, ".claude"));
	fs.symlinkSync(outside, path.join(linked, ".claude", "worktrees"));
	assert.equal(hiddenCheckouts(linked), undefined);
	fs.rmSync(path.join(linked, ".claude"), { recursive: true });
	fs.symlinkSync(path.dirname(outside), path.join(linked, ".claude"));
	assert.equal(hiddenCheckouts(linked), undefined);
	const again = await recipe("software.dataflow").collect({ folder: root }, ctxFor(root));
	assert.equal(again.graph, undefined, "they are still not read");
	assert.deepEqual(again.warnings.filter((w) => /working cop/.test(w)), ["2 working copies of this repository in .claude/worktrees were not read, as hidden folders are skipped (real-run, second). To map one, choose it as the folder."]);
	// chosen as the folder, one is mapped
	const one = await recipe("software.connectivity").collect({ folder: path.join(root, ".claude/worktrees/real-run") }, ctxFor(root));
	assert.ok(one.graph && one.graph.nodes.some((n) => /portal/.test(n.label ?? n.id)));
});

test("data flow: entry points inside the services, focus marked, agent asked to trace", async () => {
	const rec = recipe("software.dataflow");
	const r = await rec.collect({ folder: SHOP, focus: "orders" }, ctxFor(SHOP));
	const g = r.graph;
	assert.equal(g.direction, "right");
	const http = node(g, "svc:orders#http");
	assert.equal(http.shape, "table");
	assert.equal(http.parent, "svc:orders");
	assert.deepEqual(http.rows.map((x) => x.text), ["★ GET /orders", "★ GET /orders/:id", "★ POST /orders", "★ DELETE /orders/:id"]);
	assert.deepEqual(node(g, "svc:inventory#http").rows.map((x) => x.text), ["GET /items/{sku}", "POST /reserve"]);
	assert.match(node(g, "svc:inventory#consumer").rows[0].text, /order-created \(Kafka\)/);
	assert.match(node(g, "svc:orders#schedule").rows[0].text, /0 3 \* \* \* \(CronJob cleanup\)/);
	assert.match(r.summary, /8 entry point\(s\) \(\d+ matching “orders”/);
	assert.match(r.facts, /## Code mentioning “orders”[\s\S]*services\/orders\/src\/index\.ts \(\d+\)/);
	assert.match(r.facts, /http POST \/orders — services\/orders\/src\/index\.ts:15 \(Express\/Fastify\)/);
	const prompt = rec.agentPrompt({ folder: SHOP, focus: "orders" }, r);
	assert.match(prompt, /focusing on “orders”[\s\S]*marked ★[\s\S]*publishes OrderCreated/);
	const { xml } = renderGraph(g, { recipe: rec.id });
	checkModelXml(xml);
	assertNoSecrets("dataflow", r, xml, prompt);
});

test("modules: imports resolved per language, grouped by folder; large code bases per folder; cycles in red", async () => {
	const rec = recipe("software.modules");
	const r = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	const g = r.graph;
	assert.ok(edge(g, "services/orders/src/index.ts", "services/orders/src/db.ts"));
	assert.ok(edge(g, "services/orders/src/index.ts", "services/orders/src/models.ts"));
	assert.ok(edge(g, "services/inventory/app/main.py", "services/inventory/app/models.py"), "relative Python import");
	assert.equal(node(g, "services/orders/src/db.ts").parent, "folder:services/orders/src");
	assert.match(r.facts, /External packages by use: .*express/);
	checkModelXml(renderGraph(g, { recipe: rec.id }).xml);

	// 200 modules in 20 folders with a folder-level cycle → drawn per folder, cycle edges red.
	const modules = new Map();
	const edges = new Map();
	for (let d = 0; d < 20; d++) for (let f = 0; f < 10; f++) modules.set(`pkg/d${d}/m${f}.ts`, { file: `pkg/d${d}/m${f}.ts`, lang: "js" });
	edges.set("pkg/d0/m0.ts", new Set(["pkg/d1/m0.ts", "pkg/d1/m1.ts"]));
	edges.set("pkg/d1/m0.ts", new Set(["pkg/d0/m5.ts"]));
	edges.set("pkg/d2/m0.ts", new Set(["pkg/d3/m0.ts"]));
	const big = modulesToGraph({ modules, edges, externals: new Map(), unresolved: 0, languages: new Map([["js", 200]]) }, "big");
	assert.match(big.level, /^folder/);
	assert.equal(big.graph.nodes.filter((n) => n.kind === "software:folder").length, 20);
	assert.equal(edge(big.graph, "dir:pkg/d0", "dir:pkg/d1").label, "2", "import counts on folder edges");
	assert.match(edge(big.graph, "dir:pkg/d0", "dir:pkg/d1").style, /#dc2626/);
	assert.doesNotMatch(edge(big.graph, "dir:pkg/d2", "dir:pkg/d3").style, /#dc2626/);
	assert.equal(big.cycles, 1);
	checkModelXml(renderGraph(big.graph, { recipe: rec.id }).xml);
	// Deep chains do not overflow the stack.
	const chain = new Map();
	for (let i = 0; i < 20000; i++) chain.set(`n${i}`, new Set([`n${i + 1}`]));
	chain.set("n20000", new Set(["n0"]));
	assert.equal(new Set(cycleMembers(chain).values()).size, 1);
});

test("classes: tables with members, inheritance drawn base-above-derived, associations; capped when huge", async () => {
	const rec = recipe("software.classes");
	const r = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	const g = r.graph;
	const repo = node(g, "type:OrderRepository");
	assert.equal(repo.shape, "table");
	assert.ok(repo.rows.some((x) => /find\(id\)/.test(x.text)), JSON.stringify(repo.rows));
	assert.equal(repo.parent, "folder:services/orders/src");
	assert.equal(node(g, "type:Entity").label, "«interface» Entity");
	assert.equal(node(g, "type:OrderStatus").label, "«enum» OrderStatus");
	const ext = edge(g, "type:Repository", "type:OrderRepository");
	assert.equal(ext.kind, "extends");
	assert.match(ext.style, /startArrow=block;startFill=0/);
	assert.equal(edge(g, "type:Entity", "type:Order").kind, "implements");
	assert.equal(edge(g, "type:Order", "type:OrderItem").kind, "association");
	assert.ok(node(g, "type:Item") && node(g, "type:Reservation"), "Python classes");
	checkModelXml(renderGraph(g, { recipe: rec.id }).xml);
	// Over the cap: the most connected types are kept.
	const entities = Array.from({ length: 220 }, (_, i) => ({ id: `type:T${i}`, kind: "class", name: `T${i}`, file: `src/f${i % 7}.ts`, line: 1, details: [] }));
	const relations = [{ from: "type:T219", to: "type:T218", kind: "extends" }];
	const capped = classesToGraph({ entities, relations, notes: [], fileCount: 7 }, "x");
	assert.equal(capped.shown, 150);
	assert.ok(node(capped.graph, "type:T219") && node(capped.graph, "type:T218"));
});

test("API surface: OpenAPI v3 and Swagger v2 endpoints by tag with request / response schemas; GraphQL types", async () => {
	const rec = recipe("software.api");
	const r = await rec.collect({ folder: SHOP }, ctxFor(SHOP));
	const g = r.graph;
	assert.match(r.summary, /2 OpenAPI spec\(s\), 7 endpoint\(s\), 5 schema\(s\); 1 GraphQL file\(s\)/);
	const spec = "spec:api/openapi.yaml";
	assert.match(node(g, spec).label, /Orders API\s+v1\.4\.0\s+\(OpenAPI 3\.0\.3\)/);
	assert.equal(node(g, spec).data.servers, "https://api.shop.example.com/v1");
	const post = node(g, `${spec}#op:POST:/orders`);
	assert.equal(post.parent, `${spec}#group:orders`);
	assert.deepEqual(post.rows.map((x) => `${x.text}=${x.detail ?? ""}`), ["Create an order=", "body=OrderCreate", "→ 201=Order", "→ 422=Error"]);
	assert.equal(post.data.security, "bearer");
	assert.deepEqual(node(g, `${spec}#op:GET:/orders/_id_`).rows[0], { text: "id", detail: "path · string" }, "path-level parameters");
	assert.match(node(g, `${spec}#op:DELETE:/orders/_id_`).label, /deprecated/);
	assert.equal(node(g, `${spec}#op:GET:/health`).data.security, undefined, "security: [] overrides the global one");
	assert.equal(edge(g, `${spec}#op:POST:/orders`, `${spec}#schema:Order`).label, "201");
	assert.equal(edge(g, `${spec}#schema:Order`, `${spec}#schema:OrderItem`).label, "items");
	assert.deepEqual(node(g, `${spec}#schema:Order`).rows.map((x) => `${x.key ?? ""}${x.text}:${x.detail}`), ["PKid:string (uuid)", "status?:string (pending|paid|cancelled)", "items:OrderItem[]"]);
	assert.equal(node(g, `${spec}#schema:OrderCreate`).rows[0].text, "extends OrderItem");
	const v2 = "spec:api/legacy-swagger.json";
	assert.deepEqual(node(g, `${v2}#op:PUT:/items`).rows.map((x) => `${x.text}=${x.detail}`), ["body=Item", "→ 204=saved"]);
	// GraphQL
	assert.equal(node(g, "gql:Query").parent, "gql:group");
	assert.equal(edge(g, "gql:Query", "gql:Order").label, "order, orders", "one arrow per pair, all fields named");
	assert.equal(edge(g, "gql:Node", "gql:Order").kind, "implements");
	assert.deepEqual(node(g, "gql:SearchResult").rows.map((x) => x.text), ["Order", "Customer"]);
	assert.deepEqual(node(g, "gql:Query").rows.map((x) => `${x.text}:${x.detail}`), ["order(…):Order", "orders(…):[Order!]!"]);
	checkModelXml(renderGraph(g, { recipe: rec.id }).xml);
	// Many endpoints: one table per group.
	const paths = {};
	for (let i = 0; i < 80; i++) paths[`/r${i % 4}/item${i}`] = { get: { tags: [`tag${i % 4}`], responses: { 200: { description: "ok" } } } };
	const many = openApiToGraph([{ file: "big.yaml", doc: { openapi: "3.1.0", info: { title: "Big" }, paths } }], "big");
	assert.equal(many.graph.nodes.filter((n) => n.kind === "api:group").length, 4);
	assert.equal(many.graph.nodes.find((n) => n.kind === "api:group").rows.length, 20);
	assert.equal(graphqlToGraph(parseGraphQL("type Query { a: Int }", "x.graphql"), "x").nodes.length, 1);
});

const KUBECTL_JSON = fs.readFileSync(path.join(__dirname, "fixtures/software/kubectl-get.json"), "utf8");

test("Kubernetes (live): namespaces › workloads with pod counts, Services, Ingress, env connections; read-only kubectl", async () => {
	const rec = recipe("software.kubernetes");
	const calls = [];
	const exec = async (cmd, args) => {
		calls.push([cmd, ...args]);
		const { checkReadOnly } = require("../src/main/mapper/readOnly");
		assert.equal(checkReadOnly(cmd, args), undefined, `${cmd} ${args.join(" ")} must pass the read-only guard`);
		if (args[0] === "config") return { stdout: args[1] === "current-context" ? "kind-dev\n" : "prod\nkind-dev\n", stderr: "", code: 0 };
		return { stdout: KUBECTL_JSON, stderr: "", code: 0 };
	};
	assert.deepEqual(await rec.loadOptions("context", {}, ctxFor("/", exec)), [
		{ value: "kind-dev", label: "kind-dev (current)" },
		{ value: "prod", label: "prod" },
	]);
	const r = await rec.collect({ context: "kind-dev" }, ctxFor("/", exec));
	const getCall = calls.find((c) => c[1] === "get");
	assert.ok(getCall.includes("--context") && getCall.includes("kind-dev") && getCall.includes("-A"));
	const g = r.graph;
	const web = node(g, "k8s:shop/Deployment/web");
	assert.equal(web.parent, "ns:shop");
	assert.match(web.label, /1\/2 ready · 2 pods, 3 restarts/);
	assert.match(web.style, /strokeColor=#dc2626/, "not all replicas ready");
	assert.match(r.warnings.join("\n"), /shop\/web: 1\/2 ready/);
	assert.match(node(g, "k8s:shop/StatefulSet/db").style, /cylinder3/);
	assert.match(node(g, "k8s:shop/CronJob/nightly").label, /⏱ 0 2 \* \* \*/);
	assert.ok(!g.nodes.some((n) => /coredns|kube-system/.test(n.id)), "system namespaces hidden by default");
	assert.ok(!g.nodes.some((n) => n.id.includes("svc:default/kubernetes")));
	assert.ok(edge(g, "k8s:svc:shop/web", "k8s:shop/Deployment/web"), "Service selects its workload");
	assert.equal(edge(g, "k8s:ing:shop/shop", "k8s:svc:shop/web").label, "/");
	assert.equal(edge(g, "k8s:shop/Deployment/web", "k8s:svc:shop/db").label, "postgres :5432");
	assert.equal(edge(g, "k8s:shop/Deployment/web", "k8s:svc:shop/cache").label, "redis :6379");
	assert.match(r.summary, /4 workload\(s\), 3 service\(s\), 1 namespace\(s\), 1 not healthy/);
	const { xml } = renderGraph(g, { recipe: rec.id });
	checkModelXml(xml);
	assertNoSecrets("kubernetes", r, xml, rec.agentPrompt({ context: "kind-dev" }, r));
	assert.ok(clusterToGraph(JSON.parse(KUBECTL_JSON), { includeSystem: true }).graph.nodes.some((n) => n.id === "ns:kube-system"));
});

test("Kubernetes (live): missing kubectl or an unreachable cluster is a clear MapperError", async () => {
	const rec = recipe("software.kubernetes");
	const missing = async () => {
		throw new MapperError("kubectl is not installed or not on your PATH.");
	};
	await assert.rejects(rec.collect({}, ctxFor("/", missing)), (e) => e instanceof MapperError && /not installed/.test(e.message) && /Install kubectl/.test(e.hint));
	const down = async () => ({ stdout: "", stderr: "The connection to the server 127.0.0.1:6443 was refused", code: 1 });
	await assert.rejects(rec.collect({}, ctxFor("/", down)), (e) => e instanceof MapperError && /Could not read the cluster: .*refused/.test(e.message) && /kubectl get pods/.test(e.hint));
	assert.deepEqual(await rec.loadOptions("context", {}, ctxFor("/", missing)), []);
	// One kind forbidden by RBAC: the rest is mapped, with a warning.
	const partial = async () => ({ stdout: KUBECTL_JSON, stderr: 'Error from server (Forbidden): ingresses.networking.k8s.io is forbidden: User "dev" cannot list resource "ingresses"', code: 1 });
	const r = await rec.collect({}, ctxFor("/", partial));
	assert.ok(r.graph);
	assert.match(r.warnings[0], /^Partly read: .*Forbidden/);
	await assert.rejects(rec.collect({ namespace: "Bad Name;" }, ctxFor("/", noExec)), /not a namespace name/);
});

test("software recipes: ids, fields, agent prompts and dig-deeper on every recipe", () => {
	const ids = softwareRecipes.map((r) => r.id);
	assert.deepEqual(ids, ["software.connectivity", "software.dataflow", "software.github-actions", "software.api", "software.modules", "software.classes", "software.kubernetes"]);
	for (const r of softwareRecipes) {
		assert.equal(r.category, "software");
		assert.ok(r.collect && r.agentPrompt && r.digDeeper, r.id);
		assert.match(r.digDeeper([{ label: "x", data: { a: "1" } }], "why?"), /why\?[\s\S]*"a":"1"/, r.id);
	}
});

const REPO = path.resolve(__dirname, "../..");
test("real repository: this repo and the bundled draw.io map quickly and render valid XML", { skip: !fs.existsSync(path.join(REPO, "drawio/src")) }, async () => {
	for (const [id, folder] of [
		["software.connectivity", REPO],
		["software.dataflow", REPO],
		["software.modules", REPO],
		["software.classes", path.join(REPO, "src")],
		["software.modules", path.join(REPO, "drawio")],
		["software.connectivity", path.join(REPO, "drawio")],
	]) {
		const started = Date.now();
		const r = await recipe(id).collect({ folder }, ctxFor(folder));
		const ms = Date.now() - started;
		assert.ok(r.graph, `${id} ${folder}: ${r.summary}`);
		assert.ok(ms < 15000, `${id} on ${folder} took ${ms} ms`);
		checkModelXml(renderGraph(r.graph, { recipe: id }).xml);
	}
	const c = await recipe("software.connectivity").collect({ folder: REPO }, ctxFor(REPO));
	assert.ok(c.graph.nodes.some((n) => n.id === "res:ext:api.anthropic.com"), "the extension's AI providers");
	assert.ok(c.graph.nodes.some((n) => n.id === "svc:drawio"), "the draw.io submodule is its own package");
	assert.ok(!c.graph.nodes.some((n) => n.label === "orders"), "test fixtures are not mapped");
});
