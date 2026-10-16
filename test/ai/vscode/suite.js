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

	await step("render_image returns a PNG", async () => {
		const result = await vscode.lm.invokeTool("drawio_render_image", { input: {}, toolInvocationToken: undefined });
		const text = result.content.map((p) => p.value ?? "").join("");
		assert.match(text, /Rendered PNG attached/);
	});

	await step("saving writes the AI edits to disk", async () => {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
		await doc.save();
		assert.match(fs.readFileSync(file.fsPath, "utf8"), /Orders DB/);
	});
}
