/**
 * Read-only collection of an Azure subscription with the az CLI. Prefers Azure
 * Resource Graph (one paginated query, full properties) when the `resource-graph`
 * extension is installed; otherwise lists resources and the services that matter
 * for the network picture one by one. Every command goes through ctx.exec, i.e.
 * the read-only guard (only list / show / query verbs for az).
 */
import { execJson } from "../../../context";
import type { CollectContext, FieldOption } from "../../../types";
import { MapperError } from "../../../types";
import { AzInventory, AzResource, AzResourceGroup, mergeResources, normalizeResource } from "./model";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RG_NAME = /^[-\w._()]{1,90}$/;

export function checkCancelled(ctx: CollectContext): void {
	if (ctx.signal.aborted) throw new MapperError("Cancelled");
}

/** Runs `fn` over items with at most `limit` running at once, in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

const NOT_SIGNED_IN = /az login|Please run 'az login'|AADSTS|refresh token|InteractionRequired|No subscription found/i;
const DENIED = /AuthorizationFailed|does not have authorization|Forbidden|\(403\)|LinkedAuthorizationFailed/i;

function explain(e: any): string {
	return String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);
}

/** az's JSON, or a MapperError with a hint when the user is not signed in. */
async function az<T = any>(ctx: CollectContext, args: string[], timeoutMs?: number): Promise<T> {
	checkCancelled(ctx);
	try {
		return await execJson<T>(ctx, "az", [...args, "-o", "json", "--only-show-errors"], { timeoutMs });
	} catch (e: any) {
		if (NOT_SIGNED_IN.test(String(e?.message))) throw new MapperError("The Azure CLI is not signed in.", "Run `az login` in a terminal, then try again.");
		throw e;
	}
}

export async function listSubscriptions(ctx: CollectContext): Promise<FieldOption[]> {
	const subs = (await az<any[]>(ctx, ["account", "list"])) ?? [];
	if (!subs.length) throw new MapperError("No Azure subscriptions found.", "Run `az login` (or check `az account list`).");
	return subs
		.filter((s) => s.state === undefined || s.state === "Enabled")
		.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || String(a.name).localeCompare(String(b.name)))
		.map((s) => ({ value: s.id, label: `${s.name} (${s.id})${s.isDefault ? " · default" : ""}` }));
}

export async function listResourceGroups(ctx: CollectContext, subscription: string): Promise<FieldOption[]> {
	const args = ["group", "list"];
	if (subscription) args.push("--subscription", subscription);
	const groups = (await az<any[]>(ctx, args)) ?? [];
	return [{ value: "", label: "All resource groups" }, ...groups.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((g) => ({ value: g.name, label: `${g.name} (${g.location})` }))];
}

export interface AzureCollectOptions {
	subscription: string;
	resourceGroups?: string[];
	includeNetwork: boolean;
}

/** Collects the inventory; problems with single services become warnings. */
export async function collectAzure(opts: AzureCollectOptions, ctx: CollectContext): Promise<{ inventory: AzInventory; warnings: string[] }> {
	const warnings: string[] = [];
	ctx.progress("Reading Azure subscriptions…");
	const accounts = (await az<any[]>(ctx, ["account", "list"])) ?? [];
	const wanted = opts.subscription?.trim();
	const account = wanted ? accounts.find((a) => a.id === wanted || a.name === wanted) : accounts.find((a) => a.isDefault) ?? accounts[0];
	if (!account) {
		if (!accounts.length) throw new MapperError("No Azure subscriptions found.", "Run `az login`, then pick a subscription.");
		throw new MapperError(`Subscription ${wanted} is not one you are signed in to.`, "Pick one of the subscriptions listed by `az account list`.");
	}
	if (!GUID.test(account.id)) throw new MapperError(`Unexpected subscription id ${account.id}.`);
	const subscription = { id: account.id as string, name: String(account.name ?? account.id), tenantId: account.tenantId as string | undefined };
	const rgs = (opts.resourceGroups ?? []).map((g) => g.trim()).filter(Boolean);
	for (const g of rgs) if (!RG_NAME.test(g)) throw new MapperError(`"${g}" is not a valid resource group name.`);

	let hasGraph = false;
	try {
		const exts = (await az<any[]>(ctx, ["extension", "list"])) ?? [];
		hasGraph = exts.some((x) => x?.name === "resource-graph");
	} catch (e: any) {
		if (e instanceof MapperError && /Cancelled|not signed in/.test(e.message)) throw e;
		warnings.push(`Could not list az extensions: ${explain(e)}`);
	}

	let inventory: AzInventory | undefined;
	if (hasGraph) {
		try {
			inventory = await viaResourceGraph(subscription, rgs, opts.includeNetwork, ctx);
		} catch (e: any) {
			if (e instanceof MapperError && /Cancelled|not signed in/.test(e.message)) throw e;
			warnings.push(`Azure Resource Graph failed, listing resources service by service instead: ${explain(e)}`);
		}
	} else {
		warnings.push(
			"The az `resource-graph` extension is not installed, so resources were listed service by service (slower, fewer properties). `az extension add --name resource-graph` enables the faster, more complete path."
		);
	}
	if (!inventory) inventory = await viaListCommands(subscription, rgs, opts.includeNetwork, ctx, warnings);
	inventory.collectedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
	return { inventory, warnings };
}

