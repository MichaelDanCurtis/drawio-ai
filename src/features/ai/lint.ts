import {
	edgeSignature,
	isLegendLike,
	isTitleLike,
	LoadedTemplate,
	normalizeColor,
	paletteOf,
	parseStyle,
	shapeRole,
} from "./templates/profile";

export interface LintIssue {
	rule: string;
	severity: "error" | "warning" | "info";
	message: string;
	cellIds: string[];
}

const MAX_PER_RULE = 15;

/** Deterministic diagram checks, plus conformance with the active template. */
export function lintDiagram(model: AiDiagramModel, template?: LoadedTemplate): LintIssue[] {
	const issues: LintIssue[] = [];
	const byId = new Map(model.cells.map((c) => [c.id, c]));
	const vertices = model.cells.filter((c) => c.kind !== "edge");
	const edges = model.cells.filter((c) => c.kind === "edge");
	const isEdgeLabel = (c: AiCell) => !!c.parent && byId.get(c.parent)?.kind === "edge";
	const role = (c: AiCell) => shapeRole(c.style ?? "");
	const isText = (c: AiCell) => role(c) === "text" || /\bedgeLabel\b/.test(c.style ?? "") || isEdgeLabel(c);
	const isIcon = (c: AiCell) => role(c) === "image" || /shape=mxgraph\./.test(c.style ?? "") || /\bimage=/.test(c.style ?? "");

	const absCache = new Map<string, AiRect | undefined>();
	const abs = (c: AiCell): AiRect | undefined => {
		if (absCache.has(c.id)) return absCache.get(c.id);
		let r: AiRect | undefined;
		if (c.geometry) {
			const parent = c.parent ? byId.get(c.parent) : undefined;
			const p = parent && parent.kind !== "edge" ? abs(parent) : undefined;
			r = { ...c.geometry, x: c.geometry.x + (p?.x ?? 0), y: c.geometry.y + (p?.y ?? 0) };
		}
		absCache.set(c.id, r);
		return r;
	};
	const isAncestor = (a: AiCell, b: AiCell) => {
		for (let p = b.parent; p; p = byId.get(p)?.parent) if (p === a.id) return true;
		return false;
	};
	const name = (c: AiCell) => (c.label ? `"${c.label.slice(0, 40)}"` : `${c.kind} ${c.id}`);
	const push = (rule: string, severity: LintIssue["severity"], message: string, cellIds: string[]) => {
		if (issues.filter((i) => i.rule === rule).length < MAX_PER_RULE) issues.push({ rule, severity, message, cellIds });
	};

	// Dangling connectors
	for (const e of edges) {
		if (!e.source || !e.target) {
			const end = !e.source && !e.target ? "either end" : !e.source ? "its source" : "its target";
			push("dangling-edge", "error", `Connector ${name(e)} is not attached at ${end}.`, [e.id]);
		}
	}

	// Duplicate connectors
	const seen = new Map<string, string>();
	for (const e of edges) {
		if (!e.source || !e.target) continue;
		const key = `${e.source}->${e.target}|${e.label}`;
		const first = seen.get(key);
		if (first) push("duplicate-edge", "warning", `Duplicate connector between ${name(byId.get(e.source)!)} and ${name(byId.get(e.target)!)}.`, [first, e.id]);
		else seen.set(key, e.id);
	}

	// Overlapping shapes (siblings only; containment is intentional)
	const boxes = vertices
		.filter((c) => !isText(c) && !isEdgeLabel(c))
		.map((c) => ({ c, r: abs(c) }))
		.filter((x): x is { c: AiCell; r: AiRect } => !!x.r && x.r.width > 0 && x.r.height > 0);
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (a.c.parent !== b.c.parent || isAncestor(a.c, b.c) || isAncestor(b.c, a.c)) continue;
			const w = Math.min(a.r.x + a.r.width, b.r.x + b.r.width) - Math.max(a.r.x, b.r.x);
			const h = Math.min(a.r.y + a.r.height, b.r.y + b.r.height) - Math.max(a.r.y, b.r.y);
			if (w <= 0 || h <= 0) continue;
			const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
			if ((w * h) / smaller > 0.1) push("overlap", "warning", `${name(a.c)} overlaps ${name(b.c)}.`, [a.c.id, b.c.id]);
		}
	}

	// Nearly (but not exactly) aligned siblings
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (a.c.parent !== b.c.parent) continue;
			const dx = Math.abs(a.r.x + a.r.width / 2 - (b.r.x + b.r.width / 2));
			const dy = Math.abs(a.r.y + a.r.height / 2 - (b.r.y + b.r.height / 2));
			// Same row (side by side) but centres differ slightly vertically, or same column horizontally.
			const off =
				dy > 0.5 && dy <= 6 && dx >= (a.r.width + b.r.width) / 2
					? dy
					: dx > 0.5 && dx <= 6 && dy >= (a.r.height + b.r.height) / 2
					? dx
					: 0;
			if (off) {
				push("misaligned", "info", `${name(a.c)} and ${name(b.c)} are almost aligned (off by ${Math.round(off * 10) / 10}px).`, [a.c.id, b.c.id]);
			}
		}
	}

	// Unlabeled shapes and empty containers
	const hasChildren = new Set(model.cells.map((c) => c.parent).filter(Boolean));
	for (const c of vertices) {
		if (isText(c) || isIcon(c) || hasChildren.has(c.id) || c.label) continue;
		if (c.kind === "container" || c.kind === "group") push("empty-container", "info", `Container ${c.id} is empty.`, [c.id]);
		else push("unlabeled-shape", "info", `Shape ${c.id} (${role(c)}) has no label.`, [c.id]);
	}

	// Disconnected shapes in an otherwise connected diagram
	if (edges.length >= 3) {
		const connected = new Set(edges.flatMap((e) => [e.source, e.target]).filter(Boolean));
		for (const c of vertices) {
			if (connected.has(c.id) || isText(c) || c.kind !== "vertex" || hasChildren.has(c.id) || isEdgeLabel(c)) continue;
			if (isLegendLike(c.label, c.style ?? "") || (c.parent && /legend/i.test(byId.get(c.parent)?.label ?? ""))) continue;
			push("disconnected", "info", `${name(c)} is not connected to anything.`, [c.id]);
		}
	}

	// Tiny text
	for (const c of model.cells) {
		const size = Number(parseStyle(c.style ?? "").props.fontSize);
		if (c.label && size > 0 && size < 8) push("tiny-text", "warning", `${name(c)} uses a ${size}px font, which is hard to read.`, [c.id]);
	}

	if (template) issues.push(...templateIssues(model, template));
	return issues;
}

