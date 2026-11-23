// End-to-end test of the desktop app's Settings page, the part for API keys: the page itself
// (standalone/src/renderer/settings.html) in headless Chrome, with its other half for API keys
// (standalone/src/main/api/keysPanel.ts and access.ts) behind it. The provider is a local
// stand-in and the keychain a test cipher: no network, no real key, nothing of this computer's.
//
// Run: node --test test/ai/settings.e2e.test.js
// SETTINGS_SHOTS=<folder> saves screenshots there.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "commonjs", target: "es2022", esModuleInterop: true } });

const root = path.resolve(__dirname, "../..");
const renderer = path.join(root, "standalone/src/renderer");
const { KeyStore } = require(path.join(root, "standalone/src/main/api/keyStore.ts"));
const { ApiAccess } = require(path.join(root, "standalone/src/main/api/access.ts"));
const { ApiKeysPanel } = require(path.join(root, "standalone/src/main/api/keysPanel.ts"));
const { API_PROVIDERS } = require(path.join(root, "standalone/src/main/api/providers.ts"));
const fake = require(path.join(root, "standalone/test/helpers/fake-providers.js"));
const shots = process.env.SETTINGS_SHOTS;

// (made up: nothing a provider issued)
const KEY = "test-key-for-the-stand-in-1";
const OTHER_KEY = "test-key-for-the-stand-in-2";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

let server, browser, base, provider;
// (how the stand-in answers a request for the models: a test changes it to be slow, or to refuse)
let listing;

before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
		if (url.pathname === "/settings.html") {
			// what the app's own server does with the page: a nonce, and its address as the only source
			const html = fs.readFileSync(path.join(renderer, "settings.html"), "utf8").replace(/\$\$nonce\$\$/g, "n0nce").replace(/\$\$cspSource\$\$/g, base);
			res.writeHead(200, { "content-type": "text/html" });
			return void res.end(html);
		}
		// (the app's build copies the fonts out of their packages: here they are taken from there)
		const font = /^\/ui\/fonts\/((space-grotesk|space-mono|doto)-[a-z0-9-]+\.woff2)$/.exec(url.pathname);
		const file = font ? path.join(root, "standalone/node_modules/@fontsource", font[2], "files", font[1]) : path.join(renderer, url.pathname);
		if (!(font || file.startsWith(renderer + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
		res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
	// Anthropic's stand-in: it accepts one key, and lists two models for it
	const rejected = { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
	const listed = fake.anthropicModels([{ id: "claude-old", display_name: "Claude Old", created_at: "2024-02-01T00:00:00Z" }, { id: "claude-new", display_name: "Claude New", created_at: "2026-05-01T00:00:00Z" }]);
	listing = (r) => (r.headers.authorization !== `Bearer ${KEY}` ? rejected : listed);
	provider = await fake.fakeApi((r) => (r.method === "GET" && r.path.startsWith("/v1/models") ? listing(r, { rejected, listed }) : undefined));
	browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
	await browser?.close();
	server?.close();
	await provider?.close();
});

/** Opens the Settings page with the app's side of it for API keys behind it. */
async function open({ dark = false } = {}) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-settings-e2e-")), "api-keys.json");
	const settings = {
		agent: "claude",
		agents: {},
		chatWidth: 400,
		editor: { "drawio-ai.reviewChanges": true, "drawio-ai.flashChanges": true, "drawio-ai.selectChangedCells": false, "drawio-ai.maxCellsInContext": 400 },
		appearance: { theme: dark ? "dark" : "light", iconStyle: "dots2d", toolbar: "top", matrix: "off" },
		chat: { side: "right", startCollapsed: false, allowAllByDefault: false },
		models: {},
		modelCatalog: {},
		shapes: { locations: [] },
		workshop: { galleries: [] },
	};
	// (a cipher for the test: it gives back what it hid; the app uses the system's)
	const flip = (bytes) => Buffer.from([...bytes].map((b) => b ^ 0x5a));
	const keys = new KeyStore(file, { available: async () => true, encrypt: async (text) => flip(Buffer.from(text, "utf8")), decrypt: async (bytes) => ({ text: flip(bytes).toString("utf8") }) });
	const access = new ApiAccess({ providers: API_PROVIDERS, keys, settings: () => settings, update: (patch) => (Object.assign(settings, patch), postState()), baseURL: (id) => (id === "anthropic" ? provider.url : `${provider.url}/v1`) });
	const page = await browser.newPage({ viewport: { width: 980, height: 820 }, colorScheme: dark ? "dark" : "light" });
	const problems = [];
	page.on("console", (m) => (m.type() === "error" || /Content Security Policy/.test(m.text())) && problems.push(m.text()));
	page.on("pageerror", (e) => problems.push(String(e)));
	page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`));
	page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()}: ${r.url()}`));
	const received = [];
	const postState = () => void page.evaluate((m) => window.__fromHost && window.__fromHost(m), { type: "state", settings, agents: [], apis: panel.rows(), file: "/Users/someone/settings.json", version: "0.1.0" }).catch(() => undefined);
	const panel = new ApiKeysPanel(() => access, postState);
	await page.exposeFunction("__toHost", (msg) => {
		received.push(msg);
		if (panel.onMessage(msg)) return;
		if (msg.type === "ready") postState();
		else if (msg.type === "setModelVisible") {
			// (as settingsWindow.ts does it)
			const cur = settings.models[msg.agent] ?? {};
			const hidden = new Set(cur.hidden ?? []);
			if (msg.visible) hidden.delete(msg.value);
			else hidden.add(msg.value);
			settings.models = { ...settings.models, [msg.agent]: { ...cur, hidden: [...hidden] } };
			postState();
		}
	});
	// the preload's bridge
	await page.addInitScript(() => {
		window.drawaiSettings = { post: (m) => window.__toHost(m), onMessage: (h) => (window.__fromHost = h) };
	});
	await page.goto(`${base}/settings.html`);
	await page.click('nav [data-section="agents"]');
	await page.waitForSelector("#agentTabs");
	const card = (id) => `#apiList .agent[data-api="${id}"]`;
	const shows = (id) =>
		page.$eval(card(id), (c) => ({
			tag: c.querySelector("header .tag").textContent,
			input: c.querySelector(".keyrow input") ? [c.querySelector(".keyrow input").type, c.querySelector(".keyrow input").placeholder, c.querySelector(".keyrow input").value] : null,
			note: c.querySelector(".keyrow .note") ? c.querySelector(".keyrow .note").textContent : null,
			error: c.querySelector(".bad") ? c.querySelector(".bad").textContent : null,
			models: [...c.querySelectorAll(".model")].map((m) => [m.querySelector(".name").textContent, m.querySelector("input").checked]),
			buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
		}));
	return { page, problems, received, settings, access, keys, file, card, shows, postState };
}

