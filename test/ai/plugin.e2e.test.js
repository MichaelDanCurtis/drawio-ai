// End-to-end test of the draw.io AI plugin: loads the real draw.io webapp with
// the extension's own webview HTML and custom plugins in headless Chrome, then
// drives it through the same JSON message protocol the extension uses.
//
// Prereqs: `git submodule update --init drawio` and `yarn build-plugins` (or dev build).
// Run: node --test test/ai/plugin.e2e.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "../..");
const webapp = path.join(root, "drawio/src/main/webapp");
const pluginBundle = path.join(root, "dist/custom-drawio-plugins/index.js");

const MIME = {
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
	".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".xml": "application/xml",
	".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2",
};

let server, browser, page, base;
const inbox = [];
const waiters = [];
let nextId = 1000;

function editorHtml() {
	const shim = `<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(typeof m === "string" ? m : JSON.stringify(m)) });</script>`;
	return fs
		.readFileSync(path.join(root, "src/DrawioClient/webview-content.html"), "utf8")
		.replace("<head>", "<head>" + shim)
		.replace(/\$\$literal-vsuri\$\$/g, `${base}/webapp`)
		.replace("$$theme$$", JSON.stringify("kennedy"))
		.replace("$$appearance$$", JSON.stringify("0"))
		.replace("$$dark$$", JSON.stringify("0"))
		.replace("$$lang$$", JSON.stringify("en"))
		.replace("$$simpleLabels$$", "false")
		.replace("$$chrome$$", JSON.stringify("1"))
		.replace("$$customPluginPaths$$", JSON.stringify([`${base}/plugin.js`]))
		.replace("$$localStorage$$", "{}")
		.replace("$$additionalCode$$", "[]");
}

function onHostMessage(raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	if (msg.event === "configure") {
		send({ action: "configure", config: {} });
	}
	inbox.push(msg);
	for (const w of [...waiters]) {
		if (w.match(msg)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(msg);
		}
	}
}

function waitFor(match, timeout = 20000) {
	const existing = inbox.find(match);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const w = { match, resolve };
		waiters.push(w);
		setTimeout(() => {
			const i = waiters.indexOf(w);
			if (i >= 0) {
				waiters.splice(i, 1);
				reject(new Error("Timed out waiting for message"));
			}
		}, timeout);
	});
}

function send(action) {
	return page.evaluate((m) => window.postMessage(m, "*"), JSON.stringify(action));
}

async function request(action) {
	const actionId = String(nextId++);
	const response = waitFor((m) => m.message && m.message.actionId === actionId);
	await send({ ...action, actionId });
	return response;
}

const getModel = (scope = "page") =>
	request({ action: "aiGetModel", scope, includeStyles: true, maxCells: 1000 }).then((r) => r.model);
const apply = (ops, atomic = true) =>
	request({ action: "aiApplyOps", ops, atomic, flash: false, selectResult: false });

before(async () => {
	assert.ok(fs.existsSync(path.join(webapp, "index.html")), "drawio submodule missing");
	assert.ok(fs.existsSync(pluginBundle), "build the plugins first");

	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		let file;
		if (url.pathname === "/editor.html") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(editorHtml());
		} else if (url.pathname === "/plugin.js") {
			file = pluginBundle;
		} else if (url.pathname.startsWith("/webapp/")) {
			file = path.join(webapp, decodeURIComponent(url.pathname.slice("/webapp/".length)));
			if (!file.startsWith(webapp)) {
				res.writeHead(403);
				return res.end();
			}
		}
		if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;

	browser = await chromium.launch({ channel: "chrome", headless: true });
	page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on("pageerror", (e) => console.error("[page error]", e.message));
	await page.exposeFunction("__toHost", onHostMessage);
	await page.goto(`${base}/editor.html`);

	await waitFor((m) => m.event === "init", 60000);
	await send({ action: "load", xml: "", autosave: 1 });
	await waitFor((m) => m.event === "pluginLoaded" && m.pluginId === "ai", 30000);
});

after(async () => {
	await browser?.close();
	server?.close();
});

test("adds shapes and wires an edge through tempIds in one batch", async () => {
	const r = await apply([
		{ op: "addShape", tempId: "$web", label: "Web", x: 40, y: 40 },
		{ op: "addShape", tempId: "$db", label: "Database", style: "shape=cylinder3;whiteSpace=wrap;html=1;", placement: { relativeTo: "$web", side: "right" } },
		{ op: "addEdge", tempId: "$e", source: "$web", target: "$db", label: "SQL" },
	]);
	assert.equal(r.rolledBack, false);
	assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
	const model = await getModel();
	const web = model.cells.find((c) => c.id === r.idMap.$web);
	const db = model.cells.find((c) => c.id === r.idMap.$db);
	const edge = model.cells.find((c) => c.id === r.idMap.$e);
	assert.equal(web.label, "Web");
	assert.match(db.style, /cylinder3/);
	assert.equal(db.geometry.x, web.geometry.x + web.geometry.width + 60);
	assert.equal(edge.source, web.id);
	assert.equal(edge.target, db.id);
	assert.equal(edge.label, "SQL");
});

test("the model change reaches the host as an autosave", async () => {
	inbox.length = 0;
	await apply([{ op: "addShape", label: "Autosaved" }]);
	const evt = await waitFor((m) => m.event === "autosave");
	assert.match(evt.xml, /Autosaved/);
});

