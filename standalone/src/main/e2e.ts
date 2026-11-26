import { app } from "electron";
import * as fs from "fs";
import { paths } from "./paths";
import * as path from "path";
import { AgentId } from "./agents";
import { DiagramWindow } from "./diagramWindow";
import { exportDiagram } from "./exporter";
import { diagramContent } from "./xmlContent";
import { settings, updateSettings } from "./settings";
import { drawioLocalStorage } from "./diagramWindow";
import { SettingsWindow } from "./settingsWindow";
import { Menu, screen } from "electron";
import type { StaticServer } from "./staticServer";

export interface E2eConfig {
	/** Diagram to open (use a copy: the run may save over it). */
	file: string;
	/** Agent to drive, or omit to only check the editor, the MCP endpoint and exports. */
	agent?: AgentId;
	prompt?: string;
	/** Folder for results: screenshots, PDF, edited diagram, transcript, summary.json. */
	out: string;
	timeoutMs?: number;
	/** Answer permission requests by clicking the first "allow" button in the chat panel (instead of auto-approving in code). */
	clickPermissions?: boolean;
	/** Answer the first permission request by clicking "Allow all" in the chat panel. */
	clickAllowAll?: boolean;
	/** JavaScript to run in the editor before the screenshots (e.g. open a menu). */
	editorScript?: string;
	/** Measure editor responsiveness and editor→app traffic instead of the normal checks. */
	diagnose?: boolean;
	/** ACP session mode to switch to before prompting (e.g. Claude's "default", which asks before edits). */
	mode?: string;
	/** Run a Mapper recipe (instead of the agent prompt), optionally screenshot its dialog, then dig deeper with the agent. */
	/** Check presentation mode: enter, step pages, pan, try to edit, leave. */
	present?: boolean;
	/** Check map records, mapper_* tools, descriptions, health, recent changes, refresh, tours, Ask and the desktop endpoint. */
	insights?: boolean;
	/** Go live: a second window joins the first one's diagram through the relay at this address. */
	live?: { relay: string };
	map?: { recipe: string; input?: Record<string, string>; dialog?: boolean; askAgent?: boolean; digDeeper?: string };
	/** Check Settings, themes, icon styles, the toolbar, the chat's menus, sliding and docking, and shape folders. */
	polish?: boolean;
	/** Check the Shape Workshop: gallery palettes, draw.io's search, Workshop search and insert, GitHub galleries, collections. */
	workshop?: boolean;
	/** Check the chat answered through an API key, with a stand-in provider (api/standIn.ts): nothing is sent anywhere, and the keychain is not asked. */
	apiChat?: boolean;
}

/**
 * End-to-end check, run with DRAWAI_E2E='{"file":…,"out":…,"agent":"claude","prompt":…}'
 * (see `yarn e2e`): opens the diagram in a real window, calls the window's MCP
 * endpoint like an agent would, optionally runs one prompt through an ACP agent
 * (permission requests auto-approved), then exports and screenshots the result.
 */
export async function runE2e(server: StaticServer, config: E2eConfig): Promise<void> {
	const summary: Record<string, unknown> = { file: config.file, agent: config.agent ?? null };
	const log = (k: string, v: unknown) => {
		summary[k] = v;
		console.log(`[e2e] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
	};
	const timer = setTimeout(() => {
		log("error", "timed out");
		finish(2);
	}, config.timeoutMs ?? 300_000);
	const finish = (code: number) => {
		clearTimeout(timer);
		fs.writeFileSync(path.join(config.out, "summary.json"), JSON.stringify(summary, null, 2));
		app.exit(code);
	};
	try {
		fs.mkdirSync(config.out, { recursive: true });
		// Pick the agent before the window opens: the chat starts it as soon as it is ready.
		if (config.agent) settings().agent = config.agent; // this run only; not written to settings.json
		if (config.apiChat) {
			// (before anything asks for the app's API access: this run's is the stand-in's)
			process.env.DRAWAI_E2E_API = "1";
			settings().agent = "api:stand-in";
		}
		const t0 = Date.now();
		const w = await DiagramWindow.open(server, config.file);
		await w.whenLoaded();
		log("loadedMs", Date.now() - t0);
		const diagnose = async (label: string) => {
			w.traffic = new Map();
			const wc = w.editorView.webContents;
			// Event-loop lag (timer drift) and long tasks; works even when the window is covered.
			const frames = wc.executeJavaScript(`new Promise((resolve) => { const lag = []; const long = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(Math.round(e.duration)))).observe({ type: "longtask" }); } catch {} let last = performance.now(); const id = setInterval(() => { const now = performance.now(); lag.push(now - last - 10); last = now; if (lag.length >= 380) { clearInterval(id); lag.sort((a, b) => a - b); resolve({ lagP50: Math.round(lag[190]), lagP95: Math.round(lag[361]), lagMax: Math.round(lag[379]), longTasks: long.length, longestTask: Math.max(0, ...long), heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6), cells: document.querySelectorAll("svg g g").length }); } }, 10); })`);
			for (let i = 0; i < 240; i++) {
				wc.sendInputEvent({ type: "mouseMove", x: 300 + Math.round(200 * Math.sin(i / 10)), y: 300 + Math.round(150 * Math.cos(i / 13)) });
				await new Promise((r) => setTimeout(r, 16));
			}
			log(`perf ${label}`, { ...(await frames), traffic: Object.fromEntries(w.traffic) });
			w.traffic = new Map();
			await new Promise((r) => setTimeout(r, 3000));
			log(`idle traffic 3s ${label}`, Object.fromEntries(w.traffic));
			w.traffic = undefined;
			log(`cpu ${label}`, app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`).join(" "));
		};
		if (config.diagnose) await diagnose("fresh");

		// The MCP endpoint, exactly as an agent reaches it.
		const mcp = (w as any).mcp as { url: string; token: string };
		const rpc = async (method: string, params: unknown) => {
			const r = await fetch(mcp.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
			return (await r.json()) as any;
		};
		const tools = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
		log("mcpTools", tools);
		const model = JSON.parse((await rpc("tools/call", { name: "drawio_get_diagram", arguments: {} })).result.content[0].text);
		log("cellsBefore", model.totalCells);
		const unauthorized = await fetch(mcp.url, { method: "POST", body: "{}" });
		log("mcpWithoutTokenStatus", unauthorized.status);

		const before = await w.client.getXml();
		if (config.workshop) {
			await runWorkshop(w, server, config, log);
		} else if (config.apiChat) {
			await runApiChat(w, server, config, log);
		} else if (config.polish) {
			await runPolish(w, server, config, log);
		} else if (config.insights) {
			await runInsights(w, config, log);
		} else if (config.live) {
			await runLive(w, server, config, log);
		} else if (config.present) {
			await runPresent(w, config, log);
		} else if (config.map) {
			await runMap(w, config, log);
		} else if (config.agent) {
			let clicker: NodeJS.Timeout | undefined;
			if (config.clickAllowAll) {
				clicker = setInterval(() => {
					void w.chatView.webContents
						.executeJavaScript(`(() => { const b = document.querySelector(".permission .options button.allow-all"); if (b) { b.click(); return true; } return false; })()`)
						.then((clicked) => clicked && console.log("[e2e] clicked Allow all"));
				}, 400);
			} else if (config.clickPermissions) {
				// Through the real UI: the permission card the user would see.
				clicker = setInterval(() => {
					void w.chatView.webContents
						.executeJavaScript(`(() => { const b = document.querySelector(".permission .options button.btn-primary") || document.querySelector(".permission .options button"); if (b) { b.click(); return b.textContent; } return null; })()`)
						.then((clicked) => clicked && console.log(`[e2e] clicked permission button: ${clicked}`));
				}, 500);
			} else {
				w.chat.autoApprove = true;
			}
			if (config.mode) {
				await w.whenLoaded();
				for (let i = 0; i < 100 && !(w.chat as any).session?.info; i++) await new Promise((r) => setTimeout(r, 200));
				await (w.chat as any).session?.setMode(config.mode);
				log("mode", config.mode);
			}
			const turn = new Promise<{ stop?: string; error?: string }>((resolve) => (w.chat.onTurnEnd = (stop, error) => resolve({ stop, error })));
			const t1 = Date.now();
			void w.chat.send(config.prompt ?? "Add a shape labelled 'Hello from the agent' next to the existing shapes and connect it to one of them.");
			const r = await turn;
			if (clicker) clearInterval(clicker);
			log("turn", { ...r, ms: Date.now() - t1 });
			log("agentInfo", (w.chat as any).session?.info?.agentName);
			log("mcpTransport", (w.chat as any).session?.info?.mcpTransport);
			const after = await w.client.getXml();
			log("diagramChanged", after !== before);
			const items = w.chat.items;
			log("toolCalls", items.filter((i) => i.kind === "tool").map((i: any) => `${i.status}: ${i.summary}`));
			log("permissions", items.filter((i) => i.kind === "permission").map((i: any) => `${i.title} -> ${i.outcome}`));
			log("allowAllOn", w.chat.allowingAll);
			log("allowAllChipVisible", await w.chatView.webContents.executeJavaScript(`!document.getElementById("allowAllChip").classList.contains("hidden")`));
			log("reply", items.filter((i) => i.kind === "assistant").map((i: any) => i.text).join("\n").slice(0, 2000));
			log("errors", items.filter((i) => i.kind === "error").map((i: any) => i.text));
			fs.writeFileSync(path.join(config.out, "transcript.json"), JSON.stringify(items, null, 2));
			if (config.diagnose) {
				await diagnose("review pending");
				w.client.aiResolveReview("accept");
				await new Promise((r) => setTimeout(r, 1000));
				await diagnose("after accept");
			}
			await new Promise((r) => setTimeout(r, 1500)); // let the editor repaint
		}
		const model2 = JSON.parse((await rpc("tools/call", { name: "drawio_get_diagram", arguments: {} })).result.content[0].text);
		log("cellsAfter", model2.totalCells);

		if (config.editorScript) {
			log("editorScript", await w.editorView.webContents.executeJavaScript(config.editorScript).catch((e) => String(e)));
			await new Promise((r) => setTimeout(r, 800));
		}
		fs.writeFileSync(path.join(config.out, "editor.png"), (await w.editorView.webContents.capturePage()).toPNG());
		fs.writeFileSync(path.join(config.out, "chat.png"), (await w.chatView.webContents.capturePage()).toPNG());
		const pdf = await exportDiagram(w.client, "pdf", path.join(config.out, "diagram.pdf"));
		log("pdf", pdf);
		const svg = await exportDiagram(w.client, "svg", path.join(config.out, "diagram.drawio.svg"));
		log("svgBytes", svg.bytes);
		// a test run is built into, and started from, a folder of its own (a copy of the app that is running keeps its
		// files), and every run leaves word of its start in the data folder's log
		const started = fs.readFileSync(path.join(app.getPath("userData"), "logs", "app.log"), "utf8").split("\n")[0];
		log("runLog", { built: path.basename(paths.out), started: started.replace(/^\S+ /, "").replace(/pid=\d+/, "pid=…") });
		if (!app.isPackaged && path.basename(paths.out) !== "out-e2e") throw new Error("The test run was not started from its own build folder.");
		if (!/^started version=\S+ pid=… built=\S+ test=yes$/.test(started.replace(/^\S+ /, "").replace(/pid=\d+/, "pid=…"))) throw new Error(`The run log does not start with this run: ${started}`);
		fs.writeFileSync(path.join(config.out, "edited.drawio"), await w.client.getXml());
		w.chat.dispose();
		finish(0);
	} catch (e: any) {
		log("error", String(e?.stack ?? e));
		finish(1);
	}
}

