import { app } from "electron";
import { settings, updateSettings, type GalleryConfig } from "../settings";
import { workshopFetch } from "./fetch";
import { GalleryService, type Insertable } from "./galleries";
import { paletteItems as itemsForPalette, searchForEditor as searchGalleries, withDefaultGalleries } from "./palette";
import type { GalleryItem } from "./sources";

let service: GalleryService | undefined;

/** The app's one gallery service (indexes and SVGs cached in the app's data folder). */
export function galleries(): GalleryService {
	if (!service) {
		service = new GalleryService(app.getPath("userData"), workshopFetch);
	}
	return service;
}

export function galleryConfigs(): GalleryConfig[] {
	return settings().workshop.galleries;
}

export function saveGalleries(list: GalleryConfig[]): void {
	updateSettings({ workshop: { ...settings().workshop, galleries: list } });
}

export function restoreDefaultGalleries(): void {
	saveGalleries(withDefaultGalleries(galleryConfigs()));
}

/** A gallery's first page for the shapes sidebar (see palette.ts). */
export function paletteItems(g: GalleryConfig, max = 36): Promise<GalleryItem[]> {
	return itemsForPalette(galleries(), g, max);
}

/** Up to `limit` matches across the enabled galleries, ready for the editor (for draw.io's own search). */
export function searchForEditor(query: string, limit = 24): Promise<Insertable[]> {
	return searchGalleries(galleries(), galleryConfigs(), query, limit);
}
