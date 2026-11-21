/**
 * Turns a Google Cloud inventory (Cloud Asset Inventory search results, or the
 * per-service `gcloud ... list` output) into a map: project › VPC network ›
 * region › subnetwork › resources, with serverless and regional services grouped
 * by region and edges found by scanning resources for references to each other.
 * Pure (no CLI calls), unit-tested with documented JSON shapes.
 */
import type { MapEdge, MapGraph, MapNode } from "../../../types";
import { CONTAINER_STYLES, EDGE_STYLES, GENERIC_STENCIL, gcpStencil, ICON_STYLE } from "./icons";

export interface GcpResource {
	/** Full resource name, e.g. //compute.googleapis.com/projects/p/zones/z/instances/i */
	name: string;
	assetType: string;
	displayName: string;
	/** Zone, region, multi-region (US, EU) or global. */
	location?: string;
	/** Project id. */
	project?: string;
	state?: string;
	labels?: Record<string, string>;
	networkTags?: string[];
	/** The resource's own JSON (versionedResources[0].resource, or the service list output). */
	data?: any;
	/** Cloud Asset additionalAttributes. */
	additional?: any;
}

export interface GcpInventory {
	project: { id: string; name?: string; number?: string };
	resources: GcpResource[];
	source: "asset-inventory" | "cli";
	collectedAt?: string;
}

/** Types never drawn (enabled APIs, keys, default routes...): counted in the facts only. */
const NOISE = new Set([
	"serviceusage.googleapis.com/Service",
	"iam.googleapis.com/ServiceAccountKey",
	"cloudresourcemanager.googleapis.com/Project",
	"compute.googleapis.com/Route",
	"cloudkms.googleapis.com/CryptoKeyVersion",
	"secretmanager.googleapis.com/SecretVersion",
	"appengine.googleapis.com/Version",
	"artifactregistry.googleapis.com/DockerImage",
	"run.googleapis.com/Revision",
	"cloudbilling.googleapis.com/ProjectBillingInfo",
	"monitoring.googleapis.com/NotificationChannel",
	"logging.googleapis.com/LogBucket",
	"compute.googleapis.com/Project",
]);

const COMPUTE_URL = /^https:\/\/(?:www\.googleapis\.com|compute\.googleapis\.com)\/compute\/(?:v1|beta|alpha)\/(projects\/.+)$/;
const CONTAINER_URL = /^https:\/\/container\.googleapis\.com\/v1(?:beta1)?\/(projects\/.+)$/;
const SQL_URL = /^https:\/\/sqladmin\.googleapis\.com\/sql\/v1(?:beta4)?\/(projects\/.+)$/;
const FULL = /^\/\/([a-z0-9.-]+\.googleapis\.com)\/(.+)$/;

/** A self link → full resource name (Cloud Asset format). */
export function fullNameFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	let m = COMPUTE_URL.exec(url);
	if (m) return `//compute.googleapis.com/${m[1]}`;
	m = CONTAINER_URL.exec(url);
	if (m) return `//container.googleapis.com/${m[1]}`;
	m = SQL_URL.exec(url);
	if (m) return `//cloudsql.googleapis.com/${m[1]}`;
	return undefined;
}

const last = (s: string | undefined) => (s ?? "").split("/").pop() ?? "";
/** us-central1-a → us-central1; regions stay; multi-regions and global have no region. */
export function regionOf(location: string | undefined): string | undefined {
	if (!location) return undefined;
	const l = last(location).toLowerCase();
	if (/^[a-z]+-[a-z]+\d+-[a-z]$/.test(l)) return l.replace(/-[a-z]$/, "");
	if (/^[a-z]+-[a-z]+\d+$/.test(l)) return l;
	return undefined;
}

/** The relative path used to match references: projects/p/regions/r/subnetworks/s, buckets/b… */
function relKey(fullName: string): string {
	const m = FULL.exec(fullName);
	if (!m) return fullName;
	if (m[1] === "storage.googleapis.com") return `buckets/${m[2].split("/")[0]}`;
	return m[2];
}

/** A string inside a resource's JSON that may point at another resource → candidate keys. */
function refCandidates(s: string, projectNumber?: string, projectId?: string): string[] {
	let key: string | undefined;
	const full = FULL.exec(s);
	if (full) key = relKey(s);
	else {
		const url = fullNameFromUrl(s);
		if (url) key = relKey(url);
		else if (/^projects\/[^/\s]+\/.+/.test(s)) key = s;
		else if (/^gs:\/\/[^/\s]+/.test(s)) key = `buckets/${s.slice(5).split("/")[0]}`;
	}
	if (!key) return [];
	if (projectNumber && projectId) key = key.replace(new RegExp(`^projects/${projectNumber}/`), `projects/${projectId}/`);
	const parts = key.split("/");
	const out: string[] = [];
	for (let end = parts.length; end >= 2; end -= 2) out.push(parts.slice(0, end).join("/"));
	return out;
}

