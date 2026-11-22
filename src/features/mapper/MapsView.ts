import * as vscode from "vscode";
import type { MapRecord, MapTour } from "../../../standalone/src/main/mapper/store";
import type { MapFinding } from "../../../standalone/src/main/mapper/types";

/** What "Recent changes" found on a map. */
export interface ChangedShapes {
	since?: string;
	changedFiles: number;
	shapes: { nodeId: string; label: string; files: string[]; how: string[] }[];
}

/** What the Maps view shows: each map of the diagram used last, with its findings, tours and recent changes. */
export type MapNode =
	| { kind: "map"; mapId: string; record: MapRecord }
	| { kind: "findings"; mapId: string; record: MapRecord; findings: MapFinding[] }
	| { kind: "finding"; mapId: string; findingId: string; record: MapRecord; finding: MapFinding }
	| { kind: "tours"; mapId: string; record: MapRecord }
	| { kind: "tour"; mapId: string; tourId: string; record: MapRecord; tour: MapTour }
	| { kind: "changes"; mapId: string; record: MapRecord; changes: ChangedShapes }
	| { kind: "change"; mapId: string; nodeIds: string[]; label: string; detail: string };

export interface MapsViewData {
	records: MapRecord[];
	changes: Map<string, ChangedShapes>;
	/** The findings still showing (dismissed ones are left out). */
	active(record: MapRecord): MapFinding[];
}

const SEVERITY_ORDER: MapFinding["severity"][] = ["high", "medium", "low", "info"];
const SEVERITY_LABEL: Record<MapFinding["severity"], string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };
const SEVERITY_ICON: Record<MapFinding["severity"], vscode.ThemeIcon> = {
	high: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")),
	medium: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")),
	low: new vscode.ThemeIcon("info", new vscode.ThemeColor("problemsInfoIcon.foreground")),
	info: new vscode.ThemeIcon("circle-outline"),
};

