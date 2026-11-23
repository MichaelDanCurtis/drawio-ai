import type { CustomizedDrawioClient } from "../../../src/DrawioClient/CustomizedDrawioClient";
import type { ChatController } from "./chatController";
import { mapsOnPage } from "./mapper/draw";
import { askPrompt, describePrompt, fixFindingPrompt, tourPrompt } from "./mapper/prompts";
import { recipeById } from "./mapper/registry";
import { SEVERITY, MapperService } from "./mapper/service";
import { activeFindings, MapRecord } from "./mapper/store";

type Action =
	| { kind: "finding-show"; mapId: string; findingId: string }
	| { kind: "finding-fix"; mapId: string; findingId: string }
	| { kind: "finding-dismiss"; mapId: string; findingId: string }
	| { kind: "node-show"; mapId: string; nodeIds: string[] };

/**
 * The chat's Map menu (findings, describe, recent changes, refresh, tour, ask)
 * and the buttons on its report cards, for one diagram window.
 */
export class MapActions {
	private summary = { maps: 0, findings: 0 };
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly client: CustomizedDrawioClient,
		private readonly chat: ChatController,
		private readonly maps: MapperService,
		private readonly ready: () => boolean,
		private readonly openMapper: (category?: string) => void
	) {}

	public get pageSummary(): { maps: number; findings: number } {
		return this.summary;
	}

	/** Recounts the maps on the page shown (debounced; after edits and page switches). */
	public refreshSummary(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(async () => {
			if (!this.ready()) return;
			try {
				const records = await this.maps.pageRecords();
				const next = { maps: records.length, findings: records.reduce((n, r) => n + activeFindings(r).length, 0) };
				if (next.maps !== this.summary.maps || next.findings !== this.summary.findings) {
					this.summary = next;
					this.chat.postState();
				}
			} catch {
				// the editor may be reloading
			}
		}, 400);
	}

	public dispose(): void {
		clearTimeout(this.timer);
	}

	/** The map the action is about: the biggest one on the page shown. */
	private async pageRecord(): Promise<MapRecord | undefined> {
		const records = await this.maps.pageRecords();
		if (!records.length) {
			this.chat.note("There is no map on this page. Make one with 🗺 Map… first, or show a page with a map.");
			return undefined;
		}
		return records.sort((a, b) => b.graph.nodes.length - a.graph.nodes.length)[0];
	}

	public async run(action: string, text: string): Promise<void> {
		try {
			switch (action) {
				case "findings":
					for (const r of await this.maps.pageRecords()) this.findingsReport(r);
					if (!this.summary.maps) await this.pageRecord();
					break;
				case "describe":
				case "describe-dev": {
					const r = await this.pageRecord();
					if (r) await this.chat.send(describePrompt(r, action === "describe" ? "everyone" : "developer"), { cellIds: [] }, [], `✎ Describe "${r.title}" in plain English${action === "describe-dev" ? " (for developers)" : ""}`);
					break;
				}
				case "recent": {
					const r = await this.pageRecord();
					if (r) await this.recent(r);
					break;
				}
				case "refresh": {
					const r = await this.pageRecord();
					if (r) await this.refresh(r);
					break;
				}
				case "tour": {
					const r = await this.pageRecord();
					if (r) await this.chat.send(tourPrompt(r, text), { cellIds: [] }, [], `▶ Build a tour of "${r.title}"${text ? `: ${text}` : ""}`);
					break;
				}
				case "ask":
					if (!text.trim()) {
						this.chat.note("Type your question in the chat box, then choose Map ▾ → Ask the map.");
						break;
					}
					if (await this.pageRecord()) await this.chat.send(askPrompt(text), { cellIds: [] }, [], `❓ ${text}`);
					break;
			}
		} catch (e: any) {
			this.chat.report({ title: "Map action failed", rows: [{ text: String(e?.message ?? e), color: SEVERITY.high.fill }] });
		}
	}

	private findingsReport(r: MapRecord): void {
		const f = this.maps.findings(r);
		const label = (id: string) => r.graph.nodes.find((n) => n.id === id)?.label ?? id;
		this.chat.report({
			title: `⚠ ${f.findings.length} finding${f.findings.length === 1 ? "" : "s"} on "${r.title}"`,
			subtitle: f.dismissed ? `${f.dismissed} dismissed` : undefined,
			rows: f.findings.map((x) => ({
				color: SEVERITY[x.severity].fill,
				text: `${SEVERITY[x.severity].label}: ${x.title}`,
				detail: [x.nodeIds.map(label).join(", "), x.detail, x.fix ? `Fix: ${x.fix}` : ""].filter(Boolean).join("\n"),
				actions: [
					{ title: "Show on map", action: { kind: "finding-show", mapId: r.id, findingId: x.id } },
					{ title: "Fix with agent", action: { kind: "finding-fix", mapId: r.id, findingId: x.id } },
					{ title: "Dismiss", action: { kind: "finding-dismiss", mapId: r.id, findingId: x.id } },
				],
			})),
			footer: f.checked.length ? `What was checked:\n${f.checked.map((c) => `• ${c.check}: ${c.scanned}${c.note ? ` (${c.note})` : ""}`).join("\n")}` : "No checks ran for this map.",
		});
	}

	private async recent(r: MapRecord): Promise<void> {
		const c = await this.maps.recentChanges(r, { draw: true });
		this.chat.report({
			title: `⟳ ${c.shapes.length} shape${c.shapes.length === 1 ? "" : "s"} changed since "${r.title}" was made${c.since ? ` (${c.since})` : ""}`,
			subtitle: `${c.changedFiles} changed file(s); green "changed" badges are on the Changes layer.`,
			rows: c.shapes.slice(0, 40).map((s) => ({
				color: "#16a34a",
				text: s.label,
				detail: `${s.how.join(", ")}: ${s.files.slice(0, 6).join(", ")}${s.files.length > 6 ? ` +${s.files.length - 6}` : ""}`,
				actions: [{ title: "Show on map", action: { kind: "node-show", mapId: r.id, nodeIds: [s.nodeId] } }],
			})),
			footer: [
				c.commits.length ? `Commits:\n${c.commits.slice(0, 12).map((x) => `• ${x.hash} ${x.subject} (${x.author}, ${x.when})`).join("\n")}` : "",
				c.unmappedFiles.length ? `Changed files not on the map: ${c.unmappedFiles.slice(0, 10).join(", ")}${c.unmappedFiles.length > 10 ? "…" : ""}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		});
	}

	private async refresh(r: MapRecord): Promise<void> {
		const recipe = recipeById(r.recipe);
		if (recipe?.fields.some((f) => (f.secret || f.type === "password") && f.required)) {
			this.chat.note(`"${r.title}" needs a password or token again (they are never stored): map it again from 🗺 Map….`);
			this.openMapper(recipe.category);
			return;
		}
		this.chat.note(`Refreshing "${r.title}"…`);
		const out = await this.maps.refresh(r);
		this.chat.report({
			title: `↻ Refreshed "${r.title}" onto "${out.drawn?.page ?? "a new page"}"`,
			subtitle: `${out.diff.added} new · ${out.diff.changed} changed · ${out.diff.removed.length} removed (badges on the Changes layer); descriptions and tours carried over.`,
			rows: out.diff.removed.slice(0, 30).map((label) => ({ color: SEVERITY.info.fill, text: `Removed: ${label}` })),
			footer: out.result.summary,
		});
		this.refreshSummary();
	}

	public async action(raw: unknown): Promise<void> {
		const a = raw as Action;
		try {
			const r = this.maps.record(a.mapId);
			const finding = "findingId" in a ? r.findings.find((f) => f.id === a.findingId) : undefined;
			switch (a.kind) {
				case "finding-show":
				case "node-show":
					await this.select(r, a.kind === "node-show" ? a.nodeIds : finding?.nodeIds ?? []);
					break;
				case "finding-fix": {
					if (!finding) return;
					await this.chat.send(
						fixFindingPrompt(r, finding),
						{ cellIds: [] },
						[],
						`🛠 Fix: ${finding.title}`
					);
					break;
				}
				case "finding-dismiss":
					await this.maps.dismiss(r, a.findingId);
					this.chat.note(`Dismissed "${finding?.title ?? a.findingId}". It comes back if it changes.`);
					this.refreshSummary();
					break;
			}
		} catch (e: any) {
			this.chat.note(`Could not do that: ${e?.message ?? e}`);
		}
	}

	/** Selects a map's shapes in the editor, switching to the map's page when needed. */
	private async select(r: MapRecord, nodeIds: string[]): Promise<void> {
		let page = await mapsOnPage(this.client);
		if (!page.maps.has(r.id) && r.page) {
			await this.client.aiPages({ op: "select", page: r.page });
			page = await mapsOnPage(this.client);
		}
		const cells = page.maps.get(r.id);
		const ids = nodeIds.map((id) => cells?.get(id)?.cellId).filter((x): x is string => !!x);
		if (!ids.length) {
			this.chat.note("Those shapes are not on the diagram any more.");
			return;
		}
		await this.client.aiSetSelection(ids, true);
	}
}
