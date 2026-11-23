import { cleanGalleries, DEFAULT_GALLERIES, GalleryConfig } from "../../../standalone/src/main/workshop/types";

/**
 * The Shape Workshop's galleries as the extension keeps them (in its own storage, not in the
 * settings: the list holds folders on this computer).
 *
 * Nothing here imports vscode: the unit tests load it as it is.
 */

/** Where the list is kept in the extension's global state. */
export const GALLERIES_KEY = "drawio-ai.workshop.galleries";

/**
 * The saved galleries. Before anything was saved: the desktop app's three default galleries,
 * switched off. Draw.AI sends nothing anywhere until the user asks for it, and a gallery that
 * is on downloads its index (from jsDelivr) the first time a diagram opens.
 */
export function storedGalleries(raw: unknown): GalleryConfig[] {
	return Array.isArray(raw) ? cleanGalleries(raw) : DEFAULT_GALLERIES.map((g) => ({ ...g, enabled: false }));
}

/** Whether any saved gallery is on (read without loading the Workshop). */
export function anyGalleryOn(raw: unknown): boolean {
	return Array.isArray(raw) && raw.some((g) => g && typeof g === "object" && (g as { enabled?: unknown }).enabled !== false) && storedGalleries(raw).some((g) => g.enabled);
}
