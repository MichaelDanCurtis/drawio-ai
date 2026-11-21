import type { Recipe } from "../../types";
import { lifecycleRecipe } from "./lifecycle";
import { mlflowRecipe } from "./mlflow";
import { modelRecipe } from "./model";
import { mlPipelineRecipe } from "./pipeline";

export const mlRecipes: Recipe[] = [mlPipelineRecipe, mlflowRecipe, lifecycleRecipe, modelRecipe];
