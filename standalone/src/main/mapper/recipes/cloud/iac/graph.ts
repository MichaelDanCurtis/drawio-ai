/** Draws the IaC resources of one cloud: a container per module / stack / template, edges from references. */
import type { MapEdge, MapGraph, MapNode } from "../../../types";
import { collapseCrowds } from "../aws/graph";
import { iacIconStyle } from "./icons";
import type { Cloud, IacGroup, IacResource, IacScan, IacTool } from "./model";

const GROUP_COLORS: Record<IacTool, string> = {
	terraform: "#7B42BC",
	cloudformation: "#E7157B",
	sam: "#E7157B",
	cdk: "#E7157B",
	bicep: "#0078D4",
	arm: "#0078D4",
	"deployment-manager": "#4285F4",
};
const groupStyle = (tool: IacTool) =>
	`rounded=1;arcSize=2;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=none;dashed=0;strokeColor=${GROUP_COLORS[tool]};fontColor=${GROUP_COLORS[tool]};`;
const MODULE_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f3eefa;strokeColor=#7B42BC;fontColor=#4a2a7a;fontSize=11;";
const REF_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;endFill=0;strokeColor=#6b7280;fontSize=10;";
const MODULE_EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;dashed=1;strokeColor=#7B42BC;fontSize=10;";

export const CLOUD_NAMES: Record<Exclude<Cloud, "other">, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud" };

/** "aws_instance" → "instance"; "AWS::EC2::Instance" → "EC2::Instance"; "Microsoft.Web/sites" → "Web/sites". */
export function shortType(type: string): string {
	if (/^AWS::/.test(type)) return type.slice(5);
	if (/^Microsoft\./i.test(type)) return type.replace(/^Microsoft\./i, "");
	if (/^[a-z0-9-]+\.v\w+\./.test(type)) return type.split(".").slice(-1)[0];
	return type.replace(/^(aws|awscc|azurerm|azuread|azapi|google|google-beta)_/, "");
}

export interface IacFinding {
	resource: IacResource;
	text: string;
}

/** Settings that are worth a review note. */
export function iacFindings(r: IacResource): string[] {
	const a = Object.fromEntries(Object.entries(r.attrs).map(([k, v]) => [k.toLowerCase().replace(/_/g, ""), String(v).toLowerCase()]));
	const out: string[] = [];
	if (a.opentoworld === "true") out.push("open to the internet (0.0.0.0/0 or *)");
	if (a.publiclyaccessible === "true") out.push("publicly accessible");
	if (a.storageencrypted === "false" || a.encrypted === "false") out.push("encryption disabled");
	if (/public-read/.test(a.acl ?? "")) out.push(`public ACL (${a.acl})`);
	if (a.allowblobpublicaccess === "true" || a.allownesteditemstobepublic === "true") out.push("allows public blob access");
	if (a.publicnetworkaccess === "enabled" || a.publicnetworkaccessenabled === "true") out.push("public network access enabled");
	if (a.httpsonly === "false" || a.supportshttpstrafficonly === "false") out.push("HTTPS not enforced");
	if (/tls1_[01]|^1\.[01]$/.test(a.mintlsversion ?? a.minimumtlsversion ?? "")) out.push(`old minimum TLS (${a.mintlsversion ?? a.minimumtlsversion})`);
	if (a.deletionprotection === "false") out.push("deletion protection off");
	return out;
}

export interface IacMap {
	graph: MapGraph;
	facts: string;
	summary: string;
	warnings: string[];
	findings: IacFinding[];
}

