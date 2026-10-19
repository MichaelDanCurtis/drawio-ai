// Builds, tests and packages Draw.AI on this machine (no CI needed), and optionally publishes it.
//
//   node scripts/release.js                  build + all tests + release check + dist/draw-ai-<version>.vsix
//   node scripts/release.js --quick          skip the real-VS-Code tests (they open a VS Code window)
//   node scripts/release.js --pre-release    package as a pre-release
//   node scripts/release.js --publish-marketplace   publish with Microsoft Entra ID (needs `az login`; see RELEASING.md)
//   node scripts/release.js --publish-openvsx       publish to Open VSX (needs the OVSX_PAT environment variable)
//
// Without a publish flag, upload the .vsix at https://marketplace.visualstudio.com/manage.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const vsix = path.join("dist", `${pkg.name}-${pkg.version}${args.has("--pre-release") ? "-pre" : ""}.vsix`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function step(title, cmd, cmdArgs, env) {
	console.log(`\n▶ ${title}`);
	const start = Date.now();
	try {
		execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
	} catch {
		console.error(`\n✖ ${title} failed.`);
		process.exit(1);
	}
	console.log(`✔ ${title} (${Math.round((Date.now() - start) / 1000)}s)`);
}

const node = process.execPath;
step("Release check (metadata)", node, ["scripts/release-check.js"]);
step("Build extension", npx, ["webpack", "--mode", "production"]);
step("Build draw.io plugins", npx, ["webpack", "--mode", "production", "--config", "./drawio-custom-plugins/webpack.config.ts"]);
// The same files as `yarn test:ai`, so new test files are never left out of a release.
const unitTests = (pkg.scripts["test:ai"].match(/test\/ai\/[\w.-]+\.test\.js/g) || []);
step("Unit tests", node, ["--test", ...unitTests]);
step("Browser tests (real draw.io in Chrome)", node, ["--test", "--test-timeout=180000", "test/ai/plugin.e2e.test.js", "test/ai/chatView.e2e.test.js"]);
if (!args.has("--quick")) step("VS Code integration tests", node, ["test/ai/vscode/runVsCodeTests.js"]);
step("Release check (build output)", node, ["scripts/release-check.js", "--built"]);
step(
	`Package ${vsix}`,
	npx,
	// The extension is bundled by webpack (it only loads Node built-ins at runtime), so vsce
	// must not resolve node_modules: npm rejects the yarn-installed tree as extraneous.
	["vsce", "package", "--no-dependencies", "--allow-unused-files-pattern", "--out", vsix, ...(args.has("--pre-release") ? ["--pre-release"] : [])]
);

if (args.has("--publish-marketplace")) {
	step("Publish to the VS Code Marketplace", npx, ["vsce", "publish", "--azure-credential", "--packagePath", vsix, ...(args.has("--pre-release") ? ["--pre-release"] : [])]);
}
if (args.has("--publish-openvsx")) {
	if (!process.env.OVSX_PAT) {
		console.error("\n✖ Set the OVSX_PAT environment variable to your Open VSX access token (see RELEASING.md).");
		process.exit(1);
	}
	step("Publish to Open VSX", npx, ["ovsx", "publish", vsix, ...(args.has("--pre-release") ? ["--pre-release"] : [])]);
}

console.log(`\nDone: ${vsix}`);
if (!args.has("--publish-marketplace")) {
	console.log(
		`To publish, open https://marketplace.visualstudio.com/manage/publishers/${pkg.publisher}, then ` +
			`"New extension" → "Visual Studio Code" (first release) or "…" → "Update" (later releases), and upload ${vsix}.`
	);
}
// Prefixed: clones with the upstream remote have hediet's v0.1.3 to v1.17.0 tags (see RELEASING.md).
const tag = `draw-ai-v${pkg.version}`;
console.log(`Tag the release: git tag -a ${tag} -m "Draw.AI ${pkg.version}" && git push origin ${tag}`);
