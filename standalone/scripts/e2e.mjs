// End-to-end check of the real app (see src/main/e2e.ts).
//   yarn e2e                                   editor + MCP endpoint + exports, no agent
//   yarn e2e --agent claude|gemini|codex|copilot|kimi  also one prompt through that agent over ACP
//   yarn e2e --agent codex --prompt "…" --file ../examples/use-cases/cloud-architecture.drawio
// The diagram is copied to a temp folder first; results land in <temp>/out.
import { spawnSync } from "child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const source = resolve(arg("file", join(here, "../../examples/use-cases/cloud-architecture.drawio")));
const dir = mkdtempSync(join(tmpdir(), "drawai-e2e-"));
const file = join(dir, basename(source));
copyFileSync(source, file);
const config = {
	file,
	out: join(dir, "out"),
	agent: arg("agent"),
	prompt: arg("prompt"),
	timeoutMs: Number(arg("timeout", "420000")),
	clickPermissions: process.argv.includes("--click-permissions"),
	present: process.argv.includes("--present"),
	insights: process.argv.includes("--insights"),
	clickAllowAll: process.argv.includes("--click-allow-all"),
	// yarn e2e --map software.github-actions --map-input '{"folder":"…"}' [--map-dialog] [--agent claude --ask-agent] [--dig "question"]
	map: arg("map")
		? {
				recipe: arg("map"),
				input: JSON.parse(arg("map-input", "{}")),
				dialog: process.argv.includes("--map-dialog"),
				askAgent: process.argv.includes("--ask-agent"),
				digDeeper: arg("dig"),
		  }
		: undefined,
};
const electron = createRequire(import.meta.url)("electron");
const r = spawnSync(electron, [join(here, "..")], { stdio: "inherit", env: { ...process.env, DRAWAI_E2E: JSON.stringify(config) } });
console.log(`\nResults in ${config.out}`);
try {
	const s = JSON.parse(readFileSync(join(config.out, "summary.json"), "utf8"));
	if (config.agent && !config.map && !s.diagramChanged) {
		console.error("The agent did not change the diagram.");
		process.exit(1);
	}
} catch {
	process.exit(1);
}
process.exit(r.status ?? 1);
