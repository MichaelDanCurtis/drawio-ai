import type { Recipe } from "../../types";
import { apiRecipe } from "./api";
import { classesRecipe, modulesRecipe } from "./codeStructure";
import { connectivityRecipe, dataflowRecipe } from "./connectivity";
import { githubActionsRecipe } from "./githubActions";
import { kubernetesRecipe } from "./kubernetes";

export const softwareRecipes: Recipe[] = [connectivityRecipe, dataflowRecipe, githubActionsRecipe, apiRecipe, modulesRecipe, classesRecipe, kubernetesRecipe];
