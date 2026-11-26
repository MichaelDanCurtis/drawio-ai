// Bundles the Electron main process, the preloads, the draw.io plugin and the
// MCP stdio proxy with esbuild. Shared code is imported straight from ../src
// (read-only); `vscode` resolves to a small shim (src/main/vscode-shim.ts).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
// `--out <folder>`: build somewhere else than `out` (the end-to-end run builds into `out-e2e`,
// so that a test never replaces the files of a copy of the app that is running from `out`).
const outArg = process.argv.indexOf("--out");
const outName = outArg >= 0 ? process.argv[outArg + 1] : "out";
// (a folder directly in this one, by its name: the app finds its sources from where its build is, one level up)
if (!outName || !/^[\w.-]+$/.test(outName) || outName.startsWith(".") || ["src", "test", "scripts", "node_modules", "build", "dist"].includes(outName)) {
	console.error(`--out takes the name of a folder in ${here} to build into (letters, digits, - and _), such as out-e2e; not a path, and not one of the app's own folders.`);
	process.exit(2);
}
const out = join(here, outName);
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
			"preload-live": join(here, "src/preload/live.ts"),
			"preload-settings": join(here, "src/preload/settings.ts"),
			"preload-workshop": join(here, "src/preload/workshop.ts"),
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
for (const f of ["chat.html", "mapper.html", "live.html", "settings.html", "workshop.html", "desktop-menu.js", "desktop-toolbar.js", "desktop-menubar.js", "presentation.js", "theme.js"]) copyFileSync(join(here, "src/renderer", f), join(out, f));
// The app's look (omni-design): tokens, motion, the dot layers, and the self-hosted fonts.
mkdirSync(join(out, "ui/fonts"), { recursive: true });
for (const f of readdirSync(join(here, "src/renderer/ui"))) copyFileSync(join(here, "src/renderer/ui", f), join(out, "ui", f));
for (const [pkg, files] of Object.entries({
	"space-grotesk": ["latin-400-normal", "latin-ext-400-normal", "latin-500-normal", "latin-ext-500-normal"],
	"space-mono": ["latin-400-normal", "latin-ext-400-normal"],
	doto: ["latin-700-normal"],
}))
	for (const f of files) copyFileSync(join(here, "node_modules/@fontsource", pkg, "files", `${pkg}-${f}.woff2`), join(out, "ui/fonts", `${pkg}-${f}.woff2`));
// (a build elsewhere is an app folder of its own for Electron to start: same name and version, its main beside it)
if (out !== join(here, "out")) {
	const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
	writeFileSync(join(out, "package.json"), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: "main.js" }, null, "\t"));
}
console.log(`Built to ${out}${watch ? " (watch not supported; rerun)" : ""}`);
