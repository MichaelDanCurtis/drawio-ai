// Lets tests require the standalone app's TypeScript directly (transpile only).
const path = require("path");
require(require.resolve("ts-node", { paths: [path.resolve(__dirname, "../../..")] })).register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", moduleResolution: "node", target: "es2022", esModuleInterop: true },
	skipProject: true,
});
