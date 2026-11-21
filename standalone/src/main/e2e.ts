import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AgentId } from "./agents";
import { DiagramWindow } from "./diagramWindow";
import { exportDiagram } from "./exporter";
import { settings } from "./settings";
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
	/** JavaScript to run in the editor before the screenshots (e.g. open a menu). */
	editorScript?: string;
	/** Measure editor responsiveness and editor→app traffic instead of the normal checks. */
	diagnose?: boolean;
	/** ACP session mode to switch to before prompting (e.g. Claude's "default", which asks before edits). */
	mode?: string;
	/** Run a Mapper recipe (instead of the agent prompt), optionally screenshot its dialog, then dig deeper with the agent. */
	/** Check presentation mode: enter, step pages, pan, try to edit, leave. */
	present?: boolean;
	map?: { recipe: string; input?: Record<string, string>; dialog?: boolean; askAgent?: boolean; digDeeper?: string };
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
		if (config.present) {
			await runPresent(w, config, log);
		} else if (config.map) {
			await runMap(w, config, log);
		} else if (config.agent) {
			let clicker: NodeJS.Timeout | undefined;
			if (config.clickPermissions) {
				// Through the real UI: the permission card the user would see.
				clicker = setInterval(() => {
					void w.chatView.webContents
						.executeJavaScript(`(() => { const b = document.querySelector(".permission .options button.primary") || document.querySelector(".permission .options button"); if (b) { b.click(); return b.textContent; } return null; })()`)
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
		fs.writeFileSync(path.join(config.out, "mapper-dialog.png"), (await dlg.webContents.capturePage()).toPNG());
		log("dialogText", (await dlg.webContents.executeJavaScript("document.body.innerText")).slice(0, 1500));
	}
	if (config.agent) w.chat.autoApprove = true;
	const t0 = Date.now();
	const turn = config.agent && map.askAgent ? waitForTurn(w) : undefined;
	const r = await w.mapper.run(recipe.id, { ...(map.input ?? {}) }, !!map.askAgent);
	log("mapMs", Date.now() - t0);
	log("mapSummary", r.result?.summary ?? null);
	log("mapWarnings", r.result?.warnings ?? []);
	if (r.error) throw new Error(`Mapper: ${r.error}`);
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
	// Page view state (scroll position, view defaults draw.io writes when a page is visited) may differ; content may not.
	// Attribute order is not content either (draw.io re-serializes a page it visits).
	const viewless = (x: string) =>
		x
			.replace(/<mxGraphModel[^>]*>/g, "<mxGraphModel>")
			.replace(/<([\w:]+)((?:\s+[\w:-]+="[^"]*")+)\s*(\/?)>/g, (_m, tag: string, attrs: string, close: string) => `<${tag} ${attrs.trim().match(/[\w:-]+="[^"]*"/g)!.sort().join(" ")}${close}>`);
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
}
