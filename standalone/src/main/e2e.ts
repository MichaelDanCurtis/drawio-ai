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
		if (config.agent) {
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
