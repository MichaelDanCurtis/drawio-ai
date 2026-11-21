/** Draws the IaC resources of one cloud: a container per module / stack / template, edges from references. */
import type { CheckCoverage, MapEdge, MapFinding, MapGraph, MapNode } from "../../../types";
import { FindingSet, findingsMarkdown, findingsSummary, portNames, riskyPorts, Severity } from "../findings";
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

/** A health check result on one declared resource (before it becomes a MapFinding). */
export interface IacCheckResult {
	kind: string;
	severity: Severity;
	title: string;
	/** The evidence: setting and value (the file:line is added by the caller). */
	evidence: string;
	fix: string;
	/** Addresses of other resources in the same group the finding concerns too (e.g. the bucket of an IAM member). */
	alsoRefs?: string[];
}

const DATABASE = /(^aws_(db_instance|rds_cluster(_instance)?|docdb_cluster|neptune_cluster)$)|^AWS::(RDS|DocDB|Neptune)::DB|^google_(sql_database_instance|spanner_(instance|database)|bigtable_instance|alloydb_cluster)$|sqladmin\.v1\w*\.instance$/i;
const NETWORK_PROTOCOL = /^(tcp|udp|6|17|\*|any|all|-1)$/i;

/** Risky ports of an openPorts attribute ("tcp/22, all, udp/*, tcp/?"), and whether some ports were not literal. */
export function openPortRisk(openPorts: string): { risky: string[]; unknown: boolean } {
	const risky = new Set<string>();
	let unknown = false;
	for (const entry of openPorts.split(/,\s*/).filter(Boolean)) {
		if (entry === "all") {
			risky.add("all ports");
			continue;
		}
		const [proto, ports] = entry.split("/");
		if (!NETWORK_PROTOCOL.test(proto)) continue;
		if (ports === "?") unknown = true;
		else if (ports === "*") risky.add("all ports");
		else {
			const [from, to] = ports.split("-").map(Number);
			for (const p of riskyPorts(from, to ?? from)) risky.add(p);
		}
	}
	return { risky: [...risky], unknown };
}

