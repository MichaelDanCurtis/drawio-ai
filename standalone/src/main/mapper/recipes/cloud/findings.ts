/**
 * Health findings for the cloud collectors (AWS, Azure, Google Cloud, IaC):
 * a small builder that keeps ids stable (`${kind}:${nodeId}`), merges repeats,
 * counts what each check looked at, and maps the findings onto the nodes that
 * are finally drawn (folded "+N more" shapes, hidden containers).
 */
import type { CheckCoverage, MapFinding, MapGraph } from "../../types";

export type Severity = MapFinding["severity"];

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Ports that should never be open to the whole internet: remote administration and data stores. */
export const RISKY_PORTS: Record<number, string> = {
	22: "SSH",
	23: "Telnet",
	135: "RPC",
	445: "SMB",
	1433: "SQL Server",
	1521: "Oracle",
	2375: "Docker API",
	2379: "etcd",
	3306: "MySQL",
	3389: "RDP",
	5432: "PostgreSQL",
	5601: "Kibana",
	5984: "CouchDB",
	5985: "WinRM",
	5986: "WinRM",
	6379: "Redis",
	9042: "Cassandra",
	9200: "Elasticsearch",
	11211: "Memcached",
	27017: "MongoDB",
};

/**
 * The risky ports a port range opens: ["all ports"] for every port (or an
 * unknown range), else e.g. ["22 (SSH)"]. Empty when nothing risky is in it.
 */
export function riskyPorts(from?: number, to?: number): string[] {
	const lo = from === undefined || Number.isNaN(from) || from < 0 ? 0 : from;
	const hi = to === undefined || Number.isNaN(to) || to < 0 ? 65535 : to;
	if (lo <= 1 && hi >= 65535) return ["all ports"];
	return Object.entries(RISKY_PORTS)
		.filter(([p]) => Number(p) >= lo && Number(p) <= hi)
		.map(([p, name]) => `${p} (${name})`);
}

/** "22", "1000-2000", "*", 22 → [from, to]; undefined for anything else (named ports, variables). */
export function portRange(spec: unknown): [number, number] | undefined {
	if (typeof spec === "number" && Number.isFinite(spec)) return [spec, spec];
	const s = String(spec ?? "").trim();
	if (s === "*" || /^all$/i.test(s)) return [0, 65535];
	const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
	return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
}

/** "the internet": 0.0.0.0/0, ::/0, Azure's * / Internet / Any. */
export const WORLD = /^(0\.0\.0\.0\/0|::\/0|\*|internet|any)$/i;

/** "SSH (22)" style list for titles: "SSH and RDP", "all ports". */
export function portNames(list: string[]): string {
	const names = [...new Set(list.map((p) => (p === "all ports" ? p : /\((.+)\)/.exec(p)?.[1] ?? p)))];
	return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface NewFinding {
	kind: string;
	severity: Severity;
	title: string;
	detail?: string;
	nodeIds: string[];
	fix?: string;
	/** What the id is made of after the kind; default: the first node id. */
	key?: string;
}

export class FindingSet {
	private readonly byId = new Map<string, MapFinding>();
	private readonly checks = new Map<string, CheckCoverage>();

	/** Adds a finding; a second one with the same id adds its nodes to the first. */
	add(f: NewFinding): void {
		const nodeIds = f.nodeIds.filter(Boolean);
		if (!nodeIds.length) return;
		const id = `${f.kind}:${f.key ?? nodeIds[0]}`;
		const prev = this.byId.get(id);
		if (prev) {
			for (const n of nodeIds) if (!prev.nodeIds.includes(n)) prev.nodeIds.push(n);
			return;
		}
		this.byId.set(id, {
			id,
			kind: f.kind,
			severity: f.severity,
			title: f.title,
			...(f.detail ? { detail: f.detail } : {}),
			nodeIds: [...new Set(nodeIds)],
			...(f.fix ? { fix: f.fix } : {}),
		});
	}

	/** Counts what a check looked at (called once per region / resource is fine: counts add up). */
	check(name: string, scanned: number, note?: string): void {
		const c = this.checks.get(name);
		if (c) {
			c.scanned += scanned;
			if (note && !c.note) c.note = note;
		} else this.checks.set(name, { check: name, scanned, ...(note ? { note } : {}) });
	}

	get size(): number {
		return this.byId.size;
	}

	/**
	 * The findings on the drawn graph: node ids folded into another shape are
	 * replaced by it (`folded`: old id → shape id), ids not drawn are dropped, and
	 * a finding left without nodes is dropped. Sorted by severity, then id.
	 */
	finish(graph: MapGraph | undefined, folded?: Map<string, string>): { findings: MapFinding[]; checked: CheckCoverage[] } {
		const ids = new Set((graph?.nodes ?? []).map((n) => n.id));
		const findings: MapFinding[] = [];
		for (const f of this.byId.values()) {
			const nodeIds = [...new Set(f.nodeIds.map((n) => folded?.get(n) ?? n).filter((n) => ids.has(n)))];
			if (nodeIds.length) findings.push({ ...f, nodeIds });
		}
		findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));
		return { findings, checked: [...this.checks.values()] };
	}
}

/** The findings as a Markdown section for the agent's facts. */
export function findingsMarkdown(findings: MapFinding[], heading = "## Health findings"): string[] {
	if (!findings.length) return [];
	const lines = ["", heading];
	for (const f of findings) lines.push(`- [${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ""}${f.fix ? ` Fix: ${f.fix}` : ""}`);
	return lines;
}

/** A summary suffix: ", 3 findings (1 high)". */
export function findingsSummary(findings: MapFinding[]): string {
	if (!findings.length) return "";
	const high = findings.filter((f) => f.severity === "high").length;
	return `, ${findings.length} finding(s)${high ? ` (${high} high)` : ""}`;
}