interface Ref {
	value: string;
	path: string[];
}

/** Keys never read: environment variables and instance metadata (startup scripts, SSH keys). */
const SKIP_KEYS = /^(env|environmentVariables|secretEnvironmentVariables|buildEnvironmentVariables|secretVolumes)$/i;

function scan(value: any, path: string[] = [], out: Ref[] = [], depth = 0): Ref[] {
	if (depth > 20 || value === null || value === undefined) return out;
	if (typeof value === "string") {
		if (value.length < 2000 && /^(https:\/\/|\/\/|projects\/|gs:\/\/)/.test(value)) out.push({ value, path });
	} else if (Array.isArray(value)) {
		for (const v of value.slice(0, 300)) scan(v, path, out, depth + 1);
	} else if (typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (SKIP_KEYS.test(k) || (k === "items" && path[path.length - 1] === "metadata")) continue;
			scan(v, [...path, k], out, depth + 1);
		}
	}
	return out;
}

const SECRET_KEY = /(password|secret|token|credential|privatekey|private_key|apikey|api_key|startup-script|user-data|sshkeys|ssh-keys|env)/i;
function safe(key: string, v: any): string | undefined {
	if (SECRET_KEY.test(key)) return undefined;
	if (v === null || v === undefined || v === "") return undefined;
	if (typeof v === "string") return v.slice(0, 200);
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return undefined;
}

