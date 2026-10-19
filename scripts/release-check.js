// Pre-publish checks for the VS Code Marketplace / Open VSX.
// Usage: node scripts/release-check.js [--built]   (--built also checks the build output)
// Exits 1 on errors; warnings are printed but do not fail.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];
const warnings = [];
const exists = (p) => fs.existsSync(path.join(root, p));

if (!/^[a-z0-9][a-z0-9-]*$/i.test(pkg.publisher || "")) errors.push(`"publisher" is missing or invalid.`);
if (pkg.publisher === "drawio-ai") {
	warnings.push('"publisher" is still the placeholder "drawio-ai". Run `node scripts/set-publisher.js <your-publisher-id>` unless you own that publisher.');
}
if (!pkg.author?.name || /Dieterichs/.test(pkg.author.name)) errors.push('"author" must be set to the maintainer of this fork.');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) errors.push(`"version" ${pkg.version} is not a plain x.y.z version (the Marketplace rejects pre-release suffixes).`);

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${pkg.version}]`)) errors.push(`CHANGELOG.md has no "## [${pkg.version}]" section.`);
if (/## \[Unreleased\]/i.test(changelog)) warnings.push('CHANGELOG.md still has an "Unreleased" section.');

if (!pkg.icon || !exists(pkg.icon)) {
	errors.push(`icon ${pkg.icon} does not exist.`);
} else {
	const png = fs.readFileSync(path.join(root, pkg.icon));
	const isPng = png.slice(1, 4).toString() === "PNG";
	const w = isPng ? png.readUInt32BE(16) : 0;
	const h = isPng ? png.readUInt32BE(20) : 0;
	if (!isPng) errors.push("icon must be a PNG (the Marketplace does not accept SVG icons).");
	else if (w < 128 || h < 128 || w !== h) errors.push(`icon must be square and at least 128x128 (is ${w}x${h}).`);
}

for (const k of ["repository", "bugs", "homepage"]) {
	const url = typeof pkg[k] === "string" ? pkg[k] : pkg[k]?.url;
	if (!url) errors.push(`"${k}" is missing.`);
	else if (/hediet/.test(url)) errors.push(`"${k}" still points to hediet's repository.`);
}
if (pkg.license !== "GPL-3.0" || !exists("LICENSE.md")) errors.push("The fork must stay GPL-3.0 with LICENSE.md included.");
if ((pkg.keywords || []).length > 30) errors.push("The Marketplace allows at most 30 keywords.");
if (!pkg.files?.includes("LICENSE.md")) errors.push('"files" must include LICENSE.md.');
if (!pkg.files?.includes("CHANGELOG.md")) errors.push('"files" must include CHANGELOG.md, or the Marketplace changelog tab stays empty.');

const contributes = JSON.stringify(pkg.contributes);
const leftovers = [...new Set(contributes.match(/hediet\.vscode-drawio[\w.-]*/g) || [])];
if (leftovers.length) errors.push(`contributes still uses upstream ids: ${leftovers.join(", ")}`);

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
for (const m of readme.matchAll(/(?:!\[[^\]]*\]\(|<img[^>]+src=")(\.?\/?[^)"\s]+)/g)) {
	const ref = m[1];
	if (/^https?:/.test(ref)) {
		if (!/^https:/.test(ref)) errors.push(`README image ${ref} must use https.`);
		continue;
	}
	if (!exists(ref.replace(/^\.\//, ""))) errors.push(`README image ${ref} does not exist.`);
}
if (/\.svg\)/.test(readme.replace(/\.drawio\.svg\)/g, ""))) warnings.push("README embeds SVG images; the Marketplace only allows SVGs from trusted badge providers.");

try {
	execFileSync(process.execPath, [path.join(__dirname, "sync-lm-tools.js"), "--check"], { stdio: "pipe" });
} catch {
	errors.push("languageModelTools are out of sync: run `node scripts/sync-lm-tools.js`.");
}
try {
	// The Claude Code / Codex plugin manifests carry the version.
	execFileSync(process.execPath, [path.join(__dirname, "generate-agent-plugin.js"), "--check"], { stdio: "pipe" });
} catch {
	errors.push("The agent plugin is out of date: run `node scripts/generate-agent-plugin.js`.");
}

if (process.argv.includes("--built")) {
	for (const f of ["dist/extension/index.js", "dist/custom-drawio-plugins/index.js", "drawio/src/main/webapp/index.html"]) {
		if (!exists(f)) errors.push(`${f} is missing; build first (and init the drawio submodule).`);
	}
	// vsce does not follow symbolic links: a linked draw.io would be left out of the .vsix.
	for (const p of ["drawio", "drawio/src", "drawio/src/main", "drawio/src/main/webapp"]) {
		if (exists(p) && fs.lstatSync(path.join(root, p)).isSymbolicLink()) {
			errors.push(`${p} is a symbolic link; vsce would leave draw.io out of the package. Use a real copy (init the drawio submodule).`);
		}
	}
	if (exists("dist/custom-drawio-plugins/index.js") && /[^\x00-\x7f]/.test(fs.readFileSync(path.join(root, "dist/custom-drawio-plugins/index.js"), "utf8"))) {
		errors.push("dist/custom-drawio-plugins/index.js is not ASCII-only.");
	}
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) {
	console.error(`\n${errors.length} problem(s) must be fixed before publishing.`);
	process.exit(1);
}
console.log(`Release check passed for ${pkg.publisher}.${pkg.name} ${pkg.version}${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);
