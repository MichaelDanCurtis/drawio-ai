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
