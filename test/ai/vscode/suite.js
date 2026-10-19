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
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "draw-ai");
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
			"drawio_export",
			"drawio_list_diagrams",
			"drawio_search_diagrams",
			"drawio_create",
		]) {
			assert.ok(names.includes(n), `tool ${n} not registered`);
		}
		const commands = await vscode.commands.getCommands(true);
		for (const c of ["drawio-ai.openChat", "drawio-ai.askAboutSelection", "drawio-ai.lassoSelect", "drawio-ai.setApiKey", "drawio-ai.connectAgents", "drawio-ai.disconnectAgents"]) {
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

	await agentSteps(file, dir);

	await step("saving writes the AI edits to disk", async () => {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file.fsPath);
		await doc.save();
		assert.match(fs.readFileSync(file.fsPath, "utf8"), /Orders DB/);
	});
}

const tabPaths = () =>
	vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.uri && t.input.uri.fsPath).filter(Boolean);

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
		assert.equal(entry.token, info.token);
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