test("atomic batch rolls back completely when one op fails", async () => {
	const before = (await getModel()).totalCells;
	const r = await apply([
		{ op: "addShape", tempId: "$x", label: "Should vanish" },
		{ op: "update", id: "does-not-exist", label: "boom" },
	]);
	assert.equal(r.rolledBack, true);
	assert.equal(r.results[1].ok, false);
	assert.match(r.results[1].error, /Unknown cell id "does-not-exist"/);
	assert.equal((await getModel()).totalCells, before);
});

test("a batch is a single undo step", async () => {
	const before = (await getModel()).totalCells;
	await apply([
		{ op: "addShape", label: "U1" },
		{ op: "addShape", label: "U2" },
		{ op: "addShape", label: "U3" },
	]);
	assert.equal((await getModel()).totalCells, before + 3);
	await page.evaluate(() => editorUi.editor.undoManager.undo());
	assert.equal((await getModel()).totalCells, before);
});

test("update merges styleProps, escapes labels and sets data", async () => {
	const { idMap } = await apply([{ op: "addShape", tempId: "$s", label: "Old", style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff;" }]);
	const r = await apply([
		{ op: "update", id: idMap.$s, label: "A < B\nline 2", styleProps: { fillColor: "#dae8fc", rounded: null, strokeWidth: 2 }, data: { tooltip: "hi" } },
	]);
	assert.equal(r.rolledBack, false);
	const cell = (await getModel()).cells.find((c) => c.id === idMap.$s);
	assert.match(cell.style, /fillColor=#dae8fc/);
	assert.doesNotMatch(cell.style, /rounded=/);
	assert.match(cell.style, /strokeWidth=2/);
	assert.equal(cell.label, "A < B\nline 2");
	assert.equal(cell.data.tooltip, "hi");
});

test("group with label, align, distribute, layout and zOrder all apply", async () => {
	const { idMap } = await apply([
		{ op: "addShape", tempId: "$a", label: "A", x: 600, y: 300 },
		{ op: "addShape", tempId: "$b", label: "B", x: 800, y: 340 },
		{ op: "addShape", tempId: "$c", label: "C", x: 1000, y: 320 },
		{ op: "addEdge", source: "$a", target: "$b" },
		{ op: "addEdge", source: "$b", target: "$c" },
	]);
	const ids = [idMap.$a, idMap.$b, idMap.$c];
	const r = await apply([
		{ op: "align", ids, align: "middle" },
		{ op: "distribute", ids, direction: "horizontal" },
		{ op: "zOrder", ids: [idMap.$a], position: "front" },
		{ op: "group", tempId: "$g", ids, label: "Tier" },
		{ op: "layout", parent: "$g", type: "horizontalHierarchical" },
	]);
	assert.deepEqual(r.results.filter((x) => !x.ok), []);
	const model = await getModel();
	const group = model.cells.find((c) => c.id === r.idMap.$g);
	assert.equal(group.kind, "container");
	assert.equal(group.label, "Tier");
	for (const id of ids) {
		assert.equal(model.cells.find((c) => c.id === id).parent, group.id);
	}
});

test("ELK layout really separates overlapping shapes, and edit+layout is one undo step", async () => {
	const { idMap } = await apply([
		{ op: "addShape", tempId: "$c1", label: "L1", x: 2000, y: 2000 },
		{ op: "addShape", tempId: "$c2", label: "L2", x: 2000, y: 2000 },
		{ op: "addShape", tempId: "$c3", label: "L3", x: 2000, y: 2000 },
		{ op: "addEdge", source: "$c1", target: "$c2" },
		{ op: "addEdge", source: "$c2", target: "$c3" },
	]);
	const ids = [idMap.$c1, idMap.$c2, idMap.$c3];
	const geos = async () => {
		const m = await getModel();
		return ids.map((id) => m.cells.find((c) => c.id === id).geometry);
	};
	const before = await geos();

	const r = await apply([
		{ op: "update", id: idMap.$c1, label: "L1 (root)" },
		{ op: "layout", ids, type: "hierarchical" },
	]);
	assert.deepEqual(r.results.filter((x) => !x.ok), []);
	const after = await geos();
	assert.ok(after[0].y < after[1].y && after[1].y < after[2].y, JSON.stringify(after));

	await page.evaluate(() => editorUi.editor.undoManager.undo());
	assert.deepEqual(await geos(), before);
	const m = await getModel();
	assert.equal(m.cells.find((c) => c.id === idMap.$c1).label, "L1");
});

test("insertXml keeps requested ids and links to existing cells", async () => {
	const { idMap } = await apply([{ op: "addShape", tempId: "$anchor", label: "Anchor", x: 40, y: 600 }]);
	const xml =
		`<mxCell id="lb" value="LB" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="600" width="120" height="60" as="geometry"/></mxCell>` +
		`<mxCell id="lb-edge" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="lb" target="${idMap.$anchor}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
	const r = await apply([{ op: "insertXml", xml }]);
	assert.deepEqual(r.results.filter((x) => !x.ok), []);
	assert.equal(r.idMap.lb, "lb");
	const model = await getModel();
	const edge = model.cells.find((c) => c.id === r.idMap["lb-edge"]);
	assert.equal(edge.source, "lb");
	assert.equal(edge.target, idMap.$anchor);
});

test("selection scope returns selected cells plus adjacent context", async () => {
	const { idMap } = await apply([
		{ op: "addShape", tempId: "$p", label: "P", x: 40, y: 800 },
		{ op: "addShape", tempId: "$q", label: "Q", x: 300, y: 800 },
		{ op: "addEdge", tempId: "$pq", source: "$p", target: "$q" },
	]);
	await request({ action: "aiSetSelection", cellIds: [idMap.$p], reveal: false });
	const model = await getModel("selection");
	assert.deepEqual(model.selection, [idMap.$p]);
	assert.equal(model.cells.find((c) => c.id === idMap.$p).selected, true);
	assert.equal(model.cells.find((c) => c.id === idMap.$q).context, true);
	assert.equal(model.cells.find((c) => c.id === idMap.$pq).context, true);
});

test("shape search returns real library styles", async () => {
	const r = await request({ action: "aiSearchShapes", query: "aws lambda", limit: 5 });
	assert.ok(r.shapes.length > 0, `no shapes: ${r.error}`);
	assert.ok(r.shapes.some((s) => /mxgraph\.aws/.test(s.style)), JSON.stringify(r.shapes.map((s) => s.style)));
});

test("renders the page to PNG", async () => {
	const r = await request({ action: "aiExportImage", cellIds: [], maxSize: 600 });
	assert.match(r.dataUrl, /^data:image\/png;base64,/, r.error);
});

test("replaceAll swaps the page content", async () => {
	const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="only" value="Only" style="ellipse;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="80" as="geometry"/></mxCell></root></mxGraphModel>`;
	const r = await apply([{ op: "replaceAll", xml }]);
	assert.deepEqual(r.results.filter((x) => !x.ok), []);
	const model = await getModel();
	assert.deepEqual(model.cells.map((c) => c.id), ["only"]);
});

// ---------------------------------------------------------------------------
// Review mode: AI edits stay pending until the user keeps or reverts them.
// ---------------------------------------------------------------------------

const applyReview = (ops) =>
	request({ action: "aiApplyOps", ops, atomic: true, flash: false, selectResult: false, review: true });
const lastReview = () => [...inbox].reverse().find((m) => m.event === "aiReview");
const resolve = async (decision, cellIds) => {
	inbox.length = 0;
	await send({ action: "aiResolveReview", decision, cellIds });
	return waitFor((m) => m.event === "aiReview");
};
const historyLength = () => page.evaluate(() => editorUi.editor.undoManager.indexOfNextAdd);
const byId = (model, id) => model.cells.find((c) => c.id === id);

async function freshBaseline() {
	const xml =
		`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
		`<mxCell id="api" value="API" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>` +
		`<mxCell id="db" value="DB" style="shape=cylinder3;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="40" width="80" height="80" as="geometry"/></mxCell>` +
		`<mxCell id="e1" style="html=1;" edge="1" parent="1" source="api" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>` +
		`</root></mxGraphModel>`;
	await apply([{ op: "replaceAll", xml }]);
}

test("review: AI changes are flagged as pending and Reject all restores the original", async () => {
	await freshBaseline();
	const before = await getModel();
	inbox.length = 0;
	const r = await applyReview([
		{ op: "addShape", tempId: "$cache", label: "Cache", placement: { relativeTo: "api", side: "below" } },
		{ op: "addEdge", source: "api", target: "$cache" },
		{ op: "update", id: "api", label: "Gateway", styleProps: { fillColor: "#dae8fc" } },
		{ op: "move", ids: ["db"], dx: 100, dy: 0 },
	]);
	assert.equal(r.rolledBack, false);
	const evt = lastReview();
	assert.ok(evt?.pending, "no pending review event");
	assert.deepEqual(evt.summary, { added: 2, changed: 2, removed: 0 });
	assert.deepEqual(byId({ cells: evt.changes }, "api").fields.sort(), ["label", "style"]);
	assert.deepEqual(byId({ cells: evt.changes }, "db").fields, ["geometry"]);

	const ui = await page.evaluate(() => ({
		bar: !!document.querySelector("[data-ai-review-bar]"),
		ghosts: [...document.querySelectorAll("[data-ai-ghost]")].map((e) => e.getAttribute("data-ai-ghost")),
	}));
	assert.ok(ui.bar, "review bar missing");
	assert.deepEqual(ui.ghosts, ["changed"], "moved shape should leave a ghost");

	const done = await resolve("reject");
	assert.equal(done.pending, false);
	assert.equal(done.resolved, "rejected");
	const after = await getModel();
	assert.deepEqual(
		after.cells.map((c) => [c.id, c.label, c.style, JSON.stringify(c.geometry), c.source, c.target]),
		before.cells.map((c) => [c.id, c.label, c.style, JSON.stringify(c.geometry), c.source, c.target])
	);
	assert.equal(await page.evaluate(() => !!document.querySelector("[data-ai-review-bar]")), false);
});

test("review: reverting one deleted shape brings back its connections; the rest can be kept", async () => {
	await freshBaseline();
	inbox.length = 0;
	await applyReview([
		{ op: "delete", ids: ["db"] },
		{ op: "addShape", tempId: "$q", label: "Queue", x: 40, y: 300 },
	]);
	let evt = lastReview();
	assert.deepEqual(evt.summary, { added: 1, changed: 0, removed: 2 }, JSON.stringify(evt.changes));
	assert.ok(await page.evaluate(() => document.querySelectorAll('[data-ai-ghost="removed"]').length >= 1));

	evt = await resolve("reject", ["db"]);
	assert.equal(evt.pending, true);
	assert.deepEqual(evt.summary, { added: 1, changed: 0, removed: 0 });
	const model = await getModel();
	assert.equal(byId(model, "db").label, "DB");
	assert.equal(byId(model, "e1").source, "api");
	assert.equal(byId(model, "e1").target, "db");

	evt = await resolve("accept");
	assert.equal(evt.pending, false);
	assert.equal(evt.resolved, "mixed");
	assert.ok((await getModel()).cells.some((c) => c.label === "Queue"));
});

test("review: reverting an added shape also removes the edges the AI attached to it", async () => {
	await freshBaseline();
	inbox.length = 0;
	const r = await applyReview([
		{ op: "addShape", tempId: "$w", label: "Worker", x: 40, y: 400 },
		{ op: "addEdge", tempId: "$we", source: "$w", target: "db" },
		{ op: "update", id: "e1", target: "$w" },
	]);
	const evt = await resolve("reject", [r.idMap.$w]);
	assert.equal(evt.pending, false, JSON.stringify(evt));
	const model = await getModel();
	assert.equal(byId(model, r.idMap.$w), undefined);
	assert.equal(byId(model, r.idMap.$we), undefined);
	assert.equal(byId(model, "e1").target, "db", "existing edge should be reconnected to its original target");
});

test("review: several AI batches form one review and one undo step; user edits are not flagged", async () => {
	await freshBaseline();
	const history = await historyLength();
	inbox.length = 0;
	await applyReview([{ op: "addShape", label: "One", x: 40, y: 500 }]);
	await page.evaluate(() => {
		const g = editorUi.editor.graph;
		g.insertVertex(g.getDefaultParent(), "mine", "Mine", 600, 500, 80, 40);
	});
	await applyReview([{ op: "update", id: "api", label: "Two" }]);
	await new Promise((r) => setTimeout(r, 150));
	const evt = lastReview();
	assert.deepEqual(evt.summary, { added: 1, changed: 1, removed: 0 }, JSON.stringify(evt.changes));
	assert.ok(!evt.changes.some((c) => c.id === "mine"), "the user's own shape must not be flagged");

	await resolve("accept");
	assert.equal(await historyLength(), history + 3, "batch 1, the user's edit, batch 2");

	inbox.length = 0;
	await applyReview([{ op: "addShape", label: "Three" }]);
	await applyReview([{ op: "addShape", label: "Four" }]);
	assert.equal(await historyLength(), history + 4, "consecutive AI batches in one review share an undo step");
	await page.evaluate(() => editorUi.editor.undoManager.undo());
	await new Promise((r) => setTimeout(r, 150));
	const labels = (await getModel()).cells.map((c) => c.label);
	assert.ok(!labels.includes("Three") && !labels.includes("Four"));
	assert.equal(lastReview().pending, false, "undoing the AI's changes ends the review");
});

test("review: the in-diagram bar keeps or reverts the selection", async () => {
	await freshBaseline();
	inbox.length = 0;
	const r = await applyReview([
		{ op: "addShape", tempId: "$a", label: "KeepMe", x: 40, y: 300 },
		{ op: "addShape", tempId: "$b", label: "DropMe", x: 240, y: 300 },
	]);
	await request({ action: "aiSetSelection", cellIds: [r.idMap.$b], reveal: false });
	const buttons = await page.evaluate(() =>
		[...document.querySelectorAll("[data-ai-review]")].map((b) => b.getAttribute("data-ai-review"))
	);
	assert.deepEqual(buttons, ["Revert 1 selected", "Keep 1 selected", "Reject all", "Accept all"]);
	inbox.length = 0;
	await page.click('[data-ai-review="Revert 1 selected"]');
	await waitFor((m) => m.event === "aiReview" && m.summary.added === 1);
	await page.click('[data-ai-review="Accept all"]');
	const end = await waitFor((m) => m.event === "aiReview" && !m.pending);
	assert.equal(end.resolved, "mixed");
	const labels = (await getModel()).cells.map((c) => c.label);
	assert.ok(labels.includes("KeepMe") && !labels.includes("DropMe"));
});

// ---------------------------------------------------------------------------
// Markup and image conversion
// ---------------------------------------------------------------------------

/** Scrolls all cells into view once, then returns their centres in client coordinates. */
async function clientCenters(...ids) {
	return page.evaluate((cellIds) => {
		const graph = editorUi.editor.graph;
		const cells = cellIds.map((id) => graph.model.getCell(id));
		graph.zoomTo(1);
		editorUi.resetScrollbars();
		graph.scrollCellToVisible(cells[0], true);
		const r = graph.container.getBoundingClientRect();
		return cells.map((c) => {
			const s = graph.view.getState(c);
			return { x: r.left + s.getCenterX() - graph.container.scrollLeft, y: r.top + s.getCenterY() - graph.container.scrollTop, w: s.width };
		});
	}, ids);
}

async function resetMarkup() {
	await send({ action: "aiSetMarkupMode", enabled: false });
	await page.keyboard.press("Escape");
	await page.evaluate(() => editorUi.editor.graph.clearSelection());
}

async function drag(from, to) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.mouse.up();
}

test("markup: arrow, strike-through and note become one AI request; nothing is added to the diagram", async () => {
	await freshBaseline();
	await apply([{ op: "insertXml", xml: '<mxCell id="cache" value="Cache" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="200" width="120" height="60" as="geometry"/></mxCell>' }]);
	const before = (await getModel()).totalCells;
	await resetMarkup();
	const [api, db, cache] = await clientCenters("api", "db", "cache");
	inbox.length = 0;
	await send({ action: "aiSetMarkupMode", enabled: true });
	await waitFor((m) => m.event === "aiMarkup" && m.active === true);

	await drag(api, db);
	await page.waitForSelector("[data-ai-markup-note]");
	await page.keyboard.type("through a queue");
	await page.keyboard.press("Enter");

	await page.keyboard.press("s");
	await drag({ x: cache.x - cache.w / 2 - 10, y: cache.y }, { x: cache.x + cache.w / 2 + 10, y: cache.y + 4 });

	await page.keyboard.press("n");
	await page.mouse.click(db.x + 200, cache.y + 60);
	await page.waitForSelector("[data-ai-markup-note]");
	await page.keyboard.type("add a CDN here");
	await page.keyboard.press("Enter");

	assert.equal(await page.locator("[data-ai-markup-count]").innerText(), "3 marks");
	assert.ok((await page.locator("[data-ai-mark]").count()) >= 3, "marks are drawn on the canvas");
	assert.equal((await getModel()).totalCells, before, "marks are overlays, not cells");

	await page.fill("[data-ai-markup-instructions]", "keep the colours");
	await page.click('[data-ai-markup="send"]');
	const ask = await waitFor((m) => m.event === "aiAsk");
	assert.equal(ask.source, "markup");
	assert.equal(ask.markCount, 3);
	assert.deepEqual([...ask.cellIds].sort(), ["api", "cache", "db"]);
	assert.match(ask.prompt, /1\. Arrow from "API" \[id api\] to "DB" \[id db\] — "through a queue"/);
	assert.match(ask.prompt, /2\. Strike-through over "Cache" \[id cache\]/);
	assert.match(ask.prompt, /3\. Note on empty space \(x=\d+, y=\d+\): "add a CDN here"/);
	assert.match(ask.prompt, /keep the colours/);
	await waitFor((m) => m.event === "aiMarkup" && m.active === false);
	assert.equal(await page.locator("[data-ai-markup-bar], [data-ai-markup-layer]").count(), 0);
});

test("markup: undo removes the last mark, Escape leaves without sending", async () => {
	await freshBaseline();
	await resetMarkup();
	const [api, db] = await clientCenters("api", "db");
	inbox.length = 0;
	await send({ action: "aiSetMarkupMode", enabled: true });
	await waitFor((m) => m.event === "aiMarkup" && m.active);
	await drag(api, db);
	await page.waitForSelector("[data-ai-markup-note]");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("[data-ai-markup-count]").innerText(), "1 mark", "skipping the arrow note keeps the arrow");
	await page.click('[data-ai-markup="undo"]');
	assert.equal(await page.locator("[data-ai-markup-count]").innerText(), "");
	assert.equal(await page.locator('[data-ai-markup="send"]').isDisabled(), true);
	await page.keyboard.press("Escape");
	await waitFor((m) => m.event === "aiMarkup" && m.active === false);
	assert.ok(!inbox.some((m) => m.event === "aiAsk"));
});

function tinyPng() {
	const zlib = require("zlib");
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const w = 8, h = 8;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([220, 40, 40]).flat())])));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

