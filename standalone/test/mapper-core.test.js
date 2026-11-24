// Unit tests for the Mapper core: the read-only guard, layout, rendering, and the
// GitHub Actions recipe. Run from standalone/: node --test test/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const { checkReadOnly } = require("../src/main/mapper/readOnly");
const { layoutGraph } = require("../src/main/mapper/layout");
const { renderGraph } = require("../src/main/mapper/render");
const { createContext } = require("../src/main/mapper/context");
const { githubActionsRecipe, workflowsToGraph } = require("../src/main/mapper/recipes/software/githubActions");
const { catalog } = require("../src/main/mapper/registry");
const { checkModelXml } = require("./helpers/xml");

test("read-only guard: inventory commands pass, anything that changes things is refused", () => {
	for (const [cmd, args] of [
		["az", ["account", "list", "-o", "json"]],
		["az", ["graph", "query", "-q", "Resources | limit 5"]],
		["az", ["network", "vnet", "list", "--subscription", "x"]],
		["aws", ["ec2", "describe-instances", "--region", "us-east-1"]],
		["aws", ["sts", "get-caller-identity"]],
		["aws", ["s3api", "list-buckets"]],
		["/usr/local/bin/aws", ["lambda", "list-functions"]],
		["gcloud", ["asset", "search-all-resources", "--scope=projects/p"]],
		["gcloud", ["projects", "list", "--format=json"]],
		["kubectl", ["get", "pods", "-A", "-o", "json"]],
		["git", ["remote", "-v"]],
		["gh", ["api", "repos/o/r"]],
	]) {
		assert.equal(checkReadOnly(cmd, args), undefined, `${cmd} ${args.join(" ")}`);
	}
	for (const [cmd, args] of [
		["az", ["vm", "delete", "-n", "x"]],
		["az", ["group", "create", "-n", "x"]],
		["aws", ["ec2", "terminate-instances", "--instance-ids", "i-1"]],
		["aws", ["s3", "rm", "s3://b", "--recursive"]],
		["aws", ["iam", "create-user", "--user-name", "x"]],
		["gcloud", ["compute", "instances", "delete", "x"]],
		["kubectl", ["delete", "pod", "x"]],
		["kubectl", ["config", "use-context", "prod"]],
		["git", ["push"]],
		["gh", ["api", "-X", "DELETE", "repos/o/r"]],
		["rm", ["-rf", "/"]],
		["python3", ["-c", "print(1)"]],
		["sqlite3", ["db", "DROP TABLE t"]],
	]) {
		assert.ok(checkReadOnly(cmd, args), `${cmd} ${args.join(" ")} must be refused`);
	}
});

