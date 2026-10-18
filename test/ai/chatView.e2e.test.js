// Loads the real chat panel HTML (with its CSP) in headless Chrome, stubs the VS Code
// webview API and drives it with the messages ChatViewProvider sends.
// Run: node --test test/ai/chatView.e2e.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright-core");

let browser, page, server;
const posted = [];
const errors = [];

const state = (overrides = {}) => ({
	file: "arch.drawio",
	selectionCount: 0,
	lassoActive: false,
	busy: false,
	transcript: [],
	transcriptVersion: 1,
	providers: [
		{ id: "vscode-lm", label: "VS Code / Copilot models" },
		{ id: "anthropic", label: "Anthropic (API key)" },
	],
	providerId: "vscode-lm",
	models: [{ id: "m1", name: "Model One", vision: true }],
	modelId: "m1",
	...overrides,
});

// postMessage is delivered as a task; the timeout task queued after it runs once it was handled.
const post = (msg) =>
	page.evaluate((m) => {
		window.postMessage(m, "*");
		return new Promise((r) => setTimeout(r, 0));
	}, msg);
const text = (sel) => page.locator(sel).innerText();

before(async () => {
	const html = fs
		.readFileSync(path.resolve(__dirname, "../../src/features/ai/chatView.html"), "utf8")
		.replace(/\$\$nonce\$\$/g, "testnonce")
		.replace(/\$\$cspSource\$\$/g, "'self'");
	// Served over http so the CSP meta tag is enforced exactly as in the webview.
	server = http.createServer((_, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(html);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));

	browser = await chromium.launch({ channel: "chrome", headless: true });
	page = await browser.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.exposeFunction("__post", (m) => posted.push(m));
	await page.addInitScript(() => {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__post(m) });
	});
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	await page.waitForFunction(() => document.getElementById("send"));
});

after(async () => {
	await browser?.close();
	server?.close();
});

test("announces readiness and renders state", async () => {
	assert.ok(posted.some((m) => m.type === "ready"));
	await post({ type: "state", state: state({ selectionCount: 3 }) });
	assert.match(await text("#file"), /arch\.drawio/);
	assert.match(await text("#selection"), /3 selected/);
	assert.equal(await page.locator("#model option").count(), 1);
	assert.equal(await page.locator("#empty").isVisible(), true);
});

test("Enter sends the prompt, Shift+Enter does not", async () => {
	posted.length = 0;
	await page.fill("#input", "make it blue");
	await page.press("#input", "Shift+Enter");
	assert.equal(posted.filter((m) => m.type === "send").length, 0);
	await page.press("#input", "Enter");
	assert.deepEqual(posted.find((m) => m.type === "send"), { type: "send", text: "make it blue" });
	assert.equal(await page.inputValue("#input"), "");
});

test("streams assistant text, tool progress and busy state", async () => {
	await post({ type: "append", item: { kind: "user", text: "make it blue", scope: "◌ lasso 3 selected" } });
	await post({ type: "busy", busy: true });
	assert.equal(await page.locator("#stop").isVisible(), true);
	await post({ type: "append", item: { kind: "tool", id: "t1", summary: "Editing diagram…", status: "running" } });
	await post({ type: "tool", id: "t1", summary: "Applied 3 edits", status: "ok" });
	await post({ type: "appendText", text: "Done: **3 shapes** are now " });
	await post({ type: "appendText", text: "`blue`." });
	await post({ type: "busy", busy: false });

	assert.equal(await page.locator("#empty").isVisible(), false);
	assert.match(await text(".msg.user"), /lasso 3 selected/);
	assert.equal(await text(".tool.ok"), "Applied 3 edits");
	assert.equal(await page.locator(".msg.assistant strong").innerText(), "3 shapes");
	assert.equal(await page.locator(".msg.assistant code").innerText(), "blue");
	assert.equal(await page.locator("#send").isVisible(), true);
});

test("model output cannot inject HTML", async () => {
	await post({ type: "appendText", text: '\n\n<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>' });
	await page.waitForTimeout(100);
	assert.equal(await page.evaluate(() => window.__pwned), undefined);
	assert.equal(await page.locator(".msg.assistant img").count(), 0);
});

test("error items offer their action button", async () => {
	posted.length = 0;
	await post({
		type: "append",
		item: { kind: "error", text: "No API key", action: { title: "Set API Key", command: "drawio-ai.setApiKey" } },
	});
	await page.click(".msg.error button");
	assert.deepEqual(posted.at(-1), { type: "command", command: "drawio-ai.setApiKey" });
});

test("switching conversations re-renders the transcript", async () => {
	await post({
		type: "state",
		state: state({ transcriptVersion: 2, transcript: [{ kind: "assistant", text: "Other diagram" }] }),
	});
	assert.equal(await page.locator(".msg").count(), 1);
	assert.equal(await text(".msg.assistant"), "Other diagram");
});

