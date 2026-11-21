/**
 * Turns an Azure inventory (from Resource Graph or the az CLI's list commands) into
 * a map: subscription › resource groups › virtual networks › subnets › resources,
 * with edges found by scanning every resource's properties for the ARM ids of the
 * others. Pure (no CLI calls), so it is unit-tested with recorded JSON.
 */
import type { CheckCoverage, MapEdge, MapFinding, MapGraph, MapNode } from "../../../types";
import { findingsMarkdown } from "../findings";
import { azureHealth } from "./health";
import { azureIcon, CONTAINER_STYLES, EDGE_STYLES, GENERIC_ICON, ICON_STYLE } from "./icons";

export interface AzResource {
	id: string;
	name: string;
	type: string;
	location?: string;
	resourceGroup?: string;
	subscriptionId?: string;
	kind?: string;
	sku?: any;
	tags?: Record<string, string>;
	identity?: any;
	managedBy?: string;
	zones?: string[];
	/** ARM properties; for the CLI's flattened output, the object minus its envelope. */
	properties?: any;
}

export interface AzResourceGroup {
	id?: string;
	name: string;
	location?: string;
}

export interface AzInventory {
	subscription: { id: string; name: string; tenantId?: string };
	resourceGroups: AzResourceGroup[];
	resources: AzResource[];
	source: "resource-graph" | "cli";
	/** Draw VNets, subnets and the network plumbing (NICs, public IPs, NSGs, private endpoints...). */
	includeNetwork: boolean;
	/** Only these resource groups (lowercase); VNets elsewhere that they attach to are drawn too. */
	resourceGroupFilter?: string[];
	collectedAt?: string;
}

const ENVELOPE = new Set([
	"id",
	"name",
	"type",
	"location",
	"resourceGroup",
	"subscriptionId",
	"kind",
	"sku",
	"tags",
	"identity",
	"managedBy",
	"etag",
	"zones",
	"extendedLocation",
	"plan",
	"systemData",
	"tenantId",
	"apiVersion",
	"properties",
]);

/** ARM id parts: /subscriptions/{s}/resourceGroups/{rg}/providers/{ns}/{type}/{name}/... */
export function parseArmId(id: string): { subscriptionId?: string; resourceGroup?: string } {
	const m = /^\/subscriptions\/([^/]+)(?:\/resourcegroups\/([^/]+))?/i.exec(id);
	return { subscriptionId: m?.[1], resourceGroup: m?.[2] };
}

/** One resource from Resource Graph, `az resource list` or a service's `list` command (flattened). */
export function normalizeResource(raw: any): AzResource | undefined {
	if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") return undefined;
	let properties = raw.properties;
	if (properties === undefined || properties === null) {
		properties = {};
		for (const [k, v] of Object.entries(raw)) if (!ENVELOPE.has(k)) properties[k] = v;
	}
	const ids = parseArmId(raw.id);
	return {
		id: raw.id,
		name: String(raw.name ?? raw.id.split("/").pop()),
		type: raw.type,
		location: raw.location ?? undefined,
		resourceGroup: raw.resourceGroup ?? ids.resourceGroup,
		subscriptionId: raw.subscriptionId ?? ids.subscriptionId,
		kind: raw.kind ?? undefined,
		sku: raw.sku ?? undefined,
		tags: raw.tags ?? undefined,
		identity: raw.identity ?? undefined,
		managedBy: raw.managedBy ?? undefined,
		zones: Array.isArray(raw.zones) ? raw.zones : undefined,
		properties,
	};
}

/** Merges detail (from a service's list command) into the base resources, by id. */
export function mergeResources(base: AzResource[], detail: AzResource[]): AzResource[] {
	const byId = new Map(base.map((r) => [r.id.toLowerCase(), { ...r }]));
	for (const d of detail) {
		const k = d.id.toLowerCase();
		const b = byId.get(k);
		if (!b) byId.set(k, d);
		else
			byId.set(k, {
				...b,
				properties: { ...(b.properties ?? {}), ...(d.properties ?? {}) },
				kind: b.kind ?? d.kind,
				sku: b.sku ?? d.sku,
				identity: b.identity ?? d.identity,
				managedBy: b.managedBy ?? d.managedBy,
				zones: b.zones ?? d.zones,
			});
	}
	return [...byId.values()];
}

/** Properties live under `properties` in ARM JSON and at the top level in the CLI's flattened output. */
const P = (o: any): any => (o && typeof o === "object" ? o.properties ?? o : {});
const L = (s: string) => s.toLowerCase();
const ARM_ID = /\/subscriptions\/[0-9a-f-]{36}\/resourcegroups\/[^"'\s,;)]+/gi;
const SUBNET_IN = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.network\/virtualnetworks\/[^/]+\/subnets\/[^/]+)/i;

