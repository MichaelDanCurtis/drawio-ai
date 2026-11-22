import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { AgentId } from "./agents";
import { DiagramWindow } from "./diagramWindow";
import { exportDiagram } from "./exporter";
import { diagramContent } from "./xmlContent";
import { settings, updateSettings } from "./settings";
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
	map?: { recipe: string; input?: Record<string, string>; dialog?: boolean; askAgent?: boolean; digDeeper?: string };
	/** Check Settings, themes, icon styles, the toolbar, the chat's menus, sliding and docking, and shape folders. */
	polish?: boolean;
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
		if (config.polish) {
			await runPolish(w, server, config, log);
		} else if (config.insights) {
			await runInsights(w, config, log);
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

	await ed.executeJavaScript(`(() => { const b = document.querySelector(".geToolbarContainer a.geButton:not(.drawai-mark)"); b && b.dispatchEvent(new MouseEvent("click", { bubbles: true })); })()`);
	await pause(400);
	log("panelMenu", await ed.executeJavaScript(`Array.from(document.querySelectorAll(".mxPopupMenu .mxPopupMenuItem")).map((e) => e.textContent.trim()).filter(Boolean)`));
	await save("panel-menu.png", ed, { x: 0, y: 0, width: 360, height: 260 });
	await ed.executeJavaScript(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));`);

	// icon styles, in both themes
	for (const theme of ["light", "dark"] as const) {
		process.env.DRAWAI_THEME = theme;
		for (const style of ["isometric", "dots", "extruded", "classic"] as const) {
			updateSettings({ appearance: { ...settings().appearance, theme, iconStyle: style } });
			await pause(700);
			await save(`toolbar-${theme}-${style}.png`, ed, await top());
			await save(`chat-${theme}-${style}.png`, chat);
		}
		const zoomIn = await ed.executeJavaScript(`(() => { const a = Array.from(document.querySelectorAll(".geToolbarContainer a.geButton")).find((x) => /^Zoom In/.test(x.getAttribute("title") || "")); return a ? a.style.backgroundImage.length : 0; })()`);
		log(`zoomInIconBytes-${theme}-classic`, zoomIn);
	}
	process.env.DRAWAI_THEME = "light";
	updateSettings({ appearance: { theme: "light", iconStyle: "isometric", toolbar: "top" } });
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
		updateSettings({ appearance: { ...settings().appearance, theme, iconStyle: "isometric" } });
		await pause(500);
		for (const section of ["appearance", "agents", "chat", "editor", "shapes"]) {
			await sw.webContents.executeJavaScript(`document.querySelector('nav [data-section="${section}"]').click()`);
			await pause(400);
			await save(`settings-${theme}-${section}.png`, sw.webContents);
		}
	}
	log("settingsSections", await sw.webContents.executeJavaScript(`Array.from(document.querySelectorAll("nav [data-section]")).map((b) => b.textContent.trim())`));
	sw.close();
	process.env.DRAWAI_THEME = "light";
	updateSettings({ appearance: { ...settings().appearance, theme: "light", iconStyle: "isometric" } });
}

/** Calls a diagram tool on the window's MCP server, as an agent would. */
async function rpcTool(w: DiagramWindow, name: string, args: unknown): Promise<unknown> {
	return w.callTool(name, args);
}