/** Health checks on the settings a resource declares (literal values only; never secrets). */
export function iacFindings(r: IacResource): IacCheckResult[] {
	if (r.kind !== "resource" || r.attrs.existing === "true") return [];
	const norm = (k: string) => k.toLowerCase().replace(/_/g, "");
	const entries = Object.entries(r.attrs).map(([k, v]) => ({ key: k, n: norm(k), value: String(v), lower: String(v).toLowerCase() }));
	/** The first declared setting among these (normalized) names. */
	const get = (...names: string[]) => entries.find((e) => names.includes(e.n));
	const is = (value: string, ...names: string[]) => {
		const e = get(...names);
		return e && e.lower === value ? e : undefined;
	};
	const show = (e: { key: string; value: string }) => `${e.key} = ${/^(true|false|-?\d+)$/.test(e.value) ? e.value : `"${e.value}"`}`;
	const name = r.attrs.name && !/\$\{|\[/.test(r.attrs.name) ? `${r.address} (${r.attrs.name})` : r.address;
	const out: IacCheckResult[] = [];

	// Inbound rules open to the internet.
	if (r.attrs.openToWorld === "true" && r.attrs.openPorts) {
		const { risky, unknown } = openPortRisk(r.attrs.openPorts);
		const evidence = `inbound ${r.attrs.openPorts} allowed from ${r.attrs.openSources ?? "0.0.0.0/0"}`;
		if (risky.length)
			out.push({
				kind: "open-ingress",
				severity: "high",
				title: `${name} opens ${portNames(risky)} to the internet`,
				evidence,
				fix: `Narrow the inbound rule(s) of ${r.address} to known address ranges instead of ${r.attrs.openSources ?? "0.0.0.0/0"}, or remove them; reach machines through a bastion, VPN or identity-aware proxy instead.`,
			});
		else if (unknown)
			out.push({
				kind: "open-ingress",
				severity: "medium",
				title: `${name} opens ports set by an expression to the internet`,
				evidence: `${evidence} (the ports come from a variable or expression)`,
				fix: `Check which ports the inbound rule(s) of ${r.address} resolve to; if they include remote administration or database ports, narrow the sources to known address ranges.`,
			});
	}

	// Databases reachable from the internet.
	const pubDb = is("true", "publiclyaccessible");
	if (pubDb)
		out.push({
			kind: "public-database",
			severity: "high",
			title: `${name} is publicly accessible`,
			evidence: show(pubDb),
			fix: `Set ${pubDb.key} to false on ${r.address} and reach the database from inside the network (private subnets, a bastion or a VPN).`,
		});
	if (r.attrs.authorizedNetworks)
		out.push({
			kind: "public-database",
			severity: "high",
			title: `${name} accepts database connections from any address`,
			evidence: `authorized network ${r.attrs.authorizedNetworks}`,
			fix: `Remove the ${r.attrs.authorizedNetworks} authorized network from ${r.address}; use private IP or the Cloud SQL Auth Proxy, or list only the client addresses that need access.`,
		});
	const start = get("startipaddress");
	const end = get("endipaddress");
	if (start?.value === "0.0.0.0" && end?.value === "255.255.255.255")
		out.push({
			kind: "public-database",
			severity: "high",
			title: `${name} lets every IPv4 address through the database firewall`,
			evidence: `${show(start)}, ${show(end)}`,
			fix: `Replace the 0.0.0.0–255.255.255.255 firewall rule ${r.address} with rules for the client addresses that need access, or use a private endpoint.`,
		});

	// Public buckets and storage.
	const acl = get("acl", "accesscontrol");
	if (acl && /^(public-?read(-?write)?|authenticated-?read)$/i.test(acl.value))
		out.push({
			kind: "public-bucket",
			severity: "high",
			title: `${name} makes its objects readable by anyone`,
			evidence: show(acl),
			fix: `Remove the ${acl.value} ACL from ${r.address} (keep it private, with S3 Block Public Access on) and serve public content through CloudFront with origin access control.`,
		});
	if (r.attrs.publicMembers)
		out.push({
			kind: "public-bucket",
			severity: "high",
			title: `${name} grants ${r.attrs.role ?? "a role"} on a bucket to ${r.attrs.publicMembers}`,
			evidence: `member(s) ${r.attrs.publicMembers}${r.attrs.role ? `, role ${r.attrs.role}` : ""}`,
			fix: `Remove ${r.attrs.publicMembers} from ${r.address}; grant access to specific principals, and enforce public access prevention on the bucket.`,
			alsoRefs: r.refs.filter((x) => /^google_storage_bucket\./.test(x)),
		});
	const container = get("containeraccesstype", "publicaccess");
	if (container && /^(blob|container)$/i.test(container.value))
		out.push({
			kind: "public-bucket",
			severity: "high",
			title: `${name} lets anyone read its blobs`,
			evidence: show(container),
			fix: `Set ${container.key} to private ("None" in ARM / Bicep) on ${r.address} and hand out SAS tokens or use Entra ID for readers.`,
		});
	const blockOff = entries.filter((e) => ["blockpublicacls", "blockpublicpolicy", "ignorepublicacls", "restrictpublicbuckets"].includes(e.n) && e.lower === "false");
	if (blockOff.length)
		out.push({
			kind: "public-access-block-off",
			severity: "medium",
			title: `${name} turns S3 Block Public Access off`,
			evidence: blockOff.map(show).join(", "),
			fix: `Set ${blockOff.map((e) => e.key).join(", ")} to true on ${r.address} unless the bucket must be public.`,
			alsoRefs: r.refs.filter((x) => /^aws_s3_bucket\./.test(x)),
		});
	const blobPublic = is("true", "allowblobpublicaccess", "allownesteditemstobepublic");
	if (blobPublic)
		out.push({
			kind: "public-blob-access",
			severity: "medium",
			title: `${name} allows containers to be made public`,
			evidence: show(blobPublic),
			fix: `Set ${blobPublic.key} to false on ${r.address} so no container can be opened to anonymous readers.`,
		});

	// Encryption and transport security.
	const enc = is("false", "storageencrypted", "encrypted");
	if (enc)
		out.push({
			kind: "unencrypted-storage",
			severity: "medium",
			title: `${name} stores data unencrypted`,
			evidence: show(enc),
			fix: `Set ${enc.key} to true on ${r.address} (for an existing database or volume this means restoring from an encrypted snapshot copy).`,
		});
	const https = is("false", "httpsonly", "supportshttpstrafficonly", "enablehttpstrafficonly", "httpstrafficonlyenabled");
	if (https)
		out.push({
			kind: "https-not-enforced",
			severity: "medium",
			title: `${name} accepts plain HTTP`,
			evidence: show(https),
			fix: `Set ${https.key} to true on ${r.address} so clients are redirected to HTTPS.`,
		});
	const nonSsl = is("true", "enablenonsslport");
	if (nonSsl)
		out.push({
			kind: "unencrypted-transit",
			severity: "medium",
			title: `${name} opens a non-TLS port`,
			evidence: show(nonSsl),
			fix: `Set ${nonSsl.key} to false on ${r.address} and connect over TLS (port 6380).`,
		});
	const tls = get("mintlsversion", "minimumtlsversion", "minimaltlsversion");
	if (tls && /^(tls)?1[._][01]$/i.test(tls.value))
		out.push({
			kind: "old-tls",
			severity: "medium",
			title: `${name} still accepts TLS ${tls.value.replace(/^tls/i, "").replace("_", ".")}`,
			evidence: show(tls),
			fix: `Raise ${tls.key} on ${r.address} to TLS 1.2 (${/^tls/i.test(tls.value) ? '"TLS1_2"' : '"1.2"'}).`,
		});
	const pna = is("true", "publicnetworkaccessenabled") ?? is("enabled", "publicnetworkaccess");
	if (pna)
		out.push({
			kind: "public-network-access",
			severity: "low",
			title: `${name} is reachable over its public endpoint`,
			evidence: show(pna),
			fix: `Disable public network access on ${r.address} and reach it through a private endpoint, or restrict its firewall to known networks.`,
		});

	// Resilience.
	const del = is("false", "deletionprotection");
	if (del && DATABASE.test(r.type))
		out.push({
			kind: "deletion-protection-off",
			severity: "low",
			title: `${name} can be deleted without protection`,
			evidence: show(del),
			fix: `Set ${del.key} to true on ${r.address} so the database cannot be destroyed by an accidental apply or delete.`,
		});
	const multiAz = is("false", "multiaz");
	if (multiAz && DATABASE.test(r.type))
		out.push({
			kind: "single-az-database",
			severity: "low",
			title: `${name} runs in a single availability zone`,
			evidence: show(multiAz),
			fix: `Set ${multiAz.key} to true on ${r.address} for a standby in another zone.`,
		});
	if (/^azurerm_key_vault$|^Microsoft\.KeyVault\/vaults$/i.test(r.type)) {
		const purge = get("purgeprotectionenabled", "enablepurgeprotection");
		if (!purge || purge.lower !== "true")
			out.push({
				kind: "no-purge-protection",
				severity: "low",
				title: `${name} can be purged during its soft-delete period`,
				evidence: purge ? show(purge) : `${r.tool === "terraform" ? "purge_protection_enabled" : "enablePurgeProtection"} not set (off by default)`,
				fix: `Enable purge protection on ${r.address} (${r.tool === "terraform" ? "purge_protection_enabled = true" : "enablePurgeProtection: true"}) so deleted keys and secrets cannot be destroyed before the retention period ends.`,
			});
	}

	// Kubernetes control planes reachable from anywhere.
	const k8s =
		(r.type === "google_container_cluster" && r.attrs.privateEndpoint === "false" && r.attrs.masterAuthorizedNetworks === "false" && "no private endpoint and no master_authorized_networks_config") ||
		((r.type === "azurerm_kubernetes_cluster" || /managedClusters$/i.test(r.type)) && r.attrs.privateCluster === "false" && r.attrs.authorizedIpRanges === "false" && "not a private cluster and no authorized IP ranges") ||
		(r.type === "aws_eks_cluster" && r.attrs.endpointPublicAccess === "true" && /0\.0\.0\.0\/0/.test(r.attrs.publicAccessCidrs ?? "") && `endpoint_public_access on, public_access_cidrs ${r.attrs.publicAccessCidrs}`);
	if (k8s)
		out.push({
			kind: "public-control-plane",
			severity: "medium",
			title: `The Kubernetes API of ${name} is reachable from the whole internet`,
			evidence: k8s,
			fix: `Restrict the API server of ${r.address} to known networks (authorized networks / authorized IP ranges / public_access_cidrs) or make the endpoint private.`,
		});
	return out;
}

/** The health checks and the resource types each one examines. */
const IAC_CHECKS: { check: string; types: RegExp; note?: string }[] = [
	{
		check: "Inbound rules open to the internet",
		types: /^(aws_security_group(_rule)?|aws_vpc_security_group_ingress_rule|google_compute_firewall|azurerm_network_security_(group|rule))$|^AWS::EC2::SecurityGroup(Ingress)?$|networkSecurityGroups(\/securityRules)?$|compute\.v1\.firewall$/i,
		note: "Security groups, firewalls and NSGs examined; only literal rules opening remote administration, database or all ports (or ports set by an expression) are reported.",
	},
	{ check: "Publicly accessible databases", types: /db_instance|rds_cluster|^AWS::RDS::|sql_database_instance|sqladmin|firewall_rule$|firewallRules$|^Microsoft\.(Sql|DBfor\w+)\//i },
	{ check: "Public buckets and storage", types: /s3_bucket|^AWS::S3::Bucket$|storage_bucket|storage\.v1\.bucket|storage_(account|container)$|^Microsoft\.Storage\/storageAccounts/i },
	{ check: "Encryption at rest", types: /db_instance|rds_cluster|ebs_volume|^AWS::(RDS::DB|EC2::Volume)/i },
	{ check: "HTTPS and TLS settings", types: /app_service|web_app|function_app|^Microsoft\.Web\/sites$|storage_account$|^Microsoft\.Storage\/storageAccounts$|(mssql|sql)_server$|^Microsoft\.Sql\/servers$|redis_cache$|^Microsoft\.Cache\/redis$/i },
	{ check: "Kubernetes API exposure", types: /^(google_container_cluster|azurerm_kubernetes_cluster|aws_eks_cluster)$|managedClusters$/i },
	{ check: "Key Vault purge protection", types: /^azurerm_key_vault$|^Microsoft\.KeyVault\/vaults$/i },
	{ check: "Database deletion protection and availability", types: DATABASE },
];

export interface IacMap {
	graph: MapGraph;
	facts: string;
	summary: string;
	warnings: string[];
	findings: MapFinding[];
	checked: CheckCoverage[];
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
		const files = [...new Set([...own, ...keptModules].filter((r) => r.group === g.id).map((r) => r.file))].sort();
		nodes.push({ id: g.id, label: g.label, kind: `iac:${g.tool}:group`, container: true, style: groupStyle(g.tool), data: { tool: g.tool, path: g.path }, ...(files.length ? { files } : {}) });
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
			files: [r.file],
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
			files: [m.file],
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

	const found = new FindingSet();
	const declared = own.filter((r) => r.kind === "resource" && r.attrs.existing !== "true");
	for (const c of IAC_CHECKS) {
		const scanned = declared.filter((r) => c.types.test(r.type)).length;
		if (scanned) found.check(c.check, scanned, c.note);
	}
	for (const r of declared) {
		for (const f of iacFindings(r)) {
			const also = (f.alsoRefs ?? []).map((a) => `${r.group}::${a}`).filter((id) => nodeIds.has(id));
			found.add({ kind: f.kind, severity: f.severity, title: f.title, detail: `${r.file}:${r.line} ${r.address}: ${f.evidence}.`, nodeIds: [r.id, ...also], fix: f.fix });
		}
	}
	const graph: MapGraph = { title: `${CLOUD_NAMES[cloud]} IaC · ${repoName}`, nodes, edges, direction: "down", legend: [] };
	// Fold only many resources of the same type in one module (e.g. 60 DNS records).
	const foldedIds = new Map<string, string>();
	const folded = collapseCrowds(graph, 30, (n) => `${n.kind}\u0000${n.data?.type ?? ""}`, foldedIds);
	const { findings, checked } = found.finish(graph, foldedIds);
	const tools = [...new Set(groups.map((g) => g.tool))];
	graph.legend = [
		`${CLOUD_NAMES[cloud]} resources declared in ${repoName} (${tools.join(", ") || "no IaC"}): ${own.length} in ${groups.length} module(s) / stack(s) / template(s).`,
		"Arrows: a resource refers to another (references, dependsOn). Dashed purple: a module or nested stack and the code it instantiates. Faded: data sources and existing resources.",
		...(folded ? [`${folded} resources folded into "+N more" shapes.`] : []),
	];
	const summary = own.length ? `${own.length} ${CLOUD_NAMES[cloud]} resource(s) in ${groups.length} module(s)/stack(s)/template(s) (${tools.join(", ")})${findingsSummary(findings)}` : `No ${CLOUD_NAMES[cloud]} resources found in the IaC files.`;
	return { graph, facts: factsOf(groups, own, keptModules, findings, cloud), summary, warnings, findings, checked };
}

function factsOf(groups: IacGroup[], own: IacResource[], modules: IacResource[], findings: MapFinding[], cloud: Exclude<Cloud, "other">): string {
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
	lines.push(...findingsMarkdown(findings, "## Health findings (from the declared settings; also drawn as badges on the shapes)"));
	return lines.join("\n");
}
