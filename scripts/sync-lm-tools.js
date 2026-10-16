// Keeps package.json#contributes.languageModelTools in sync with src/features/ai/toolSchemas.ts.
// Usage: node scripts/sync-lm-tools.js          (rewrite package.json)
//        node scripts/sync-lm-tools.js --check  (exit 1 if out of sync)
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const schemaFile = path.join(root, "src/features/ai/toolSchemas.ts");
const packageFile = path.join(root, "package.json");

function loadSchemas() {
	const source = fs.readFileSync(schemaFile, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const mod = { exports: {} };
	new Function("module", "exports", outputText)(mod, mod.exports);
	return mod.exports.TOOL_SCHEMAS;
}

function toManifest(schema) {
	const reference = schema.name
		.replace(/^drawio_/, "drawio-")
		.replace(/_/g, "-");
	return {
		name: schema.name,
		displayName: schema.displayName,
		toolReferenceName: reference,
		canBeReferencedInPrompt: true,
		icon: "$(sparkle)",
		tags: ["drawio", "diagram"],
		userDescription: schema.displayName,
		modelDescription: schema.description,
		inputSchema: schema.inputSchema,
	};
}

const expected = loadSchemas().map(toManifest);
const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const actual = pkg.contributes.languageModelTools;

if (process.argv.includes("--check")) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		console.error("package.json languageModelTools is out of sync. Run: node scripts/sync-lm-tools.js");
		process.exit(1);
	}
	console.log("languageModelTools in sync");
} else {
	pkg.contributes.languageModelTools = expected;
	fs.writeFileSync(packageFile, JSON.stringify(pkg, null, "\t") + "\n");
	console.log(`Wrote ${expected.length} tools to package.json`);
}