const kqlString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function graphQuery(query: string, subscription: string, ctx: CollectContext): Promise<any[]> {
	const rows: any[] = [];
	let skip: string | undefined;
	for (let page = 0; page < 100; page++) {
		const args = ["graph", "query", "-q", query, "--subscriptions", subscription, "--first", "1000"];
		if (skip) args.push("--skip-token", skip);
		const r: any = await az(ctx, args, 300_000);
		const data = Array.isArray(r) ? r : r?.data ?? [];
		rows.push(...data);
		skip = r?.skip_token ?? r?.skipToken ?? r?.$skipToken ?? undefined;
		if (!skip || data.length === 0) break;
		ctx.progress(`Azure Resource Graph: ${rows.length} rows…`);
	}
	return rows;
}

async function viaResourceGraph(subscription: AzInventory["subscription"], rgs: string[], includeNetwork: boolean, ctx: CollectContext): Promise<AzInventory> {
	ctx.progress("Querying Azure Resource Graph…");
	const rgFilter = rgs.length ? ` | where resourceGroup in~ (${rgs.map(kqlString).join(", ")})${includeNetwork ? " or type =~ 'microsoft.network/virtualnetworks'" : ""}` : "";
	const resourcesQuery = `Resources | where subscriptionId =~ ${kqlString(subscription.id)}${rgFilter} | project id, name, type, location, resourceGroup, subscriptionId, kind, sku, tags, identity, managedBy, zones, properties | order by id asc`;
	const groupsQuery = `ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and subscriptionId =~ ${kqlString(subscription.id)} | project id, name, location | order by name asc`;
	const [rows, groups] = await Promise.all([graphQuery(resourcesQuery, subscription.id, ctx), graphQuery(groupsQuery, subscription.id, ctx)]);
	return {
		subscription,
		resourceGroups: groups.map((g: any) => ({ id: g.id, name: g.name, location: g.location })),
		resources: rows.map(normalizeResource).filter((r): r is AzResource => !!r),
		source: "resource-graph",
		includeNetwork,
		resourceGroupFilter: rgs.length ? rgs.map((g) => g.toLowerCase()) : undefined,
	};
}

