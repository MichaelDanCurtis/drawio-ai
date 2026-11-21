import { app, BaseWindow, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { agentEnv } from "./agents";
import { createContext } from "./mapper/context";
import { drawMap } from "./mapper/draw";
import { catalog, recipeById } from "./mapper/registry";
import { agentRequest } from "./mapper/recipes/common";
import { CollectResult, MapInput, MapperError, Recipe } from "./mapper/types";
import { paths } from "./paths";
import type { StaticServer } from "./staticServer";

/** What the Mapper needs from the diagram window it maps into. */
export interface MapperHost {
	win: BaseWindow;
	client: import("../../../src/DrawioClient/CustomizedDrawioClient").CustomizedDrawioClient;
	/** The diagram's folder: default for folder and file fields. */
	cwd(): string;
	ready(): boolean;
	/** Sends a request to the agent in the chat; `shown` is what the transcript shows. */
	askAgent(text: string, shown: string): void;
	showChat(): void;
}

const inputsFile = () => path.join(app.getPath("userData"), "mapper-inputs.json");

function loadSavedInputs(): Record<string, MapInput> {
	try {
		return JSON.parse(fs.readFileSync(inputsFile(), "utf8"));
	} catch {
		return {};
	}
}

/** Remembers the last inputs per recipe, without secrets. */
function saveInputs(recipe: Recipe, input: MapInput): void {
	const all = loadSavedInputs();
	const secret = new Set(recipe.fields.filter((f) => f.secret || f.type === "password").map((f) => f.id));
	all[recipe.id] = Object.fromEntries(Object.entries(input).filter(([k]) => !secret.has(k)));
	try {
		fs.writeFileSync(inputsFile(), JSON.stringify(all, null, 1), { mode: 0o600 });
	} catch {
		// not important
	}
}

/** The Mapper dialog of one diagram window. */
export class MapperDialog {
	private static byView = new Map<number, MapperDialog>();
	private static installed = false;

	private win: BrowserWindow | undefined;
	private running: AbortController | undefined;

	constructor(private readonly host: MapperHost, private readonly server: StaticServer) {
		MapperDialog.installIpc();
	}

	private static installIpc(): void {
		if (MapperDialog.installed) return;
		MapperDialog.installed = true;
		ipcMain.on("mapper:toHost", (e, msg) => void MapperDialog.byView.get(e.sender.id)?.onMessage(msg));
	}

	public open(category?: string): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.focus();
			if (category) this.post({ type: "selectCategory", category });
			return;
		}
		const win = new BrowserWindow({
			parent: this.host.win,
			modal: process.platform !== "darwin",
			width: 880,
			height: 680,
			minWidth: 640,
			minHeight: 480,
			title: "Map Something",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e22" : "#ffffff",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-mapper.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		this.win = win;
		MapperDialog.byView.set(win.webContents.id, this);
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => {
			this.running?.abort();
			for (const [k, v] of MapperDialog.byView) if (v === this) MapperDialog.byView.delete(k);
			this.win = undefined;
		});
		void win.loadURL(`${this.server.base}/mapper.html${category ? `#${encodeURIComponent(category)}` : ""}`);
	}

	/** The dialog's window while it is open (tests screenshot it). */
	public get window(): BrowserWindow | undefined {
		return this.win && !this.win.isDestroyed() ? this.win : undefined;
	}

	public close(): void {
		if (this.win && !this.win.isDestroyed()) this.win.close();
	}

	private post(msg: unknown): void {
		if (this.win && !this.win.isDestroyed()) this.win.webContents.send("mapper:toWebview", msg);
	}

	private context(signal: AbortSignal, onProgress?: (t: string) => void) {
		return createContext({ cwd: this.host.cwd(), env: agentEnv(), signal, progress: onProgress });
	}

	private async onMessage(msg: any): Promise<void> {
		switch (msg?.type) {
			case "ready":
				this.post({ type: "catalog", catalog: catalog(), saved: loadSavedInputs(), cwd: this.host.cwd() });
				break;
			case "loadOptions": {
				const recipe = recipeById(String(msg.recipeId));
				if (!recipe?.loadOptions) return;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), 60_000);
				try {
					const options = await recipe.loadOptions(String(msg.fieldId), msg.input ?? {}, this.context(ac.signal));
					this.post({ type: "options", recipeId: recipe.id, fieldId: msg.fieldId, options });
				} catch (e: any) {
					this.post({ type: "options", recipeId: recipe.id, fieldId: msg.fieldId, options: [], error: errorText(e) });
				} finally {
					clearTimeout(timer);
				}
				break;
			}
			case "pick": {
				if (!this.win) return;
				const folder = msg.kind === "folder";
				const r = await dialog.showOpenDialog(this.win, {
					defaultPath: msg.current || this.host.cwd(),
					properties: folder ? ["openDirectory"] : ["openFile"],
				});
				if (!r.canceled && r.filePaths[0]) this.post({ type: "picked", fieldId: msg.fieldId, path: r.filePaths[0] });
				break;
			}
			case "run":
				await this.run(String(msg.recipeId), msg.input ?? {}, !!msg.askAgent);
				break;
			case "cancel":
				this.running?.abort();
				break;
			case "close":
				this.close();
				break;
		}
	}

	/** Collect → draw → (optionally) hand to the agent. */
	public async run(recipeId: string, input: MapInput, askAgent: boolean): Promise<{ result?: CollectResult; error?: string }> {
		const recipe = recipeById(recipeId);
		if (!recipe) return { error: `Unknown map ${recipeId}` };
		if (this.running) {
			this.post({ type: "failed", message: "A map is already being made." });
			return { error: "busy" };
		}
		const missing = recipe.fields.filter((f) => f.required && !String(input[f.id] ?? "").trim() && visible(recipe, f.id, input));
		if (missing.length) {
			this.post({ type: "failed", message: `Fill in: ${missing.map((f) => f.label).join(", ")}` });
			return { error: "missing fields" };
		}
		if (!this.host.ready()) {
			this.post({ type: "failed", message: "The diagram is still loading. Try again in a moment." });
			return { error: "not ready" };
		}
		saveInputs(recipe, input);
		const ac = new AbortController();
		this.running = ac;
		this.post({ type: "running", recipeId });
		const progress = (text: string) => this.post({ type: "progress", text });
		try {
			let result: CollectResult | undefined;
			if (recipe.collect) {
				progress("Collecting (read-only)…");
				result = await recipe.collect(input, this.context(ac.signal, progress));
				if (ac.signal.aborted) throw new MapperError("Cancelled");
			}
			let drawn = "";
			// Dig deeper needs to know where relative paths in the shapes' data point.
			const root = ["folder", "file"].map((k) => String(input[k] ?? "").trim()).find(Boolean);
			if (root && result?.graph) for (const n of result.graph.nodes) n.data = { mapRoot: root, ...(n.data ?? {}) };
			if (result?.graph && result.graph.nodes.length > 0) {
				progress(`Drawing ${result.graph.nodes.length} shapes…`);
				const d = await drawMap(this.host.client, result.graph, recipe.id);
				drawn = `Drew ${d.cells} cells on ${d.newPage ? "a new page" : "this page"} "${d.page}" (pending: keep or revert it).`;
			}
			const wantsAgent = recipe.mode === "agent" || (askAgent && !!recipe.agentPrompt);
			if (wantsAgent && recipe.agentPrompt) {
				const task = recipe.agentPrompt(input, result);
				const text = agentRequest(
					`${task}${drawn ? `\n\nThe Mapper has just drawn the map on the page "${result?.graph?.title ?? ""}" from read-only data (${result?.summary ?? ""}); build on it.` : ""}`,
					result?.facts
				);
				this.host.showChat();
				this.host.askAgent(text, `🗺 ${recipe.title}${result?.summary ? ` — ${result.summary}` : ""}`);
			}
			const summary = [result?.summary, drawn, wantsAgent ? "Handed to the agent in the chat." : ""].filter(Boolean).join(" ");
			this.post({ type: "done", summary: summary || "Done.", warnings: result?.warnings ?? [], close: !result?.warnings?.length });
			return { result };
		} catch (e: any) {
			const message = errorText(e);
			this.post({ type: "failed", message, hint: e instanceof MapperError ? e.hint : undefined });
			return { error: message };
		} finally {
			this.running = undefined;
		}
	}
}

/** A field applies when its condition holds and the field it depends on applies too. */
export function visible(recipe: Recipe, fieldId: string, input: MapInput, depth = 0): boolean {
	const f = recipe.fields.find((x) => x.id === fieldId);
	if (!f?.showIf) return true;
	if (depth < 10 && !visible(recipe, f.showIf.field, input, depth + 1)) return false;
	return f.showIf.values.includes(String(input[f.showIf.field] ?? recipe.fields.find((x) => x.id === f.showIf!.field)?.default ?? ""));
}

function errorText(e: any): string {
	const s = String(e?.message ?? e);
	return s.length > 800 ? s.slice(0, 800) + "…" : s;
}
