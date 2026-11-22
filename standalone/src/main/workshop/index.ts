import { app } from "electron";
import { httpRequest } from "../mapper/recipes/ml/shared";
import { settings, updateSettings, DEFAULT_GALLERIES, type GalleryConfig } from "../settings";
import { GalleryService, type Insertable } from "./galleries";
import type { GalleryItem } from "./sources";

let service: GalleryService | undefined;

/** The app's one gallery service (indexes and SVGs cached in the app's data folder). */
export function galleries(): GalleryService {
	if (!service) {
		service = new GalleryService(app.getPath("userData"), async (url, opts) => {
			const r = await httpRequest(url, { timeoutMs: opts.timeoutMs, headers: { Accept: "application/json, image/svg+xml, */*" } });
			return { ok: r.ok, status: r.status, text: r.text, json: r.json };
		});
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
	const list = galleryConfigs();
	const missing = DEFAULT_GALLERIES.filter((d) => !list.some((g) => g.id === d.id)).map((d) => ({ ...d }));
	saveGalleries([...list, ...missing]);
}

/**
 * What a gallery's palette in the shapes sidebar shows: for the built-in galleries the best
 * hit for each of a list of everyday words (a useful first page, not "a-arrow-down"…), for the
 * others their first items.
 */
const PALETTE_WORDS: Record<string, string[]> = {
	thesvg: ["aws", "azure", "google cloud", "kubernetes", "pod", "service", "ingress", "docker", "github", "gitlab", "postgresql", "mysql", "redis", "mongodb", "kafka", "rabbitmq", "nginx", "terraform", "ansible", "jenkins", "grafana", "prometheus", "elastic", "openai", "anthropic", "slack", "stripe", "cloudflare", "vercel", "linux"],
	"tech-logos": ["javascript", "typescript", "python", "java", "go", "rust", "csharp", "react", "angular", "vue", "nodejs", "dotnet", "spring", "django", "postgresql", "mysql", "mongodb", "redis", "docker", "kubernetes", "aws", "azure", "googlecloud", "git", "github", "linux", "nginx", "graphql", "kafka", "terraform"],
	"ui-icons": ["user", "users", "server", "database", "cloud", "lock", "key", "file", "folder", "settings", "search", "mail", "bell", "home", "globe", "shield", "cpu", "network", "wifi", "smartphone", "laptop", "monitor", "chart", "calendar", "clock", "cart", "credit card", "message", "api", "code"],
};

export async function paletteItems(g: GalleryConfig, max = 36): Promise<GalleryItem[]> {
	const s = galleries();
	const items = await s.items(g);
	const words = PALETTE_WORDS[g.id];
	if (!words || !items.length) return items.slice(0, max);
	const picked: GalleryItem[] = [];
	const seen = new Set<string>();
	for (const w of words) {
		const [hit] = await s.search([g], w, { galleryId: g.id, limit: 1 });
		if (hit && !seen.has(hit.item.id)) {
			seen.add(hit.item.id);
			picked.push(hit.item);
		}
		if (picked.length >= max) break;
	}
	return picked;
}

/** Up to `limit` matches across the enabled galleries, ready for the editor (for draw.io's own search). */
export async function searchForEditor(query: string, limit = 24): Promise<Insertable[]> {
	const s = galleries();
	const configs = galleryConfigs();
	const hits = await s.search(configs, query, { limit });
	const out = await Promise.all(hits.map(async (h) => s.insertable(configs.find((c) => c.id === h.galleryId)!, h.item).catch(() => undefined)));
	return out.filter((x): x is Insertable => !!x);
}
