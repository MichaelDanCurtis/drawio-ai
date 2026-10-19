// Keeps everything VS Code's chat reads about the diagram tools in sync with
// src/features/ai/toolSchemas.ts and src/features/ai/systemPrompt.ts:
// - package.json#contributes.languageModelTools
// - media/chat/draw-ai.agent.md, the "Draw.AI" custom agent (its tool names
//   include the extension id, so rerun this after changing the publisher)
// Usage: node scripts/sync-lm-tools.js          (rewrite the generated files)
//        node scripts/sync-lm-tools.js --check  (exit 1 if out of sync)
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const packageFile = path.join(root, "package.json");
const agentFile = path.join(root, "media/chat/draw-ai.agent.md");

function loadTs(relative) {
	const source = fs.readFileSync(path.join(root, relative), "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const mod = { exports: {} };
	new Function("module", "exports", "require", outputText)(mod, mod.exports, require);
	return mod.exports;
}

const referenceName = (name) => name.replace(/^drawio_/, "drawio-").replace(/_/g, "-");

function toManifest(schema) {
	return {
		name: schema.name,
		displayName: schema.displayName,
		toolReferenceName: referenceName(schema.name),
		canBeReferencedInPrompt: true,
		icon: "$(sparkle)",
		tags: ["drawio", "diagram"],
		userDescription: schema.displayName,
		modelDescription: schema.description,
		inputSchema: schema.inputSchema,
	};
}

function agentMarkdown(pkg, schemas, prompt) {
	const extensionId = `${pkg.publisher}.${pkg.name}`;
	const tools = ["read", "search", ...schemas.map((s) => `${extensionId}/${referenceName(s.name)}`)];
	return [
		"---",
		"name: Draw.AI",
		"description: Edit the open draw.io diagram live with Draw.AI's diagram tools (changes stay pending for review, design templates, lint, export).",
		'argument-hint: Describe the change, e.g. "add a Redis cache between the API and the database"',
		"tools:",
		...tools.map((t) => `  - ${t}`),
		"---",
		"",
		prompt.SYSTEM_PROMPT,
		"",
		prompt.NATIVE_AGENT_NOTES,
		"",
	].join("\n");
}

const schemas = loadTs("src/features/ai/toolSchemas.ts").TOOL_SCHEMAS;
const prompt = loadTs("src/features/ai/systemPrompt.ts");
const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const expectedTools = schemas.map(toManifest);
const expectedAgent = agentMarkdown(pkg, schemas, prompt);

if (process.argv.includes("--check")) {
	const stale = [];
	if (JSON.stringify(pkg.contributes.languageModelTools) !== JSON.stringify(expectedTools)) {
		stale.push("package.json languageModelTools");
	}
	if (!fs.existsSync(agentFile) || fs.readFileSync(agentFile, "utf8") !== expectedAgent) {
		stale.push(path.relative(root, agentFile));
	}
	if (stale.length) {
		console.error(`Out of sync: ${stale.join(", ")}. Run: node scripts/sync-lm-tools.js`);
		process.exit(1);
	}
	console.log("languageModelTools and the Draw.AI agent are in sync");
} else {
	pkg.contributes.languageModelTools = expectedTools;
	fs.writeFileSync(packageFile, JSON.stringify(pkg, null, "\t") + "\n");
	fs.mkdirSync(path.dirname(agentFile), { recursive: true });
	fs.writeFileSync(agentFile, expectedAgent);
	console.log(`Wrote ${expectedTools.length} tools to package.json and ${path.relative(root, agentFile)}`);
}
