/**
 * Health checks on an Azure inventory: only what the collected properties
 * show (an absent property is "unknown", not "off"), with the setting as
 * evidence and never a secret value. Node ids are the lowercase ARM ids the
 * map uses for resources and subnets.
 */
import { FindingSet, portNames, riskyPorts, WORLD } from "../findings";
import type { AzResource } from "./model";

const L = (s: string) => s.toLowerCase();
const P = (o: any): any => (o && typeof o === "object" ? o.properties ?? o : {});
const OLD_TLS = /^(tls)?1[._][01]$/i;
const tlsText = (v: string) => v.replace(/^tls/i, "").replace("_", ".");

export interface AzureHealthInput {
	resources: AzResource[];
	/** Resource key → the drawn resource it is folded into (NIC → VM). */
	owner: (key: string) => string;
}

/** A port range as written ("22", "1000-2000", "*"). */
function range(spec: unknown): [number, number] | undefined {
	const s = String(spec ?? "").trim();
	if (s === "*") return [0, 65535];
	const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
	return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
}

/** Inbound Allow rules of an NSG that open risky ports to the internet. */
export function openNsgRules(nsg: AzResource): { rule: string; risky: string[] }[] {
	const out: { rule: string; risky: string[] }[] = [];
	for (const raw of P(nsg).securityRules ?? []) {
		const r = P(raw);
		if (!/^inbound$/i.test(String(r?.direction ?? "")) || !/^allow$/i.test(String(r?.access ?? ""))) continue;
		const sources = [r.sourceAddressPrefix, ...(r.sourceAddressPrefixes ?? [])].filter((x: unknown): x is string => typeof x === "string");
		const world = sources.filter((s) => WORLD.test(s.trim()));
		if (!world.length || /^icmp$/i.test(String(r.protocol ?? ""))) continue;
		const ports = [r.destinationPortRange, ...(r.destinationPortRanges ?? [])].filter((x: unknown) => x !== undefined && x !== null && x !== "");
		const risky = new Set<string>();
		for (const p of ports.length ? ports : ["*"]) {
			const rg = range(p);
			if (rg) for (const x of riskyPorts(rg[0], rg[1])) risky.add(x);
		}
		if (risky.size) out.push({ rule: `${raw?.name ?? r.name ?? "rule"} (priority ${r.priority ?? "?"}): allow ${r.protocol ?? "*"} ${ports.join(",") || "*"} from ${world.join(",")}`, risky: [...risky] });
	}
	return out;
}

