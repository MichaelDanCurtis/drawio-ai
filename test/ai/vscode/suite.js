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
	console.log(`▶ ${name}`); // shows which step is running if the suite hangs
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
		// runVsCodeTests.js runs the suite twice: without a folder, then the agent steps in a workspace folder.
		if (process.env.DRAWIO_AI_IT_PART === "agents") await agentSuite();
		else await runSteps();
	} finally {
		console.log("\n" + steps.join("\n"));
	}
};

async function runSteps() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-it-"));
	const file = vscode.Uri.file(path.join(dir, "test.drawio"));
	fs.writeFileSync(file.fsPath, EMPTY);

	await step("contributes tools, participant commands and chat view", async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "draw-ai");
		assert.ok(ext, "extension not found");
		await ext.activate();
		const names = vscode.lm.tools.map((t) => t.name);
		for (const n of [
			"drawio_get_diagram",
			"drawio_apply_operations",
			"drawio_find_cells",
			"drawio_select_cells",
			"drawio_pages",
			"drawio_render_image",
			"drawio_search_shapes",
			"drawio_style_reference",
			"drawio_get_xml",
			"drawio_export",
			"drawio_import",
			"drawio_get_attachment",
			"drawio_list_diagrams",
			"drawio_search_diagrams",
			"drawio_create",
		]) {
			assert.ok(names.includes(n), `tool ${n} not registered`);
		}
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["drawio-ai.openChat", "drawio-ai.askAboutSelection", "drawio-ai.lassoSelect", "drawio-ai.exportPdf", "drawio-ai.connectAgents", "drawio-ai.disconnectAgents"]) {
			assert.ok(commands.includes(c), `command ${c} missing`);
		}
		await vscode.commands.executeCommand("drawio-ai.openChat");
	});

	await step("the Draw.AI sidebar: its view opens, and a diagram opens from it in Draw.AI", async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["workbench.view.extension.drawio-ai", "drawio-ai.sidebar.open", "drawio-ai.sidebar.openToSide", "drawio-ai.sidebar.refresh", "drawio-ai.sidebar.reveal"]) {
			assert.ok(commands.includes(c), `command ${c} missing`);
		}
		await vscode.commands.executeCommand("workbench.view.extension.drawio-ai");
		await vscode.commands.executeCommand("drawio-ai.sidebar.refresh");
		await vscode.commands.executeCommand("drawio-ai.sidebar.open", file);
		const tab = await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === file.toString()), "the diagram to open from the sidebar");
		assert.equal(tab.input.viewType, "drawio-ai-text");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	});

	await step("tools report a missing diagram instead of failing", async () => {
		const text = await invoke("drawio_get_diagram", {});
		assert.match(text, /No draw.io diagram is open/);
	});

	await step("Open Visio File as Draw.io: converts in a temporary draw.io webview, opens the result, never overwrites", async () => {
		const fixtures = path.join(__dirname, "../fixtures");
		fs.copyFileSync(path.join(fixtures, "import.vsdx"), path.join(dir, "network.vsdx"));
		fs.copyFileSync(path.join(fixtures, "import.gliffy"), path.join(dir, "flow.gliffy"));
		fs.copyFileSync(path.join(fixtures, "import.graphml"), path.join(dir, "services.graphml"));
		fs.copyFileSync(path.join(fixtures, "import-lucidchart.json"), path.join(dir, "signup.json"));
		fs.copyFileSync(path.join(fixtures, "import-miro.json"), path.join(dir, "board.json"));
		fs.copyFileSync(path.join(fixtures, "import.csv"), path.join(dir, "team.csv"));
		const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
		const vsdx = vscode.Uri.file(path.join(dir, "network.vsdx"));

		// No diagram is open yet, so draw.io runs in a webview of its own.
		const first = await vscode.commands.executeCommand("drawio-ai.openVisio", vsdx);
		assert.deepEqual(first.failed, []);
		assert.equal(path.basename(first.converted[0].target.fsPath), "network.drawio");
		assert.deepEqual([first.converted[0].pages, first.converted[0].warnings], [2, []]);
		const converted = path.join(dir, "network.drawio");
		const text = fs.readFileSync(converted, "utf8");
		assert.match(text, /<diagram name="Architecture"[\s\S]*Web App[\s\S]*<diagram name="Notes"/);
		const tab = await waitFor(
			() => tabs().find((t) => t.input instanceof vscode.TabInputCustom && path.basename(t.input.uri.fsPath) === "network.drawio"),
			"the converted diagram to open"
		);
		assert.equal(tab.input.viewType, "drawio-ai-text");
		assert.ok(!tabs().some((t) => t.input instanceof vscode.TabInputWebview && /drawio-ai\.converter/.test(t.input.viewType)), "the converter webview is closed");

		// Converting again, with a diagram open, never replaces the first result and leaves the open editor alone.
		const second = await vscode.commands.executeCommand("drawio-ai.openVisio", vsdx);
		assert.equal(path.basename(second.converted[0].target.fsPath), "network-2.drawio");
		assert.equal(fs.readFileSync(converted, "utf8"), text);
		assert.ok(!tabs().some((t) => t.input instanceof vscode.TabInputWebview && /drawio-ai\.converter/.test(t.input.viewType)), "the converter webview is closed");

		const graphml = await vscode.commands.executeCommand("drawio-ai.importDiagram", vscode.Uri.file(path.join(dir, "services.graphml")));
		assert.deepEqual([graphml.failed, graphml.converted[0].format], [[], "graphml"]);
		fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
		const bad = await vscode.commands.executeCommand("drawio-ai.importDiagram", vscode.Uri.file(path.join(dir, "notes.txt")));
		assert.equal(bad.converted.length, 0);
		assert.match(bad.failed[0].error, /not a file draw\.io can convert/);

		await sleep(1000);
		assert.ok(!tabs().some((t) => t.isDirty), "opening a converted diagram leaves it unchanged");
		await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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

	await step("the editor has the desktop app's tools and look, and presentation mode starts and leaves", async () => {
		// (the tools are draw.io plugins loaded from the extension's folder: the modules and
		// fonts they load themselves only work if the webview may read that folder)
		const look = () => vscode.commands.executeCommand("drawio-ai.editorLookState");
		const state = await waitFor(async () => {
			const s = await look();
			return s && s.matrixMounted && s.formatDots ? s : undefined;
		}, "the editor tools, the matrix and the dot field");
		assert.equal(state.host, "vscode");
		assert.equal(state.themed, true);
		assert.equal(state.tips, true);
		assert.deepEqual(state.buttons, { mark: true, shapes: true, panels: 3, ruler: true, present: true, workshop: true, chat: false });
		assert.equal(state.icons, "dots2d");

		// a setting changes the open editor (it is not loaded again: the plugin answers with the new style)
		const config = vscode.workspace.getConfiguration("drawio-ai");
		await config.update("look.icons", "classic", vscode.ConfigurationTarget.Global);
		await waitFor(async () => ((await look())?.icons === "classic" ? true : undefined), "the icon style to change");
		await config.update("look.icons", undefined, vscode.ConfigurationTarget.Global);
		await waitFor(async () => ((await look())?.icons === "dots2d" ? true : undefined), "the icon style to change back");

		await vscode.commands.executeCommand("drawio-ai.present");
		await waitFor(async () => ((await look())?.presenting ? true : undefined), "presentation mode to start");
		await vscode.commands.executeCommand("drawio-ai.present");
		await waitFor(async () => ((await look())?.presenting === false ? true : undefined), "presentation mode to end");
		// presenting changes nothing in the diagram
		assert.equal(JSON.parse(await invoke("drawio_get_diagram", {})).totalCells, 0);
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

	await step("drawio_export writes a Visio file next to the diagram and never overwrites unasked", async () => {
		const result = JSON.parse(await invoke("drawio_export", { format: "vsdx" }));
		assert.equal(result.path.split(/[\\/]/).pop(), "test.vsdx");
		assert.equal(result.pages, 1);
		assert.ok(result.shapes >= 2 && result.connectors >= 1, JSON.stringify(result));
		const bytes = fs.readFileSync(path.join(dir, "test.vsdx"));
		assert.equal(bytes.readUInt32LE(0), 0x04034b50, "not a ZIP package");
		assert.ok(bytes.includes(Buffer.from("visio/pages/page1.xml")));
		assert.match(await invoke("drawio_export", { format: "vsdx" }), /already exists/);
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes("drawio-ai.exportVisio"));
	});

	await step("drawio_import converts Gliffy, Lucidchart, Miro and CSV files next to the open diagram without switching to them", async () => {
		const gliffy = JSON.parse(await invoke("drawio_import", { path: "flow.gliffy", open: false }));
		assert.equal(path.basename(gliffy.path), "flow.drawio");
		assert.deepEqual([gliffy.format, gliffy.pages, gliffy.connectors, gliffy.opened], ["gliffy", 1, 1, false]);
		assert.match(gliffy.warnings.join(" "), /has no mapping/);
		const lucid = JSON.parse(await invoke("drawio_import", { path: "signup.json", open: false }));
		assert.equal(lucid.format, "lucidchart");
		assert.match(lucid.warnings.join(" "), /QuantumFluxCapacitorBlock/);
		assert.match(fs.readFileSync(path.join(dir, "signup.drawio"), "utf8"), /<diagram name="Signup flow"/);
		const miro = JSON.parse(await invoke("drawio_import", { path: "board.json", open: false }));
		assert.deepEqual([miro.format, miro.shapes, miro.connectors], ["miro", 3, 1]);
		// CSV is laid out in the conversion panel's own editor, never in the open diagram.
		const csv = JSON.parse(await invoke("drawio_import", { path: "team.csv", open: false }));
		assert.deepEqual([csv.format, csv.shapes, csv.connectors, csv.warnings], ["csv", 4, 3, []]);
		assert.match(fs.readFileSync(path.join(dir, "team.drawio"), "utf8"), /name="Margaret"/);
		assert.match(await invoke("drawio_import", { path: "../elsewhere.vsdx" }), /inside the diagram's folder/);
		assert.match(await invoke("drawio_import", { path: "missing.vsdx" }), /missing\.vsdx was not found/);
		// The other tools still work on the diagram that was open.
		assert.match(await invoke("drawio_get_xml", {}), /Orders DB/);
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes("drawio-ai.openVisio") && commands.includes("drawio-ai.importDiagram"));
	});

	await step("VS Code's chat gets the Draw.AI agent (with resolvable tool names) and the diagram instructions", async () => {
		const listed = JSON.stringify(await vscode.commands.executeCommand("_listExtensionPromptFiles"));
		assert.ok(listed.includes("draw-ai.agent.md"), `agent not registered: ${listed.slice(0, 400)}`);
		assert.ok(listed.includes("drawio.instructions.md"), "instructions not registered");

		// VS Code validates agent files; a broken copy proves the check runs, then ours must pass it.
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "draw-ai");
		const agentUri = vscode.Uri.joinPath(ext.extensionUri, "media/chat/draw-ai.agent.md");
		const bad = vscode.Uri.file(path.join(dir, "broken.agent.md"));
		const ours = fs.readFileSync(agentUri.fsPath, "utf8");
		fs.writeFileSync(bad.fsPath, ours.replace("/drawio-lint", "/drawio-no-such-tool"));
		const problems = async (uri) => {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
			await sleep(3000);
			return vscode.languages.getDiagnostics(uri).map((d) => d.message);
		};
		const badProblems = await waitFor(async () => {
			const p = await problems(bad);
			return p.some((m) => m.includes("drawio-no-such-tool")) ? p : undefined;
		}, "VS Code to flag an unknown tool in an agent file", 20000);
		assert.ok(badProblems.length > 0);
		const ourProblems = (await problems(agentUri)).filter((m) => /drawio/i.test(m));
		assert.deepEqual(ourProblems, [], "the Draw.AI agent names tools VS Code does not know");
		// Close only what this step opened: the diagram has unsaved edits later steps need.
		const opened = new Set([bad.toString(), agentUri.toString()]);
		const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input?.uri && opened.has(t.input.uri.toString()));
		await vscode.window.tabGroups.close(tabs);
		await vscode.commands.executeCommand("vscode.openWith", file, "drawio-ai-text");
		const commands = await vscode.commands.getCommands(true);
		for (const gone of ["drawio-ai.openChatPanel", "drawio-ai.newChat", "drawio-ai.selectModel", "drawio-ai.setApiKey"]) {
			assert.ok(!commands.includes(gone), `${gone} should be gone with the chat panel`);
		}
		assert.match(await invoke("drawio_get_attachment", { id: "../../secrets" }), /not an attachment id/);
	});

	await step("v2 commands and tools are registered", async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["drawio-ai.markup", "drawio-ai.reviewDiagram", "drawio-ai.createTemplate", "drawio-ai.selectTemplate", "drawio-ai.diagramFromImage", "drawio-ai.diagramFromCode", "drawio-ai.checkCodeLinks"]) {
			assert.ok(commands.includes(c), `command ${c} missing`);
		}
		const names = vscode.lm.tools.map((t) => t.name);
		assert.ok(names.includes("drawio_lint") && names.includes("drawio_get_template") && names.includes("drawio_code_links"));
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

	await step("live code links: moved and changed code is detected, refresh re-points links", async () => {
		const sql = path.join(dir, "schema.sql");
		const report = async (input = {}) => JSON.parse(await invoke("drawio_code_links", input));
		let r = await report();
		assert.equal(r.linked, 2);
		assert.equal(r.problems, 0, JSON.stringify(r));

		fs.writeFileSync(sql, "-- v2\n-- moved down\n" + fs.readFileSync(sql, "utf8"));
		r = await report();
		assert.deepEqual(r.links.map((l) => l.status), ["moved", "moved"], JSON.stringify(r));
		const users = r.links.find((l) => l.label === "users");

		r = await report({ refresh: r.links.map((l) => l.id) });
		assert.equal(r.refreshed.updated.length, 2);
		assert.equal(r.problems, 0);
		const model = JSON.parse(await invoke("drawio_get_diagram", {}));
		assert.equal(model.cells.find((c) => c.id === users.id).data["hedietLinkedDataV1_start_line_x-num"], "2");

		fs.writeFileSync(sql, fs.readFileSync(sql, "utf8").replace("org_id int references orgs(id)", "org_id int references orgs(id),\n  email text"));
		r = await report({ ids: [users.id] });
		assert.equal(r.links[0].status, "changed");
		assert.match(r.links[0].currentCode, /email text/);

		fs.writeFileSync(sql, "CREATE TABLE orgs (id int primary key);\n");
		r = await report();
		assert.equal(r.links.find((l) => l.id === users.id).status, "missing-code");
		fs.unlinkSync(sql);
		r = await report();
		assert.deepEqual(r.links.map((l) => l.status), ["missing-file", "missing-file"]);
	});

	await step("MCP server: an external agent reads and edits the open diagram", async () => {
		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("port", 0, vscode.ConfigurationTarget.Global);
		const info = await vscode.commands.executeCommand("drawio-ai.mcpSetup", { enable: true, show: false });
		assert.equal(info.running, true);
		assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		assert.match(info.claudeCommand, /^claude mcp add --transport http drawio http:\/\/127\.0\.0\.1:\d+\/mcp --header "Authorization: Bearer [0-9a-f]{48}"$/);
		const rpc = async (id, method, params) => {
			const r = await fetch(info.url, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${info.token}` },
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			});
			assert.equal(r.status, 200);
			return (await r.json()).result;
		};
		const init = await rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "it", version: "1" } });
		assert.match(init.instructions, /the diagram the user has open/);
		assert.match(init.instructions, /Active design template: "Team Style"/);
		const tools = (await rpc(2, "tools/list")).tools.map((t) => t.name);
		assert.ok(tools.includes("drawio_apply_operations") && tools.includes("drawio_code_links"));

		const edit = await rpc(3, "tools/call", { name: "drawio_apply_operations", arguments: { ops: [{ op: "addShape", label: "From MCP", x: 40, y: 800 }] } });
		assert.equal(edit.isError, false, JSON.stringify(edit));
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const read = await rpc(4, "tools/call", { name: "drawio_find_cells", arguments: { query: "From MCP" } });
		assert.equal(JSON.parse(read.content[0].text).total, 1);

		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", false, vscode.ConfigurationTarget.Global);
		await waitFor(async () => fetch(info.url, { method: "POST" }).then(() => false, () => true), "server to stop");
	});

	await step("drawio_pages: the AI adds a page, reads the other one without switching, uses layers; Reject removes its page", async () => {
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const pages = async (input) => {
			const text = await invoke("drawio_pages", input);
			assert.ok(text.startsWith("{"), text);
			return JSON.parse(text);
		};
		let r = await pages({ action: "list" });
		assert.deepEqual(r.pages.map((p) => [p.name, p.current]), [["Page-1", true]]);
		const first = r.pages[0].id;

		r = await pages({ action: "add", name: "Details" });
		assert.deepEqual([r.page.name, r.page.current], ["Details", true]);
		const edit = JSON.parse(
			await invoke("drawio_apply_operations", {
				ops: [
					{ op: "addLayer", tempId: "$notes", name: "Notes" },
					{ op: "addShape", label: "Queue", x: 40, y: 40, parent: "$notes" },
				],
			})
		);
		assert.equal(edit.ok, true, JSON.stringify(edit));
		const shown = JSON.parse(await invoke("drawio_get_diagram", {}));
		assert.deepEqual([shown.page.name, shown.layers.map((l) => l.name)], ["Details", ["", "Notes"]]);

		const other = JSON.parse(await invoke("drawio_get_diagram", { page: first }));
		assert.equal(other.page.current, false);
		assert.ok(other.cells.some((c) => c.label === "Orders DB"));
		assert.equal(JSON.parse(await invoke("drawio_find_cells", { query: "orders", page: "Page-1" })).total, 1);
		assert.equal(typeof JSON.parse(await invoke("drawio_lint", { page: "Page-1" })).issueCount, "number");
		assert.equal((await pages({ action: "list" })).pages.find((p) => p.current).name, "Details", "reading another page does not switch");

		// A page the AI added in this review is deleted without asking the user.
		r = await pages({ action: "duplicate", page: "Details", select: false });
		assert.deepEqual([r.page.name, r.page.cells], ["Copy of Details", 1]);
		r = await pages({ action: "delete", page: "Copy of Details" });
		assert.equal(r.pages.length, 2);

		await vscode.commands.executeCommand("drawio-ai.rejectChanges");
		r = await waitFor(async () => {
			const list = await pages({ action: "list" });
			return list.pages.length === 1 ? list : undefined;
		}, "Reject to remove the AI's page");
		assert.deepEqual(r.pages.map((p) => [p.id, p.current]), [[first, true]]);
		assert.match(await invoke("drawio_get_xml", {}), /Orders DB/);
	});

	await step("saving writes the AI edits to disk", async () => {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
		await doc.save();
		assert.match(fs.readFileSync(file.fsPath, "utf8"), /Orders DB/);
	});

	await step("drawio_import opens the new diagram, and the next tool calls work on it", async () => {
		const r = JSON.parse(await invoke("drawio_import", { path: "services.graphml" }));
		assert.deepEqual([r.opened, r.openError], [true, undefined]);
		assert.equal(path.basename(r.path), "services-2.drawio");
		const xml = await invoke("drawio_get_xml", {});
		assert.match(xml, /Order Service/);
		assert.doesNotMatch(xml, /Orders DB/);
	});

	await step("the Mapper: maps a folder into the diagram, its tools answer, the Maps view lists findings and tours, and a tour plays", async () => {
		const names = vscode.lm.tools.map((t) => t.name);
		for (const n of ["mapper_maps", "mapper_list_recipes", "mapper_run", "mapper_find", "mapper_show", "mapper_path", "mapper_findings", "mapper_worksheet", "mapper_set_descriptions", "mapper_recent_changes", "mapper_refresh", "mapper_set_tour", "mapper_answer"]) {
			assert.ok(names.includes(n), `tool ${n} not registered`);
		}
		// (as VS Code's chat and the MCP server call them; running a map through the chat asks the user first)
		const tool = async (name, args = {}) => {
			const r = await vscode.commands.executeCommand("drawio-ai.maps.tool", { name, args });
			assert.ok(!r.isError, `${name}: ${r.text}`);
			return JSON.parse(r.text);
		};
		const mapsState = () => vscode.commands.executeCommand("drawio-ai.maps.state");
		const look = () => vscode.commands.executeCommand("drawio-ai.editorLookState");

		// A small repository under git, from the desktop app's software fixture.
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-map-"));
		fs.cpSync(path.join(__dirname, "../../../standalone/test/fixtures/software/shop"), repo, { recursive: true });
		const git = (...args) => require("child_process").execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", ...args], { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "initial");

		assert.deepEqual(JSON.parse(await invoke("mapper_maps", {})).maps, []);
		assert.ok(JSON.parse(await invoke("mapper_list_recipes", { category: "software" })).some((r) => r.id === "software.connectivity"));
		assert.match((await vscode.commands.executeCommand("drawio-ai.maps.tool", { name: "mapper_run", args: { recipe: "nope" } })).text, /Unknown map nope/);

		const run = await tool("mapper_run", { recipe: "software.connectivity", input: { folder: repo } });
		const mapId = run.map.id;
		assert.ok(run.map.shapes > 3, JSON.stringify(run.map));
		assert.ok(run.drawnOn, "the map was not drawn");
		// the record is next to the diagram, and the map is a pending change on a page of its own
		const diagram = vscode.workspace.textDocuments.find((d) => /services-2\.drawio$/.test(d.uri.fsPath));
		assert.ok(fs.existsSync(path.join(path.dirname(diagram.uri.fsPath), ".drawai", "maps", `${mapId}.json`)), "no map record next to the diagram");
		const maps = await tool("mapper_maps");
		assert.deepEqual([maps.maps.length, maps.onPage], [1, [mapId]]);
		const model = JSON.parse(await invoke("drawio_get_diagram", {}));
		assert.equal(model.page.name, run.drawnOn);
		assert.ok(model.totalCells > 3);

		// lookups, and a description that shows as the shape's tooltip
		const found = await tool("mapper_find", { query: "" });
		const first = found[0];
		const shown = await tool("mapper_show", { nodeId: first.id });
		assert.equal(shown.id, first.id);
		const ws = await tool("mapper_worksheet", { mapId, limit: 5 });
		const described = await tool("mapper_set_descriptions", { mapId, items: [{ nodeId: ws.entries[0].id, description: "Keeps the shop running and answers the pages people open." }, { nodeId: "nope", description: "Nothing here at all, really." }] });
		assert.deepEqual([described.accepted, described.applied, described.problems.length], [1, 1, 1], JSON.stringify(described));
		// with another page showing, the agent's descriptions still reach the map's shapes: its page is shown first
		const firstPage = JSON.parse(await invoke("drawio_pages", { action: "list" })).pages.find((p) => p.name !== run.drawnOn);
		await invoke("drawio_pages", { action: "select", page: firstPage.id });
		const again = await tool("mapper_set_descriptions", { mapId, items: [{ nodeId: ws.entries[1].id, description: "Takes the orders people place and passes them on to be packed." }] });
		assert.deepEqual([again.accepted, again.applied, again.problems], [1, 1, []], JSON.stringify(again));
		const tips = JSON.parse(await invoke("drawio_get_diagram", { maxCells: 5000 }));
		assert.equal(tips.page.name, run.drawnOn);
		assert.equal(tips.cells.find((c) => c.data?.mapperId === ws.entries[1].id)?.data.tooltip, "Takes the orders people place and passes them on to be packed.");

		// findings: in the Maps view, shown on the map, dismissed
		const findings = await tool("mapper_findings", { mapId });
		assert.ok(findings.checked.length > 0, "no checks ran");
		let view = (await mapsState()).view;
		assert.equal(view.length, 1);
		const group = view[0].children[0];
		assert.equal(group.label, findings.findings.length ? `Findings (${findings.findings.length})` : "No findings");
		assert.equal(group.children.length, findings.findings.length);
		// (another page is showing when a map is picked in the Maps view: its actions go to the map's page first)
		const otherPage = JSON.parse(await invoke("drawio_pages", { action: "list" })).pages.find((p) => p.name !== run.drawnOn);
		assert.ok(otherPage, "the diagram has no other page");
		const showOther = async () => {
			await invoke("drawio_pages", { action: "select", page: otherPage.id });
			assert.notEqual(JSON.parse(await invoke("drawio_get_diagram", {})).page.name, run.drawnOn);
		};
		const badgesOnMapPage = async (kind) => {
			const m = JSON.parse(await invoke("drawio_get_diagram", { maxCells: 5000 }));
			assert.equal(m.page.name, run.drawnOn, "the map's page is not showing");
			return m.cells.filter((c) => c.data?.mapperKind === kind).length;
		};
		if (findings.findings.length) {
			const f = findings.findings[0];
			const before = await badgesOnMapPage("finding-badge");
			assert.ok(before > 0, "no health badges on the map");
			await showOther();
			assert.ok((await vscode.commands.executeCommand("drawio-ai.maps.showFinding", { mapId, findingId: f.id })) > 0, "the finding's shapes were not selected");
			await showOther();
			await vscode.commands.executeCommand("drawio-ai.maps.dismissFinding", { mapId, findingId: f.id });
			assert.equal((await tool("mapper_findings", { mapId })).findings.length, findings.findings.length - 1);
			// its badge left the map (a shape with another finding keeps a badge)
			assert.ok((await badgesOnMapPage("finding-badge")) <= before, "the dismissed finding's badge is still drawn");
		}

		// recent changes: a changed file marks its shapes
		const known = found.map((n) => n.id).slice(0, 12);
		let changedFile;
		for (const id of known) {
			const files = (await tool("mapper_show", { nodeId: id })).files ?? [];
			changedFile = files.map((f) => path.join(repo, f)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
			if (changedFile) break;
		}
		assert.ok(changedFile, "no shape of the map lists a file");
		fs.appendFileSync(changedFile, "\n# changed by the test\n");
		await showOther();
		const recent = await vscode.commands.executeCommand("drawio-ai.maps.recentChanges", mapId);
		assert.ok(recent.shapes > 0 && recent.badges > 0, JSON.stringify(recent));
		assert.equal(await badgesOnMapPage("change-badge"), recent.badges);
		view = (await mapsState()).view;
		assert.ok(view[0].children.some((c) => /^Changed since [0-9a-f]{7} \(\d+\)$/.test(c.label)), JSON.stringify(view[0].children.map((c) => c.label)));

		// a tour: saved by the agent's tool, listed in the view, played in presentation mode
		const steps = [first.id, ...(shown.uses[0] ? [shown.uses[0].id] : [])].map((id, i) => ({ title: `Step ${i + 1}`, caption: `This is ${id}.`, nodeIds: [id] }));
		assert.equal((await tool("mapper_set_tour", { mapId, title: "Quick tour", steps })).saved, true);
		view = (await mapsState()).view;
		assert.deepEqual(view[0].children.find((c) => c.label === "Tours (1)")?.children, ["Quick tour"]);
		assert.equal(await vscode.commands.executeCommand("drawio-ai.maps.playTour", { mapId }), true);
		// (the first step is shown a moment after the tour starts, once presentation mode has fitted the page)
		const playing = await waitFor(async () => {
			const s = await look();
			return s?.presenting && s.tour?.highlighted > 0 ? s : undefined;
		}, "the tour to play in presentation mode and highlight its first step");
		assert.deepEqual([playing.tour.title, playing.tour.step, playing.tour.steps], ["Quick tour", 0, steps.length]);
		assert.deepEqual(playing.tours, ["Quick tour"]);
		assert.match(playing.tour.caption, /This is /);
		await vscode.commands.executeCommand("drawio-ai.present");
		await waitFor(async () => ((await look())?.presenting === false ? true : undefined), "presentation mode to end");

		// an answer drawn as a page of its own
		const answer = await tool("mapper_answer", { question: "What does it talk to?", answer: "Its database.", steps: steps.map((s) => ({ nodeId: s.nodeIds[0], note: s.caption, mapId })) });
		assert.equal(answer.drawn, true, JSON.stringify(answer));

		// databases: every driver is part of the extension (it gets as far as the network), and a SQLite file maps
		const raw = (name, args) => vscode.commands.executeCommand("drawio-ai.maps.tool", { name, args });
		for (const [engine, connectionString] of [
			["postgres", "postgres://u:s3cr3tPw@127.0.0.1:1/db"],
			["mysql", "mysql://u:s3cr3tPw@127.0.0.1:1/db"],
			["mssql", "Server=127.0.0.1,1;Database=db;User Id=u;Password=s3cr3tPw;Encrypt=false"],
			["oracle", "oracle://u:s3cr3tPw@127.0.0.1:1/svc"],
			["mongodb", "mongodb://u:s3cr3tPw@127.0.0.1:1/db?serverSelectionTimeoutMS=1500"],
		]) {
			const r = await raw("mapper_run", { recipe: "database.schema", input: { engine, connectWith: "url", connectionString } });
			assert.equal(r.isError, true, `${engine}: ${r.text}`);
			assert.doesNotMatch(r.text, /Cannot find module|is not a function|is not defined|not a constructor/, `${engine}: ${r.text}`);
			assert.match(r.text, /ECONNREFUSED|connect|reach|refused|NJS-|timed out|Server selection/i, `${engine}: ${r.text}`);
			// the secret never comes back
			assert.ok(!r.text.includes("s3cr3tPw"), `${engine}: ${r.text}`);
		}
		// ... and is not written next to the diagram
		const mapsDir = path.join(path.dirname(diagram.uri.fsPath), ".drawai", "maps");
		for (const f of fs.readdirSync(mapsDir)) assert.ok(!fs.readFileSync(path.join(mapsDir, f), "utf8").includes("s3cr3tPw"), f);
		let sqlite;
		try {
			sqlite = require("node:sqlite");
		} catch {
			sqlite = undefined; // an older VS Code: the Mapper says so
		}
		const dbFile = path.join(repo, "shop.sqlite");
		if (sqlite) {
			const db = new sqlite.DatabaseSync(dbFile);
			db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL);");
			db.close();
			const dbMap = await tool("mapper_run", { recipe: "database.schema", input: { engine: "sqlite", file: dbFile } });
			assert.ok(dbMap.map.shapes >= 2, JSON.stringify(dbMap.map));
			assert.ok((await tool("mapper_find", { query: "orders", mapId: dbMap.map.id })).length > 0);
		} else {
			fs.writeFileSync(dbFile, "");
			assert.match((await raw("mapper_run", { recipe: "database.schema", input: { engine: "sqlite", file: dbFile } })).text, /newer runtime/);
		}

		// the Map Something panel: the desktop app's page, loaded in a webview
		// (asked for twice at once: still one panel)
		await Promise.all([vscode.commands.executeCommand("drawio-ai.mapSomething"), vscode.commands.executeCommand("drawio-ai.mapSomething")]);
		const loaded = await waitFor(async () => {
			const p = (await mapsState()).panelPage;
			return p?.ready && p.loaded ? p.loaded : undefined;
		}, "the Map Something page to load");
		// its five style sheets, its scripts, its modules and its font came from the extension's folder
		assert.deepEqual([loaded.sheets, loaded.scripts, loaded.modules, loaded.font], [5, true, true, true], JSON.stringify(loaded));
		assert.equal(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /^Map Something: /.test(t.label)).length, 1);

		// A request from a diagram's panel is about that diagram: with another one in front, it becomes the target again first
		// (the agent's map tools work on the diagram used last).
		const mapped = diagram.uri.fsPath;
		assert.equal((await mapsState()).target, mapped);
		await vscode.commands.executeCommand("vscode.openWith", file, "drawio-ai-text");
		await waitFor(async () => ((await mapsState()).target === file.fsPath ? true : undefined), "the first diagram to be the one used last");
		assert.deepEqual((await mapsState()).maps, [], "the other diagram has no maps");
		assert.equal(await vscode.commands.executeCommand("drawio-ai.maps.makeTarget", mapped), true);
		const back = await mapsState();
		assert.equal(back.target, mapped);
		assert.ok(back.maps.some((m) => m.id === mapId));

		// the same tools over the MCP server, as Claude Code and Codex reach them
		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("port", 0, vscode.ConfigurationTarget.Global);
		const info = await vscode.commands.executeCommand("drawio-ai.mcpSetup", { enable: true, show: false });
		const rpc = async (id, method, params) => {
			const r = await fetch(info.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
			assert.equal(r.status, 200);
			return (await r.json()).result;
		};
		const listed = (await rpc(1, "tools/list")).tools;
		assert.equal(listed.filter((t) => t.name.startsWith("mapper_")).length, 13);
		const viaMcp = await rpc(2, "tools/call", { name: "mapper_maps", arguments: {} });
		assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp));
		assert.ok(JSON.parse(viaMcp.content[0].text).maps.some((m) => m.id === mapId));
		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", false, vscode.ConfigurationTarget.Global);
	});

	await step("the Shape Workshop: nothing is downloaded unasked; a gallery becomes a palette and joins draw.io's search; a shape goes in; shape sets and the Scratchpad switch and are kept; the panel loads", async () => {
		const workshop = () => vscode.commands.executeCommand("drawio-ai.workshop.state");
		const message = (msg) => vscode.commands.executeCommand("drawio-ai.workshop.message", msg);
		const look = () => vscode.commands.executeCommand("drawio-ai.editorLookState");
		const cells = async () => JSON.parse(await invoke("drawio_get_diagram", {})).totalCells;

		// The desktop app's default galleries are there, switched off: nothing was fetched or cached, and the editor has no palettes of theirs.
		let st = await workshop();
		assert.deepEqual(st.galleries.map((g) => [g.id, g.enabled, g.count ?? null]), [["thesvg", false, null], ["tech-logos", false, null], ["ui-icons", false, null]]);
		assert.equal(fs.existsSync(path.join(st.dataDir, "galleries")), false, "something was cached before a gallery was turned on");
		assert.deepEqual((await look()).palettes, []);

		// The panel: the desktop app's page, loaded in a webview (asked for twice at once: still one panel).
		await Promise.all([vscode.commands.executeCommand("drawio-ai.shapeWorkshop"), vscode.commands.executeCommand("drawio-ai.shapeWorkshop")]);
		const loaded = await waitFor(async () => {
			const p = (await workshop()).panelPage;
			return p?.ready && p.loaded ? p.loaded : undefined;
		}, "the Shape Workshop page to load");
		assert.deepEqual([loaded.sheets, loaded.scripts, loaded.modules, loaded.font], [5, true, true, true], JSON.stringify(loaded));
		assert.equal(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === "Shape Workshop").length, 1);
		// With the page open and the galleries listed, everything a user can do to a gallery that is off downloads nothing:
		// browsing it (a click on its card), Sync now, Make available offline. Restored defaults come back off.
		for (const msg of [{ type: "search", reqId: 1, query: "", galleryId: "thesvg" }, { type: "sync", id: "tech-logos" }, { type: "offline", id: "ui-icons" }]) {
			assert.match((await message(msg)).error ?? "", /is off\. Switch it on to use it/, JSON.stringify(msg));
		}
		await vscode.commands.executeCommand("drawio-ai.workshop.setGalleries", st.galleries.slice(0, 1).map((g) => ({ id: g.id, title: g.title, sources: [{ kind: "thesvg" }], enabled: false, builtin: true })));
		await message({ type: "restoreDefaults" });
		await vscode.commands.executeCommand("drawio-ai.workshop.setGalleries");
		await sleep(500);
		st = await workshop();
		assert.deepEqual(st.galleries.map((g) => [g.id, g.enabled, g.count ?? null]), [["thesvg", false, null], ["tech-logos", false, null], ["ui-icons", false, null]]);
		assert.equal(fs.existsSync(path.join(st.dataDir, "galleries")), false, "something was downloaded for a gallery that is off");
		// the editor told the extension what draw.io's own shape sets are
		const sets = await waitFor(async () => (await workshop()).sets, "the editor's shape sets");
		const entries = sets.flatMap((g) => g.entries);
		assert.ok(entries.some((e) => e.id === "general" && e.on) && entries.some((e) => e.id === ".scratchpad"), JSON.stringify(sets.map((g) => g.title)));

		// a gallery from a folder on this computer (no downloads): a palette in the shapes sidebar
		const shapes = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-shapes-"));
		const svg = (colour) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${colour}"/></svg>`;
		for (const [name, colour] of [["zebracrossing", "black"], ["lighthouse", "orange"]]) fs.writeFileSync(path.join(shapes, `${name}.svg`), svg(colour));
		const mine = { id: "mine", title: "My shapes", sources: [{ kind: "folder", path: shapes }], enabled: true };
		await vscode.commands.executeCommand("drawio-ai.workshop.setGalleries", [mine]);
		await waitFor(async () => ((await look()).palettes.includes("My shapes") ? true : undefined), "the gallery's palette in the editor");
		st = await workshop();
		assert.deepEqual(st.galleries.map((g) => [g.id, g.enabled, g.count]), [["mine", true, 2]]);

		// draw.io's own search, which drawio_search_shapes uses too, finds the gallery's shape
		const found = await invoke("drawio_search_shapes", { query: "zebracrossing", limit: 10 });
		assert.match(found, /zebracrossing/i);

		// a shape from the Workshop goes into the diagram used last, once
		const before = await cells();
		const results = (await message({ type: "search", reqId: 1, query: "lighthouse" })).posted.find((m) => m.type === "results");
		assert.deepEqual(results.hits.map((h) => h.title), ["lighthouse"]);
		const put = await message({ type: "insert", galleryId: "mine", itemId: results.hits[0].id });
		assert.deepEqual(put.posted.filter((m) => m.type === "notice").map((m) => m.message), [`Added lighthouse to ${path.basename(st.target)}.`]);
		await waitFor(async () => ((await cells()) === before + 1 ? true : undefined), "the shape to be in the diagram");
		await sleep(400);
		assert.equal(await cells(), before + 1);

		// a shape set and the Scratchpad are switched on from the Workshop...
		const off = entries.find((e) => !e.on && e.id !== ".scratchpad");
		assert.ok(off, "every shape set is already shown");
		await message({ type: "setShapeSet", id: off.id, on: true });
		await message({ type: "setShapeSet", id: ".scratchpad", on: true });
		const isOn = (list, id) => list?.flatMap((g) => g.entries).some((e) => e.id === id && e.on);
		await waitFor(async () => {
			const now = (await workshop()).sets;
			return isOn(now, off.id) && isOn(now, ".scratchpad") && isOn(now, "general") ? true : undefined;
		}, "the shape set and the Scratchpad to be shown");
		// ... and kept: a diagram opened afterwards starts with them (draw.io's storage is the extension's)
		const second = vscode.Uri.file(path.join(path.dirname(st.target), "workshop-second.drawio"));
		fs.writeFileSync(second.fsPath, EMPTY);
		await vscode.commands.executeCommand("vscode.openWith", second, "drawio-ai-text");
		await waitFor(async () => {
			const now = await workshop();
			return now.target === second.fsPath && isOn(now.sets, off.id) && isOn(now.sets, ".scratchpad") ? true : undefined;
		}, "a new diagram to open with the shape set and the Scratchpad");
		// the gallery's palette is in the new diagram too
		await waitFor(async () => ((await look())?.palettes.includes("My shapes") ? true : undefined), "the gallery's palette in the new diagram");

		// a collection filled from the Workshop becomes a palette too, and follows what it holds
		const made = await message({ type: "newCollection", title: "Favourites" });
		const collection = made.posted.find((m) => m.type === "selectGallery").id;
		assert.deepEqual((await look()).palettes, ["My shapes"], "an empty collection has no palette");
		await message({ type: "addToCollection", collectionId: collection, galleryId: "mine", itemId: results.hits[0].id });
		await waitFor(async () => ((await look())?.palettes.includes("Favourites") ? true : undefined), "the collection's palette once it holds a shape");
		const kept = (await message({ type: "search", reqId: 2, query: "", galleryId: collection })).posted.find((m) => m.type === "results").hits;
		assert.deepEqual(kept.map((h) => h.title), ["lighthouse"]);
		await message({ type: "removeFromCollection", collectionId: collection, itemId: kept[0].id });
		await waitFor(async () => (((await look())?.palettes ?? []).includes("Favourites") ? undefined : true), "the emptied collection's palette to go");

		// the gallery switched off: its palette leaves every open diagram
		// the Shape Shifter, in VS Code too: draw.io's own shapes are ownFound by words with a picture each, one goes into
		// the diagram used last, and the selected shape is recoloured as the user's own change (one undo step)
		const ownFound = (await message({ type: "find", reqId: 7, query: "cylinder" })).posted.find((m) => m.type === "found");
		assert.ok(ownFound && ownFound.diagram === true && ownFound.own.length > 0, JSON.stringify(ownFound).slice(0, 300));
		assert.ok(ownFound.own.every((o) => typeof o.src === "string" && o.src.length > 20 && typeof o.title === "string"), "each of draw.io's shapes with its picture");
		const beforeOwn = await cells();
		const putOwn = await message({ type: "insertFound", key: ownFound.own[0].key });
		assert.equal(putOwn.error, undefined);
		await waitFor(async () => ((await cells()) === beforeOwn + 1 ? true : undefined), "draw.io's own shape to be in the diagram");
		const ownAdded = JSON.parse(await invoke("drawio_get_diagram", { includeStyles: true })).cells.at(-1);
		await invoke("drawio_select_cells", { ids: [ownAdded.id] });
		const styleOf = async (id) => JSON.parse(await invoke("drawio_get_diagram", { includeStyles: true })).cells.find((c) => c.id === id).style;
		const recoloured = await message({ type: "restyle", fill: "#ff5500" });
		assert.deepEqual([recoloured.error, recoloured.posted.filter((m) => m.type === "notice").map((m) => m.message)], [undefined, ["Changed 1 shape. Undo in the diagram takes it back."]]);
		assert.match(await styleOf(ownAdded.id), /fillColor=#ff5500/i);
		// the Workshop is told of the selection as it changes in the diagram (its controls follow without a change of tab)
		const sinceSelect = (await workshop()).selectionPosts;
		await invoke("drawio_select_cells", { ids: [] });
		await waitFor(async () => { const st = await workshop(); return st.selectionPosts > sinceSelect && st.lastSelection?.count === 0 ? true : undefined; }, "the Workshop to hear that nothing is selected");
		await invoke("drawio_select_cells", { ids: [ownAdded.id] });
		await waitFor(async () => ((await workshop()).lastSelection?.count === 1 ? true : undefined), "the Workshop to hear of the selected shape");
		// with nothing selected it says so, and changes nothing
		await invoke("drawio_select_cells", { ids: [] });
		assert.match((await message({ type: "restyle", fill: "#00ff00" })).error, /Select the shapes to change/);
		// the Workshop says that the Shape Shifter is there for this diagram (its tab is not "Next" any more)
		assert.equal((await workshop()).shifter, true);

		// the Shape Creator, in VS Code too: drawn by a model VS Code offers. This window has none (nobody is signed
		// in to anything): it is listed, says what to do, and nothing is sent anywhere by listing it.
		assert.equal((await workshop()).creator, true);
		const agentsNow = async () => (await message({ type: "creatorAgents" })).posted.filter((m) => m.type === "creatorAgents").pop();
		const drawers = await waitFor(async () => { const m = await agentsNow(); return m && m.agents.length ? m : undefined; }, "who can draw");
		assert.deepEqual(drawers.agents.map((a) => [a.id, a.kind, a.label]), [["vscode-lm", "api", "VS Code's models"]]);
		const models = await vscode.lm.selectChatModels();
		assert.equal(drawers.agents[0].ready, models.length > 0);
		if (!models.length) assert.match(drawers.agents[0].problem, /VS Code offers no language model yet/);

		await vscode.commands.executeCommand("drawio-ai.workshop.setGalleries", [{ ...mine, enabled: false }]);
		await waitFor(async () => ((await look())?.palettes.length === 0 ? true : undefined), "the palette to go");
		assert.deepEqual((await workshop()).galleries.map((g) => [g.id, g.enabled]), [["mine", false]]);

	});
}

const tabPaths = () =>
	vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.uri && t.input.uri.fsPath).filter(Boolean);

/** The agent steps, in a window that has a workspace folder open. */
async function agentSuite() {
	const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "draw-ai");
	assert.ok(ext, "extension not found");
	await ext.activate();
	// A diagram the user has open outside the workspace: reachable by `file` because it is open.
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-it-outside-"));
	const firstFile = vscode.Uri.file(path.join(outsideDir, "open.drawio"));
	fs.writeFileSync(
		firstFile.fsPath,
		'<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="db" value="Orders DB" style="shape=cylinder3;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="100" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
	);
	await step("agents: setup opens a diagram outside the workspace", async () => {
		await vscode.commands.executeCommand("vscode.openWith", firstFile, "drawio-ai-text");
		await waitFor(async () => (await invoke("drawio_get_diagram", {})).startsWith("{"), "draw.io + AI plugin to load", 60000);
	});
	await agentSteps(firstFile, outsideDir);
}

/** External agents: the `file` argument, the workspace tools, discovery, the bridge, and Connect. */
async function agentSteps(firstFile, outsideDir) {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		steps.push("- skipped agent steps: no workspace folder (run through runVsCodeTests.js)");
		return;
	}
	const second = path.join(folder.uri.fsPath, "docs", "second.drawio");
	fs.mkdirSync(path.dirname(second), { recursive: true });
	fs.writeFileSync(
		second,
		'<mxfile><diagram id="s1" name="Services"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="bill" value="Billing Service" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
	);

	await step("agents: list and search find diagrams in the workspace", async () => {
		const list = JSON.parse(await invoke("drawio_list_diagrams", {}));
		assert.ok(list.files.includes("docs/second.drawio"), JSON.stringify(list));
		assert.ok(list.open.some((o) => o.path === firstFile.fsPath), "the open diagram outside the workspace is listed by its full path");
		const found = JSON.parse(await invoke("drawio_search_diagrams", { query: "/billing\\s+serv/" }));
		assert.deepEqual(found.matches, [{ path: "docs/second.drawio", page: "Services", cellId: "bill", kind: "vertex", label: "Billing Service" }]);
	});

	await step("agents: `file` opens a workspace diagram beside the user's work and edits it there", async () => {
		const edit = JSON.parse(await invoke("drawio_apply_operations", { file: "docs/second.drawio", ops: [{ op: "addShape", label: "Invoices", x: 220, y: 40 }] }));
		assert.equal(edit.ok, true, JSON.stringify(edit));
		assert.ok(tabPaths().includes(second), "second.drawio opened in an editor");
		const cells = JSON.parse(await invoke("drawio_find_cells", { file: second, query: "Invoices" }));
		assert.equal(cells.total, 1);
		await vscode.commands.executeCommand("drawio-ai.acceptChanges");
		const first = JSON.parse(await invoke("drawio_get_diagram", { file: firstFile.fsPath }));
		assert.ok(first.cells.some((c) => c.label === "Orders DB"), "an open diagram outside the workspace is still reachable");
	});

	await step("agents: `file` refuses diagrams outside the workspace, and drawio_create never replaces a file", async () => {
		const outside = path.join(outsideDir, "outside.drawio");
		fs.writeFileSync(outside, EMPTY);
		assert.match(await invoke("drawio_get_diagram", { file: outside }), /outside the workspace/);
		assert.match(await invoke("drawio_get_diagram", { file: "../escape.drawio" }), /No diagram at \.\.\/escape\.drawio/);
		assert.match(await invoke("drawio_get_diagram", { file: "README.md" }), /is not a draw\.io diagram/);
		const created = JSON.parse(await invoke("drawio_create", { path: "docs/new/flow.drawio" }));
		assert.equal(created.created, "docs/new/flow.drawio");
		await waitFor(() => tabPaths().includes(path.join(folder.uri.fsPath, "docs", "new", "flow.drawio")), "new diagram to open");
		const added = JSON.parse(await invoke("drawio_apply_operations", { file: "docs/new/flow.drawio", ops: [{ op: "addShape", label: "Start" }] }));
		assert.equal(added.ok, true, JSON.stringify(added));
		assert.match(await invoke("drawio_create", { path: "docs/second.drawio" }), /already exists/);
		assert.match(await invoke("drawio_create", { path: "docs/pic.drawio.png" }), /must end in \.drawio \(recommended\) or \.drawio\.svg/);
		const svg = JSON.parse(await invoke("drawio_create", { path: "docs/pic.drawio.svg" }));
		assert.equal(svg.created, "docs/pic.drawio.svg");
		const drawn = JSON.parse(await invoke("drawio_apply_operations", { file: "docs/pic.drawio.svg", ops: [{ op: "addShape", label: "In SVG" }] }));
		assert.equal(drawn.ok, true, JSON.stringify(drawn));
		assert.match(await invoke("drawio_create", { path: "../escape.drawio" }), /inside the workspace/);
	});

	const home = process.env.DRAWIO_AI_HOME;
	if (!home) {
		steps.push("- skipped bridge steps: DRAWIO_AI_HOME not set (run through runVsCodeTests.js)");
		return;
	}

	await step("agents: this window announces itself, and the plugin's launcher reaches it through the bridge", async () => {
		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("port", 0, vscode.ConfigurationTarget.Global);
		const info = await vscode.commands.executeCommand("drawio-ai.mcpSetup", { enable: true, show: false });
		assert.equal(info.running, true);
		const entryFile = path.join(home, "instances", `${process.pid}.json`);
		const entry = await waitFor(() => {
			if (!fs.existsSync(entryFile)) return undefined;
			const e = JSON.parse(fs.readFileSync(entryFile, "utf8"));
			return e.openDiagrams.includes(second) ? e : undefined;
		}, "discovery entry listing second.drawio");
		assert.equal(`http://127.0.0.1:${entry.port}/mcp`, info.url);
		assert.match(entry.token, /^[0-9a-f]{48}$/);
		assert.notEqual(entry.token, info.token, "discovery holds a per-window session token, not the long-lived one");
		assert.deepEqual(entry.workspaceFolders, [folder.uri.fsPath]);
		if (process.platform !== "win32") assert.equal(fs.statSync(entryFile).mode & 0o777, 0o600);

		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "draw-ai");
		const launcher = path.join(ext.extensionPath, "agent-plugin", "bin", process.platform === "win32" ? "draw-ai-mcp.cmd" : "draw-ai-mcp");
		const replies = await talkToBridge(launcher, home, [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "it" } } },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "drawio_find_cells", arguments: { file: "docs/second.drawio", query: "Invoices" } } },
			{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "drawio_list_diagrams", arguments: { filter: "flow" } } },
		]);
		assert.equal(replies[1].result.serverInfo.name, "draw-ai");
		assert.match(replies[1].result.instructions, /Draw\.AI extension/);
		assert.equal(JSON.parse(replies[2].result.content[0].text).total, 1, JSON.stringify(replies[2]));
		assert.deepEqual(JSON.parse(replies[3].result.content[0].text).files, ["docs/new/flow.drawio"]);

		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", false, vscode.ConfigurationTarget.Global);
		await waitFor(() => !fs.existsSync(entryFile), "discovery entry to be removed when the server stops");
	});

	const isolated = (v) => !!v && path.resolve(v).startsWith(path.resolve(os.tmpdir())) || (!!v && v.includes("drawio-ai-vscode-"));
	if (!isolated(process.env.CLAUDE_CONFIG_DIR) || !isolated(process.env.CODEX_HOME)) {
		steps.push("- skipped Connect steps: CLAUDE_CONFIG_DIR / CODEX_HOME are not throwaway folders");
		return;
	}
	await step("agents: Connect installs the plugin into Claude Code and Codex; Disconnect removes it", async () => {
		const connected = await vscode.commands.executeCommand("drawio-ai.connectAgents", { agents: ["claude-code", "codex"], confirm: false });
		if (connected.done.length === 0 && connected.failed.length === 0) {
			steps.push("- skipped: neither the claude nor the codex CLI is installed");
			return;
		}
		assert.deepEqual(connected.failed, [], "see the Draw.AI Agents output");
		const pluginCopy = path.join(home, "agent-plugin");
		assert.ok(fs.existsSync(path.join(pluginCopy, "skills", "drawio-diagrams", "SKILL.md")));
		if (connected.done.includes("claude-code")) {
			const settings = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8");
			assert.match(settings, /draw-ai@draw-ai/);
		}
		if (connected.done.includes("codex")) {
			const toml = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
			assert.match(toml, /\[plugins\."draw-ai@draw-ai"\]\s*enabled = true/);
		}
		const again = await vscode.commands.executeCommand("drawio-ai.connectAgents", { agents: connected.done, confirm: false });
		assert.deepEqual(again.failed, [], "connecting twice is harmless");
		const removed = await vscode.commands.executeCommand("drawio-ai.disconnectAgents", { agents: connected.done, confirm: false });
		assert.deepEqual(removed.failed, []);
		if (connected.done.includes("codex")) {
			assert.doesNotMatch(fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"), /draw-ai/);
		}
		await vscode.workspace.getConfiguration("drawio-ai.mcp").update("enabled", false, vscode.ConfigurationTarget.Global);
	});
}