function templateIssues(model: AiDiagramModel, t: LoadedTemplate): LintIssue[] {
	const out: LintIssue[] = [];
	const { enforce, profile } = t.manifest;
	const tag = `template "${t.manifest.name}"`;

	if (enforce.palette) {
		const palette = paletteOf(profile);
		if (palette.size > 0) {
			const offenders = new Map<string, string[]>();
			for (const c of model.cells) {
				const { props } = parseStyle(c.style ?? "");
				for (const key of c.kind === "edge" ? ["strokeColor", "fontColor"] : ["fillColor", "strokeColor", "fontColor"]) {
					const color = normalizeColor(props[key]);
					if (color && /^#[0-9a-f]{6}$/.test(color) && !palette.has(color)) {
						offenders.set(color, [...(offenders.get(color) ?? []), c.id]);
					}
				}
			}
			for (const [color, ids] of offenders) {
				const unique = [...new Set(ids)];
				const near = nearestColor(color, [...palette]);
				out.push({
					rule: "template-palette",
					severity: "warning",
					message: `Colour ${color} is not in the ${tag} palette (${unique.length} item${unique.length === 1 ? "" : "s"})${near ? `; closest palette colour: ${near}` : ""}.`,
					cellIds: unique,
				});
			}
		}
	}

	if (enforce.fonts && profile.fonts.length > 0) {
		const allowed = new Set(profile.fonts.map((f) => f.value.toLowerCase()));
		const offenders = new Map<string, string[]>();
		for (const c of model.cells) {
			const family = parseStyle(c.style ?? "").props.fontFamily;
			if (family && !allowed.has(family.toLowerCase())) offenders.set(family, [...(offenders.get(family) ?? []), c.id]);
		}
		for (const [family, ids] of offenders) {
			out.push({ rule: "template-font", severity: "warning", message: `Font "${family}" is not used by ${tag} (expected ${profile.fonts[0].value}).`, cellIds: ids });
		}
	}

	const expected = profile.edgeStyles[0]?.value;
	if (enforce.edges && expected && expected !== "(default)") {
		const want = parseStyle(expected).props;
		const keys = ["edgeStyle", "curved", "rounded", "dashed", "endArrow", "startArrow"].filter((k) => want[k] !== undefined);
		const ids = model.cells
			.filter((c) => c.kind === "edge")
			.filter((c) => {
				const got = parseStyle(edgeSignature(c.style ?? "")).props;
				return keys.some((k) => (got[k] ?? defaultEdge[k]) !== want[k]);
			})
			.map((c) => c.id);
		if (ids.length) {
			out.push({
				rule: "template-edges",
				severity: "warning",
				message: `${ids.length} connector${ids.length === 1 ? " does" : "s do"} not use the ${tag} connector style (${keys.map((k) => `${k}=${want[k]}`).join(";")}).`,
				cellIds: ids,
			});
		}
	}

	const labelled = model.cells.filter((c) => c.kind !== "edge" && c.label);
	const maxFont = Math.max(0, ...labelled.map((c) => Number(parseStyle(c.style ?? "").props.fontSize) || 0));
	if (enforce.title && labelled.length > 0 && !labelled.some((c) => isTitleLike(c.label, c.style ?? "", maxFont))) {
		out.push({ rule: "template-title", severity: "warning", message: `The diagram has no title (required by ${tag}).`, cellIds: [] });
	}
	if (enforce.legend && labelled.length > 0 && !model.cells.some((c) => isLegendLike(c.label, c.style ?? ""))) {
		out.push({ rule: "template-legend", severity: "warning", message: `The diagram has no legend (required by ${tag}).`, cellIds: [] });
	}
	return out;
}

const defaultEdge: Record<string, string> = { rounded: "0", curved: "0", dashed: "0", endArrow: "classic", startArrow: "none" };

function nearestColor(color: string, palette: string[]): string | undefined {
	const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
	const [r, g, b] = rgb(color);
	let best: string | undefined;
	let bestD = Infinity;
	for (const p of palette) {
		if (!/^#[0-9a-f]{6}$/.test(p)) continue;
		const [pr, pg, pb] = rgb(p);
		const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
		if (d < bestD) {
			bestD = d;
			best = p;
		}
	}
	return best;
}

export function formatIssues(issues: LintIssue[]): string {
	if (issues.length === 0) return "No issues found.";
	return issues
		.map((i, n) => `${n + 1}. [${i.severity}] ${i.message}${i.cellIds.length ? ` (ids: ${i.cellIds.slice(0, 12).join(", ")})` : ""}`)
		.join("\n");
}
