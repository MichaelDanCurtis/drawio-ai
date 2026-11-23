// End-to-end test of the Shape Workshop page as the VS Code extension shows it: the desktop
// app's page (dist/custom-drawio-plugins/omni/workshop.html) with its files' addresses and the
// postMessage bridge of src/features/omniPage.ts, in headless Chrome, with the page's other
// half (standalone/src/main/workshop/core.ts) and a real gallery service on a folder of shapes
// behind it. Nothing is downloaded.
//
// Prereq: `yarn build-plugins`.
// Run: node --test test/ai/workshop.e2e.test.js
// WORKSHOP_SHOTS=<folder> saves screenshots there.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs", target: "es2022", esModuleInterop: true } });

const root = path.resolve(__dirname, "../..");
const { workshopPageHtml } = require(path.join(root, "src/features/workshop/workshopPage.ts"));
const { WorkshopCore } = require(path.join(root, "standalone/src/main/workshop/core.ts"));
const { GalleryService } = require(path.join(root, "standalone/src/main/workshop/galleries.ts"));
const omni = path.join(root, "dist/custom-drawio-plugins/omni");
const shots = process.env.WORKSHOP_SHOTS;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const SVG = (colour) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${colour}"/></svg>`;

let server, browser, base;

before(async () => {
	assert.ok(fs.existsSync(path.join(omni, "workshop.html")), "run `yarn build-plugins` first");
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		// (a browser asks for this by itself; a webview does not)
		if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
		if (url.pathname === "/page") {
			// what WorkshopFeature sets as the webview's HTML
			const html = workshopPageHtml(fs.readFileSync(path.join(omni, "workshop.html"), "utf8"), { nonce: "n0nce", cspSource: base, base: `${base}/ext/omni` });
			res.writeHead(200, { "content-type": "text/html" });
			return void res.end(html);
		}
		const file = url.pathname.startsWith("/ext/omni/") ? path.join(omni, url.pathname.slice("/ext/omni/".length)) : undefined;
		if (!file || !file.startsWith(omni + path.sep) || !fs.existsSync(file)) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
	await browser?.close();
	server?.close();
});

/** Opens the page with the Workshop's other half behind it, as the extension's panel does. */
async function open({ dark = false, diagram = true } = {}) {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-workshop-e2e-"));
	const shapes = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-shapes-e2e-"));
	for (const [name, colour] of [["postgres", "#336791"], ["redis", "#d82c20"], ["kafka", "#222222"], ["nginx", "#009639"]]) fs.writeFileSync(path.join(shapes, `${name}.svg`), SVG(colour));
	const downloads = [];
	const service = new GalleryService(data, async (url) => {
		downloads.push(url);
		throw new Error("no downloads in this test");
	});
	let configs = [
		{ id: "mine", title: "My shapes", sources: [{ kind: "folder", path: shapes }], enabled: true },
		{ id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }, { kind: "simpleicons" }], enabled: false, builtin: true },
	];
	const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: "light" });
	const problems = [];
	page.on("console", (m) => (m.type() === "error" || /Content Security Policy/.test(m.text())) && problems.push(m.text()));
	page.on("pageerror", (e) => problems.push(String(e)));
	page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`));
	page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()}: ${r.url()}`));
	const inserted = [];
	const sets = [];
	const loaded = [];
	const shapeSets = [
		{ title: "Yours", entries: [{ id: ".scratchpad", title: "Scratchpad", on: false }] },
		{ title: "Standard", entries: [{ id: "general", title: "General", on: true }, { id: "uml", title: "UML", on: false }] },
	];
	const core = new WorkshopCore({
		post: (msg) => void page.evaluate((m) => window.postMessage(m, "*"), msg).catch(() => undefined),
		service: () => service,
		configs: () => configs,
		save: (next) => {
			configs = next;
			core.postState();
		},
		host: () =>
			diagram
				? {
						insert: async (shape) => (inserted.push(shape), "shop.drawio"),
						diagramName: () => "shop.drawio",
						shapeSets: () => shapeSets,
						setShapeSet: (id, on) => sets.push([id, on]),
						refreshShapeSets: () => undefined,
				  }
				: undefined,
		look: () => ({ iconStyle: "dots2d", matrix: "grey" }),
		version: () => "0.4.0",
		confirm: async () => true,
		pickLocal: async () => undefined,
		pickExport: async () => undefined,
		reveal: () => undefined,
		openExternal: () => undefined,
	});
	service.onChange(() => core.postState());
	// VS Code's webview API, and the class it puts on <body> for the colour theme
	await page.exposeFunction("__toHost", (msg) => {
		if (msg?.type === "pageLoaded") return void loaded.push(msg);
		void core.onMessage(msg).catch((e) => page.evaluate((m) => window.postMessage(m, "*"), { type: "error", message: String(e?.message ?? e) }));
	});
	await page.addInitScript((isDark) => {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(m) });
		document.addEventListener("DOMContentLoaded", () => document.body.classList.add(isDark ? "vscode-dark" : "vscode-light"), { capture: true });
	}, dark);
	await page.goto(`${base}/page`);
	await page.waitForSelector("#galleryList .gallery");
	return { page, problems, inserted, sets, loaded, downloads, configs: () => configs };
}