export function iacToGraph(scan: IacScan, cloud: Exclude<Cloud, "other">, repoName: string): IacMap {
	const warnings = scan.warnings.filter((w) => !w.cloud || w.cloud === cloud).map((w) => w.text);
	const groupsById = new Map(scan.groups.map((g) => [g.id, g]));
	const own = scan.resources.filter((r) => r.kind !== "module" && r.cloud === cloud);
	const included = new Set<string>(own.map((r) => r.group));
	// Modules that lead to included groups pull their caller in, transitively.
	const modules = scan.resources.filter((r) => r.kind === "module");
	for (let changed = true; changed; ) {
		changed = false;
		for (const m of modules) if (m.moduleTarget && included.has(m.moduleTarget) && !included.has(m.group)) (included.add(m.group), (changed = true));
	}
	const keptModules = modules.filter((m) => included.has(m.group) && (!m.moduleTarget || included.has(m.moduleTarget) || !groupsById.has(m.moduleTarget)));
	const others = scan.resources.filter((r) => r.kind !== "module" && r.cloud !== cloud);
	if (others.length) {
		const byCloud = new Map<string, string[]>();
		for (const r of others) byCloud.set(r.cloud, [...(byCloud.get(r.cloud) ?? []), r.type]);
		const parts = [...byCloud].map(([c, types]) => `${c === "other" ? "other providers" : CLOUD_NAMES[c as Exclude<Cloud, "other">]}: ${types.length} (${[...new Set(types)].slice(0, 4).join(", ")}${new Set(types).size > 4 ? ", …" : ""})`);
		warnings.push(`Not drawn (not ${CLOUD_NAMES[cloud]}): ${parts.join("; ")}.`);
	}

	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const nodeIds = new Set<string>();
	const groups = scan.groups.filter((g) => included.has(g.id));
	for (const g of groups) {
		nodes.push({ id: g.id, label: g.label, kind: `iac:${g.tool}:group`, container: true, style: groupStyle(g.tool), data: { tool: g.tool, path: g.path } });
		nodeIds.add(g.id);
	}
	const dataOf = (r: IacResource): Record<string, string> => {
		const d: Record<string, string> = {};
		// Names ending in source / target / parent read like cell references in draw.io XML: avoid them.
		for (const [k, v] of Object.entries(r.attrs)) d[`attr_${k}${/(source|target|parent)$/i.test(k) ? "_" : ""}`] = v;
		return { ...d, type: r.type, address: r.address, file: r.file, line: String(r.line), tool: r.tool, cloud: r.cloud === "other" ? "" : r.cloud };
	};
	for (const r of own) {
		const icon = iacIconStyle(cloud, r.type, r.attrs.kind);
		const multi = r.attrs.count ? " [count]" : r.attrs.for_each ? " [for_each]" : r.attrs.copy ? " [copy]" : "";
		const label = `${r.kind === "data" ? "data · " : ""}${r.name}${multi}\n${shortType(r.type)}`;
		nodes.push({
			id: r.id,
			label,
			kind: `iac:${cloud}:${r.kind}`,
			parent: r.group,
			shape: "icon",
			style: icon.style + (r.kind === "data" || r.attrs.existing === "true" ? "opacity=55;" : ""),
			width: icon.width,
			height: icon.height,
			data: dataOf(r),
		});
		nodeIds.add(r.id);
	}
	for (const m of keptModules) {
		const target = m.moduleTarget ? groupsById.get(m.moduleTarget) : undefined;
		nodes.push({
			id: m.id,
			label: `${m.tool === "terraform" ? `module "${m.name}"` : m.name}\n${target?.path ?? m.moduleSource ?? m.type}`.slice(0, 120),
			kind: "iac:module",
			parent: m.group,
			style: MODULE_STYLE,
			width: 170,
			height: 46,
			data: { ...dataOf(m), ...(m.moduleSource ? { moduleSource: m.moduleSource } : {}) },
		});
		nodeIds.add(m.id);
	}
	const seen = new Set<string>();
	for (const r of [...own, ...keptModules]) {
		for (const ref of r.refs) {
			const to = `${r.group}::${ref}`;
			if (!nodeIds.has(to) || to === r.id || seen.has(`${r.id}\u0000${to}`)) continue;
			seen.add(`${r.id}\u0000${to}`);
			edges.push({ from: r.id, to, kind: "ref", style: REF_EDGE });
		}
		if (r.moduleTarget && nodeIds.has(r.moduleTarget)) edges.push({ from: r.id, to: r.moduleTarget, kind: "module", label: "instantiates", style: MODULE_EDGE });
	}
	for (const m of keptModules) if (m.moduleTarget && !groupsById.has(m.moduleTarget)) warnings.push(`${m.file}:${m.line}: ${m.address} points at ${m.moduleTarget.replace(/^\w+:/, "")}, which has no IaC files in the folder.`);

	const findings: IacFinding[] = own.flatMap((r) => iacFindings(r).map((text) => ({ resource: r, text })));
	const graph: MapGraph = { title: `${CLOUD_NAMES[cloud]} IaC · ${repoName}`, nodes, edges, direction: "down", legend: [] };
	// Fold only many resources of the same type in one module (e.g. 60 DNS records).
	const folded = collapseCrowds(graph, 30, (n) => `${n.kind}\u0000${n.data?.type ?? ""}`);
	const tools = [...new Set(groups.map((g) => g.tool))];
	graph.legend = [
		`${CLOUD_NAMES[cloud]} resources declared in ${repoName} (${tools.join(", ") || "no IaC"}): ${own.length} in ${groups.length} module(s) / stack(s) / template(s).`,
		"Arrows: a resource refers to another (references, dependsOn). Dashed purple: a module or nested stack and the code it instantiates. Faded: data sources and existing resources.",
		...(folded ? [`${folded} resources folded into "+N more" shapes.`] : []),
	];
	const summary = own.length ? `${own.length} ${CLOUD_NAMES[cloud]} resource(s) in ${groups.length} module(s)/stack(s)/template(s) (${tools.join(", ")})${findings.length ? `, ${findings.length} review finding(s)` : ""}` : `No ${CLOUD_NAMES[cloud]} resources found in the IaC files.`;
	return { graph, facts: factsOf(groups, own, keptModules, findings, cloud), summary, warnings, findings };
}

function factsOf(groups: IacGroup[], own: IacResource[], modules: IacResource[], findings: IacFinding[], cloud: Exclude<Cloud, "other">): string {
	const lines = [`# ${CLOUD_NAMES[cloud]} infrastructure as code (read from the repository)`, ""];
	for (const g of groups) {
		lines.push(`## ${g.label}`);
		for (const r of [...own, ...modules].filter((x) => x.group === g.id)) {
			const attrs = Object.entries(r.attrs)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ");
			lines.push(`- ${r.address} (${r.type}) at ${r.file}:${r.line}${r.refs.length ? ` → ${r.refs.join(", ")}` : ""}${r.moduleSource ? ` source=${r.moduleSource}` : ""}${attrs ? ` [${attrs}]` : ""}`);
		}
		lines.push("");
	}
	if (findings.length) {
		lines.push("## Review findings (from the declared settings)");
		for (const f of findings) lines.push(`- ${f.resource.address} (${f.resource.file}:${f.resource.line}): ${f.text}`);
	}
	return lines.join("\n");
}
