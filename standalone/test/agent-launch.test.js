// Where an agent's program is started (src/main/launchPlace.ts, src/main/acpSession.ts): a
// package runner in the app's own folder, never in the document's.
// Run from standalone/: node --test test/agent-launch.test.js
// No real agent is started and nothing is fetched: the agent is test/helpers/fake-acp-agent.js.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");
const { fetchesPackages, ownLaunchFolder, startFolder, LaunchPlaceError } = require("../src/main/launchPlace");
const { AcpAgentSession } = require("../src/main/acpSession");

const made = [];
const temp = (name) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `omnidraw-launch-${name}-`)));
	made.push(dir);
	return dir;
};
const sessions = [];
after(() => {
	sessions.forEach((s) => s.dispose());
	made.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test("which commands fetch a package and run it", () => {
	for (const c of ["npx", "/usr/local/bin/npx", "/Users/me/.nvm/versions/node/v22.1.0/bin/npx", "C:\\Program Files\\nodejs\\npx.cmd", "NPX.CMD", "pnpm", "bunx", "yarn", "uvx", "npm"]) assert.equal(fetchesPackages(c), true, c);
	// an installed adapter, an agent's own program, node itself: started where the session is, as before
	for (const c of ["claude-agent-acp", "/opt/homebrew/bin/codex-acp", "gemini", "node", "/usr/local/bin/node", "npx-like", "my-npx", ""]) assert.equal(fetchesPackages(c), false, c);
});

test("the app's own folder: made, emptied of what got into it, and never a link", () => {
	const root = temp("root");
	const own = ownLaunchFolder(root);
	assert.equal(own, path.join(root, "agent-start"));
	assert.deepEqual(fs.readdirSync(own), []);
	// what npm would read there is gone by the next start
	fs.writeFileSync(path.join(own, ".npmrc"), "registry=https://example.invalid/\n");
	fs.mkdirSync(path.join(own, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(path.join(own, "package.json"), "{}");
	assert.equal(ownLaunchFolder(root), own);
	assert.deepEqual(fs.readdirSync(own), []);

	// a link under its name leads elsewhere: refused, and nothing behind it is touched
	const elsewhere = temp("elsewhere");
	fs.writeFileSync(path.join(elsewhere, "keep.txt"), "the user's own file");
	const linked = temp("linked");
	fs.symlinkSync(elsewhere, path.join(linked, "agent-start"));
	assert.throws(() => ownLaunchFolder(linked), LaunchPlaceError);
	assert.equal(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8"), "the user's own file");
	// a file under its name: refused too
	const filed = temp("filed");
	fs.writeFileSync(path.join(filed, "agent-start"), "");
	assert.throws(() => ownLaunchFolder(filed), LaunchPlaceError);
});

test("the folder a program is started in", () => {
	assert.equal(startFolder({ startIn: "/app/agent-start" }, "/repo/docs"), "/app/agent-start");
	assert.equal(startFolder({}, "/repo/docs"), "/repo/docs");
});

const FAKE_AGENT = path.join(__dirname, "helpers", "fake-acp-agent.js");
const fakeDef = { id: "fake", label: "Fake agent", cli: [], acp: { command: "node", args: [] }, install: "", signIn: "", hasCredentials: () => true };

/** Starts the stand-in agent and asks it where it was started and where its session is. */
async function whereItRuns(launch, sessionFolder) {
	let said = "";
	const session = new AcpAgentSession(fakeDef, { command: process.execPath, args: [FAKE_AGENT], env: process.env, ...launch }, sessionFolder, undefined, {
		onUpdate: (u) => {
			if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") said += u.content.text;
		},
		requestPermission: async () => ({ outcome: "cancelled" }),
		onExit: () => undefined,
	});
	sessions.push(session);
	await session.start();
	await session.prompt([{ type: "text", text: `STEPS:${JSON.stringify([{ where: true }])}` }]);
	session.dispose();
	const m = /\[started in ([^\]]*)\] \[session in ([^\]]*)\]/.exec(said);
	assert.ok(m, `the agent said where it is: ${said}`);
	return { started: m[1], session: m[2] };
}

test("a launch with a folder of its own is started there, and its session is still the document's", async () => {
	// the document's folder, with what a checked-out repository could bring along
	const repo = temp("repo");
	fs.writeFileSync(path.join(repo, ".npmrc"), "registry=https://example.invalid/\n");
	const own = ownLaunchFolder(temp("app"));
	assert.deepEqual(await whereItRuns({ startIn: own }, repo), { started: own, session: repo });
	// any other program: started in the document's folder, as it always was
	assert.deepEqual(await whereItRuns({}, repo), { started: repo, session: repo });
});
