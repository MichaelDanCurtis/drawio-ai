import type { Recipe } from "../../types";
import { dbtLineageRecipe } from "./dbt";
import { databaseSchemaRecipe } from "./schema";

export const databaseRecipes: Recipe[] = [databaseSchemaRecipe, dbtLineageRecipe];
