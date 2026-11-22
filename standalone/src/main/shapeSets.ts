/**
 * draw.io's own shape sets (General, UML, AWS…): what its "More Shapes" dialog chose between.
 * In OmniDraw they are switches in the Shape Workshop, next to the galleries; the editor
 * reports them and the app passes the list on.
 */
/**
 * draw.io's saved storage, ready for an editor page: with a Scratchpad in it. A profile from
 * before the Scratchpad was kept here names it in draw.io's settings but has no shapes for it;
 * draw.io then fails to load it and drops it from the sidebar for good. An empty one loads.
 */
export function withScratchpad(storage: Record<string, string>): Record<string, string> {
	if (typeof storage[".scratchpad"] !== "string" || !/^\s*<mxlibrary[\s>]/.test(storage[".scratchpad"])) storage[".scratchpad"] = "<mxlibrary>[]</mxlibrary>";
	return storage;
}

export interface ShapeSetGroup {
	title: string;
	entries: { id: string; title: string; on: boolean }[];
}

/** What an editor page says its shape sets are, kept to plain short strings and booleans. */
export function cleanShapeSets(groups: unknown[]): ShapeSetGroup[] {
	const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : "");
	const out: ShapeSetGroup[] = [];
	for (const g of groups.slice(0, 40) as any[]) {
		if (!g || !Array.isArray(g.entries)) continue;
		const entries = (g.entries as any[]).slice(0, 200).filter((e) => e && /^[\w.-]{1,60}$/.test(String(e.id))).map((e) => ({ id: String(e.id), title: text(e.title) || String(e.id), on: !!e.on }));
		if (entries.length) out.push({ title: text(g.title) || "Shapes", entries });
	}
	return out;
}
