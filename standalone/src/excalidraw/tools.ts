// The tools an agent has for an Excalidraw drawing: what they are called, what they take, and
// the check of what a model sent before any of it reaches the editor. Nothing of Electron or of
// the page here: the app's main process, the editor page and the tests all load this file.

/** A tool as the Model Context Protocol lists it (the shape src/features/ai/mcp.ts takes). */
export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
	/** Its answer is a picture: only for models that take pictures. */
	picture?: boolean;
}

/** What a model sent is not what the tool takes; the message is for the model, to try again. */
export class ToolInputError extends Error {}

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond"] as const;
export const LINE_TYPES = ["arrow", "line"] as const;
export const ELEMENT_TYPES = [...SHAPE_TYPES, "text", ...LINE_TYPES] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"] as const;
const STROKE_STYLES = ["solid", "dashed", "dotted"] as const;
const FONTS = ["hand", "normal", "code"] as const;
const ALIGN = ["left", "center", "right"] as const;
const VALIGN = ["top", "middle", "bottom"] as const;
const ARROWHEADS = ["none", "arrow", "triangle", "bar", "dot", "diamond"] as const;
const CORNERS = ["round", "sharp"] as const;

/** How an element looks: the same names Excalidraw's own panel uses. Every one is optional. */
export interface Style {
	strokeColor?: string;
	backgroundColor?: string;
	fillStyle?: (typeof FILL_STYLES)[number];
	strokeWidth?: number;
	strokeStyle?: (typeof STROKE_STYLES)[number];
	roughness?: number;
	opacity?: number;
	corners?: (typeof CORNERS)[number];
	fontSize?: number;
	fontFamily?: (typeof FONTS)[number];
	textAlign?: (typeof ALIGN)[number];
	verticalAlign?: (typeof VALIGN)[number];
	startArrowhead?: (typeof ARROWHEADS)[number];
	endArrowhead?: (typeof ARROWHEADS)[number];
	/** Degrees, clockwise. */
	angle?: number;
	locked?: boolean;
	link?: string | null;
	groupIds?: string[];
}

export interface AddOp extends Style {
	op: "add";
	type: ElementType;
	/** The new element's id (others in the same call can name it). One is made when none is given. */
	id?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	/** The words of a text element. */
	text?: string;
	/** The words written in a shape or on a line. */
	label?: string;
	/** A line's ends: the id of the element each one is attached to. */
	start?: string;
	end?: string;
	/** A line's points, as [x, y] on the drawing; needed only for a line that is not attached at both ends, or that bends. */
	points?: [number, number][];
}

export interface UpdateOp extends Style {
	op: "update";
	id: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	text?: string;
	label?: string;
	/** null lets that end go. */
	start?: string | null;
	end?: string | null;
	points?: [number, number][];
}

export interface DeleteOp {
	op: "delete";
	id: string;
}

export type Operation = AddOp | UpdateOp | DeleteOp;

export const MAX_OPERATIONS = 400;
const MAX_TEXT = 20_000;
const MAX_POINTS = 200;
const MAX_ID = 80;
const LIMIT = 1_000_000;

const STYLE_SCHEMA: Record<string, unknown> = {
	strokeColor: { type: "string", description: 'Line and text colour, e.g. "#1e1e1e" (the default), "#e03131", "#1971c2", "#2f9e44", "#f08c00".' },
	backgroundColor: { type: "string", description: 'Fill colour, e.g. "#ffc9c9", "#a5d8ff", "#b2f2bb", "#ffec99", or "transparent" (the default).' },
	fillStyle: { type: "string", enum: [...FILL_STYLES] },
	strokeWidth: { type: "number", description: "1 (thin), 2 (the default) or 4 (bold)." },
	strokeStyle: { type: "string", enum: [...STROKE_STYLES] },
	roughness: { type: "number", description: "0 (clean lines), 1 (hand-drawn, the default) or 2 (sketchier)." },
	opacity: { type: "number", description: "0 to 100." },
	corners: { type: "string", enum: [...CORNERS], description: "Of a rectangle or diamond, or how a line bends." },
	fontSize: { type: "number", description: "Of a text element or a label: 16 (small), 20 (the default), 28 (large), 36 (very large)." },
	fontFamily: { type: "string", enum: [...FONTS], description: '"hand" (hand-drawn, the default), "normal" or "code".' },
	textAlign: { type: "string", enum: [...ALIGN] },
	verticalAlign: { type: "string", enum: [...VALIGN] },
	startArrowhead: { type: "string", enum: [...ARROWHEADS] },
	endArrowhead: { type: "string", enum: [...ARROWHEADS], description: 'An arrow ends in "arrow" unless told otherwise.' },
	angle: { type: "number", description: "Rotation in degrees, clockwise." },
	locked: { type: "boolean" },
	link: { type: "string", description: "A web address the element links to." },
	groupIds: { type: "array", items: { type: "string" }, description: "Elements with the same group id move as one. Any string names a group." },
};