test("the Workshop page loads from the extension's folder, lists the galleries, finds a shape and puts it in the diagram", async () => {
	const w = await open();
	const { page } = w;
	assert.deepEqual(await page.$$eval("#galleryList .gallery", (els) => els.map((e) => [e.classList.contains("off"), /My shapes|Tech logos/.exec(e.textContent)?.[0]])), [[false, "My shapes"], [true, "Tech logos"]]);
	// the bridge's report: the five style sheets, the scripts, the module and the font
	await page.waitForFunction(() => true);
	const report = await (async () => {
		for (let i = 0; i < 50 && !w.loaded.length; i++) await new Promise((r) => setTimeout(r, 100));
		return w.loaded[0];
	})();
	assert.deepEqual([report.sheets, report.scripts, report.modules, report.font], [5, true, true, true], JSON.stringify(report));
	assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
	// the page says whose it is here
	assert.equal(await page.$eval(".head .label .label", (e) => e.textContent), "Draw.AI · Shape Workshop");

	await page.fill("#q", "redis");
	await page.waitForSelector("#grid .tile img[src^='data:image/svg+xml']");
	assert.deepEqual(await page.$$eval("#grid .tile", (els) => els.map((e) => e.getAttribute("title"))), ["redis · My shapes"]);
	await page.click("#grid .tile");
	await page.waitForFunction(() => /Added redis to shop\.drawio\./.test(document.getElementById("toasts").textContent));
	assert.equal(w.inserted.length, 1);
	assert.match(w.inserted[0].style, /^shape=image;.*image=data:image\/svg\+xml,/);

	// a gallery is switched on here, never by itself; this one would download, so the test only looks at the request to do it
	assert.deepEqual(w.downloads, []);
	assert.deepEqual(w.problems, []);
	if (shots) await page.waitForTimeout(600);
	if (shots) await page.screenshot({ path: path.join(shots, "workshop-vscode-light.png") });
	await page.close();
});

test("draw.io's shape sets are switches in the Workshop, and the dark theme follows VS Code", async () => {
	const w = await open({ dark: true });
	const { page } = w;
	assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#000000");
	await page.waitForSelector("#shapeSets label.set");
	assert.deepEqual(await page.$$eval("#shapeSets label.set", (els) => els.map((e) => [e.dataset.set, e.querySelector("input").checked])), [[".scratchpad", false], ["general", true], ["uml", false]]);
	await page.evaluate(() => document.querySelectorAll("#shapeSets details").forEach((d) => (d.open = true)));
	await page.click('#shapeSets label.set[data-set="uml"] input');
	await page.click('#shapeSets label.set[data-set=".scratchpad"] input');
	for (let i = 0; i < 40 && w.sets.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(w.sets, [["uml", true], [".scratchpad", true]]);
	assert.deepEqual(w.problems, []);
	if (shots) await page.waitForTimeout(600);
	if (shots) await page.screenshot({ path: path.join(shots, "workshop-vscode-dark.png") });
	await page.close();
});

test("with no diagram open the Workshop says so, and a shape is not put anywhere", async () => {
	const w = await open({ diagram: false });
	const { page } = w;
	await page.waitForFunction(() => /Open a diagram to choose/.test(document.getElementById("shapeSets").textContent));
	await page.fill("#q", "kafka");
	await page.waitForSelector("#grid .tile");
	await page.click("#grid .tile");
	await page.waitForFunction(() => /Open a diagram first\./.test(document.getElementById("toasts").textContent));
	assert.deepEqual(w.inserted, []);
	assert.deepEqual(w.problems, []);
	await page.close();
});
