// Packs the editor add-ons for another host (out/frame, see src/renderer/frame/README.md) as
// dist/omnidraw-frame-<version>.zip, holding one folder, omnidraw-frame/. Run after a build.
// It goes up with a release beside the app, for a host that fetches it (OmniPad does).
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const frame = join(here, "out/frame");
if (!existsSync(join(frame, "omnidraw-frame.js"))) throw new Error("out/frame is not built: run the build first (yarn build).");
const version = readFileSync(join(frame, "VERSION"), "utf8").trim();
const tmp = mkdtempSync(join(tmpdir(), "omnidraw-frame-"));
try {
	cpSync(frame, join(tmp, "omnidraw-frame"), { recursive: true });
	mkdirSync(join(here, "dist"), { recursive: true });
	const zip = join(here, "dist", `omnidraw-frame-${version}.zip`);
	rmSync(zip, { force: true });
	// (zip is there on macOS and Linux; -X leaves out what only this computer's file system knows)
	execFileSync("zip", ["-r", "-X", "-q", zip, "omnidraw-frame"], { cwd: tmp, stdio: "inherit" });
	console.log(`Packed ${zip}`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
