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

/** What the Mapper dialog shows: categories and their recipes, without the functions. */
export function catalog(): {
	categories: { id: MapCategory; title: string; description: string }[];
	recipes: { id: string; category: MapCategory; title: string; description: string; mode: Recipe["mode"]; fields: FieldDef[]; canAskAgent: boolean }[];
} {
	return {
		categories: CATEGORIES,
		recipes: allRecipes().map((r) => ({
			id: r.id,
			category: r.category,
			title: r.title,
			description: r.description,
			mode: r.mode,
			fields: r.fields,
			canAskAgent: !!r.agentPrompt,
		})),
	};
}