test("image cells offer 'Convert image to diagram', which sends the rendered image to the AI", async () => {
	await freshBaseline();
	const r = await apply([
		{ op: "addShape", tempId: "$img", label: "", x: 500, y: 300, width: 160, height: 120, style: `shape=image;html=1;imageAspect=0;image=data:image/png,${tinyPng()};` },
	]);
	const id = r.idMap.$img;
	await resetMarkup();
	const [c] = await clientCenters(id);
	await request({ action: "aiSetSelection", cellIds: [id], reveal: false });
	inbox.length = 0;
	await page.mouse.click(c.x, c.y, { button: "right" });
	await page.click("text=✦ Convert image to diagram");
	const ask = await waitFor((m) => m.event === "aiAsk");
	assert.equal(ask.source, "image");
	assert.deepEqual(ask.cellIds, [id]);
	assert.equal(ask.images.length, 1);
	assert.equal(ask.images[0].mimeType, "image/png");
	assert.ok(ask.images[0].base64.length > 200);
	assert.match(ask.prompt, new RegExp(`delete the image cell ${id}`));
});

test("badges: shown on cells, replaced per group, clickable, never saved", async () => {
	await freshBaseline();
	await send({ action: "aiSetBadges", group: "codeLinks", badges: [
		{ cellId: "api", kind: "warning", tooltip: "Code link: changed" },
		{ cellId: "db", kind: "error", tooltip: "Code link: gone" },
		{ cellId: "missing", kind: "info", tooltip: "ignored" },
	] });
	const overlays = () =>
		page.evaluate(() => {
			const g = editorUi.editor.graph;
			return ["api", "db"].map((id) => (g.getCellOverlays(g.model.getCell(id)) || []).map((o) => [o.aiBadge.kind, o.tooltip]));
		});
	await page.waitForFunction(() => (editorUi.editor.graph.getCellOverlays(editorUi.editor.graph.model.getCell("db")) || []).length === 1);
	assert.deepEqual(await overlays(), [[["warning", "Code link: changed"]], [["error", "Code link: gone"]]]);

	inbox.length = 0;
	await page.evaluate(() => {
		const g = editorUi.editor.graph;
		const o = g.getCellOverlays(g.model.getCell("db"))[0];
		o.fireEvent(new mxEventObject(mxEvent.CLICK, "event", null, "cell", g.model.getCell("db")));
	});
	assert.deepEqual(await waitFor((m) => m.event === "aiBadgeClick"), { event: "aiBadgeClick", group: "codeLinks", cellId: "db" });

	await send({ action: "aiSetBadges", group: "codeLinks", badges: [{ cellId: "db", kind: "info", tooltip: "moved" }] });
	await page.waitForFunction(() => !(editorUi.editor.graph.getCellOverlays(editorUi.editor.graph.model.getCell("api")) || []).length);
	assert.deepEqual(await overlays(), [[], [["info", "moved"]]]);

	inbox.length = 0;
	await apply([{ op: "update", id: "api", label: "API v2" }]);
	const saved = await waitFor((m) => m.event === "autosave");
	assert.doesNotMatch(saved.xml, /moved|aiBadge|Code link/);
	await send({ action: "aiSetBadges", group: "codeLinks", badges: [] });
});