export class MapsViewProvider implements vscode.TreeDataProvider<MapNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this.changed.event;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly data: () => Promise<MapsViewData | undefined>) {}

	public refresh(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.changed.fire(), 150);
	}

	public async getChildren(node?: MapNode): Promise<MapNode[]> {
		if (!node) {
			const data = await this.data().catch(() => undefined);
			return (data?.records ?? []).map((record) => ({ kind: "map", mapId: record.id, record }));
		}
		switch (node.kind) {
			case "map": {
				const data = await this.data().catch(() => undefined);
				const r = node.record;
				const findings = data ? data.active(r) : r.findings;
				const out: MapNode[] = [{ kind: "findings", mapId: r.id, record: r, findings }];
				if (r.tours.length) out.push({ kind: "tours", mapId: r.id, record: r });
				const changes = data?.changes.get(r.id);
				if (changes) out.push({ kind: "changes", mapId: r.id, record: r, changes });
				return out;
			}
			case "findings":
				return [...node.findings]
					.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
					.map((finding) => ({ kind: "finding", mapId: node.mapId, findingId: finding.id, record: node.record, finding }));
			case "tours":
				return node.record.tours.map((tour) => ({ kind: "tour", mapId: node.mapId, tourId: tour.id, record: node.record, tour }));
			case "changes":
				return node.changes.shapes.map((s) => ({
					kind: "change",
					mapId: node.mapId,
					nodeIds: [s.nodeId],
					label: s.label,
					detail: `${s.how.join(", ")}: ${s.files.slice(0, 6).join(", ")}${s.files.length > 6 ? ` +${s.files.length - 6}` : ""}`,
				}));
			default:
				return [];
		}
	}

	public getTreeItem(node: MapNode): vscode.TreeItem {
		switch (node.kind) {
			case "map": {
				const r = node.record;
				const t = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.Expanded);
				t.id = `map:${r.id}`;
				t.description = `${r.graph.nodes.length} shape${r.graph.nodes.length === 1 ? "" : "s"}${r.page ? ` · ${r.page}` : ""}`;
				t.tooltip = new vscode.MarkdownString(
					[`**${escapeMd(r.title)}**`, escapeMd(r.summary), r.root ? `From \`${r.root}\`` : "", `Made ${new Date(r.createdAt).toLocaleString()}`, `${Object.keys(r.descriptions).length} of ${r.graph.nodes.length} shapes described`]
						.filter(Boolean)
						.join("\n\n")
				);
				t.iconPath = new vscode.ThemeIcon("type-hierarchy");
				t.contextValue = "drawioMap";
				t.command = { command: "drawio-ai.maps.show", title: "Show the Map", arguments: [{ mapId: r.id }] };
				return t;
			}
			case "findings": {
				const n = node.findings.length;
				const dismissed = node.record.findings.length - n;
				const t = new vscode.TreeItem(n ? `Findings (${n})` : "No findings", n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				t.id = `findings:${node.mapId}`;
				t.description = dismissed ? `${dismissed} dismissed` : undefined;
				const checked = node.record.checked;
				// An empty list is not "all clear" unless something was checked.
				t.tooltip = checked.length ? `What was checked:\n${checked.map((c) => `• ${c.check}: ${c.scanned}${c.note ? ` (${c.note})` : ""}`).join("\n")}` : "No checks ran for this map.";
				t.iconPath = new vscode.ThemeIcon(n ? "warning" : checked.length ? "pass" : "circle-slash");
				return t;
			}
			case "finding": {
				const f = node.finding;
				const label = (id: string) => node.record.graph.nodes.find((x) => x.id === id)?.label ?? id;
				const t = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
				t.id = `finding:${node.mapId}:${f.id}`;
				t.description = f.nodeIds.map(label).join(", ");
				t.tooltip = new vscode.MarkdownString(
					[`**${SEVERITY_LABEL[f.severity]}**: ${escapeMd(f.title)}`, f.detail ? escapeMd(f.detail) : "", f.fix ? `Fix: ${escapeMd(f.fix)}` : ""].filter(Boolean).join("\n\n")
				);
				t.iconPath = SEVERITY_ICON[f.severity];
				t.contextValue = "drawioMapFinding";
				t.command = { command: "drawio-ai.maps.showFinding", title: "Show on the Map", arguments: [{ mapId: node.mapId, findingId: f.id }] };
				return t;
			}
			case "tours": {
				const t = new vscode.TreeItem(`Tours (${node.record.tours.length})`, vscode.TreeItemCollapsibleState.Expanded);
				t.id = `tours:${node.mapId}`;
				t.iconPath = new vscode.ThemeIcon("play-circle");
				return t;
			}
			case "tour": {
				const t = new vscode.TreeItem(node.tour.title, vscode.TreeItemCollapsibleState.None);
				t.id = `tour:${node.mapId}:${node.tour.id}`;
				t.description = `${node.tour.steps.length} step${node.tour.steps.length === 1 ? "" : "s"}`;
				t.tooltip = node.tour.steps.map((s, i) => `${i + 1}. ${s.title || s.caption}`).join("\n");
				t.iconPath = new vscode.ThemeIcon("play");
				t.contextValue = "drawioMapTour";
				t.command = { command: "drawio-ai.maps.playTour", title: "Play the Tour", arguments: [{ mapId: node.mapId, tourId: node.tour.id }] };
				return t;
			}
			case "changes": {
				const c = node.changes;
				const t = new vscode.TreeItem(`Changed${c.since ? ` since ${c.since}` : ""} (${c.shapes.length})`, c.shapes.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
				t.id = `changes:${node.mapId}`;
				t.description = `${c.changedFiles} file${c.changedFiles === 1 ? "" : "s"}`;
				t.iconPath = new vscode.ThemeIcon("git-compare");
				return t;
			}
			case "change": {
				const t = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
				t.id = `change:${node.mapId}:${node.nodeIds[0]}`;
				t.description = node.detail;
				t.tooltip = node.detail;
				t.iconPath = new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
				t.command = { command: "drawio-ai.maps.showShapes", title: "Show on the Map", arguments: [{ mapId: node.mapId, nodeIds: node.nodeIds }] };
				return t;
			}
		}
	}

	/** What the view shows, as plain data (tests). */
	public async snapshot(): Promise<{ label: string; children: { label: string; children: string[] }[] }[]> {
		const text = (n: MapNode) => String(this.getTreeItem(n).label);
		const out = [];
		for (const map of await this.getChildren()) {
			const children = [];
			for (const group of await this.getChildren(map)) children.push({ label: text(group), children: (await this.getChildren(group)).map(text) });
			out.push({ label: text(map), children });
		}
		return out;
	}

	public dispose(): void {
		clearTimeout(this.timer);
		this.changed.dispose();
	}
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
