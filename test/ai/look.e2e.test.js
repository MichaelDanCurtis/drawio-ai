// End-to-end test of the editor tools and the look the extension shares with the desktop
// app: loads the real draw.io webapp with the extension's own webview HTML, the plugin
// bundle and the shared files (dist/custom-drawio-plugins/omni) in headless Chrome, with the
// page built the way DrawioClientFactory builds it (src/features/editorLook.ts).
//
// Prereqs: `git submodule update --init drawio` and `yarn build-plugins`.
// Run: node --test test/ai/look.e2e.test.js
// LOOK_SHOTS=<folder> saves screenshots of each state there.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs", target: "es2020" } });

const root = path.resolve(__dirname, "../..");
const { cleanLook, editorPluginPaths, fillTemplate, omniConfig, scriptLiteral } = require(path.join(root, "src/features/editorLook.ts"));
const webapp = path.join(root, "drawio/src/main/webapp");
const plugins = path.join(root, "dist/custom-drawio-plugins");
const shots = process.env.LOOK_SHOTS;

const MIME = {
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
	".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".xml": "application/xml",
	".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2",
};

let server, browser, base;
/** Page variants by name: what DrawioClientFactory would be given. */
const variants = new Map();

function editorHtml(v) {
	const look = cleanLook(v.look);
	const kind = { readOnly: !!v.readOnly, drawioTheme: v.drawioTheme || "kennedy" };
	const shim = `<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(typeof m === "string" ? m : JSON.stringify(m)) });</script>`;
	const template = fs.readFileSync(path.join(root, "src/DrawioClient/webview-content.html"), "utf8").replace("<head>", "<head>" + shim);
	return fillTemplate(template, {
		"literal-vsuri": `${base}/webapp`,
		theme: scriptLiteral(kind.drawioTheme),
		appearance: scriptLiteral("0"),
		dark: scriptLiteral(v.dark ? "1" : "0"),
		lang: scriptLiteral("en"),
		simpleLabels: scriptLiteral(false),
		chrome: scriptLiteral(v.readOnly ? "0" : "1"),
		customPluginPaths: scriptLiteral(editorPluginPaths(look, `${base}/plugins/omni`, `${base}/plugins/index.js`, kind)),
		localStorage: scriptLiteral(v.storage || {}),
		omniConfig: scriptLiteral(omniConfig(look, `${base}/plugins/omni`, kind)),
		additionalCode: scriptLiteral(v.code || []),
	});
}

/** Opens one editor page and gives the handles the tests drive it with. */
async function open(name, v) {
	variants.set(name, v);
	const inbox = [];
	const waiters = [];
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: v.dark ? "dark" : "light" });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const send = (action) => page.evaluate((m) => window.postMessage(m, "*"), JSON.stringify(action));
	await page.exposeFunction("__toHost", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.event === "configure") void send({ action: "configure", config: { compact: true } });
		inbox.push(msg);
		for (const w of [...waiters]) {
			if (w.match(msg)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(msg);
			}
		}
	});
	const waitFor = (match, timeout = 30000, fresh = false) => {
		const existing = fresh ? undefined : inbox.find(match);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const w = { match, resolve };
			waiters.push(w);
			setTimeout(() => {
				const i = waiters.indexOf(w);
				if (i >= 0) {
					waiters.splice(i, 1);
					reject(new Error(`Timed out waiting for a message (${name})`));
				}
			}, timeout);
		});
	};
	await page.goto(`${base}/editor/${name}.html`);
	await waitFor((m) => m.event === "init", 60000);
	await send({ action: "load", xml: v.xml || "", autosave: 1 });
	await waitFor((m) => m.event === "pluginLoaded" && m.pluginId === "ai");
	/** The tools' state as the page reports it now. */
	const state = async () => {
		const answer = waitFor((m) => m.event === "desktopState", 10000, true);
		await send({ action: "desktopReportState" });
		return (await answer).state;
	};
	const shot = async (file) => {
		if (!shots) return;
		fs.mkdirSync(shots, { recursive: true });
		await page.screenshot({ path: path.join(shots, file) });
	};
	return { page, inbox, errors, send, waitFor, state, shot };
}

