// Map records and the lookups on them: refresh diffs, dismissed findings,
// find/show/path, description worksheet and checks, tours, Ask pages, MCP tools.
// Run from standalone/: node --test test/mapper-insights.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const store = require("../src/main/mapper/store");
const query = require("../src/main/mapper/query");
const { renderGraph } = require("../src/main/mapper/render");
const { MAPPER_TOOLS } = require("../src/main/mapper/mcpTools");
const { checkModelXml } = require("./helpers/xml");

const recipe = { id: "test.shop", title: "Shop", category: "software", description: "", mode: "inventory", fields: [{ id: "folder", label: "Folder", type: "folder" }, { id: "password", label: "Password", type: "password", secret: true }] };
const graph = () => ({
	title: "Shop",
	nodes: [
		{ id: "web", label: "web", kind: "svc", files: ["web/server.js"] },
		{ id: "api", label: "orders-api", kind: "svc", files: ["api/"] },
		{ id: "db", label: "orders-db", kind: "db" },
		{ id: "mail", label: "mailer", kind: "svc" },
	],
	edges: [
		{ from: "web", to: "api", label: "http :8080" },
		{ from: "api", to: "db", label: "postgres :5432" },
	],
});
const result = (g = graph()) => ({
	graph: g,
	summary: "4 services",
	findings: [{ id: "open-db:db", kind: "open-db", severity: "high", title: "orders-db accepts connections from the internet", nodeIds: ["db"], fix: "Restrict the security group" }],
	checked: [{ check: "Databases open to the internet", scanned: 1 }],
});

test("a record keeps no secrets, fingerprints nodes, and is saved next to the diagram", () => {
	const r = store.createRecord({ recipe, input: { folder: "/repo", password: "hunter2" }, result: result(), root: "/repo" });
	assert.deepEqual(r.input, { folder: "/repo" });
	assert.equal(Object.keys(r.fingerprints).length, 4);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maps-"));
	store.saveRecord(dir, r);
	assert.ok(!fs.readFileSync(path.join(dir, ".drawai/maps", `${r.id}.json`), "utf8").includes("hunter2"));
	assert.equal(store.loadRecord(dir, r.id).id, r.id);
	assert.equal(store.loadRecord(dir, "../etc/passwd"), undefined);
});

test("refresh: what was added, removed and changed; descriptions and tours carry over to nodes that still exist", () => {
	const before = store.createRecord({ recipe, input: {}, result: result() });
	before.descriptions = { web: { description: "Serves the shop's pages", audience: "everyone", at: "x" }, mail: { description: "Sends order emails", audience: "everyone", at: "x" } };
	before.tours = [{ id: "t1", title: "Order", steps: [{ title: "a", caption: "c", nodeIds: ["web", "api"] }, { title: "b", caption: "c", nodeIds: ["mail"] }] }];
	const g = graph();
	g.nodes = g.nodes.filter((n) => n.id !== "mail");
	g.nodes.find((n) => n.id === "api").label = "orders-api v2";
	g.nodes.push({ id: "cache", label: "redis", kind: "cache" });
	const after = store.createRecord({ recipe, input: {}, result: result(g), previous: before });
	assert.deepEqual(store.diffRecords(before, after), { added: ["cache"], removed: ["mail"], changed: ["api"] });
	assert.deepEqual(Object.keys(after.descriptions), ["web"]);
	assert.deepEqual(after.tours[0].steps.map((s) => s.nodeIds), [["web", "api"]]);
	assert.equal(after.previous, before.id);
});

test("a dismissed finding stays hidden until it changes", () => {
	const r = store.createRecord({ recipe, input: {}, result: result() });
	const f = r.findings[0];
	r.dismissed[f.id] = store.findingFingerprint(f);
	assert.equal(store.activeFindings(r).length, 0);
	r.findings[0] = { ...f, detail: "now also port 22" };
	assert.equal(store.activeFindings(r).length, 1);
});

test("find, show and path answer from the map", () => {
	const r = store.createRecord({ recipe, input: {}, result: result() });
	assert.deepEqual(query.findNodes([r], "orders").map((n) => n.id), ["api", "db"]);
	assert.deepEqual(query.findNodes([r], "server.js").map((n) => n.id), ["web"]);
	const api = query.showNode(r, "api");
	assert.deepEqual(api.uses, [{ id: "db", label: "orders-db", via: "postgres :5432" }]);
	assert.deepEqual(api.usedBy, [{ id: "web", label: "web", via: "http :8080" }]);
	assert.equal(query.showNode(r, "db").findings.length, 1);
	assert.deepEqual(query.findPath(r, "web", "db").map((s) => s.id), ["web", "api", "db"]);
	assert.deepEqual(query.findPath(r, "db", "web").map((s) => s.dir), [undefined, "←", "←"]);
	assert.equal(query.findPath(r, "web", "mail"), undefined);
});