/** Service list commands (all core az commands, read-only) that add properties for the types they cover. */
const DETAIL: { types: string[]; args: string[]; network?: boolean; label: string }[] = [
	{ label: "virtual networks", types: ["microsoft.network/virtualnetworks"], args: ["network", "vnet", "list"], network: true },
	{ label: "network interfaces", types: ["microsoft.network/networkinterfaces"], args: ["network", "nic", "list"], network: true },
	{ label: "public IPs", types: ["microsoft.network/publicipaddresses"], args: ["network", "public-ip", "list"], network: true },
	{ label: "private endpoints", types: ["microsoft.network/privateendpoints"], args: ["network", "private-endpoint", "list"], network: true },
	{ label: "network security groups", types: ["microsoft.network/networksecuritygroups"], args: ["network", "nsg", "list"], network: true },
	{ label: "NAT gateways", types: ["microsoft.network/natgateways"], args: ["network", "nat", "gateway", "list"], network: true },
	{ label: "application gateways", types: ["microsoft.network/applicationgateways"], args: ["network", "application-gateway", "list"] },
	{ label: "load balancers", types: ["microsoft.network/loadbalancers"], args: ["network", "lb", "list"] },
	{ label: "virtual machines", types: ["microsoft.compute/virtualmachines"], args: ["vm", "list"] },
	{ label: "scale sets", types: ["microsoft.compute/virtualmachinescalesets"], args: ["vmss", "list"] },
	{ label: "AKS clusters", types: ["microsoft.containerservice/managedclusters"], args: ["aks", "list"] },
	{ label: "web apps", types: ["microsoft.web/sites"], args: ["webapp", "list"] },
	{ label: "function apps", types: ["microsoft.web/sites"], args: ["functionapp", "list"] },
	{ label: "storage accounts", types: ["microsoft.storage/storageaccounts"], args: ["storage", "account", "list"] },
	{ label: "SQL servers", types: ["microsoft.sql/servers"], args: ["sql", "server", "list"] },
	{ label: "Cosmos DB accounts", types: ["microsoft.documentdb/databaseaccounts"], args: ["cosmosdb", "list"] },
	{ label: "container registries", types: ["microsoft.containerregistry/registries"], args: ["acr", "list"] },
	{ label: "Redis caches", types: ["microsoft.cache/redis"], args: ["redis", "list"] },
	{ label: "PostgreSQL servers", types: ["microsoft.dbforpostgresql/flexibleservers"], args: ["postgres", "flexible-server", "list"] },
	{ label: "MySQL servers", types: ["microsoft.dbformysql/flexibleservers"], args: ["mysql", "flexible-server", "list"] },
	{ label: "Event Hubs namespaces", types: ["microsoft.eventhub/namespaces"], args: ["eventhubs", "namespace", "list"] },
	{ label: "Service Bus namespaces", types: ["microsoft.servicebus/namespaces"], args: ["servicebus", "namespace", "list"] },
	{ label: "API Management", types: ["microsoft.apimanagement/service"], args: ["apim", "list"] },
];

async function viaListCommands(
	subscription: AzInventory["subscription"],
	rgs: string[],
	includeNetwork: boolean,
	ctx: CollectContext,
	warnings: string[]
): Promise<AzInventory> {
	const sub = ["--subscription", subscription.id];
	ctx.progress("Listing resource groups and resources…");
	const [groupsRaw, resourcesRaw] = await Promise.all([
		az<any[]>(ctx, ["group", "list", ...sub]).catch((e) => {
			if (/Cancelled|not signed in/.test(String(e?.message))) throw e;
			warnings.push(`Could not list resource groups: ${explain(e)}`);
			return [] as any[];
		}),
		az<any[]>(ctx, ["resource", "list", ...sub], 300_000),
	]);
	const groups: AzResourceGroup[] = (groupsRaw ?? []).map((g: any) => ({ id: g.id, name: g.name, location: g.location }));
	let resources = (resourcesRaw ?? []).map(normalizeResource).filter((r): r is AzResource => !!r);
	const present = new Set(resources.map((r) => r.type.toLowerCase()));
	const jobs = DETAIL.filter((d) => (includeNetwork || !d.network) && d.types.some((t) => present.has(t)));
	let done = 0;
	const details = await mapLimit(jobs, 4, async (job) => {
		checkCancelled(ctx);
		try {
			const out = (await az<any[]>(ctx, [...job.args, ...sub], 300_000)) ?? [];
			return out.map(normalizeResource).filter((r): r is AzResource => !!r);
		} catch (e: any) {
			if (/Cancelled|not signed in/.test(String(e?.message))) throw e;
			warnings.push(`${DENIED.test(String(e?.message)) ? "No permission to list" : "Could not list"} ${job.label}: ${explain(e)}`);
			return [];
		} finally {
			ctx.progress(`Reading service details… ${++done}/${jobs.length}`);
		}
	});
	resources = mergeResources(resources, details.flat());
	return {
		subscription,
		resourceGroups: groups,
		resources,
		source: "cli",
		includeNetwork,
		resourceGroupFilter: rgs.length ? rgs.map((g) => g.toLowerCase()) : undefined,
	};
}
