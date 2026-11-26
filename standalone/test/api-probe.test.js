// The API surface map asked of a running API at its address. The "APIs" are servers on this
// computer, started by the tests: nothing here reaches the internet.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
require("./helpers/ts");
const { probeApi, apiAddress, asSpec, specLinks, introspectionToSdl, nothingFound, USUAL_PLACES } = require("../src/main/mapper/recipes/software/apiProbe");
const { apiRecipe, parseGraphQL } = require("../src/main/mapper/recipes/software/api");
const { MapperError } = require("../src/main/mapper/types");

const SPEC = { openapi: "3.0.3", info: { title: "Shop", version: "1" }, paths: { "/orders": { get: { tags: ["orders"], responses: { 200: { description: "ok" } } }, post: { tags: ["orders"], responses: { 201: { description: "made" } } } }, "/orders/{id}": { get: { tags: ["orders"], responses: { 200: { description: "ok" } } } } } };
const YAML = "openapi: 3.0.3\ninfo:\n  title: Yaml Shop\n  version: '1'\npaths:\n  /items:\n    get:\n      responses:\n        '200':\n          description: ok\n";
const SCHEMA = {
	data: {
		__schema: {
			queryType: { name: "RootQuery" },
			mutationType: { name: "Mutation" },
			subscriptionType: null,
			types: [
				{ kind: "OBJECT", name: "RootQuery", fields: [{ name: "order", args: [{ name: "id" }], type: { kind: "OBJECT", name: "Order" } }, { name: "orders", args: [], type: { kind: "NON_NULL", ofType: { kind: "LIST", ofType: { kind: "NON_NULL", ofType: { kind: "OBJECT", name: "Order" } } } } }], interfaces: [] },
				{ kind: "OBJECT", name: "Mutation", fields: [{ name: "cancel", args: [{ name: "id" }], type: { kind: "SCALAR", name: "Boolean" } }], interfaces: [] },
				{ kind: "OBJECT", name: "Order", fields: [{ name: "id", args: [], type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }, { name: "state", args: [], type: { kind: "ENUM", name: "State" } }], interfaces: [{ name: "Node" }] },
				{ kind: "INTERFACE", name: "Node", fields: [{ name: "id", args: [], type: { kind: "SCALAR", name: "ID" } }] },
				{ kind: "ENUM", name: "State", enumValues: [{ name: "OPEN" }, { name: "DONE" }] },
				{ kind: "INPUT_OBJECT", name: "Filter", inputFields: [{ name: "state", type: { kind: "ENUM", name: "State" } }] },
				{ kind: "UNION", name: "Thing", possibleTypes: [{ name: "Order" }] },
				{ kind: "SCALAR", name: "DateTime" },
				{ kind: "SCALAR", name: "String" },
				{ kind: "OBJECT", name: "__Type", fields: [] },
			],
		},
	},
};

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
/** A server on this computer; `routes`: path → answer, or a function of the request. Records what it was asked. */
async function api(routes) {
	const got = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const request = { method: req.method, path: req.url, host: req.headers.host, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
			got.push(request);
			let a = routes[req.url.split("?")[0]] ?? routes["*"];
			if (typeof a === "function") a = a(request);
			if (!a) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
			if (a.hang) return;
			const body = a.json !== undefined ? JSON.stringify(a.json) : a.text ?? "";
			res.writeHead(a.status ?? 200, { "content-type": a.type ?? (a.json !== undefined ? "application/json" : "text/html"), ...(a.headers ?? {}) }).end(body);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return { url: `http://127.0.0.1:${server.address().port}`, got, paths: () => got.map((g) => `${g.method} ${g.path}`) };
}
const found = (r) => [r.specs.map((s) => [s.file.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), s.doc.info.title]), r.graphql?.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")];

test("an API's address as typed: https unless it is this computer or a private network; never a sign-in in it, another scheme, or a cloud machine's own metadata", () => {
	assert.equal(apiAddress("api.example.com").toString(), "https://api.example.com/");
	assert.equal(apiAddress(" https://api.example.com/v2/#docs ").toString(), "https://api.example.com/v2/");
	assert.equal(apiAddress("localhost:8080/docs").toString(), "http://localhost:8080/docs");
	assert.equal(apiAddress("127.0.0.1:3000").toString(), "http://127.0.0.1:3000/");
	assert.equal(apiAddress("192.168.1.20/api").toString(), "http://192.168.1.20/api");
	assert.equal(apiAddress("orders-service:8080").toString(), "http://orders-service:8080/");
	for (const [bad, why] of [["", /Give the API's address/], ["ftp://x.example", /http:\/\/ or https:\/\//], ["file:///etc/passwd", /http:\/\/ or https:\/\//], ["https://me:pw@api.example.com", /Authorization field/], ["http://169.254.169.254/latest/meta-data", /metadata service/], ["http://metadata.google.internal/", /metadata service/], ["http://[fd00:ec2::254]/", /metadata service/], ["ht!tp://x y", /is not an address/]]) {
		assert.throws(() => apiAddress(bad), (e) => e instanceof MapperError && why.test(e.message), bad);
	}
});

test("the address of the document itself, of a docs page that names it, or of the API: the description is found each way, in JSON or YAML", async () => {
	// the document itself
	const direct = await api({ "/openapi.json": { json: SPEC } });
	let r = await probeApi(`${direct.url}/openapi.json`);
	assert.deepEqual(found(r), [[["/openapi.json", "Shop"]], undefined]);
	assert.deepEqual(direct.paths(), ["GET /openapi.json"], "one request, and no GraphQL question when a description was found");

	// a Swagger UI page whose start-up script names it
	const ui = await api({
		"/docs": { text: '<html><link rel="stylesheet" href="./swagger-ui.css"><script src="./swagger-ui-bundle.js"></script><script src="./swagger-initializer.js"></script></html>' },
		"/swagger-initializer.js": { text: 'window.ui = SwaggerUIBundle({ url: "/internal/spec.json", dom_id: "#swagger-ui" });', type: "application/javascript" },
		"/internal/spec.json": { json: SPEC },
	});
	r = await probeApi(`${ui.url}/docs`);
	assert.deepEqual(found(r), [[["/internal/spec.json", "Shop"]], undefined]);
	assert.deepEqual(ui.paths(), ["GET /docs", "GET /swagger-initializer.js", "GET /internal/spec.json"], "the page's styles and the Swagger UI bundle are not fetched");

	// a page that names several (springdoc's list, Redoc's attribute): each is read
	const many = await api({
		"/": { text: `<redoc spec-url='/a.yaml'></redoc><script>const c = {"urls":[{"url":"/b.json","name":"b"}]}</script>` },
		"/a.yaml": { text: YAML, type: "application/yaml" },
		"/b.json": { json: SPEC },
	});
	r = await probeApi(many.url);
	assert.deepEqual(found(r)[0].sort(), [["/a.yaml", "Yaml Shop"], ["/b.json", "Shop"]]);

	// a start-up script that lists descriptions of several hosts in one piece of text: this host's is taken, the others' are not asked
	const listed = await api({
		"/": { text: '<script src="./swagger-initializer.js" charset="UTF-8"> </script>' },
		"/swagger-initializer.js": (q) => ({ text: "const services = `other.example=https://other.example/api/v3/openapi.json,here=http://" + q.host + "/api/v3/openapi.json,more.example=https://more.example/v2/swagger.json`;", type: "application/javascript" }),
		"/api/v3/openapi.json": { json: SPEC },
	});
	r = await probeApi(listed.url);
	assert.deepEqual(found(r), [[["/api/v3/openapi.json", "Shop"]], undefined]);
	assert.deepEqual(listed.paths(), ["GET /", "GET /swagger-initializer.js", "GET /api/v3/openapi.json"]);

	// the Link header says where it is
	const linked = await api({ "/": { json: { hello: "api" }, headers: { link: '</spec>; rel="service-desc"' } }, "/spec": { json: SPEC } });
	assert.deepEqual(found(await probeApi(linked.url)), [[["/spec", "Shop"]], undefined]);

	// only the API's address: the usual places are asked, under the path given first, and the first that answers ends it
	const plain = await api({ "/shop/v1/openapi.yaml": { text: YAML, type: "text/yaml" } });
	r = await probeApi(`${plain.url}/shop/v1`);
	assert.deepEqual(found(r), [[["/shop/v1/openapi.yaml", "Yaml Shop"]], undefined]);
	assert.ok(plain.got.every((g) => g.method === "GET"), "only GET");
	assert.ok(plain.got.length <= 12, `${plain.got.length} requests`);
	assert.ok(USUAL_PLACES.includes("v3/api-docs") && USUAL_PLACES.includes("swagger/v1/swagger.json"));
});

test("GraphQL: an endpoint is asked for its schema with one read-only question, when its address is given or nothing else was found", async () => {
	const gql = await api({ "/graphql": (q) => (q.method === "POST" && /IntrospectionQuery/.test(q.body) ? { json: SCHEMA } : { status: 400, json: { errors: [{ message: "Must provide query string." }] } }) });
	const named = await probeApi(`${gql.url}/graphql`);
	assert.deepEqual(found(named), [[], "/graphql"]);
	assert.deepEqual(gql.paths(), ["GET /graphql", "POST /graphql"], "the address itself, then the question: nothing else is asked");
	// the schema as the map reads it: the roots by their usual names, whatever the API calls them
	const types = parseGraphQL(named.graphql.sdl, "x");
	assert.deepEqual(types.map((t) => `${t.kind} ${t.name}`).sort(), ["enum State", "input Filter", "interface Node", "scalar DateTime", "type Mutation", "type Order", "type Query", "union Thing"]);
	assert.deepEqual(types.find((t) => t.name === "Query").fields.map((f) => `${f.name}:${f.type}:${f.args}`), ["order:Order:1", "orders:[Order!]!:0"]);
	assert.deepEqual(types.find((t) => t.name === "Order").implements, ["Node"]);
	// (an API with queries only, and one whose answer has a type without a name: read, not tripped over)
	assert.equal(introspectionToSdl({ data: { __schema: { queryType: { name: "Q" }, types: [{ kind: "OBJECT", name: "Q", fields: [{ name: "a", args: [], type: { kind: "SCALAR", name: "Int" } }, { type: {} }] }, { kind: "OBJECT" }, null] } } }), "type Query {\n  a: Int\n}");
	assert.equal(introspectionToSdl({ data: null }), undefined);
	assert.equal(introspectionToSdl({ errors: [{ message: "introspection is disabled" }] }), undefined);

	// the address moves the question on (a server that wants /graphql/): asked where it was sent to, in the same place
	const moved = await api({
		"/graphql": { status: 308, headers: { location: "/graphql/" } },
		"/graphql/": (q) => (q.method === "POST" && /IntrospectionQuery/.test(q.body) ? { json: SCHEMA } : { status: 400, json: {} }),
	});
	const sent = await probeApi(`${moved.url}/graphql`);
	assert.deepEqual(found(sent), [[], "/graphql/"]);
	assert.deepEqual(moved.got.filter((g) => g.method === "POST").map((g) => g.path), ["/graphql", "/graphql/"]);
	// (a question is not turned into a plain read: "see other" is where it stops)
	const calls = [];
	const seeOther = async (u, init) => {
		calls.push(`${init.method} ${new URL(u).pathname}`);
		return init.method === "POST" && new URL(u).pathname === "/graphql" ? new Response("", { status: 303, headers: { location: "/other" } }) : new Response("{}", { status: 404 });
	};
	await probeApi("https://api.example.com/graphql", { fetch: seeOther, deadlineMs: 4000 });
	assert.ok(calls.includes("POST /graphql") && !calls.some((c) => c.endsWith(" /other")), calls.join(", "));

	// only the host given: no description anywhere, so the usual GraphQL endpoints are asked last
	const bare = await api({ "/api/graphql": (q) => (q.method === "POST" ? { json: SCHEMA } : undefined) });
	const r = await probeApi(bare.url);
	assert.deepEqual(found(r), [[], "/api/graphql"]);
	assert.deepEqual(bare.got.filter((g) => g.method === "POST").map((g) => g.path), ["/graphql", "/api/graphql"]);
	assert.ok(bare.got.length <= 40);
});

test("descriptions at one address that differ only by what is asked of it: each is drawn as its own, the same one once, and no query is shown", async () => {
	const other = (title, path) => ({ ...SPEC, info: { title, version: "1" }, paths: { [path]: { get: { responses: { 200: { description: "ok" } } } } } });
	const groups = await api({
		"/": { text: `<script>SwaggerUIBundle({ urls: [{ url: "/spec?group=a&api_key=abc123" }, { url: "/spec?group=b" }, { url: "/spec?group=a&again=1" }] })</script>` },
		"/spec": (q) => ({ json: /group=b/.test(q.path) ? other("Billing", "/invoices") : other("Shop", "/orders") }),
	});
	const r = await probeApi(groups.url);
	assert.deepEqual(r.specs.map((s) => [s.file.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), s.doc.info.title]), [["/spec", "Shop"], ["/spec #2", "Billing"]]);
	assert.ok(!JSON.stringify(r).includes("abc123") && !JSON.stringify(r).includes("group="));
	// drawn: every shape has an id of its own
	const ctx = { cwd: os.tmpdir(), progress: () => {}, signal: new AbortController().signal, exec: async () => assert.fail("no commands") };
	const map = await apiRecipe.collect({ folder: "", url: groups.url }, ctx);
	const ids = map.graph.nodes.map((n) => n.id);
	assert.equal(new Set(ids).size, ids.length, "no two shapes share an id");
	assert.match(map.summary, /^2 OpenAPI spec\(s\), 2 endpoint\(s\)/);
});

test("it stays on the host it was given: the Authorization header goes nowhere else, and a redirect away is not followed", async () => {
	const other = await api({ "*": { json: SPEC } });
	const guarded = await api({
		"/openapi.json": (q) => (q.auth === "Bearer s3cret-token" ? { json: SPEC } : { status: 401, json: { error: "sign in" } }),
		"/moved": { status: 302, headers: { location: `${other.url}/openapi.json` } },
		"/here": { status: 301, headers: { location: "/openapi.json" } },
	});
	// without what it needs: it says a sign-in was asked for
	let r = await probeApi(guarded.url, { timeoutMs: 2000 });
	assert.deepEqual(found(r), [[], undefined]);
	assert.match(nothingFound(r), /it asked for a sign-in at \d+ of them \(put what it needs into the Authorization field\)|most are not there/);
	const only401 = await api({ "*": { status: 401, json: {} } });
	assert.match(nothingFound(await probeApi(only401.url)), /asked for a sign-in at \d+ of them/);

	// with it: found, and the header was on every request to that host
	guarded.got.length = 0;
	r = await probeApi(`${guarded.url}/here`, { authorization: "Bearer s3cret-token" });
	assert.deepEqual(found(r), [[["/openapi.json", "Shop"]], undefined]);
	assert.ok(guarded.got.every((g) => g.auth === "Bearer s3cret-token"));
	// a redirect to another host (here: another port) is not followed: that host is asked nothing, and told nothing
	r = await probeApi(`${guarded.url}/moved`, { authorization: "Bearer s3cret-token" });
	assert.equal(other.got.length, 0);
	assert.equal(r.asked[0].status, 302);
	// a link on a page to another host is not followed either
	const page = await api({ "/": { text: `<script>SwaggerUIBundle({ url: "${other.url}/openapi.json" })</script>` } });
	await probeApi(page.url, { authorization: "Bearer s3cret-token" });
	assert.equal(other.got.length, 0);
	// nor is one in a Link header: the one to this host is followed, the one to another host is not asked at all
	const linked = await api({ "/": { text: "<html></html>", headers: { link: `<${other.url}/openapi.json>; rel="service-desc", </real.json>; rel="service-desc"` } }, "/real.json": { json: SPEC } });
	r = await probeApi(linked.url, { authorization: "Bearer s3cret-token" });
	assert.equal(other.got.length, 0, "a Link header does not carry the Authorization header to another host");
	assert.deepEqual(found(r), [[["/real.json", "Shop"]], undefined]);
	assert.ok(!r.asked.some((a) => a.url.startsWith(other.url)));
	// and once https was given, plain http on that host is another place too: a redirect or a link down to it is not followed
	const calls = [];
	const downgrade = async (u, init) => {
		calls.push([String(u), init.headers.Authorization]);
		if (String(u) === "https://api.example.com/") return new Response("", { status: 302, headers: { location: "http://api.example.com/openapi.json" } });
		if (String(u) === "https://api.example.com/api-docs") return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html", link: '<http://api.example.com/openapi.json>; rel="service-desc"' } });
		return new Response("{}", { status: 404 });
	};
	r = await probeApi("https://api.example.com", { authorization: "Bearer s3cret-token", fetch: downgrade, deadlineMs: 5000 });
	assert.ok(calls.length > 5 && calls.every(([u]) => u.startsWith("https://api.example.com/")), `only https on that host: ${calls.find(([u]) => !u.startsWith("https://api.example.com/"))}`);
	assert.ok(calls.some(([u]) => u === "https://api.example.com/api-docs"), "the page whose Link header pointed down to http was asked");
	// what is shown of an address has no query in it, and nothing anywhere holds the header
	const withQuery = await api({ "/spec": { json: SPEC } });
	r = await probeApi(`${withQuery.url}/spec?api_key=abc123`, { authorization: "Bearer s3cret-token" });
	assert.ok(!JSON.stringify(r).includes("abc123") && !JSON.stringify(r).includes("s3cret-token"));
});

test("an API without a description, one that cannot be reached, one that is slow or sends too much: bounded, and it says what happened", async () => {
	const none = await api({});
	let r = await probeApi(`${none.url}/v1`);
	assert.deepEqual(found(r), [[], undefined]);
	assert.ok(none.got.length <= 40, `${none.got.length} requests`);
	assert.equal(new Set(none.paths()).size, none.got.length, "no address is asked twice");
	assert.match(nothingFound(r), /^No OpenAPI \/ Swagger document or GraphQL schema was found on 127\.0\.0\.1:\d+: \d+ addresses were asked and most are not there \(404\)\. Not every API publishes one\. If this one does, give the address of the document itself .*or map its repository\.$/);

	// nothing listens there
	const closed = await api({});
	const port = new URL(closed.url).port;
	servers.pop().close();
	await new Promise((res) => setTimeout(res, 50));
	r = await probeApi(`http://127.0.0.1:${port}`, { timeoutMs: 1500 });
	assert.match(nothingFound(r), /^127\.0\.0\.1:\d+ could not be reached \(.*\)\. Check the address, and that this computer can reach it\.$/);

	// an endpoint that never answers does not hold it up beyond its time; a huge answer is not read
	const slow = await api({ "/openapi.json": { hang: true }, "/swagger.json": { text: `{"openapi":"3.0.0","paths":{},"pad":"${"x".repeat(9 * 1024 * 1024)}"}`, type: "application/json" }, "/v3/api-docs": { json: SPEC } });
	const started = Date.now();
	r = await probeApi(slow.url, { timeoutMs: 400 });
	assert.deepEqual(found(r), [[["/v3/api-docs", "Shop"]], undefined]);
	assert.ok(Date.now() - started < 5000);
	assert.equal(r.asked.find((a) => a.url.endsWith("/openapi.json")).status, "no answer in time");

	// stopped
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(probeApi(none.url, { signal: stop.signal }), /Cancelled/);
	// what is and is not a description
	assert.equal(asSpec('{"swagger":"2.0","paths":{}}').swagger, "2.0");
	for (const no of ["", "<html>", '{"openapi":"3.0.0"}', '["openapi"]', "paths: {}", "{not json", '"openapi: 3"']) assert.equal(asSpec(no), undefined, no);
	assert.deepEqual(specLinks('<a href="javascript:alert(1)">x</a> url: "data:text/plain,hi" url: "https://elsewhere.example/openapi.json" url: "/ok.json"', new URL("http://h.example/docs/")), ["http://h.example/ok.json"]);
});

test("the API surface map from an address: drawn like one read from files, with the Authorization header in nothing that is kept", async () => {
	const live = await api({ "/v3/api-docs": (q) => (q.auth === "Bearer s3cret-token" ? { json: SPEC } : { status: 401, json: {} }) });
	const ctx = { cwd: os.tmpdir(), progress: () => {}, signal: new AbortController().signal, exec: async () => assert.fail("no commands") };
	const fields = Object.fromEntries(apiRecipe.fields.map((f) => [f.id, f]));
	assert.deepEqual([fields.folder.required, fields.url.type, fields.authorization.type, fields.authorization.secret], [false, "text", "password", true]);

	const host = live.url.replace("http://", "");
	const r = await apiRecipe.collect({ folder: "", url: live.url, authorization: "Bearer s3cret-token" }, ctx);
	assert.match(r.summary, /^1 OpenAPI spec\(s\), 3 endpoint\(s\), 0 schema\(s\) \(\d+ ms\)$/);
	assert.equal(r.graph.title.includes(host), true);
	assert.ok(r.graph.nodes.some((n) => /orders/.test(n.label)));
	assert.ok(!JSON.stringify(r).includes("s3cret-token"), "the header is in nothing the map keeps or hands to the agent");
	assert.match(r.facts, new RegExp(`/v3/api-docs`));

	// nothing there: no map, and the reason
	const empty = await api({});
	const nothing = await apiRecipe.collect({ url: empty.url }, ctx);
	assert.equal(nothing.graph, undefined);
	assert.match(nothing.summary, /^No OpenAPI \/ Swagger document or GraphQL schema was found on /);

	// a folder and an address: both are read; an address that gives nothing is a warning beside the folder's map
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-api-"));
	fs.writeFileSync(path.join(dir, "openapi.yaml"), "openapi: 3.0.3\ninfo:\n  title: Yaml Shop\n  version: '1'\npaths:\n  /items:\n    get:\n      responses:\n        '200':\n          description: ok\n");
	const both = await apiRecipe.collect({ folder: dir, url: live.url, authorization: "Bearer s3cret-token" }, ctx);
	assert.match(both.summary, /^2 OpenAPI spec\(s\), 4 endpoint\(s\)/);
	const beside = await apiRecipe.collect({ folder: dir, url: empty.url }, ctx);
	assert.match(beside.summary, /^1 OpenAPI spec\(s\), 1 endpoint\(s\)/);
	assert.ok(beside.warnings.some((w) => /^No OpenAPI \/ Swagger document or GraphQL schema was found on /.test(w)));
	// no address: the folder alone, as before, and nothing is asked of anyone
	const before = live.got.length;
	assert.match((await apiRecipe.collect({ folder: dir }, ctx)).summary, /^1 OpenAPI spec\(s\)/);
	assert.equal(live.got.length, before);
});
