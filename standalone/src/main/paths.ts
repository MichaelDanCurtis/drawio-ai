import { app } from "electron";
import * as path from "path";

// In development <repo>/standalone is the app directory and the draw.io webapp is the
// repo's submodule. In a packaged app both the webapp and the examples are resources.
const packaged = app.isPackaged;
// (the built files are where this file's bundle is: `out`, or `out-e2e` for a test run, which
// is started from that folder so that it leaves a running copy's files alone)
const out = packaged ? path.join(app.getAppPath(), "out") : __dirname;
const appDir = packaged ? app.getAppPath() : path.resolve(out, "..");
const repo = path.resolve(appDir, "..");

export const paths = {
	appDir,
	repo,
	out,
	webapp: process.env.DRAWAI_WEBAPP ?? (packaged ? path.join(process.resourcesPath, "webapp") : path.join(repo, "drawio", "src", "main", "webapp")),
	examples: packaged ? path.join(process.resourcesPath, "examples") : path.join(repo, "examples"),
	// agents run the proxy with Electron as Node, which cannot read inside app.asar from a script path
	stdioProxy: packaged ? path.join(appDir.replace(/app\.asar$/, "app.asar.unpacked"), "out", "mcp-stdio-proxy.js") : path.join(out, "mcp-stdio-proxy.js"),
};