test("the command runner refuses writes before starting anything", async () => {
	const ctx = createContext({ cwd: os.tmpdir(), env: process.env });
	await assert.rejects(ctx.exec("aws", ["ec2", "terminate-instances"]), /Refused: .*only reads/);
	await assert.rejects(ctx.exec("definitely-not-a-cli-xyz", []), /not one of the Mapper's read-only tools/);
});

const cloudish = {
	title: "Test",
	direction: "down",
	nodes: [
		{ id: "acct", label: "Account 1", kind: "aws:account", container: true },
		{ id: "vpc", label: "VPC", kind: "aws:vpc", container: true, parent: "acct" },
		{ id: "subA", label: "Subnet A", kind: "aws:subnet", container: true, parent: "vpc" },
		{ id: "subB", label: "Subnet B", kind: "aws:subnet", container: true, parent: "vpc" },
		{ id: "web", label: "web-1", kind: "aws:ec2", shape: "icon", parent: "subA", data: { arn: "arn:aws:ec2:i-1", "bad key!": "x" } },
		{ id: "db", label: "orders-db", kind: "aws:rds", shape: "icon", parent: "subB" },
		{ id: "s3", label: "assets", kind: "aws:s3", shape: "icon", parent: "acct" },
		{ id: "users", label: "users", kind: "db:table", shape: "table", rows: [{ text: "id", key: "PK", detail: "int" }, { text: "org_id", key: "FK", detail: "int" }] },
	],
	edges: [
		{ from: "web", to: "db", label: "5432" },
		{ from: "web", to: "s3" },
		{ from: "missing", to: "db" },
	],
	legend: ["Mapped read-only"],
};

test("layout: children sit inside their containers, nothing overlaps among siblings", () => {
	const { boxes } = layoutGraph(cloudish);
	for (const n of cloudish.nodes) assert.ok(boxes.get(n.id), `no box for ${n.id}`);
	// Children's boxes are relative to the parent and fit inside it.
	for (const n of cloudish.nodes.filter((n) => n.parent)) {
		const b = boxes.get(n.id);
		const p = boxes.get(n.parent);
		assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= p.width && b.y + b.height <= p.height, `${n.id} does not fit in ${n.parent}: ${JSON.stringify(b)} in ${JSON.stringify(p)}`);
	}
	const siblings = new Map();
	for (const n of cloudish.nodes) {
		const k = n.parent ?? "";
		if (!siblings.has(k)) siblings.set(k, []);
		siblings.get(k).push(boxes.get(n.id));
	}
	for (const list of siblings.values()) {
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i];
				const b = list[j];
				const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
				assert.ok(!overlap, `overlap ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
			}
	}
});

test("layout: a chain of connected nodes goes in layers along the flow; cycles do not hang", () => {
	const chain = (dir) => ({
		title: "c",
		direction: dir,
		nodes: ["a", "b", "c", "d"].map((id) => ({ id, label: id, kind: "x" })),
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "c", to: "d" },
			{ from: "d", to: "a" },
		],
	});
	const down = layoutGraph(chain("down")).boxes;
	assert.ok(down.get("a").y < down.get("b").y && down.get("b").y < down.get("c").y && down.get("c").y < down.get("d").y);
	const right = layoutGraph(chain("right")).boxes;
	assert.ok(right.get("a").x < right.get("b").x && right.get("c").x < right.get("d").x);
});

test("drawing a map: its connectors hop over each other where they cross, and are then routed around the shapes; a map too large for that, or a router that fails, is still drawn", async () => {
	const { drawMap, MAX_ROUTED_EDGES } = require("../src/main/mapper/draw");
	const graphOf = (edges, style) => ({ title: "Shop", nodes: [{ id: "a", label: "A", kind: "test:box", data: {} }, { id: "b", label: "B", kind: "test:box", data: {} }], edges: Array.from({ length: edges }, () => ({ from: "a", to: "b", ...(style ? { style } : {}) })) });
	const client = (route = () => ({ results: [{ ok: true, ids: ["e1", "e2"] }], idMap: {} }), drawn = ["map1", "map2", "mapE1", "mapE2"], drawnOn = "page-7") => {
		const calls = [];
		return {
			calls,
			aiGetModel: async () => ({ page: { name: "Page-1" }, totalCells: 0 }),
			aiApplyOps: async (ops, options) => {
				calls.push([ops, options]);
				return ops[0].op === "layout" ? route() : { results: [{ ok: true, ids: drawn }], idMap: {}, ...(drawnOn ? { page: drawnOn } : {}) };
			},
		};
	};
	const c = client();
	assert.deepEqual(await drawMap(c, graphOf(2), "test.recipe"), { page: "Page-1", newPage: false, cells: 4 });
	assert.equal(c.calls.length, 2);
	assert.equal(c.calls[0][0][0].op, "insertXml");
	// every connector: the Mapper's own style, and a recipe's
	assert.equal((c.calls[0][0][0].xml.match(/jumpStyle=arc;jumpSize=6;/g) || []).length, 2);
	const styled = renderGraph(graphOf(1, "edgeStyle=entityRelationEdgeStyle;endArrow=ERmany"), { recipe: "test.recipe" }).xml;
	assert.match(styled, /style="edgeStyle=entityRelationEdgeStyle;endArrow=ERmany;jumpStyle=arc;jumpSize=6;"/);
	assert.match(renderGraph(graphOf(1, "jumpStyle=gap;"), { recipe: "test.recipe" }).xml, /style="jumpStyle=gap;jumpSize=6;"/, "a recipe's own choice is kept");
	// then the router, as a step of its own that moves no shape
	// (of what was just drawn, by its ids and on the page it was drawn on: never of whatever page is shown by then,
	// which can be another map with the very same ids)
	assert.deepEqual(c.calls[1], [[{ op: "layout", type: "route", ids: ["map1", "map2", "mapE1", "mapE2"] }], { selectResult: false, flash: false, atomic: true, review: true, page: "page-7" }]);
	for (const unknown of [client(undefined, []), client(undefined, undefined, "")]) {
		await drawMap(unknown, graphOf(2), "test.recipe");
		assert.equal(unknown.calls.length, 1, "nothing to name, or no page to name: nothing is routed");
	}
	// a very large map's lines do not hop either: draw.io compares each with every other on every redraw
	assert.ok(!/jumpStyle/.test(renderGraph(graphOf(MAX_ROUTED_EDGES + 1), { recipe: "test.recipe" }).xml));
	assert.equal((renderGraph(graphOf(MAX_ROUTED_EDGES), { recipe: "test.recipe" }).xml.match(/jumpStyle=arc/g) || []).length, MAX_ROUTED_EDGES);

	// no connectors, or more than routing is worth waiting for: drawn as it is
	for (const edges of [0, MAX_ROUTED_EDGES + 1]) {
		const plain = client();
		await drawMap(plain, graphOf(edges), "test.recipe");
		assert.equal(plain.calls.length, 1, `${edges} connectors`);
	}
	// a router that fails, either way it can: the map is drawn all the same
	for (const route of [() => ({ results: [{ ok: false, error: "The connector router is not available" }], idMap: {}, rolledBack: true }), () => { throw new Error("the editor went away"); }]) {
		const failing = client(route);
		assert.equal((await drawMap(failing, graphOf(2), "test.recipe")).cells, 4);
	}
});

test("render: a well-formed draw.io fragment with data on every shape and edges only between drawn shapes", () => {
	const { xml, cells } = renderGraph(cloudish, { recipe: "test.recipe" });
	checkModelXml(xml);
	assert.match(xml, /<object id="map5" label="web-1" mapper="test\.recipe" mapperKind="aws:ec2" mapperId="web" arn="arn:aws:ec2:i-1" bad_key_="x">/);
	assert.match(xml, /verticalLabelPosition=bottom/);
	assert.match(xml, /value="&lt;b&gt;PK&lt;\/b&gt;&amp;nbsp;id &lt;font/, "table rows are HTML labels, escaped in the attribute");
	assert.equal((xml.match(/edge="1"/g) || []).length, 2, "the edge to a missing node is left out");
	assert.match(xml, /value="5432"/);
	assert.match(xml, /mapperKind="legend"/);
	// 8 nodes + 2 table rows + 2 edges + legend
	assert.equal(cells, 13);
	// Parents come before their children.
	const order = [...xml.matchAll(/<object id="(map\d+)"/g)].map((m) => m[1]);
	assert.ok(order.indexOf("map1") < order.indexOf("map2") && order.indexOf("map2") < order.indexOf("map3"));
});

test("GitHub Actions: triggers, jobs with steps, needs, reusable workflows and workflow_run", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-"));
	fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".github/workflows/ci.yml"),
		`name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: npm test
  deploy:
    needs: build
    uses: ./.github/workflows/deploy.yml
`
	);
	fs.writeFileSync(
		path.join(dir, ".github/workflows/deploy.yml"),
		`name: Deploy
on: [workflow_call, workflow_dispatch]
jobs:
  ship:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy.sh
`
	);
	fs.writeFileSync(
		path.join(dir, ".github/workflows/notify.yml"),
		`name: Notify
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  schedule:
    - cron: "0 3 * * *"
jobs:
  ping:
    runs-on: ubuntu-latest
    steps: [{ uses: "some/action@0123456789abcdef0123456789abcdef01234567" }]
`
	);
	fs.writeFileSync(path.join(dir, ".github/workflows/broken.yml"), "name: [unclosed\n");
	const progress = [];
	const r = await githubActionsRecipe.collect({ folder: dir }, { cwd: dir, progress: (t) => progress.push(t), signal: new AbortController().signal, exec: async () => assert.fail("no commands") });
	assert.equal(r.summary, "3 workflow(s), 4 job(s)");
	assert.equal(r.warnings.length, 1, "the broken file is reported, not fatal");
	const g = r.graph;
	const node = (id) => g.nodes.find((n) => n.id === id);
	assert.deepEqual(node("wf:.github/workflows/ci.yml#build").rows.map((x) => x.text), ["actions/checkout@v4", "Test"]);
	assert.equal(node("wf:.github/workflows/deploy.yml#ship").data.environment, "production");
	const has = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
	assert.ok(has("wf:.github/workflows/ci.yml#build", "wf:.github/workflows/ci.yml#deploy"), "needs");
	assert.ok(has("wf:.github/workflows/ci.yml#deploy", "wf:.github/workflows/deploy.yml"), "reusable workflow call");
	assert.ok(has("wf:.github/workflows/ci.yml", "wf:.github/workflows/notify.yml"), "workflow_run");
	assert.ok(g.nodes.some((n) => n.kind === "gha:trigger" && /cron|0 3/.test(n.label)), "schedule trigger with its cron");
	assert.ok(node("trigger:push\nbranches: main"), "push trigger with branch filter");
	assert.ok(!g.nodes.some((n) => /workflow_call/.test(n.label)), "workflow_call is drawn as a call, not a trigger");
	assert.match(node("wf:.github/workflows/notify.yml#ping").rows[0].text, /some\/action@0123/);
	checkModelXml(renderGraph(g, { recipe: githubActionsRecipe.id }).xml);
	assert.match(githubActionsRecipe.digDeeper([{ label: "build", data: { job: "build" } }], "why is it slow?"), /why is it slow\?[\s\S]*"job":"build"/);
});

test("GitHub Actions on a real repository (the bundled draw.io's workflows)", { skip: !fs.existsSync(path.resolve(__dirname, "../../drawio/.github/workflows")) }, async () => {
	const repo = path.resolve(__dirname, "../../drawio");
	const r = await githubActionsRecipe.collect({ folder: repo }, { cwd: repo, progress: () => {}, signal: new AbortController().signal, exec: async () => assert.fail() });
	assert.ok(r.graph, r.summary);
	assert.ok(r.graph.nodes.some((n) => n.kind === "gha:job"));
	checkModelXml(renderGraph(r.graph, { recipe: githubActionsRecipe.id }).xml);
});

test("catalog: every category exists and recipe ids are unique", () => {
	const c = catalog();
	assert.deepEqual(c.categories.map((x) => x.id), ["software", "database", "azure", "aws", "gcp", "ml"]);
	const ids = c.recipes.map((r) => r.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const r of c.recipes) {
		assert.ok(c.categories.some((x) => x.id === r.category), r.id);
		assert.ok(r.fields.every((f) => f.id && f.label && f.type), r.id);
	}
});

test("render: line breaks in labels survive as <br> (draw.io labels are HTML)", () => {
	const { xml } = renderGraph({ title: "t", nodes: [{ id: "a", label: "schedule\n0 3 * * *", kind: "x" }], edges: [] }, { recipe: "r" });
	assert.match(xml, /label="schedule&lt;br&gt;0 3 \* \* \*"/);
});

test("read-only guard: read verbs with positional arguments pass, writes hidden among them do not", () => {
	assert.equal(checkReadOnly("gcloud", ["projects", "describe", "my-project", "--format=json"]), undefined);
	assert.equal(checkReadOnly("gcloud", ["compute", "instances", "describe", "vm-1", "--zone", "us-central1-a"]), undefined);
	assert.equal(checkReadOnly("az", ["network", "vnet", "show", "-g", "rg", "-n", "v"]), undefined);
	assert.ok(checkReadOnly("gcloud", ["compute", "instances", "delete", "describe"]));
	assert.ok(checkReadOnly("gcloud", ["run", "services", "update", "list"]));
	// Command groups that look like verbs are fine.
	assert.equal(checkReadOnly("gcloud", ["run", "services", "list", "--format=json"]), undefined);
	assert.equal(checkReadOnly("gcloud", ["deploy", "releases", "list"]), undefined);
	assert.equal(checkReadOnly("az", ["lock", "list"]), undefined);
	assert.ok(checkReadOnly("gcloud", ["run", "deploy", "svc", "list"]));
	assert.ok(checkReadOnly("az", ["vm", "start", "list"]));
});

test("dig deeper names the mapped folder so relative paths can be found", () => {
	const { digDeeperRequest } = require("../src/main/mapper/recipes/common");
	const text = digDeeperRequest("jobs", [{ label: "build", data: { mapRoot: "/repo", file: ".github/workflows/ci.yml" } }], "");
	assert.match(text, /made from "\/repo"; paths in the shapes' data are relative to it/);
});

test("diagram content ignores page view state and attribute order, not edits", () => {
	const { diagramContent } = require("../src/main/xmlContent");
	const a = '<mxfile><diagram id="p" name="P"><mxGraphModel dx="1" dy="2" grid="1"><root><mxCell id="0"/><mxCell id="x" value="A" vertex="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
	const b = '<mxfile><diagram name="P" id="p"><mxGraphModel grid="0" page="0"><root><mxCell id="0"/><mxCell parent="0" vertex="1" value="A" id="x"/></root></mxGraphModel></diagram></mxfile>';
	const edited = b.replace('value="A"', 'value="B"');
	assert.equal(diagramContent(a), diagramContent(b));
	assert.notEqual(diagramContent(a), diagramContent(edited));
});

test("Model architecture: a local model and a Hub id together are refused, not silently resolved", async () => {
	const { collectModel } = require("../src/main/mapper/recipes/ml/model");
	await assert.rejects(collectModel({ folder: "/tmp", hfModel: "gpt2" }, { progress: () => {}, signal: new AbortController().signal }), /either a local model .* or a Hugging Face model id, not both/);
});

test("database schema: an unticked Include views (explicit false) leaves views out", () => {
	const { isOn } = require("../src/main/mapper/recipes/database/connection");
	assert.equal(isOn("false", true), false);
	assert.equal(isOn(undefined, true), true);
	assert.equal(isOn("true", false), true);
});
