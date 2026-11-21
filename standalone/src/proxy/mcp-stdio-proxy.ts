// stdio ⇄ Streamable-HTTP bridge for agents that only accept stdio MCP servers.
// Run by the agent as `<Electron> mcp-stdio-proxy.js <url>` with
// ELECTRON_RUN_AS_NODE=1 and DRAWAI_MCP_TOKEN set; forwards each JSON-RPC line
// to the window's MCP endpoint and writes the answer back as one line.
import * as http from "http";
import * as readline from "readline";

const url = new URL(process.argv[2] ?? "");
const token = process.env.DRAWAI_MCP_TOKEN ?? "";

function post(body: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${token}`,
					"x-drawio-ai-client": "acp-stdio",
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			}
		);
		req.on("error", reject);
		req.end(body);
	});
}

let pending = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	pending = pending.then(async () => {
		let id: unknown = null;
		try {
			id = JSON.parse(line)?.id ?? null;
		} catch {
			// forwarded as is; the server answers with a parse error
		}
		try {
			const answer = await post(line);
			if (answer.trim()) process.stdout.write(answer.trim().replace(/\n/g, " ") + "\n");
		} catch (e: any) {
			if (id !== null) {
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `Draw.AI is not reachable: ${e?.message ?? e}` } }) + "\n");
			}
		}
	});
});
