// Makes sure the draw.io webapp (the repo's `drawio` git submodule) is checked out.
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webapp = join(repo, "drawio/src/main/webapp/index.html");
if (!existsSync(webapp)) {
	console.log("draw.io webapp missing: running `git submodule update --init --depth 1 drawio` (one-time download)…");
	execFileSync("git", ["submodule", "update", "--init", "--depth", "1", "drawio"], { cwd: repo, stdio: "inherit" });
}
if (!existsSync(webapp)) {
	console.error(`Still missing ${webapp}. Check the submodule, or set DRAWAI_WEBAPP to a draw.io webapp folder.`);
	process.exit(1);
}
