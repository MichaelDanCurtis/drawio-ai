import { agentRequest, digDeeperRequest } from "../../common";
import type { Recipe } from "../../../types";
import { collectAzure, listResourceGroups, listSubscriptions } from "./collect";
import { findingsSummary } from "../findings";
import { buildAzureGraph } from "./model";

export const azureEnvironmentRecipe: Recipe = {
	id: "azure.environment",
	category: "azure",
	title: "Azure environment",
	description:
		"Subscription, resource groups, virtual networks and subnets with the resources attached to them, and the references between resources (private endpoints, public IPs, peerings, plans, identities...). Read-only, with the az CLI.",
	mode: "inventory",
	fields: [
		{ id: "subscription", label: "Subscription", type: "select", dynamic: true, required: true, help: "From `az account list` (run `az login` first)." },
		{
			id: "resourceGroups",
			label: "Resource groups",
			type: "select",
			dynamic: true,
			help: "All, or just one group (the VNets its resources attach to are drawn too).",
		},
		{
			id: "includeNetwork",
			label: "Include networking detail",
			type: "checkbox",
			default: "true",
			help: "VNets and subnets as boxes, resources placed by their subnet, NICs, public IPs, NSGs and private endpoints.",
		},
	],
	async loadOptions(fieldId, input, ctx) {
		if (fieldId === "subscription") return listSubscriptions(ctx);
		if (fieldId === "resourceGroups") return listResourceGroups(ctx, input.subscription ?? "");
		return [];
	},
	async collect(input, ctx) {
		const { inventory, warnings } = await collectAzure(
			{
				subscription: input.subscription ?? "",
				resourceGroups: (input.resourceGroups ?? "").split(",").map((s) => s.trim()).filter(Boolean),
				includeNetwork: input.includeNetwork !== "false" && input.includeNetwork !== "",
			},
			ctx
		);
		ctx.progress("Drawing the map…");
		const { graph, stats, facts, findings, checked } = buildAzureGraph(inventory);
		const summary =
			stats.drawn === 0
				? `No resources found in ${inventory.subscription.name}${inventory.resourceGroupFilter ? ` (${inventory.resourceGroupFilter.join(", ")})` : ""} (${stats.resourceGroups} resource group(s) visible).`
				: `${stats.drawn} resource(s) in ${stats.resourceGroups} resource group(s)${inventory.includeNetwork ? `, ${stats.vnets} VNet(s), ${stats.subnets} subnet(s)` : ""}, ${stats.edges} connection(s)${findingsSummary(findings)} · ${inventory.source === "resource-graph" ? "Resource Graph" : "az CLI"}`;
		if (stats.drawn > 600) warnings.push(`A large map (${stats.drawn} resources): drawing and editing may be slow; map one resource group at a time for detail.`);
		return { graph, facts, summary, warnings, findings, checked };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			[
				"Review the Azure architecture on this map (it was just drawn from the subscription's inventory) and add short review notes next to the shapes they concern, as pending changes:",
				"- exposure: public IPs, public network access, open NSG rules (e.g. 22/3389 from Internet/*), resources without a WAF or private endpoint in front;",
				"- single points of failure: single VMs or single-instance plans, no zones, one gateway, databases without HA/geo-redundancy;",
				"- missing private endpoints / service-endpoint-only access to PaaS (storage, Key Vault, SQL, Cosmos DB...), missing NSGs or route tables on subnets;",
				"- anything else worth a human's attention (identity, unused or orphaned resources).",
				"Base the notes on the facts below; if you need more detail, use read-only `az ... show/list` or `az graph query` commands with the resource ids from the shapes' data. Do not redraw the map.",
			].join("\n"),
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest(
			"Azure resources. Use only read-only az commands (`az resource show --ids <resourceId>`, `az <service> show/list ...`, `az network ... list/show`, `az monitor ... list`, `az graph query` when the resource-graph extension is installed) with the resourceId, resourceGroup and subscriptionId stored on each shape",
			shapes,
			question
		),
};

export const azureRecipes: Recipe[] = [azureEnvironmentRecipe];