test("descriptions: worksheet pages missing ones; checks refuse unknown ids, placeholders and jargon for everyone", () => {
	const r = store.createRecord({ recipe, input: {}, result: result() });
	const ws = query.worksheet(r, { only: "missing", limit: 3 });
	assert.equal(ws.total, 4);
	assert.equal(ws.next, 3);
	assert.deepEqual(ws.entries.find((e) => e.id === "api").uses, ["orders-db (postgres :5432)"]);
	const c = query.checkDescriptions(
		r,
		[
			{ nodeId: "web", description: "Shows the shop's pages and sends orders on." },
			{ nodeId: "ap", description: "Takes orders from the web site." },
			{ nodeId: "db", description: "TODO describe this" },
			{ nodeId: "mail", description: "Calls the SMTP API endpoint on a cron." },
		],
		"everyone"
	);
	assert.deepEqual(c.accepted.map((a) => a.nodeId), ["web"]);
	assert.match(c.problems.join("\n"), /ap: no such node \(did you mean "api"\?\)/);
	assert.match(c.problems.join("\n"), /db: placeholder/);
	assert.match(c.problems.join("\n"), /mail: uses jargon/);
	assert.equal(query.checkDescriptions(r, [{ nodeId: "mail", description: "Calls the SMTP API endpoint on a cron." }], "developer").accepted.length, 1);
});

test("tours: unknown ids are refused; unconnected consecutive steps are flagged", () => {
	const r = store.createRecord({ recipe, input: {}, result: result() });
	assert.match(query.checkTour(r, [{ title: "a", caption: "x", nodeIds: ["nope"] }]).problems[0], /unknown node/);
	const ok = query.checkTour(r, [
		{ title: "a", caption: "The site", nodeIds: ["web"] },
		{ title: "b", caption: "The API", nodeIds: ["api"] },
		{ title: "c", caption: "Mail", nodeIds: ["mail"] },
	]);
	assert.deepEqual(ok.problems, []);
	assert.deepEqual(ok.warnings, ["steps 2 → 3 are not directly connected on the map"]);
});

test("Ask: a page of just the steps, numbered, with their edges and the answer", () => {
	const r = store.createRecord({ recipe, input: {}, result: result() });
	const { graph: g, problems } = query.answerGraph([r], "Where do orders go?", "From the site to the API, then the database.", [
		{ nodeId: "web", note: "takes the order" },
		{ nodeId: "api" },
		{ nodeId: "db", note: "stores it" },
		{ nodeId: "ghost" },
	]);
	assert.match(problems[0], /unknown node ghost/);
	assert.deepEqual(g.nodes.map((n) => n.label), ["1. web\ntakes the order", "2. orders-api", "3. orders-db\nstores it"]);
	assert.deepEqual(g.edges.map((e) => `${e.from}>${e.to}`), ["ask1>ask2", "ask2>ask3"]);
	checkModelXml(renderGraph(g, { recipe: "mapper.ask" }).xml);
});

test("render stores the map id and descriptions as tooltips", () => {
	const { xml } = renderGraph(graph(), { recipe: "test.shop", mapId: "m1", descriptions: { web: "Shows the shop's pages" } });
	checkModelXml(xml);
	assert.match(xml, /mapperId="web" mapId="m1" tooltip="Shows the shop&apos;s pages"/);
});

test("MCP tools: unique names, schemas, and read-only flags on the lookups", () => {
	const names = MAPPER_TOOLS.map((t) => t.name);
	assert.equal(new Set(names).size, names.length);
	for (const t of MAPPER_TOOLS) {
		assert.match(t.name, /^mapper_[a-z_]+$/);
		assert.equal(t.inputSchema.type, "object");
		assert.ok(t.description.length > 30, t.name);
	}
	const ro = Object.fromEntries(MAPPER_TOOLS.map((t) => [t.name, t.readOnly]));
	for (const n of ["mapper_maps", "mapper_find", "mapper_show", "mapper_path", "mapper_findings", "mapper_worksheet"]) assert.equal(ro[n], true, n);
	for (const n of ["mapper_run", "mapper_set_descriptions", "mapper_refresh", "mapper_answer"]) assert.equal(ro[n], false, n);
});

