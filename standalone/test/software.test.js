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
const { scanSystem, stripComments } = require("../src/main/mapper/recipes/software/systemScan");
const { modulesToGraph, classesToGraph, cycleMembers } = require("../src/main/mapper/recipes/software/codeStructure");
const { openApiToGraph, parseGraphQL, graphqlToGraph } = require("../src/main/mapper/recipes/software/api");
const { clusterToGraph } = require("../src/main/mapper/recipes/software/kubernetes");
const { checkModelXml } = require("./helpers/xml");

const SHOP = path.join(__dirname, "fixtures/software/shop");
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
