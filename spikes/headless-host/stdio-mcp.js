// Feasibility spike (not product code): a stdio MCP server for Claude Code /
// Codex that reuses Draw.AI's own tool layer UNCHANGED (src/features/ai/
// DiagramToolbox.ts, mcp.ts, toolSchemas.ts and src/DrawioClient) on top of the
// headless draw.io host, with no VS Code. Only the host glue below is new.
//
// Run: node spikes/headless-host/stdio-mcp.js   (JSON-RPC lines on stdin/stdout)
// stdout carries protocol only; everything else goes to stderr.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "../..");

// --- load the extension's TypeScript sources as-is ---------------------------
require.extensions[".ts"] = (module, filename) => {
	const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
		fileName: filename,
	});
	module._compile(out.outputText, filename);
};
// Headless defaults for the few settings the toolbox reads. Review mode needs a
// human looking at the canvas, so it is off here; git diff of the .drawio is the review.
const HEADLESS_SETTINGS = { reviewChanges: false, flashChanges: false, selectChangedCells: false, maxCellsInContext: 400 };
const vscodeStub = { workspace: { getConfiguration: () => ({ get: (k, d) => (k in HEADLESS_SETTINGS ? HEADLESS_SETTINGS[k] : d) }) } };
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === "vscode" ? "vscode-stub" : resolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: vscodeStub };

const { handleMcpMessage } = require(path.join(root, "src/features/ai/mcp.ts"));
const { TOOL_SCHEMAS } = require(path.join(root, "src/features/ai/toolSchemas.ts"));
const { DiagramToolbox } = require(path.join(root, "src/features/ai/DiagramToolbox.ts"));
const { CustomizedDrawioClient } = require(path.join(root, "src/DrawioClient/CustomizedDrawioClient.ts"));
const { HeadlessServer } = require("./server.js");

// --- headless host -----------------------------------------------------------
let browser, page, client, server, currentFile;
const handlers = [];

async function ensureHost() {
	if (client) return;
	server = await HeadlessServer.start(root);
	browser = await chromium.launch({ channel: "chrome", headless: true });
	const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await context.route("**/*", (route) => {
		const u = route.request().url();
		return u.startsWith(server.base + "/") || u.startsWith("data:") || u.startsWith("blob:") ? route.continue() : route.abort();
	});
	page = await context.newPage();
	page.on("pageerror", (e) => console.error("[page error]", e.message));
	await page.exposeFunction("__toHost", (m) => handlers.forEach((h) => h(m)));
	const stream = {
		registerMessageHandler: (h) => (handlers.push(h), { dispose: () => handlers.splice(handlers.indexOf(h), 1) }),
		sendMessage: (m) => void page.evaluate((x) => window.postMessage(x, "*"), m),
	};
	client = new CustomizedDrawioClient(stream, async () => ({}), () => {}, () => "light");
	const init = new Promise((r) => client.onInit.sub(() => r()));
	await page.goto(`${server.base}/editor.html`);
	await init;
}

async function openFile(file) {
	await ensureHost();
	const abs = path.resolve(file);
	if (!/\.(drawio|dio)$/i.test(abs)) throw new Error("The spike only handles .drawio files.");
	const xml = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
	await client.loadXmlLike(xml);
	currentFile = abs;
	return abs;
}

async function save() {
	if (!currentFile) return;
	fs.writeFileSync(currentFile, await client.getXml());
}

const toolbox = new DiagramToolbox(() => (client && currentFile ? { drawioClient: client } : undefined));
const HEADLESS_TOOLS = new Set(["drawio_get_diagram", "drawio_apply_operations", "drawio_find_cells", "drawio_render_image", "drawio_search_shapes", "drawio_style_reference", "drawio_get_xml", "drawio_lint"]);
const OPEN_TOOL = {
	name: "drawio_open",
	title: "Open Draw.io File",
	description: "Open (or create, if missing) a .drawio file for the other drawio_* tools to work on. Edits are saved to the file.",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	readOnly: false,
};

const deps = {
	serverVersion: "spike",
	tools: () => [
		OPEN_TOOL,
		...TOOL_SCHEMAS.filter((t) => HEADLESS_TOOLS.has(t.name)).map((t) => ({ name: t.name, title: t.displayName, description: t.description, inputSchema: t.inputSchema, readOnly: !t.mutates })),
	],
	callTool: async (name, args) => {
		if (name === "drawio_open") return { text: `Opened ${await openFile(String(args.path))}` };
		if (!currentFile) return { text: "Call drawio_open with a .drawio path first.", isError: true };
		const r = await toolbox.invoke(name, args);
		if (getMutates(name) && !r.isError) await save();
		return r;
	},
	instructions: async () => "Headless Draw.AI: edits .drawio files on disk with draw.io itself. Call drawio_open first.",
};
const getMutates = (name) => !!TOOL_SCHEMAS.find((t) => t.name === name)?.mutates;

// --- stdio transport (newline-delimited JSON-RPC) ----------------------------
let buffer = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		queue = queue.then(async () => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
			}
			const res = await handleMcpMessage(msg, deps);
			if (res) process.stdout.write(JSON.stringify(res) + "\n");
		});
	}
});
process.stdin.on("end", () => queue.then(() => Promise.all([browser?.close(), server?.close()])).then(() => process.exit(0)));
