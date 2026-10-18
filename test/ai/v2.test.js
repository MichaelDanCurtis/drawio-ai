// Unit tests for the v2 building blocks: template profiles, lint, code analysis,
// and image/attachment handling in the agent loop.
// Run: node --test test/ai/v2.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");
const zlib = require("zlib");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = {
	id: "vscode",
	filename: "vscode",
	loaded: true,
	exports: { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } },
};

const src = (p) => path.resolve(__dirname, "../../src/features/ai", p);
const profile = require(src("templates/profile.ts"));
const { lintDiagram, formatIssues } = require(src("lint.ts"));
const code = require(src("codeAnalysis.ts"));
const { DiagramAgent } = require(src("DiagramAgent.ts"));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const compress = (xml) => zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");

const PAGE_A = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="t" value="Payments Architecture" style="text;fontSize=24;fontFamily=Inter;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="300" height="40" as="geometry"/></mxCell>
<mxCell id="a" value="API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#DAE8FC;strokeColor=#6c8ebf;fontFamily=Inter;fontSize=12;" vertex="1" parent="1"><mxGeometry x="0" y="80" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="Worker" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontFamily=Inter;fontSize=12;" vertex="1" parent="1"><mxGeometry x="200" y="80" width="120" height="60" as="geometry"/></mxCell>
<object label="Orders DB" id="d"><mxCell style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontFamily=Inter;" vertex="1" parent="1"><mxGeometry x="400" y="80" width="80" height="80" as="geometry"/></mxCell></object>
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#333333;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#333333;" edge="1" parent="1" source="b" target="d"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;

const PAGE_B = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="l" value="Legend" style="swimlane;fillColor=#f5f5f5;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="100" as="geometry"/></mxCell>
</root></mxGraphModel>`;

const DRAWIO = `<mxfile><diagram id="p1" name="A">${compress(PAGE_A)}</diagram><diagram id="p2" name="B">${PAGE_B}</diagram></mxfile>`;

const LIBRARY = `<mxlibrary>${JSON.stringify([
	{ xml: compress(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Queue" style="shape=mxgraph.aws4.sqs;fillColor=#E7157B;" vertex="1" parent="1"><mxGeometry width="60" height="60" as="geometry"/></mxCell></root></mxGraphModel>`), w: 60, h: 60, title: "Queue" },
	{ xml: `&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;&lt;mxCell id="2" value="Service" style="rounded=1;fillColor=#fff2cc;" vertex="1" parent="1"&gt;&lt;mxGeometry width="120" height="60" as="geometry"/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;`, w: 120, h: 60 },
])}</mxlibrary>`;

function zipStored(name, content, method = 0) {
	const data = Buffer.from(content);
	const body = method === 8 ? zlib.deflateRawSync(data) : data;
	const nameBuf = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt32LE(0, 42);
	const localPart = Buffer.concat([local, nameBuf, body]);
	const centralPart = Buffer.concat([central, nameBuf]);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

test("template profile: palette, fonts, edges, shapes, title/legend from compressed and plain pages", () => {
	const p = profile.extractProfile({ diagrams: [DRAWIO], libraries: [LIBRARY] });
	assert.equal(p.stats.diagrams, 2);
	assert.equal(p.colors.fill[0].value, "#dae8fc", "colours are normalised to lower case and counted");
	assert.equal(p.colors.fill[0].uses, 2);
	assert.ok(p.colors.fill.some((c) => c.value === "#e7157b"), "library colours are included");
	assert.equal(p.fonts[0].value, "Inter");
	assert.equal(p.edgeStyles[0].value, "edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1");
	const rounded = p.shapes.find((s) => s.role === "rounded rectangle");
	assert.equal(rounded.uses, 2);
	assert.equal(rounded.example, "API");
	assert.ok(p.shapes.some((s) => s.role === "cylinder3" && s.example === "Orders DB"), "object-wrapped cells keep their label");
	assert.deepEqual(p.library.map((l) => l.title), ["Queue", "Service"]);
	assert.equal(p.hasTitle, true);
	assert.equal(p.hasLegend, true);
});

test("template sources: .drawio.svg content, docx (stored and deflated) and pdf text", () => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${DRAWIO.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"><g/></svg>`;
	assert.equal(profile.diagramPages(svg).length, 2);

	const docXml = '<w:document><w:body><w:p><w:r><w:t>Use blue for services &amp; queues.</w:t></w:r></w:p><w:p><w:r><w:t>Title top-left.</w:t></w:r></w:p></w:body></w:document>';
	for (const method of [0, 8]) {
		const { text, warning } = profile.extractDocumentText("guide.docx", zipStored("word/document.xml", docXml, method));
		assert.equal(warning, undefined);
		assert.equal(text, "Use blue for services & queues.\nTitle top-left.");
	}

	const content = "BT /F1 12 Tf 72 712 Td (Services are blue rounded rectangles.) Tj 0 -14 Td (Databases are green cylinders \\(always\\).) Tj ET";
	const stream = zlib.deflateSync(Buffer.from(content, "latin1"));
	const pdf = Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		stream,
		Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
	]);
	const { text } = profile.extractDocumentText("guide.pdf", pdf);
	assert.match(text, /Services are blue rounded rectangles\./);
	assert.match(text, /Databases are green cylinders \(always\)\./);

	assert.match(profile.extractDocumentText("bad.pdf", Buffer.from("%PDF-1.4 nothing")).warning, /could not extract text/);
});