async function runMap(w: DiagramWindow, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const map = config.map!;
	const { recipeById } = await import("./mapper/registry");
	const recipe = recipeById(map.recipe);
	if (!recipe) throw new Error(`Unknown recipe ${map.recipe}`);
	if (map.dialog) {
		w.mapper.open(recipe.category);
		const dlg = await waitFor(() => w.mapper.window, 10_000);
		await new Promise((r) => setTimeout(r, 1500));
		// the picture is of this recipe's form, filled in as the run is (its lists have a moment to load)
		const filled = recipe.fields.filter((f) => map.input?.[f.id] !== undefined).map((f) => ({ label: f.label, value: map.input![f.id] }));
		await dlg.webContents.executeJavaScript(`(async () => {
			document.querySelector(${JSON.stringify(`.recipe[data-recipe="${recipe.id}"]`)})?.click();
			for (const f of ${JSON.stringify(filled)}) {
				await new Promise((r) => setTimeout(r, 150));
				const field = Array.from(document.querySelectorAll(".field")).find((d) => d.querySelector("label")?.textContent.replace(/ \\*$/, "").trim() === f.label);
				const control = field?.querySelector("select, input[type=text], input[type=password], textarea");
				if (!control) continue;
				control.value = f.value;
				control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
			}
		})()`);
		await new Promise((r) => setTimeout(r, filled.length ? 5000 : 600));
		fs.writeFileSync(path.join(config.out, "mapper-dialog.png"), (await dlg.webContents.capturePage()).toPNG());
		log("dialogText", (await dlg.webContents.executeJavaScript("document.body.innerText")).slice(0, 1500));
		// each list of the form: what is chosen, and how many it offers
		log("dialogLists", await dlg.webContents.executeJavaScript(`Object.fromEntries(Array.from(document.querySelectorAll(".field")).filter((d) => d.querySelector("select")).map((d) => [d.querySelector("label").textContent.trim(), [d.querySelector("select").selectedOptions[0]?.textContent ?? "", d.querySelector("select").options.length]]))`));
	}
	if (config.agent) w.chat.autoApprove = true;
	const t0 = Date.now();
	const turn = config.agent && map.askAgent ? waitForTurn(w) : undefined;
	const r = await w.mapper.run(recipe.id, { ...(map.input ?? {}) }, !!map.askAgent);
	log("mapMs", Date.now() - t0);
	log("mapSummary", r.result?.summary ?? null);
	log("mapRouting", (await import("./mapper/draw")).lastRouting ?? null);
	log("mapWarnings", r.result?.warnings ?? []);
	if (r.error) throw new Error(`Mapper: ${r.error}`);
	if (map.dialog && r.result?.elsewhere?.length) {
		// the folder held next to nothing and its working copies were not read: the dialog offers them, and a click maps one
		const dlg = w.mapper.window!.webContents;
		const offered: string[] = await dlg.executeJavaScript(`Array.from(document.querySelectorAll("#result .elsewhere button")).map((b) => b.textContent)`);
		await new Promise((r) => setTimeout(r, 700));
		fs.writeFileSync(path.join(config.out, "mapper-elsewhere.png"), (await dlg.capturePage()).toPNG());
		// (more than six: the rest are behind a button, and all of them are there once it is pressed)
		await dlg.executeJavaScript(`Array.from(document.querySelectorAll("#result .elsewhere button")).find((b) => / more…$/.test(b.textContent))?.click()`);
		const all: string[] = await dlg.executeJavaScript(`Array.from(document.querySelectorAll("#result .elsewhere button")).map((b) => b.textContent)`);
		if (all.join() !== r.result.elsewhere.map((e) => e.label).join()) throw new Error(`The Mapper dialog does not offer every working copy: ${all.join(", ")}`);
		await dlg.executeJavaScript(`document.querySelector("#result .elsewhere button").click()`);
		const end = Date.now() + 30_000;
		let after = "";
		while (Date.now() < end && !/^✓/.test(after)) {
			await new Promise((r) => setTimeout(r, 200));
			after = await dlg.executeJavaScript(`document.getElementById("result").className === "ok" ? document.querySelector("#result div").textContent : ""`);
		}
		log("mapElsewhere", { offered, expected: r.result.elsewhere.map((e) => e.label), folder: await dlg.executeJavaScript(`Array.from(document.querySelectorAll("input[type=text]")).map((i) => i.value).find((v) => v.includes("worktrees")) || ""`), after });
		if (offered.filter((o) => !/ more…$/.test(o)).join() !== r.result.elsewhere.slice(0, 6).map((e) => e.label).join() || (r.result.elsewhere.length > 6) !== offered.some((o) => / more…$/.test(o)) || !/^✓/.test(after)) throw new Error("The Mapper dialog did not offer the working copies, or a click on one did not map it.");
	}
	const pages = await w.client.aiPages({ op: "list" });
	log("pages", pages.pages.map((p) => `${p.name}${p.current ? " (shown)" : ""}: ${p.cells}`));
	const model = await w.client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 5000 });
	const mapped = model.cells.filter((c) => c.data?.mapper === recipe.id);
	log("mappedShapes", mapped.length);
	log("mappedKinds", Object.fromEntries([...new Set(mapped.map((c) => c.data!.mapperKind))].map((k) => [k, mapped.filter((c) => c.data!.mapperKind === k).length])));
	log("reviewPending", !!w.client.pendingReview?.pending);
	if (map.dialog && w.mapper.window) fs.writeFileSync(path.join(config.out, "mapper-dialog-done.png"), (await w.mapper.window.webContents.capturePage()).toPNG());
	await new Promise((res) => setTimeout(res, 800));
	fs.writeFileSync(path.join(config.out, "map.png"), (await w.editorView.webContents.capturePage()).toPNG());
	fs.writeFileSync(path.join(config.out, "map.drawio"), await w.client.getXml());
	if (turn) log("agentTurn", await turn);
	if (config.agent && map.digDeeper !== undefined) {
		// Select a few mapped leaf shapes, as the user would, and dig deeper.
		const pick = mapped.filter((c) => c.kind === "vertex").slice(0, 3).map((c) => c.id);
		await w.client.aiSetSelection(pick, true);
		await new Promise((res) => setTimeout(res, 600));
		const dig = waitForTurn(w);
		await w.digDeeper(map.digDeeper);
		log("digDeeperTurn", await dig);
		const items = w.chat.items;
		log("digDeeperShown", items.filter((i) => i.kind === "user").map((i: any) => i.text).slice(-1)[0]);
		log("digDeeperTools", items.filter((i) => i.kind === "tool").map((i: any) => `${i.status}: ${i.summary}`).slice(-15));
		log("digDeeperPermissions", items.filter((i) => i.kind === "permission").map((i: any) => i.title).slice(-15));
		log("digDeeperReply", items.filter((i) => i.kind === "assistant").map((i: any) => i.text).join("\n").slice(-1500));
		fs.writeFileSync(path.join(config.out, "after-dig.png"), (await w.editorView.webContents.capturePage()).toPNG());
		fs.writeFileSync(path.join(config.out, "chat.png"), (await w.chatView.webContents.capturePage()).toPNG());
	}
}

/**
 * The chat answered through an API key instead of an agent program. The provider is a
 * stand-in (api/standIn.ts): the window, the chat page, the key store's file, the tools and
 * the permission cards are the real ones; nothing is sent anywhere and the keychain is not asked.
 */
