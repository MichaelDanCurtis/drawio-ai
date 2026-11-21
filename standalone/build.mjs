// Bundles the Electron main process, the preloads, the draw.io plugin and the
// MCP stdio proxy with esbuild. Shared code is imported straight from ../src
// (read-only); `vscode` resolves to a small shim (src/main/vscode-shim.ts).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const repo = resolve(here, "..");
const watch = process.argv.includes("--watch");
mkdirSync(out, { recursive: true });

const common = {
	bundle: true,
	sourcemap: "linked",
	logLevel: "warning",
	// ../src and ../drawio-custom-plugins import packages; resolve them from here.
	nodePaths: [join(here, "node_modules")],
	charset: "ascii",
	target: "es2022",
};

/** `import "./x.css"` → inject a <style> (what style-loader does in the extension build). */
const cssAsStyleTag = {
	name: "css-as-style-tag",
	setup(b) {
		b.onLoad({ filter: /\.css$/ }, (args) => ({
			loader: "js",
			contents: `const s=document.createElement("style");s.textContent=${JSON.stringify(readFileSync(args.path, "utf8"))};document.head.appendChild(s);`,
		}));
	},
};

/**
 * The plugin sources use `import * as m from "mithril"` and call `m(...)`, which
 * works with webpack's CommonJS interop but not with esbuild's: import the default.
 */
const mithrilDefaultImport = {
	name: "mithril-default-import",
	setup(b) {
		b.onLoad({ filter: /drawio-custom-plugins[\\/]src[\\/].*\.ts$/ }, (args) => ({
			loader: "ts",
			contents: readFileSync(args.path, "utf8").replace(/import \* as m from "mithril";/g, 'import m from "mithril";'),
		}));
	},
};

const jobs = [
	{
		...common,
		entryPoints: { main: join(here, "src/main/main.ts") },
		outdir: out,
		platform: "node",
		format: "cjs",
		// Database drivers load optional native add-ons at runtime: keep them out of the bundle.
		external: ["electron", "pg", "pg-native", "mysql2", "mssql", "tedious", "oracledb", "mongodb"],
		alias: { vscode: join(here, "src/main/vscode-shim.ts") },
		loader: { ".html": "text" },
	},
	{
		...common,
		entryPoints: {
			"preload-editor": join(here, "src/preload/editor.ts"),
			"preload-chat": join(here, "src/preload/chat.ts"),
			"preload-mapper": join(here, "src/preload/mapper.ts"),
		},
		outdir: out,
		platform: "node",
		format: "cjs",
		external: ["electron"],
		sourcemap: false,
	},
	{
		...common,
		entryPoints: { "mcp-stdio-proxy": join(here, "src/proxy/mcp-stdio-proxy.ts") },
		outdir: out,
		platform: "node",
		format: "cjs",
		sourcemap: false,
	},
	{
		// The Draw.AI draw.io plugin, built the way `yarn build-plugins` builds it for the extension.
		...common,
		entryPoints: { "drawio-plugin": join(repo, "drawio-custom-plugins/src/index.ts") },
		outdir: out,
		platform: "browser",
		format: "iife",
		external: ["vscode"],
		plugins: [cssAsStyleTag, mithrilDefaultImport],
		loader: { ".html": "text" },
		minify: true,
		tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
	},
];

await Promise.all(jobs.map((j) => build(j)));
for (const f of ["chat.html", "mapper.html", "desktop-menu.js"]) copyFileSync(join(here, "src/renderer", f), join(out, f));
console.log(`Built to ${out}${watch ? " (watch not supported; rerun)" : ""}`);
