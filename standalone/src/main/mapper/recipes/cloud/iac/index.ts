import type { MapCategory, Recipe } from "../../../types";

/** Maps infrastructure-as-code files in a repository for one cloud (filled in by the IaC collector). */
export function iacRecipes(_category: Extract<MapCategory, "azure" | "aws" | "gcp">): Recipe[] {
	return [];
}
