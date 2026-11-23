import { omniPageHtml, OmniPageKind, OmniPageOptions } from "../omniPage";

/**
 * The Shape Workshop page is the desktop app's own (standalone/src/renderer/workshop.html):
 * see ../omniPage.ts for how a VS Code webview loads it.
 */

/** The page's file below OMNI_DIR (see editorLook.ts). */
export const WORKSHOP_PAGE = "workshop.html";

const KIND: OmniPageKind = {
	bridge: "omnidrawWorkshop",
	scripts: "window.DrawAIIcons && window.DrawAITips && window.DrawAIBrandmark",
	modules: "window.omnidrawMatrix",
};

/** The page as a VS Code webview loads it. */
export function workshopPageHtml(template: string, options: OmniPageOptions): string {
	return omniPageHtml(template, KIND, options);
}