/** Key, non-secret facts about a resource. */
export function gcpKeyProps(r: GcpResource): Record<string, string> {
	const d = r.data ?? {};
	const a = r.additional ?? {};
	const out: Record<string, string> = {};
	const put = (k: string, v: any) => {
		const s = safe(k, v);
		if (s !== undefined) out[k] = s;
	};
	if (r.state) put("state", r.state);
	switch (r.assetType) {
		case "compute.googleapis.com/Instance": {
			put("machineType", last(d.machineType) || a.machineType);
			const nics: any[] = d.networkInterfaces ?? [];
			put("internalIPs", nics.map((n) => n.networkIP).filter(Boolean).join(",") || (a.internalIPs ?? []).join(","));
			const ext = nics.flatMap((n) => (n.accessConfigs ?? []).map((c: any) => c.natIP ?? "ephemeral")).filter(Boolean);
			put("externalIPs", ext.join(",") || (a.externalIPs ?? []).join(","));
			put("serviceAccount", (d.serviceAccounts ?? []).map((s: any) => s.email).join(","));
			if (d.shieldedInstanceConfig) put("secureBoot", d.shieldedInstanceConfig.enableSecureBoot);
			if (d.scheduling?.preemptible || d.scheduling?.provisioningModel === "SPOT") put("spot", true);
			break;
		}
		case "compute.googleapis.com/Firewall": {
			put("direction", d.direction);
			put("priority", d.priority);
			const allowed = (d.allowed ?? []).map((x: any) => `${x.IPProtocol}${x.ports ? `:${x.ports.join(",")}` : ""}`).join(" ");
			const denied = (d.denied ?? []).map((x: any) => `${x.IPProtocol}${x.ports ? `:${x.ports.join(",")}` : ""}`).join(" ");
			if (allowed) put("allow", allowed);
			if (denied) put("deny", denied);
			put("sourceRanges", (d.sourceRanges ?? []).join(","));
			put("sourceTags", (d.sourceTags ?? []).join(","));
			put("targetTags", (d.targetTags ?? []).join(",") || (d.direction !== "EGRESS" && !d.targetServiceAccounts ? "(all instances)" : ""));
			if (d.disabled) put("disabled", true);
			break;
		}
		case "compute.googleapis.com/Network":
			put("mode", d.autoCreateSubnetworks === undefined ? undefined : d.autoCreateSubnetworks ? "auto" : "custom");
			put("routingMode", d.routingConfig?.routingMode);
			break;
		case "compute.googleapis.com/Subnetwork":
			put("ipCidrRange", d.ipCidrRange);
			put("privateIpGoogleAccess", d.privateIpGoogleAccess);
			put("purpose", d.purpose);
			if (d.logConfig) put("flowLogs", d.logConfig.enable);
			break;
		case "compute.googleapis.com/ForwardingRule":
		case "compute.googleapis.com/GlobalForwardingRule":
			put("ipAddress", d.IPAddress);
			put("scheme", d.loadBalancingScheme);
			put("ports", d.portRange ?? (d.ports ?? []).join(","));
			break;
		case "compute.googleapis.com/Address":
		case "compute.googleapis.com/GlobalAddress":
			put("address", d.address);
			put("addressType", d.addressType);
			break;
		case "container.googleapis.com/Cluster": {
			put("version", d.currentMasterVersion);
			put("privateNodes", d.privateClusterConfig?.enablePrivateNodes ?? false);
			put("privateEndpoint", d.privateClusterConfig?.enablePrivateEndpoint ?? false);
			put("masterAuthorizedNetworks", d.masterAuthorizedNetworksConfig?.enabled ?? false);
			put("autopilot", d.autopilot?.enabled);
			put("workloadIdentity", !!d.workloadIdentityConfig?.workloadPool);
			put("nodePools", (d.nodePools ?? []).map((p: any) => `${p.name}: ${p.autoscaling?.enabled ? `${p.autoscaling.minNodeCount ?? p.autoscaling.totalMinNodeCount}-${p.autoscaling.maxNodeCount ?? p.autoscaling.totalMaxNodeCount}` : p.initialNodeCount ?? "?"}× ${p.config?.machineType ?? "?"}`).join("; "));
			break;
		}
		case "run.googleapis.com/Service": {
			const ann = { ...(d.metadata?.annotations ?? {}) };
			put("ingress", ann["run.googleapis.com/ingress"] ?? d.ingress);
			put("url", d.status?.url ?? d.uri);
			put("serviceAccount", d.spec?.template?.spec?.serviceAccountName ?? d.template?.serviceAccount);
			const tAnn = d.spec?.template?.metadata?.annotations ?? {};
			put("vpcConnector", tAnn["run.googleapis.com/vpc-access-connector"] ?? d.template?.vpcAccess?.connector);
			put("vpcEgress", tAnn["run.googleapis.com/vpc-access-egress"] ?? d.template?.vpcAccess?.egress);
			put("maxScale", tAnn["autoscaling.knative.dev/maxScale"]);
			break;
		}
		case "cloudfunctions.googleapis.com/Function":
		case "cloudfunctions.googleapis.com/CloudFunction":
			put("generation", d.environment ?? (d.runtime ? "GEN_1" : undefined));
			put("runtime", d.buildConfig?.runtime ?? d.runtime);
			put("ingress", d.serviceConfig?.ingressSettings ?? d.ingressSettings);
			put("url", d.serviceConfig?.uri ?? d.url ?? d.httpsTrigger?.url);
			put("serviceAccount", d.serviceConfig?.serviceAccountEmail ?? d.serviceAccountEmail);
			put("trigger", d.eventTrigger?.eventType ?? (d.httpsTrigger ? "http" : undefined));
			break;
		case "sqladmin.googleapis.com/Instance": {
			const ip = d.settings?.ipConfiguration ?? {};
			put("databaseVersion", d.databaseVersion);
			put("tier", d.settings?.tier);
			put("availability", d.settings?.availabilityType);
			put("publicIp", ip.ipv4Enabled);
			put("authorizedNetworks", (ip.authorizedNetworks ?? []).map((n: any) => n.value).join(","));
			put("sslMode", ip.sslMode ?? (ip.requireSsl ? "required" : undefined));
			put("backups", d.settings?.backupConfiguration?.enabled);
			put("privateNetwork", ip.privateNetwork);
			break;
		}
		case "storage.googleapis.com/Bucket":
			put("storageClass", d.storageClass ?? d.default_storage_class);
			put("publicAccessPrevention", d.iamConfiguration?.publicAccessPrevention ?? d.public_access_prevention);
			put("uniformAccess", d.iamConfiguration?.uniformBucketLevelAccess?.enabled ?? d.uniform_bucket_level_access);
			put("versioning", d.versioning?.enabled ?? d.versioning_enabled);
			break;
		case "redis.googleapis.com/Instance":
			put("tier", d.tier);
			put("memorySizeGb", d.memorySizeGb);
			put("authEnabled", d.authEnabled);
			put("transitEncryption", d.transitEncryptionMode);
			break;
		case "pubsub.googleapis.com/Subscription":
			put("push", d.pushConfig?.pushEndpoint ? "yes" : "no");
			put("ackDeadlineSeconds", d.ackDeadlineSeconds);
			break;
	}
	if (r.networkTags?.length) put("networkTags", r.networkTags.join(","));
	return out;
}

interface Built {
	graph: MapGraph;
	stats: { resources: number; drawn: number; networks: number; subnets: number; regions: number; edges: number; byType: Record<string, number>; hidden: Record<string, number> };
	facts: string;
}

