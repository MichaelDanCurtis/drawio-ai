// stdio ⇄ Streamable-HTTP bridge for agents that only accept stdio MCP servers.
// Run by the agent as `<Electron> mcp-stdio-proxy.js <url>` with
// ELECTRON_RUN_AS_NODE=1 and DRAWAI_MCP_TOKEN set; forwards each JSON-RPC line
// to the window's MCP endpoint and writes the answer back as one line.
//
// With --desktop (the launcher Claude Code / Codex run), the address and token come
// from ~/.drawio-ai/desktop.json, read on every request so a restarted app is found.
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

const desktop = process.argv.includes("--desktop");

function target(): { url: URL; token: string } {
	if (!desktop) return { url: new URL(process.argv[2] ?? ""), token: process.env.DRAWAI_MCP_TOKEN ?? "" };
	const file = path.join(process.env.DRAWIO_AI_HOME || path.join(os.homedir(), ".drawio-ai"), "desktop.json");
	let info: any;
	try {
		info = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error("the Draw.AI desktop app is not running. Open it, then try again");
	}
	return { url: new URL(info.url), token: String(info.token ?? "") };
}

function post(body: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let url: URL;
		let token: string;
		try {
			({ url, token } = target());
		} catch (e) {
			return reject(e);
		}
		const req = http.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${token}`,
					"x-drawio-ai-client": desktop ? "desktop-stdio" : "acp-stdio",
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
