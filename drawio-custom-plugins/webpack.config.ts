import * as webpack from "webpack";
import path = require("path");
import { CleanWebpackPlugin } from "clean-webpack-plugin";
import * as CopyPlugin from "copy-webpack-plugin";
// Bundled with webpack. ASCII-only output keeps the UI glyphs (✦, —, …) intact however draw.io loads the script.
const TerserPlugin = require("terser-webpack-plugin");

const r = (file: string) => path.resolve(__dirname, file);

/** The font files the shared theme and presentation mode name (theme.js, presentation.js). */
const OMNI_FONTS = [
	"space-grotesk-latin-400-normal",
	"space-grotesk-latin-ext-400-normal",
	"space-grotesk-latin-500-normal",
	"space-grotesk-latin-ext-500-normal",
	"space-mono-latin-400-normal",
	"space-mono-latin-ext-400-normal",
];

module.exports = {
	target: "web",
	entry: r("./src/index"),
	output: {
		path: r("../dist/custom-drawio-plugins"),
		filename: "index.js",
		libraryTarget: "window",
		devtoolModuleFilenameTemplate: "../[resource-path]",
	},
	devtool: "source-map",
	externals: {
		vscode: "commonjs vscode",
	},
	resolve: {
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [
			{ test: /\.css$/, use: ["style-loader", "css-loader"] },
			{
				test: /\.html$/i,
				loader: "raw-loader",
			},
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: "ts-loader",
					},
				],
			},
		],
	},
	node: {
		__dirname: false,
	},
	optimization: {
		minimizer: [new TerserPlugin({ terserOptions: { format: { ascii_only: true } } })],
	},
	plugins: [
		new CleanWebpackPlugin(),
		// The editor tools and the look shared with the desktop app (see
		// src/features/editorLook.ts): its own files, as they are, in the layout
		// its pages use (/ui and /plugin), with the fonts the look is set in.
		new CopyPlugin({
			patterns: [
				// (brands.js and the style sheets are for the Map Something and Shape Workshop pages: src/features/mapper, workshop)
				...["icons.js", "brandmark.js", "tips.js", "dots.js", "matrix.js", "brands.js", "fonts.css", "tokens.css", "motion.css", "depth.css", "app.css"].map((f) => ({
					from: r(`../standalone/src/renderer/ui/${f}`),
					to: `omni/ui/${f}`,
				})),
				...["theme.js", "desktop-toolbar.js", "presentation.js"].map((f) => ({
					from: r(`../standalone/src/renderer/${f}`),
					to: `omni/plugin/${f}`,
				})),
				{ from: r("../standalone/src/renderer/mapper.html"), to: "omni/mapper.html" },
				{ from: r("../standalone/src/renderer/workshop.html"), to: "omni/workshop.html" },
				...OMNI_FONTS.map((f) => ({
					from: r(`../node_modules/@fontsource/${f.replace(/-(latin).*$/, "")}/files/${f}.woff2`),
					to: `omni/ui/fonts/${f}.woff2`,
				})),
			],
		}),
	],
} as webpack.Configuration;