export function buildGcpGraph(inv: GcpInventory): Built {
	const project = inv.project;
	const pid = project.id;
	const all = inv.resources.filter((r) => r && r.name && r.assetType);
	const byName = new Map(all.map((r) => [r.name, r]));
	const index = new Map<string, string>(); // relKey → full name
	for (const r of all) {
		const k = relKey(r.name);
		if (!index.has(k)) index.set(k, r.name);
		if (project.number) index.set(k.replace(new RegExp(`^projects/${pid}/`), `projects/${project.number}/`), r.name);
	}
	const hiddenCount: Record<string, number> = {};
	const hidden = new Set<string>();
	const alias = new Map<string, string>();
	const folded = new Map<string, GcpResource[]>();
	const fold = (name: string, owner: string) => {
		alias.set(name, owner);
		if (!folded.has(owner)) folded.set(owner, []);
		folded.get(owner)!.push(byName.get(name)!);
	};
	const clusters = all.filter((r) => r.assetType === "container.googleapis.com/Cluster");
	const clusterByShort = new Map(clusters.map((c) => [c.displayName, c.name]));
	for (const r of all) {
		if (NOISE.has(r.assetType)) {
			hidden.add(r.name);
			hiddenCount[r.assetType] = (hiddenCount[r.assetType] ?? 0) + 1;
			continue;
		}
		const d = r.data ?? {};
		// GKE nodes, node pools and their instance groups belong to their cluster.
		const gkeCluster = r.labels?.["goog-k8s-cluster-name"] ?? d.labels?.["goog-k8s-cluster-name"];
		if (gkeCluster && clusterByShort.has(gkeCluster) && r.assetType !== "container.googleapis.com/Cluster") {
			fold(r.name, clusterByShort.get(gkeCluster)!);
			continue;
		}
		if (r.assetType === "container.googleapis.com/NodePool" || /^compute\.googleapis\.com\/(InstanceGroup|InstanceGroupManager|InstanceTemplate)$/.test(r.assetType)) {
			const c = clusters.find((cl) => r.name.startsWith(`${cl.name}/`) || r.displayName.startsWith(`gke-${cl.displayName}-`));
			if (c) {
				fold(r.name, c.name);
				continue;
			}
		}
		if (r.assetType === "compute.googleapis.com/Disk") {
			const users: string[] = d.users ?? [];
			const owner = users.map(fullNameFromUrl).find((u) => u && byName.has(u));
			if (owner) {
				fold(r.name, owner);
				continue;
			}
		}
		// A 2nd-gen function runs on a Cloud Run service that Cloud Asset lists too.
		if (r.assetType === "run.googleapis.com/Service") {
			const fn = all.find((f) => f.assetType === "cloudfunctions.googleapis.com/Function" && typeof f.data?.serviceConfig?.service === "string" && relKey(r.name) === f.data.serviceConfig.service.replace(new RegExp(`^projects/${project.number ?? "\\d+"}/`), `projects/${pid}/`));
			if (fn) {
				fold(r.name, fn.name);
				continue;
			}
		}
		if (r.assetType === "bigquery.googleapis.com/Table") {
			const ds = r.name.replace(/\/tables\/[^/]+$/, "");
			if (byName.has(ds)) {
				fold(r.name, ds);
				continue;
			}
		}
	}
	const owner = (name: string) => {
		let n = name;
		for (let i = 0; i < 5 && alias.has(n); i++) n = alias.get(n)!;
		return n;
	};
	const resolve = (s: string): string | undefined => {
		for (const c of refCandidates(s, project.number, pid)) {
			const hit = index.get(c);
			if (hit) {
				const o = owner(hit);
				return hidden.has(o) ? undefined : o;
			}
		}
		return undefined;
	};

	// --- networks, regions, subnetworks
	const networks = all.filter((r) => r.assetType === "compute.googleapis.com/Network");
	const subnetworks = all.filter((r) => r.assetType === "compute.googleapis.com/Subnetwork");
	const networkOfSubnet = new Map<string, string>();
	for (const s of subnetworks) {
		const net = resolve(s.data?.network ?? s.additional?.network ?? "");
		if (net) networkOfSubnet.set(s.name, net);
	}
	/** Subnetwork by network + region + short name (GKE refers to subnets by name). */
	const subnetByName = (net: string | undefined, region: string | undefined, name: string) =>
		subnetworks.find((s) => s.displayName === name && (!region || regionOf(s.location) === region) && (!net || networkOfSubnet.get(s.name) === net))?.name;

	const nodes: MapNode[] = [];
	const ids = new Set<string>();
	const push = (n: MapNode) => {
		if (!ids.has(n.id)) {
			ids.add(n.id);
			nodes.push(n);
		}
	};
	const projectKey = `project:${pid}`;
	push({
		id: projectKey,
		label: `Project: ${project.name && project.name !== pid ? `${project.name} (${pid})` : pid}`,
		kind: "gcp:project",
		container: true,
		style: CONTAINER_STYLES.project,
		data: { project: pid, ...(project.number ? { projectNumber: project.number } : {}), assetType: "cloudresourcemanager.googleapis.com/Project" },
	});
	const dataOf = (r: GcpResource, extra: Record<string, string> = {}): Record<string, string> => ({
		name: r.name,
		assetType: r.assetType,
		location: r.location ?? "",
		project: r.project ?? pid,
		...gcpKeyProps(r),
		...extra,
	});
	for (const n of networks) {
		push({
			id: n.name,
			label: `VPC network ${n.displayName}${n.data?.autoCreateSubnetworks === true ? "  (auto mode)" : ""}`,
			kind: "gcp:network",
			parent: projectKey,
			container: true,
			style: CONTAINER_STYLES.network,
			data: dataOf(n),
		});
	}
	const netRegion = (net: string, region: string) => {
		const id = `${net}|region:${region}`;
		push({ id, label: region, kind: "gcp:region", parent: net, container: true, style: CONTAINER_STYLES.region, data: { region, network: net } });
		return id;
	};
	const projectRegion = (region: string) => {
		const id = `${projectKey}|region:${region}`;
		push({ id, label: `Region ${region}`, kind: "gcp:region", parent: projectKey, container: true, style: CONTAINER_STYLES.region, data: { region, project: pid } });
		return id;
	};
	for (const s of subnetworks) {
		const net = networkOfSubnet.get(s.name);
		const region = regionOf(s.location ?? s.data?.region);
		if (!net || !ids.has(net) || !region) continue;
		push({
			id: s.name,
			label: `${s.displayName}  ${s.data?.ipCidrRange ?? ""}`.trim(),
			kind: "gcp:subnetwork",
			parent: netRegion(net, region),
			container: true,
			style: CONTAINER_STYLES.subnet,
			data: dataOf(s),
		});
	}

	// --- placement
	const placeOf = (r: GcpResource): string => {
		const d = r.data ?? {};
		const region = regionOf(r.location);
		const inNetwork = (netRef: string | undefined, subRef: string | undefined): string | undefined => {
			const sub = subRef ? resolve(subRef) : undefined;
			if (sub && ids.has(sub)) return sub;
			const net = netRef ? resolve(netRef) : undefined;
			if (net && ids.has(net)) return region ? netRegion(net, region) : net;
			return undefined;
		};
		switch (r.assetType) {
			case "compute.googleapis.com/Instance": {
				const nics: any[] = d.networkInterfaces ?? [];
				const subs = [...new Set(nics.map((n) => resolve(n.subnetwork ?? "")).filter((x): x is string => !!x && ids.has(x)))];
				if (subs.length === 1) return subs[0];
				const nets = [...new Set(nics.map((n) => resolve(n.network ?? "")).filter((x): x is string => !!x && ids.has(x)))];
				if (nets.length === 1) return region ? netRegion(nets[0], region) : nets[0];
				break;
			}
			case "container.googleapis.com/Cluster": {
				const net = resolve(d.networkConfig?.network ?? "") ?? (d.network ? resolve(`projects/${pid}/global/networks/${d.network}`) : undefined);
				const sub =
					resolve(d.networkConfig?.subnetwork ?? "") ??
					(d.subnetwork ? subnetByName(net, region, d.subnetwork) ?? resolve(`projects/${pid}/regions/${region}/subnetworks/${d.subnetwork}`) : undefined);
				if (sub && ids.has(sub)) return sub;
				if (net && ids.has(net)) return region ? netRegion(net, region) : net;
				break;
			}
			case "compute.googleapis.com/Firewall":
			case "compute.googleapis.com/FirewallPolicy": {
				const net = resolve(d.network ?? "");
				if (net && ids.has(net)) return net;
				break;
			}
			case "compute.googleapis.com/Router":
			case "compute.googleapis.com/VpnGateway": {
				const p = inNetwork(d.network, undefined);
				if (p) return p;
				break;
			}
			case "vpcaccess.googleapis.com/Connector": {
				// { network: "default" | "projects/p/global/networks/n", subnet: { name, projectId } }
				const netRef = typeof d.network === "string" ? (d.network.includes("/") ? d.network : `projects/${pid}/global/networks/${d.network}`) : undefined;
				const subRef = d.subnet?.name && region ? `projects/${d.subnet.projectId ?? pid}/regions/${region}/subnetworks/${d.subnet.name}` : undefined;
				const p = inNetwork(netRef, subRef);
				if (p) return p;
				break;
			}
			case "compute.googleapis.com/ForwardingRule":
			case "compute.googleapis.com/InstanceGroup":
			case "compute.googleapis.com/NetworkEndpointGroup":
			case "compute.googleapis.com/Address": {
				const p = inNetwork(d.network, d.subnetwork);
				if (p) return p;
				break;
			}
			case "sqladmin.googleapis.com/Instance":
			case "redis.googleapis.com/Instance":
			case "file.googleapis.com/Instance": {
				// Private services access: drawn inside the VPC (region) they are reachable from.
				const netRef = d.settings?.ipConfiguration?.privateNetwork ?? d.authorizedNetwork ?? d.networks?.[0]?.network;
				const net = netRef ? resolve(netRef.includes("/") ? netRef : `projects/${pid}/global/networks/${netRef}`) : undefined;
				if (net && ids.has(net)) return region ? netRegion(net, region) : net;
				break;
			}
		}
		return region ? projectRegion(region) : projectKey;
	};

	const visible = all.filter((r) => !hidden.has(r.name) && !alias.has(r.name) && r.assetType !== "compute.googleapis.com/Network" && r.assetType !== "compute.googleapis.com/Subnetwork");
	const byType: Record<string, number> = {};
	for (const r of visible) {
		byType[r.assetType] = (byType[r.assetType] ?? 0) + 1;
		const stencil = gcpStencil(r.assetType, r.data);
		const parts = folded.get(r.name) ?? [];
		const extra: Record<string, string> = {};
		if (parts.length) {
			const kinds: Record<string, number> = {};
			for (const p of parts) kinds[last(p.assetType)] = (kinds[last(p.assetType)] ?? 0) + 1;
			extra.includes = Object.entries(kinds)
				.map(([k, n]) => `${n} ${k}`)
				.join(", ");
		}
		push({
			id: r.name,
			label: stencil ? r.displayName : `${r.displayName} (${last(r.assetType)})`,
			kind: `gcp:${r.assetType.replace(/\.googleapis\.com\//, ":")}`,
			parent: placeOf(r),
			shape: "icon",
			style: ICON_STYLE(stencil ?? GENERIC_STENCIL),
			width: 48,
			height: 48,
			data: dataOf(r, extra),
		});
	}

	// --- edges
	const edges: MapEdge[] = [];
	const seen = new Set<string>();
	const add = (from: string, to: string, kind: keyof typeof EDGE_STYLES, label?: string, undirected = false) => {
		if (from === to || !ids.has(from) || !ids.has(to)) return;
		const k = undirected ? [from, to].sort().join("|") : `${from}|${to}`;
		if (seen.has(k) || (kind === "reference" && seen.has(`${to}|${from}`))) return;
		seen.add(k);
		edges.push({ from, to, kind, style: EDGE_STYLES[kind], ...(label ? { label } : {}) });
	};
	for (const n of networks) {
		for (const p of n.data?.peerings ?? []) {
			const other = resolve(p.network ?? "");
			if (other) add(n.name, other, "peering", `peering${p.state && p.state !== "ACTIVE" ? ` (${p.state})` : ""}`, true);
		}
	}
	const NET_TYPES = new Set(["compute.googleapis.com/Network", "compute.googleapis.com/Subnetwork"]);
	const typeOf = (name: string) => byName.get(name)?.assetType ?? "";
	// Service URLs (Cloud Run, Functions) for push subscriptions.
	const byUrl: [string, string][] = [];
	for (const r of visible) {
		const url = gcpKeyProps(r).url;
		if (url) byUrl.push([url.replace(/\/$/, ""), r.name]);
	}
	for (const r of all) {
		const from = owner(r.name);
		if (hidden.has(r.name) || hidden.has(from) || !ids.has(from) || NET_TYPES.has(r.assetType)) continue;
		const d = r.data ?? {};
		for (const ref of scan(d)) {
			const to = resolve(ref.value);
			if (!to || to === from || NET_TYPES.has(typeOf(to))) continue;
			const p = ref.path.join(".");
			if (/eventTrigger|topic$|^topic/.test(p) && typeOf(to) === "pubsub.googleapis.com/Topic") add(to, from, "flow", /eventTrigger/.test(p) ? "trigger" : "messages");
			else if (/vpc-access-connector|vpcConnector|vpcAccess/.test(p)) add(from, to, "reference", "VPC connector");
			else add(from, to, "reference");
		}
		// Cloud Run → Cloud SQL through the connector annotation (project:region:instance).
		const sqlAnn = d.spec?.template?.metadata?.annotations?.["run.googleapis.com/cloudsql-instances"] ?? (d.template?.volumes ?? []).flatMap((v: any) => v.cloudSqlInstance?.instances ?? []).join(",");
		for (const conn of String(sqlAnn ?? "").split(",").filter(Boolean)) {
			const [p, , inst] = conn.trim().split(":");
			const to = resolve(`projects/${p}/instances/${inst}`);
			if (to) add(from, to, "flow", "Cloud SQL");
		}
		// Push subscriptions → the service behind the endpoint.
		const push = d.pushConfig?.pushEndpoint;
		if (typeof push === "string") {
			const hit = byUrl.find(([u]) => push.startsWith(u));
			if (hit) add(from, hit[1], "flow", "push");
		}
	}
	// Firewall rules → the instances they open (by target tags).
	const instances = visible.filter((r) => r.assetType === "compute.googleapis.com/Instance");
	for (const fw of visible.filter((r) => r.assetType === "compute.googleapis.com/Firewall")) {
		const d = fw.data ?? {};
		if (d.direction === "EGRESS" || d.disabled || !(d.allowed ?? []).length) continue;
		const tags: string[] = d.targetTags ?? [];
		if (!tags.length) continue;
		const net = resolve(d.network ?? "");
		const open = (d.sourceRanges ?? []).includes("0.0.0.0/0");
		const ports = (d.allowed ?? []).map((x: any) => `${x.IPProtocol}${x.ports ? `:${x.ports.join(",")}` : ""}`).join(" ");
		for (const i of instances) {
			if (!(i.networkTags ?? []).some((t) => tags.includes(t))) continue;
			const nets = (i.data?.networkInterfaces ?? []).map((n: any) => resolve(n.network ?? ""));
			if (net && nets.length && !nets.includes(net)) continue;
			add(fw.name, i.name, "firewall", `${open ? "internet " : ""}${ports}`);
		}
	}

	const regions = nodes.filter((n) => n.kind === "gcp:region").length;
	const subnetCount = nodes.filter((n) => n.kind === "gcp:subnetwork").length;
	const stats = { resources: all.length, drawn: visible.length, networks: networks.length, subnets: subnetCount, regions, edges: edges.length, byType, hidden: hiddenCount };
	const legend = [
		`Google Cloud project ${pid}: ${visible.length} resource(s), ${networks.length} VPC network(s), ${subnetCount} subnetwork(s). Read from ${inv.source === "asset-inventory" ? "Cloud Asset Inventory" : "gcloud list commands"}${inv.collectedAt ? ` on ${inv.collectedAt}` : ""}.`,
		"VMs, GKE clusters and internal load balancers sit in their subnetwork; Cloud SQL / Memorystore with private IP in the VPC they peer with; serverless and other regional services in their region; global services in the project. GKE nodes, node pools and attached disks are folded into their cluster / VM.",
		"Blue: data flow (Pub/Sub, push, Cloud SQL). Red dashed: firewall rules → the instances they open. Green: VPC peering. Grey: other references.",
	];
	const graph: MapGraph = { title: `Google Cloud · ${pid}`, nodes, edges, direction: "down", legend };
	return { graph, stats, facts: gcpFacts(inv, nodes, edges, stats) };
}

