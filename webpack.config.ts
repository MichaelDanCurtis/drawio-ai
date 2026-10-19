import * as webpack from "webpack";
import path = require("path");
import { CleanWebpackPlugin } from "clean-webpack-plugin";
import * as CopyPlugin from "copy-webpack-plugin";

const r = (file: string) => path.resolve(__dirname, file);

const extensionConfig: webpack.Configuration = {
	entry: r("./src/index"),
	output: {
		path: r("./dist/extension"),
		filename: "index.js",
		libraryTarget: "commonjs2",
		devtoolModuleFilenameTemplate: "../../[resource-path]",
	},
	devtool: "source-map",
	target: "node",
	externals: {
		vscode: "commonjs vscode",
		fs: "commonjs fs",
		path: "commonjs path",
		http: "commonjs http",
	},
	resolve: {
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [
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
	plugins: [
		new CleanWebpackPlugin(),
		new webpack.EnvironmentPlugin({
			DEV: "0",
		}),
		// Without `as any`, I get "Excessive stack depth comparing types with TS 3.2"
		new webpack.IgnorePlugin({ resourceRegExp: /^canvas$/ }) as any,
		new CopyPlugin({
			patterns: [
				{ from: "./src/features/LiveshareFeature/assets", to: "." },
			],
		}),
	],
};

/**
 * Browser guest of the Markdown code block editor (see
 * src/codeblock-editor). A single classic script: the Markdown editor loads
 * the guest HTML via document.write and a plain <script src> is the least
 * surprising way to get code into it.
 */
const codeBlockEditorGuestConfig: webpack.Configuration = {
	entry: r("./src/codeblock-editor/guest/main.ts"),
	output: {
		path: r("./dist/codeblock-editor"),
		filename: "guest.js",
		devtoolModuleFilenameTemplate: "../../[resource-path]",
	},
	devtool: "source-map",
	target: "web",
	resolve: {
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: "ts-loader",
						options: {
							configFile: r("./src/codeblock-editor/guest/tsconfig.json"),
							instance: "codeblock-editor-guest",
						},
					},
				],
			},
		],
	},
	plugins: [
		new CleanWebpackPlugin(),
		// Chunk URLs would resolve against the guest document's <base href>
		// (the Draw.io webapp folder), so keep everything in one file.
		new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
	],
};

/**
 * The agent bridge (src/agent-bridge): a stdio MCP server that Claude Code and
 * Codex start through the agent plugin. It runs outside VS Code (on VS Code's
 * Electron as Node), so it must not import vscode.
 */
const agentBridgeConfig: webpack.Configuration = {
	entry: r("./src/agent-bridge/main.ts"),
	output: {
		path: r("./dist/agent-bridge"),
		filename: "index.js",
		libraryTarget: "commonjs2",
		devtoolModuleFilenameTemplate: "../../[resource-path]",
	},
	devtool: "source-map",
	target: "node",
	resolve: {
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						// Type errors are reported by the extension build, which compiles the same files.
						loader: "ts-loader",
						options: { instance: "agent-bridge", transpileOnly: true },
					},
				],
			},
		],
	},
	plugins: [
		new CleanWebpackPlugin(),
		new webpack.EnvironmentPlugin({
			DRAWIO_AI_VERSION: require("./package.json").version,
		}),
	],
};

module.exports = [extensionConfig, codeBlockEditorGuestConfig, agentBridgeConfig];