const template = () => {
	const p = profile.extractProfile({ diagrams: [DRAWIO], libraries: [] });
	const enforce = { palette: true, fonts: true, edges: true, title: true, legend: true };
	return {
		id: "payments",
		location: "/x",
		manifest: { version: 1, name: "Payments", sources: [], enforce, profile: p, createdAt: "" },
		rules: profile.draftRules("Payments", p, enforce),
	};
};

test("draft rules and the prompt section describe the template", () => {
	const t = template();
	assert.match(t.rules, /## Rules/);
	assert.match(t.rules, /#dae8fc/);
	assert.match(t.rules, /Every diagram has a legend/);
	const prompt = profile.describeTemplate(t);
	assert.match(prompt, /Active design template: "Payments"/);
	assert.match(prompt, /drawio_lint/);
	assert.match(prompt, /Fill palette: #dae8fc/);
	assert.doesNotMatch(prompt, /<!--/, "comments in rules.md are not sent to the model");
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

const cell = (id, extra) => ({ id, kind: "vertex", label: id.toUpperCase(), style: "rounded=1;", geometry: { x: 0, y: 0, width: 100, height: 50 }, ...extra });
const modelOf = (cells) => ({ page: { id: "p", name: "P", index: 0, count: 1 }, layers: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, selection: [], cells, truncated: false, totalCells: cells.length });

test("lint finds structural problems", () => {
	const issues = lintDiagram(
		modelOf([
			cell("a", { geometry: { x: 0, y: 0, width: 100, height: 50 } }),
			cell("b", { geometry: { x: 50, y: 10, width: 100, height: 50 } }),
			cell("c", { geometry: { x: 300, y: 3, width: 100, height: 50 } }),
			cell("box", { kind: "container", label: "Group", geometry: { x: 600, y: 0, width: 300, height: 200 } }),
			cell("inner", { parent: "box", geometry: { x: 10, y: 10, width: 50, height: 30 } }),
			cell("nolabel", { label: "", geometry: { x: 0, y: 400, width: 80, height: 40 } }),
			cell("tiny", { style: "text;fontSize=6;", geometry: { x: 0, y: 500, width: 80, height: 20 } }),
			{ id: "e1", kind: "edge", label: "", source: "a" },
			{ id: "e2", kind: "edge", label: "x", source: "a", target: "c" },
			{ id: "e3", kind: "edge", label: "x", source: "a", target: "c" },
		])
	);
	const rules = (r) => issues.filter((i) => i.rule === r);
	assert.deepEqual(rules("dangling-edge").map((i) => i.cellIds), [["e1"]]);
	assert.deepEqual(rules("duplicate-edge").map((i) => i.cellIds), [["e2", "e3"]]);
	assert.deepEqual(rules("overlap").map((i) => i.cellIds.sort()), [["a", "b"]], "containment is not an overlap");
	assert.ok(rules("misaligned").some((i) => i.cellIds.includes("c")), JSON.stringify(issues));
	assert.deepEqual(rules("unlabeled-shape").map((i) => i.cellIds), [["nolabel"]]);
	assert.deepEqual(rules("tiny-text").map((i) => i.cellIds), [["tiny"]]);
	assert.equal(rules("dangling-edge")[0].severity, "error");
	assert.match(formatIssues(issues), /^1\. \[error\] Connector/);
});

test("lint flags template violations: palette (with nearest colour), font, connectors, title, legend", () => {
	const issues = lintDiagram(
		modelOf([
			cell("ok", { style: "rounded=1;fillColor=#DAE8FC;strokeColor=#6c8ebf;fontFamily=Inter;" }),
			cell("red", { style: "rounded=1;fillColor=#ff0000;fontFamily=Comic Sans MS;", geometry: { x: 300, y: 0, width: 100, height: 50 } }),
			{ id: "e", kind: "edge", label: "", source: "ok", target: "red", style: "edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;" },
			{ id: "e2", kind: "edge", label: "", source: "red", target: "ok", style: "edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" },
		]),
		template()
	);
	const byRule = Object.fromEntries(issues.map((i) => [i.rule, i]));
	assert.match(byRule["template-palette"].message, /#ff0000 .*closest palette colour: #f8cecc|#ff0000/);
	assert.deepEqual(byRule["template-palette"].cellIds, ["red"]);
	assert.deepEqual(byRule["template-font"].cellIds, ["red"]);
	assert.deepEqual(byRule["template-edges"].cellIds, ["e"]);
	assert.ok(byRule["template-title"]);
	assert.ok(byRule["template-legend"]);
	assert.ok(!issues.some((i) => i.rule.startsWith("template") && i.cellIds.includes("ok")));
});

// ---------------------------------------------------------------------------
// code analysis
// ---------------------------------------------------------------------------

test("code → module dependencies resolves relative imports and finds cycles", () => {
	const a = code.analyze(
		[
			{ path: "src/a.ts", text: 'import { b } from "./b";\nimport x from "lodash";\nexport * from "./util/index.js";' },
			{ path: "src/b.ts", text: "const a = require('./a');\nimport('./lazy');" },
			{ path: "src/lazy.tsx", text: "export const lazy = 1;" },
			{ path: "src/util/index.ts", text: "export {};" },
			{ path: "pkg/mod.py", text: "from . import helpers\nfrom pkg.helpers import x\nimport os" },
			{ path: "pkg/helpers.py", text: "" },
		],
		"dependencies"
	);
	const rel = a.relations.map((r) => `${r.from.slice(4)}→${r.to.slice(4)}`).sort();
	assert.deepEqual(rel, ["pkg/mod.py→pkg/helpers.py", "src/a.ts→src/b.ts", "src/a.ts→src/util/index.ts", "src/b.ts→src/a.ts", "src/b.ts→src/lazy.tsx"]);
	assert.match(a.notes.join("\n"), /Import cycles: src\/a\.ts → src\/b\.ts → src\/a\.ts|Import cycles: src\/b\.ts → src\/a\.ts → src\/b\.ts/);
	assert.match(a.notes.join("\n"), /lodash \(1\)/);
	assert.equal(a.entities.find((e) => e.file === "src/util/index.ts").group, "src/util");
});

test("code → class diagram for TypeScript, Java, C#, Python and Go", () => {
	const a = code.analyze(
		[
			{
				path: "shapes.ts",
				text: `export interface Shape { area(): number; }\nexport abstract class Base implements Shape {\n  protected name: string;\n  private cache?: Map<string, number>;\n  area(): number { if (x) { return 1; } return 0; }\n}\nexport class Circle extends Base {\n  radius = 1;\n  owner: Owner;\n  constructor(r: number) { super(); }\n}\nclass Owner {}\nenum Color { Red, Green = 2 }\n`,
			},
			{ path: "Repo.java", text: "public class UserRepo extends BaseRepo implements Repo<User> {\n  private final DataSource ds;\n  public User find(String id) { return null; }\n}\ninterface Repo<T> {}\nclass BaseRepo {}\n" },
			{ path: "Svc.cs", text: "public sealed class Svc : BaseSvc, ISvc\n{\n    public int Count { get; set; }\n    public void Run(int n) { }\n}\npublic interface ISvc {}\npublic class BaseSvc {}\n" },
			{ path: "models.py", text: "class Animal:\n    def __init__(self, name):\n        self.name = name\n    def speak(self):\n        pass\n\nclass Dog(Animal):\n    def _wag(self):\n        pass\n" },
			{ path: "store.go", text: "package store\n\ntype Store interface {\n\tGet(k string) string\n}\n\ntype Mem struct {\n\tBase\n\tdata map[string]string\n}\n\ntype Base struct{}\n\nfunc (m *Mem) Get(k string) string { return m.data[k] }\n" },
		],
		"classes"
	);
	const names = a.entities.map((e) => e.name).sort();
	assert.deepEqual(names, ["Animal", "Base", "Base", "BaseRepo", "BaseSvc", "Circle", "Color", "Dog", "ISvc", "Mem", "Owner", "Repo", "Shape", "Store", "Svc", "UserRepo"].sort());
	const rel = new Set(a.relations.map((r) => `${r.from.slice(5)} ${r.kind} ${r.to.slice(5)}`));
	for (const r of ["Base implements Shape", "Circle extends Base", "Circle association Owner", "UserRepo extends BaseRepo", "UserRepo implements Repo", "Svc extends BaseSvc", "Svc implements ISvc", "Dog extends Animal", "Mem extends Base@store.go"]) {
		assert.ok(rel.has(r), `missing relation "${r}" in ${[...rel].join(", ")}`);
	}
	const base = a.entities.find((e) => e.name === "Base");
	assert.deepEqual(base.details, ["#name: string", "-cache: Map<string, number>", "+area(): number"]);
	assert.equal(base.line, 2);
	assert.equal(base.endLine, 6);
	assert.deepEqual(a.entities.find((e) => e.name === "Color").details, ["Red", "Green"]);
	assert.deepEqual(a.entities.find((e) => e.name === "Animal").details, ["+name", "+__init__(name)", "+speak()"]);
	assert.deepEqual(a.entities.find((e) => e.name === "Mem").details, ["-data: map[string]string", "+Get()"]);
	assert.ok(a.entities.find((e) => e.name === "UserRepo").details.includes("+find(id): User"));
});

test("code → ERD from SQL DDL and Prisma", () => {
	const a = code.analyze(
		[
			{
				path: "schema.sql",
				text: `CREATE TABLE IF NOT EXISTS public.orgs (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(100) NOT NULL\n);\nCREATE TABLE "users" (\n  id integer,\n  org_id integer REFERENCES orgs(id),\n  email text, -- comment, with comma\n  PRIMARY KEY (id)\n);\nCREATE TABLE posts (id int primary key, author_id int, CONSTRAINT fk FOREIGN KEY (author_id) REFERENCES users (id));\nALTER TABLE posts ADD CONSTRAINT x FOREIGN KEY (id) REFERENCES orgs(id);`,
			},
			{ path: "prisma/schema.prisma", text: "model Account {\n  id    Int    @id @default(autoincrement())\n  user  Profile @relation(fields: [userId], references: [id])\n  userId Int @unique\n}\nmodel Profile {\n  id Int @id\n  accounts Account[]\n}\n" },
		],
		"erd"
	);
	assert.deepEqual(a.entities.map((e) => e.name), ["orgs", "users", "posts", "Account", "Profile"]);
	assert.deepEqual(a.entities.find((e) => e.name === "users").details, ["PK id: integer", "FK org_id: integer → orgs.id", "email: text"]);
	assert.deepEqual(a.entities.find((e) => e.name === "orgs").details, ["PK id: SERIAL", "name: VARCHAR(100)"]);
	const rel = a.relations.map((r) => `${r.from.slice(6)}→${r.to.slice(6)}:${r.label}`).sort();
	assert.deepEqual(rel, ["Account→Profile:userId", "posts→orgs:id", "posts→users:author_id", "users→orgs:org_id"]);
});

test("code → infrastructure from Terraform, docker-compose and Kubernetes", () => {
	const a = code.analyze(
		[
			{ path: "main.tf", text: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "a" {\n  vpc_id = aws_vpc.main.id\n}\nmodule "db" {\n  source = "./db"\n  subnet = aws_subnet.a.id\n}\n' },
			{ path: "docker-compose.yml", text: "services:\n  web:\n    build: .\n    ports: ['8080:80']\n    depends_on: [db]\n  db:\n    image: postgres:16\n" },
			{
				path: "k8s.yaml",
				text: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n  template:\n    metadata:\n      labels: {app: api}\n    spec:\n      containers:\n        - name: api\n          image: api:1\n          envFrom: [{configMapRef: {name: api-config}}]\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api-svc\nspec:\n  selector: {app: api}\n  ports: [{port: 80}]\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\nspec:\n  rules:\n    - http:\n        paths:\n          - path: /\n            backend: {service: {name: api-svc, port: {number: 80}}}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: api-config\n",
			},
		],
		"infrastructure"
	);
	const rel = new Set(a.relations.map((r) => `${r.from} ${r.kind} ${r.to}`));
	for (const r of [
		"tf:aws_subnet.a references tf:aws_vpc.main",
		"tf:module.db references tf:aws_subnet.a",
		"svc:web depends on svc:db",
		"k8s:default/Deployment/api uses k8s:default/ConfigMap/api-config",
		"k8s:default/Service/api-svc selects k8s:default/Deployment/api",
		"k8s:default/Ingress/web routes to k8s:default/Service/api-svc",
	]) {
		assert.ok(rel.has(r), `missing "${r}" in ${[...rel].join(" | ")}`);
	}
	const api = a.entities.find((e) => e.id === "k8s:default/Deployment/api");
	assert.equal(api.line, 4);
	assert.deepEqual(api.details, ["container api: api:1", "replicas: 2"]);
	assert.equal(a.entities.find((e) => e.id === "svc:web").line, 2);
});

test("code analysis never executes code embedded in YAML (js-yaml !!js/function)", () => {
	globalThis.__yamlPwned = false;
	const a = code.analyze(
		[{ path: "docker-compose.yml", text: 'services:\n  web:\n    image: { toString: !!js/function "function(){ globalThis.__yamlPwned = true; return 1 }" }\n' }],
		"infrastructure"
	);
	JSON.stringify(a);
	code.formatAnalysis(a);
	assert.equal(globalThis.__yamlPwned, false);
	assert.match(a.notes[0], /YAML parse error \(unknown tag/);
});

test("code analysis: kind detection, aggregation of large trees, and the prompt payload", () => {
	assert.equal(code.detectKind([{ path: "a.sql", text: "" }]), "erd");
	assert.equal(code.detectKind([{ path: "x.yaml", text: "kind: Service\n" }]), "infrastructure");
	assert.equal(code.detectKind([{ path: "a.ts", text: "" }]), "classes");

	const many = Array.from({ length: 70 }, (_, i) => ({
		path: `${i < 35 ? "core" : "ui"}/m${i}.ts`,
		text: i >= 35 ? `import "../core/m${i - 35}";` : "",
	}));
	const agg = code.analyze(many, "dependencies");
	assert.deepEqual(agg.entities.map((e) => e.id), ["dir:core", "dir:ui"]);
	assert.deepEqual(agg.relations, [{ from: "dir:ui", to: "dir:core", kind: "imports", label: "35" }]);

	const text = code.formatAnalysis(agg);
	assert.match(text, /How to draw it: Draw a module dependency diagram/);
	assert.match(text, /"codeRef":"e1"/);
	assert.match(text, /"from":"e2","to":"e1"/);
	assert.equal(code.codeRefs(agg).get("e2").name, "ui");
});

// ---------------------------------------------------------------------------
// agent: images, attachments, template system prompt
// ---------------------------------------------------------------------------

function recordingClient(vision) {
	const requests = [];
	return {
		requests,
		providerId: "anthropic",
		model: { id: "m", name: "Model M", vision },
		async *stream(req) {
			requests.push(JSON.parse(JSON.stringify(req)));
			yield { type: "text", text: "ok" };
		},
	};
}
const toolbox = { specs: () => [], invoke: async () => ({ text: "", summary: "" }) };
const noopSink = { text() {}, toolStart() {}, toolEnd() {} };
const tok = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

test("agent sends images, attachments and the template section; older ones are compacted", async () => {
	const client = recordingClient(true);
	const agent = new DiagramAgent(toolbox);
	const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
	const first = await agent.run({
		client, history: [], userText: "convert", context: "ctx", sink: noopSink, token: tok, maxRounds: 2,
		systemExtra: "## Active design template", images: [image], attachments: [{ name: "code", text: "x".repeat(5000) }],
	});
	const req = client.requests[0];
	assert.match(req.system, /You are Draw\.io AI[\s\S]*## Active design template$/);
	const parts = req.messages[0].parts;
	assert.deepEqual(parts.map((p) => p.type), ["text", "text", "image"]);
	assert.match(parts[1].text, /^<attachment name="code">\n/);
	assert.deepEqual(parts[2].image, image);

	let history = first.messages;
	for (let i = 0; i < 3; i++) history = [...history, ...(await agent.run({ client, history, userText: `more ${i}`, context: "", sink: noopSink, token: tok, maxRounds: 2 })).messages];
	const old = client.requests.at(-1).messages[0].parts;
	assert.equal(old[2].type, "text");
	assert.match(old[2].text, /image from an earlier turn omitted/);
	assert.ok(old[1].text.length < 1700 && old[1].text.endsWith("</attachment>"));
});

test("agent refuses images for models without vision", async () => {
	const agent = new DiagramAgent(toolbox);
	const client = recordingClient(false);
	const { error, messages } = await agent.run({
		client, history: [], userText: "x", context: "", sink: noopSink, token: tok, maxRounds: 2,
		images: [{ mimeType: "image/png", base64: "AA==" }],
	});
	assert.match(String(error.message), /Model M cannot read images/);
	assert.equal(messages.length, 0);
	assert.equal(client.requests.length, 0);
});