function gcpFacts(inv: GcpInventory, nodes: MapNode[], edges: MapEdge[], stats: Built["stats"]): string {
	const lines: string[] = [];
	lines.push(`# Google Cloud project ${inv.project.id}${inv.project.name ? ` (${inv.project.name})` : ""}`);
	lines.push(`Source: ${inv.source === "asset-inventory" ? "Cloud Asset Inventory (gcloud asset search-all-resources)" : "gcloud list commands"}${inv.collectedAt ? `, ${inv.collectedAt}` : ""}. ${stats.drawn} resources drawn of ${stats.resources} collected.`);
	lines.push(
		`Counts by type: ${Object.entries(stats.byType)
			.sort((a, b) => b[1] - a[1])
			.map(([t, n]) => `${t} ${n}`)
			.join(", ")}`
	);
	if (Object.keys(stats.hidden).length)
		lines.push(
			`Not drawn: ${Object.entries(stats.hidden)
				.map(([t, n]) => `${t} ${n}`)
				.join(", ")}`
		);
	const children = new Map<string, MapNode[]>();
	for (const n of nodes) {
		if (!n.parent) continue;
		if (!children.has(n.parent)) children.set(n.parent, []);
		children.get(n.parent)!.push(n);
	}
	const describe = (n: MapNode) => {
		const d = n.data ?? {};
		const props = Object.entries(d)
			.filter(([k]) => !["name", "assetType", "project", "location", "region", "network"].includes(k))
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
		return `${d.assetType ?? n.kind} **${n.label}**${d.location ? ` [${d.location}]` : ""}${d.name ? ` name=${d.name}` : ""}${props ? ` | ${props}` : ""}`;
	};
	const walk = (id: string, depth: number) => {
		for (const n of children.get(id) ?? []) {
			lines.push(`${"  ".repeat(depth)}- ${n.kind === "gcp:region" ? `Region ${n.data?.region}` : describe(n)}`);
			walk(n.id, depth + 1);
		}
	};
	walk(`project:${inv.project.id}`, 0);
	const label = new Map(nodes.map((n) => [n.id, n.label]));
	if (edges.length) {
		lines.push("", "## Connections (from → to)");
		for (const e of edges.slice(0, 400)) lines.push(`- ${label.get(e.from)} → ${label.get(e.to)}${e.label ? ` (${e.label})` : ""} [${e.kind}]`);
	}
	return lines.join("\n");
}