/** Property paths whose ids are network access rules (service endpoints), not attachments. */
const ACL_PATH = /virtualnetworkrules|networkacls|networkruleset|firewallrules|iprules|allowedsubnets/i;
/** Property names holding back-references (the other resource points here); edges are reversed. */
const BACKREF = new Set(
	["subnets", "networkinterfaces", "ipconfiguration", "ipconfigurations", "privateendpointconnections", "virtualnetworklinks", "associatedresources", "connecteddevices", "managedby", "virtualmachines", "loadbalancerbackendaddresses", "backendipconfigurations"].map(L)
);
/** Network plumbing hidden when networking detail is off. */
const PLUMBING = new Set(
	[
		"microsoft.network/networkinterfaces",
		"microsoft.network/publicipaddresses",
		"microsoft.network/networksecuritygroups",
		"microsoft.network/applicationsecuritygroups",
		"microsoft.network/routetables",
		"microsoft.network/privateendpoints",
		"microsoft.network/privatednszones",
		"microsoft.network/privatednszones/virtualnetworklinks",
		"microsoft.network/networkwatchers",
		"microsoft.network/virtualnetworks",
		"microsoft.network/serviceendpointpolicies",
	].map(L)
);

interface Ref {
	id: string;
	path: string[];
}

/** Every ARM id inside a JSON value (values and object keys), with the property path where it was found. */
export function scanRefs(value: any, path: string[] = [], out: Ref[] = [], depth = 0): Ref[] {
	if (depth > 24 || value === null || value === undefined) return out;
	if (typeof value === "string") {
		if (value.length < 4000) for (const m of value.matchAll(ARM_ID)) out.push({ id: m[0], path });
	} else if (Array.isArray(value)) {
		for (const v of value.slice(0, 500)) scanRefs(v, path, out, depth + 1);
	} else if (typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (/^\/subscriptions\//i.test(k)) out.push({ id: k, path: [...path, k] });
			scanRefs(v, [...path, k], out, depth + 1);
		}
	}
	return out;
}

/** Candidate resource ids for an id, longest first: …/a/x/b/y → …/a/x/b/y, …/a/x. */
function prefixes(id: string): string[] {
	const parts = id.replace(/\/+$/, "").split("/");
	const p = parts.findIndex((s) => L(s) === "providers");
	if (p < 0) return [L(id)];
	const out: string[] = [];
	// provider namespace at p+1, then type/name pairs.
	for (let end = parts.length; end >= p + 4; end -= 2) {
		// A nested provider segment (…/providers/Microsoft.Insights/…) is not a pair boundary.
		out.push(L(parts.slice(0, end).join("/")));
	}
	return out;
}

const shortType = (type: string) => type.split("/").slice(1).join("/");

function nameOf(id: string): string {
	return id.split("/").pop() ?? id;
}

function sizeOf(v: any): number {
	return Array.isArray(v) ? v.length : 0;
}

/** Scalars only, never anything that looks like a secret. */
const SECRET_KEY = /(password|secret|connectionstring|accesskey|accountkey|primarykey|secondarykey|sastoken|\bsas\b|token|credential|privatekey|certificatedata|adminkey|querykey|masterkey)/i;
export function safeScalar(key: string, v: any): string | undefined {
	if (SECRET_KEY.test(key)) return undefined;
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return /AccountKey=|SharedAccessKey=|sig=|password=/i.test(v) ? undefined : v.slice(0, 200);
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return undefined;
}

function get(o: any, path: string): any {
	let cur = o;
	for (const k of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = cur[k];
	}
	return cur;
}

/** A compact summary of NSG rules: the ones that allow inbound traffic matter most for a review. */
export function nsgRules(nsg: AzResource): string[] {
	const rules: any[] = P(nsg).securityRules ?? [];
	return rules
		.map((r) => P(r))
		.filter((r) => r && r.access && r.direction)
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
		.slice(0, 30)
		.map((r) => {
			const ports = r.destinationPortRange ?? (r.destinationPortRanges ?? []).join(",");
			const from = r.sourceAddressPrefix ?? (r.sourceAddressPrefixes ?? []).join(",") ?? "";
			return `${r.access} ${String(r.direction).slice(0, 3).toLowerCase()} ${r.protocol ?? "*"} ${ports || "*"} from ${from || "*"} (p${r.priority ?? "?"})`;
		});
}

