import * as path from "path";
import { digDeeperRequest, FOLDER_FIELD, folderInput } from "../../common";
import type { MapCategory, Recipe } from "../../../types";
import { MapperError } from "../../../types";
import { CLOUD_NAMES, iacToGraph } from "./graph";
import { scanIac } from "./scan";

export { scanIac } from "./scan";
export { iacToGraph, shortType, iacFindings } from "./graph";
export { parseTerraform, maskHcl, terraformBlocks } from "./terraform";
export { parseCloudFormation, loadTemplate, cfnRefs } from "./cloudformation";
export { parseBicep } from "./bicep";
export { parseArm } from "./arm";
export { parseDeploymentManager } from "./deploymentManager";

const TOOLS: Record<"aws" | "azure" | "gcp", string> = {
	aws: "Terraform (aws_*), CloudFormation, SAM and CDK (cdk.out) templates",
	azure: "Terraform (azurerm_*), Bicep and ARM templates",
	gcp: "Terraform (google_*) and Deployment Manager configs",
};

/** Maps infrastructure-as-code files in a repository for one cloud. */
export function iacRecipes(category: Extract<MapCategory, "azure" | "aws" | "gcp">): Recipe[] {
	const cloud = category;
	const name = CLOUD_NAMES[cloud];
	return [
		{
			id: `${cloud}.iac`,
			category,
			title: "Infrastructure as code in a repo",
			description: `${name} resources declared in ${TOOLS[cloud]}: grouped by module / stack / template, with the references between them. Reads files only.`,
			mode: "inventory",
			fields: [{ ...FOLDER_FIELD, help: `The repository (or folder) with the IaC files. ${FOLDER_FIELD.help}` }],
			async collect(input, ctx) {
				const root = folderInput(input, ctx.cwd);
				ctx.progress("Looking for IaC files…");
				const scan = scanIac(root, ctx.signal, ctx.progress);
				if (ctx.signal.aborted) throw new MapperError("Cancelled");
				const map = iacToGraph(scan, cloud, path.basename(root) || root);
				const drawn = map.graph.nodes.some((n) => !n.container);
				return { graph: drawn ? map.graph : undefined, facts: drawn ? map.facts : undefined, summary: map.summary, warnings: map.warnings };
			},
			agentPrompt: () =>
				`Review the ${name} infrastructure-as-code map on this page as an architect. The shapes carry the file and line of each declaration (file, line, address, type): read those definitions and add short review notes next to the shapes they concern — public exposure (open security rules, public access settings), single points of failure (single instances, single-AZ / non-zonal databases), missing encryption or TLS settings, risky defaults, and dependencies that are missing from the map (for example resources referenced through variables or remote state). Do not change any files.`,
			digDeeper: (shapes, question) =>
				digDeeperRequest(
					`${name} infrastructure-as-code resources (read each selected resource's definition at the file and line stored on the shape, follow the variables, modules and references it uses, and explain what it creates and how it is configured; read files only, change nothing)`,
					shapes,
					question
				),
		},
	];
}
