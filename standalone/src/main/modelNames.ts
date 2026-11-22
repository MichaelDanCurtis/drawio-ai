/**
 * "Opus" → "Opus 4.7" when the agent says which version it is (in the description or the
 * value, e.g. "claude-opus-4-7"): several versions of a family can be on offer.
 */
export function versionedName(name: string, value: string, description?: string | null): string {
	if (/\d/.test(name)) return name;
	const family = name.replace(/\s*\(.*\)\s*$/, "").trim().split(/\s+/).pop() ?? "";
	if (!family || !/^[a-z][a-z-]*$/i.test(family)) return name;
	const re = new RegExp(`\\b${family}[-\\s]+(\\d+(?:[-.]\\d+)?)`, "i");
	for (const source of [description ?? "", value]) {
		const m = re.exec(source);
		if (m) return name.replace(new RegExp(`\\b${family}\\b`, "i"), `${family} ${m[1].replace("-", ".")}`);
	}
	return name;
}

/** What a model list needs from a session (ACP's config options and modes). */
export interface ModelSource {
	configOptions?: readonly any[] | null;
	modes?: { availableModes?: readonly { id: string; name: string; description?: string | null }[]; currentModeId?: string } | null;
}

export interface ListedModel {
	/** What pickModel takes ("opt:<option>:<value>" or "mode:<id>"). */
	id: string;
	/** What Settings stores (hidden / preferred). */
	value: string;
	name: string;
	description?: string;
}

/** The models (or modes) an agent's session offers, with versions in their names. */
export function modelsFromSession(info: ModelSource | undefined): { models: ListedModel[]; current?: string; currentId?: string } {
	const models: ListedModel[] = [];
	const modelOption = info?.configOptions?.find((o) => o.type === "select" && (o.category === "model" || /model/i.test(o.id)));
	if (modelOption && modelOption.type === "select") {
		for (const entry of modelOption.options as any[]) {
			const opts = "group" in entry ? entry.options : [entry];
			for (const o of opts) {
				const value = String(o.value);
				models.push({ id: `opt:${modelOption.id}:${value}`, value, name: versionedName(String(o.name ?? value), value, o.description), description: o.description ?? undefined });
			}
		}
		const current = String(modelOption.currentValue);
		return { models, current, currentId: `opt:${modelOption.id}:${current}` };
	}
	if (info?.modes?.availableModes?.length) {
		for (const m of info.modes.availableModes) models.push({ id: `mode:${m.id}`, value: `mode:${m.id}`, name: `Mode: ${m.name}`, description: m.description ?? undefined });
		return { models, current: `mode:${info.modes.currentModeId}`, currentId: `mode:${info.modes.currentModeId}` };
	}
	return { models };
}