// ---------------------------------------------------------------------------
// Visio export
// ---------------------------------------------------------------------------

const { unzip } = require("./unzip");
const visioFixture = fs.readFileSync(path.join(__dirname, "fixtures/visio-export.drawio"), "utf8");

async function loadFixture(xml) {
	inbox.length = 0;
	await send({ action: "load", xml, autosave: 1 });
	await page.waitForFunction((n) => (editorUi.pages || []).length === n, (xml.match(/<diagram /g) || []).length);
	await page.waitForFunction(() => editorUi.editor.graph.model.getCell("a") != null);
}

async function exportVisio(currentPageOnly = false) {
	const r = await request({ action: "aiExportVsdx", currentPageOnly }).catch((e) => assert.fail(e));
	assert.equal(r.error, undefined);
	return { ...r, files: unzip(Buffer.from(r.data, "base64")) };
}

/** Parses the page XML in the browser and returns its shapes as a tree. */
function shapesOf(xml) {
	return page.evaluate((xml) => {
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		if (doc.getElementsByTagName("parsererror").length) return { error: doc.documentElement.textContent };
		const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
		const cells = (el) => Object.fromEntries(kids(el, "Cell").map((c) => [c.getAttribute("N"), c.getAttribute("V")]));
		const shape = (s) => {
			const text = kids(s, "Text")[0];
			const sub = kids(s, "Shapes")[0];
			return {
				id: s.getAttribute("ID"),
				type: s.getAttribute("Type"),
				master: s.getAttribute("Master"),
				cells: cells(s),
				text: text ? text.textContent : null,
				sections: kids(s, "Section").map((x) => x.getAttribute("N")),
				data: kids(s, "Section")
					.filter((x) => x.getAttribute("N") === "Property")
					.flatMap((x) => kids(x, "Row").map((r) => [cells(r).Label, cells(r).Value])),
				link: kids(s, "Section").filter((x) => x.getAttribute("N") === "Hyperlink").map((x) => cells(kids(x, "Row")[0]).Address)[0],
				order: Array.from(s.children).map((c) => c.localName),
				children: sub ? kids(sub, "Shape").map(shape) : [],
			};
		};
		const root = doc.documentElement;
		return {
			shapes: kids(kids(root, "Shapes")[0], "Shape").map(shape),
			connects: Array.from(root.getElementsByTagName("Connect")).map((c) => [c.getAttribute("FromSheet"), c.getAttribute("FromCell"), c.getAttribute("ToSheet")]),
		};
	}, xml);
}