/** The tools, as an agent sees them. */
export const EXCALIDRAW_TOOLS: ToolDefinition[] = [
	{
		name: "excalidraw_get_scene",
		title: "Read the Excalidraw Drawing",
		readOnly: true,
		description:
			"Read the open Excalidraw drawing: its elements with id, type, position, size, text and what each line is attached to. A shape's label is given with the shape (`label`), not as an element of its own. Call this before changing anything, unless this turn already returned the current state.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["all", "selection"], description: 'What to read: "all" (the default) or only what the user has selected.' },
				ids: { type: "array", items: { type: "string" }, description: "Read only these elements." },
				query: { type: "string", description: "Read only elements whose text, label, type or id contains this (case does not matter)." },
				includeStyles: { type: "boolean", description: "Also give every element's colours, line and font settings. Off by default: only colours that are not the default are given." },
				maxElements: { type: "number", description: "At most this many elements (default 400)." },
			},
		},
	},
	{
		name: "excalidraw_apply_operations",
		title: "Change the Excalidraw Drawing",
		readOnly: false,
		description:
			'Change the drawing with a list of operations, applied in order as one step (if one fails, none is applied; fix it and send the whole list again). Operations: {"op":"add","type":"rectangle"|"ellipse"|"diamond"|"text"|"arrow"|"line", ...}, {"op":"update","id":..., ...what to change}, {"op":"delete","id":...}. Give a shape its words with `label`; do not add a text element on top of it. Connect two elements with {"op":"add","type":"arrow","start":"<id>","end":"<id>"}: the arrow is routed between them, stays attached, and follows them when you move them (a "line" is drawn between them but not attached). An `id` you give a new element can be used by later operations in the same call. The user sees every change at once and can keep or revert it.',
		inputSchema: {
			type: "object",
			required: ["operations"],
			properties: {
				operations: {
					type: "array",
					description: `The operations, at most ${MAX_OPERATIONS}.`,
					items: {
						type: "object",
						required: ["op"],
						properties: {
							op: { type: "string", enum: ["add", "update", "delete"] },
							type: { type: "string", enum: [...ELEMENT_TYPES], description: "add: what to add." },
							id: { type: "string", description: "add: the new element's id (optional). update, delete: the element." },
							x: { type: "number", description: "Left edge, in pixels; x grows to the right." },
							y: { type: "number", description: "Top edge, in pixels; y grows downwards." },
							width: { type: "number", description: "A shape's width (default 160). A labelled shape without width and height is made to fit its label." },
							height: { type: "number", description: "A shape's height (default 80)." },
							text: { type: "string", description: "The words of a text element. Use \\n for a new line." },
							label: { type: "string", description: "The words in a shape or on an arrow or line." },
							start: { type: "string", description: "An arrow or line: the id of the element it starts at. update: an empty string detaches that end." },
							end: { type: "string", description: "An arrow or line: the id of the element it ends at. update: an empty string detaches that end." },
							points: {
								type: "array",
								items: { type: "array", items: { type: "number" } },
								description: "An arrow or line: its points as [x, y] on the drawing, first to last. Needed only when an end is not attached, or to make it bend.",
							},
							...STYLE_SCHEMA,
						},
					},
				},
				select: { type: "boolean", description: "Select what was added or changed afterwards (default false)." },
			},
		},
	},
	{
		name: "excalidraw_select",
		title: "Select in the Excalidraw Drawing",
		readOnly: true,
		description: "Select elements for the user and bring them into view. An empty list clears the selection.",
		inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } },
	},
	{
		name: "excalidraw_render_image",
		title: "Render the Excalidraw Drawing",
		readOnly: true,
		picture: true,
		description: "Render the drawing (or only the given elements) to a PNG, to check layout, overlaps and readability after a change.",
		inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } },
	},
	{
		name: "excalidraw_from_mermaid",
		title: "Add a Mermaid Diagram to the Excalidraw Drawing",
		readOnly: false,
		description:
			"Add a diagram written in Mermaid to the drawing, as editable Excalidraw shapes: a quick way to lay out a flowchart (flowchart TD / LR), which becomes shapes and arrows. Other kinds of Mermaid diagram (sequence, class, ...) are added as one picture. It is placed in free space beside what is there unless x and y say where. Returns the ids of what was added.",
		inputSchema: {
			type: "object",
			required: ["definition"],
			properties: {
				definition: { type: "string", description: 'The Mermaid text, e.g. "flowchart LR\\n  A[Start] --> B{Ready?}\\n  B -- yes --> C[Go]".' },
				x: { type: "number", description: "Left edge of where to put it." },
				y: { type: "number", description: "Top edge of where to put it." },
			},
		},
	},
	{
		name: "excalidraw_export",
		title: "Export the Excalidraw Drawing",
		readOnly: false,
		description:
			"Write the drawing to a file: a PNG or SVG picture (with the drawing inside it, so it opens again for editing), or a .excalidraw file. Written next to the drawing unless a path is given. An existing file is only replaced with overwrite: true, and the user is asked.",
		inputSchema: {
			type: "object",
			required: ["format"],
			properties: {
				format: { type: "string", enum: ["png", "svg", "excalidraw"] },
				path: { type: "string", description: "Where to write it: absolute, or relative to the drawing's folder." },
				overwrite: { type: "boolean" },
			},
		},
	},
];

