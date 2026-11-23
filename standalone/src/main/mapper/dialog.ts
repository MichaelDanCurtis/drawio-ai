import { describePrompt } from "./prompts";
import { agentRequest } from "./recipes/common";
import { safeInputs } from "./redact";
import { catalog, recipeById } from "./registry";
import type { MapperService } from "./service";
import type { MapRecord } from "./store";
import type { CollectContext, CollectResult, MapInput, Recipe } from "./types";
import { MapperError } from "./types";

/**
 * What the Map Something page (renderer/mapper.html) needs from the program showing it: the
 * desktop app shows it in a window of its own, the VS Code extension in a webview panel.
 */
export interface MapperDialogPorts {
	/** Sends a message to the page. */
	post(msg: unknown): void;
	/** The diagram's folder: default for folder and file fields. */
	cwd(): string;
	/** Whether the diagram can be drawn into. */
	ready(): boolean;
	service(): MapperService;
	context(signal: AbortSignal, progress?: (text: string) => void): CollectContext;
	/** Sends a request to the agent; `shown` is the short line a transcript shows for it. */
	askAgent(text: string, shown: string): void;
	showChat(): void;
	/** The inputs remembered per recipe (never secrets). */
	loadInputs(): Record<string, MapInput>;
	saveInputs(all: Record<string, MapInput>): void;
	/** Lets the user choose a folder or file; undefined when they cancel. */
	pick(kind: "folder" | "file", current: string | undefined): Promise<string | undefined>;
	look(): { iconStyle: string; matrix: string };
	close(): void;
}

export interface MapRunOutcome {
	result?: CollectResult;
	error?: string;
	mapId?: string;
}

/** The Map Something page's other half: answers its messages and runs maps. */
export class MapperDialogCore {
	private running: AbortController | undefined;

	constructor(private readonly ports: MapperDialogPorts) {}

	/** Stops a map that is being made (the page was closed, or Stop was pressed). */
	public abort(): void {
		this.running?.abort();
	}

	public get busy(): boolean {
		return !!this.running;
	}

	public async onMessage(msg: any): Promise<void> {
		const p = this.ports;
		switch (msg?.type) {
			case "ready":
				p.post({ type: "catalog", catalog: catalog(), saved: p.loadInputs(), cwd: p.cwd(), ...p.look() });
				break;
			case "loadOptions": {
				const recipe = recipeById(String(msg.recipeId));
				if (!recipe?.loadOptions) return;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), 60_000);
				try {
					const options = await recipe.loadOptions(String(msg.fieldId), msg.input ?? {}, p.context(ac.signal));
					p.post({ type: "options", recipeId: recipe.id, fieldId: msg.fieldId, options });
				} catch (e: any) {
					p.post({ type: "options", recipeId: recipe.id, fieldId: msg.fieldId, options: [], error: errorText(e) });
				} finally {
					clearTimeout(timer);
				}
				break;
			}
			case "pick": {
				const picked = await p.pick(msg.kind === "folder" ? "folder" : "file", typeof msg.current === "string" && msg.current ? msg.current : undefined);
				if (picked) p.post({ type: "picked", fieldId: msg.fieldId, path: picked });
				break;
			}
			case "run":
				await this.run(String(msg.recipeId), msg.input ?? {}, !!msg.askAgent, !!msg.describe);
				break;
			case "cancel":
				this.abort();
				break;
			case "close":
				p.close();
				break;
		}
	}

	/** Collect → draw → (optionally) hand to the agent. */
	public async run(recipeId: string, input: MapInput, askAgent: boolean, describe = false): Promise<MapRunOutcome> {
		const p = this.ports;
		const recipe = recipeById(recipeId);
		if (!recipe) return { error: `Unknown map ${recipeId}` };
		if (this.running) {
			p.post({ type: "failed", message: "A map is already being made." });
			return { error: "busy" };
		}
		const missing = recipe.fields.filter((f) => f.required && !String(input[f.id] ?? "").trim() && visible(recipe, f.id, input));
		if (missing.length) {
			p.post({ type: "failed", message: `Fill in: ${missing.map((f) => f.label).join(", ")}` });
			return { error: "missing fields" };
		}
		if (!p.ready()) {
			p.post({ type: "failed", message: "The diagram is still loading. Try again in a moment." });
			return { error: "not ready" };
		}
		this.remember(recipe, input);
		const ac = new AbortController();
		this.running = ac;
		p.post({ type: "running", recipeId });
		const progress = (text: string) => p.post({ type: "progress", text });
		try {
			let result: CollectResult | undefined;
			let drawn = "";
			let record: MapRecord | undefined;
			if (recipe.collect) {
				// Collects read-only, draws the map and its health badges, and stores its record.
				const out = await p.service().run(recipe.id, input, { signal: ac.signal, progress });
				result = out.result;
				record = out.record;
				if (out.drawn) drawn = `Drew ${out.drawn.cells} cells on ${out.drawn.newPage ? "a new page" : "this page"} "${out.drawn.page}" (pending: keep or revert it).${out.badges ? ` ${out.record.findings.length} finding(s) marked on the Health layer.` : ""}`;
			}
			const wantsAgent = recipe.mode === "agent" || (askAgent && !!recipe.agentPrompt);
			if (describe && record && record.graph.nodes.length) {
				p.showChat();
				p.askAgent(describePrompt(record, "everyone"), `🗺 Describe "${record.title}" in plain English`);
			} else if (wantsAgent && recipe.agentPrompt) {
				const task = recipe.agentPrompt(input, result);
				const text = agentRequest(
					`${task}${drawn ? `\n\nThe Mapper has just drawn the map on the page "${result?.graph?.title ?? ""}" from read-only data (${result?.summary ?? ""}); build on it.` : ""}`,
					result?.facts
				);
				p.showChat();
				p.askAgent(text, `🗺 ${recipe.title}${result?.summary ? ` — ${result.summary}` : ""}`);
			}
			const summary = [result?.summary, drawn, wantsAgent || describe ? "Handed to the agent in the chat." : ""].filter(Boolean).join(" ");
			p.post({ type: "done", summary: summary || "Done.", warnings: result?.warnings ?? [], close: !result?.warnings?.length });
			return { result, mapId: record?.id };
		} catch (e: any) {
			const message = errorText(e);
			p.post({ type: "failed", message, hint: e instanceof MapperError ? e.hint : undefined });
			return { error: message };
		} finally {
			this.running = undefined;
		}
	}

	/** Remembers the last inputs per recipe, without secrets. */
	private remember(recipe: Recipe, input: MapInput): void {
		try {
			const all = this.ports.loadInputs();
			const secret = new Set(recipe.fields.filter((f) => f.secret || f.type === "password").map((f) => f.id));
			all[recipe.id] = safeInputs(input, secret);
			this.ports.saveInputs(all);
		} catch {
			// not important
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

export function errorText(e: any): string {
	const s = String(e?.message ?? e);
	return s.length > 800 ? s.slice(0, 800) + "…" : s;
}
