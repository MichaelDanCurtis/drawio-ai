import { app } from "electron";
import * as path from "path";

// <repo>/standalone is the app directory; the draw.io webapp is the repo's submodule.
const appDir = app.getAppPath();
const repo = path.resolve(appDir, "..");

export const paths = {
	appDir,
	repo,
	out: path.join(appDir, "out"),
	webapp: process.env.DRAWAI_WEBAPP ?? path.join(repo, "drawio", "src", "main", "webapp"),
	examples: path.join(repo, "examples"),
	stdioProxy: path.join(appDir, "out", "mcp-stdio-proxy.js"),
};