test("Settings → Agents & models: a key is typed once, checked with its provider, kept out of sight, and removed again", async () => {
	const w = await open();
	const { page, card } = w;
	// Agents & models has two halves: the agent programs first, the API keys one click away
	const halves = () => page.$$eval("#programsTab, #apiTab", (els) => els.map((e) => getComputedStyle(e).display !== "none"));
	assert.deepEqual([await halves(), await page.$$eval("#agentTabs button", (els) => els.map((b) => [b.textContent, b.getAttribute("aria-pressed")]))], [[true, false], [["Agents", "true"], ["API keys", "false"]]]);
	await page.click('#agentTabs [data-tab="api"]');
	assert.deepEqual(await halves(), [false, true]);
	// (where the Shape Creator's "Open Settings…" lands: the app asks for this half by name)
	await page.click('nav [data-section="appearance"]');
	await page.evaluate(() => window.__fromHost({ type: "section", section: "agents" }));
	assert.deepEqual(await halves(), [true, false]);
	await page.evaluate(() => window.__fromHost({ type: "section", section: "api" }));
	assert.deepEqual([await halves(), await page.$eval("section.active", (s) => s.id), await page.$eval("nav .active", (b) => b.dataset.section)], [[false, true], "agents", "agents"]);
	await page.waitForSelector("#apiList .agent");
	assert.deepEqual(await page.$$eval("#apiList .agent header b", (els) => els.map((e) => e.textContent)), ["Anthropic API", "OpenAI API", "Kimi API"]);
	assert.match(await page.$eval("#apiTab > p.lead", (p) => p.textContent), /^Use a provider's models with your own API key, without an agent program\. A key is kept encrypted with a secret from this computer's keychain: it is never written to the settings file, never shown again, and sent only to its provider\./);
	// nothing kept yet: a field for the key, as a password
	assert.deepEqual(await w.shows("anthropic"), { tag: "No key", input: ["password", "Paste your Anthropic API key (sk-ant-…)", ""], note: null, error: null, models: [], buttons: ["Save key"] });
	assert.deepEqual((await w.shows("kimi")).input, ["password", "Paste your Kimi API key (sk-…)", ""]);
	assert.equal(await page.$eval(`${card("anthropic")} .keyrow input`, (i) => i.autocomplete), "off");
	if (shots) await page.screenshot({ path: path.join(shots, "settings-api-keys-none.png") });

	// an empty field sends nothing; what is not a key is not sent to the provider
	await page.click(`${card("anthropic")} .keyrow button`);
	assert.equal(w.received.some((m) => m.type === "setApiKey"), false);
	await page.fill(`${card("anthropic")} .keyrow input`, "nope");
	// (the field is emptied as Save is pressed, before anything comes back: the key does not stay in the page)
	assert.equal(await page.evaluate((sel) => (document.querySelector(sel + " .keyrow button").click(), document.querySelector(sel + " .keyrow input").value), card("anthropic")), "");
	await page.waitForFunction((sel) => /does not look like an API key/.test(document.querySelector(sel).textContent), card("anthropic"));
	assert.equal(provider.requests.length, 0);
	assert.equal((await w.shows("anthropic")).input[2], "");

	// a key the provider does not accept is not kept
	await page.fill(`${card("anthropic")} .keyrow input`, OTHER_KEY);
	await page.press(`${card("anthropic")} .keyrow input`, "Enter");
	await page.waitForFunction((sel) => /did not accept the API key/.test(document.querySelector(sel).textContent), card("anthropic"));
	assert.deepEqual([(await w.shows("anthropic")).tag, w.keys.has("anthropic"), w.settings.modelCatalog], ["No key", false, {}]);

	// one it accepts is: its models are listed, and the key is not on the page any more
	await page.fill(`${card("anthropic")} .keyrow input`, `  ${KEY} `);
	await page.press(`${card("anthropic")} .keyrow input`, "Enter");
	await page.waitForFunction((sel) => document.querySelector(sel + " header .tag").textContent === "Key saved" && document.querySelectorAll(sel + " .model").length === 2, card("anthropic"));
	assert.deepEqual(await w.shows("anthropic"), {
		tag: "Key saved",
		input: null,
		note: "A key from Anthropic is kept in the keychain.",
		error: null,
		models: [["Claude New", true], ["Claude Old", true]],
		buttons: ["Refresh", "Remove key"],
	});
	assert.equal(await w.keys.get("anthropic"), KEY);
	const everywhere = (await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join("\n"))) + JSON.stringify(w.settings) + fs.readFileSync(w.file, "utf8");
	assert.doesNotMatch(everywhere, new RegExp(`${KEY}|${OTHER_KEY}`), "the key is not on the page, in the settings, or readable in its file");
	// (the other providers are as they were)
	assert.deepEqual([(await w.shows("openai")).tag, (await w.shows("kimi")).tag], ["No key", "No key"]);
	if (shots) await page.screenshot({ path: path.join(shots, "settings-api-keys-saved.png") });

	// a model switched off is not offered where models are picked
	await page.click(`${card("anthropic")} .model:nth-of-type(3) input`);
	await page.waitForFunction((sel) => document.querySelectorAll(sel + " .model.hidden-model").length === 1, card("anthropic"));
	assert.deepEqual(w.received.filter((m) => m.type === "setModelVisible"), [{ type: "setModelVisible", agent: "api:anthropic", value: "claude-old", visible: false }]);
	assert.deepEqual(w.access.models("anthropic"), [{ value: "claude-new", name: "Claude New" }]);

	// Refresh asks the provider again, with the kept key
	const asked = provider.requests.length;
	await page.click(`${card("anthropic")} header .refresh-btn`);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .refresh-btn").textContent === "Refresh", card("anthropic"));
	for (let i = 0; i < 100 && provider.requests.length === asked; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(provider.requests.length, asked + 1);
	assert.equal(provider.requests.pop().headers.authorization, `Bearer ${KEY}`);

	// while the provider is asked with it the key cannot be removed; one the provider no longer accepts is marked
	const answers = listing;
	listing = (r, as) => ({ ...as.rejected, delay: 400 });
	await page.click(`${card("anthropic")} header .refresh-btn`);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .refresh-btn").textContent === "Asking…", card("anthropic"));
	assert.deepEqual(await page.$eval(card("anthropic"), (c) => [c.querySelector(".keyrow button").textContent, c.querySelector(".keyrow button").disabled, c.querySelector("header .refresh-btn").disabled]), ["Remove key", true, true]);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .tag").textContent === "Not accepted", card("anthropic"));
	assert.deepEqual([(await w.shows("anthropic")).error, w.keys.has("anthropic"), await page.$eval(`${card("anthropic")} .keyrow button`, (b) => b.disabled)], ["Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys.", true, false]);
	listing = answers;
	await page.click(`${card("anthropic")} header .refresh-btn`);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .tag").textContent === "Key saved" && !document.querySelector(sel + " .bad"), card("anthropic"));

	// removed: the key and its models are gone, and the field is back
	await page.click(`${card("anthropic")} .keyrow button`);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .tag").textContent === "No key", card("anthropic"));
	assert.deepEqual(await w.shows("anthropic"), { tag: "No key", input: ["password", "Paste your Anthropic API key (sk-ant-…)", ""], note: null, error: null, models: [], buttons: ["Save key"] });
	assert.deepEqual([w.keys.has("anthropic"), w.settings.modelCatalog, JSON.parse(fs.readFileSync(w.file, "utf8")).keys], [false, {}, {}]);
	assert.deepEqual(w.problems, []);
	await page.close();
});

