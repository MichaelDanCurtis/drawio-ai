const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");
const { RunLog, logLine, errorDetails } = require("../src/main/runLog");

test("the run log: a line per start and end, and a run that ended without a word is named by the next one", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-run-log-"));
	const file = path.join(dir, "logs", "app.log");
	const lines = () => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => l.replace(/^\S+ /, ""));

	// a first run that quits
	const first = new RunLog(file);
	first.started({ version: "1.0.0", pid: 11 });
	first.end("quit", { code: 0, pid: 11 });
	first.end("quit", { code: 0, pid: 11 });
	assert.deepEqual(lines(), ["started version=1.0.0 pid=11", "ended why=quit code=0 pid=11"]);

	// a second that is killed: nothing is written at its end, the third says so
	new RunLog(file).started({ version: "1.0.0", pid: 22 });
	const third = new RunLog(file);
	third.started({ version: "1.0.0", pid: 33 });
	assert.match(lines()[3], /^the run before this one ended without a word \(crashed or was killed\) started=\S+ pid=22$/);
	assert.equal(lines()[4], "started version=1.0.0 pid=33");
	// what goes wrong while it runs is a line of its own, and is not an end
	third.write("a window's page ended", { reason: "crashed", code: 5, page: "chat.html" });
	third.end("quit", { code: 0, pid: 33 });
	new RunLog(file).started({ version: "1.0.0", pid: 44 });
	assert.deepEqual(lines().slice(5), ["a window's page ended reason=crashed code=5 page=chat.html", "ended why=quit code=0 pid=33", "started version=1.0.0 pid=44"]);
	assert.match(fs.readFileSync(file, "utf8").split("\n")[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z started /);
});

test("the run log: one line whatever is in it, an error by its name and first line, and a file that stays small", () => {
	assert.equal(logLine("x", { a: "two\nlines\tand  spaces", b: undefined, c: "", d: 0 }, new Date(0)), "1970-01-01T00:00:00.000Z x a=two lines and spaces d=0");
	assert.ok(logLine("x", { a: "y".repeat(5000) }).length <= 600);
	const e = new TypeError("first line\nsecond line with a secret");
	const d = errorDetails(e);
	assert.equal(d.error, "TypeError: first line");
	assert.ok(d.at && !/\n/.test(d.at));
	assert.deepEqual(errorDetails("just words"), { error: "Error: just words", at: errorDetails("just words").at });

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-run-log-"));
	const file = path.join(dir, "app.log");
	const log = new RunLog(file);
	for (let i = 0; i < 4000; i++) log.write("filler", { n: i, pad: "p".repeat(200) });
	assert.ok(fs.statSync(file).size < 300 * 1024, `${fs.statSync(file).size} bytes`);
	const kept = fs.readFileSync(file, "utf8").trim().split("\n");
	assert.match(kept[0], /^\S+ filler n=\d+ /, "what is kept starts at a whole line");
	assert.match(kept.at(-1), / n=3999 /);

	// a log that cannot be written is not a reason to fail
	const blocked = path.join(dir, "a-file");
	fs.writeFileSync(blocked, "x");
	assert.doesNotThrow(() => new RunLog(path.join(blocked, "logs", "app.log")).started({ pid: 1 }));
});
