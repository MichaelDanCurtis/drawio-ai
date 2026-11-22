import { awsRecipes, azureRecipes, gcpRecipes } from "./recipes/cloud";
import { databaseRecipes } from "./recipes/database";
import { mlRecipes } from "./recipes/ml";
import { softwareRecipes } from "./recipes/software";
import { CATEGORIES, FieldDef, MapCategory, Recipe } from "./types";

export function allRecipes(): Recipe[] {
	return [...softwareRecipes, ...databaseRecipes, ...azureRecipes, ...awsRecipes, ...gcpRecipes, ...mlRecipes];
}

export function recipeById(id: string): Recipe | undefined {
	return allRecipes().find((r) => r.id === id);
}

/** A few words for each map's card in the dialog (the full description shows once it is picked). */
const BLURBS: Record<string, string> = {
	"software.connectivity": "What talks to what",
	"software.dataflow": "How data moves",
	"software.github-actions": "Jobs, triggers and order",
	"software.api": "Endpoints and their types",
	"software.modules": "Which module imports which",
	"software.classes": "Classes and how they relate",
	"software.kubernetes": "Workloads, services and ingress",
	"database.schema": "Tables, keys and relations",
	"database.dbt-lineage": "Models and where they come from",
	"azure.environment": "Networks, subnets and resources",
	"azure.iac": "Terraform, Bicep and ARM files",
	"aws.environment": "VPCs, subnets and services",
	"aws.iac": "Terraform, CloudFormation, CDK",
	"gcp.environment": "Networks, regions and resources",
	"gcp.iac": "Terraform, Deployment Manager",
	"ml.pipeline": "Steps from data to model",
	"ml.mlflow": "Experiments, runs, registry",
	"ml.lifecycle": "Data to serving, end to end",
	"ml.model": "A model's blocks and layers",
};

function firstClause(text: string): string {
	const t = text.split(/[.:;(]/)[0].trim();
	return t.length > 32 ? `${t.slice(0, 30).trimEnd()}…` : t;
}

/** What the Mapper dialog shows: categories and their recipes, without the functions. */
export function catalog(): {
	categories: { id: MapCategory; title: string; description: string }[];
	recipes: { id: string; category: MapCategory; title: string; blurb: string; description: string; mode: Recipe["mode"]; fields: FieldDef[]; canAskAgent: boolean }[];
} {
	return {
		categories: CATEGORIES,
		recipes: allRecipes().map((r) => ({
			id: r.id,
			category: r.category,
			title: r.title,
			blurb: BLURBS[r.id] ?? firstClause(r.description),
			description: r.description,
			mode: r.mode,
			fields: r.fields,
			canAskAgent: !!r.agentPrompt,
		})),
	};
}
