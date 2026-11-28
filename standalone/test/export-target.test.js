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

test("a file the user agreed to replace is replaced whole, and nothing goes through a link that took its place", () => {
	const f = folder();
	try {
		const old = path.join(f.real, "old.svg");
		fs.writeFileSync(old, "old");
		writeExport(old, Buffer.from("<svg>new</svg>"), true);
		assert.equal(fs.readFileSync(old, "utf8"), "<svg>new</svg>");
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
		// what was a hard link to the user's file is not written into either: the name gets a file of its own
		const twin = path.join(f.real, "twin.svg");
		fs.linkSync(f.victim, twin);
		writeExport(twin, Buffer.from("<svg>6</svg>"), true);
		assert.equal(fs.readFileSync(twin, "utf8"), "<svg>6</svg>");
		f.untouched();
		// nothing is left behind
		assert.deepEqual(fs.readdirSync(f.real).filter((n) => n.endsWith(".tmp")), []);
	} finally {
		f.done();
	}
});

test("a replaced file keeps who may read it, however long its name is, and a write that fails leaves nothing behind", () => {
	const f = folder();
	try {
		// a private file stays private (the new file is not given what a new file gets by default)
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

		// the disk fills up while the new file is written: the old one is as it was, and nothing is left beside it
		const kept = path.join(f.real, "kept.svg");
		fs.writeFileSync(kept, "still here");
		const write = fs.writeFileSync;
		fs.writeFileSync = (target, ...rest) => {
			if (typeof target !== "number") return write(target, ...rest);
			fs.writeSync(target, "half of");
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		};
		try {
			assert.throws(() => writeExport(kept, Buffer.from("<svg>never</svg>"), true), /ENOSPC/);
		} finally {
			fs.writeFileSync = write;
		}
		assert.equal(fs.readFileSync(kept, "utf8"), "still here");
		assert.deepEqual(fs.readdirSync(f.real).filter((n) => n.endsWith(".tmp")), []);
		// the same for a new file: half an export is not left under its name
		fs.writeFileSync = (target, ...rest) => {
			if (typeof target !== "number") return write(target, ...rest);
			fs.writeSync(target, "half of");
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		};
		try {
			assert.throws(() => writeExport(path.join(f.real, "half.svg"), Buffer.from("<svg>never</svg>"), false), /ENOSPC/);
		} finally {
			fs.writeFileSync = write;
		}
		assert.equal(fs.existsSync(path.join(f.real, "half.svg")), false);
		f.untouched();
	} finally {
		f.done();
	}
});

test("a replaced file stays its owner's and its group's, and is not replaced where that cannot be kept", (t) => {
	if (process.platform === "win32") return t.skip("a file has no group to keep on Windows");
	const f = folder();
	try {
		// a file of a group that new files in this folder do not get (as one shared with a team is)
		const shared = path.join(f.real, "team.svg");
		fs.writeFileSync(shared, "old");
		fs.chmodSync(shared, 0o640);
		const mine = fs.statSync(shared);
		const other = process.getgroups().find((g) => g !== mine.gid);
		if (other === undefined) return t.skip("this user is in one group only");
		fs.chownSync(shared, mine.uid, other);
		writeExport(shared, Buffer.from("<svg>new</svg>"), true);
		const now = fs.statSync(shared);
		assert.equal(fs.readFileSync(shared, "utf8"), "<svg>new</svg>");
		assert.deepEqual([now.uid, now.gid, now.mode & 0o777], [mine.uid, other, 0o640]);

		// the old file's owner or group cannot be given to the new one (another user's file, a group
		// this user is not in): it is not replaced by one that other people could read
		const chown = fs.fchownSync;
		fs.fchownSync = () => {
			throw Object.assign(new Error("EPERM: operation not permitted, fchown"), { code: "EPERM" });
		};
		try {
			refused(() => writeExport(shared, Buffer.from("<svg>never</svg>"), true), /belongs to another user or group/);
		} finally {
			fs.fchownSync = chown;
		}
		assert.equal(fs.readFileSync(shared, "utf8"), "<svg>new</svg>");
		assert.equal(fs.statSync(shared).gid, other);
		assert.deepEqual(fs.readdirSync(f.real).filter((n) => n.endsWith(".tmp")), []);
		f.untouched();
	} finally {
		f.done();
	}
});
