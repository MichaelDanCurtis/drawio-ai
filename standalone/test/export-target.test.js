// Where a file an agent asked for is written (src/main/exportTarget.ts): never through a link.
// Run from standalone/: node --test test/export-target.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");
const { ExportTargetError, exportTarget, realPath, writeExport } = require("../src/main/exportTarget");

const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof ExportTargetError && pattern.test(e.message), `expected a refusal matching ${pattern}`);

/** A folder for one test, with a file of the user's in it that no export may touch. */
function folder() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-export-test-"));
	const victim = path.join(dir, "notes.txt");
	fs.writeFileSync(victim, "the user's own file");
	return { dir, real: fs.realpathSync(dir), victim, untouched: () => assert.equal(fs.readFileSync(victim, "utf8"), "the user's own file"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("where an export would land: a new file, a file that is there, and what is refused", () => {
	const f = folder();
	try {
		// nothing there: it can be written, and its real place is known (the folder's own links followed)
		assert.deepEqual(exportTarget(path.join(f.dir, "plan.svg")), { exists: false, real: path.join(f.real, "plan.svg") });
		// a file there: said so, for the user to be asked
		fs.writeFileSync(path.join(f.dir, "old.svg"), "old");
		assert.deepEqual(exportTarget(path.join(f.dir, "old.svg")), { exists: true, real: path.join(f.real, "old.svg") });
		// a link under the export's name, to a file or to nothing, is refused; so is a folder
		fs.symlinkSync(f.victim, path.join(f.dir, "drawing.svg"));
		fs.symlinkSync(path.join(f.dir, "not-there"), path.join(f.dir, "dangling.svg"));
		fs.mkdirSync(path.join(f.dir, "folder.svg"));
		refused(() => exportTarget(path.join(f.dir, "drawing.svg")), /^drawing\.svg is a link to another file, and an export is not written through a link\. Export under another name\.$/);
		refused(() => exportTarget(path.join(f.dir, "dangling.svg")), /is a link to another file/);
		refused(() => exportTarget(path.join(f.dir, "folder.svg")), /^folder\.svg is not a file\.$/);
		refused(() => exportTarget(path.join(f.dir, "no-such-folder", "plan.svg")), /^The folder .*no-such-folder does not exist\.$/);
		// a link in the folders above is followed to where it leads: that place is what is compared, shown and written
		fs.mkdirSync(path.join(f.dir, "exports"));
		fs.symlinkSync(path.join(f.dir, "exports"), path.join(f.dir, "shortcut"));
		assert.equal(exportTarget(path.join(f.dir, "shortcut", "plan.svg")).real, path.join(f.real, "exports", "plan.svg"));
		assert.equal(realPath(path.join(f.dir, "shortcut")), path.join(f.real, "exports"));
		assert.equal(realPath(path.join(f.dir, "not-there-at-all.svg")), path.resolve(f.dir, "not-there-at-all.svg"));
		f.untouched();
	} finally {
		f.done();
	}
});

test("a new file is made only if nothing has its name, not even a link that appeared meanwhile", () => {
	const f = folder();
	try {
		const fresh = path.join(f.real, "fresh.svg");
		writeExport(fresh, Buffer.from("<svg>1</svg>"), false);
		assert.equal(fs.readFileSync(fresh, "utf8"), "<svg>1</svg>");
		refused(() => writeExport(fresh, Buffer.from("<svg>2</svg>"), false), /^fresh\.svg appeared while the export was made\. Nothing was written\.$/);
		assert.equal(fs.readFileSync(fresh, "utf8"), "<svg>1</svg>");
		// (looked at, it was not there; by the time it is written, a link is)
		const raced = path.join(f.real, "raced.svg");
		assert.equal(exportTarget(raced).exists, false);
		fs.symlinkSync(f.victim, raced);
		refused(() => writeExport(raced, Buffer.from("<svg>3</svg>"), false), /appeared while the export was made/);
		f.untouched();
	} finally {
		f.done();
	}
});

test("a file the user agreed to replace is written into as it is, and nothing goes through a link", () => {
	const f = folder();
	try {
		const old = path.join(f.real, "old.svg");
		fs.writeFileSync(old, "old, and rather longer than what comes in its place");
		const before = fs.statSync(old).ino;
		writeExport(old, Buffer.from("<svg>new</svg>"), true);
		// (the whole of it is the new export, and it is the file it was: not another one under its name)
		assert.equal(fs.readFileSync(old, "utf8"), "<svg>new</svg>");
		assert.equal(fs.statSync(old).ino, before);
		assert.deepEqual(fs.readdirSync(f.real).sort(), ["notes.txt", "old.svg"]);
		// a link took its place between the question and the writing
		const swapped = path.join(f.real, "swapped.svg");
		fs.writeFileSync(swapped, "agreed to replace this");
		assert.equal(exportTarget(swapped).exists, true);
		fs.rmSync(swapped);
		fs.symlinkSync(f.victim, swapped);
		refused(() => writeExport(swapped, Buffer.from("<svg>4</svg>"), true), /is a link to another file/);
		f.untouched();
		// a file that went away meanwhile is simply written
		writeExport(path.join(f.real, "gone.svg"), Buffer.from("<svg>5</svg>"), true);
		assert.equal(fs.readFileSync(path.join(f.real, "gone.svg"), "utf8"), "<svg>5</svg>");
		// a second name of the user's file (a hard link) is not written into: that would be the other file too
		const twin = path.join(f.real, "twin.svg");
		fs.linkSync(f.victim, twin);
		refused(() => writeExport(twin, Buffer.from("<svg>6</svg>"), true), /hard link/);
		f.untouched();
	} finally {
		f.done();
	}
});

/** Makes the next write into an open file fail half-way, as a full disk does; returns what puts things right again. */
function fullDiskOnce() {
	const write = fs.writeSync;
	let failed = false;
	fs.writeSync = (fd, ...rest) => {
		if (failed) return write(fd, ...rest);
		failed = true;
		write(fd, "half of");
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	};
	return () => (fs.writeSync = write);
}

test("a replaced file keeps who may read it, however long its name is, and a write that fails leaves things as they were", () => {
	const f = folder();
	try {
		// a private file stays private
		const secret = path.join(f.real, "private.svg");
		fs.writeFileSync(secret, "old", { mode: 0o600 });
		fs.chmodSync(secret, 0o600);
		writeExport(secret, Buffer.from("<svg>new</svg>"), true);
		assert.equal(fs.readFileSync(secret, "utf8"), "<svg>new</svg>");
		if (process.platform !== "win32") assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
		// and one that others may read still may be
		const shared = path.join(f.real, "shared.svg");
		fs.writeFileSync(shared, "old");
		fs.chmodSync(shared, 0o664);
		writeExport(shared, Buffer.from("<svg>new</svg>"), true);
		if (process.platform !== "win32") assert.equal(fs.statSync(shared).mode & 0o777, 0o664);

		// a name as long as a file system takes (255 bytes) can still be replaced
		const long = path.join(f.real, `${"a".repeat(251)}.svg`);
		fs.writeFileSync(long, "old");
		writeExport(long, Buffer.from("<svg>long</svg>"), true);
		assert.equal(fs.readFileSync(long, "utf8"), "<svg>long</svg>");

		// the disk fills up while the new export is written: the old one is put back, and nothing is left beside it
		const kept = path.join(f.real, "kept.svg");
		fs.writeFileSync(kept, "still here");
		const names = fs.readdirSync(f.real).sort();
		let restore = fullDiskOnce();
		try {
			assert.throws(() => writeExport(kept, Buffer.from("<svg>never</svg>"), true), /ENOSPC/);
		} finally {
			restore();
		}
		assert.equal(fs.readFileSync(kept, "utf8"), "still here");
		assert.deepEqual(fs.readdirSync(f.real).sort(), names);
		// the same for a new file: half an export is not left under its name
		restore = fullDiskOnce();
		try {
			assert.throws(() => writeExport(path.join(f.real, "half.svg"), Buffer.from("<svg>never</svg>"), false), /ENOSPC/);
		} finally {
			restore();
		}
		assert.equal(fs.existsSync(path.join(f.real, "half.svg")), false);
		f.untouched();
	} finally {
		f.done();
	}
});

test("a replaced file stays its group's, and keeps the list of who may and may not read it", (t) => {
	if (process.platform === "win32") return t.skip("a file's group and access list are not read this way on Windows");
	const { execFileSync } = require("child_process");
	const f = folder();
	try {
		// a file of a group that new files in this folder do not get (as one shared with a team is)
		const team = path.join(f.real, "team.svg");
		fs.writeFileSync(team, "old");
		fs.chmodSync(team, 0o640);
		const mine = fs.statSync(team);
		const other = process.getgroups().find((g) => g !== mine.gid);
		if (other !== undefined) {
			fs.chownSync(team, mine.uid, other);
			writeExport(team, Buffer.from("<svg>new</svg>"), true);
			const now = fs.statSync(team);
			assert.equal(fs.readFileSync(team, "utf8"), "<svg>new</svg>");
			assert.deepEqual([now.uid, now.gid, now.mode & 0o777, now.ino], [mine.uid, other, 0o640, mine.ino]);
		}

		// a file with an access list that keeps somebody out: they are still kept out afterwards
		const listed = path.join(f.real, "listed.svg");
		fs.writeFileSync(listed, "old");
		fs.chmodSync(listed, 0o644);
		let list;
		try {
			if (process.platform === "darwin") {
				execFileSync("/bin/chmod", ["+a", "user:nobody deny read", listed], { stdio: "pipe" });
				list = () => execFileSync("/bin/ls", ["-le", listed], { encoding: "utf8" }).split("\n").slice(1).join("\n").trim();
			} else {
				execFileSync("setfacl", ["-m", "u:nobody:---", listed], { stdio: "pipe" });
				list = () => execFileSync("getfacl", ["-c", "-p", listed], { encoding: "utf8" }).trim();
			}
		} catch {
			list = undefined; // (no access lists on this file system, or not the programs for them)
		}
		if (list) {
			const before = list();
			assert.match(before, /nobody/);
			writeExport(listed, Buffer.from("<svg>new</svg>"), true);
			assert.equal(fs.readFileSync(listed, "utf8"), "<svg>new</svg>");
			assert.equal(list(), before);
		}
		if (other === undefined && !list) return t.skip("this user is in one group only, and access lists cannot be set here");
	} finally {
		f.done();
	}
});