test("Save As: the map records follow the diagram (copied to a new folder, re-associated in the same one)", () => {
	const { MapperService } = require("../src/main/mapper/service");
	const a = fs.mkdtempSync(path.join(os.tmpdir(), "maps-a-"));
	const b = fs.mkdtempSync(path.join(os.tmpdir(), "maps-b-"));
	let cwd = a, diagram;
	const service = new MapperService({ client: null, cwd: () => cwd, diagram: () => diagram, context: () => ({}) });
	const untitled = store.createRecord({ recipe, input: {}, result: result() });
	store.saveRecord(a, untitled);
	const other = { ...store.createRecord({ recipe, input: {}, result: result() }), diagram: "other.drawio" };
	store.saveRecord(a, other);
	// untitled (in Documents) → b/shop.drawio: copied, the other diagram's map stays behind
	assert.equal(service.adoptRecords({ cwd: a }, { cwd: b, diagram: path.join(b, "shop.drawio") }), 1);
	cwd = b;
	diagram = path.join(b, "shop.drawio");
	assert.deepEqual(service.records().map((r) => r.id), [untitled.id]);
	assert.equal(store.loadRecord(a, untitled.id).diagram, undefined);
	// same folder, new name: re-associated
	assert.equal(service.adoptRecords({ cwd: b, diagram }, { cwd: b, diagram: path.join(b, "shop-v2.drawio") }), 1);
	diagram = path.join(b, "shop-v2.drawio");
	assert.equal(service.records()[0].id, untitled.id);
	assert.equal(store.loadRecord(b, untitled.id).diagram, "shop-v2.drawio");
});

test("a move: the map records go with the diagram, the current ones win, and none stay behind", () => {
	const a = fs.mkdtempSync(path.join(os.tmpdir(), "maps-move-a-"));
	const b = fs.mkdtempSync(path.join(os.tmpdir(), "maps-move-b-"));
	const mine = { ...store.createRecord({ recipe, input: {}, result: result() }), diagram: "plan.drawio" };
	const other = { ...store.createRecord({ recipe, input: {}, result: result() }), diagram: "other.drawio" };
	store.saveRecord(a, mine);
	store.saveRecord(a, other);
	// a → b: moved, the other diagram's map stays
	assert.equal(store.moveRecords({ cwd: a, diagram: path.join(a, "plan.drawio") }, { cwd: b, diagram: path.join(b, "plan.drawio") }), 1);
	assert.equal(store.loadRecord(a, mine.id), undefined);
	assert.equal(store.loadRecord(a, other.id).diagram, "other.drawio");
	// changed in b, and a stale copy left in a (as an earlier Save As would leave one)
	store.saveRecord(b, { ...store.loadRecord(b, mine.id), note: "current" });
	store.saveRecord(a, { ...mine, note: "stale" });
	// b → a: the current one comes back, over the stale one
	assert.equal(store.moveRecords({ cwd: b, diagram: path.join(b, "plan.drawio") }, { cwd: a, diagram: path.join(a, "plan.drawio") }), 1);
	assert.equal(store.loadRecord(a, mine.id).note, "current");
	assert.equal(store.loadRecord(b, mine.id), undefined);
	// a new name in the same folder: re-associated, still there
	assert.equal(store.moveRecords({ cwd: a, diagram: path.join(a, "plan.drawio") }, { cwd: a, diagram: path.join(a, "roadmap.drawio") }), 1);
	assert.equal(store.loadRecord(a, mine.id).diagram, "roadmap.drawio");
	// the same folder by a path with a link in it: re-associated in place, never taken out
	const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maps-link-")), "by-link");
	fs.symlinkSync(a, linked);
	assert.equal(store.moveRecords({ cwd: linked, diagram: path.join(linked, "roadmap.drawio") }, { cwd: fs.realpathSync(a), diagram: path.join(fs.realpathSync(a), "plan-b.drawio") }), 1);
	assert.equal(store.loadRecord(a, mine.id).diagram, "plan-b.drawio");
	assert.equal(store.hasRecords(a, path.join(a, "plan-b.drawio")), true);
	assert.equal(store.hasRecords(a, path.join(a, "roadmap.drawio")), false);
	assert.equal(store.hasRecords(b, path.join(b, "plan-b.drawio")), false);
	fs.rmSync(a, { recursive: true, force: true });
	fs.rmSync(b, { recursive: true, force: true });
});