/** Key, non-secret facts about a resource, for the agent and the shape data. */
export function keyProps(r: AzResource): Record<string, string> {
	const t = L(r.type);
	const p = P(r);
	const out: Record<string, string> = {};
	const put = (k: string, v: any) => {
		const s = safeScalar(k, v);
		if (s !== undefined && s !== "") out[k] = s;
	};
	if (r.kind) put("kind", r.kind);
	if (r.sku) put("sku", typeof r.sku === "string" ? r.sku : [r.sku.name, r.sku.tier].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" / "));
	if (r.zones?.length) put("zones", r.zones.join(","));
	for (const k of ["publicNetworkAccess", "minimumTlsVersion", "minimalTlsVersion", "minTlsVersion", "httpsOnly", "disableLocalAuth", "provisioningState", "state"]) put(k, p[k]);
	const paths: Record<string, string[]> = {
		"microsoft.compute/virtualmachines": ["hardwareProfile.vmSize", "storageProfile.osDisk.osType", "storageProfile.imageReference.offer", "storageProfile.imageReference.sku", "priority"],
		"microsoft.compute/virtualmachinescalesets": ["sku.capacity", "virtualMachineProfile.storageProfile.osDisk.osType", "orchestrationMode"],
		"microsoft.containerservice/managedclusters": [
			"kubernetesVersion",
			"apiServerAccessProfile.enablePrivateCluster",
			"networkProfile.networkPlugin",
			"networkProfile.networkPolicy",
			"networkProfile.outboundType",
			"enableRBAC",
			"aadProfile.managed",
			"disableLocalAccounts",
			"nodeResourceGroup",
		],
		"microsoft.storage/storageaccounts": ["allowBlobPublicAccess", "supportsHttpsTrafficOnly", "networkAcls.defaultAction", "isHnsEnabled", "allowSharedKeyAccess", "accessTier"],
		"microsoft.keyvault/vaults": ["enableRbacAuthorization", "enableSoftDelete", "enablePurgeProtection", "networkAcls.defaultAction"],
		"microsoft.sql/servers": ["version", "administrators.azureADOnlyAuthentication"],
		"microsoft.sql/servers/databases": ["currentServiceObjectiveName", "zoneRedundant", "requestedBackupStorageRedundancy"],
		"microsoft.web/sites": ["defaultHostName", "siteConfig.minTlsVersion", "siteConfig.ftpsState", "clientCertEnabled", "vnetRouteAllEnabled"],
		"microsoft.web/serverfarms": ["numberOfWorkers", "reserved", "zoneRedundant"],
		"microsoft.network/publicipaddresses": ["ipAddress", "publicIPAllocationMethod", "dnsSettings.fqdn"],
		"microsoft.network/applicationgateways": ["sku.tier", "sku.capacity", "autoscaleConfiguration.minCapacity"],
		"microsoft.network/azurefirewalls": ["sku.tier", "threatIntelMode"],
		"microsoft.network/loadbalancers": [],
		"microsoft.network/virtualnetworkgateways": ["gatewayType", "vpnType", "sku.name", "activeActive"],
		"microsoft.documentdb/databaseaccounts": ["isVirtualNetworkFilterEnabled", "enableAutomaticFailover", "enableMultipleWriteLocations"],
		"microsoft.dbforpostgresql/flexibleservers": ["version", "network.publicNetworkAccess", "highAvailability.mode", "storage.storageSizeGB"],
		"microsoft.dbformysql/flexibleservers": ["version", "network.publicNetworkAccess", "highAvailability.mode"],
		"microsoft.cache/redis": ["enableNonSslPort", "redisVersion"],
		"microsoft.containerregistry/registries": ["adminUserEnabled", "anonymousPullEnabled"],
		"microsoft.apimanagement/service": ["virtualNetworkType", "gatewayUrl"],
		"microsoft.app/containerapps": ["configuration.ingress.external", "configuration.ingress.fqdn"],
		"microsoft.app/managedenvironments": ["vnetConfiguration.internal"],
		"microsoft.cognitiveservices/accounts": ["endpoint"],
		"microsoft.network/privateendpoints": [],
	};
	for (const path of paths[t] ?? []) {
		const v = path.startsWith("sku.") ? get(r, path) ?? get(p, path) : get(p, path);
		put(path.split(".").pop()!, v);
	}
	if (t === "microsoft.containerservice/managedclusters") {
		const pools: any[] = p.agentPoolProfiles ?? [];
		if (pools.length) put("nodePools", pools.map((a) => `${a.name}: ${a.count ?? "?"}× ${a.vmSize ?? "?"}${a.mode ? ` (${a.mode})` : ""}`).join("; "));
		const ranges = sizeOf(p.apiServerAccessProfile?.authorizedIPRanges);
		if (ranges) put("authorizedIPRanges", ranges);
	}
	if (t === "microsoft.network/networksecuritygroups") put("rules", nsgRules(r).join("; "));
	if (t === "microsoft.network/applicationgateways") {
		const waf = p.webApplicationFirewallConfiguration;
		put("waf", waf?.enabled ? `${waf.firewallMode ?? "on"}` : p.firewallPolicy?.id ? "policy" : "none");
	}
	if (t === "microsoft.network/privateendpoints") {
		const conns = [...(p.privateLinkServiceConnections ?? []), ...(p.manualPrivateLinkServiceConnections ?? [])];
		put("groupIds", conns.flatMap((c) => P(c).groupIds ?? []).join(","));
	}
	if (p.privateEndpointConnections) put("privateEndpoints", sizeOf(p.privateEndpointConnections));
	return out;
}

