import { AgentBridge } from "./bridge";
import { drawioAiHome } from "./discovery";

// Entry point of dist/agent-bridge/index.js: newline-delimited JSON-RPC on
// stdin/stdout. stdout carries protocol messages only; everything else goes to stderr.

const log = (text: string): void => {
	process.stderr.write(`[draw-ai bridge] ${text}\n`);
};
console.log = console.info = console.warn = (...args: unknown[]) => log(args.map(String).join(" "));

const bridge = new AgentBridge({
	home: drawioAiHome(),
	env: process.env,
	version: process.env.DRAWIO_AI_VERSION ?? "0.0.0",
	write: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
	log,
});

const inFlight = new Set<Promise<void>>();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let nl: number;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
			continue;
		}
		// Messages are handled concurrently: a long tool call must not hold up a ping.
		const p = bridge.receive(msg).catch((e) => log(`error: ${e?.stack ?? e}`));
		inFlight.add(p);
		void p.finally(() => inFlight.delete(p));
	}
});
process.stdin.on("end", () => {
	void Promise.allSettled([...inFlight]).then(() => process.exit(0));
});
process.stdout.on("error", () => process.exit(0));