/** A tool's arguments as an object: models send them as an object, or as that object written as text. */
export function inputObject(raw: unknown): Record<string, unknown> {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = value.trim() ? JSON.parse(value) : {};
		} catch {
			throw new ToolInputError("The arguments are not JSON.");
		}
	}
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new ToolInputError("The arguments must be an object.");
	return value as Record<string, unknown>;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && isFinite(v) && Math.abs(v) <= LIMIT;

/** A list of ids, when given: strings, none empty. */
export function idList(value: unknown, name: string, max = 2000): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v || v.length > MAX_ID)) throw new ToolInputError(`${name} must be a list of element ids.`);
	if (value.length > max) throw new ToolInputError(`${name} takes at most ${max} ids.`);
	return [...new Set(value as string[])];
}

/** The style settings in what a model sent, checked. `where` names the operation in a message. */
function styleOf(o: Record<string, unknown>, where: string, problems: string[]): Style {
	const style: Style = {};
	const oneOf = <K extends keyof Style>(key: K, allowed: readonly string[]) => {
		if (o[key] === undefined) return;
		if (typeof o[key] !== "string" || !allowed.includes(o[key] as string)) problems.push(`${where}: ${key} must be one of ${allowed.join(", ")}.`);
		else (style as any)[key] = o[key];
	};
	const colour = (key: "strokeColor" | "backgroundColor") => {
		if (o[key] === undefined) return;
		const v = o[key];
		// (a colour as CSS names it: a hex value, a name, or transparent)
		if (typeof v !== "string" || !/^(#[0-9a-f]{3,8}|[a-z]{3,30})$/i.test(v.trim())) problems.push(`${where}: ${key} must be a colour such as "#1971c2" or "transparent".`);
		else style[key] = v.trim();
	};
	const number = (key: "strokeWidth" | "roughness" | "opacity" | "fontSize" | "angle", min: number, max: number) => {
		if (o[key] === undefined) return;
		if (!isNumber(o[key]) || (o[key] as number) < min || (o[key] as number) > max) problems.push(`${where}: ${key} must be a number from ${min} to ${max}.`);
		else style[key] = o[key] as number;
	};
	colour("strokeColor");
	colour("backgroundColor");
	oneOf("fillStyle", FILL_STYLES);
	oneOf("strokeStyle", STROKE_STYLES);
	oneOf("corners", CORNERS);
	oneOf("fontFamily", FONTS);
	oneOf("textAlign", ALIGN);
	oneOf("verticalAlign", VALIGN);
	oneOf("startArrowhead", ARROWHEADS);
	oneOf("endArrowhead", ARROWHEADS);
	number("strokeWidth", 0.5, 16);
	number("roughness", 0, 2);
	number("opacity", 0, 100);
	number("fontSize", 4, 400);
	number("angle", -360, 360);
	if (o.locked !== undefined) {
		if (typeof o.locked !== "boolean") problems.push(`${where}: locked must be true or false.`);
		else style.locked = o.locked;
	}
	if (o.link !== undefined) {
		if (o.link === null || o.link === "") style.link = null;
		else if (typeof o.link !== "string" || o.link.length > 2000 || !/^(https?:\/\/|mailto:)/i.test(o.link)) problems.push(`${where}: link must be an http(s) or mailto address.`);
		else style.link = o.link;
	}
	if (o.groupIds !== undefined) {
		if (!Array.isArray(o.groupIds) || o.groupIds.length > 8 || o.groupIds.some((g) => typeof g !== "string" || !g || g.length > MAX_ID)) problems.push(`${where}: groupIds must be a short list of names.`);
		else style.groupIds = [...new Set(o.groupIds as string[])];
	}
	return style;
}

/**
 * The operations of excalidraw_apply_operations, checked: every problem found is named (by the
 * operation's place in the list), so a model can fix them all in one go.
 */
export function parseOperations(raw: unknown): Operation[] {
	if (!Array.isArray(raw)) throw new ToolInputError("operations must be a list.");
	if (raw.length === 0) throw new ToolInputError("operations is empty: nothing to do.");
	if (raw.length > MAX_OPERATIONS) throw new ToolInputError(`At most ${MAX_OPERATIONS} operations in one call; send the rest in another.`);
	const problems: string[] = [];
	const operations: Operation[] = [];
	const given = new Set<string>();
	raw.forEach((item, i) => {
		const where = `operations[${i}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) return void problems.push(`${where} must be an object.`);
		const o = item as Record<string, unknown>;
		const before = problems.length;
		const id = (key: "id" | "start" | "end", needed: boolean): string | undefined => {
			const v = o[key];
			if (v === undefined || v === null || v === "") {
				if (needed) problems.push(`${where}: ${key} is missing.`);
				return undefined;
			}
			if (typeof v !== "string" || v.length > MAX_ID || /[\u0000-\u001f]/.test(v)) return void problems.push(`${where}: ${key} must be an element id.`);
			return v;
		};
		const number = (key: "x" | "y" | "width" | "height", positive = false): number | undefined => {
			if (o[key] === undefined) return undefined;
			if (!isNumber(o[key]) || (positive && (o[key] as number) <= 0)) return void problems.push(`${where}: ${key} must be a ${positive ? "positive " : ""}number.`);
			return o[key] as number;
		};
		const words = (key: "text" | "label"): string | undefined => {
			if (o[key] === undefined || o[key] === null) return undefined;
			if (typeof o[key] !== "string" || (o[key] as string).length > MAX_TEXT) return void problems.push(`${where}: ${key} must be text.`);
			return o[key] as string;
		};
		const points = (): [number, number][] | undefined => {
			if (o.points === undefined || o.points === null) return undefined;
			const p = o.points;
			if (!Array.isArray(p) || p.length < 2 || p.length > MAX_POINTS || p.some((q) => !Array.isArray(q) || q.length !== 2 || !isNumber(q[0]) || !isNumber(q[1]))) return void problems.push(`${where}: points must be a list of at least two [x, y] pairs.`);
			return (p as number[][]).map((q) => [q[0], q[1]] as [number, number]);
		};
		if (o.op === "delete") {
			const target = id("id", true);
			if (problems.length === before) operations.push({ op: "delete", id: target! });
			return;
		}
		if (o.op === "add") {
			if (typeof o.type !== "string" || !(ELEMENT_TYPES as readonly string[]).includes(o.type)) return void problems.push(`${where}: type must be one of ${ELEMENT_TYPES.join(", ")}.`);
			const type = o.type as ElementType;
			const line = (LINE_TYPES as readonly string[]).includes(type);
			const op: AddOp = { op: "add", type, ...styleOf(o, where, problems) };
			const newId = id("id", false);
			if (newId) {
				if (given.has(newId)) problems.push(`${where}: the id "${newId}" is given to two new elements.`);
				given.add(newId);
				op.id = newId;
			}
			const x = number("x"), y = number("y"), width = number("width", true), height = number("height", true);
			const text = words("text"), label = words("label");
			if (type === "text") {
				// (a model that puts a text element's words in `label` means the same thing)
				const content = text ?? label;
				if (!content?.trim()) problems.push(`${where}: a text element needs text.`);
				else op.text = content;
				if (x === undefined || y === undefined) problems.push(`${where}: a text element needs x and y.`);
			} else {
				const content = label ?? text;
				if (content?.trim()) op.label = content;
			}
			if (line) {
				op.start = id("start", false);
				op.end = id("end", false);
				op.points = points();
				if (!op.points && !(op.start && op.end) && (x === undefined || y === undefined)) problems.push(`${where}: a ${type} that is not attached at both ends needs points (or x and y, with width and height for where it goes).`);
			} else {
				if (o.start !== undefined || o.end !== undefined || o.points !== undefined) problems.push(`${where}: start, end and points are for arrows and lines.`);
				if (type !== "text" && (x === undefined || y === undefined)) problems.push(`${where}: a ${type} needs x and y.`);
			}
			if (x !== undefined) op.x = x;
			if (y !== undefined) op.y = y;
			if (width !== undefined) op.width = width;
			if (height !== undefined) op.height = height;
			if (problems.length === before) operations.push(op);
			return;
		}
		if (o.op === "update") {
			const target = id("id", true);
			const op: UpdateOp = { op: "update", id: target ?? "", ...styleOf(o, where, problems) };
			const x = number("x"), y = number("y"), width = number("width", true), height = number("height", true);
			if (x !== undefined) op.x = x;
			if (y !== undefined) op.y = y;
			if (width !== undefined) op.width = width;
			if (height !== undefined) op.height = height;
			const text = words("text"), label = words("label");
			if (text !== undefined) op.text = text;
			if (label !== undefined) op.label = label;
			// (an end given as "" or null is let go; one not given stays as it is)
			for (const end of ["start", "end"] as const) {
				if (o[end] === undefined) continue;
				if (o[end] === null || o[end] === "") op[end] = null;
				else op[end] = id(end, false);
			}
			const p = points();
			if (p) op.points = p;
			if (o.type !== undefined) problems.push(`${where}: an element's type cannot be changed; delete it and add another.`);
			if (problems.length === before && Object.keys(op).length <= 2) problems.push(`${where}: nothing to change is given.`);
			if (problems.length === before) operations.push(op);
			return;
		}
		problems.push(`${where}: op must be "add", "update" or "delete".`);
	});
	if (problems.length) throw new ToolInputError(problems.slice(0, 30).join("\n") + (problems.length > 30 ? `\n… and ${problems.length - 30} more.` : ""));
	return operations;
}

/** What excalidraw_get_scene was asked for, checked. */
export interface SceneQuery {
	scope: "all" | "selection";
	ids?: string[];
	query?: string;
	includeStyles: boolean;
	maxElements: number;
}

export function parseSceneQuery(input: Record<string, unknown>): SceneQuery {
	if (input.scope !== undefined && input.scope !== "all" && input.scope !== "selection") throw new ToolInputError('scope must be "all" or "selection".');
	if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200)) throw new ToolInputError("query must be a short text.");
	const max = input.maxElements === undefined ? 400 : input.maxElements;
	if (!isNumber(max) || max < 1) throw new ToolInputError("maxElements must be a positive number.");
	return {
		scope: (input.scope as "all" | "selection") ?? "all",
		...(idList(input.ids, "ids") ? { ids: idList(input.ids, "ids") } : {}),
		...(typeof input.query === "string" && input.query.trim() ? { query: input.query.trim() } : {}),
		includeStyles: input.includeStyles === true,
		maxElements: Math.min(2000, Math.floor(max)),
	};
}

/** What excalidraw_from_mermaid was asked for, checked. */
export function parseMermaid(input: Record<string, unknown>): { definition: string; x?: number; y?: number } {
	if (typeof input.definition !== "string" || !input.definition.trim()) throw new ToolInputError("definition is missing: the Mermaid text of the diagram.");
	if (input.definition.length > 50_000) throw new ToolInputError("definition is too long.");
	for (const key of ["x", "y"] as const) if (input[key] !== undefined && !isNumber(input[key])) throw new ToolInputError(`${key} must be a number.`);
	if ((input.x === undefined) !== (input.y === undefined)) throw new ToolInputError("Give both x and y, or neither.");
	return { definition: input.definition, ...(input.x !== undefined ? { x: input.x as number, y: input.y as number } : {}) };
}
