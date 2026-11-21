import type { Recipe } from "../../types";
import { awsRecipes as aws } from "./aws";
import { azureRecipes as azure } from "./azure";
import { gcpRecipes as gcp } from "./gcp";
import { iacRecipes } from "./iac";

export const azureRecipes: Recipe[] = [...azure, ...iacRecipes("azure")];
export const awsRecipes: Recipe[] = [...aws, ...iacRecipes("aws")];
export const gcpRecipes: Recipe[] = [...gcp, ...iacRecipes("gcp")];
