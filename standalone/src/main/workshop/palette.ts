import type { GalleryService, Insertable } from "./galleries";
import type { GalleryItem } from "./sources";
import { DEFAULT_GALLERIES, type GalleryConfig } from "./types";

/**
 * What the editor shows of the galleries: a first page of each as a palette, and their shapes
 * in draw.io's own search. Nothing here imports Electron (the VS Code extension uses it too).
 */

/** The galleries with the default ones that are missing added back. */
export function withDefaultGalleries(list: GalleryConfig[]): GalleryConfig[] {
	const missing = DEFAULT_GALLERIES.filter((d) => !list.some((g) => g.id === d.id)).map((d) => ({ ...d }));
	return [...list, ...missing];
}

/** One gallery as a palette for the shapes sidebar, or undefined when it has nothing to show (or cannot be read now). */
export async function galleryPalette(s: GalleryService, g: GalleryConfig): Promise<{ title: string; path: string; kind: "gallery"; shapes: Insertable[]; more: number } | undefined> {
	const items = await paletteItems(s, g);
	const shapes = (await Promise.all(items.map((i) => s.insertable(g, i).catch(() => undefined)))).filter((x): x is Insertable => !!x);
	return shapes.length ? { title: g.title, path: `gallery:${g.id}`, kind: "gallery", shapes, more: (await s.items(g)).length - shapes.length } : undefined;
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

const palettePicks = new Map<string, { items: GalleryItem[]; picked: GalleryItem[] }>();

export async function paletteItems(s: GalleryService, g: GalleryConfig, max = 36): Promise<GalleryItem[]> {
	const items = await s.items(g);
	const words = PALETTE_WORDS[g.id];
	if (!words || !items.length) return items.slice(0, max);
	// the same index gives the same picks: only work them out again when it changes
	const memo = palettePicks.get(g.id);
	if (memo && memo.items === items) return memo.picked.slice(0, max);
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
	palettePicks.set(g.id, { items, picked });
	return picked;
}

/** Up to `limit` matches across the enabled galleries, ready for the editor (for draw.io's own search). */
export async function searchForEditor(s: GalleryService, configs: GalleryConfig[], query: string, limit = 24): Promise<Insertable[]> {
	const hits = await s.search(configs, query, { limit });
	const out = await Promise.all(hits.map(async (h) => s.insertable(configs.find((c) => c.id === h.galleryId)!, h.item).catch(() => undefined)));
	return out.filter((x): x is Insertable => !!x);
}
