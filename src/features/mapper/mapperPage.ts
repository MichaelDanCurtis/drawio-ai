import { omniPageHtml, OmniPageKind, OmniPageOptions, pageNonce } from "../omniPage";

/**
 * The Map Something page is the desktop app's own (standalone/src/renderer/mapper.html): see
 * ../omniPage.ts for how a VS Code webview loads it.
 */

/** The page's file below OMNI_DIR (see editorLook.ts). */
export const MAPPER_PAGE = "mapper.html";

const KIND: OmniPageKind = {
	bridge: "drawaiMapper",
	scripts: "window.DrawAIIcons && window.DrawAIBrands && window.DrawAITips && window.DrawAIBrandmark",
	modules: 'window.omnidrawMatrix && typeof window.drawaiPulse === "function"',
};

export type MapperPageOptions = OmniPageOptions;

/** The page as a VS Code webview loads it. */
export function mapperPageHtml(template: string, options: MapperPageOptions): string {
	return omniPageHtml(template, KIND, options);
}

export { pageNonce };
