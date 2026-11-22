/**
 * Requests the Mapper sends to the agent carry the facts it collected inside the text
 * (standalone/src/main/mapper/recipes/common.ts, agentRequest), up to 60,000 characters and
 * sometimes twice (the recipe's request and the dialog's). VS Code's chat shows a request as
 * the user's message, so the extension takes the facts out and sends them as an attachment the
 * agent reads with drawio_get_attachment.
 *
 * Nothing here imports vscode: the unit tests load it as it is.
 */
const FACTS = /\n*<facts collected read-only by the Mapper>\n([\s\S]*?)\n<\/facts>/g;

/** The request without its facts, and the facts (the longest block, when the same facts are there twice). */
export function splitFacts(request: string): { text: string; facts?: string } {
	let facts: string | undefined;
	const text = request.replace(FACTS, (_all, body: string) => {
		if (facts === undefined || body.length > facts.length) {
			facts = body;
		}
		return "";
	});
	return facts === undefined ? { text: request } : { text: `${text.trimEnd()}\n\nThe facts the Mapper collected read-only are attached as "map-facts".`, facts };
}

/** The Mapper's tools that collect: they run inventory commands and may connect to a database, so the user says yes first. */
export function collects(tool: string): boolean {
	return tool === "mapper_run" || tool === "mapper_refresh";
}

/**
 * What the user is asked before the agent starts a map. It names the map and the input
 * fields given, never their values: an input can be a password or a connection string.
 */
export function runConfirmation(tool: string, input: unknown): { title: string; message: string } {
	const args = (input && typeof input === "object" ? input : {}) as { recipe?: unknown; input?: unknown };
	const again = tool === "mapper_refresh";
	const recipe = typeof args.recipe === "string" ? args.recipe.replace(/[^\w.-]/g, "").slice(0, 60) : "";
	const fields =
		!again && args.input && typeof args.input === "object"
			? Object.keys(args.input as object)
					.map((k) => k.replace(/[^\w.-]/g, "").slice(0, 40))
					.filter(Boolean)
					.slice(0, 20)
			: [];
	return {
		title: again ? "Map it again?" : "Map something into the diagram?",
		message: `${again ? "The Mapper will run the same map again" : `The Mapper will run ${recipe ? `\`${recipe}\`` : "a map"}`}: it collects read-only (inventory commands, catalog queries, file reads) and draws the result on a page of its own, as a change you keep or revert.${
			fields.length ? `\n\nWith: ${fields.map((k) => `\`${k}\``).join(", ")}` : ""
		}`,
	};
}