interface Built {
	graph: MapGraph;
	stats: { resources: number; drawn: number; resourceGroups: number; vnets: number; subnets: number; edges: number; byType: Record<string, number> };
	/** Markdown inventory for the agent. */
	facts: string;
	/** Health findings on the drawn shapes. */
	findings: MapFinding[];
	/** The checks that ran (those with nothing to examine are left out, except the NSG rules). */
	checked: CheckCoverage[];
}

/** Builds the map, the facts and counts from an inventory. */
export function buildAzureGraph(inv: AzInventory): Built {
	const sub = inv.subscription;
	const subKey = L(`/subscriptions/${sub.id}`);
	const filter = inv.resourceGroupFilter?.length ? new Set(inv.resourceGroupFilter.map(L)) : undefined;
	const all = inv.resources.filter((r) => r && r.id && r.type);
	const byId = new Map<string, AzResource>(all.map((r) => [L(r.id), r]));
	const typeOf = (key: string) => L(byId.get(key)?.type ?? "");

	// --- resources that are folded into others or not drawn
	const alias = new Map<string, string>(); // key → owner key
	const hidden = new Set<string>();
	const folded = new Map<string, AzResource[]>(); // owner key → folded resources (NICs, disks, extensions)
	const fold = (key: string, owner: string) => {
		alias.set(key, owner);
		if (!folded.has(owner)) folded.set(owner, []);
		folded.get(owner)!.push(byId.get(key)!);
	};
	const dnsLinks: { zone: string; vnet: string }[] = [];
	for (const r of all) {
		const key = L(r.id);
		const t = L(r.type);
		const p = P(r);
		if (t === "microsoft.network/networkinterfaces") {
			const owner = [p.virtualMachine?.id, p.privateEndpoint?.id].find((id) => typeof id === "string" && byId.has(L(id)));
			if (owner) fold(key, L(owner));
		} else if (t === "microsoft.compute/disks" && r.managedBy && byId.has(L(r.managedBy))) {
			fold(key, L(r.managedBy));
		} else if (t === "microsoft.compute/virtualmachines/extensions" || t === "microsoft.compute/virtualmachinescalesets/extensions") {
			const parent = prefixes(r.id)[1];
			if (parent && byId.has(parent)) fold(key, parent);
			else hidden.add(key);
		} else if (t === "microsoft.network/privatednszones/virtualnetworklinks") {
			hidden.add(key);
			const vnet = p.virtualNetwork?.id;
			const zone = prefixes(r.id)[1];
			if (typeof vnet === "string" && zone) dnsLinks.push({ zone, vnet: L(vnet) });
		} else if (t === "microsoft.sql/servers/databases" && L(r.name) === "master") {
			hidden.add(key);
		}
		if (!inv.includeNetwork && PLUMBING.has(t) && !alias.has(key)) hidden.add(key);
	}
	const owner = (key: string): string => {
		let k = key;
		for (let i = 0; i < 6 && alias.has(k); i++) k = alias.get(k)!;
		return k;
	};

	// --- virtual networks and subnets
	interface SubnetInfo {
		key: string;
		vnet: string;
		name: string;
		prefix: string;
		raw: any;
	}
	const subnets = new Map<string, SubnetInfo>();
	const vnets = all.filter((r) => L(r.type) === "microsoft.network/virtualnetworks");
	if (inv.includeNetwork) {
		for (const v of vnets) {
			for (const s of P(v).subnets ?? []) {
				const id = typeof s?.id === "string" ? s.id : `${v.id}/subnets/${s?.name}`;
				const sp = P(s);
				subnets.set(L(id), {
					key: L(id),
					vnet: L(v.id),
					name: s?.name ?? nameOf(id),
					prefix: sp.addressPrefix ?? (sp.addressPrefixes ?? []).join(", "),
					raw: s,
				});
			}
		}
	}

	/** Resolves an id found in properties to a drawn thing: a subnet, or a (folded) resource. */
	const resolve = (id: string): { subnet?: string; res?: string } | undefined => {
		const sm = SUBNET_IN.exec(id);
		if (sm && subnets.has(L(sm[1]))) return { subnet: L(sm[1]) };
		for (const cand of prefixes(id)) {
			if (byId.has(cand)) {
				const o = owner(cand);
				return hidden.has(o) ? undefined : { res: o };
			}
		}
		return undefined;
	};

	// --- placement: which subnet(s) each resource is attached to
	const attached = new Map<string, Set<string>>();
	const attach = (res: string, subnet: string) => {
		if (!attached.has(res)) attached.set(res, new Set());
		attached.get(res)!.add(subnet);
	};
	const NOT_PLACED = new Set(
		[
			"microsoft.network/virtualnetworks",
			"microsoft.network/networksecuritygroups",
			"microsoft.network/routetables",
			"microsoft.network/natgateways",
			"microsoft.network/serviceendpointpolicies",
			"microsoft.network/networkwatchers",
			// A plan's service association link marks VNet integration; the apps are drawn in the subnet.
			"microsoft.web/serverfarms",
		].map(L)
	);
	for (const s of subnets.values()) {
		const sp = P(s.raw);
		const back = [
			...(sp.ipConfigurations ?? []).map((x: any) => x?.id),
			...(sp.privateEndpoints ?? []).map((x: any) => x?.id),
			...(sp.applicationGatewayIPConfigurations ?? []).map((x: any) => x?.id),
			...(sp.ipConfigurationProfiles ?? []).map((x: any) => x?.id),
			...(sp.serviceAssociationLinks ?? []).map((x: any) => P(x).link),
		].filter((x): x is string => typeof x === "string");
		for (const id of back) {
			const t = resolve(id);
			if (t?.res && !NOT_PLACED.has(typeOf(t.res))) attach(t.res, s.key);
		}
	}
	const aclEdges: { subnet: string; res: string }[] = [];
	const refsOf = new Map<string, Ref[]>();
	for (const r of all) {
		const key = L(r.id);
		const o = owner(key);
		if (hidden.has(key) || hidden.has(o)) continue;
		const refs = scanRefs({ properties: P(r), identity: r.identity });
		if (!refsOf.has(o)) refsOf.set(o, []);
		refsOf.get(o)!.push(...refs);
		if (NOT_PLACED.has(L(r.type))) continue;
		for (const ref of refs) {
			const sm = SUBNET_IN.exec(ref.id);
			if (!sm || !subnets.has(L(sm[1]))) continue;
			if (ref.path.some((k) => ACL_PATH.test(k))) aclEdges.push({ subnet: L(sm[1]), res: o });
			else attach(o, L(sm[1]));
		}
	}

	// --- which resources and groups are drawn
	const inFilter = (r: AzResource) => !filter || filter.has(L(r.resourceGroup ?? ""));
	const visible = all.filter((r) => {
		const key = L(r.id);
		return !hidden.has(key) && !alias.has(key) && inFilter(r) && L(r.type) !== "microsoft.network/virtualnetworks";
	});
	const visibleKeys = new Set(visible.map((r) => L(r.id)));
	// VNets: in the selected groups, or attached to by a drawn resource.
	const usedVnets = new Set<string>();
	if (inv.includeNetwork) {
		for (const v of vnets) if (inFilter(v)) usedVnets.add(L(v.id));
		for (const [res, subs] of attached) if (visibleKeys.has(res)) for (const s of subs) usedVnets.add(subnets.get(s)!.vnet);
	}

	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const nodeIds = new Set<string>();
	const push = (n: MapNode) => {
		if (nodeIds.has(n.id)) return;
		nodeIds.add(n.id);
		nodes.push(n);
	};
	push({
		id: subKey,
		label: `Subscription: ${sub.name || sub.id}`,
		kind: "azure:subscription",
		container: true,
		style: CONTAINER_STYLES.subscription,
		data: { subscriptionId: sub.id, ...(sub.tenantId ? { tenantId: sub.tenantId } : {}), type: "Microsoft.Resources/subscriptions" },
	});
	const rgKey = (name: string) => L(`/subscriptions/${sub.id}/resourceGroups/${name}`);
	const rgInfo = new Map(inv.resourceGroups.map((g) => [L(g.name), g]));
	const ensureRg = (name: string | undefined): string => {
		if (!name) return subKey;
		const key = rgKey(name);
		if (!nodeIds.has(key)) {
			const g = rgInfo.get(L(name));
			push({
				id: key,
				label: `${g?.name ?? name}${g?.location ? `  (${g.location})` : ""}`,
				kind: "azure:resource-group",
				parent: subKey,
				container: true,
				style: CONTAINER_STYLES.resourceGroup,
				data: { resourceId: g?.id ?? `/subscriptions/${sub.id}/resourceGroups/${name}`, type: "Microsoft.Resources/resourceGroups", resourceGroup: g?.name ?? name, subscriptionId: sub.id, ...(g?.location ? { location: g.location } : {}) },
			});
		}
		return key;
	};
	for (const g of inv.resourceGroups) if (!filter || filter.has(L(g.name))) ensureRg(g.name);

	const nsgName = (id: any) => (typeof id === "string" ? nameOf(id) : undefined);
	for (const v of vnets) {
		const key = L(v.id);
		if (!usedVnets.has(key)) continue;
		const vp = P(v);
		const prefixesText = (vp.addressSpace?.addressPrefixes ?? []).join(", ");
		push({
			id: key,
			label: `${v.name}${prefixesText ? `  ${prefixesText}` : ""}`,
			kind: "azure:vnet",
			parent: ensureRg(v.resourceGroup),
			container: true,
			style: CONTAINER_STYLES.vnet,
			data: { resourceId: v.id, type: v.type, location: v.location ?? "", resourceGroup: v.resourceGroup ?? "", subscriptionId: v.subscriptionId ?? sub.id, addressSpace: prefixesText },
		});
		for (const s of subnets.values()) {
			if (s.vnet !== key) continue;
			const sp = P(s.raw);
			const nsg = nsgName(sp.networkSecurityGroup?.id);
			const rt = nsgName(sp.routeTable?.id);
			const nat = nsgName(sp.natGateway?.id);
			const delegations = (sp.delegations ?? []).map((d: any) => P(d).serviceName).filter(Boolean);
			const extra = [nsg ? `NSG ${nsg}` : "", rt ? `UDR ${rt}` : "", nat ? `NAT ${nat}` : ""].filter(Boolean).join(" · ");
			push({
				id: s.key,
				label: `${s.name}  ${s.prefix}${extra ? `  · ${extra}` : ""}`,
				kind: "azure:subnet",
				parent: key,
				container: true,
				style: CONTAINER_STYLES.subnet,
				data: {
					resourceId: s.raw?.id ?? s.key,
					type: "Microsoft.Network/virtualNetworks/subnets",
					resourceGroup: v.resourceGroup ?? "",
					subscriptionId: v.subscriptionId ?? sub.id,
					location: v.location ?? "",
					addressPrefix: s.prefix,
					...(sp.networkSecurityGroup?.id ? { networkSecurityGroup: sp.networkSecurityGroup.id } : {}),
					...(sp.routeTable?.id ? { routeTable: sp.routeTable.id } : {}),
					...(sp.natGateway?.id ? { natGateway: sp.natGateway.id } : {}),
					...(delegations.length ? { delegations: delegations.join(",") } : {}),
					...(sp.privateEndpointNetworkPolicies ? { privateEndpointNetworkPolicies: String(sp.privateEndpointNetworkPolicies) } : {}),
				},
			});
		}
	}

	// --- resources
	const placement = (key: string, r: AzResource): string => {
		const subs = [...(attached.get(key) ?? [])].filter((s) => nodeIds.has(s));
		if (subs.length === 1) return subs[0];
		if (subs.length > 1) {
			const vs = new Set(subs.map((s) => subnets.get(s)!.vnet));
			if (vs.size === 1) return [...vs][0];
		}
		return ensureRg(r.resourceGroup);
	};
	/** PIP id → address, for VM labels/data. */
	const pipAddress = (id: string) => P(byId.get(L(id))).ipAddress as string | undefined;
	const byType: Record<string, number> = {};
	const childOf = new Map<string, string>();
	for (const r of visible) {
		const key = L(r.id);
		const segs = prefixes(r.id);
		if (segs.length > 1 && byId.has(segs[1]) && !hidden.has(segs[1])) childOf.set(key, segs[1]);
	}
	const drawOrder = [...visible].sort((a, b) => (childOf.has(L(a.id)) ? 1 : 0) - (childOf.has(L(b.id)) ? 1 : 0));
	const parentOf = new Map<string, string>();
	for (const r of drawOrder) {
		const key = L(r.id);
		byType[r.type] = (byType[r.type] ?? 0) + 1;
		const icon = azureIcon(r.type, r.kind, typeof r.sku === "object" ? r.sku?.name : r.sku);
		const parent = childOf.has(key) && parentOf.has(childOf.get(key)!) ? parentOf.get(childOf.get(key)!)! : placement(key, r);
		parentOf.set(key, parent);
		const data: Record<string, string> = {
			resourceId: r.id,
			type: r.type,
			location: r.location ?? "",
			resourceGroup: r.resourceGroup ?? "",
			subscriptionId: r.subscriptionId ?? sub.id,
			...keyProps(r),
		};
		// Folded NICs and disks: their addresses and names live on the owner.
		const parts = folded.get(key) ?? [];
		const privateIps: string[] = [];
		const publicIps: string[] = [];
		for (const f of parts) {
			if (L(f.type) !== "microsoft.network/networkinterfaces") continue;
			for (const c of P(f).ipConfigurations ?? []) {
				const cp = P(c);
				if (cp.privateIPAddress) privateIps.push(cp.privateIPAddress);
				const pip = cp.publicIPAddress?.id;
				if (typeof pip === "string") publicIps.push(pipAddress(pip) ?? nameOf(pip));
			}
		}
		if (privateIps.length) data.privateIPs = privateIps.join(",");
		if (publicIps.length) data.publicIPs = publicIps.join(",");
		const nics = parts.filter((f) => L(f.type) === "microsoft.network/networkinterfaces").map((f) => f.id);
		const disks = parts.filter((f) => L(f.type) === "microsoft.compute/disks").map((f) => f.name);
		const exts = parts.filter((f) => /\/extensions$/i.test(f.type)).map((f) => f.name);
		if (nics.length) data.networkInterfaces = nics.join(",");
		if (disks.length) data.disks = disks.join(",");
		if (exts.length) data.extensions = exts.join(",");
		push({
			id: key,
			label: icon ? r.name : `${r.name} (${shortType(r.type)})`,
			kind: `azure:${shortType(r.type).toLowerCase()}`,
			parent,
			shape: "icon",
			style: ICON_STYLE(icon ?? GENERIC_ICON),
			width: 48,
			height: 48,
			data,
		});
	}

	// --- edges
	const seen = new Set<string>();
	const addEdge = (from: string, to: string, kind: string, label?: string, undirected = false) => {
		if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) return;
		const k = undirected ? [from, to].sort().join("|") : `${from}|${to}`;
		const rev = `${to}|${from}`;
		if (seen.has(k) || (!undirected && seen.has(rev) && kind === "reference")) return;
		seen.add(k);
		const style = (EDGE_STYLES as Record<string, string>)[kind] ?? EDGE_STYLES.reference;
		edges.push({ from, to, kind, style, ...(label ? { label } : {}) });
	};
	// Peerings between VNets.
	for (const v of vnets) {
		for (const peer of P(v).virtualNetworkPeerings ?? []) {
			const pp = P(peer);
			const remote = pp.remoteVirtualNetwork?.id;
			if (typeof remote !== "string") continue;
			const state = pp.peeringState && pp.peeringState !== "Connected" ? ` (${pp.peeringState})` : "";
			addEdge(L(v.id), L(remote), "peering", `peering${state}`, true);
		}
	}
	for (const l of dnsLinks) addEdge(owner(l.zone), l.vnet, "dnsLink", "DNS link");
	for (const a of aclEdges) addEdge(a.subnet, a.res, "vnetRule", "VNet rule");
	const LABELS: Record<string, string> = {
		serverfarmid: "plan",
		managedenvironmentid: "environment",
		environmentid: "environment",
		workspaceresourceid: "logs",
		loganalyticsworkspaceresourceid: "logs",
		userassignedidentities: "identity",
		kubeletidentity: "identity",
		keyvaultid: "keys",
		firewallpolicy: "policy",
		webapplicationfirewallpolicy: "WAF policy",
	};
	const labelFor = (path: string[]): string | undefined => {
		for (const k of [...path].reverse()) {
			const l = LABELS[L(k)];
			if (l) return l;
		}
		return undefined;
	};
	const LB_TYPES = new Set(["microsoft.network/loadbalancers", "microsoft.network/applicationgateways"]);
	const BACKEND_PATH = /backendaddresspools|backendipconfigurations|inboundnatrules/i;
	for (const [from, refs] of refsOf) {
		if (!nodeIds.has(from)) continue;
		const fromType = typeOf(from);
		for (const ref of refs) {
			const target = resolve(ref.id);
			if (!target?.res || target.res === from || !nodeIds.has(target.res)) continue;
			const to = target.res;
			const toType = typeOf(to);
			if (toType === "microsoft.network/virtualnetworks" || fromType === "microsoft.network/virtualnetworks") continue;
			if (ref.path.some((k) => ACL_PATH.test(k))) continue;
			if (fromType === "microsoft.network/publicipaddresses") addEdge(from, to, "publicIp", "public IP");
			else if (toType === "microsoft.network/publicipaddresses") addEdge(to, from, "publicIp", "public IP");
			else if (fromType === "microsoft.network/privateendpoints") addEdge(from, to, "privateLink", keyProps(byId.get(from)!).groupIds ?? "private endpoint");
			else if (toType === "microsoft.network/privateendpoints") addEdge(to, from, "privateLink", keyProps(byId.get(to)!).groupIds ?? "private endpoint");
			else if (childOf.get(to) === from || childOf.get(from) === to) continue; // drawn below
			else if (ref.path.some((k) => BACKEND_PATH.test(k)) && (LB_TYPES.has(fromType) || LB_TYPES.has(toType))) {
				// Backend pool membership: traffic goes from the load balancer / gateway to the backend.
				if (LB_TYPES.has(fromType)) addEdge(from, to, "reference", "backend");
				else addEdge(to, from, "reference", "backend");
			} else {
				const isBack = ref.path.some((k) => BACKREF.has(L(k)));
				if (isBack) addEdge(to, from, "reference", labelFor(ref.path));
				else addEdge(from, to, "reference", labelFor(ref.path));
			}
		}
	}
	for (const [child, parent] of childOf) addEdge(parent, child, "child");
	// AKS → its node pools' scale sets (in the node resource group).
	for (const r of visible) {
		if (L(r.type) !== "microsoft.containerservice/managedclusters") continue;
		const nrg = P(r).nodeResourceGroup;
		if (typeof nrg !== "string") continue;
		for (const s of visible)
			if (L(s.type) === "microsoft.compute/virtualmachinescalesets" && L(s.resourceGroup ?? "") === L(nrg)) addEdge(L(r.id), L(s.id), "reference", "node pool");
	}

	const usedSubnets = [...subnets.values()].filter((s) => nodeIds.has(s.key)).length;
	const rgCount = nodes.filter((n) => n.kind === "azure:resource-group").length;
	const stats = { resources: all.length, drawn: visible.length, resourceGroups: rgCount, vnets: usedVnets.size, subnets: usedSubnets, edges: edges.length, byType };
	const legend = [
		`Azure subscription ${sub.name || sub.id}: ${visible.length} resource(s) in ${rgCount} resource group(s)${inv.includeNetwork ? `, ${usedVnets.size} VNet(s), ${usedSubnets} subnet(s)` : ""}. Read from ${inv.source === "resource-graph" ? "Azure Resource Graph" : "az CLI list commands"}${inv.collectedAt ? ` on ${inv.collectedAt}` : ""}.`,
		inv.includeNetwork
			? "Resources are drawn in the subnet they attach to (NICs, private endpoints, VNet integration, node pools), even when they belong to another resource group. NICs and attached disks are folded into their VM."
			: "Networking detail was left out (no VNets, subnets, NICs, public IPs, NSGs or private endpoints).",
		"Arrows: references between resources. Purple dashed: private endpoint → service. Orange: public IP. Green: VNet peering. Dotted green: VNet service-endpoint rule.",
	];
	if (filter) legend.push(`Only resource groups: ${[...filter].join(", ")} (plus the VNets they attach to).`);
	const graph: MapGraph = { title: `Azure · ${sub.name || sub.id}`, nodes, edges, direction: "down", legend };
	// Health checks over everything collected in the drawn scope (the filter's groups and the VNets they use).
	const inScope = all.filter((r) => inFilter(r) || usedVnets.has(L(r.id)));
	const health = azureHealth({ resources: inScope, owner }).finish(graph);
	const checked = health.checked.filter((c) => c.scanned > 0 || /^NSG/.test(c.check));
	return { graph, stats, facts: azureFacts(inv, nodes, edges, stats) + findingsMarkdown(health.findings).join("\n"), findings: health.findings, checked };
}

