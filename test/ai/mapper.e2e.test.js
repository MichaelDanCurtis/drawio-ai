// End-to-end test of the Map Something page as the VS Code extension shows it: the desktop
// app's page (dist/custom-drawio-plugins/omni/mapper.html) with its files' addresses and
// the postMessage bridge of src/features/mapper/mapperPage.ts, in headless Chrome, with the
// dialog logic both programs share (standalone/src/main/mapper/dialog.ts) behind it.
//
// Prereq: `yarn build-plugins`.
// Run: node --test test/ai/mapper.e2e.test.js
// MAPPER_SHOTS=<folder> saves screenshots there.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs", target: "es2022", esModuleInterop: true } });

const root = path.resolve(__dirname, "../..");
const { mapperPageHtml } = require(path.join(root, "src/features/mapper/mapperPage.ts"));
const { MapperDialogCore } = require(path.join(root, "standalone/src/main/mapper/dialog.ts"));
const omni = path.join(root, "dist/custom-drawio-plugins/omni");
const shots = process.env.MAPPER_SHOTS;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

let server, browser, base;

before(async () => {
	assert.ok(fs.existsSync(path.join(omni, "mapper.html")), "run `yarn build-plugins` first");
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		// (a browser asks for this by itself; a webview does not)
		if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
		if (url.pathname === "/page") {
			// what MapperFeature sets as the webview's HTML
			const html = mapperPageHtml(fs.readFileSync(path.join(omni, "mapper.html"), "utf8"), { nonce: "n0nce", cspSource: base, base: `${base}/ext/omni` });
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

/** Opens the page with the shared dialog logic behind it, as the extension's panel does. */
async function open({ dark = false, runs = [] } = {}) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme: "light" });
	const problems = [];
	page.on("console", (m) => (m.type() === "error" || /Content Security Policy/.test(m.text())) && problems.push(m.text()));
	page.on("pageerror", (e) => problems.push(String(e)));
	page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`));
	page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()}: ${r.url()}`));
	const asked = [];
	const picks = [];
	let saved = {};
	const core = new MapperDialogCore({
		post: (msg) => void page.evaluate((m) => window.postMessage(m, "*"), msg).catch(() => undefined),
		cwd: () => "/work/diagrams",
		ready: () => true,
		service: () => ({
			run: async (recipeId, input, opts) => {
				runs.push({ recipeId, input });
				opts.progress("Reading the folder…");
				// (the page shows progress while a map is being made)
				await page.waitForFunction(() => /Reading the folder…/.test(document.getElementById("log")?.textContent ?? "") && document.getElementById("run").disabled);
				return {
					record: { id: "m1", title: "Shop", graph: { nodes: [{ id: "a" }] }, findings: [{}] },
					result: { summary: "4 services and 3 connections", graph: { title: "Shop" }, warnings: ["docker-compose.yml: one service has no image"] },
					drawn: { cells: 12, newPage: true, page: "Shop" },
					badges: 1,
				};
			},
		}),
		context: () => ({ cwd: "/work/diagrams", signal: new AbortController().signal, progress: () => undefined, exec: async () => ({ stdout: "[]", stderr: "", code: 0 }) }),
		askAgent: (text) => asked.push(text),
		showChat: () => undefined,
		loadInputs: () => ({ ...saved }),
		saveInputs: (all) => (saved = all),
		pick: async (kind) => (picks.push(kind), "/picked/repo"),
		look: () => ({ iconStyle: "dots2d", matrix: "grey" }),
		close: () => picks.push("closed"),
	});
	// VS Code's webview API, and the class it puts on <body> for the colour theme
	await page.exposeFunction("__toHost", (msg) => void core.onMessage(msg));
	await page.addInitScript((isDark) => {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(m) });
		document.addEventListener("DOMContentLoaded", () => document.body.classList.add(isDark ? "vscode-dark" : "vscode-light"), { capture: true });
	}, dark);
	await page.goto(`${base}/page`);
	await page.waitForSelector("#cats .cat");
	return { page, problems, asked, picks, saved: () => saved };
}