test("Settings → Agents & models: the API keys in the dark theme", async () => {
	const w = await open({ dark: true });
	await w.page.click('#agentTabs [data-tab="api"]');
	await w.page.fill(`${w.card("anthropic")} .keyrow input`, KEY);
	await w.page.press(`${w.card("anthropic")} .keyrow input`, "Enter");
	await w.page.waitForFunction((sel) => document.querySelectorAll(sel + " .model").length === 2, w.card("anthropic"));
	// what the page draws is readable: the tag and the names take the theme's colours
	const colours = await w.page.$eval(w.card("anthropic"), (c) => [getComputedStyle(c).backgroundColor, getComputedStyle(c.querySelector(".model .name")).color]);
	assert.notEqual(colours[0], colours[1]);
	if (shots) await w.page.screenshot({ path: path.join(shots, "settings-api-keys-dark.png") });
	assert.deepEqual(w.problems, []);
	await w.page.close();
});

test("Settings → Agents & models: a key that is being typed is not lost or left behind when the page is told something", async () => {
	const w = await open();
	const { page, card } = w;
	await page.click('#agentTabs [data-tab="api"]');
	await page.waitForSelector("#apiList .agent");
	const field = (id) => `${card(id)} .keyrow input`;
	const state = (id) => page.$eval(card(id), (c) => [c.querySelector("header .tag").textContent, c.querySelector(".keyrow input") ? c.querySelector(".keyrow input").value : null, c.querySelector(".keyrow input") ? c.querySelector(".keyrow input").disabled : null, c.querySelector(".bad") ? c.querySelector(".bad").textContent : null]);

	// a key is checked for one provider while another's is being typed: the first card says so and then shows the outcome,
	// and the field that is being typed in keeps its text, its cursor and the focus
	const answers = listing;
	listing = (r, as) => ({ ...as.rejected, delay: 1500 });
	await page.fill(field("anthropic"), OTHER_KEY);
	await page.press(field("anthropic"), "Enter");
	await page.click(field("openai"));
	await page.keyboard.type("half-a-key");
	await page.waitForFunction((sel) => document.querySelector(sel + " .keyrow input").disabled, card("anthropic"));
	assert.deepEqual(await state("openai"), ["No key", "half-a-key", false, null]);
	assert.equal(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), field("openai")), true);
	await page.waitForFunction((sel) => /did not accept the API key/.test(document.querySelector(sel).textContent), card("anthropic"));
	await page.keyboard.type("-and-more");
	assert.deepEqual(await state("openai"), ["No key", "half-a-key-and-more", false, null]);
	assert.deepEqual(await state("anthropic"), ["No key", "", false, "Anthropic did not accept the API key. Check it in Settings → Agents & models → API keys."]);
	listing = answers;

	// what was typed and not saved stays in its field when the page is told something after the field was left
	await page.click("#apiTab > p.lead");
	w.postState();
	w.postState();
	await page.waitForFunction(() => document.activeElement === document.body);
	assert.deepEqual(await state("openai"), ["No key", "half-a-key-and-more", false, null]);

	// something that happens to a card while its field is being typed in shows as soon as the field is left
	await page.click(field("kimi"));
	await page.keyboard.type("typed");
	w.settings.modelCatalog = { "api:kimi": [{ value: "kimi-k3", name: "kimi-k3" }, { value: "moonshot-v1-8k", name: "moonshot-v1-8k", images: false }] };
	await w.keys.set("kimi", KEY);
	w.postState();
	await new Promise((r) => setTimeout(r, 150));
	assert.deepEqual(await state("kimi"), ["Key saved", null, null, null], "a card that now has a key is drawn, typing or not: its field is gone");
	// (which of its models takes no pictures is said)
	assert.deepEqual(await page.$$eval(`${card("kimi")} .model .name`, (els) => els.map((e) => e.textContent)), ["kimi-k3", "moonshot-v1-8kTakes no pictures: it is given words only"]);
	assert.doesNotMatch(await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join("\n")), new RegExp(`${KEY}|${OTHER_KEY}`));
	assert.deepEqual(w.problems, []);
	await page.close();
});