async function runApiChat(w: DiagramWindow, server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const { apiAccess } = await import("./api/catalog");
	const { STAND_IN_ID, STAND_IN_KEY } = await import("./api/standIn");
	const page = w.chatView.webContents;
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const until = async <T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<T> => {
		for (const end = Date.now() + ms; ; await pause(100)) {
			const v = await fn();
			if (v) return v;
			if (Date.now() > end) throw new Error(`Waited too long for ${what}.`);
		}
	};
	const expect = (ok: unknown, what: string) => {
		if (!ok) throw new Error(`The chat with an API key: ${what}`);
	};
	const shown = (): Promise<{ provider: string; model: string; dot: string }> =>
		page.executeJavaScript(`({ provider: document.getElementById("providerLabel").textContent, model: document.getElementById("modelLabel").textContent, dot: document.getElementById("status").dataset.state })`);
	const turn = (text: string) => {
		const done = waitForTurn(w);
		void w.chat.send(text);
		return done;
	};
	const waiting = (): Promise<string[]> => page.executeJavaScript(`Array.from(document.querySelectorAll(".permission:not(.resolved):not(.auto) .options button")).map((b) => b.textContent)`);
	/** Presses a button of the permission card that is waiting, as the user would. */
	const answer = async (name: string) => {
		await until(`the "${name}" button of a permission card`, () =>
			page.executeJavaScript(
				`(() => { const b = Array.from(document.querySelectorAll(".permission:not(.resolved):not(.auto):not([data-answered]) .options button")).find((b) => b.textContent === ${JSON.stringify(name)}); if (b) { b.closest(".permission").dataset.answered = "1"; b.click(); } return !!b; })()`
			)
		);
		// (the page marks a card as answered when the app says so, a moment after the click: until then
		// it would be taken for the next request's card, and pressed again or waited on in its place)
		await until("the card to be marked as answered", () => page.executeJavaScript(`!document.querySelector(".permission[data-answered]:not(.resolved)")`));
	};
	const last = <K extends string>(kind: K) => [...w.chat.items].reverse().find((i) => i.kind === kind) as any;
	const has = async (label: string) => (await w.client.getXml()).includes(label);
	const save = async (name: string) => fs.writeFileSync(path.join(config.out, name), (await page.capturePage()).toPNG());

	// no key yet: the provider is listed, and a request says where a key goes
	await until("the chat page", async () => (await shown()).provider === "Stand-in API");
	log("apiChatNoKey", await shown());
	expect((await shown()).dot === "problem", "a provider without a key is not shown as ready.");
	const refused = await turn("Add a shape labelled 'No key'.");
	const said = last("error");
	log("apiChatNoKeyTurn", { ...refused, action: said?.action });
	expect(/There is no Stand-in API key/.test(said?.text ?? "") && said?.action?.command === "drawai.openApiKeys", "a request without a key does not point to Settings.");

	// the picker: the agents, then the providers used with an API key
	await page.executeJavaScript(`document.getElementById("providerBtn").click()`);
	await pause(300);
	const menu: string[] = await page.executeJavaScript(
		`Array.from(document.querySelectorAll("#pickMenu > *")).map((e) => e.classList.contains("group") ? "# " + e.textContent : e.getAttribute("role") === "menuitemradio" ? e.children[1].textContent + (e.querySelector("small") ? " (" + e.querySelector("small").textContent + ")" : "") : "").filter(Boolean)`
	);
	log("apiChatPicker", menu);
	await save("chat-api-picker.png");
	await page.executeJavaScript(`document.getElementById("providerBtn").click()`);
	expect(menu[0] === "# Agents" && menu.indexOf("# With an API key") > 1 && menu.includes("Stand-in API (no key)") && menu.includes("Anthropic API (no key)"), "the picker does not list the agents and then the providers.");

	// a key is kept: the chat is ready without a request, a program or the keychain
	expect((await apiAccess().saveKey(STAND_IN_ID, STAND_IN_KEY)) === undefined, "the stand-in's key was not kept.");

	// Settings → Test: one request the way the chat makes them, on a click. It runs no tool: the diagram is as it was.
	const xmlBefore = await w.client.getXml();
	const itemsBefore = w.chat.items.length;
	SettingsWindow.open(server, "apiKeys");
	for (let i = 0; i < 50 && !SettingsWindow.window?.isVisible(); i++) await pause(100);
	const sp = SettingsWindow.window!.webContents;
	const card = `document.querySelector('#apiList [data-api="stand-in"]')`;
	await until("the stand-in's card in Settings", () => sp.executeJavaScript(`!!${card}`));
	const testButton: string = await sp.executeJavaScript(`(() => { const b = Array.from(${card}.querySelectorAll("button")).find((b) => b.textContent === "Test"); if (b) b.click(); return b ? b.title : ""; })()`);
	const found: string = await until("what the test found", () => sp.executeJavaScript(`${card}.querySelector(".good")?.textContent || ${card}.querySelector(".bad")?.textContent || ""`));
	fs.writeFileSync(path.join(config.out, "settings-key-test.png"), (await sp.capturePage()).toPNG());
	log("apiKeyTest", { found, title: testButton });
	expect(/^Works: Stand-in Large took the chat's \d+ tools, called drawio_lint, and answered "OK"\.$/.test(found) && /uses a little of your credit/.test(testButton), "the Test button in Settings did not report a working request.");
	expect((await w.client.getXml()) === xmlBefore && w.chat.items.length === itemsBefore, "testing a key changed the diagram or the chat.");
	SettingsWindow.window?.close();
	await until("the chat to be ready", async () => (await shown()).dot === "ready");
	log("apiChatReady", await shown());
	expect((await shown()).model === "Stand-in Large", "the model picked for a new chat is not the first one listed.");

	// a tool that changes the diagram asks first; one that reads does not
	const before = await w.client.getXml();
	let done = turn("Add a shape labelled 'Denied shape'.");
	await until("a permission card", async () => (await waiting()).length);
	log("apiChatAsks", { title: last("permission")?.title, buttons: await waiting() });
	await answer("Deny");
	log("apiChatDenied", { ...(await done), reply: last("assistant")?.text, outcome: last("permission")?.outcome });
	expect((await w.client.getXml()) === before && /did not allow/.test(last("assistant")?.text ?? ""), "a call that was not allowed changed the diagram, or the model was not told.");
	expect(w.chat.items.filter((i) => i.kind === "permission").length === 1, "reading the diagram asked for permission.");

	done = turn("Add a shape labelled 'Hello from the API'.");
	await answer("Allow");
	log("apiChatAllowed", { ...(await done), reply: last("assistant")?.text, tools: w.chat.items.filter((i) => i.kind === "tool").slice(-2).map((i: any) => `${i.status}: ${i.summary}`) });
	expect(await has("Hello from the API"), "the shape was not added.");

	// while it works the box stays open. What is sent then waits in a strip above it...
	const type = (text: string) => page.executeJavaScript(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return document.getElementById("send").textContent; })()`);
	const strip = (): Promise<string[]> => page.executeJavaScript(`Array.from(document.querySelectorAll("#queued .queued .what")).map((e) => e.textContent)`);
	const users = () => w.chat.items.filter((i) => i.kind === "user").map((i: any) => `${i.scope ?? ""}|${i.text}`);
	done = turn("Add a shape labelled 'While working'.");
	await until("a permission card", async () => (await waiting()).length);
	const button = await type("Also add a shape labelled 'Steered in'.");
	await type("And one labelled 'Taken back'.");
	await until("the waiting strip", async () => (await strip()).length === 2);
	await pause(500);
	await save("chat-api-waiting.png");
	log("apiChatWaiting", { button, strip: await strip(), hint: await page.executeJavaScript(`document.getElementById("hint").textContent`) });
	// ...can be taken back...
	await page.executeJavaScript(`document.querySelectorAll("#queued .queued .drop")[1].click()`);
	await until("one to be taken back", async () => (await strip()).length === 1);
	// ...and reaches the model with the next tool's answer: it reads it as it works
	await answer("Allow");
	await answer("Allow");
	const steered = await done;
	log("apiChatSteered", { ...steered, reply: last("assistant")?.text, users: users().slice(-2), strip: await strip() });
	expect(button === "Add" && steered.stop === "end_turn" && (await has("While working")) && (await has("Steered in")) && !(await has("Taken back")) && users().pop() === "↪ added while it works|Also add a shape labelled 'Steered in'." && !(await strip()).length, "what was added while it worked did not reach the model with a tool's answer.");

	// what could not be handed over (no tool answered after it) is sent as the next request when this one ends
	let ended = 0;
	const twice = new Promise<{ stop?: string; error?: string }>((resolve) => (w.chat.onTurnEnd = (stop, error) => ++ended === 2 && resolve({ stop, error })));
	void w.chat.send("Add a shape labelled 'Not this one'.");
	await until("a permission card", async () => (await waiting()).length);
	// (what is selected as it is sent is what it is about, whatever is selected when its turn comes)
	const pick = (how: string) => w.editorView.webContents.executeJavaScript(`(() => { const g = editorUi.editor.graph; ${how}; return g.getSelectionCount(); })()`);
	const picked: number = await pick(`g.setSelectionCell(Object.values(g.getModel().cells).find((c) => c.vertex))`);
	await until("the selection to reach the app", () => w.client.currentSelection.length === 1);
	const pickedId = w.client.currentSelection[0];
	await type("Add a shape labelled 'Sent after'.");
	await until("the waiting strip", async () => (await strip()).length === 1);
	await pick(`g.clearSelection()`);
	await until("the selection to be gone", () => w.client.currentSelection.length === 0);
	await answer("Deny");
	await answer("Allow");
	const followed = await twice;
	log("apiChatFollowed", { ...followed, users: users().slice(-2) });
	expect(followed.stop === "end_turn" && (await has("Sent after")) && !(await has("Not this one")) && picked === 1 && !!pickedId && users().pop() === "◉ 1 selected|Add a shape labelled 'Sent after'.", "what was still waiting when the request ended was not sent as the next one, or not with what was selected as it was sent.");

	// asked for elsewhere in the app while it works (the Shifter's "Ask the agent", the Mapper): it is not refused, and
	// not handed over in the middle of the other request. It waits under its own name and follows as the next request.
	ended = 0;
	const both = new Promise<{ stop?: string; error?: string }>((resolve) => (w.chat.onTurnEnd = (stop, error) => ++ended === 2 && resolve({ stop, error })));
	void w.chat.send("Add a shape labelled 'Busy with this'.");
	await until("a permission card", async () => (await waiting()).length);
	void w.askAboutSelection("Add a shape labelled 'Asked meanwhile'.", "🎨 Asked meanwhile");
	await until("the request to wait", async () => (await strip()).join() === "🎨 Asked meanwhile");
	const refusedBefore = w.chat.items.filter((i) => i.kind === "error").length;
	await answer("Allow");
	await answer("Allow");
	const after = await both;
	log("apiChatAskedMeanwhile", { ...after, users: users().slice(-2), strip: await strip() });
	expect(after.stop === "end_turn" && (await has("Busy with this")) && (await has("Asked meanwhile")) && users().slice(-2).join() === "|Add a shape labelled 'Busy with this'.,|🎨 Asked meanwhile" && w.chat.items.filter((i) => i.kind === "error").length === refusedBefore && !(await strip()).length, "a request made elsewhere in the app while it worked was refused, or did not follow as the next one.");
	// ...and after Stop it is not put into the box as if the user had typed it: the chat says it was not sent
	done = turn("Add a shape labelled 'Stopped with one waiting'.");
	await until("a permission card", async () => (await waiting()).length);
	void w.askAboutSelection("Add a shape labelled 'Dropped request'.", "🎨 Dropped request");
	await until("the request to wait", async () => (await strip()).length === 1);
	w.chat.stop();
	await done;
	await pause(300);
	const boxAfter: string = await page.executeJavaScript(`document.getElementById("input").value`);
	log("apiChatAskedThenStopped", { note: last("note")?.text, box: boxAfter, strip: await strip() });
	expect(boxAfter === "" && !(await strip()).length && last("note")?.text === "Not sent: 🎨 Dropped request. Ask again where you asked." && !(await has("Dropped request")), "a request of the app that waited when Stop was pressed was sent, or put into the box.");

	// Stop while a card waits: the request ends as stopped, and nothing is changed; what was waiting goes back into the box, unsent
	done = turn("Add a shape labelled 'Stopped shape'.");
	await until("a permission card", async () => (await waiting()).length);
	await type("And a shape labelled 'Never sent'.");
	await until("the waiting strip", async () => (await strip()).length === 1);
	// (only so many wait: one more is not taken, and is back in the box it was sent from)
	for (let n = 2; n <= 8; n++) await type(`Extra ${n}.`);
	await until("a full strip", async () => (await strip()).length === 8);
	await type("One too many.");
	await until("the one too many, back in the box", () => page.executeJavaScript(`document.getElementById("input").value === "One too many."`));
	const full = { strip: (await strip()).length, said: last("error")?.text };
	await page.executeJavaScript(`document.getElementById("input").value = ""`);
	// (taken back from the end, each by what it is and not by its place: the first stays)
	for (let left = 7; left >= 1; left--) {
		await page.executeJavaScript(`Array.from(document.querySelectorAll("#queued .queued .drop")).pop().click()`);
		await until("one fewer waiting", async () => (await strip()).length === left);
	}
	log("apiChatFull", { ...full, left: await strip() });
	expect(full.strip === 8 && /a lot to add/.test(full.said ?? "") && (await strip()).join() === "And a shape labelled 'Never sent'.", "one more than can wait was lost, or the wrong ones were taken back.");
	w.chat.stop();
	const stopped = await done;
	await pause(300);
	const box: string = await page.executeJavaScript(`(() => { const i = document.getElementById("input"); const v = i.value; i.value = ""; return v; })()`);
	log("apiChatStopped", { ...stopped, outcome: last("permission")?.outcome, box, strip: await strip() });
	expect(stopped.stop === "cancelled" && !(await has("Stopped shape")), "Stop did not end the request, or the shape was added all the same.");
	expect(box === "And a shape labelled 'Never sent'." && !(await strip()).length && !(await has("Never sent")) && !w.chat.items.some((i: any) => i.kind === "user" && /Never sent/.test(i.text)), "what was waiting when Stop was pressed was sent, or lost.");


	// another model, picked in the page: a new conversation, and the one a new chat starts with
	await page.executeJavaScript(`document.getElementById("modelBtn").click()`);
	await pause(300);
	await page.executeJavaScript(`Array.from(document.querySelectorAll("#pickMenu [role=menuitemradio]")).find((b) => b.children[1].textContent === "Stand-in Small").click()`);
	await until("the other model", async () => (await shown()).model === "Stand-in Small");
	log("apiChatModel", { ...(await shown()), note: last("note")?.text, preferred: settings().models["api:stand-in"]?.preferred });
	expect(/Switched to Stand-in Small/.test(last("note")?.text ?? "") && settings().models["api:stand-in"]?.preferred === "stand-in-small", "picking a model did not start a new conversation with it.");

	// "Always allow in this chat": asked once, then not again for that tool
	done = turn("Add a shape labelled 'Second shape'.");
	await answer("Always allow in this chat");
	await done;
	const cards = w.chat.items.filter((i) => i.kind === "permission").length;
	const third = await turn("Add a shape labelled 'Third shape'.");
	log("apiChatAlways", { ...third, reply: last("assistant")?.text, cards: [cards, w.chat.items.filter((i) => i.kind === "permission").length] });
	expect(third.stop === "end_turn" && (await has("Third shape")) && w.chat.items.filter((i) => i.kind === "permission").length === cards && /stand-in-small \(request 2 of this conversation\)/.test(last("assistant")?.text ?? ""), "a tool allowed for the chat asked again, or the model picked was not the one used in a conversation of its own.");

	// a request from elsewhere in the app (the Shifter's "Ask the agent", the Mapper) goes the same way
	const asked = waitForTurn(w);
	void w.askAboutSelection("Add a shape labelled 'Asked from the Workshop'.", "🎨 Asked from the Workshop");
	log("apiChatAskedElsewhere", await asked);
	expect(await has("Asked from the Workshop"), "a request handed to the chat from elsewhere was not answered.");
	await pause(600);
	await save("chat-api.png");

	// a new diagram that is not saved yet is a diagram to draw on: the model is not told that none is open,
	// and reading its empty page says that it is the place to draw
	settings().agent = "api:stand-in"; // (this run only, as above: what was saved since has put the default back)
	const blank = await DiagramWindow.open(server);
	await blank.whenLoaded();
	expect(blank.chat.agentId === "api:stand-in", "the new window does not use the stand-in.");
	await until("the new window's chat", () => (blank.chat as any).session?.info);
	const seen = waitForTurn(blank);
	void blank.chat.send("Say which diagram you see.");
	await seen;
	const told = ([...blank.chat.items].reverse().find((i) => i.kind === "assistant") as any)?.text ?? "";
	log("apiChatNewDiagram", told || blank.chat.items.map((i: any) => `${i.kind}: ${i.text ?? i.summary ?? i.title ?? ""}`));
	expect(/I was told: Open diagram: Untitled \(a new diagram, not saved to a file yet\)/.test(told) && /This page is empty: nothing is drawn on it yet\. It is the diagram to draw on\./.test(told) && !/No draw\.io diagram is open/.test(told), "a new, unsaved diagram is not presented to the model as a diagram to draw on.");
	blank.chat.dispose();
	blank.win.destroy();

	// the key is nowhere it should not be
	const data = app.getPath("userData");
	const keyFile = fs.readFileSync(path.join(data, "api-keys.json"), "utf8");
	const leaks = [fs.readFileSync(path.join(data, "settings.json"), "utf8"), keyFile, JSON.stringify(w.chat.items), await page.executeJavaScript("document.documentElement.outerHTML")].map((text) => text.includes(STAND_IN_KEY));
	log("apiChatKeySeen", { settings: leaks[0], keyFile: leaks[1], transcript: leaks[2], page: leaks[3], keyFileHasEntry: keyFile.includes('"stand-in"') });
	expect(!leaks.some(Boolean) && keyFile.includes('"stand-in"'), "the key is readable somewhere.");

	// the key is removed: the conversation ends there
	apiAccess().removeKey(STAND_IN_ID);
	await until("the chat to notice", async () => (await shown()).dot === "problem");
	log("apiChatKeyRemoved", { ...(await shown()), note: last("note")?.text });
	expect(/key changed/.test(last("note")?.text ?? ""), "removing the key did not end the conversation.");

	// a key is kept again: a new conversation, whose tool calls are new lines under the old ones
	const lines = w.chat.items.filter((i) => i.kind === "tool").length;
	await apiAccess().saveKey(STAND_IN_ID, STAND_IN_KEY);
	await until("the chat to be ready again", async () => (await shown()).dot === "ready");
	done = turn("Add a shape labelled 'After the new key'.");
	await answer("Allow");
	const again = await done;
	const added = w.chat.items.filter((i) => i.kind === "tool").slice(lines).map((i: any) => `${i.status}: ${i.summary}`);
	log("apiChatNewKey", { ...again, reply: last("assistant")?.text, lines: added });
	expect(again.stop === "end_turn" && /request 1 of this conversation/.test(last("assistant")?.text ?? "") && added.length === 2 && added.every((l) => l.startsWith("ok: ")), "a request after the key was replaced went on with the old conversation, or its tool calls were taken for earlier ones.");
	fs.writeFileSync(path.join(config.out, "transcript.json"), JSON.stringify(w.chat.items, null, 2));

	// New Chat while something waits: the chat is emptied, and what was not sent stays with the user
	done = turn("Add a shape labelled 'Before a new chat'.");
	await until("a permission card", async () => (await waiting()).length);
	await type("Keep this for later.");
	await until("the waiting strip", async () => (await strip()).length === 1);
	w.chat.newChat();
	const emptied = await done;
	await pause(300);
	const kept: string = await page.executeJavaScript(`(() => { const i = document.getElementById("input"); const v = i.value; i.value = ""; return v; })()`);
	log("apiChatNewChat", { ...emptied, kept, strip: await strip(), items: w.chat.items.length });
	expect(kept === "Keep this for later." && !(await strip()).length && !(await has("Before a new chat")) && !w.chat.items.some((i: any) => /Keep this/.test(i.text ?? "")), "what was waiting when New Chat was pressed was sent, or lost.");
	expect(w.chat.items.length === 0, "the new chat starts with what the request it ended said of its end.");
}

/**
 * Go live between two windows: the first shares its diagram, the second joins by the link, and
 * each sees what the other does. Fails (throws) when the two diagrams differ at any step.
 */
async function runLive(w: DiagramWindow, server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const cells = async (win: DiagramWindow) => (await win.client.aiGetModel({ scope: "page", includeStyles: true, maxCells: 5000 })).cells;
	const picture = async (win: DiagramWindow) =>
		JSON.stringify((await cells(win)).map((c: any) => [c.id, c.label ?? "", c.style ?? "", c.x, c.y, c.width, c.height, c.source ?? "", c.target ?? ""]).sort());
	const same = async (a: DiagramWindow, b: DiagramWindow, what: string) => {
		const end = Date.now() + 15_000;
		for (;;) {
			const [pa, pb] = [await picture(a), await picture(b)];
			if (pa === pb) return JSON.parse(pa).length;
			if (Date.now() > end) throw new Error(`The two windows differ after ${what}: ${pa.slice(0, 300)} / ${pb.slice(0, 300)}`);
			await new Promise((r) => setTimeout(r, 150));
		}
	};
	const edit = (win: DiagramWindow, ops: any[]) => win.client.aiApplyOps(ops, { selectResult: false, flash: false, atomic: true, review: false, user: true });
	const t0 = Date.now();
	const link = await w.goLive(config.live!.relay, "Host");
	log("liveLinkShape", /^http:\/\/127\.0\.0\.1:\d+\/b\/[A-Za-z0-9_-]{22}$/.test(link));
	const guest = await DiagramWindow.join(server, link, "Guest");
	log("liveJoinMs", Date.now() - t0);
	log("liveCellsOnJoin", await same(w, guest, "joining"));
	log("liveTitles", [w.win.getTitle(), guest.win.getTitle()]);

	// the host draws; the guest sees it
	const made = await edit(w, [{ op: "addShape", tempId: "h1", label: "from the host", x: 40, y: 40, width: 140, height: 50 }]);
	const hostShape = Object.values(made.idMap)[0];
	log("liveAfterHostEdit", await same(w, guest, "the host's change"));
	// the guest draws and connects to the host's shape; the host sees it
	const gm = await edit(guest, [
		{ op: "addShape", tempId: "g1", label: "from the guest", x: 300, y: 160, width: 140, height: 50 },
		{ op: "addEdge", source: hostShape, target: "g1", label: "together" },
	]);
	log("liveAfterGuestEdit", await same(w, guest, "the guest's change"));
	// both at once, on different shapes and then on the same one
	await Promise.all([edit(w, [{ op: "update", id: hostShape, label: "host renamed" }]), edit(guest, [{ op: "move", ids: [gm.idMap.g1], dx: 30, dy: 20 }])]);
	log("liveAfterBothDifferent", await same(w, guest, "changes to different shapes at once"));
	await Promise.all([edit(w, [{ op: "update", id: hostShape, label: "host says" }]), edit(guest, [{ op: "update", id: hostShape, label: "guest says" }])]);
	log("liveAfterBothSame", await same(w, guest, "changes to the same shape at once"));
	log("liveLabelBothSee", (await cells(w)).find((c: any) => c.id === hostShape)?.label);
	// the guest deletes; undo on the host does not bring it back as its own change
	await edit(guest, [{ op: "delete", ids: [gm.idMap.g1], includeEdges: true }]);
	log("liveAfterDelete", await same(w, guest, "a deletion"));
	log("livePeople", [w.live?.people().map((p) => p.name), guest.live?.people().map((p) => p.name)]);
	log("liveDirty", { hostEdited: w.win.isDocumentEdited(), guestEdited: guest.win.isDocumentEdited() });
	log("liveSession", { host: { revision: w.live?.session.revision, settled: w.live?.session.settled }, guest: { revision: guest.live?.session.revision, settled: guest.live?.session.settled } });
	fs.writeFileSync(path.join(config.out, "live-host.png"), (await w.editorView.webContents.capturePage()).toPNG());
	fs.writeFileSync(path.join(config.out, "live-guest.png"), (await guest.editorView.webContents.capturePage()).toPNG());

	// the host stops: the guest is told, keeps the diagram, and is no longer live
	let ended: string | undefined;
	DiagramWindow.onLiveEnded = (_win, why) => (ended = why);
	await w.stopLive();
	await waitFor(() => ended, 10_000);
	log("liveEndedForGuest", ended);
	log("liveAfterStop", { hostLive: !!w.live, guestLive: !!guest.live, guestKeeps: (await cells(guest)).length, titles: [w.win.getTitle(), guest.win.getTitle()] });
	// after that a change in one is not a change in the other
	await edit(w, [{ op: "addShape", label: "after", x: 500, y: 40, width: 80, height: 40 }]);
	await new Promise((r) => setTimeout(r, 800));
	log("liveApartAfterStop", (await cells(w)).length - (await cells(guest)).length);
}

function waitForTurn(w: DiagramWindow): Promise<{ stop?: string; error?: string }> {
	return new Promise((resolve) => (w.chat.onTurnEnd = (stop, error) => resolve({ stop, error })));
}

async function waitFor<T>(get: () => T | undefined, ms: number): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = get();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function runPresent(w: DiagramWindow, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const wc = w.editorView.webContents;
	const state = () =>
		Promise.race([
			wc.executeJavaScript("window.drawaiPresentation.state()"),
			new Promise((_, rej) => setTimeout(() => rej(new Error("editor did not answer within 5s")), 5000)),
		]) as Promise<any>;
	const shot = async (name: string) => fs.writeFileSync(path.join(config.out, name), (await wc.capturePage()).toPNG());
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const key = async (keyCode: string, modifiers: any[] = []) => {
		wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
		wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
		await pause(400);
	};
	// The GitHub "octocat" link draw.io puts in its footer, which the desktop app hides.
	log(
		"githubLinks",
		await wc.executeJavaScript(`Array.from(document.querySelectorAll("a, img, div, span")).filter((e) => /github/i.test((e.getAttribute("href") || "") + (e.getAttribute("src") || "") + (e.getAttribute("title") || "") + (getComputedStyle(e).backgroundImage || ""))).map((e) => ({ tag: e.tagName, cls: e.className, title: e.getAttribute("title"), visible: e.offsetParent !== null, parent: e.parentElement && e.parentElement.className }))`)
	);
	log("stateBefore", await state());
	const xmlBefore = await w.client.getXml();
	await shot("before-present.png");
	w.setPresenting(true);
	await pause(1800);
	let s1: any;
	try {
		s1 = await state();
	} catch (e) {
		// Frozen: pause the page with the debugger and print where it is stuck.
		wc.debugger.attach("1.3");
		await wc.debugger.sendCommand("Debugger.enable");
		const paused = new Promise<any>((res) => wc.debugger.once("message", (_e, method, params) => method === "Debugger.paused" && res(params)));
		await wc.debugger.sendCommand("Debugger.pause");
		const p: any = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 5000))]);
		log("frozenStack", p ? p.callFrames.slice(0, 30).map((f: any) => `${f.functionName || "(anon)"} ${String(f.url).split("/").pop()}:${f.location.lineNumber + 1}`) : "could not pause");
		throw e;
	}
	log("presenting", s1);
	// the buttons: leave at the bottom left; the pages at the bottom right (only when there are several); no rulers
	const chrome = await wc.executeJavaScript(`(() => {
		const box = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { shown: getComputedStyle(e).display !== "none", left: Math.round(r.left), fromRight: Math.round(innerWidth - r.right), fromBottom: Math.round(innerHeight - r.bottom) }; };
		return { exit: box("drawai-present-exit"), nav: box("drawai-present-nav"), rulersShown: Array.from(document.querySelectorAll(".geRuler")).filter((r) => getComputedStyle(r).display !== "none").length };
	})()`);
	log("presentButtons", chrome);
	if (!chrome.exit?.shown || chrome.exit.left > 40 || chrome.exit.fromBottom > 40 || !chrome.nav || chrome.rulersShown) throw new Error("Presentation mode lacks its Exit button, or shows rulers (see presentButtons above).");
	await shot("present-page1.png");
	await key("Tab");
	const s2 = await state();
	log("afterTab", { page: s2.page, pages: s2.pages });
	await shot("present-page2.png");
	await key("Tab", ["shift"]);
	log("afterShiftTab", (await state()).page);
	// Drag the view with the left button.
	const { width, height } = w.editorView.getBounds();
	const cx = Math.round(width / 2);
	const cy = Math.round(height / 2);
	const before = await state();
	wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
	for (let i = 1; i <= 10; i++) {
		wc.sendInputEvent({ type: "mouseMove", x: cx + i * 15, y: cy + i * 8, button: "left", modifiers: ["leftbuttondown"] as any });
		await pause(16);
	}
	wc.sendInputEvent({ type: "mouseUp", x: cx + 150, y: cy + 80, button: "left", clickCount: 1 });
	await pause(300);
	const after = await state();
	log("pan", { before: before.translate, after: after.translate, scrollBefore: before.scroll, scrollAfter: after.scroll });
	// Clicks select nothing; right-click opens no menu.
	wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
	wc.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
	wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "right", clickCount: 1 });
	wc.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "right", clickCount: 1 });
	await pause(300);
	log(
		"afterClicks",
		await wc.executeJavaScript(`({ selected: editorUi.editor.graph.getSelectionCount(), popupMenus: document.querySelectorAll(".mxPopupMenu").length })`)
	);
	await key("Delete");
	await key("Backspace");
	await key("a", ["meta"]);
	await key("Delete");
	await shot("present-final.png");
	await key("Escape");
	await pause(1200);
	const viewless = diagramContent;
	const xmlAfter = await w.client.getXml();
	log("diagramUnchanged", viewless(xmlAfter) === viewless(xmlBefore));
	log("markedEdited", (w as any).dirty);
	const a = viewless(xmlBefore);
	const b = viewless(xmlAfter);
	if (a !== b) {
		let i = 0;
		while (i < a.length && a[i] === b[i]) i++;
		log("firstDifference", { at: i, lengths: [a.length, b.length], before: a.slice(Math.max(0, i - 150), i + 150), after: b.slice(Math.max(0, i - 150), i + 150) });
	}
	log("afterEscape", { hostPresenting: w.presenting, plugin: await state() });
	await shot("after-present.png");
	// A real edit while presenting (an agent or the Mapper still working) must still count.
	w.setPresenting(true);
	await pause(1200);
	await w.client.aiApplyOps([{ op: "addShape", label: "edited while presenting", x: 10, y: 10, width: 120, height: 40 }], { selectResult: false, flash: false, atomic: true, review: false });
	await pause(1500);
	log("editWhilePresentingMarkedEdited", (w as any).dirty);
	w.setPresenting(false);
	await pause(600);
}

async function runInsights(w: DiagramWindow, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const { execFileSync, spawn } = await import("child_process");
	const os = await import("os");
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const call = async (name: string, args: unknown = {}) => {
		const r = await w.callTool(name, args);
		if (r.isError) throw new Error(`${name}: ${r.text}`);
		return JSON.parse(r.text);
	};
	// A small repository under git, from the software test fixture.
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "drawai-insights-"));
	fs.cpSync(path.join(__dirname, "../test/fixtures/software/shop"), repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
	git("init", "-q");
	git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "add", "-A");
	git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "initial");

	const run = await call("mapper_run", { recipe: "software.connectivity", input: { folder: repo } });
	log("run", { summary: run.map.summary, page: run.drawnOn, badges: run.healthBadges, findings: run.map.findings });
	const mapId = run.map.id;
	const maps = await call("mapper_maps");
	log("maps", { count: maps.maps.length, onPage: maps.onPage });
	const found = await call("mapper_find", { query: "postgres" });
	log("find", found.slice(0, 3).map((n: any) => `${n.id} (${n.kind})`));
	const any = found[0] ?? (await call("mapper_find", { query: "" }))[0];
	const shown = await call("mapper_show", { nodeId: any.id });
	log("show", { id: shown.id, uses: shown.uses.length, usedBy: shown.usedBy.length, files: shown.files?.length ?? 0 });
	const ws = await call("mapper_worksheet", { mapId, limit: 5 });
	log("worksheet", { total: ws.total, first: ws.entries.map((e: any) => e.id) });
	const desc = await call("mapper_set_descriptions", {
		mapId,
		items: [{ nodeId: ws.entries[0].id, description: "Keeps the shop running and answers the pages people open." }, { nodeId: "nope", description: "Nothing here at all, really." }],
	});
	log("describe", desc);
	const page = await w.client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 5000 });
	log("tooltipOnShape", page.cells.find((c) => c.data?.mapperId === ws.entries[0].id)?.data?.tooltip ?? null);
	log("healthBadgesOnPage", page.cells.filter((c) => c.data?.mapperKind === "finding-badge").length);
	log("layers", page.layers.map((l) => l.name));
	const findings = await call("mapper_findings", { mapId });
	log("findings", { n: findings.findings.length, checked: findings.checked.length, first: findings.findings[0]?.title ?? null });
	// The chat's Map ▾ menu, clicked like the user would.
	await pause(800);
	const cw = w.chatView.webContents;
	log("mapMenuButton", await cw.executeJavaScript(`(() => { const b = document.getElementById("mapActions"); return b.classList.contains("hidden") ? null : b.textContent.trim(); })()`));
	await cw.executeJavaScript(`document.getElementById("mapActions").click(); document.querySelector('#mapMenu button[data-action="findings"]').click(); true`);
	await pause(1500);
	const report = w.chat.items.filter((i) => i.kind === "report").slice(-1)[0] as any;
	log("findingsReport", report ? { title: report.title, rows: report.rows.length, firstActions: report.rows[0]?.actions?.map((a: any) => a.title), footer: String(report.footer ?? "").split("\n")[0] } : null);
	fs.writeFileSync(path.join(config.out, "findings-chat.png"), (await cw.capturePage()).toPNG());
	// "Show on map" selects the finding's shapes.
	await cw.executeJavaScript(`(() => { const b = [...document.querySelectorAll(".report .ractions button")].find((x) => x.textContent === "Show on map"); b && b.click(); return !!b; })()`);
	await pause(1200);
	log("showOnMapSelected", w.client.currentSelection.length);

	// Change a file the map knows about, and add one.
	const known = run && (await call("mapper_show", { nodeId: any.id })).files?.[0];
	const target = known ? path.join(repo, known.replace(/\/$/, "")) : undefined;
	if (target && fs.existsSync(target) && fs.statSync(target).isFile()) fs.appendFileSync(target, "\n// changed by e2e\n");
	fs.writeFileSync(path.join(repo, "NEW_FILE.md"), "new");
	const recent = await call("mapper_recent_changes", { mapId, draw: true });
	log("recent", { since: recent.since, files: recent.changedFiles, shapes: recent.shapes.map((s: any) => s.nodeId).slice(0, 5), badges: recent.badges });

	const refreshed = await call("mapper_refresh", { mapId });
	log("refresh", { page: refreshed.drawnOn, diff: refreshed.diff, carriedDescriptions: refreshed.map.described });
	const newMap = refreshed.map.id;

	const path2 = shown.uses[0] ? await call("mapper_path", { mapId: newMap, from: shown.id, to: shown.uses[0].id }) : null;
	log("path", path2?.map((s: any) => s.id) ?? null);
	const steps = [shown.id, ...(shown.uses[0] ? [shown.uses[0].id] : [])].map((id: string, i: number) => ({ title: `Step ${i + 1}`, caption: `This is ${id}.`, nodeIds: [id] }));
	const tour = await call("mapper_set_tour", { mapId: newMap, title: "Quick tour", steps });
	log("tour", tour);

	// Play it in presentation mode.
	w.setPresenting(true, { startTour: true });
	await pause(1800);
	const st = await w.editorView.webContents.executeJavaScript("window.drawaiPresentation.state()");
	log("presentTour", st.tour);
	fs.writeFileSync(path.join(config.out, "tour.png"), (await w.editorView.webContents.capturePage()).toPNG());
	w.editorView.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
	await pause(600);
	log("tourAfterTab", (await w.editorView.webContents.executeJavaScript("window.drawaiPresentation.state()")).tour);
	w.setPresenting(false);
	await pause(800);

	const answer = await call("mapper_answer", { question: "What does it talk to?", answer: "Its database.", steps: steps.map((s) => ({ nodeId: s.nodeIds[0], note: s.caption, mapId: newMap })) });
	log("answer", answer);
	fs.writeFileSync(path.join(config.out, "answer.png"), (await w.editorView.webContents.capturePage()).toPNG());

	// The desktop-wide endpoint, as Claude Code / Codex reach it.
	const home = process.env.DRAWIO_AI_HOME!;
	const info = JSON.parse(fs.readFileSync(path.join(home, "desktop.json"), "utf8"));
	const rpc = async (method: string, params: unknown) =>
		(await (await fetch(info.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
	const dtools = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
	log("desktopTools", { count: dtools.length, mapper: dtools.filter((n: string) => n.startsWith("mapper_")).length, hasList: dtools.includes("drawio_list_diagrams") });
	const dlist = JSON.parse((await rpc("tools/call", { name: "drawio_list_diagrams", arguments: {} })).result.content[0].text);
	log("desktopDiagrams", dlist);
	const dmaps = JSON.parse((await rpc("tools/call", { name: "mapper_maps", arguments: { file: config.file } })).result.content[0].text);
	log("desktopMaps", dmaps.maps.length);
	// The launcher, over stdio, exactly as an agent starts it.
	const launcher = path.join(home, "bin", "omnidraw-mcp");
	const out = await new Promise<string>((resolve) => {
		const child = spawn(launcher, [], { env: { ...process.env, DRAWIO_AI_HOME: home } });
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			if (buf.split("\n").filter(Boolean).length >= 2) {
				child.kill();
				resolve(buf);
			}
		});
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }) + "\n");
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mapper_find", arguments: { query: "postgres", file: config.file } } }) + "\n");
		setTimeout(() => {
			child.kill();
			resolve(buf);
		}, 15000);
	});
	const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	log("launcher", { server: lines[0]?.result?.serverInfo?.name ?? null, findOk: !!lines[1]?.result && !lines[1].result.isError });
	log("recordFiles", fs.readdirSync(path.join(path.dirname(config.file), ".drawai", "maps")).length);
}

async function runPolish(w: DiagramWindow, server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const ed = w.editorView.webContents, chat = w.chatView.webContents;
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const save = async (name: string, wc: Electron.WebContents, rect?: Electron.Rectangle) => {
		const img = await wc.capturePage();
		const f = img.getSize().width / ((await wc.executeJavaScript("innerWidth")) as number);
		const out = rect ? img.crop({ x: Math.round(rect.x * f), y: Math.round(rect.y * f), width: Math.round(Math.min(rect.width * f, img.getSize().width)), height: Math.round(Math.min(rect.height * f, img.getSize().height)) }) : img;
		fs.writeFileSync(path.join(config.out, name), out.toPNG());
	};
	const top = async () => ({ x: 0, y: 0, width: (await ed.executeJavaScript("innerWidth")) as number, height: 80 });

	// window placement: inside the display's work area
	const b = w.win.getBounds(), area = screen.getDisplayMatching(b).workArea;
	log("windowInsideWorkArea", b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);

	// toolbar: the mark before File, panel buttons, presentation, chat toggle, the panel menu
	log(
		"toolbar",
		await ed.executeJavaScript(`(() => {
			const menubar = document.querySelector(".geMenubarContainer");
			const first = document.querySelector(".geToolbarContainer").firstElementChild;
			const titles = Array.from(document.querySelectorAll(".geToolbarContainer a.geButton")).map((a) => a.getAttribute("title") || "").filter(Boolean);
			return {
				markFirstInToolbar: !!(first && first.classList.contains("drawai-mark")),
				drawioMenubarHidden: !menubar || getComputedStyle(menubar).display === "none",
				layers: titles.some((t) => /^Layers/.test(t)), tags: titles.some((t) => /^Tags/.test(t)), outline: titles.some((t) => /^Outline/.test(t)),
				present: titles.some((t) => /Presentation/.test(t)), chatToggle: !!document.querySelector(".drawai-chat-toggle"),
			};
		})()`)
	);
	// draw.io's menus in the system menu bar
	await pause(800);
	const appMenu = Menu.getApplicationMenu()!;
	const sub = (label: string) => appMenu.items.find((i) => i.label === label)?.submenu;
	const labels = (label: string) => (sub(label)?.items ?? []).filter((i) => i.type !== "separator").map((i) => i.label);
	log("menuSnapshot", await ed.executeJavaScript(`(() => { const out = {}; const errs = []; const ow = console.warn; console.warn = (...a) => errs.push(a.map(String).join(" ")); try { const m = window.drawaiMenubar.peek(); for (const k in m) out[k] = (m[k] || []).map((n) => n.separator ? "-" : n.label + (n.children ? "▸" : "") + (n.key ? "[" + n.key + "]" : "")); } finally { console.warn = ow; } out.errors = errs; return out; })()`));
	log("menuBar", { top: appMenu.items.map((i) => i.label), edit: labels("Edit").length, view: labels("View").length, arrange: labels("Arrange").length, extras: labels("Extras").length, file: labels("File") });
	const gridItem = sub("View")?.items.find((i) => /^Grid$/.test(i.label));
	const gridBefore = await ed.executeJavaScript(`window.drawaiMenubar && document.querySelector(".geDiagramContainer") ? !!(window.drawaiTestUi || null) : null`);
	void gridBefore;
	const gridState = () => ed.executeJavaScript(`window.drawaiMenubar.gridEnabled()`);
	const g0 = await gridState();
	gridItem?.click();
	await pause(600);
	const g1 = await gridState();
	gridItem && sub("View")?.items.find((i) => /^Grid$/.test(i.label))?.click();
	log("menuGridToggles", { found: !!gridItem, before: g0, after: g1 });
	await pause(600);
	// Edit → Undo from the menu bar undoes a canvas edit (draw.io's own undo, not the text field's)
	const cells = async () => JSON.parse(((await rpcTool(w, "drawio_get_diagram", {})) as any).text ?? "{}").totalCells;
	const c0 = await cells();
	await ed.executeJavaScript(`(() => { const ui = window.drawaiMenubar; return !!ui; })()`);
	await rpcTool(w, "drawio_apply_operations", { ops: [{ op: "addShape", label: "undo me", x: 10, y: 10, width: 80, height: 40 }] });
	await pause(600);
	const c1 = await cells();
	ed.focus();
	await ed.executeJavaScript(`document.querySelector(".geDiagramContainer").focus()`);
	const undo = Menu.getApplicationMenu()!.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => /^Undo/.test(i.label));
	undo?.click();
	await pause(800);
	log("menuUndo", { found: !!undo, before: c0, afterAdd: c1, afterUndo: await cells() });
	// with the new shape selected (draw.io then keeps a hidden text field focused), Undo still works
	await rpcTool(w, "drawio_apply_operations", { ops: [{ op: "addShape", label: "selected", x: 120, y: 10, width: 80, height: 40 }] });
	await pause(500);
	const added = JSON.parse(((await rpcTool(w, "drawio_find_cells", { query: "selected" })) as any).text ?? "{}");
	const addedId = (added.cells ?? added.matches ?? added)[0]?.id;
	if (addedId) await rpcTool(w, "drawio_select_cells", { ids: [addedId] });
	ed.focus();
	await pause(400);
	const s1 = await cells();
	const focusIsShim = await ed.executeJavaScript(`(() => { const a = document.activeElement; return a ? (a.className || a.tagName) : null; })()`);
	Menu.getApplicationMenu()!.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => /^Undo/.test(i.label))?.click();
	await pause(800);
	log("menuUndoWithSelection", { selected: !!addedId, focus: focusIsShim, before: s1, afterUndo: await cells() });
	// a draw.io shortcut that reaches the menu while the chat has focus does nothing to the diagram
	const dup = Menu.getApplicationMenu()!.items.find((i) => i.label === "Edit")?.submenu?.items.find((i) => /^Duplicate/.test(i.label));
	const d0 = await cells();
	chat.focus();
	await pause(200);
	(dup as any)?.click({ triggeredByAccelerator: true }, undefined, { triggeredByAccelerator: true });
	await pause(800);
	log("menuKeyFromChatIgnored", { found: !!dup, before: d0, after: await cells() });

	// the first toolbar button shows and hides the Shapes panel directly (no menu)
	const shapesShown = `(() => { const sb = document.querySelector(".geSidebarContainer:not(.geFormatContainer)"); return !!sb && sb.offsetWidth > 20 && getComputedStyle(sb).display !== "none"; })()`;
	const clickShapes = `(() => { const b = document.querySelector('.geToolbarContainer [data-drawai="shapes-toggle"]'); b && b.dispatchEvent(new MouseEvent("click", { bubbles: true })); return !!b; })()`;
	const shapes0 = await ed.executeJavaScript(shapesShown);
	const hasShapesBtn = await ed.executeJavaScript(clickShapes);
	await pause(500);
	const shapes1 = await ed.executeJavaScript(shapesShown);
	const menuOpened = await ed.executeJavaScript(`document.querySelectorAll(".mxPopupMenu .mxPopupMenuItem").length`);
	await ed.executeJavaScript(clickShapes);
	await pause(500);
	log("shapesToggle", { button: hasShapesBtn, before: shapes0, afterOneClick: shapes1, afterTwo: await ed.executeJavaScript(shapesShown), menuOpened });
	// Ruler is a toolbar button; the chat's arrow says which way the chat goes; tooltips are quick
	log("toolbarExtras", await ed.executeJavaScript(`(() => {
		const ruler = document.querySelector('.geToolbarContainer [data-drawai="ruler"]');
		const arrow = document.querySelector(".drawai-chat-toggle");
		return { ruler: !!ruler, chatArrow: arrow ? arrow.getAttribute("data-chat") : null, tips: !!window.DrawAITips && window.DrawAITips.delay };
	})()`));
	await save("toolbar-buttons.png", ed, await top());

	// the Scratchpad: a shape put on it is kept by the app, so it is there after a restart
	const scratch0 = await ed.executeJavaScript(`window.omnidrawShapes.scratchpad()`);
	await ed.executeJavaScript(`window.omnidrawShapes.scratchpad("kept shape")`);
	await pause(1500);
	const scratch1 = await ed.executeJavaScript(`window.omnidrawShapes.scratchpad()`);
	const kept = drawioLocalStorage()[".scratchpad"] ?? "";
	// a window opened afterwards (as after a restart: a fresh page given what the app kept) has it too
	const second = await DiagramWindow.open(server);
	await second.whenLoaded();
	await pause(1200);
	const scratch2 = await second.editorView.webContents.executeJavaScript(`window.omnidrawShapes.scratchpad()`);
	(second as any).win?.destroy?.();
	await pause(300);
	log("scratchpad", { before: scratch0, after: scratch1, keptByApp: kept.includes("kept shape") || /mxlibrary/.test(kept), keptBytes: kept.length, inNewWindow: scratch2 });
	if (!scratch0.open || scratch1.items !== scratch0.items + 1 || !/mxlibrary/.test(kept) || scratch2.items !== scratch1.items) throw new Error("The Scratchpad does not keep its shapes (see the scratchpad line above).");

	// the matrix: the chat head's dot field over every surface, but never over the diagram
	const matrix = async (wc: Electron.WebContents) => wc.executeJavaScript(`window.omnidrawMatrix ? window.omnidrawMatrix.stats() : null`);
	const edMatrix = await matrix(ed), chatMatrix = await matrix(chat);
	const overDiagram = await ed.executeJavaScript(`(() => {
		const c = document.querySelector(".matrix-layer canvas"), d = document.querySelector(".geDiagramContainer").getBoundingClientRect();
		const k = c.width / window.innerWidth, g = c.getContext("2d");
		const lit = (x, y, w, h) => { const px = g.getImageData(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k)).data; let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n; };
		return { inDiagram: lit(d.left + 20, d.top + 20, 120, 120), inToolbar: lit(0, 0, 300, 30) };
	})()`);
	log("matrix", { editor: edMatrix, chat: chatMatrix, overDiagram });
	if (!edMatrix?.dots || !chatMatrix?.dots || edMatrix.holes !== 1 || overDiagram.inDiagram !== 0 || overDiagram.inToolbar === 0) throw new Error("The matrix is not on every surface, or is over the diagram (see the matrix line above).");
	await save("matrix-editor.png", ed);
	await save("matrix-chat.png", chat);

	// the Format panel has the chat's live dot field in its top right corner
	await pause(600);
	log("formatDots", await ed.executeJavaScript(`(() => {
		const c = document.querySelector(".geFormatContainer .drawai-backdrop canvas, .drawai-dots-host .drawai-backdrop canvas");
		const f = window.omnidrawFormatDots;
		return { canvas: !!c, width: c ? c.width : 0, dots: f ? f.engine.stats().dots : 0 };
	})()`));
	// the chat's dot object: a square of layers that changes shape, and flies to the top right corner on typing
	const orb = () => chat.executeJavaScript("(() => { const o = window.drawaiUI.orb(); return { docked: o.docked, shape: o.shape, x: Math.round(o.rect.x), y: Math.round(o.rect.y), w: Math.round(o.rect.w) }; })()");
	const orb0 = await orb();
	await chat.executeJavaScript(`(() => { const o = document.getElementById("emptyObject"); return new Promise((r) => { const t0 = Date.now(); (function wait() { if ((o.dataset.shape && o.dataset.shape !== "planes") || Date.now() - t0 > 9000) r(); else setTimeout(wait, 150); })(); }); })()`);
	const orbMorphed = await orb();
	await pause(1900);
	await save("chat-orb-morphed.png", chat);
	await chat.executeJavaScript(`(() => { const i = document.getElementById("input"); i.value = "hello"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await pause(900);
	const orbTyping = await orb();
	await save("chat-orb-docked.png", chat);
	await chat.executeJavaScript(`(() => { const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await pause(900);
	log("chatOrb", { start: orb0, morphed: orbMorphed.shape, typing: orbTyping, cleared: await orb(), viewport: await chat.executeJavaScript("window.innerWidth") });

	// icon styles, in both themes
	for (const theme of ["light", "dark"] as const) {
		process.env.DRAWAI_THEME = theme;
		for (const style of ["dots2d", "dots", "real", "classic"] as const) {
			updateSettings({ appearance: { ...settings().appearance, theme, iconStyle: style } });
			await pause(700);
			await save(`toolbar-${theme}-${style}.png`, ed, await top());
			await save(`chat-${theme}-${style}.png`, chat);
		}
		const zoomIn = await ed.executeJavaScript(`(() => { const a = Array.from(document.querySelectorAll(".geToolbarContainer a.geButton")).find((x) => /^Zoom In/.test(x.getAttribute("title") || "")); return a ? a.style.backgroundImage.length : 0; })()`);
		log(`zoomInIconBytes-${theme}-classic`, zoomIn);
	}
	process.env.DRAWAI_THEME = "light";
	updateSettings({ appearance: { ...settings().appearance, theme: "light", iconStyle: "dots2d", toolbar: "top" } });
	await pause(600);
	// the toolbar on each side
	for (const side of ["left", "right", "bottom", "top"] as const) {
		updateSettings({ appearance: { ...settings().appearance, toolbar: side } });
		await pause(700);
		log(
			`toolbar-${side}`,
			await ed.executeJavaScript(`(() => { const t = document.querySelector(".geToolbarContainer").getBoundingClientRect(), d = document.querySelector(".geDiagramContainer").getBoundingClientRect(); const visible = Array.from(document.querySelectorAll(".geToolbarContainer a.geButton")).filter((b) => b.offsetParent && b.getBoundingClientRect().width > 0).length; return { toolbar: [Math.round(t.left), Math.round(t.top), Math.round(t.width), Math.round(t.height)], diagram: [Math.round(d.left), Math.round(d.top), Math.round(d.width), Math.round(d.height)], buttons: visible }; })()`)
		);
		await save(`layout-toolbar-${side}.png`, ed);
	}
	log("chatIconsDrawn", await chat.executeJavaScript(`document.querySelectorAll("[data-icon] svg.icon").length`));
	log("chatToolbarOneRow", await chat.executeJavaScript(`(() => { const tops = new Set(Array.from(document.querySelectorAll("#context > .tb:not(.hidden)")).map((b) => Math.round(b.getBoundingClientRect().top))); return tops.size === 1; })()`));

	// the agent and model menus (in-app, under their buttons)
	for (const id of ["providerBtn", "modelBtn"]) {
		const r = await chat.executeJavaScript(`(() => { const b = document.getElementById("${id}"); b.click(); const m = document.getElementById("pickMenu"); const br = b.getBoundingClientRect(), mr = m.getBoundingClientRect(); return { open: !m.classList.contains("hidden"), items: Array.from(m.querySelectorAll("button")).map((x) => x.textContent.trim()), belowButton: Math.abs(mr.top - br.bottom - 6) < 2 }; })()`);
		log(`menu-${id}`, r);
		await pause(350);
		await save(`menu-${id}.png`, chat);
		await chat.executeJavaScript(`document.body.click()`);
		await pause(200);
	}

	// the chat slides away and docks left
	const editorWidth = () => w.editorView.getBounds().width;
	const full = w.win.getContentBounds().width;
	w.setChatVisible(false);
	await pause(300);
	log("collapsedEditorFullWidth", editorWidth() === full);
	await ed.executeJavaScript(`document.querySelector(".drawai-chat-toggle").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
	await pause(500);
	log("chatBackViaToolbar", editorWidth() < full);
	updateSettings({ chat: { ...settings().chat, side: "left" } });
	await pause(400);
	log("dockedLeft", { chatX: w.chatView.getBounds().x, editorX: w.editorView.getBounds().x });
	await save("chat-left.png", chat);
	updateSettings({ chat: { ...settings().chat, side: "right" } });
	await pause(300);

	// a shape folder becomes a palette
	const shapes = fs.mkdtempSync(path.join(require("os").tmpdir(), "drawai-shapes-"));
	fs.writeFileSync(path.join(shapes, "server-rack.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 48"><rect x="2" y="2" width="28" height="44" rx="3" fill="#ddd" stroke="#333"/></svg>');
	fs.writeFileSync(path.join(shapes, "cloud.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24"><ellipse cx="20" cy="12" rx="18" ry="10" fill="#cde"/></svg>');
	updateSettings({ shapes: { locations: [{ path: shapes, name: "My test shapes", enabled: true }] } });
	await pause(1200);
	log("shapePalette", await ed.executeJavaScript(`(async () => {
		const titles = Array.from(document.querySelectorAll(".geSidebarContainer .geTitle")).filter((e) => /My test shapes/.test(e.textContent));
		const t = titles[0];
		const imgs = t && t.nextElementSibling ? Array.from(t.nextElementSibling.querySelectorAll("a.geItem img, a.geItem image")) : [];
		await new Promise((r) => setTimeout(r, 300));
		return { palettes: titles.length, items: t && t.nextElementSibling ? t.nextElementSibling.querySelectorAll("a.geItem").length : 0, imagesLoaded: imgs.filter((i) => i.tagName === "image" || (i.complete && i.naturalWidth > 0)).length };
	})()`));
	await save("sidebar-shapes.png", ed, { x: 0, y: 0, width: 260, height: Math.min(900, w.editorView.getBounds().height) });

	// Settings, every section, in both themes
	SettingsWindow.open(server);
	for (let i = 0; i < 50 && !SettingsWindow.window?.isVisible(); i++) await pause(100);
	const sw = SettingsWindow.window!;
	await pause(800);
	for (const theme of ["light", "dark"] as const) {
		process.env.DRAWAI_THEME = theme;
		updateSettings({ appearance: { ...settings().appearance, theme, iconStyle: "dots2d" } });
		await pause(500);
		for (const section of ["appearance", "agents", "chat", "editor", "shapes"]) {
			await sw.webContents.executeJavaScript(`document.querySelector('nav [data-section="${section}"]').click()`);
			await pause(400);
			await save(`settings-${theme}-${section}.png`, sw.webContents);
			// (Agents & models has a second half: the API keys)
			if (section === "agents") {
				await sw.webContents.executeJavaScript(`document.querySelector('#agentTabs [data-tab="api"]').click()`);
				await pause(300);
				await save(`settings-${theme}-api-keys.png`, sw.webContents);
			}
		}
	}
	log("settingsSections", await sw.webContents.executeJavaScript(`Array.from(document.querySelectorAll("nav [data-section]")).map((b) => b.textContent.trim())`));
	// API keys: the providers, none with a key in this run's empty data folder. What is not a
	// key is refused before anything is sent or the keychain is asked (so this run touches neither).
	await sw.webContents.executeJavaScript(`document.querySelector('nav [data-section="agents"]').click(); document.querySelector('#agentTabs [data-tab="api"]').click()`);
	const apiCards = `Array.from(document.querySelectorAll("#apiList .agent")).map((c) => [c.querySelector("header b").textContent, c.querySelector("header .tag").textContent, !!c.querySelector('.keyrow input[type="password"]'), c.querySelector(".bad") ? c.querySelector(".bad").textContent : null])`;
	const apis: [string, string, boolean, string | null][] = await sw.webContents.executeJavaScript(apiCards);
	log("settingsApis", apis);
	await sw.webContents.executeJavaScript(`(() => { const c = document.querySelector('#apiList .agent[data-api="openai"]'); c.querySelector(".keyrow input").value = "not a key"; c.querySelector(".keyrow button").click(); })()`);
	await pause(600);
	const refused: [string, string, boolean, string | null][] = await sw.webContents.executeJavaScript(apiCards);
	log("settingsApiRefused", refused[1]);
	if (apis.map((a) => a[0]).join() !== "Anthropic API,OpenAI API,Gemini API,Grok API,Kimi API,OpenRouter" || apis.some((a) => a[1] !== "No key" || !a[2] || a[3]) || !/does not look like an API key/.test(refused[1]?.[3] ?? "") || refused[1][1] !== "No key" || fs.existsSync(path.join(app.getPath("userData"), "api-keys.json")))
		throw new Error("Settings does not list the API providers as it should (see the settingsApis lines above).");
	sw.close();
	process.env.DRAWAI_THEME = "light";
	updateSettings({ appearance: { ...settings().appearance, theme: "light", iconStyle: "dots2d" } });
}

/** Calls a diagram tool on the window's MCP server, as an agent would. */
async function rpcTool(w: DiagramWindow, name: string, args: unknown): Promise<unknown> {
	return w.callTool(name, args);
}

async function runWorkshop(w: DiagramWindow, server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void): Promise<void> {
	const { WorkshopWindow } = await import("./workshop/workshopWindow");
	const { galleries, galleryConfigs } = await import("./workshop");
	const ed = w.editorView.webContents;
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const until = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> => {
		const end = Date.now() + ms;
		for (;;) {
			const v = await fn();
			if (v) return v as T;
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
			await pause(250);
		}
	};
	const shot = async (name: string, wc: Electron.WebContents) => fs.writeFileSync(path.join(config.out, name), (await wc.capturePage()).toPNG());
	log("mirror", process.env.OMNIDRAW_GALLERY_MIRROR ?? null);

	// the default galleries become palettes in the shapes sidebar
	const palettes: string[] = await until("gallery palettes", async () => {
		const p: string[] = await ed.executeJavaScript("window.omnidrawShapes ? window.omnidrawShapes.palettes() : []");
		return ["theSVG", "Tech logos", "UI icons"].every((t) => p.some((x) => x.startsWith(t))) ? p : undefined;
	});
	log("palettes", palettes.filter((p) => /theSVG|Tech logos|UI icons/.test(p)));
	await shot("sidebar-galleries.png", ed);

	// draw.io's own search finds gallery shapes
	const found: string[] = await ed.executeJavaScript(`window.omnidrawShapes.search("kubernetes")`);
	const fromGallery = (await galleries().search(galleryConfigs(), "kubernetes", { limit: 50 })).map((h) => h.item.title);
	log("drawioSearch", { results: found.length, galleryTitlesFound: fromGallery.filter((t) => found.includes(t + " (gallery)")) });

	// the Workshop: search with previews, click to add to the diagram
	WorkshopWindow.open(server, "gallery");
	const ww = await until("the Workshop window", async () => WorkshopWindow.window?.isVisible() && WorkshopWindow.window);
	const wc = ww.webContents;
	await until("gallery counts", async () => wc.executeJavaScript(`document.querySelectorAll("#galleryList .gallery .num").length >= 3 && !document.querySelector("#galleryList .dot-loader")`));
	log("galleries", (await import("./workshop")).galleries().status(galleryConfigs()).map((g) => ({ id: g.id, count: g.count, error: g.error ?? null })));
	await shot("workshop-empty-light.png", wc);
	await wc.executeJavaScript(`(() => { const q = document.getElementById("q"); q.value = "server"; q.dispatchEvent(new Event("input")); })()`);
	const tiles = await until("results with previews", async () => {
		const r = await wc.executeJavaScript(`({ tiles: document.querySelectorAll("#grid .tile").length, imgs: document.querySelectorAll("#grid .tile img").length })`);
		return r.tiles > 0 && r.imgs >= Math.min(3, r.tiles) ? r : undefined;
	});
	log("workshopSearch", tiles);
	await shot("workshop-search-light.png", wc);
	const before = (await w.client.getXml()).split("galleryItem=").length - 1;
	await wc.executeJavaScript(`document.querySelector("#grid .tile").click()`);
	const after = await until("the inserted shape", async () => {
		const n = (await w.client.getXml()).split("galleryItem=").length - 1;
		return n > before ? n : undefined;
	});
	log("inserted", { before, after });

	// a hostile SVG from a source arrives cleaned (the devicon fixture for docker has a script)
	const tech = galleryConfigs().find((g) => g.id === "tech-logos")!;
	const docker = (await galleries().items(tech)).find((i) => i.id === "devicon:docker")!;
	const cleaned = await galleries().svg(tech, docker);
	log("hostileSvgCleaned", !!cleaned && !/script|onload|evil/i.test(cleaned));

	// a GitHub gallery, and a collection
	await wc.executeJavaScript(`window.omnidrawWorkshop.post({ type: "addGithub", url: "acme/icons/tree/main/icons" })`);
	const gh = await until("the GitHub gallery", async () => (await import("./workshop")).galleries().status(galleryConfigs()).find((g) => g.kinds.includes("github") && (g.count ?? 0) > 0));
	log("githubGallery", { title: gh.title, count: gh.count });
	await wc.executeJavaScript(`window.omnidrawWorkshop.post({ type: "newCollection", title: "Network kit" })`);
	const col = await until("the collection", async () => galleryConfigs().find((g) => g.title === "Network kit"));
	const ghItems = await galleries().items(galleryConfigs().find((g) => g.id === gh.id)!);
	await wc.executeJavaScript(`window.omnidrawWorkshop.post({ type: "addToCollection", collectionId: ${JSON.stringify(col.id)}, galleryId: ${JSON.stringify(gh.id)}, itemId: ${JSON.stringify(ghItems[0].id)} })`);
	const colCount = await until("the collection's shape", async () => {
		const n = (await galleries().items(galleryConfigs().find((g) => g.id === col.id)!, true)).length;
		return n > 0 ? n : undefined;
	});
	log("collection", { title: col.title, count: colCount, file: fs.existsSync(galleries().collectionFile(col.id)) });
	// with its first shape the collection becomes a palette in the diagram (palettes follow what a gallery holds)
	const colPalette = await until("the collection's palette in the diagram", async () => ((await ed.executeJavaScript("window.omnidrawShapes.palettes()")) as string[]).find((p) => /^Network kit/.test(p)));
	log("collectionPalette", colPalette);
	await pause(600);
	await shot("workshop-galleries-light.png", wc);

	// draw.io's own shape sets are chosen here too (its "More Shapes" dialog is gone)
	const sets = await until("draw.io's shape sets in the Workshop", async () => {
		const r = await wc.executeJavaScript(`({ groups: document.querySelectorAll("#shapeSets details.sets").length, rows: document.querySelectorAll("#shapeSets .set").length, on: document.querySelectorAll("#shapeSets .set input:checked").length })`);
		return r.rows > 20 ? r : undefined;
	});
	const paletteShown = (title: string) => ed.executeJavaScript(`(() => { const t = Array.from(document.querySelectorAll(".geSidebarContainer .geTitle")).find((x) => x.textContent.trim() === ${JSON.stringify(title)}); return !!t && getComputedStyle(t).display !== "none" && t.offsetHeight > 0; })()`);
	const click = (id: string) => wc.executeJavaScript(`(() => { const i = document.querySelector('#shapeSets .set[data-set="${id}"] input'); if (!i) return false; i.closest("details").open = true; i.click(); return i.checked; })()`);
	const umlBefore = await paletteShown("UML");
	const umlSwitch = await click("uml");
	const umlOn = await until("the UML palette", async () => ((await paletteShown("UML")) ? true : undefined));
	const remembered = () => String(drawioLocalStorage()[".drawio-config@undefined"] ?? Object.entries(drawioLocalStorage()).find(([k]) => k.startsWith(".drawio-config"))?.[1] ?? "");
	await pause(700);
	const keptOn = /"libraries":"[^"]*\buml\b/.test(remembered());
	await shot("workshop-sets-light.png", wc);
	await click("uml");
	await until("the UML palette to go", async () => ((await paletteShown("UML")) ? undefined : true));
	// the Scratchpad is one of the switches
	const padBefore = (await ed.executeJavaScript(`window.omnidrawShapes.scratchpad()`)).open;
	await click(".scratchpad");
	const padOff = await until("the Scratchpad to close", async () => ((await ed.executeJavaScript(`window.omnidrawShapes.scratchpad()`)).open ? undefined : true));
	await click(".scratchpad");
	const padBack = await until("the Scratchpad to open again", async () => ((await ed.executeJavaScript(`window.omnidrawShapes.scratchpad()`)).open ? true : undefined));
	// the galleries' palettes are still there after draw.io's sets changed
	const stillThere: string[] = await ed.executeJavaScript("window.omnidrawShapes.palettes()");
	// "+ More Shapes" in the editor opens the Workshop at these switches, not draw.io's dialog
	ww.hide();
	await ed.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll(".geSidebarFooter button, .geSidebarFooter a, .geSidebarContainer button")).find((x) => /More Shapes/.test(x.textContent)); if (b) b.click(); return !!b; })()`).then((found) => log("moreShapesButton", found));
	const reopened = await until("the Workshop from More Shapes", async () => (ww.isVisible() ? true : undefined)).catch(() => false);
	const drawioDialog = await ed.executeJavaScript(`!!document.querySelector(".geDialog")`);
	log("shapeSets", { listed: sets, uml: { before: umlBefore, switchedOn: umlSwitch, paletteShown: umlOn, remembered: keptOn }, scratchpad: { before: padBefore, off: padOff, back: padBack }, galleriesKept: ["theSVG", "Tech logos", "UI icons"].every((t) => stillThere.some((x) => x.startsWith(t))), moreShapesOpensWorkshop: reopened, drawioDialog });
	if (!umlOn || !keptOn || !padOff || !padBack || !reopened || drawioDialog) throw new Error("The Workshop does not switch draw.io's shape sets as it should (see the shapeSets line above).");

	// ----- the Shape Shifter: find by words, change a shape, import a stencil -----
	const cellCount = async () => (await w.client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 1 })).totalCells;
	await wc.executeJavaScript(`document.querySelector('nav button[data-mode="shifter"]').click(); true`);
	const type = (text: string) => wc.executeJavaScript(`(() => { const q = document.getElementById("q"); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event("input")); return true; })()`);
	await type("database");
	const finds = await until("the Shifter's finds", async () => {
		const r = await wc.executeJavaScript(
			`(() => ({ groups: [...document.querySelectorAll("#grid .group")].map((g) => g.textContent.replace(/ · \\d+$/, "")), own: document.querySelectorAll('#grid .tile[data-key^="own:"]').length, ownPictures: [...document.querySelectorAll('#grid .tile[data-key^="own:"] img')].filter((i) => i.complete && i.naturalWidth > 0).length, gallery: document.querySelectorAll('#grid .tile:not([data-key^="own:"])').length }))()`
		);
		return r.own > 0 && r.gallery > 0 && r.ownPictures > 0 ? r : undefined;
	});
	// (shapes that are pictures of draw.io's own, not vector stencils, show the picture)
	const pictures = (await w.searchOwnShapes("database", 36)).filter((x) => /(^|;)image=img\//.test(x.style));
	log("shifterFind", { ...finds, pictureShapes: pictures.length, withPreview: pictures.filter((x) => (x.preview ?? "").length > 200).length });
	if (pictures.some((x) => !x.preview)) throw new Error("A draw.io picture shape has no preview in the Shape Shifter.");
	await shot("workshop-shifter-light.png", wc);
	// one of draw.io's own shapes goes into the diagram, selected
	const cellsBefore = await cellCount();
	await wc.executeJavaScript(`document.querySelector('#grid .tile[data-key^="own:"]').click(); true`);
	await until("the found shape in the diagram", async () => ((await cellCount()) > cellsBefore ? true : undefined));
	const ownId = (await until("the found shape selected", async () => ((await w.selectedCells()).length === 1 ? w.selectedCells() : undefined)))[0].id;
	// ... and the Shifter shows it as the selection: a fill colour, one undo step
	const selInfo: string = await until("the selection in the Shifter", async () => {
		const t: string = await wc.executeJavaScript(`document.getElementById("selInfo").textContent`);
		return /^1 shape selected/.test(t) ? t : undefined;
	});
	await wc.executeJavaScript(`(() => { const i = document.querySelector('#changeShape input[data-colour="fill"]'); i.value = "#ff8800"; i.dispatchEvent(new Event("change")); return true; })()`);
	const filled = await until("the fill colour on the shape", async () => {
		const cells = await w.selectedCells();
		return cells.length === 1 && /fillColor=#ff8800/.test(cells[0].style) ? true : undefined;
	});
	// a gallery icon goes in beside it and gets one colour
	await wc.executeJavaScript(`document.querySelector('#grid .tile:not([data-key^="own:"])').click(); true`);
	const iconRow = await until("the icon colour control", async () => ((await wc.executeJavaScript(`!document.getElementById("iconRow").classList.contains("hidden")`)) ? true : undefined));
	const iconBefore = (await w.selectedCells())[0]?.style ?? "";
	await wc.executeJavaScript(`(() => { const i = document.querySelector('#changeShape input[data-colour="icon"]'); i.value = "#0055ff"; i.dispatchEvent(new Event("change")); return true; })()`);
	const recoloured = await until("the icon in one colour", async () => {
		const style = (await w.selectedCells())[0]?.style ?? "";
		const m = /image=data:image\/svg\+xml,([^;]+)/.exec(style);
		return style !== iconBefore && m && Buffer.from(m[1], "base64").toString("utf8").includes("#0055ff") ? true : undefined;
	});
	const pagedBeside = (await cellCount()) - cellsBefore;
	// a selected group is one shape: a change to it leaves what is inside as it is
	const group: { id: string; children: number } = await ed.executeJavaScript(
		`(() => { const g = editorUi.editor.graph, m = g.getModel(); const made = g.groupCells(null, 0, [m.getCell(${JSON.stringify(ownId)}), ...g.getSelectionCells()]); g.setSelectionCell(made); return { id: made.id, children: m.getChildCount(made) }; })()`
	);
	const groupSelected = await until("the group as the selection", async () => {
		const cells = await w.selectedCells();
		return cells.length === 1 && cells[0].id === group.id ? true : undefined;
	});
	await until("the Shifter to show the group", async () => ((await wc.executeJavaScript(`document.getElementById("iconRow").classList.contains("hidden")`)) ? true : undefined));
	await wc.executeJavaScript(`(() => { const i = document.querySelector('#changeShape input[data-colour="stroke"]'); i.value = "#00aa00"; i.dispatchEvent(new Event("change")); return true; })()`);
	const groupAlone = await until("the line colour on the group alone", async () => {
		const styles: string[] = await ed.executeJavaScript(`(() => { const m = editorUi.editor.graph.getModel(), g = m.getCell(${JSON.stringify(group.id)}); return [g.style || "", ...(g.children || []).map((c) => c.style || "")]; })()`);
		return /strokeColor=#00aa00/.test(styles[0]) ? styles.slice(1).every((x) => !/#00aa00/.test(x)) : undefined;
	});
	// a shape that is its label (draw.io's Text) arrives with it
	await type("text");
	await until("the Text shape among the finds", async () => ((await wc.executeJavaScript(`!!document.querySelector('#grid .tile[data-key^="own:"][title^="Text ·"]')`)) ? true : undefined));
	await wc.executeJavaScript(`document.querySelector('#grid .tile[data-key^="own:"][title^="Text ·"]').click(); true`);
	const textLabel: string = await until("the Text shape in the diagram", async () => {
		const v: string = await ed.executeJavaScript(`(() => { const c = editorUi.editor.graph.getSelectionCell(); return c && /^text;/.test(c.style || "") ? String(c.value || "") : ""; })()`);
		return v || undefined;
	});
	log("shifterChange", { selInfo, filled, iconRow, recoloured, pagedBeside, group: { ...group, selectedAsOne: groupSelected, changedAlone: groupAlone }, textLabel });
	// a Visio stencil becomes a collection (converted by the editor; the name is asked for first)
	process.env.DRAWAI_E2E_STENCIL = path.join(__dirname, "../../test/ai/fixtures/import.vssx");
	await wc.executeJavaScript(`document.getElementById("importStencil").click(); true`);
	const asked: string = await until("the stencil's name to be asked", async () => ((await wc.executeJavaScript(`document.getElementById("ask").open`)) ? wc.executeJavaScript(`document.getElementById("askTitle").textContent + " | " + document.getElementById("askInput").value`) : undefined));
	await wc.executeJavaScript(`document.getElementById("askOk").click(); true`);
	const stencil = await until("the stencil's collection", async () => {
		const g = galleryConfigs().find((x) => x.title === "import" && x.sources.some((src) => src.kind === "collection"));
		const n = g ? (await galleries().items(g)).length : 0;
		return g && n > 0 ? { title: g.title, shapes: n } : undefined;
	});
	const backInGallery = await until("the Gallery showing the new collection", async () => ((await wc.executeJavaScript(`document.querySelector('nav button[data-mode="gallery"]').classList.contains("active") && document.querySelectorAll("#grid .tile").length`)) ? true : undefined));
	log("shifterStencil", { asked, ...stencil, backInGallery });
	if (!filled || !recoloured || group.children !== 2 || !groupSelected || !groupAlone || textLabel !== "Text" || !stencil.shapes) throw new Error("The Shape Shifter does not work as it should (see the shifter lines above).");

	// ----- the Shape Creator: an agent draws an icon (here a stand-in: no agent is started, nothing is sent anywhere) -----
	process.env.DRAWAI_E2E_CREATOR = "1";
	const made = () => wc.executeJavaScript(`[...document.querySelectorAll("#creatorOut .made .row1 b")].map((b) => b.textContent)`) as Promise<string[]>;
	await wc.executeJavaScript(`document.querySelector('nav button[data-mode="creator"]').click(); true`);
	const agents: string[] = await until("the Creator's agents", async () => {
		const list: string[] = await wc.executeJavaScript(`[...document.querySelectorAll("#crAgent option")].map((o) => o.textContent)`);
		return list.length ? list : undefined;
	});
	await wc.executeJavaScript(`(() => { document.getElementById("crPrompt").value = "a load balancer"; document.getElementById("crCount").value = "3"; document.getElementById("crGo").click(); return true; })()`);
	const drawn = await until("three icons from the stand-in", async () => ((await made()).length === 3 ? made() : undefined));
	const saidWhile: string = await until("the request to end", async () => ((await wc.executeJavaScript(`!document.getElementById("crGo").classList.contains("hidden")`)) ? wc.executeJavaScript(`document.getElementById("crSaid").textContent`) : undefined));
	// one goes into the diagram as an image shape
	const cellsBeforeIcon = await cellCount();
	await wc.executeJavaScript(`document.querySelector('#creatorOut .made button[data-do="insert"]').click(); true`);
	const insertedIcon = await until("the created icon in the diagram", async () => {
		if ((await cellCount()) <= cellsBeforeIcon) return undefined;
		const style = (await w.selectedCells())[0]?.style ?? "";
		return /^shape=image;.*image=data:image\/svg\+xml,/.test(style) ? true : undefined;
	});
	// ... and is kept in My shapes, which is a collection like any other: a gallery, and a palette in the editor
	await wc.executeJavaScript(`document.querySelector('#creatorOut .made button[data-do="save"]').click(); true`);
	await wc.executeJavaScript(`[...document.querySelectorAll("#menu button")].find((b) => b.textContent === "My shapes").click(); true`);
	const kept = await until("the icon in My shapes", async () => {
		const g = galleryConfigs().find((x) => x.id === "my-shapes");
		const items = g ? await galleries().items(g) : [];
		return g && items.length === 1 ? { title: g.title, shapes: items.map((i) => i.title) } : undefined;
	});
	const myPalette = await until("the My shapes palette in the editor", async () => (((await ed.executeJavaScript("window.omnidrawShapes.palettes()")) as string[]).some((t) => /^My shapes/.test(t)) ? true : undefined)).catch(() => false);
	// a change is asked of the same stand-in
	await wc.executeJavaScript(`(() => { const i = document.querySelector("#creatorOut .made .revise input"); i.value = "thicker lines"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
	const revised = await until("the revised icon", async () => ((await made()).length === 4 ? (await made())[0] : undefined));
	await until("the revision to end", async () => ((await wc.executeJavaScript(`!document.getElementById("crGo").classList.contains("hidden")`)) ? true : undefined));
	// (a window behind another one is not drawn again: bring it forward for its picture)
	ww.show();
	ww.moveTop();
	await pause(900);
	await shot("workshop-creator-light.png", wc);
	log("creator", { agents, drawn, saidWhile, insertedIcon, kept, myPalette, revised });
	if (drawn.length !== 3 || !/looked at it/.test(saidWhile) || !insertedIcon || kept.shapes.length !== 1 || !myPalette || revised !== "Revised 1") throw new Error("The Shape Creator does not work as it should (see the creator line above).");

	// dark
	process.env.DRAWAI_THEME = "dark";
	updateSettings({ appearance: { ...settings().appearance, theme: "dark" } });
	await pause(800);
	await shot("workshop-creator-dark.png", wc);
	await wc.executeJavaScript(`document.querySelector('nav button[data-mode="gallery"]').click(); true`);
	await pause(300);
	await shot("workshop-search-dark.png", wc);
	process.env.DRAWAI_THEME = "light";
	updateSettings({ appearance: { ...settings().appearance, theme: "light" } });
	ww.close();
}
