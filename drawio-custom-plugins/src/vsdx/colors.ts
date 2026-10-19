/**
 * draw.io stores colors as light-dark(light, dark) (even in light mode), may use
 * var(--x, fallback), "default" and "none", and CSS color names. Visio needs #RRGGBB.
 */

/** Splits "a, b(c, d), e" at top-level commas. */
function splitArgs(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			out.push(s.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(s.slice(start).trim());
	return out;
}

function fnArgs(s: string, name: string): string[] | undefined {
	if (s.toLowerCase().startsWith(name + "(") && s.endsWith(")")) {
		return splitArgs(s.slice(name.length + 1, -1));
	}
	return undefined;
}

let ctx: CanvasRenderingContext2D | null | undefined;

function cssToHex(s: string): string | undefined {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
	if (hex) {
		let h = hex[1];
		if (h.length === 3) h = h.split("").map((c) => c + c).join("");
		return "#" + h.slice(0, 6).toUpperCase();
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
	if (rgb) {
		if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) {
			return "none";
		}
		return (
			"#" +
			[rgb[1], rgb[2], rgb[3]]
				.map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))).toString(16).padStart(2, "0"))
				.join("")
				.toUpperCase()
		);
	}
	if (typeof document === "undefined") {
		return undefined;
	}
	// Named colors: let the browser normalize them.
	if (ctx === undefined) {
		ctx = document.createElement("canvas").getContext("2d");
	}
	if (!ctx) {
		return undefined;
	}
	const sentinel = "#010203";
	ctx.fillStyle = sentinel;
	ctx.fillStyle = s;
	const normalized = String(ctx.fillStyle);
	if (normalized === sentinel && s.toLowerCase() !== sentinel) {
		return undefined;
	}
	return normalized === s ? undefined : cssToHex(normalized);
}

/**
 * Returns "#RRGGBB", "none", or undefined when the value is unset, "default"
 * (the caller decides) or not a color.
 */
export function resolveColor(value: unknown): string | undefined {
	if (value == null) {
		return undefined;
	}
	const s = String(value).trim();
	if (!s || s === "default" || s === "inherit") {
		return undefined;
	}
	if (s === "none" || s === "transparent") {
		return "none";
	}
	const lightDark = fnArgs(s, "light-dark");
	if (lightDark) {
		return resolveColor(lightDark[0]);
	}
	const cssVar = fnArgs(s, "var");
	if (cssVar) {
		return cssVar.length > 1 ? resolveColor(cssVar.slice(1).join(",")) : undefined;
	}
	return cssToHex(s);
}
