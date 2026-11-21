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
