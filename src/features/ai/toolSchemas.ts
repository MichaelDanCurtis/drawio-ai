/**
 * Tool definitions shared by the built-in agent, the @drawio chat participant
 * and the Copilot language-model tools. `package.json#contributes.languageModelTools`
 * must mirror these schemas (checked by test/ai/toolManifest.test.js).
 *
 * Schemas avoid oneOf/anyOf: several providers reject or mishandle them.
 */

export interface ToolSchema {
	name: string;
	displayName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Only offered to models that accept images. */
	requiresVision?: boolean;
	/** Mutates the diagram. */
	mutates?: boolean;
	/** Writes files in the workspace. */
	writesFiles?: boolean;
}

const OP_KINDS = [
	"addShape",
	"addEdge",
	"update",
	"delete",
	"move",
	"resize",
	"group",
	"ungroup",
	"align",
	"distribute",
	"zOrder",
	"layout",
	"insertXml",
	"replaceAll",
];

const styleProps = {
	type: "object",
	description:
		'draw.io style keys to set, merged into the existing/base style. Values are strings/numbers/booleans; null removes a key. Example: {"fillColor":"#dae8fc","strokeColor":"#6c8ebf","fontStyle":1}',
};

const point = {
	type: "object",
	properties: { x: { type: "number" }, y: { type: "number" } },
	required: ["x", "y"],
};

const operation = {
	type: "object",
	description:
		"One edit. Set `op` and only the fields that operation uses (listed in each field's description).",
	properties: {
		op: { type: "string", enum: OP_KINDS },
		tempId: {
			type: "string",
			description:
				'[addShape, addEdge, group] Your own handle (e.g. "$db") for the new cell. Later operations in the SAME batch can use it anywhere an id is expected.',
		},
		id: { type: "string", description: "[update] Id of the cell to change." },
		ids: {
			type: "array",
			items: { type: "string" },
			description:
				"[delete, move, resize, group, ungroup, align, distribute, zOrder, layout] Target cell ids.",
		},
		label: {
			type: "string",
			description:
				"[addShape, addEdge, update, group] Plain text; use \\n for line breaks. Simple HTML is kept as-is when the style has html=1.",
		},
		style: {
			type: "string",
			description:
				'[addShape, addEdge, update, group] Full draw.io style string, e.g. "shape=cylinder3;whiteSpace=wrap;html=1;". On update it REPLACES the style; prefer styleProps for small changes.',
		},
		styleProps,
		x: { type: "number", description: "[addShape, update] Left, relative to parent." },
		y: { type: "number", description: "[addShape, update] Top, relative to parent." },
		width: { type: "number", description: "[addShape, update, resize]" },
		height: { type: "number", description: "[addShape, update, resize]" },
		scale: { type: "number", description: "[resize] Multiply width and height." },
		dx: { type: "number", description: "[move, insertXml] Horizontal offset." },
		dy: { type: "number", description: "[move, insertXml] Vertical offset." },
		parent: {
			type: "string",
			description:
				"[addShape, addEdge, update, layout, insertXml] Container/group id. Omit for the default layer.",
		},
		placement: {
			type: "object",
			description:
				"[addShape] Position relative to an existing cell instead of x/y. Inherits that cell's parent.",
			properties: {
				relativeTo: { type: "string" },
				side: { type: "string", enum: ["right", "left", "above", "below"] },
				gap: { type: "number", description: "Default 60." },
			},
			required: ["relativeTo", "side"],
		},
		source: { type: "string", description: "[addEdge, update] Source cell id." },
		target: { type: "string", description: "[addEdge, update] Target cell id." },
		points: {
			type: "array",
			items: point,
			description: "[addEdge] Optional waypoints.",
		},
		data: {
			type: "object",
			description:
				"[addShape, update] Custom string attributes (tooltip, link, metadata). null removes on update.",
		},
		includeEdges: {
			type: "boolean",
			description: "[delete] Also delete connected edges. Default true.",
		},
		padding: { type: "number", description: "[group] Default 20." },
		align: {
			type: "string",
			enum: ["left", "center", "right", "top", "middle", "bottom"],
			description: "[align]",
		},
		direction: {
			type: "string",
			enum: ["horizontal", "vertical"],
			description: "[distribute]",
		},
		position: { type: "string", enum: ["front", "back"], description: "[zOrder]" },
		type: {
			type: "string",
			enum: [
				"hierarchical",
				"horizontalHierarchical",
				"tree",
				"horizontalTree",
				"radialTree",
				"organic",
				"circle",
				"grid",
			],
			description:
				"[layout] Automatic layout (draw.io's ELK engine). hierarchical = top-down flow; horizontalHierarchical = left-to-right. Lays out the children of `parent` (default: the page, or the common parent of `ids`); with `ids`, only those cells and the edges between them move.",
		},
		spacing: { type: "number", description: "[layout] Default 50." },
		xml: {
			type: "string",
			description:
				'[insertXml, replaceAll] mxGraphModel XML or bare <mxCell> elements. Ids you choose are kept unless they collide (the result maps them). parent/source/target may reference existing cells.',
		},
	},
	required: ["op"],
};

