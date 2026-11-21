/**
 * The Mapper: maps software, databases, cloud environments and ML systems into
 * diagrams. A recipe collects facts read-only (catalog queries, inventory CLIs,
 * config files), turns them into a MapGraph that is laid out and drawn
 * deterministically, and can then hand the result to the user's coding agent to
 * annotate, or to dig deeper into a part of the map.
 *
 * Nothing in here imports Electron, so recipes and the renderer are unit-testable.
 */

export type MapCategory = "software" | "database" | "azure" | "aws" | "gcp" | "ml";

export const CATEGORIES: { id: MapCategory; title: string; description: string }[] = [
	{ id: "software", title: "Software", description: "Data flow, connectivity, CI/CD workflows, modules and classes" },
	{ id: "database", title: "Databases", description: "Schemas and relations of SQL and NoSQL databases" },
	{ id: "azure", title: "Azure", description: "Subscriptions, resource groups, networks and resources" },
	{ id: "aws", title: "AWS", description: "Accounts, regions, VPCs, subnets and services" },
	{ id: "gcp", title: "Google Cloud", description: "Projects, networks and resources" },
	{ id: "ml", title: "Machine Learning", description: "Pipelines, MLflow, the ML lifecycle and model architectures" },
];

/** A thing on the map. Containers hold the nodes whose `parent` is their id. */
export interface MapNode {
	/** Unique within the graph and stable across runs (ARN, resource id, table name...). */
	id: string;
	label: string;
	/** Semantic kind, e.g. "aws:ec2:instance", "db:table", "ml:step", "gha:job". */
	kind: string;
	parent?: string;
	/** Drawn as a box that holds its children (account, VPC, subnet, resource group...). */
	container?: boolean;
	/** draw.io style; when omitted, a default for `shape` is used. */
	style?: string;
	/** "icon": a picture with the label below it (cloud services); "box" (default); "table": header + rows. */
	shape?: "icon" | "box" | "table" | "note";
	width?: number;
	height?: number;
	/** Rows of a table-like node (columns of a database table, fields of a document). */
	rows?: MapRow[];
	/** Stored on the shape: resource ids, types, regions... Read by "dig deeper". */
	data?: Record<string, string>;
}

export interface MapRow {
	text: string;
	/** Key marker shown before the text. */
	key?: "PK" | "FK" | "PK,FK" | "UK" | "IDX";
	/** Detail shown dimmed after the text (type, nullability). */
	detail?: string;
}

export interface MapEdge {
	from: string;
	to: string;
	label?: string;
	/** e.g. "fk", "network", "dataflow", "needs", "trigger". */
	kind?: string;
	style?: string;
}

export interface MapGraph {
	/** Used as the page name. */
	title: string;
	nodes: MapNode[];
	edges: MapEdge[];
	/** Main direction of flow for layered layouts. Default "down". */
	direction?: "down" | "right";
	/** Shown in a note on the map (what was mapped, when, what was skipped). */
	legend?: string[];
}

// ----- recipes -----

export interface FieldOption {
	value: string;
	label: string;
}

export interface FieldDef {
	id: string;
	label: string;
	type: "text" | "password" | "folder" | "file" | "select" | "checkbox" | "textarea";
	placeholder?: string;
	help?: string;
	required?: boolean;
	default?: string;
	options?: FieldOption[];
	/** Options come from loadOptions (e.g. subscriptions from `az account list`). */
	dynamic?: boolean;
	/** Never stored or shown to the agent (passwords, connection strings). */
	secret?: boolean;
	/** Only shown when another field has one of these values, e.g. { field: "engine", values: ["postgres"] }. */
	showIf?: { field: string; values: string[] };
}

export type MapInput = Record<string, string>;

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface CollectContext {
	/**
	 * Runs a command with the user's shell environment (PATH, cloud CLI logins).
	 * Only read-only commands are allowed (see readOnly.ts); others are refused.
	 */
	exec(command: string, args: string[], opts?: { timeoutMs?: number; cwd?: string; input?: string }): Promise<ExecResult>;
	/** Shown in the Mapper while it runs. */
	progress(text: string): void;
	signal: AbortSignal;
	/** The diagram's folder (default folder for file and folder fields). */
	cwd: string;
}

export interface CollectResult {
	/** What to draw. Omit when the agent draws everything (agent-only recipes). */
	graph?: MapGraph;
	/** Facts for the agent (Markdown or JSON), e.g. the inventory it can dig into. Never secrets. */
	facts?: string;
	/** One line for the user, e.g. "42 resources in 3 resource groups". */
	summary: string;
	warnings?: string[];
}

export interface Recipe {
	id: string;
	category: MapCategory;
	title: string;
	description: string;
	fields: FieldDef[];
	/** "inventory": read-only collection then a drawn map; "agent": the agent explores and draws. */
	mode: "inventory" | "agent";
	/** Options for `dynamic` select fields. */
	loadOptions?(fieldId: string, input: MapInput, ctx: CollectContext): Promise<FieldOption[]>;
	collect?(input: MapInput, ctx: CollectContext): Promise<CollectResult>;
	/** The request for the agent: for "agent" recipes the whole job, otherwise an optional follow-up. */
	agentPrompt?(input: MapInput, result: CollectResult | undefined): string;
	/** Asks the agent to investigate the selected mapped shapes further (read-only). */
	digDeeper?(shapes: { label: string; data: Record<string, string> }[], question: string): string;
}

/** Thrown by collectors for problems the user can fix (not signed in, CLI missing...). */
export class MapperError extends Error {
	constructor(message: string, public readonly hint?: string) {
		super(message);
	}
}
