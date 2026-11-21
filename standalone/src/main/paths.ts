import { app } from "electron";
import * as path from "path";

// In development <repo>/standalone is the app directory and the draw.io webapp is the
// repo's submodule. In a packaged app both the webapp and the examples are resources.
const appDir = app.getAppPath();
const repo = path.resolve(appDir, "..");
const packaged = app.isPackaged;
const out = path.join(appDir, "out");

export const paths = {
	appDir,
	repo,
	out,
	webapp: process.env.DRAWAI_WEBAPP ?? (packaged ? path.join(process.resourcesPath, "webapp") : path.join(repo, "drawio", "src", "main", "webapp")),
	examples: packaged ? path.join(process.resourcesPath, "examples") : path.join(repo, "examples"),
	// agents run the proxy with Electron as Node, which cannot read inside app.asar from a script path
	stdioProxy: path.join(packaged ? appDir.replace(/app\.asar$/, "app.asar.unpacked") : appDir, "out", "mcp-stdio-proxy.js"),
};
