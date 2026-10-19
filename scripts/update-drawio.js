// Moves the bundled draw.io (the `drawio` git submodule) to a release tag.
// Usage: node scripts/update-drawio.js [v32.5.5]   (default: the newest release tag)
// Then build, run the tests (node scripts/release.js --quick) and commit the submodule change.
const { execFileSync } = require("child_process");
const path = require("path");

const dir = path.resolve(__dirname, "../drawio");
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

git("fetch", "--tags", "--quiet", "origin");
const tag =
	process.argv[2] ||
	git("tag", "--list", "v*", "--sort=-v:refname")
		.split("\n")
		.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
if (!tag) {
	console.error("No release tag found.");
	process.exit(1);
}
const before = git("describe", "--tags", "--always");
git("checkout", "--quiet", `refs/tags/${tag}`);
console.log(before === tag ? `draw.io is already at ${tag}.` : `draw.io: ${before} → ${tag}. Run "node scripts/release.js --quick", then commit the "drawio" submodule change.`);
