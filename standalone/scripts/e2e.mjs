// End-to-end check of the real app (see src/main/e2e.ts).
//   yarn e2e                                   editor + MCP endpoint + exports, no agent
//   yarn e2e --agent claude|gemini|codex|copilot|kimi  also one prompt through that agent over ACP
//   yarn e2e --agent codex --prompt "…" --file ../examples/use-cases/cloud-architecture.drawio
//   node scripts/e2e.mjs --app dist/mac-arm64/Draw.AI.app/Contents/MacOS/Draw.AI   the packaged app
// The diagram is copied to a temp folder first; results land in <temp>/out.
import { spawn } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "fs";
import { createServer } from "http";
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
	workshop: process.argv.includes("--workshop"),
	polish: process.argv.includes("--polish"),
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
const packaged = arg("app");
const electron = packaged ? resolve(packaged) : createRequire(import.meta.url)("electron");
// The Shape Gallery's sources, served from fixtures: test runs never download from the internet.
const mirrorRoot = join(here, "../test/fixtures/galleries/mirror");
const mirror = createServer((req, res) => {
	const p = join(mirrorRoot, decodeURIComponent(new URL(req.url, "http://x").pathname));
	if (!p.startsWith(mirrorRoot) || !existsSync(p) || !statSync(p).isFile()) return void res.writeHead(404).end();
	res.writeHead(200, { "content-type": p.endsWith(".svg") ? "image/svg+xml" : "application/json" }).end(readFileSync(p));
});
await new Promise((r) => mirror.listen(0, "127.0.0.1", r));
const mirrorUrl = `http://127.0.0.1:${mirror.address().port}`;
const r = await new Promise((done) => {
	const child = spawn(electron, packaged ? [] : [join(here, "..")], { stdio: "inherit", env: { ...process.env, DRAWAI_E2E: JSON.stringify(config), OMNIDRAW_GALLERY_MIRROR: mirrorUrl } });
	child.on("exit", (status) => done({ status }));
});
mirror.close();
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