/** Starts the agent plugin's launcher like an agent would and exchanges newline-delimited JSON-RPC with it. */
function talkToBridge(launcher, home, messages) {
	const { spawn } = require("child_process");
	return new Promise((resolve, reject) => {
		const env = { ...process.env, DRAWIO_AI_HOME: home };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(launcher, [], { env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
		const replies = {};
		let out = "";
		let err = "";
		const want = messages.filter((m) => "id" in m).length;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`bridge timed out; stderr: ${err}`));
		}, 30000);
		child.stderr.on("data", (d) => (err += d));
		child.stdout.on("data", (d) => {
			out += d;
			let nl;
			while ((nl = out.indexOf("\n")) >= 0) {
				const msg = JSON.parse(out.slice(0, nl));
				out = out.slice(nl + 1);
				if ("id" in msg) replies[msg.id] = msg;
			}
			if (Object.keys(replies).length >= want) {
				clearTimeout(timer);
				child.stdin.end();
				resolve(replies);
			}
		});
		child.on("error", reject);
		// One at a time, so initialize is answered before the calls arrive.
		(async () => {
			for (const m of messages) {
				child.stdin.write(JSON.stringify(m) + "\n");
				if ("id" in m) await waitFor(() => replies[m.id], `reply ${m.id}`, 30000);
			}
		})().catch(reject);
	});
}
