// Runs inside a real VS Code extension host (see runVsCodeTests.js).
const vscode = require("vscode");
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EMPTY =
	'<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 30000) {
	const start = Date.now();
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await sleep(250);
	}
}

async function invoke(name, input) {
	const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
	return result.content.map((p) => p.value ?? "").join("");
}

const steps = [];
async function step(name, fn) {
	const start = Date.now();
	try {
		await fn();
		steps.push(`✔ ${name} (${Date.now() - start}ms)`);
	} catch (e) {
		steps.push(`✖ ${name}: ${e.message}`);
		throw e;
	}
}

exports.run = async function run() {
	try {
		await runSteps();
	} finally {
		console.log("\n" + steps.join("\n"));
	}
};

async function runSteps() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-it-"));
	const file = vscode.Uri.file(path.join(dir, "test.drawio"));
	fs.writeFileSync(file.fsPath, EMPTY);

	await step("contributes tools, participant commands and chat view", async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "vscode-drawio-ai");
		assert.ok(ext, "extension not found");
		await ext.activate();
		const names = vscode.lm.tools.map((t) => t.name);
		for (const n of [
			"drawio_get_diagram",
			"drawio_apply_operations",
			"drawio_find_cells",
			"drawio_select_cells",
			"drawio_render_image",
			"drawio_search_shapes",
			"drawio_style_reference",
			"drawio_get_xml",
		]) {
			assert.ok(names.includes(n), `tool ${n} not registered`);
		}
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["drawio-ai.openChat", "drawio-ai.askAboutSelection", "drawio-ai.lassoSelect", "drawio-ai.setApiKey"]) {
			assert.ok(commands.includes(c), `command ${c} missing`);
		}
		await vscode.commands.executeCommand("drawio-ai.openChat");
	});

	await step("tools report a missing diagram instead of failing", async () => {
		const text = await invoke("drawio_get_diagram", {});
		assert.match(text, /No draw.io diagram is open/);
	});

	await step("opens the diagram in the draw.io custom editor and reads it", async () => {
		await vscode.commands.executeCommand("vscode.openWith", file, "drawio-ai-text");
		const model = await waitFor(async () => {
			const text = await invoke("drawio_get_diagram", {});
			return text.startsWith("{") ? JSON.parse(text) : undefined;
		}, "draw.io + AI plugin to load", 60000);
		assert.equal(model.totalCells, 0);
		assert.equal(model.page.name, "Page-1");
	});

	let ids;
	await step("apply_operations edits the diagram and the change reaches the .drawio document", async () => {
		const result = JSON.parse(
			await invoke("drawio_apply_operations", {
				ops: [
					{ op: "addShape", tempId: "$web", label: "Web Server", x: 40, y: 40 },
					{ op: "addShape", tempId: "$db", label: "Orders DB", style: "shape=cylinder3;whiteSpace=wrap;html=1;", placement: { relativeTo: "$web", side: "right" } },
					{ op: "addEdge", source: "$web", target: "$db", label: "SQL" },
				],
			})
		);
		assert.equal(result.ok, true, JSON.stringify(result));
		ids = result.idMap;
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
		assert.ok(doc, "document not open");
		await waitFor(() => doc.getText().includes("Orders DB"), "document text to update");
	});

	await step("failed batch is rolled back and reports the error to the model", async () => {
		const result = JSON.parse(
			await invoke("drawio_apply_operations", {
				ops: [
					{ op: "addShape", label: "Ghost" },
					{ op: "update", id: "nope", label: "x" },
				],
			})
		);
		assert.equal(result.rolledBack, true);
		assert.match(result.failed[0].error, /Unknown cell id "nope"/);
		const model = JSON.parse(await invoke("drawio_get_diagram", {}));
		assert.ok(!model.cells.some((c) => c.label === "Ghost"));
	});

	await step("selection scope follows the editor selection", async () => {
		await invoke("drawio_select_cells", { ids: [ids.$db], reveal: false });
		const model = await waitFor(async () => {
			const m = JSON.parse(await invoke("drawio_get_diagram", { scope: "selection" }));
			return m.selection.length === 1 ? m : undefined;
		}, "selection to apply");
		assert.deepEqual(model.selection, [ids.$db]);
		assert.ok(model.cells.find((c) => c.id === ids.$web)?.context, "neighbour not included as context");
	});

	await step("find_cells, search_shapes, style_reference and get_xml answer", async () => {
		const found = JSON.parse(await invoke("drawio_find_cells", { query: "orders" }));
		assert.equal(found.matches[0].id, ids.$db);
		const shapes = JSON.parse(await invoke("drawio_search_shapes", { query: "aws lambda", limit: 3 }));
		assert.ok(shapes.shapes.some((s) => /mxgraph\.aws/.test(s.style)), JSON.stringify(shapes).slice(0, 300));
		assert.match(await invoke("drawio_style_reference", { topic: "edges" }), /orthogonalEdgeStyle/);
		assert.match(await invoke("drawio_get_xml", {}), /Orders DB/);
	});

	await step("ELK layout runs inside the webview", async () => {
		const result = JSON.parse(
			await invoke("drawio_apply_operations", { ops: [{ op: "layout", type: "hierarchical" }] })
		);
		assert.equal(result.ok, true, JSON.stringify(result));
		const model = JSON.parse(await invoke("drawio_get_diagram", {}));
		const web = model.cells.find((c) => c.id === ids.$web).geometry;
		const db = model.cells.find((c) => c.id === ids.$db).geometry;
		assert.ok(db.y > web.y, `expected top-down layout, got ${JSON.stringify({ web, db })}`);
	});

	await step("review: pending AI changes are kept or reverted with the Accept/Reject commands", async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes("drawio-ai.acceptChanges") && commands.includes("drawio-ai.rejectChanges"));
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const result = JSON.parse(
			await invoke("drawio_apply_operations", { ops: [{ op: "update", id: ids.$db, label: "Renamed DB" }] })
		);
		assert.match(result.note ?? "", /pending changes/, JSON.stringify(result));
		await vscode.commands.executeCommand("drawio-ai.rejectChanges");
		const model = await waitFor(async () => {
			const m = JSON.parse(await invoke("drawio_get_diagram", {}));
			return m.cells.find((c) => c.id === ids.$db)?.label === "Orders DB" ? m : undefined;
		}, "Reject to restore the label");
		assert.ok(model.cells.some((c) => c.label === "Web Server"), "accepted changes must survive the reject");
	});

	await step("render_image returns a PNG", async () => {
		const result = await vscode.lm.invokeTool("drawio_render_image", { input: {}, toolInvocationToken: undefined });
		const text = result.content.map((p) => p.value ?? "").join("");
		assert.match(text, /Rendered PNG attached/);
	});

	await step("v2 commands and tools are registered", async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["drawio-ai.markup", "drawio-ai.reviewDiagram", "drawio-ai.createTemplate", "drawio-ai.selectTemplate", "drawio-ai.diagramFromImage", "drawio-ai.diagramFromCode"]) {
			assert.ok(commands.includes(c), `command ${c} missing`);
		}
		const names = vscode.lm.tools.map((t) => t.name);
		assert.ok(names.includes("drawio_lint") && names.includes("drawio_get_template"));
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const lint = JSON.parse(await invoke("drawio_lint", {}));
		assert.equal(lint.template, null);
		assert.equal(typeof lint.issueCount, "number");
		assert.match(await invoke("drawio_get_template", {}), /No design template is active/);
	});

	await step("a design template created from an example diagram and a style guide drives lint", async () => {
		const example = path.join(dir, "example.drawio");
		fs.writeFileSync(
			example,
			'<mxfile><diagram name="x"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
				'<mxCell id="a" value="Service" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontFamily=Inter;" vertex="1" parent="1"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
				'<mxCell id="b" value="Store" style="shape=cylinder3;fillColor=#d5e8d4;strokeColor=#82b366;fontFamily=Inter;" vertex="1" parent="1"><mxGeometry x="200" width="80" height="80" as="geometry"/></mxCell>' +
				'<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
				"</root></mxGraphModel></diagram></mxfile>"
		);
		const guide = path.join(dir, "guide.md");
		fs.writeFileSync(guide, "# House style\n\nServices are blue rounded rectangles. Stores are green cylinders.\n");
		const t = await vscode.commands.executeCommand("drawio-ai.createTemplate", {
			name: "Team Style",
			sources: [example, guide],
			enforce: { palette: true, fonts: true, edges: true, title: false, legend: false },
			rules: "extracted",
			root: dir,
			silent: true,
		});
		assert.equal(t.id, "team-style");
		const folder = path.join(dir, ".drawio-ai/templates/team-style");
		assert.ok(fs.existsSync(path.join(folder, "sources/example.drawio")));
		assert.match(fs.readFileSync(path.join(folder, "rules.md"), "utf8"), /#dae8fc[\s\S]*Services are blue rounded rectangles/);
		const manifest = JSON.parse(fs.readFileSync(path.join(folder, "template.json"), "utf8"));
		assert.deepEqual(manifest.sources.map((s) => s.kind), ["diagram", "guide"]);

		const tpl = JSON.parse(await invoke("drawio_get_template", {}));
		assert.equal(tpl.name, "Team Style");
		assert.equal(tpl.profile.fonts[0].value, "Inter");
		const model = JSON.parse(await invoke("drawio_get_diagram", {}));
		assert.ok(model.notes.some((n) => /design template "Team Style" is active/.test(n)));

		const added = JSON.parse(await invoke("drawio_apply_operations", { ops: [{ op: "addShape", tempId: "$r", label: "Rogue", x: 600, y: 400, style: "rounded=1;fillColor=#ff0000;fontFamily=Comic Sans MS;" }] }));
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const lint = JSON.parse(await invoke("drawio_lint", { ids: [added.idMap.$r] }));
		assert.equal(lint.template, "Team Style");
		const rules = lint.issues.map((i) => i.rule);
		assert.ok(rules.includes("template-palette") && rules.includes("template-font"), JSON.stringify(lint));
		const issues = await vscode.commands.executeCommand("drawio-ai.reviewDiagram", { fix: "none" });
		assert.ok(issues.some((i) => i.rule === "template-palette" && i.cellIds.includes(added.idMap.$r)));
	});

	await step("diagram from code: SQL schema analysis and codeRef → code links", async () => {
		const sql = path.join(dir, "schema.sql");
		fs.writeFileSync(sql, "CREATE TABLE users (\n  id int primary key,\n  org_id int references orgs(id)\n);\n\nCREATE TABLE orgs (id int primary key);\n");
		const text = await vscode.commands.executeCommand("drawio-ai.diagramFromCode", { paths: [sql], kind: "erd", analyzeOnly: true });
		assert.match(text, /\(erd\): 2 entities, 1 relations/);
		assert.match(text, /"codeRef":"e1","kind":"table","name":"users"/);

		const r = JSON.parse(await invoke("drawio_apply_operations", { ops: [{ op: "addShape", tempId: "$u", label: "users", x: 40, y: 600, data: { codeRef: "e1" } }, { op: "addShape", tempId: "$o", label: "orgs", x: 300, y: 600 }] }));
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		// No model is available in the test host, so the AI request fails fast; linking still runs on what is on the page.
		await vscode.commands.executeCommand("drawio-ai.diagramFromCode", { paths: [sql], kind: "erd", target: "current" });
		const model = await waitFor(async () => {
			const m = JSON.parse(await invoke("drawio_get_diagram", {}));
			return m.cells.find((c) => c.id === r.idMap.$o)?.data?.hedietLinkedDataV1_path ? m : undefined;
		}, "shapes to be linked");
		const users = model.cells.find((c) => c.id === r.idMap.$u);
		assert.equal(users.data.codeRef, undefined, "codeRef is replaced by the link");
		assert.equal(users.data.hedietLinkedDataV1_path, "../schema.sql");
		assert.equal(users.data["hedietLinkedDataV1_start_line_x-num"], "0");
		assert.equal(users.data["hedietLinkedDataV1_end_line_x-num"], "3");
		const orgs = model.cells.find((c) => c.id === r.idMap.$o);
		assert.equal(orgs.data["hedietLinkedDataV1_start_line_x-num"], "5", "unreferenced shapes are linked by exact name");
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
	});

	await step("saving writes the AI edits to disk", async () => {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
		await doc.save();
		assert.match(fs.readFileSync(file.fsPath, "utf8"), /Orders DB/);
	});
}