test("provider/model pickers and toolbar post their messages", async () => {
	posted.length = 0;
	await page.selectOption("#provider", "anthropic");
	await page.click("#lasso");
	await page.click("#askInDiagram");
	await page.click("#newChat");
	assert.deepEqual(
		posted.map((m) => m.type),
		["pickProvider", "lasso", "askInDiagram", "newChat"]
	);
	assert.equal(posted[0].providerId, "anthropic");
});

test("pending AI changes show a review strip whose buttons resolve the review", async () => {
	assert.equal(await page.locator("#review").isVisible(), false);
	await post({ type: "state", state: state({ transcriptVersion: 2, review: { added: 2, changed: 1, removed: 0 } }) });
	assert.equal(await page.locator("#review").isVisible(), true);
	assert.equal(await text("#reviewCounts"), "2 added1 changed");
	posted.length = 0;
	await page.click("#reviewReject");
	await page.click("#reviewAccept");
	assert.deepEqual(posted, [
		{ type: "review", decision: "reject" },
		{ type: "review", decision: "accept" },
	]);
	await post({ type: "state", state: state({ transcriptVersion: 2 }) });
	assert.equal(await page.locator("#review").isVisible(), false);
});

test("toolbar: markup, review and template chip post their commands", async () => {
	await post({ type: "state", state: state({ transcriptVersion: 3, template: "Payments" }) });
	assert.equal(await text("#template"), "◆ Payments");
	posted.length = 0;
	await page.click("#markup");
	await page.click("#lint");
	await page.click("#template");
	await page.click("#attach");
	assert.deepEqual(posted, [
		{ type: "command", command: "drawio-ai.markup" },
		{ type: "command", command: "drawio-ai.reviewDiagram" },
		{ type: "command", command: "drawio-ai.selectTemplate" },
		{ type: "pickImage" },
	]);
	await post({ type: "state", state: state({ transcriptVersion: 3, file: undefined }) });
	assert.equal(await page.locator("#markup").isDisabled(), true);
	assert.equal(await page.locator("#lint").isDisabled(), true);
	assert.equal(await text("#template"), "◆ No template");
	await post({ type: "state", state: state({ transcriptVersion: 3 }) });
});

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("pasted, dropped and picked images are previewed, removable and sent with the prompt", async () => {
	const dispatch = (type, target) =>
		page.evaluate(
			({ type, target, b64 }) => {
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const dt = new DataTransfer();
				dt.items.add(new File([bytes], "sketch.png", { type: "image/png" }));
				dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
				const evt =
					type === "paste"
						? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
						: new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
				document.querySelector(target).dispatchEvent(evt);
			},
			{ type, target, b64: PNG_1PX }
		);
	await dispatch("paste", "#input");
	await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 1);
	await dispatch("drop", "#messages");
	await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 2);
	await post({ type: "addImages", images: [{ mimeType: "image/jpeg", base64: PNG_1PX }] });
	await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 3);
	assert.match(await page.locator("#attachments img").first().getAttribute("src"), /^data:image\/png;base64,iVBOR/);

	await page.locator("#attachments button").nth(1).click();
	assert.equal(await page.locator("#attachments img").count(), 2);

	posted.length = 0;
	await page.click("#send");
	assert.equal(posted.length, 1);
	assert.equal(posted[0].type, "send");
	assert.equal(posted[0].text, "");
	assert.deepEqual(posted[0].images.map((i) => i.mimeType), ["image/png", "image/jpeg"]);
	assert.equal(posted[0].images[0].base64, PNG_1PX);
	assert.equal(await page.locator("#attachments img").count(), 0);

	await post({ type: "append", item: { kind: "user", text: "convert", attachments: ["🖼 2 images", "📎 code analysis"] } });
	assert.equal(await page.locator(".msg.user .attached").last().innerText(), "🖼 2 images · 📎 code analysis");
});

test("huge images are downscaled to at most 2048px JPEG before sending", async () => {
	const big = await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 3000;
		c.height = 1200;
		const ctx = c.getContext("2d");
		for (let i = 0; i < 300; i++) {
			ctx.fillStyle = `hsl(${i * 7}, 70%, 50%)`;
			ctx.fillRect((i * 37) % 3000, (i * 53) % 1200, 120, 80);
		}
		return c.toDataURL("image/png").split(",")[1];
	});
	await post({ type: "addImages", images: [{ mimeType: "image/png", base64: big }] });
	await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 1);
	assert.deepEqual(
		await page.locator("#attachments img").evaluate((img) => new Promise((r) => (img.complete ? r([img.naturalWidth, img.naturalHeight]) : (img.onload = () => r([img.naturalWidth, img.naturalHeight]))))),
		[2048, 819]
	);
	posted.length = 0;
	await page.fill("#input", "convert");
	await page.click("#send");
	assert.equal(posted[0].images[0].mimeType, "image/jpeg");
	assert.ok(posted[0].images[0].base64.length <= 5000000);
});

test("no script errors or CSP violations", () => {
	assert.deepEqual(errors, []);
});