/** The inventory for the agent: one line per resource with the ids it needs to dig deeper. */
function azureFacts(inv: AzInventory, nodes: MapNode[], edges: MapEdge[], stats: Built["stats"]): string {
	const lines: string[] = [];
	const sub = inv.subscription;
	lines.push(`# Azure subscription ${sub.name} (${sub.id})`);
	lines.push(`Source: ${inv.source === "resource-graph" ? "Azure Resource Graph" : "az CLI list commands"}${inv.collectedAt ? `, ${inv.collectedAt}` : ""}. ${stats.drawn} resources drawn of ${stats.resources} collected.`);
	lines.push(
		`Counts by type: ${Object.entries(stats.byType)
			.sort((a, b) => b[1] - a[1])
			.map(([t, n]) => `${t} ${n}`)
			.join(", ")}`
	);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const labelOf = (id: string) => byId.get(id)?.label ?? id;
	const children = new Map<string, MapNode[]>();
	for (const n of nodes) {
		if (!n.parent) continue;
		if (!children.has(n.parent)) children.set(n.parent, []);
		children.get(n.parent)!.push(n);
	}
	const describe = (n: MapNode): string => {
		const d = n.data ?? {};
		const props = Object.entries(d)
			.filter(([k]) => !["resourceId", "type", "resourceGroup", "subscriptionId", "location"].includes(k))
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
		return `${d.type ?? n.kind} **${n.label}** [${d.location ?? ""}] id=${d.resourceId ?? n.id}${props ? ` | ${props}` : ""}`;
	};
	const walk = (id: string, depth: number) => {
		for (const n of children.get(id) ?? []) {
			const indent = "  ".repeat(depth);
			if (n.container) {
				const heading = n.kind === "azure:resource-group" ? "Resource group" : n.kind === "azure:vnet" ? "VNet" : n.kind === "azure:subnet" ? "Subnet" : n.kind;
				lines.push(`${indent}- ${heading} ${describe(n)}`);
			} else lines.push(`${indent}- ${describe(n)}`);
			walk(n.id, depth + 1);
		}
	};
	walk(L(`/subscriptions/${sub.id}`), 0);
	if (edges.length) {
		lines.push("", "## Connections (from → to)");
		for (const e of edges.slice(0, 400)) lines.push(`- ${labelOf(e.from)} → ${labelOf(e.to)}${e.label ? ` (${e.label})` : ""} [${e.kind}]`);
		if (edges.length > 400) lines.push(`- … ${edges.length - 400} more`);
	}
	return lines.join("\n");
}
