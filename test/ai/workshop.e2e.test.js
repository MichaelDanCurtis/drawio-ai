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
async function open({ dark = false, diagram = true, shifter = false, creator = false } = {}) {
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
	// what the Shape Creator's scripted agent was asked and saw
	const drawing = { opened: [], prompts: [], looked: [] };
	const ICON = (fill, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="${10 + n}" width="36" height="24" rx="4" fill="${fill}"/></svg>`;
	// the Shape Shifter's side of a diagram, faked: two of draw.io's shapes, one selected cell, a stencil of three shapes
	const applied = [];
	const askedAgent = [];
	const selected = [{ id: "c1", style: "rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#333333;", edge: false }];
	const thumb = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="8" y="16" width="48" height="32" fill="#ffffff" stroke="#000000"/></svg>';
	const shifterHost = {
		searchBuiltIn: async (query) => [{ title: "Process", library: "general", style: "rounded=1;whiteSpace=wrap;html=1;", width: 120, height: 60, preview: thumb }, { title: `Decision for ${query}`, library: "flowchart", style: "rhombus;whiteSpace=wrap;html=1;", width: 80, height: 80, preview: thumb }],
		selectedCells: async () => selected,
		applyStyles: async (edits) => {
			applied.push(...edits);
			for (const e of edits) for (const c of selected) if (c.id === e.id) for (const [k, v] of Object.entries(e.props)) c.style = c.style.replace(new RegExp(`${k}=[^;]*;`), "") + `${k}=${v};`;
		},
		askAgent: async (request, shown) => void askedAgent.push({ request, shown }),
		convertStencil: async () => ({ library: `<mxlibrary>${JSON.stringify([1, 2, 3].map((n) => ({ xml: `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="" style="rounded=${n};" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>`, w: 80, h: 40, title: `Router ${n}` })))}</mxlibrary>`, warnings: [] }),
	};
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
						...(shifter ? { shifter: shifterHost } : {}),
				  }
				: undefined,
		look: () => ({ iconStyle: "dots2d", matrix: "grey" }),
		version: () => "0.4.0",
		confirm: async () => true,
		pickLocal: async () => undefined,
		pickExport: async () => undefined,
		reveal: () => undefined,
		openExternal: () => undefined,
		// as the extension has it: a gallery that is off downloads nothing
		offStaysOff: true,
		// as the desktop app has it: the Shape Shifter
		...(shifter ? { shifter: true, pickStencil: async () => "/stencils/Network.vssx" } : {}),
		// ... and the Shape Creator, with a scripted agent: it looks at its icon, hands in one per variation, and says so
		...(creator
			? {
					creator: {
						agents: () => [
							{ id: "ready", label: "Ready agent", ready: true, models: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }], model: "small" },
							{ id: "broken", label: "Broken agent", ready: false, problem: "Broken agent is not installed.", models: [] },
						],
						open: async (o) => {
							drawing.opened.push({ agent: o.agent, model: o.model });
							let stop;
							return {
								label: "Ready agent",
								images: true,
								prompt: async (text, images) => {
									drawing.prompts.push({ text, images });
									o.onText("Drawing… ");
									if (/slowly/.test(text)) return new Promise((r) => (stop = () => r("cancelled")));
									const n = drawing.prompts.length;
									drawing.looked.push(await o.tools.call("workshop_render_preview", { svg: ICON("#141414", 0) }));
									for (let i = 0; i < (/three variations/.test(text) ? 3 : 1); i++) {
										await o.tools.call("workshop_submit_svg", { svg: ICON("var(--fill, #141414)", i + n * 4), name: /^Change the icon/.test(text) ? `Revised ${i + 1}` : `Balancer ${i + 1}`, tags: ["network", "lb"] });
									}
									o.onText("done.");
									return "end_turn";
								},
								cancel: () => stop?.(),
								dispose: () => undefined,
							};
						},
					},
			  }
			: {}),
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
	return { page, problems, inserted, sets, loaded, downloads, applied, askedAgent, selected, service, drawing, configs: () => configs };
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

	// a gallery that is off stays off: clicking its card (to browse it) says so and downloads nothing
	await page.click("#galleryList .gallery.off");
	await page.waitForFunction(() => /“Tech logos” is off\. Switch it on to use it/.test(document.getElementById("toasts").textContent));
	assert.equal(await page.$$eval("#grid .tile", (els) => els.length), 0);
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

test("the Shape Shifter is off where the program has none (the extension, for now), and on where it has", async () => {
	const none = await open();
	assert.equal(await none.page.$eval('nav button[data-mode="shifter"]', (b) => b.disabled), true);
	assert.equal(await none.page.$eval('nav button[data-mode="shifter"] .tag', (t) => t.textContent), "Next");
	assert.equal(await none.page.$eval("#shifterCol", (c) => c.classList.contains("hidden")), true);
	await none.page.close();

	const w = await open({ shifter: true });
	const { page } = w;
	await page.waitForFunction(() => !document.querySelector('nav button[data-mode="shifter"]').disabled);
	await page.click('nav button[data-mode="shifter"]');
	assert.equal(await page.$eval("#galleryCol", (c) => c.classList.contains("hidden")), true);
	assert.equal(await page.$eval("#shifterCol", (c) => c.classList.contains("hidden")), false);

	// find: draw.io's own shapes and the galleries' in one answer, in two groups
	await page.fill("#q", "redis");
	await page.waitForSelector('#grid .tile[data-key^="own:"] img');
	await page.waitForSelector("#grid .tile:not([data-key^='own:']) img[src^='data:image/svg+xml']");
	assert.deepEqual(await page.$$eval("#grid .group", (els) => els.map((e) => e.textContent)), ["draw.io's own shapes · 2", "From your galleries · 1"]);
	assert.deepEqual(await page.$$eval("#grid .tile", (els) => els.map((e) => e.getAttribute("title"))), ["Process · general · draw.io", "Decision for redis · flowchart · draw.io", "redis · My shapes"]);
	assert.equal(await page.$eval("#scope .label", (e) => e.textContent), "In draw.io's own shapes and 1 gallery");
	// one of draw.io's shapes goes into the diagram as it is; a gallery's as an image
	await page.click('#grid .tile[data-key^="own:"]');
	await page.waitForFunction(() => /Added Process to shop\.drawio\./.test(document.getElementById("toasts").textContent));
	assert.deepEqual(w.inserted[0], { style: "rounded=1;whiteSpace=wrap;html=1;", w: 120, h: 60, title: "Process" });
	await page.click("#grid .tile:not([data-key^='own:'])");
	await page.waitForFunction(() => /Added redis to shop\.drawio\./.test(document.getElementById("toasts").textContent));
	assert.match(w.inserted[1].style, /^shape=image;/);

	// change a shape: the selection's colours show, a new one is applied to what is selected
	await page.waitForFunction(() => /^1 shape selected in shop\.drawio\.$/.test(document.getElementById("selInfo").textContent));
	assert.equal(await page.$eval('#changeShape input[data-colour="fill"]', (i) => i.value), "#dae8fc");
	assert.equal(await page.$eval("#iconRow", (r) => r.classList.contains("hidden")), true);
	await page.$eval('#changeShape input[data-colour="fill"]', (i) => { i.value = "#ff8800"; i.dispatchEvent(new Event("change")); });
	await page.waitForFunction(() => /Changed 1 shape\./.test(document.getElementById("toasts").textContent));
	assert.deepEqual(w.applied, [{ id: "c1", props: { fillColor: "#ff8800" } }]);
	await page.click('#changeShape button[data-none="stroke"]');
	for (let i = 0; i < 40 && w.applied.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(w.applied[1], { id: "c1", props: { strokeColor: "none" } });
	// ... or described, for the agent
	await page.fill("#describe", "make it rounded with a soft blue fill");
	await page.click("#describeGo");
	for (let i = 0; i < 40 && !w.askedAgent.length; i++) await new Promise((r) => setTimeout(r, 50));
	assert.match(w.askedAgent[0].request, /^Change the selected shape like this: make it rounded with a soft blue fill\n/);
	assert.match(w.askedAgent[0].request, /keep their text, their place and their connections/);
	if (shots) await page.waitForTimeout(600);
	if (shots) await page.screenshot({ path: path.join(shots, "workshop-shifter.png") });

	// a Visio stencil: converted, named, and then a collection of the user's own in the Gallery
	await page.click("#importStencil");
	await page.waitForFunction(() => document.getElementById("ask").open);
	assert.equal(await page.$eval("#askTitle", (e) => e.textContent), "Import 3 shapes");
	assert.match(await page.$eval("#askText", (e) => e.textContent), /^From Network: Router 1, Router 2, Router 3 /);
	// (Enter in the field is OK, not the form's first button, which is Cancel)
	await page.fill("#askInput", "Network kit");
	await page.press("#askInput", "Enter");
	await page.waitForFunction(() => /3 shapes are in the new collection “Network kit”\./.test(document.getElementById("toasts").textContent));
	const col = w.configs().find((g) => g.title === "Network kit");
	assert.deepEqual([col.id, col.sources, col.enabled], ["network-kit", [{ kind: "collection" }], true]);
	assert.deepEqual((await w.service.items(col)).map((i) => i.title), ["Router 1", "Router 2", "Router 3"]);
	// the Gallery shows it
	await page.waitForFunction(() => document.querySelector('nav button[data-mode="gallery"]').classList.contains("active") && document.querySelectorAll("#grid .tile").length === 3);
	// Esc at the name is Cancel, whatever the dialog answered last: the stencil is dropped
	await page.click('nav button[data-mode="shifter"]');
	await page.click("#importStencil");
	await page.waitForFunction(() => document.getElementById("ask").open);
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !document.getElementById("ask").open);
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(w.configs().filter((g) => g.sources.some((src) => src.kind === "collection")).map((g) => g.title), ["Network kit"]);
	// a question that arrives while another is open waits its turn, and is asked, not answered by the first one's OK
	await page.click('nav button[data-mode="gallery"]');
	await page.click("#newCollection");
	await page.waitForFunction(() => document.getElementById("ask").open && document.getElementById("askTitle").textContent === "New collection");
	await page.evaluate(() => document.getElementById("importStencil").click());
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(await page.$eval("#askTitle", (e) => e.textContent), "New collection");
	await page.fill("#askInput", "First");
	await page.click("#askOk");
	await page.waitForFunction(() => document.getElementById("ask").open && document.getElementById("askTitle").textContent === "Import 3 shapes");
	assert.equal(await page.$eval("#askInput", (i) => i.value), "Network");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(await page.$eval("#ask", (d) => d.open), true, "the second question is still open");
	await page.fill("#askInput", "Second");
	await page.click("#askOk");
	await page.waitForFunction(() => /3 shapes are in the new collection “Second”\./.test(document.getElementById("toasts").textContent));
	assert.deepEqual(w.configs().filter((g) => g.sources.some((src) => src.kind === "collection")).map((g) => g.title).sort(), ["First", "Network kit", "Second"]);
	assert.deepEqual(w.problems, []);
	assert.deepEqual(w.downloads, []);
	await page.close();
});

test("the Shape Creator is off where the program has none, and on where it has: describe, look, insert, save, change", async () => {
	const none = await open();
	assert.equal(await none.page.$eval('nav button[data-mode="creator"]', (b) => b.disabled), true);
	assert.equal(await none.page.$eval('nav button[data-mode="creator"] .tag', (t) => t.textContent), "Next");
	assert.equal(await none.page.$eval("#creatorCol", (c) => c.classList.contains("hidden")), true);
	await none.page.close();

	const w = await open({ creator: true });
	const { page } = w;
	await page.waitForFunction(() => !document.querySelector('nav button[data-mode="creator"]').disabled);
	await page.click('nav button[data-mode="creator"]');
	assert.deepEqual(await page.$$eval("#galleryCol, #shifterCol, #creatorCol", (els) => els.map((e) => e.classList.contains("hidden"))), [true, true, false]);
	assert.equal(await page.$eval("#grid", (g) => getComputedStyle(g).display), "none");
	assert.match(await page.$eval("#creatorOut", (o) => o.textContent), /Describe an icon, and an agent draws it/);
	// the agents of this computer, the ready one chosen, with its models
	await page.waitForFunction(() => document.querySelectorAll("#crAgent option").length === 2);
	assert.deepEqual(await page.$$eval("#crAgent option", (els) => els.map((e) => [e.value, e.textContent])), [["ready", "Ready agent"], ["broken", "Broken agent (not ready)"]]);
	assert.deepEqual(await page.$$eval("#crModel option", (els) => els.map((e) => e.textContent)), ["The agent's own choice", "Small", "Large"]);
	assert.deepEqual([await page.$eval("#crAgent", (e) => e.value), await page.$eval("#crModel", (e) => e.value)], ["ready", "small"]);
	// an agent that cannot be started says why, and cannot be asked
	await page.selectOption("#crAgent", "broken");
	assert.deepEqual([await page.$eval("#crProblem", (e) => e.textContent), await page.$eval("#crGo", (b) => b.disabled), await page.$eval("#crModelRow", (r) => r.classList.contains("hidden"))], ["Broken agent is not installed.", true, true]);
	await page.selectOption("#crAgent", "ready");
	assert.equal(await page.$eval("#crGo", (b) => b.disabled), false);

	// describe it, attach an image that shows what is meant, ask for three
	await page.click("#crGo");
	assert.equal(w.drawing.prompts.length, 0, "nothing is asked without a description");
	await page.fill("#crPrompt", "a load balancer");
	await page.selectOption("#crStyle", "line");
	await page.selectOption("#crCount", "3");
	await page.setInputFiles("#crFile", { name: "sketch.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
	await page.setInputFiles("#crFile", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
	await page.waitForFunction(() => document.querySelectorAll("#crImages .thumb").length === 1 && /notes\.txt is not a PNG/.test(document.getElementById("toasts").textContent));
	await page.click("#crGo");
	await page.waitForFunction(() => document.querySelectorAll("#creatorOut .made").length === 3);
	assert.deepEqual(w.drawing.opened, [{ agent: "ready", model: "small" }]);
	assert.match(w.drawing.prompts[0].text, /What to draw: a load balancer[\s\S]*The attached image shows[\s\S]*Look: Draw it as an outline[\s\S]*Hand in three variations/);
	assert.deepEqual(w.drawing.prompts[0].images.map((i) => [i.mimeType, i.base64.slice(0, 11)]), [["image/png", "iVBORw0KGgo"]]);
	// the agent looked at its work: this page drew the picture for it
	assert.equal(w.drawing.looked[0].isError, undefined, w.drawing.looked[0].text);
	const png = Buffer.from(w.drawing.looked[0].image.base64, "base64");
	assert.deepEqual([w.drawing.looked[0].image.mimeType, png.subarray(1, 4).toString("latin1"), png.readUInt32BE(16), png.readUInt32BE(20)], ["image/png", "PNG", 384, 384]);
	// newest first, each at three sizes on white and on black
	assert.deepEqual(await page.$$eval("#creatorOut .made .row1 b", (els) => els.map((e) => e.textContent)), ["Balancer 3", "Balancer 2", "Balancer 1"]);
	assert.deepEqual(await page.$$eval("#creatorOut .made:first-child .strip", (els) => els.map((e) => [e.className, [...e.querySelectorAll("img")].map((i) => i.width + (i.src.startsWith("data:image/svg+xml;base64,") && i.naturalWidth > 0 ? "" : "!"))])), [["strip paper", ["16", "24", "64"]], ["strip black", ["16", "24", "64"]]]);
	assert.equal(await page.$eval("#creatorOut .made .tags", (e) => e.textContent), "network · lb");
	await page.waitForFunction(() => !document.getElementById("crGo").classList.contains("hidden"));
	assert.match(await page.$eval("#crSaid", (e) => e.textContent), /^Starting Ready agent…\nDrawing… done\.$/);
	if (shots) await page.waitForTimeout(700);
	if (shots) await page.screenshot({ path: path.join(shots, "workshop-creator.png") });

	// into the diagram, and kept in My shapes
	await page.click('#creatorOut .made:first-child button[data-do="insert"]');
	await page.waitForFunction(() => /Added Balancer 3 to shop\.drawio\./.test(document.getElementById("toasts").textContent));
	assert.match(w.inserted[0].style, /^shape=image;html=1;.*image=data:image\/svg\+xml,/);
	await page.click('#creatorOut .made:first-child button[data-do="save"]');
	await page.click('#menu button:has-text("My shapes")');
	await page.waitForFunction(() => /Saved Balancer 3 to My shapes\./.test(document.getElementById("toasts").textContent));
	const mine = w.configs().find((g) => g.id === "my-shapes");
	assert.deepEqual((await w.service.items(mine)).map((i) => i.title), ["Balancer 3"]);
	await page.click('#creatorOut .made:first-child button[data-do="copy"]');
	await page.waitForFunction(() => /Copied the SVG\./.test(document.getElementById("toasts").textContent));

	// the source can be edited: what is applied is cleaned, and the pictures follow
	const before = await page.$eval("#creatorOut .made:first-child img", (i) => i.src);
	await page.click('#creatorOut .made:first-child button[data-do="source"]');
	const source = await page.$eval("#creatorOut .made:first-child .source", (t) => t.value);
	assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48"><rect /);
	await page.fill("#creatorOut .made:first-child .source", source.replace("<rect", '<script>alert(1)</script><rect onclick="x()" stroke="#ff0000"'));
	await page.click('#creatorOut .made:first-child .sourcebox button');
	await page.waitForFunction((old) => document.querySelector("#creatorOut .made:first-child img").src !== old, before);
	const applied = await page.$eval("#creatorOut .made:first-child .source", (t) => t.value);
	assert.match(applied, /stroke="#ff0000"/);
	assert.doesNotMatch(applied, /script|onclick/);
	assert.equal(await page.$eval("#creatorOut .made:first-child .sourcebox", (b) => b.classList.contains("hidden")), false, "the source stays open");
	await page.fill("#creatorOut .made:first-child .source", "<p>not an svg</p>");
	await page.click('#creatorOut .made:first-child .sourcebox button');
	await page.waitForFunction(() => /not an SVG this app accepts/.test(document.getElementById("toasts").textContent));

	// ask for a change: the agent gets it with the icon as it is now, and hands in a new one
	await page.fill("#creatorOut .made:first-child .revise input", "thicker lines");
	await page.press("#creatorOut .made:first-child .revise input", "Enter");
	await page.waitForFunction(() => document.querySelectorAll("#creatorOut .made").length === 4);
	assert.equal(w.drawing.opened.length, 1, "the same agent, still running");
	assert.match(w.drawing.prompts[1].text, /^Change the icon “Balancer 3” like this: thicker lines\n\nThe icon as it is now[\s\S]*stroke="#ff0000"/);
	assert.equal(await page.$eval("#creatorOut .made:first-child .row1 b", (e) => e.textContent), "Revised 1");
	await page.click('#creatorOut .made:first-child button[data-do="remove"]');
	assert.equal(await page.$$eval("#creatorOut .made", (els) => els.length), 3);

	// a request can be stopped
	await page.waitForFunction(() => !document.getElementById("crGo").classList.contains("hidden"));
	await page.fill("#crPrompt", "a firewall, slowly");
	await page.selectOption("#crCount", "1");
	await page.click("#crGo");
	await page.waitForFunction(() => !document.getElementById("crStop").classList.contains("hidden") && /Drawing…/.test(document.getElementById("crSaid").textContent));
	assert.deepEqual(await page.$$eval("#crGo, #creatorOut .made:first-child .revise input", (els) => els.map((e) => e.classList.contains("hidden") || e.disabled)), [true, true]);
	await page.click("#crStop");
	await page.waitForFunction(() => /Stopped\./.test(document.getElementById("toasts").textContent) && document.getElementById("crStop").classList.contains("hidden"));
	assert.equal(await page.$$eval("#creatorOut .made", (els) => els.length), 3);

	// the other tabs are as they were, and what was drawn is still here on coming back
	await page.click('nav button[data-mode="gallery"]');
	assert.deepEqual([await page.$eval("#grid", (g) => getComputedStyle(g).display), await page.$eval("#creatorOut", (o) => getComputedStyle(o).display)], ["grid", "none"]);
	await page.click('nav button[data-mode="creator"]');
	assert.equal(await page.$$eval("#creatorOut .made", (els) => els.length), 3);
	assert.deepEqual(w.problems, []);
	assert.deepEqual(w.downloads, []);
	await page.close();
});