export const TOOL_SCHEMAS: ToolSchema[] = [
	{
		name: "drawio_get_diagram",
		displayName: "Get Draw.io Diagram",
		description:
			"Read the open draw.io diagram (current page) as structured JSON: cells with ids, kind, label, style, geometry, parent, edge source/target, plus the user's current selection. Call this before editing. Use scope='selection' to focus on what the user selected (adjacent cells are included and marked context=true).",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["page", "selection"] },
				includeStyles: { type: "boolean", description: "Default true." },
				maxCells: { type: "number", description: "Default 400." },
			},
		},
	},
	{
		name: "drawio_apply_operations",
		displayName: "Edit Draw.io Diagram",
		mutates: true,
		description:
			"Apply a batch of edits to the open draw.io diagram in ONE undoable step; the user sees them live. Batch everything for one request into a single call. New cells get a tempId you can reference later in the same batch (e.g. add two shapes then an edge between them). Atomic by default: if any op fails, nothing is applied and per-op errors are returned so you can fix and retry. Returns new ids for every tempId.",
		inputSchema: {
			type: "object",
			properties: {
				ops: { type: "array", items: operation, minItems: 1 },
				atomic: { type: "boolean", description: "Default true." },
				selectResult: {
					type: "boolean",
					description: "Select the changed cells afterwards. Default false.",
				},
			},
			required: ["ops"],
		},
	},
	{
		name: "drawio_find_cells",
		displayName: "Find Draw.io Cells",
		description:
			"Search the current page for cells by label text (case-insensitive substring or /regex/), kind, or style fragment. Returns compact matches with ids.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				kind: { type: "string", enum: ["vertex", "edge", "container", "group"] },
				styleContains: { type: "string" },
				limit: { type: "number", description: "Default 50." },
			},
		},
	},
	{
		name: "drawio_select_cells",
		displayName: "Select Draw.io Cells",
		description:
			"Select (and optionally scroll to and highlight) cells in the editor, e.g. to show the user what you are referring to.",
		inputSchema: {
			type: "object",
			properties: {
				ids: { type: "array", items: { type: "string" } },
				reveal: { type: "boolean", description: "Default true." },
			},
			required: ["ids"],
		},
	},
	{
		name: "drawio_render_image",
		displayName: "Render Draw.io Diagram",
		requiresVision: true,
		description:
			"Render the current page (or only the given cells) to a PNG so you can visually check layout, overlaps and readability after editing.",
		inputSchema: {
			type: "object",
			properties: {
				ids: { type: "array", items: { type: "string" } },
			},
		},
	},
	{
		name: "drawio_search_shapes",
		displayName: "Search Draw.io Shape Library",
		description:
			"Search draw.io's built-in shape libraries (thousands of shapes: AWS, Azure, GCP, Kubernetes, Cisco/network, UML, BPMN, ER, C4, flowchart, mockups, ...) and get each shape's exact style string and default size. ALWAYS use this before adding vendor icons or specialised shapes instead of guessing `shape=mxgraph...` names. Multi-cell templates (e.g. UML class, table) include xml for insertXml.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: 'Keywords, e.g. "aws lambda", "azure sql database", "kubernetes pod", "uml class".',
				},
				limit: { type: "number", description: "Default 8, max 25." },
			},
			required: ["query"],
		},
	},
	{
		name: "drawio_style_reference",
		displayName: "Draw.io Style Reference",
		description:
			"Concise reference for common draw.io style strings: basic shapes, edge styles and arrowheads, the default colour palette, containers/swimlanes, and text. For vendor icons use drawio_search_shapes.",
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					enum: ["basics", "edges", "colors", "containers", "text", "all"],
				},
			},
			required: ["topic"],
		},
	},
	{
		name: "drawio_get_xml",
		displayName: "Get Draw.io XML",
		description:
			"Return the raw draw.io file XML (all pages). Only needed for exact copying of complex styles or multi-page questions; prefer drawio_get_diagram.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "drawio_lint",
		displayName: "Lint Draw.io Diagram",
		description:
			"Check the current page for problems: dangling or duplicate connectors, overlapping or almost-aligned shapes, unlabeled shapes, disconnected shapes, tiny text, and violations of the repository's active design template (palette, fonts, connector style, required title/legend). Returns issues with cell ids. Use it after larger edits and when asked to review a diagram.",
		inputSchema: {
			type: "object",
			properties: {
				ids: { type: "array", items: { type: "string" }, description: "Only report issues involving these cells." },
			},
		},
	},
	{
		name: "drawio_code_links",
		displayName: "Check Draw.io Code Links",
		description:
			"List the shapes on the current page that are linked to source code and whether the code they point to is unchanged, moved, changed, or gone; changed links include the current code. Use it to bring a code-derived diagram up to date. After updating shapes to match the code, pass their ids in `refresh` to re-point the links at the current code.",
		inputSchema: {
			type: "object",
			properties: {
				ids: { type: "array", items: { type: "string" }, description: "Only report these cells." },
				refresh: { type: "array", items: { type: "string" }, description: "Re-point these cells' links at where their code is now (after you updated the shapes)." },
			},
		},
	},
	{
		name: "drawio_export",
		displayName: "Export Draw.io Diagram",
		writesFiles: true,
		description:
			"Export the open diagram to a file in the workspace, when the user asks for a file. vsdx = Microsoft Visio, all pages (or currentPageOnly): shapes stay editable Visio shapes with their text, connectors stay glued, custom data becomes Shape Data. svg/png = the current page, with the diagram embedded so draw.io can still edit it. drawio = a copy of the file. Never replaces an existing file unless overwrite is true, and then only after the user confirms; never replaces a diagram. Returns the path written and, for vsdx, what was exported and anything that did not carry over.",
		inputSchema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["vsdx", "svg", "png", "drawio"] },
				path: {
					type: "string",
					description: "Workspace-relative output path, e.g. \"docs/architecture.vsdx\". Default: next to the diagram, same name with the format's extension.",
				},
				currentPageOnly: { type: "boolean", description: "[vsdx] Only the page shown in the editor. Default false (all pages)." },
				overwrite: { type: "boolean", description: "Replace an existing export; the user is asked to confirm. Default false." },
			},
			required: ["format"],
		},
	},
	{
		name: "drawio_import",
		displayName: "Import Diagram File",
		writesFiles: true,
		description:
			"Convert a diagram made in another tool into a new .drawio file next to it, and open it, when the user asks to open, import or convert such a file: Microsoft Visio (.vsdx, .vsd, .vssx stencils, .vstx/.vst templates), Gliffy (.gliffy), yEd/GraphML (.graphml), Lucidchart (.json export), Miro board data (.json copied from a board) or draw.io's CSV format (.csv rows with '# label:'/'# connect:' configuration lines; without them each row becomes one shape). Uses draw.io's own converters inside VS Code; nothing is uploaded. Needs no open diagram. Never replaces a file: when name.drawio exists, name-2.drawio (and so on) is created instead. Returns the new path, page/shape/connector counts and the warnings (unmapped shapes, unreadable parts, linked web images): tell the user about them. When opened, the new diagram takes focus and the other tools work on it from then on; with open: false they keep working on the current diagram.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path of the file to convert, e.g. \"docs/network.vsdx\"." },
				open: { type: "boolean", description: "Open the new diagram in the editor. Default true." },
			},
			required: ["path"],
		},
	},
	{
		name: "drawio_get_attachment",
		displayName: "Get Draw.io Request Attachment",
		description:
			"Return an image or text the user attached to a request sent from the diagram in VS Code's chat (a markup snapshot, an image to convert, a sketch, a code analysis). Such requests list the attachment ids; read each one before working on the request.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "An attachment id from the request." } },
			required: ["id"],
		},
	},
	{
		name: "drawio_get_template",
		displayName: "Get Draw.io Design Template",
		description:
			"Return the repository's active design template in full: its rules, extracted style profile (palette, fonts, shape style per role, connector style) and every library shape with its exact style. Follow it when creating or restyling shapes.",
		inputSchema: { type: "object", properties: {} },
	},
];

export function getToolSchema(name: string): ToolSchema {
	const s = TOOL_SCHEMAS.find((t) => t.name === name);
	if (!s) {
		throw new Error(`Unknown tool ${name}`);
	}
	return s;
}