test("Settings → Agents & models: a press of the mouse on Save, and Tab through the list, go through while the page is being told things", async () => {
	const w = await open();
	const { page, card } = w;
	await page.click('#agentTabs [data-tab="api"]');
	await page.waitForSelector("#apiList .agent");
	const field = (id) => `${card(id)} .keyrow input`;
	// a press as a hand makes it: down, a moment, up (the button pressed has to be the one released on)
	const press = async (selector) => {
		const box = await (await page.$(selector)).boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await new Promise((r) => setTimeout(r, 120));
		await page.mouse.up();
	};
	const saves = () => w.received.filter((m) => m.type === "setApiKey").map((m) => [m.provider, m.key]);

	// Tab goes from control to control through the whole list, also when the page is told something between two presses
	await page.click("#apiTab > p.lead");
	const stops = [];
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press("Tab");
		w.postState();
		await new Promise((r) => setTimeout(r, 40));
		stops.push(await page.evaluate(() => (document.activeElement.closest(".agent") ? document.activeElement.closest(".agent").dataset.api + ":" + document.activeElement.tagName.toLowerCase() : "elsewhere")));
	}
	assert.deepEqual(stops, ["anthropic:input", "anthropic:button", "openai:input", "openai:button", "kimi:input", "kimi:button"]);

	// a key is typed and Save is pressed with the mouse: saved by that one press
	await page.click(field("anthropic"));
	await page.keyboard.type(KEY);
	await press(`${card("anthropic")} .keyrow button`);
	await page.waitForFunction((sel) => document.querySelector(sel + " header .tag").textContent === "Key saved", card("anthropic"));
	assert.deepEqual(saves(), [["anthropic", KEY]]);

	// the same for a card that changed while its key was being typed (it is drawn again only once it is left)
	await page.click(field("openai"));
	await page.keyboard.type("not-a-key-that-openai-would-take");
	w.settings.models = { ...w.settings.models, "api:openai": { hidden: ["something"] } };
	w.postState();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(await page.$eval(card("openai"), (c) => c.dataset.late), "1");
	await press(`${card("openai")} .keyrow button`);
	await page.waitForFunction((sel) => /did not accept the API key/.test(document.querySelector(sel).textContent), card("openai"));
	assert.deepEqual(saves().slice(1), [["openai", "not-a-key-that-openai-would-take"]]);

	// and a model's checkbox in one card, pressed while a key is being typed in another: the box is the one pressed
	await page.click(field("kimi"));
	await page.keyboard.type("half");
	await press(`${card("anthropic")} .model input`);
	await page.waitForFunction((sel) => document.querySelectorAll(sel + " .model.hidden-model").length === 1, card("anthropic"));
	assert.deepEqual(w.received.filter((m) => m.type === "setModelVisible").map((m) => [m.agent, m.value, m.visible]), [["api:anthropic", "claude-new", false]]);
	assert.equal(await page.$eval(field("kimi"), (i) => i.value), "half");
	assert.deepEqual(w.problems, []);
	await page.close();
});
