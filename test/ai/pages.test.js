// Unit tests for the extension side of pages and layers: the drawio_pages tool,
// the `page` argument of the read tools, and their schemas. The webview side
// (draw.io's page and layer changes, review) is covered by plugin.e2e.test.js.
// Run: node --test test/ai/pages.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const settings = {};
const vscodeStub = {
	workspace: {
		getConfiguration: () => ({ get: (key, def) => (key in settings ? settings[key] : def) }),
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const src = (p) => path.resolve(__dirname, "../../src/features/ai", p);
const { DiagramToolbox } = require(src("DiagramToolbox.ts"));
const { TOOL_SCHEMAS, toMcpTools } = require(src("toolSchemas.ts"));

const PAGES = [
	{ id: "p1", name: "Overview", index: 0, cells: 3, current: true },
	{ id: "p2", name: "Details", index: 1, cells: 2, current: false },
];

const emptyModel = (page) => ({
	page,
	layers: [{ id: "1", name: "", visible: true, locked: false }],
	bounds: { x: 0, y: 0, width: 0, height: 0 },
	selection: [],
	cells: [{ id: "w", kind: "vertex", label: "Worker", geometry: { x: 0, y: 0, width: 120, height: 60 } }],
	truncated: false,
	totalCells: 1,
});

/** A draw.io client that answers like the webview and records what it was asked. */
function fakeEditor({ aiAdded = false, cells = 2 } = {}) {
	const calls = [];
	const drawioClient = {
		async aiPages(request) {
			calls.push(request);
			const page = { id: "p2", name: "Details", index: 1, cells, current: false };
			if (request.op === "list") return { event: "aiPages", pages: PAGES };
			if (request.page === "Nope") return { event: "aiPages", pages: PAGES, error: 'No page "Nope".' };
			if (request.dryRun) return { event: "aiPages", pages: PAGES, page, aiAdded };
			if (request.op === "delete") return { event: "aiPages", pages: [PAGES[0]], page, aiAdded };
			if (request.op === "add") {
				const added = { id: "p3", name: request.name || "Page-3", index: 2, cells: 0, current: request.select };
				return { event: "aiPages", pages: [...PAGES, added], page: added };
			}
			return { event: "aiPages", pages: PAGES, page: { ...page, current: request.op === "select" } };
		},
		async aiGetModel(options) {
			calls.push({ getModel: options });
			const other = options.page && options.page !== "p1";
			return emptyModel({ id: other ? "p2" : "p1", name: other ? "Details" : "Overview", index: other ? 1 : 0, count: 2, current: !other });
		},
	};
	return { calls, editor: { drawioClient } };
}

function toolbox(editor, confirm) {
	return new DiagramToolbox(() => editor, undefined, undefined, undefined, undefined, undefined, undefined, confirm);
}

test("drawio_pages: list, add (shown or not), select and rename say which page the editing tools work on", async () => {
	const { editor, calls } = fakeEditor();
	const tb = toolbox(editor);
	const list = await tb.invoke("drawio_pages", { action: "list" });
	assert.equal(list.summary, "2 pages");
	assert.deepEqual(JSON.parse(list.text).pages, PAGES);

	settings.reviewChanges = false;
	const added = JSON.parse((await tb.invoke("drawio_pages", { action: "add", name: "Deploy" })).text);
	assert.deepEqual(calls.at(-1), { op: "add", page: undefined, name: "Deploy", index: undefined, select: true, review: false });
	assert.match(added.notes.join(" "), /"Deploy" is shown now, so drawio_apply_operations edits it/);

	const hidden = JSON.parse((await tb.invoke("drawio_pages", { action: "add", name: "Later", select: false, index: "0" })).text);
	assert.equal(calls.at(-1).index, 0, "a numeric string is accepted");
	assert.match(hidden.notes.join(" "), /The editor still shows "Overview"\. Select "Later" before editing it/);

	settings.reviewChanges = true;
	const renamed = await tb.invoke("drawio_pages", { action: "rename", page: " p2 ", name: "Workers" });
	assert.equal(calls.at(-1).page, "p2");
	assert.equal(calls.at(-1).review, true, "review mode reaches the webview");
	assert.match(JSON.parse(renamed.text).notes.join(" "), /pending changes they can keep or revert/);

	const selected = await tb.invoke("drawio_pages", { action: "select", page: "Details" });
	assert.equal(selected.summary, 'Showing page "Details"');
	delete settings.reviewChanges;
});

test("drawio_pages: errors from the webview and bad input come back as tool errors", async () => {
	const { editor } = fakeEditor();
	const tb = toolbox(editor);
	const bad = await tb.invoke("drawio_pages", { action: "explode" });
	assert.equal(bad.isError, true);
	assert.match(bad.text, /`action` must be one of: list, add, rename, duplicate, move, select, delete/);
	const missing = await tb.invoke("drawio_pages", { action: "select", page: "Nope" });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /No page "Nope"/);
});

test("drawio_pages delete: the user confirms deleting a page with content; not an empty page or one the AI added", async () => {
	const asked = [];
	const decline = async (message, action) => (asked.push([message, action]), false);
	let { editor, calls } = fakeEditor();
	let result = await toolbox(editor, decline).invoke("drawio_pages", { action: "delete", page: "Details" });
	assert.equal(result.isError, true);
	assert.match(result.text, /The user chose not to delete page "Details"/);
	assert.deepEqual(asked, [['The AI wants to delete the page "Details" with 2 shapes and connectors on it. Undo in the diagram brings it back.', "Delete Page"]]);
	assert.deepEqual(calls.map((c) => [c.op, !!c.dryRun]), [["delete", true]], "nothing is deleted when the user declines");

	({ editor, calls } = fakeEditor());
	result = await toolbox(editor, async () => true).invoke("drawio_pages", { action: "delete", page: "Details" });
	assert.equal(result.summary, 'Deleted page "Details"');
	assert.equal(calls.at(-1).page, "p2", "the confirmed page is deleted by id, not by name");
	assert.match(JSON.parse(result.text).notes.join(" "), /Deleted "Details" \(2 cells\); the editor shows "Overview"\. The user can bring it back with Undo/);

	for (const quiet of [{ cells: 0 }, { aiAdded: true }]) {
		asked.length = 0;
		({ editor, calls } = fakeEditor(quiet));
		result = await toolbox(editor, decline).invoke("drawio_pages", { action: "delete", page: "Details" });
		assert.equal(result.isError, undefined, JSON.stringify(quiet));
		assert.deepEqual(asked, [], `no question for ${JSON.stringify(quiet)}`);
	}
});

test("drawio_get_diagram, drawio_find_cells and drawio_lint read another page with `page`", async () => {
	const { editor, calls } = fakeEditor();
	const tb = toolbox(editor);
	const read = await tb.invoke("drawio_get_diagram", { page: "Details" });
	assert.equal(calls.at(-1).getModel.page, "Details");
	assert.equal(read.summary, 'Read page "Details" (1 cells)');
	assert.match(JSON.parse(read.text).notes.join(" "), /which the editor does not show; drawio_apply_operations edits the page shown/);

	const shown = JSON.parse((await tb.invoke("drawio_get_diagram", {})).text);
	assert.equal(calls.at(-1).getModel.page, undefined);
	assert.match(shown.notes.join(" "), /The diagram has 2 pages; this is "Overview", the one shown/);

	const found = await tb.invoke("drawio_find_cells", { query: "work", page: "p2" });
	assert.equal(calls.at(-1).getModel.page, "p2");
	assert.equal(found.summary, 'Found 1 cell on "Details"');
	assert.equal(JSON.parse(found.text).page, "Details");

	const lint = JSON.parse((await tb.invoke("drawio_lint", { page: "p2" })).text);
	assert.equal(calls.at(-1).getModel.page, "p2");
	assert.equal(lint.page, "Details");
});

test("schemas: pages and layers fit the shared tool definitions", () => {
	const schema = (name) => TOOL_SCHEMAS.find((t) => t.name === name);
	const pages = schema("drawio_pages");
	assert.ok(pages.mutates, "drawio_pages changes the diagram");
	assert.deepEqual(pages.inputSchema.required, ["action"]);
	assert.ok("file" in pages.inputSchema.properties, "drawio_pages acts on one diagram, so it takes `file`");
	for (const name of ["drawio_get_diagram", "drawio_find_cells", "drawio_lint"]) {
		assert.equal(schema(name).inputSchema.properties.page.type, "string", `${name} takes page`);
	}
	const op = schema("drawio_apply_operations").inputSchema.properties.ops.items;
	for (const kind of ["addLayer", "renameLayer", "setLayerVisible", "setLayerLocked", "moveToLayer"]) {
		assert.ok(op.properties.op.enum.includes(kind), kind);
	}
	for (const field of ["name", "visible", "locked", "layer"]) assert.ok(field in op.properties, field);
	assert.doesNotMatch(JSON.stringify(TOOL_SCHEMAS), /"(oneOf|anyOf|allOf)"/);
	assert.equal(toMcpTools().find((t) => t.name === "drawio_pages").readOnly, false);

	const panel = new DiagramToolbox(() => undefined).specs({ vision: false }).find((t) => t.name === "drawio_pages");
	assert.ok(panel && !("file" in panel.inputSchema.properties), "the chat panel gets drawio_pages without `file`");
});
