// Feasibility spike (not product code): drive the real draw.io webapp and the
// Draw.AI webview plugin in headless Chrome, without VS Code, through the same
// JSON message protocol DrawioClient uses. Proves a standalone MCP server for
// Claude Code / Codex can reuse every webview-backed tool unchanged.
//
// Prereqs: drawio/src present, `yarn build-plugins`.
// Run: node spikes/headless-host/headless.js <in.drawio> <outDir>
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "../..");
const webapp = path.join(root, "drawio/src/main/webapp");
const pluginBundle = path.join(root, "dist/custom-drawio-plugins/index.js");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".xml": "application/xml", ".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2" };

class HeadlessDrawio {
	constructor() {
		this.inbox = [];
		this.waiters = [];
		this.nextId = 1;
		this.requests = [];
	}

	editorHtml(base) {
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

	onHostMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.event === "configure") this.send({ action: "configure", config: {} });
		this.inbox.push(msg);
		for (const w of [...this.waiters]) {
			if (w.match(msg)) {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.resolve(msg);
			}
		}
	}

	waitFor(match, timeout = 30000) {
		const i = this.inbox.findIndex(match);
		if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
		return new Promise((resolve, reject) => {
			const w = { match, resolve };
			this.waiters.push(w);
			setTimeout(() => {
				const j = this.waiters.indexOf(w);
				if (j >= 0) {
					this.waiters.splice(j, 1);
					reject(new Error("Timed out waiting for message"));
				}
			}, timeout);
		});
	}

	send(action) {
		return this.page.evaluate((m) => window.postMessage(m, "*"), JSON.stringify(action));
	}

	async request(action, timeout) {
		const actionId = `h${this.nextId++}`;
		const response = this.waitFor((m) => m.message && m.message.actionId === actionId, timeout);
		await this.send({ ...action, actionId });
		return response;
	}

	async start() {
		this.server = http.createServer((req, res) => {
			const url = new URL(req.url, "http://x");
			this.requests.push(url.pathname);
			let file;
			if (url.pathname === "/editor.html") {
				res.writeHead(200, { "content-type": "text/html" });
				return res.end(this.editorHtml(this.base));
			} else if (url.pathname === "/plugin.js") {
				file = pluginBundle;
			} else if (url.pathname.startsWith("/webapp/")) {
				file = path.join(webapp, decodeURIComponent(url.pathname.slice("/webapp/".length)));
				if (!file.startsWith(webapp + path.sep)) {
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
		await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
		this.base = `http://127.0.0.1:${this.server.address().port}`;
		this.browser = await chromium.launch({ channel: "chrome", headless: true });
		const context = await this.browser.newContext({ viewport: { width: 1400, height: 900 } });
		// Offline guarantee: block every request that is not to our own loopback server.
		this.blocked = [];
		await context.route("**/*", (route) => {
			const u = route.request().url();
			if (u.startsWith(this.base + "/") || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
			this.blocked.push(u);
			return route.abort();
		});
		this.page = await context.newPage();
		this.page.on("pageerror", (e) => console.error("[page error]", e.message));
		await this.page.exposeFunction("__toHost", (m) => this.onHostMessage(m));
		await this.page.goto(`${this.base}/editor.html`);
		await this.waitFor((m) => m.event === "init", 60000);
	}

	async load(xml) {
		await this.send({ action: "load", xml, autosave: 1 });
		await this.waitFor((m) => m.event === "pluginLoaded" && m.pluginId === "ai", 30000);
	}

	async getXml() {
		// Same as DrawioClient.getXml: export as xml.
		const r = await this.request({ action: "export", format: "xml" });
		return r.xml ?? r.data;
	}

	close() {
		return Promise.all([this.browser?.close(), new Promise((r) => (this.server ? this.server.close(r) : r()))]);
	}
}

async function main() {
	const [input, outDir] = process.argv.slice(2);
	if (!input || !outDir) throw new Error("usage: headless.js <in.drawio> <outDir>");
	fs.mkdirSync(outDir, { recursive: true });
	const t0 = Date.now();
	const h = new HeadlessDrawio();
	await h.start();
	const tInit = Date.now();
	await h.load(fs.readFileSync(input, "utf8"));
	const tLoad = Date.now();
	const log = (k, v) => console.log(`${k.padEnd(14)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
	log("startup", `${tInit - t0} ms (browser + draw.io init), load ${tLoad - tInit} ms`);

	const model = (await h.request({ action: "aiGetModel", scope: "page", includeStyles: true, maxCells: 400 })).model;
	log("aiGetModel", `${model.totalCells} cells, e.g. ${model.cells.slice(0, 3).map((c) => c.label || c.id).join(", ")}`);

	const shapes = (await h.request({ action: "aiSearchShapes", query: "aws lambda", limit: 3 })).shapes;
	log("aiSearchShapes", shapes.map((s) => `${s.title} (${(s.style || "").slice(0, 40)}…)`));

	const first = model.cells.find((c) => c.kind === "vertex");
	const applied = await h.request(
		{
			action: "aiApplyOps",
			atomic: true,
			flash: false,
			selectResult: false,
			review: false,
			ops: [
				{ op: "addShape", tempId: "$fn", label: "Headless Lambda", style: shapes[0]?.style, width: 78, height: 78, ...(first ? { placement: { relativeTo: first.id, side: "below" } } : { x: 40, y: 40 }) },
				...(first ? [{ op: "addEdge", source: first.id, target: "$fn", label: "invokes" }] : []),
			],
		},
		120000
	);
	log("aiApplyOps", { rolledBack: applied.rolledBack, results: applied.results.map((r) => r.ok), idMap: applied.idMap });

	const lintModel = (await h.request({ action: "aiGetModel", scope: "page", includeStyles: true, maxCells: 20000 })).model;
	log("model after", `${lintModel.totalCells} cells`);

	const img = await h.request({ action: "aiExportImage", cellIds: [], maxSize: 1200 });
	const png = Buffer.from(String(img.dataUrl).replace(/^data:image\/png;base64,/, ""), "base64");
	fs.writeFileSync(path.join(outDir, "render.png"), png);
	log("aiExportImage", `${png.length} bytes -> render.png`);

	const vsdx = await h.request({ action: "aiExportVsdx", currentPageOnly: false }, 120000);
	if (vsdx.error) throw new Error(vsdx.error);
	fs.writeFileSync(path.join(outDir, "export.vsdx"), Buffer.from(vsdx.data, "base64"));
	log("aiExportVsdx", { pages: vsdx.pages, shapes: vsdx.shapes, connectors: vsdx.connectors, warnings: (vsdx.warnings || []).length });

	const autosave = h.inbox.filter((m) => m.event === "autosave").pop();
	const xml = autosave?.xml ?? (await h.getXml());
	fs.writeFileSync(path.join(outDir, "edited.drawio"), xml);
	log("saved xml", `${xml.length} chars, contains new shape: ${xml.includes("Headless Lambda")}`);
	log("network", `served ${h.requests.length} local requests; blocked external: ${h.blocked.length ? h.blocked.slice(0, 5).join(", ") : "none"}`);
	log("total", `${Date.now() - t0} ms`);
	await h.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
