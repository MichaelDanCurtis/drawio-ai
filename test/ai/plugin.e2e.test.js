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
