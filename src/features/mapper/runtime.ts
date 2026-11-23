/**
 * The Mapper itself is the desktop app's code, used as it is (standalone/src/main/mapper has
 * nothing of Electron in it): recipes that collect read-only, the layout, the drawing, the
 * records next to the diagram, the lookups and the tools.
 *
 * Imported with `await import("./runtime")`, so the recipes are only run through when the
 * Mapper is first used.
 */
export { createContext } from "../../../standalone/src/main/mapper/context";
export { MapperDialogCore } from "../../../standalone/src/main/mapper/dialog";
export { mappedSelection, mapsOnPage } from "../../../standalone/src/main/mapper/draw";
export { callMapperTool } from "../../../standalone/src/main/mapper/mcpTools";
export { askPrompt, describePrompt, fixFindingPrompt, tourPrompt } from "../../../standalone/src/main/mapper/prompts";
export { digDeeperRequest, setToolSource } from "../../../standalone/src/main/mapper/recipes/common";
export { catalog, recipeById } from "../../../standalone/src/main/mapper/registry";
export { MapperService, SEVERITY } from "../../../standalone/src/main/mapper/service";
export { activeFindings, adoptRecords } from "../../../standalone/src/main/mapper/store";
export { MapperError } from "../../../standalone/src/main/mapper/types";