export function azureHealth(input: AzureHealthInput): FindingSet {
	const found = new FindingSet();
	const byType = (t: string) => input.resources.filter((r) => L(r.type) === t);
	const key = (r: AzResource) => L(r.id);

	// --- NSG rules open to the internet, on the NSG, the subnets and VMs that use it.
	const nsgs = byType("microsoft.network/networksecuritygroups");
	const users = new Map<string, Set<string>>();
	const use = (nsgId: unknown, nodeId: string) => {
		if (typeof nsgId !== "string") return;
		const k = L(nsgId);
		if (!users.has(k)) users.set(k, new Set());
		users.get(k)!.add(nodeId);
	};
	// Subnet → NSG from every VNet (whether subnets are drawn or not), so VMs behind a subnet NSG are flagged too.
	const subnetNsg = new Map<string, string>();
	for (const v of byType("microsoft.network/virtualnetworks"))
		for (const sn of P(v).subnets ?? []) {
			const nsgId = P(sn).networkSecurityGroup?.id;
			const id = typeof sn?.id === "string" ? sn.id : `${v.id}/subnets/${sn?.name}`;
			if (typeof nsgId === "string") {
				subnetNsg.set(L(id), nsgId);
				use(nsgId, L(id));
			}
		}
	for (const nic of byType("microsoft.network/networkinterfaces")) {
		const owner = input.owner(key(nic));
		use(P(nic).networkSecurityGroup?.id, owner);
		for (const c of P(nic).ipConfigurations ?? []) {
			const subnet = P(c).subnet?.id;
			if (typeof subnet === "string") use(subnetNsg.get(L(subnet)), owner);
		}
	}
	let rules = 0;
	for (const nsg of nsgs) {
		const all: any[] = P(nsg).securityRules ?? [];
		rules += all.filter((r) => /^inbound$/i.test(String(P(r)?.direction ?? ""))).length;
		const open = openNsgRules(nsg);
		if (!open.length) continue;
		const ports = portNames(open.flatMap((o) => o.risky));
		const attached = [...(users.get(key(nsg)) ?? [])].sort();
		found.add({
			kind: "open-ingress",
			severity: "high",
			title: `NSG ${nsg.name} opens ${ports} to the internet`,
			detail: `Security rule ${open.map((o) => o.rule).join("; ")} in NSG ${nsg.name} (resource group ${nsg.resourceGroup ?? "?"})${attached.length ? `; it applies to ${attached.map((k) => k.split("/").pop()).join(", ")}` : ""}.`,
			nodeIds: [key(nsg), ...attached],
			key: key(nsg),
			fix: `Remove the rule(s) or set their source to known address ranges in NSG ${nsg.name}; use Azure Bastion or just-in-time VM access for administration.`,
		});
	}
	found.check("NSG rules open to the internet", rules, "Inbound rules examined; only rules opening remote administration, database or all ports to * / Internet / 0.0.0.0/0 are reported.");

	// --- storage accounts
	const storage = byType("microsoft.storage/storageaccounts").filter((r) => {
		const p = P(r);
		return p.allowBlobPublicAccess !== undefined || p.supportsHttpsTrafficOnly !== undefined || p.minimumTlsVersion !== undefined;
	});
	for (const r of storage) {
		const p = P(r);
		if (p.allowBlobPublicAccess === true)
			found.add({
				kind: "public-blob-access",
				severity: "medium",
				title: `Storage account ${r.name} allows anonymous access to blobs`,
				detail: `allowBlobPublicAccess = true on storage account ${r.name} (resource group ${r.resourceGroup ?? "?"}): any container can be made public.`,
				nodeIds: [key(r)],
				fix: `Set allowBlobPublicAccess to false on ${r.name} (az storage account update --allow-blob-public-access false) after checking no container needs anonymous reads.`,
			});
		if (p.supportsHttpsTrafficOnly === false)
			found.add({
				kind: "https-not-enforced",
				severity: "medium",
				title: `Storage account ${r.name} accepts plain HTTP`,
				detail: `supportsHttpsTrafficOnly = false on storage account ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set supportsHttpsTrafficOnly to true on ${r.name} (az storage account update --https-only true).`,
			});
		if (typeof p.minimumTlsVersion === "string" && OLD_TLS.test(p.minimumTlsVersion))
			found.add({
				kind: "old-tls",
				severity: "medium",
				title: `Storage account ${r.name} still accepts TLS ${tlsText(p.minimumTlsVersion)}`,
				detail: `minimumTlsVersion = ${p.minimumTlsVersion} on storage account ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set minimumTlsVersion to TLS1_2 on ${r.name} (az storage account update --min-tls-version TLS1_2).`,
			});
	}
	found.check("Storage accounts: public blob access, HTTPS and TLS", storage.length);

	// --- Key Vaults
	const vaults = byType("microsoft.keyvault/vaults").filter((r) => P(r).tenantId !== undefined || P(r).vaultUri !== undefined || P(r).enableSoftDelete !== undefined);
	for (const r of vaults) {
		const p = P(r);
		if (p.enablePurgeProtection !== true)
			found.add({
				kind: "no-purge-protection",
				severity: "low",
				title: `Key Vault ${r.name} can be purged during its soft-delete period`,
				detail: `enablePurgeProtection = ${p.enablePurgeProtection ?? "not set"} on Key Vault ${r.name}: a deleted vault, key or secret can be destroyed before the retention period ends.`,
				nodeIds: [key(r)],
				fix: `Enable purge protection on ${r.name} (az keyvault update --enable-purge-protection true); it cannot be turned off again.`,
			});
		if (p.publicNetworkAccess === "Enabled" && p.networkAcls?.defaultAction === "Allow")
			found.add({
				kind: "public-network-access",
				severity: "low",
				title: `Key Vault ${r.name} accepts connections from any network`,
				detail: `publicNetworkAccess = Enabled and networkAcls.defaultAction = Allow on Key Vault ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set the firewall of ${r.name} to deny by default (networkAcls.defaultAction = Deny) with the networks that need it, or use a private endpoint.`,
			});
	}
	found.check("Key Vaults: purge protection and network access", vaults.length);

	// --- web apps
	const sites = byType("microsoft.web/sites").filter((r) => P(r).httpsOnly !== undefined || P(r).siteConfig !== undefined);
	for (const r of sites) {
		const p = P(r);
		if (p.httpsOnly === false)
			found.add({
				kind: "https-not-enforced",
				severity: "medium",
				title: `${r.name} accepts plain HTTP`,
				detail: `httpsOnly = false on ${r.kind ?? "web app"} ${r.name}${p.defaultHostName ? ` (${p.defaultHostName})` : ""}.`,
				nodeIds: [key(r)],
				fix: `Turn on HTTPS Only for ${r.name} (az webapp update --https-only true, or az functionapp update for function apps).`,
			});
		const tls = p.siteConfig?.minTlsVersion;
		if (typeof tls === "string" && OLD_TLS.test(tls))
			found.add({
				kind: "old-tls",
				severity: "medium",
				title: `${r.name} still accepts TLS ${tlsText(tls)}`,
				detail: `siteConfig.minTlsVersion = ${tls} on ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set the minimum TLS version of ${r.name} to 1.2 (az webapp config set --min-tls-version 1.2).`,
			});
		if (p.siteConfig?.ftpsState === "AllAllowed")
			found.add({
				kind: "unencrypted-transit",
				severity: "medium",
				title: `${r.name} allows deployments over plain FTP`,
				detail: `siteConfig.ftpsState = AllAllowed on ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set ftpsState to FtpsOnly or Disabled on ${r.name} (az webapp config set --ftps-state Disabled).`,
			});
	}
	found.check("Web apps: HTTPS, TLS and FTP", sites.length);

	// --- databases
	let dbs = 0;
	for (const r of byType("microsoft.sql/servers")) {
		const p = P(r);
		if (p.publicNetworkAccess === undefined && p.minimalTlsVersion === undefined) continue;
		dbs++;
		if (typeof p.minimalTlsVersion === "string" && OLD_TLS.test(p.minimalTlsVersion))
			found.add({
				kind: "old-tls",
				severity: "medium",
				title: `SQL server ${r.name} still accepts TLS ${tlsText(p.minimalTlsVersion)}`,
				detail: `minimalTlsVersion = ${p.minimalTlsVersion} on SQL server ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set the minimal TLS version of ${r.name} to 1.2 (az sql server update --minimal-tls-version 1.2).`,
			});
		if (p.publicNetworkAccess === "Enabled")
			found.add({
				kind: "public-network-access",
				severity: "low",
				title: `SQL server ${r.name} is reachable over its public endpoint`,
				detail: `publicNetworkAccess = Enabled on SQL server ${r.name}; who gets through depends on its firewall rules (not collected).`,
				nodeIds: [key(r)],
				fix: `Disable public network access on ${r.name} and connect through a private endpoint, or keep its firewall rules to the client addresses that need them.`,
			});
	}
	for (const t of ["microsoft.dbforpostgresql/flexibleservers", "microsoft.dbformysql/flexibleservers"]) {
		for (const r of byType(t)) {
			const pna = P(r).network?.publicNetworkAccess;
			if (pna === undefined) continue;
			dbs++;
			if (pna === "Enabled")
				found.add({
					kind: "public-network-access",
					severity: "low",
					title: `${t.includes("postgres") ? "PostgreSQL" : "MySQL"} server ${r.name} is reachable over its public endpoint`,
					detail: `network.publicNetworkAccess = Enabled on ${r.name}; who gets through depends on its firewall rules (not collected).`,
					nodeIds: [key(r)],
					fix: `Use VNet integration or a private endpoint for ${r.name}, or keep its firewall rules to the client addresses that need them.`,
				});
		}
	}
	for (const r of byType("microsoft.documentdb/databaseaccounts")) {
		const p = P(r);
		if (p.publicNetworkAccess === undefined) continue;
		dbs++;
		const ipRules: any[] = p.ipRules ?? p.ipRangeFilter ?? [];
		const noFilter = !p.isVirtualNetworkFilterEnabled && (Array.isArray(ipRules) ? ipRules.length === 0 : !String(ipRules).trim());
		if (p.publicNetworkAccess === "Enabled" && noFilter)
			found.add({
				kind: "public-database",
				severity: "high",
				title: `Cosmos DB account ${r.name} accepts connections from any network`,
				detail: `publicNetworkAccess = Enabled, isVirtualNetworkFilterEnabled = ${!!p.isVirtualNetworkFilterEnabled} and no IP rules on Cosmos DB account ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Restrict ${r.name} to selected networks (IP rules / VNet rules) or a private endpoint, and disable public network access if nothing outside needs it.`,
			});
	}
	found.check("Databases: network exposure and TLS (SQL, PostgreSQL, MySQL, Cosmos DB)", dbs);

	// --- Redis, container registries
	const redis = byType("microsoft.cache/redis").filter((r) => P(r).enableNonSslPort !== undefined || P(r).minimumTlsVersion !== undefined);
	for (const r of redis) {
		const p = P(r);
		if (p.enableNonSslPort === true)
			found.add({
				kind: "unencrypted-transit",
				severity: "medium",
				title: `Redis cache ${r.name} opens its non-TLS port`,
				detail: `enableNonSslPort = true on Azure Cache for Redis ${r.name} (port 6379 without TLS).`,
				nodeIds: [key(r)],
				fix: `Turn off the non-SSL port of ${r.name} (az redis update --set enableNonSslPort=false) and connect on 6380 with TLS.`,
			});
		if (typeof p.minimumTlsVersion === "string" && OLD_TLS.test(p.minimumTlsVersion))
			found.add({
				kind: "old-tls",
				severity: "medium",
				title: `Redis cache ${r.name} still accepts TLS ${tlsText(p.minimumTlsVersion)}`,
				detail: `minimumTlsVersion = ${p.minimumTlsVersion} on ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Set minimumTlsVersion of ${r.name} to 1.2.`,
			});
	}
	found.check("Redis caches: TLS", redis.length);
	const registries = byType("microsoft.containerregistry/registries").filter((r) => P(r).anonymousPullEnabled !== undefined);
	for (const r of registries)
		if (P(r).anonymousPullEnabled === true)
			found.add({
				kind: "public-registry",
				severity: "medium",
				title: `Container registry ${r.name} lets anyone pull images`,
				detail: `anonymousPullEnabled = true on container registry ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Disable anonymous pull on ${r.name} (az acr update --anonymous-pull-enabled false) unless its images are meant to be public.`,
			});
	found.check("Container registries: anonymous pull", registries.length);

	// --- AKS control plane
	const aks = byType("microsoft.containerservice/managedclusters").filter((r) => P(r).kubernetesVersion !== undefined || P(r).apiServerAccessProfile !== undefined);
	for (const r of aks) {
		const api = P(r).apiServerAccessProfile ?? {};
		const ranges: any[] = Array.isArray(api.authorizedIPRanges) ? api.authorizedIPRanges : [];
		if (api.enablePrivateCluster !== true && ranges.length === 0)
			found.add({
				kind: "public-control-plane",
				severity: "medium",
				title: `The Kubernetes API of AKS cluster ${r.name} is reachable from the whole internet`,
				detail: `apiServerAccessProfile: enablePrivateCluster = ${api.enablePrivateCluster ?? "not set"}, no authorizedIPRanges on AKS cluster ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Limit the API server of ${r.name} to known ranges (az aks update --api-server-authorized-ip-ranges …) or make it a private cluster.`,
			});
	}
	found.check("AKS API server exposure", aks.length);

	// --- Application gateways with a public frontend and no WAF
	const gateways = byType("microsoft.network/applicationgateways").filter((r) => P(r).sku !== undefined || r.sku !== undefined);
	for (const r of gateways) {
		const p = P(r);
		const tier = String(p.sku?.tier ?? r.sku?.tier ?? "");
		const publicFront = (p.frontendIPConfigurations ?? []).some((f: any) => P(f).publicIPAddress?.id);
		const waf = /waf/i.test(tier) || p.webApplicationFirewallConfiguration?.enabled === true || !!p.firewallPolicy?.id;
		if (publicFront && !waf)
			found.add({
				kind: "no-waf",
				severity: "info",
				title: `Application gateway ${r.name} faces the internet without a WAF`,
				detail: `SKU tier ${tier || "?"}, no web application firewall configuration or policy, public frontend IP on ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Move ${r.name} to the WAF_v2 tier with a WAF policy (OWASP rule set) if it serves web applications.`,
			});
	}
	found.check("Application gateways: WAF", gateways.length);

	// --- single-instance App Service plans
	const plans = byType("microsoft.web/serverfarms").filter((r) => P(r).numberOfWorkers !== undefined);
	for (const r of plans) {
		const p = P(r);
		const tier = String(r.sku?.tier ?? "");
		if (p.numberOfWorkers === 1 && !/^(free|shared|dynamic|flexconsumption|elasticpremium)$/i.test(tier))
			found.add({
				kind: "single-instance",
				severity: "info",
				title: `App Service plan ${r.name} runs on a single instance`,
				detail: `numberOfWorkers = 1${p.zoneRedundant === false ? ", zoneRedundant = false" : ""} on App Service plan ${r.name}.`,
				nodeIds: [key(r)],
				fix: `Scale ${r.name} out to at least 2 instances (zone redundant where available) if its apps must stay up during instance maintenance.`,
			});
	}
	found.check("App Service plans: instance count", plans.length);
	return found;
}