test("the page loads its style sheets, scripts, modules and fonts from the extension's folder, and shows the catalog", async () => {
	const { page, problems } = await open();
	assert.deepEqual(await page.$$eval("#cats .cat > span:last-child > span", (els) => els.map((e) => e.textContent)), ["Software", "Databases", "Azure", "AWS", "Google Cloud", "Machine Learning"]);
	// Software is chosen, its first map is open with the diagram's folder filled in
	assert.ok((await page.$$eval("#recipes .recipe", (els) => els.length)) >= 5);
	assert.equal(await page.$eval("#form input[type=text]", (e) => e.value), "/work/diagrams");
	const look = await page.evaluate(async () => {
		await document.fonts.ready;
		const style = getComputedStyle(document.body);
		return {
			tokens: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
			font: style.fontFamily,
			grotesk: document.fonts.check('14px "Space Grotesk"'),
			icons: !!window.DrawAIIcons,
			brands: Object.keys(window.DrawAIBrands || {}).length,
			tips: !!window.DrawAITips,
			matrix: !!window.omnidrawMatrix,
			dotField: typeof window.drawaiPulse === "function",
			host: window.omnidrawConfig.host,
			theme: document.documentElement.dataset.theme,
			vendorLogos: document.querySelectorAll("#cats .ico.brand img").length,
			drawnIcons: document.querySelectorAll("#cats .ico:not(.brand) svg").length,
		};
	});
	assert.equal(look.tokens, "#f3f2ef", "tokens.css did not load");
	assert.match(look.font, /Space Grotesk/);
	assert.equal(look.grotesk, true, "the font file did not load");
	// (the vendors' logos for Azure, AWS and Google Cloud; drawn icons for the rest)
	assert.deepEqual([look.icons, look.tips, look.matrix, look.dotField, look.host, look.theme], [true, true, true, true, "vscode", "light"]);
	assert.deepEqual([look.vendorLogos, look.drawnIcons], [3, 3]);
	assert.ok(look.brands >= 3);
	assert.deepEqual(problems, []);
	if (shots) await page.waitForTimeout(700); // the lists rise in
	if (shots) await page.screenshot({ path: path.join(shots, "mapper-vscode-light.png") });
	await page.close();
});

test("VS Code's dark theme gives the page its black look", async () => {
	const { page, problems } = await open({ dark: true });
	assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#000000");
	// switching the theme in VS Code changes the class on <body>: the page follows
	await page.evaluate(() => document.body.classList.replace("vscode-dark", "vscode-light"));
	await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
	await page.evaluate(() => document.body.classList.replace("vscode-light", "vscode-dark"));
	await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
	await page.click("#cats .cat:nth-child(2)");
	await page.waitForFunction(() => document.querySelector("#form h2")?.textContent.includes("Database"));
	assert.deepEqual(problems, []);
	if (shots) await page.waitForTimeout(700); // the lists rise in
	if (shots) await page.screenshot({ path: path.join(shots, "mapper-vscode-dark.png") });
	await page.close();
});

test("Choose…, Map it and Close reach the extension, and the page shows progress, the result and its warnings", async () => {
	const runs = [];
	const { page, problems, asked, picks, saved } = await open({ runs });
	await page.click("#form .row button");
	await page.waitForFunction(() => document.querySelector("#form input[type=text]").value === "/picked/repo");
	assert.deepEqual(picks, ["folder"]);
	await page.click("#describe");
	await page.click("#run");
	await page.waitForSelector("#result.ok");
	assert.equal(runs.length, 1);
	assert.equal(runs[0].input.folder, "/picked/repo");
	const result = await page.$eval("#result", (e) => e.textContent);
	assert.match(result, /✓ 4 services and 3 connections Drew 12 cells on a new page "Shop".*1 finding\(s\) marked on the Health layer\. Handed to the agent in the chat\./);
	assert.match(result, /one service has no image/);
	// "describe every shape" went to the agent, and the inputs are remembered for next time
	assert.equal(asked.length, 1);
	assert.match(asked[0], /Write a plain-English description for every shape of the map "Shop" \(map id m1\)/);
	assert.equal(saved()[runs[0].recipeId].folder, "/picked/repo");
	await page.click("#cancel");
	await page.waitForFunction(() => true);
	assert.deepEqual(picks, ["folder", "closed"]);
	assert.deepEqual(problems, []);
	await page.close();
});

test("a database's secret fields are password fields, and a run with a required field empty is refused", async () => {
	const runs = [];
	const { page, problems } = await open({ runs });
	await page.click("#cats .cat:nth-child(2)");
	await page.waitForFunction(() => document.querySelector("#form h2")?.textContent.includes("Database"));
	const secret = await page.$$eval("#form .field", (fields) =>
		fields.filter((f) => /never stored or sent to the agent/.test(f.textContent)).map((f) => f.querySelector("input")?.type)
	);
	assert.ok(secret.length >= 1 && secret.every((t) => t === "password"), JSON.stringify(secret));
	// a required field is empty: the run is refused before anything is collected
	await page.click("#cats .cat:nth-child(1)");
	await page.waitForFunction(() => document.querySelector("#form input[type=text]")?.value === "/work/diagrams");
	await page.fill("#form input[type=text]", "");
	await page.click("#run");
	await page.waitForSelector("#result.err");
	assert.match(await page.$eval("#result", (e) => e.textContent), /^Fill in: /);
	assert.deepEqual(runs, []);
	assert.deepEqual(problems, []);
	await page.close();
});