const flat = (shapes) => shapes.flatMap((s) => [s, ...flat(s.children)]);
const byText = (shapes, text) => flat(shapes).find((s) => s.text && s.text.includes(text));

test("Visio export: a valid package with every page, image and connector", async () => {
	await loadFixture(visioFixture);
	const r = await exportVisio();
	assert.deepEqual([r.pages, r.connectors, r.images], [2, 4, 2]);
	assert.deepEqual(r.warnings, ["Hidden layers were not exported: Notes layer"]);

	const names = Object.keys(r.files);
	assert.equal(names[0], "[Content_Types].xml");
	for (const part of ["visio/document.xml", "visio/pages/pages.xml", "visio/pages/page1.xml", "visio/pages/page2.xml", "visio/masters/master1.xml", "docProps/core.xml"]) {
		assert.ok(names.includes(part), `missing ${part}`);
	}

	// Every part has a content type and every relationship points at a part that exists.
	const types = r.files["[Content_Types].xml"].data.toString();
	for (const name of names.filter((n) => n !== "[Content_Types].xml")) {
		const ext = name.split(".").pop();
		assert.ok(types.includes(`PartName="/${name}"`) || types.includes(`Extension="${ext}"`), `no content type for ${name}`);
	}
	for (const rels of names.filter((n) => n.endsWith(".rels"))) {
		const dir = path.posix.dirname(path.posix.dirname(rels));
		for (const [, target] of r.files[rels].data.toString().matchAll(/Target="([^"]+)"/g)) {
			const resolved = path.posix.normalize(path.posix.join(dir, target)).replace(/^\.\//, "");
			assert.ok(names.includes(resolved), `${rels} points at missing ${resolved}`);
		}
	}

	const pagesXml = r.files["visio/pages/pages.xml"].data.toString();
	assert.deepEqual([...pagesXml.matchAll(/<Page [^>]*Name="([^"]+)"/g)].map((m) => m[1]), ["Overview", "Overview (2)"]);
	const xml = r.files["visio/pages/page1.xml"].data.toString();
	assert.doesNotMatch(xml, /light-dark|var\(/);
	assert.doesNotMatch(xml, /Hidden note/);

	const { shapes, connects, error } = await shapesOf(xml);
	assert.equal(error, undefined);
	const api = byText(shapes, "Gateway");
	assert.equal(api.text, "API Gateway");
	assert.equal(api.cells.FillForegnd, "#DAE8FC");
	assert.equal(api.cells.LineColor, "#6C8EBF");
	// Children in schema order: Cells, then Sections, then Text.
	assert.deepEqual([...new Set(api.order)], ["Cell", "Section", "Text"]);

	const worker = byText(shapes, "Worker");
	assert.deepEqual(worker.data, [["owner", "team-a"], ["cost-center", "42"]]);
	assert.equal(worker.link, "https://example.com/worker");
	assert.equal(worker.cells.Comment, "Runs jobs");
	assert.ok(Math.abs(parseFloat(worker.cells.Angle) - (330 * Math.PI) / 180) < 1e-9);

	// The AWS icon is painted in two colors: an orange tile and a white glyph.
	const lambda = byText(shapes, "Lambda");
	assert.equal(lambda.type, "Group");
	assert.deepEqual(lambda.children.map((c) => c.cells.FillForegnd), ["#ED7100", "#FFFFFF"]);

	const pool = byText(shapes, "Pool");
	const group = shapes.find((s) => s.children.includes(pool) || s.children.some((c) => c.id === pool.id));
	assert.equal(group.type, "Group");
	assert.deepEqual(group.children.map((c) => c.text ?? (c.master === "4" ? "connector" : null)), ["Pool", "Task", "Step 2", "connector"]);

	assert.equal(flat(shapes).filter((s) => s.master === "4").length, 3);
	assert.equal(connects.length, 6, "each connector is glued at both ends");
	const ids = new Set(flat(shapes).map((s) => s.id));
	for (const [from, , to] of connects) assert.ok(ids.has(from) && ids.has(to));

	const page2 = await shapesOf(r.files["visio/pages/page2.xml"].data.toString());
	assert.equal(flat(page2.shapes).filter((s) => s.type === "Foreign").length, 2);
	assert.equal(page2.connects.length, 2);
});

test("Visio export: draw.io's own Visio importer reads the file back", async () => {
	await loadFixture(visioFixture);
	const { data } = await exportVisio();
	const back = await page.evaluate(async (b64) => {
		const ui = editorUi;
		if (!ui.doImportVisio) {
			await new Promise((resolve, reject) => mxscript("js/extensions.min.js", resolve, null, null, null, reject));
		}
		const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);
		const xml = await new Promise((resolve, reject) =>
			ui.importVisio(blob, resolve, (e) => reject(new Error(e?.message || String(e))), "export.vsdx")
		);
		const doc = mxUtils.parseXml(xml);
		return Array.from(doc.getElementsByTagName("diagram")).map((d) => {
			let model = d.getElementsByTagName("mxGraphModel")[0];
			if (!model) model = mxUtils.parseXml(Graph.decompress(d.textContent)).documentElement;
			const cells = Array.from(model.getElementsByTagName("mxCell"));
			const label = (c) => {
				const owner = /^(object|UserObject)$/.test(c.parentNode.nodeName) ? c.parentNode : c;
				const div = document.createElement("div");
				div.innerHTML = owner.getAttribute("value") || owner.getAttribute("label") || "";
				div.querySelectorAll("li, p, div, br").forEach((e) => e.append(" "));
				return div.textContent.replace(/\s+/g, " ").trim();
			};
			return {
				name: d.getAttribute("name"),
				labels: cells.map(label).filter(Boolean),
				edges: cells.filter((c) => c.getAttribute("edge") === "1").map((c) => !!c.getAttribute("source") && !!c.getAttribute("target")),
				data: Array.from(model.getElementsByTagName("*"))
					.filter((o) => /^(object|UserObject)$/.test(o.nodeName) && o.getAttribute("owner"))
					.map((o) => [o.getAttribute("owner"), o.getAttribute("cost-center"), o.getAttribute("link")]),
			};
		});
	}, data);

	assert.deepEqual(back.map((p) => p.name), ["Overview", "Overview (2)"]);
	for (const label of ["API Gateway", "Orders DB", "queries", "sql", "Worker", "Pool", "Task", "Step 2", "Lambda", "one two red tail"]) {
		assert.ok(back[0].labels.includes(label), `"${label}" did not survive: ${back[0].labels.join(" | ")}`);
	}
	assert.deepEqual(back[0].edges, [true, true, true], "connectors stay glued");
	assert.deepEqual(back[0].data, [["team-a", "42", "https://example.com/worker"]]);
	assert.deepEqual(back[1].labels, ["Second page", "Also here"]);
	assert.deepEqual(back[1].edges, [true]);
});

test("Visio export: only the current page, without touching the editor", async () => {
	await loadFixture(visioFixture);
	await page.evaluate(() => editorUi.selectPage(editorUi.pages[1]));
	const before = await page.evaluate(() => ({
		page: editorUi.currentPage.getId(),
		xml: mxUtils.getXml(editorUi.editor.getGraphXml()),
		undo: editorUi.editor.undoManager.history.length,
	}));
	const r = await exportVisio(true);
	assert.equal(r.pages, 1);
	assert.ok(!("visio/pages/page2.xml" in r.files));
	assert.doesNotMatch(r.files["[Content_Types].xml"].data.toString(), /page2/);
	assert.match(r.files["visio/pages/pages.xml"].data.toString(), /Name="Overview"/);
	assert.match(r.files["visio/pages/page1.xml"].data.toString(), /Second page/);
	const after = await page.evaluate(() => ({
		page: editorUi.currentPage.getId(),
		xml: mxUtils.getXml(editorUi.editor.getGraphXml()),
		undo: editorUi.editor.undoManager.history.length,
	}));
	assert.deepEqual(after, before);
});

test("Visio export: label anchoring, directions, plain containers, data names and connector glue", async () => {
	const xml = `<mxfile><diagram id="q" name="Edge cases"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="left" value="Hi" style="text;html=1;align=left;verticalAlign=top;spacing=0;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="200" height="60" as="geometry"/></mxCell>
<mxCell id="west" value="West" style="triangle;whiteSpace=wrap;html=1;direction=west;" vertex="1" parent="1"><mxGeometry x="300" y="40" width="80" height="80" as="geometry"/></mxCell>
<mxCell id="south" value="South" style="shape=process;whiteSpace=wrap;html=1;direction=south;" vertex="1" parent="1"><mxGeometry x="420" y="40" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="plain" parent="1"/>
<mxCell id="a" value="Inside plain" style="whiteSpace=wrap;html=1;" vertex="1" parent="plain"><mxGeometry x="40" y="200" width="100" height="40" as="geometry"/></mxCell>
<object id="d" label="Data" Owner="x" owner="y"><mxCell style="whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="200" width="100" height="40" as="geometry"/></mxCell></object>
<mxCell id="e1" style="html=1;" edge="1" parent="1" source="a" target="d"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" style="html=1;" edge="1" parent="1" source="west" target="e1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
	inbox.length = 0;
	await send({ action: "load", xml, autosave: 1 });
	await page.waitForFunction(() => editorUi.editor.graph.model.getCell("e2") != null);
	const r = await exportVisio();
	const { shapes, connects } = await shapesOf(r.files["visio/pages/page1.xml"].data.toString());
	const num = (s, n) => parseFloat(s.cells[n]);
	const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} != ${b}`);
	const inch = 101.6;

	// A left/top aligned label: the text block's top-left corner is the label box's top-left corner.
	const left = byText(shapes, "Hi");
	const anchor = await page.evaluate(() => {
		const g = editorUi.editor.graph;
		const st = g.view.getState(g.model.getCell("left"));
		return { x: (st.text.bounds.x - st.x) / g.view.scale, y: (st.text.bounds.y - st.y) / g.view.scale };
	});
	near(num(left, "TxtLocPinX"), 0, "TxtLocPinX");
	near(num(left, "TxtLocPinY"), num(left, "TxtHeight"), "TxtLocPinY");
	near(num(left, "TxtPinX"), anchor.x / inch, "TxtPinX");
	near(num(left, "TxtPinY"), (60 - anchor.y) / inch, "TxtPinY");
	assert.equal(left.cells.VerticalAlign, "0");

	// direction turns the outline, never the label.
	const west = byText(shapes, "West");
	near(num(west, "Angle"), Math.PI, "west Angle");
	near(num(west, "TxtAngle"), Math.PI, "west TxtAngle");
	const south = byText(shapes, "South");
	near(num(south, "Width"), 60 / inch, "south Width");
	near(num(south, "Height"), 160 / inch, "south Height");
	near(num(south, "Angle") + num(south, "TxtAngle"), 2 * Math.PI, "south text upright");

	// Shapes inside a plain (non-shape) container cell are exported.
	const inside = byText(shapes, "Inside plain");
	assert.ok(inside, "shape in a plain container was dropped");

	// Visio row names are case-insensitive.
	const data = byText(shapes, "Data");
	assert.deepEqual(data.data, [["Owner", "x"], ["owner", "y"]]);
	const rowNames = await page.evaluate((xml) => {
		const doc = new DOMParser().parseFromString(xml, "application/xml");
		return Array.from(doc.getElementsByTagName("Row")).map((r) => r.getAttribute("N")).filter(Boolean);
	}, r.files["visio/pages/page1.xml"].data.toString());
	assert.equal(new Set(rowNames.map((n) => n.toLowerCase())).size, rowNames.length);

	// Connectors glue to shapes only; every trigger formula names a sheet on the page.
	const ids = new Set(flat(shapes).map((s) => s.id));
	const connectorIds = new Set(flat(shapes).filter((s) => s.master === "4").map((s) => s.id));
	assert.equal(connects.length, 3, JSON.stringify(connects));
	for (const [, , to] of connects) assert.ok(ids.has(to) && !connectorIds.has(to));
	for (const [, sheet] of r.files["visio/pages/page1.xml"].data.toString().matchAll(/_XFTRIGGER\(Sheet\.(\d+)!/g)) {
		assert.ok(ids.has(sheet) && !connectorIds.has(sheet), `trigger points at sheet ${sheet}`);
	}
});
