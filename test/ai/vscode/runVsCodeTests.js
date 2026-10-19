// Launches an isolated VS Code (temp profile, other extensions disabled) and runs suite.js
// in its extension host. Build first: `yarn build-extension && yarn build-plugins` (or the dev builds).
// Usage: node test/ai/vscode/runVsCodeTests.js   (VSCODE_EXECUTABLE overrides the binary)
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const executable =
	process.env.VSCODE_EXECUTABLE ||
	{
		darwin: "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
		win32: path.join(process.env.LOCALAPPDATA || "", "Programs/Microsoft VS Code/Code.exe"),
		linux: "/usr/share/code/code",
	}[process.platform];

if (!executable || !fs.existsSync(executable)) {
	console.error(`VS Code not found at ${executable}. Set VSCODE_EXECUTABLE.`);
	process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-ai-vscode-"));
// A workspace folder for the `file` and agent tests, and throwaway homes for the agent
// bridge, Claude Code and Codex, so the Connect test never touches the real configuration.
const workspace = path.join(profile, "workspace");
const isolated = {
	DRAWIO_AI_HOME: path.join(profile, "drawio-ai-home"),
	CLAUDE_CONFIG_DIR: path.join(profile, "claude"),
	CODEX_HOME: path.join(profile, "codex"),
};
for (const dir of [workspace, ...Object.values(isolated)]) fs.mkdirSync(dir, { recursive: true });
const child = spawn(
	executable,
	[
		`--extensionDevelopmentPath=${root}`,
		`--extensionTestsPath=${path.join(__dirname, "suite.js")}`,
		`--user-data-dir=${path.join(profile, "user")}`,
		`--extensions-dir=${path.join(profile, "extensions")}`,
		"--disable-extensions",
		"--disable-workspace-trust",
		"--skip-welcome",
		"--skip-release-notes",
		"--new-window",
		workspace,
	],
	{ stdio: "inherit", env: { ...process.env, ...isolated, ELECTRON_RUN_AS_NODE: undefined } }
);
child.on("exit", (code) => {
	fs.rmSync(profile, { recursive: true, force: true });
	process.exit(code ?? 1);
});
