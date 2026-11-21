import { agentRequest, digDeeperRequest } from "../../common";
import type { Recipe } from "../../../types";
import { collectGcp, listProjects } from "./collect";
import { findingsSummary } from "../findings";
import { buildGcpGraph } from "./model";

export const gcpEnvironmentRecipe: Recipe = {
	id: "gcp.environment",
	category: "gcp",
	title: "Google Cloud environment",
	description:
		"Project, VPC networks, regions and subnetworks with the VMs, GKE clusters, load balancers and databases in them, serverless services by region, firewall rules and the references between resources. Read-only, with gcloud (Cloud Asset Inventory when enabled).",
	mode: "inventory",
	fields: [{ id: "project", label: "Project", type: "select", dynamic: true, required: true, help: "From `gcloud projects list` (run `gcloud auth login` first)." }],
	async loadOptions(fieldId, _input, ctx) {
		return fieldId === "project" ? listProjects(ctx) : [];
	},
	async collect(input, ctx) {
		const { inventory, warnings } = await collectGcp(input.project ?? "", ctx);
		ctx.progress("Drawing the map…");
		const { graph, stats, facts, findings, checked } = buildGcpGraph(inventory);
		const summary =
			stats.drawn === 0
				? `No resources found in project ${inventory.project.id}.`
				: `${stats.drawn} resource(s), ${stats.networks} VPC network(s), ${stats.subnets} subnetwork(s), ${stats.edges} connection(s)${findingsSummary(findings)} · ${inventory.source === "asset-inventory" ? "Cloud Asset Inventory" : "gcloud lists"}`;
		if (stats.drawn > 600) warnings.push(`A large map (${stats.drawn} resources): drawing and editing may be slow.`);
		return { graph, facts, summary, warnings, findings, checked };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			[
				"Review the Google Cloud architecture on this map (just drawn from the project's inventory) and add short review notes next to the shapes they concern, as pending changes:",
				"- exposure: external IPs on VMs, firewall rules open to 0.0.0.0/0 (especially 22/3389), Cloud Run / Functions with ingress \"all\", Cloud SQL with public IP and broad authorized networks, buckets without public access prevention, GKE without private nodes or master authorized networks;",
				"- single points of failure: single VMs or zonal resources, Cloud SQL without REGIONAL availability or backups;",
				"- missing private connectivity (Private Google Access off, no Cloud NAT for private VMs, services reached over public endpoints), default networks and default service accounts in use;",
				"- anything else worth a human's attention.",
				"Base the notes on the facts below; if you need more detail, use read-only `gcloud ... describe/list` commands with the resource names from the shapes' data. Do not redraw the map.",
			].join("\n"),
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest(
			"Google Cloud resources. Use only read-only gcloud commands (`gcloud <service> ... describe/list`, `gcloud asset search-all-resources`, `gcloud projects get-iam-policy`) with the full resource name, location and project stored on each shape",
			shapes,
			question
		),
};

export const gcpRecipes: Recipe[] = [gcpEnvironmentRecipe];