// ----- normalizing the CLI's JSON

/** One Cloud Asset `search-all-resources` result. */
export function fromAsset(a: any, projectId: string): GcpResource | undefined {
	if (!a?.name || !a?.assetType) return undefined;
	return {
		name: a.name,
		assetType: a.assetType,
		displayName: a.displayName || last(a.name),
		location: a.location,
		project: projectId,
		state: a.state,
		labels: a.labels,
		networkTags: a.networkTags,
		data: a.versionedResources?.[0]?.resource,
		additional: a.additionalAttributes,
	};
}

/** Per-service list output → resources (used when Cloud Asset Inventory is not available). */
export const FROM_LIST: Record<string, (x: any, projectId: string) => GcpResource | undefined> = {
	instances: (x, p) => compute(x, p, "compute.googleapis.com/Instance", { state: x.status, networkTags: x.tags?.items, labels: x.labels }),
	networks: (x, p) => compute(x, p, "compute.googleapis.com/Network", { location: "global" }),
	subnetworks: (x, p) => compute(x, p, "compute.googleapis.com/Subnetwork"),
	firewalls: (x, p) => compute(x, p, "compute.googleapis.com/Firewall", { location: "global" }),
	forwardingRules: (x, p) => compute(x, p, x.region ? "compute.googleapis.com/ForwardingRule" : "compute.googleapis.com/GlobalForwardingRule"),
	addresses: (x, p) => compute(x, p, x.region ? "compute.googleapis.com/Address" : "compute.googleapis.com/GlobalAddress", { state: x.status }),
	routers: (x, p) => compute(x, p, "compute.googleapis.com/Router"),
	clusters: (x, p) => {
		const name = fullNameFromUrl(x.selfLink) ?? `//container.googleapis.com/projects/${p}/locations/${x.location}/clusters/${x.name}`;
		return { name, assetType: "container.googleapis.com/Cluster", displayName: x.name, location: x.location ?? x.zone, project: p, state: x.status, labels: x.resourceLabels, data: x };
	},
	runServices: (x, p) => {
		const loc = x.metadata?.labels?.["cloud.googleapis.com/location"] ?? last(x.name?.split("/locations/")[1]?.split("/")[0]);
		const short = x.metadata?.name ?? last(x.name);
		if (!short) return undefined;
		return { name: `//run.googleapis.com/projects/${p}/locations/${loc}/services/${short}`, assetType: "run.googleapis.com/Service", displayName: short, location: loc, project: p, labels: x.metadata?.labels, data: x };
	},
	functions: (x, p) => {
		if (!x.name) return undefined;
		const rel = String(x.name).replace(/^projects\/[^/]+/, `projects/${p}`);
		const loc = rel.split("/locations/")[1]?.split("/")[0];
		return {
			name: `//cloudfunctions.googleapis.com/${rel}`,
			assetType: x.environment === "GEN_2" || x.serviceConfig ? "cloudfunctions.googleapis.com/Function" : "cloudfunctions.googleapis.com/CloudFunction",
			displayName: last(rel),
			location: loc,
			project: p,
			state: x.state ?? x.status,
			labels: x.labels,
			data: x,
		};
	},
	sqlInstances: (x, p) => ({
		name: `//cloudsql.googleapis.com/projects/${x.project ?? p}/instances/${x.name}`,
		assetType: "sqladmin.googleapis.com/Instance",
		displayName: x.name,
		location: x.region ?? x.gceZone,
		project: p,
		state: x.state,
		labels: x.settings?.userLabels,
		data: x,
	}),
	buckets: (x, p) => {
		const name = x.name ?? String(x.storage_url ?? "").replace(/^gs:\/\//, "").replace(/\/$/, "");
		if (!name) return undefined;
		return { name: `//storage.googleapis.com/${name}`, assetType: "storage.googleapis.com/Bucket", displayName: name, location: String(x.location ?? "").toLowerCase(), project: p, labels: x.labels ?? x.default_labels, data: x };
	},
	topics: (x, p) => (x.name ? { name: `//pubsub.googleapis.com/${x.name}`, assetType: "pubsub.googleapis.com/Topic", displayName: last(x.name), location: "global", project: p, labels: x.labels, data: x } : undefined),
	subscriptions: (x, p) =>
		x.name ? { name: `//pubsub.googleapis.com/${x.name}`, assetType: "pubsub.googleapis.com/Subscription", displayName: last(x.name), location: "global", project: p, state: x.state, labels: x.labels, data: x } : undefined,
};

function compute(x: any, p: string, assetType: string, extra: Partial<GcpResource> = {}): GcpResource | undefined {
	const name = fullNameFromUrl(x?.selfLink);
	if (!name) return undefined;
	return {
		name,
		assetType,
		displayName: x.name,
		location: last(x.zone) || last(x.region) || "global",
		project: p,
		labels: x.labels,
		data: x,
		...extra,
	};
}
