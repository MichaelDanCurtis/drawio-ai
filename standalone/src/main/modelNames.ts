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