/** Waits until `read()` gives something truthy. */
async function until(read, what, timeout = 15000) {
	const end = Date.now() + timeout;
	for (;;) {
		const v = await read();
		if (v) return v;
		if (Date.now() > end) throw new Error(`Timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 150));
	}
}

const TWO_PAGES =
	'<mxfile><diagram id="a" name="First"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="One" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="80" y="80" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
	'<diagram id="b" name="Second"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Two" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="120" width="120" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';

before(async () => {
	assert.ok(fs.existsSync(path.join(webapp, "index.html")), "drawio submodule missing");
	assert.ok(fs.existsSync(path.join(plugins, "omni/plugin/desktop-toolbar.js")), "build the plugins first (yarn build-plugins)");

	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		let file;
		const editor = /^\/editor\/([\w-]+)\.html$/.exec(url.pathname);
		if (editor && variants.has(editor[1])) {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(editorHtml(variants.get(editor[1])));
		}
		for (const [prefix, dir] of [["/plugins/", plugins], ["/webapp/", webapp]]) {
			if (!url.pathname.startsWith(prefix)) continue;
			file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
			if (!file.startsWith(dir)) {
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
});

after(async () => {
	await browser?.close();
	server?.close();
});

test("the editor gets the desktop app's toolbar, look, tooltips and matrix", async () => {
	const e = await open("default", { look: {}, xml: TWO_PAGES });
	// the tools say so themselves once they have loaded
	const first = (await e.waitFor((m) => m.event === "desktopState")).state;
	assert.equal(first.host, "vscode");
	assert.deepEqual(first.buttons, { mark: true, shapes: true, panels: 3, ruler: true, present: true, workshop: false, chat: false });
	assert.equal(first.icons, "dots2d");
	assert.equal(first.toolbar, "top");
	assert.equal(first.themed, true, "the theme plugin loaded");
	assert.equal(first.tips, true, "quick tooltips loaded");

	// the matrix and the Format panel's dot field are modules loaded from the shared folder
	const later = await until(async () => {
		const s = await e.state();
		return s.matrixMounted && s.formatDots ? s : null;
	}, "the matrix and the dot field");
	assert.equal(later.matrix, "grey");

	// the fonts come from the same folder
	const fonts = await e.page.evaluate(async () => (await document.fonts.load("500 13px 'Space Grotesk'")).length);
	assert.ok(fonts > 0, "Space Grotesk loaded");

	// names and hints fit VS Code: its own name, none of the desktop app's keyboard shortcuts
	const titles = await e.page.evaluate(() => ({
		mark: document.querySelector(".drawai-mark").getAttribute("title"),
		present: document.querySelector("[data-drawai='present']").getAttribute("title"),
	}));
	assert.equal(titles.mark, "Draw.AI · Settings");
	assert.match(titles.present, /^Presentation mode: /);
	await e.shot("vscode-light.png");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("the mark opens the settings, and draw.io keeps its own More Shapes dialog", async () => {
	const e = await open("buttons", { look: {} });
	await e.waitFor((m) => m.event === "desktopState");
	await e.page.click(".drawai-mark");
	assert.equal((await e.waitFor((m) => m.event === "desktopCommand")).command, "settings");

	// (the desktop app sends this button to its Shape Workshop; the extension has none yet)
	e.inbox.length = 0;
	await e.page.evaluate(() => editorUi.actions.get("shapes").funct());
	await until(() => e.page.evaluate(() => !!document.querySelector(".geDialog")), "draw.io's More Shapes dialog");
	assert.equal(e.inbox.some((m) => m.event === "desktopCommand" || m.event === "desktopShapeSets"), false);
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("icons, the matrix and the toolbar's place change in the open editor", async () => {
	const e = await open("prefs", { look: { icons: "dots", matrix: "green", toolbar: "left" }, dark: true });
	const first = (await e.waitFor((m) => m.event === "desktopState")).state;
	assert.equal(first.icons, "dots");
	assert.equal(first.matrix, "green");
	assert.equal(first.toolbar, "left");
	assert.equal(await e.page.evaluate(() => document.querySelector(".geEditor").classList.contains("drawai-tb-left")), true);
	await until(async () => (await e.state()).matrixMounted, "the matrix");
	await e.shot("vscode-dark-left-green.png");

	await e.send({ action: "desktopPrefs", iconStyle: "real", toolbar: "top", matrix: "off" });
	const next = await until(async () => {
		const s = await e.state();
		return s.icons === "real" ? s : null;
	}, "the new icon style");
	assert.equal(next.toolbar, "top");
	assert.equal(next.matrix, "off");
	assert.equal(await e.page.evaluate(() => document.documentElement.getAttribute("data-drawai-matrix")), "off");
	assert.equal(await e.page.evaluate(() => document.querySelector(".geEditor").classList.contains("drawai-tb-left")), false);
	await e.shot("vscode-dark-real.png");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("presentation mode starts from the toolbar, steps through the pages and leaves", async () => {
	const e = await open("present", { look: {}, xml: TWO_PAGES });
	await e.waitFor((m) => m.event === "desktopState");
	await e.page.click("[data-drawai='present']");
	assert.equal((await e.waitFor((m) => m.event === "desktopCommand" && m.command === "present")).command, "present");
	// (the extension answers the button: EditorLookFeature)
	await e.send({ action: "desktopPresentation", enabled: true });
	await until(() => e.page.evaluate(() => !!document.querySelector("#drawai-present-exit")), "the Exit button");
	assert.equal((await e.state()).presenting, true);
	const shown = () => e.page.evaluate(() => window.drawaiPresentation.state());
	assert.equal((await shown()).pages, 2);
	assert.deepEqual((await shown()).visibleChrome.filter((c) => !/drawai-present|matrix-layer/.test(c)), [], "only the diagram is shown");

	await e.page.click("#drawai-present-nav .next");
	await until(async () => (await shown()).page === 1, "the second page");
	await e.page.click("#drawai-present-nav .prev");
	await until(async () => (await shown()).page === 0, "the first page again");
	// the keys work too, and Esc asks the host to leave
	await e.page.keyboard.press("ArrowRight");
	await until(async () => (await shown()).page === 1, "the second page by key");
	await e.shot("vscode-presenting.png");

	await e.page.keyboard.press("Escape");
	await e.waitFor((m) => m.event === "desktopCommand" && m.command === "exitPresentation");
	e.inbox.length = 0;
	await e.page.click("#drawai-present-exit button");
	await e.waitFor((m) => m.event === "desktopCommand" && m.command === "exitPresentation");
	await e.send({ action: "desktopPresentation", enabled: false });
	await until(async () => !(await e.state()).presenting, "leaving presentation mode");
	assert.equal(await e.page.evaluate(() => !!document.querySelector("#drawai-present-exit")), false);
	// nothing was edited by presenting
	assert.equal(e.inbox.some((m) => m.event === "autosave" && !/One/.test(m.xml || "")), false);
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("draw.io's own colours stay with look.theme drawio; the tools stay", async () => {
	const e = await open("drawio", { look: { theme: "drawio" } });
	const s = (await e.waitFor((m) => m.event === "desktopState")).state;
	assert.equal(s.themed, false);
	assert.equal(s.buttons.present, true);
	await until(async () => (await e.state()).matrixMounted, "the matrix");
	await e.shot("vscode-drawio-theme.png");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("draw.io's sketch theme keeps its own toolbar and gets presentation mode", async () => {
	const e = await open("sketch", { look: { matrix: "green" }, drawioTheme: "sketch", xml: TWO_PAGES });
	const s = (await e.waitFor((m) => m.event === "desktopState")).state;
	assert.deepEqual(s.buttons, { mark: false, shapes: false, panels: 0, ruler: false, present: false, workshop: false, chat: false });
	assert.equal(s.themed, false);
	assert.equal(s.matrix, "off");
	assert.equal(await e.page.evaluate(() => !!document.querySelector(".matrix-layer")), false);
	await e.shot("vscode-sketch.png");
	// (started by the command Draw.AI: Presentation Mode)
	await e.send({ action: "desktopPresentation", enabled: true });
	await until(async () => (await e.state()).presenting, "presentation mode");
	const shown = await e.page.evaluate(() => window.drawaiPresentation.state());
	assert.deepEqual(shown.visibleChrome.filter((c) => !/drawai-present/.test(c)), [], "only the diagram is shown");
	await e.shot("vscode-sketch-presenting.png");
	await e.send({ action: "desktopPresentation", enabled: false });
	await until(async () => !(await e.state()).presenting, "leaving presentation mode");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("with the editor tools off the editor is as it was", async () => {
	const e = await open("off", { look: { editorTools: false } });
	// (the AI plugin has loaded: the tools would have by now)
	await new Promise((r) => setTimeout(r, 800));
	const page = await e.page.evaluate(() => ({
		config: window.omnidrawConfig,
		mark: !!document.querySelector(".drawai-mark"),
		themed: !!document.querySelector("#drawai-theme"),
		matrix: !!document.querySelector(".matrix-layer"),
		scripts: Array.from(document.scripts).filter((x) => /\/plugins\//.test(x.src)).length,
	}));
	assert.deepEqual(page, { config: null, mark: false, themed: false, matrix: false, scripts: 1 });
	assert.equal(e.inbox.some((m) => m.event === "desktopState"), false);
	await e.shot("vscode-tools-off.png");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});

test("text in draw.io's storage and in plugins cannot break or change the page", async () => {
	const nasty = "</script><script>window.__broken = 1</script> $& $1 $$omniConfig$$ $$additionalCode$$  ";
	const e = await open("storage", {
		look: {},
		storage: { ".note": nasty },
		code: ["window.__pluginRan = '$& </script> $$localStorage$$';"],
	});
	await e.waitFor((m) => m.event === "desktopState");
	const page = await e.page.evaluate(() => ({ note: localStorage.getItem(".note"), broken: window.__broken, ran: window.__pluginRan, host: window.omnidrawConfig.host }));
	assert.equal(page.note, nasty);
	assert.equal(page.broken, undefined);
	assert.equal(page.ran, "$& </script> $$localStorage$$");
	assert.equal(page.host, "vscode");
	assert.deepEqual(e.errors, []);
	await e.page.close();
});
