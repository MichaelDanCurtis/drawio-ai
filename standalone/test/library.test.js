// The library behind the home screen (src/main/library): documents in a folder, collections,
// the trash, versions, the list of recent documents, and the sketches drawn for cards.
// Run from standalone/: node --test test/library.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
require("./helpers/ts");
const { Library, LibraryError, canonicalPath, cleanName, docType, VERSION_WINDOW, MAX_VERSIONS } = require("../src/main/library/library");
const { Recents, readRecent, RecentFileError } = require("../src/main/library/recents");
const { sketchExcalidraw, sketchDrawio, firstPage, safeColour } = require("../src/main/library/sketch");

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function temp(name = "library") {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `omnidraw-${name}-`)));
	made.push(dir);
	return dir;
}
const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof LibraryError && pattern.test(e.message), `expected a refusal matching ${pattern}`);
const B = (s) => Buffer.from(s);
const ids = (lib) => lib.contents().docs.map((d) => d.id).sort();

test("what a file's name says it is", () => {
	assert.deepEqual(docType("Plan.excalidraw"), { name: "Plan", ending: ".excalidraw", kind: "excalidraw" });
	assert.deepEqual(docType("Plan.excalidraw.PNG"), { name: "Plan", ending: ".excalidraw.PNG", kind: "excalidraw" });
	assert.deepEqual(docType("net.v2.drawio.svg"), { name: "net.v2", ending: ".drawio.svg", kind: "drawio" });
	assert.deepEqual(docType("old.dio"), { name: "old", ending: ".dio", kind: "drawio" });
	for (const n of ["notes.txt", "picture.png", "picture.svg", ".drawio", "drawio", "Plan.excalidraw.bak"]) assert.equal(docType(n), undefined, n);
});

test("a name is a name: never a path, never hidden, never one the system keeps", () => {
	assert.equal(cleanName("  Road   map  "), "Road map");
	for (const bad of ["", "   ", "a/b", "a\\b", "..", ".hidden", "trailing.", "what?", "a:b", "nul", "COM1", "x".repeat(121), "bell\u0007here"]) refused(() => cleanName(bad), /./);
	// (white space of any kind between words is one space)
	assert.equal(cleanName("tab\there"), "tab here");
});

test("reading the library: documents, collections, and what is left out", () => {
	const root = temp();
	const lib = new Library(root);
	fs.writeFileSync(path.join(root, "Top.drawio"), "<mxfile/>");
	fs.mkdirSync(path.join(root, "Team", "deep"), { recursive: true });
	fs.writeFileSync(path.join(root, "Team", "Plan.excalidraw"), "{}");
	fs.writeFileSync(path.join(root, "Team", "deep", "Net.drawio.svg"), "<svg/>");
	fs.mkdirSync(path.join(root, "Empty"));
	// left out: other files, hidden folders, other people's code, links (which could lead anywhere)
	fs.writeFileSync(path.join(root, "notes.txt"), "x");
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "Hidden.drawio"), "x");
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.writeFileSync(path.join(root, "node_modules", "Dep.drawio"), "x");
	const outside = temp("outside");
	fs.writeFileSync(path.join(outside, "Elsewhere.drawio"), "x");
	fs.symlinkSync(outside, path.join(root, "Linked"));
	fs.symlinkSync(path.join(outside, "Elsewhere.drawio"), path.join(root, "Link.drawio"));

	const c = lib.contents();
	assert.deepEqual(c.docs.map((d) => d.id).sort(), ["Team/Plan.excalidraw", "Team/deep/Net.drawio.svg", "Top.drawio"]);
	assert.deepEqual(c.collections, [{ name: "Empty", count: 0 }, { name: "Team", count: 2 }]);
	const net = c.docs.find((d) => d.name === "Net");
	assert.deepEqual([net.collection, net.within, net.kind, net.ending], ["Team", "deep", "drawio", ".drawio.svg"]);
	assert.equal(c.more, false);

	// which document a file is, when it is one in the library
	assert.equal(lib.idOf(path.join(root, "Team", "Plan.excalidraw")), "Team/Plan.excalidraw");
	assert.equal(lib.idOf(path.join(root, "Team", "New one.excalidraw")), "Team/New one.excalidraw");
	for (const f of [path.join(outside, "Elsewhere.drawio"), path.join(root, "notes.txt"), path.join(root, ".git", "Hidden.drawio"), path.join(root, "Linked", "Elsewhere.drawio"), path.join(root, ".omnidraw", "trash", "x", "item.drawio")]) assert.equal(lib.idOf(f), undefined, f);
});

test("a library nothing was put into has no folder: looking at it makes none", () => {
	const parent = temp();
	const folder = path.join(parent, "OmniDraw");
	const lib = new Library(folder);
	assert.deepEqual(lib.contents(), { docs: [], collections: [], trash: [], more: false });
	assert.equal(lib.idOf(path.join(folder, "Plan.drawio")), undefined);
	assert.equal(lib.thumb("Plan.drawio"), undefined);
	assert.deepEqual(lib.versions("Plan.drawio"), []);
	refused(() => lib.read("Plan.drawio"), /not in the library/);
	assert.equal(lib.exists, false);
	assert.equal(fs.existsSync(folder), false);
	// the first document makes it
	assert.equal(lib.create("Team", "Plan", ".drawio", B("x")), "Team/Plan.drawio");
	assert.equal(lib.exists, true);
	assert.equal(lib.root, path.join(parent, "OmniDraw"));
	assert.equal(lib.idOf(path.join(folder, "Team", "Plan.drawio")), "Team/Plan.drawio");
	// a file where the folder should be is no library
	fs.writeFileSync(path.join(parent, "a file"), "x");
	refused(() => new Library(path.join(parent, "a file")), /not a folder/);
});

test("an id leads nowhere but into the library", () => {
	const root = temp();
	const lib = new Library(root);
	const outside = temp("outside");
	fs.writeFileSync(path.join(outside, "Secret.drawio"), "secret");
	fs.symlinkSync(outside, path.join(root, "Linked"));
	fs.symlinkSync(path.join(outside, "Secret.drawio"), path.join(root, "Link.drawio"));
	for (const id of ["../Secret.drawio", "Team/../../Secret.drawio", "/etc/passwd", ".omnidraw/trash/x/item.drawio", "", "a//b.drawio", "notes.txt", "Linked/Secret.drawio", "Link.drawio", "a\\b.drawio"]) {
		refused(() => lib.read(id), /not (a document )?in the library/);
		refused(() => lib.trash(id), /not (a document )?in the library/);
		refused(() => lib.rename(id, "x"), /not (a document )?in the library/);
	}
	assert.equal(fs.readFileSync(path.join(outside, "Secret.drawio"), "utf8"), "secret");
});

test("making, renaming, moving and copying documents", () => {
	const lib = new Library(temp());
	const a = lib.create("", "Untitled", ".excalidraw", B("one"));
	const b = lib.create("", "Untitled", ".excalidraw", B("two"));
	const c = lib.create("Team", "Untitled", ".drawio", B("three"));
	assert.deepEqual([a, b, c], ["Untitled.excalidraw", "Untitled 2.excalidraw", "Team/Untitled.drawio"]);
	refused(() => lib.create("", "x", ".png", B("")), /not an ending/);
	refused(() => lib.create("../up", "x", ".drawio", B("")), /cannot have/);

	// a new name, its ending kept; a name that is taken is not taken over
	const plan = lib.rename(a, "Plan");
	assert.equal(plan, "Plan.excalidraw");
	assert.equal(lib.read(plan).toString(), "one");
	refused(() => lib.rename(plan, "Untitled 2"), /already/);
	refused(() => lib.rename(plan, "../Escape"), /cannot have/);
	assert.equal(lib.rename(plan, "Plan"), plan);

	// to a collection (made when it is new), to the top, and beside one of the same name
	const moved = lib.move(plan, "Team");
	assert.equal(moved, "Team/Plan.excalidraw");
	assert.equal(lib.move(moved, "Team"), moved);
	lib.create("", "Plan", ".excalidraw", B("another plan"));
	assert.equal(lib.move(moved, ""), "Plan 2.excalidraw");
	assert.equal(lib.move("Plan 2.excalidraw", "Brand new"), "Brand new/Plan 2.excalidraw");

	const copy = lib.duplicate(c);
	assert.equal(copy, "Team/Untitled copy.drawio");
	assert.equal(lib.duplicate(c), "Team/Untitled copy 2.drawio");
	assert.equal(lib.read(copy).toString(), "three");
	assert.deepEqual(ids(lib), ["Brand new/Plan 2.excalidraw", "Plan.excalidraw", "Team/Untitled copy 2.drawio", "Team/Untitled copy.drawio", "Team/Untitled.drawio", "Untitled 2.excalidraw"]);
});

test("collections: made, renamed with what is in them, and taken away without their documents", () => {
	const root = temp();
	const lib = new Library(root);
	assert.equal(lib.createCollection(" Clients "), "Clients");
	refused(() => lib.createCollection("Clients"), /already/);
	refused(() => lib.createCollection("a/b"), /cannot have/);
	const doc = lib.create("Clients", "Acme", ".drawio", B("acme"));
	lib.snapshot(doc, B("acme"));
	lib.setThumb(doc, B("png"));

	assert.equal(lib.renameCollection("Clients", "Customers"), "Customers");
	const now = "Customers/Acme.drawio";
	assert.deepEqual(ids(lib), [now]);
	assert.equal(lib.versions(now).length, 1);
	assert.equal(lib.thumb(now).toString(), "png");
	refused(() => lib.renameCollection("Clients", "x"), /not a collection/);

	// taken away: the documents go to the top, under names that are free there
	lib.create("", "Acme", ".drawio", B("another acme"));
	fs.mkdirSync(path.join(root, "Customers", "sub"));
	fs.writeFileSync(path.join(root, "Customers", "sub", "Deep.excalidraw"), "{}");
	const removed = lib.removeCollection("Customers");
	assert.deepEqual([removed.moved.sort((x, y) => x.from.localeCompare(y.from)), removed.kept], [[{ from: "Customers/Acme.drawio", to: "Acme 2.drawio" }, { from: "Customers/sub/Deep.excalidraw", to: "Deep.excalidraw" }], false]);
	assert.deepEqual(ids(lib), ["Acme 2.drawio", "Acme.drawio", "Deep.excalidraw"]);
	assert.equal(lib.versions("Acme 2.drawio").length, 1);
	assert.equal(fs.existsSync(path.join(root, "Customers")), false);
	// a folder with something else in it stays, with that in it
	lib.createCollection("Mixed");
	lib.create("Mixed", "One", ".drawio", B("1"));
	fs.writeFileSync(path.join(root, "Mixed", "README.md"), "keep me");
	assert.deepEqual(lib.removeCollection("Mixed"), { moved: [{ from: "Mixed/One.drawio", to: "One.drawio" }], kept: true });
	assert.equal(fs.readFileSync(path.join(root, "Mixed", "README.md"), "utf8"), "keep me");
});

test("the app's own folder in the library is never reached through a link, at its top or anywhere in it", () => {
	// a library that came from somewhere else, with links where the app keeps its things
	for (const linked of [".omnidraw", ".omnidraw/versions", ".omnidraw/thumbs", ".omnidraw/trash", ".omnidraw/versions/Downloads"]) {
		const root = temp();
		const outside = temp("outside");
		// (what the link leads to: someone's folders, by the names of the library's collections)
		fs.mkdirSync(path.join(outside, "Documents"), { recursive: true });
		fs.writeFileSync(path.join(outside, "Documents", "taxes.txt"), "the user's own file");
		fs.mkdirSync(path.join(outside, "Downloads", "Plan.drawio"), { recursive: true });
		fs.writeFileSync(path.join(outside, "Downloads", "Plan.drawio", "20260101T000000Z-s-000000000000.drawio"), "not a version of anything");
		fs.mkdirSync(path.join(root, "Downloads"));
		fs.writeFileSync(path.join(root, "Downloads", "Plan.drawio"), "plan");
		fs.mkdirSync(path.join(root, path.dirname(linked)), { recursive: true });
		fs.symlinkSync(linked.endsWith("Downloads") ? path.join(outside, "Downloads") : outside, path.join(root, linked));
		const lib = new Library(root);
		const untouched = () => {
			assert.equal(fs.readFileSync(path.join(outside, "Documents", "taxes.txt"), "utf8"), "the user's own file", linked);
			assert.equal(fs.existsSync(path.join(outside, "Downloads", "Plan.drawio", "20260101T000000Z-s-000000000000.drawio")), true, linked);
		};
		// nothing is read through the link
		const doc = "Downloads/Plan.drawio";
		if (linked !== ".omnidraw/thumbs" && linked !== ".omnidraw/trash") assert.deepEqual(lib.versions(doc), [], linked);
		assert.equal(lib.thumb(doc), undefined, linked);
		assert.deepEqual(lib.contents().trash, [], linked);
		// the rename that would have had the other folder's Documents taken out and its Downloads put in its place
		assert.equal(lib.renameCollection("Downloads", "Documents"), "Documents");
		untouched();
		// and nothing is written, moved or deleted through it either
		const moved = "Documents/Plan.drawio";
		if (linked === ".omnidraw" || linked === ".omnidraw/versions") refused(() => lib.snapshot(moved, B("v")), /is a link/);
		if (linked === ".omnidraw" || linked === ".omnidraw/thumbs") refused(() => lib.setThumb(moved, B("png")), /is a link/);
		if (linked === ".omnidraw" || linked === ".omnidraw/trash") refused(() => lib.trash(moved), /is a link/);
		lib.rename(moved, "Other");
		lib.move("Documents/Other.drawio", "");
		untouched();
		assert.deepEqual(fs.readdirSync(outside).sort(), ["Documents", "Downloads"], linked);
	}
});

test("a collection that is there is taken by its name as it is spelled", () => {
	// two folders made outside the app, their names apart only by a second space
	const root = temp();
	const lib = new Library(root);
	fs.mkdirSync(path.join(root, "Team  A"));
	fs.mkdirSync(path.join(root, "Team A"));
	fs.writeFileSync(path.join(root, "Team  A", "Wide.drawio"), "wide");
	fs.writeFileSync(path.join(root, "Team A", "Narrow.drawio"), "narrow");
	assert.deepEqual(lib.contents().collections, [{ name: "Team  A", count: 1 }, { name: "Team A", count: 1 }]);
	// a document made in, or moved to, the one that was picked
	assert.equal(lib.create("Team  A", "New", ".drawio", B("n")), "Team  A/New.drawio");
	assert.equal(lib.move("Team A/Narrow.drawio", "Team  A"), "Team  A/Narrow.drawio");
	assert.equal(lib.move("Team  A/Narrow.drawio", "Team A"), "Team A/Narrow.drawio");
	lib.snapshot("Team  A/Wide.drawio", B("wide"));
	// renamed: that one, with its history, and not its neighbour
	assert.equal(lib.renameCollection("Team  A", "Zeta"), "Zeta");
	assert.deepEqual(ids(lib), ["Team A/Narrow.drawio", "Zeta/New.drawio", "Zeta/Wide.drawio"]);
	assert.equal(lib.versions("Zeta/Wide.drawio").length, 1);
	// taken away: that one
	fs.mkdirSync(path.join(root, "Team  A"));
	fs.writeFileSync(path.join(root, "Team  A", "Again.drawio"), "again");
	assert.deepEqual(lib.removeCollection("Team  A"), { moved: [{ from: "Team  A/Again.drawio", to: "Again.drawio" }], kept: false });
	assert.deepEqual(ids(lib), ["Again.drawio", "Team A/Narrow.drawio", "Zeta/New.drawio", "Zeta/Wide.drawio"]);
	// a name that is no folder's is still not one; and a new collection's name is tidied as before
	for (const bad of ["Team  B", "../Team A", "Team A/x", ".omnidraw", ""]) refused(() => lib.renameCollection(bad, "x"), /not a collection/);
	assert.equal(lib.create("  Brand   new ", "One", ".drawio", B("1")), "Brand new/One.drawio");
});

test("the trash: there with its versions, back where it was, or gone for good", () => {
	const root = temp();
	const lib = new Library(root);
	const doc = lib.create("Team", "Plan", ".excalidraw", B("plan"));
	lib.snapshot(doc, B("plan"));
	lib.setThumb(doc, B("png"));
	const t = lib.trash(doc, Date.UTC(2026, 10, 28, 10, 0, 0));
	assert.deepEqual(ids(lib), []);
	const [item] = lib.contents().trash;
	assert.deepEqual([item.id, item.from, item.name, item.kind, item.collection, item.at], [t, doc, "Plan", "excalidraw", "Team", Date.UTC(2026, 10, 28, 10, 0, 0)]);
	assert.equal(fs.readFileSync(lib.trashFile(t), "utf8"), "plan");
	assert.equal(lib.trashThumb(t).toString(), "png");
	// (the collection is still one, with nothing in it)
	assert.deepEqual(lib.contents().collections, [{ name: "Team", count: 0 }]);

	// back: under its name, or beside one that took the name meanwhile; its folder made again if it went
	lib.create("Team", "Plan", ".excalidraw", B("a newer plan"));
	const back = lib.restore(t);
	assert.equal(back, "Team/Plan 2.excalidraw");
	assert.equal(lib.read(back).toString(), "plan");
	assert.equal(lib.versions(back).length, 1);
	assert.equal(lib.thumb(back).toString(), "png");
	assert.deepEqual(lib.contents().trash, []);
	refused(() => lib.restore(t), /not in the trash/);
	const t2 = lib.trash(back);
	fs.rmSync(path.join(root, "Team"), { recursive: true });
	assert.equal(lib.restore(t2), "Team/Plan 2.excalidraw");

	// a picture of what the document was before it was last changed does not go with it
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(lib.pathOf("Team/Plan 2.excalidraw"), later, later);
	// gone for good, one or all; and nothing that is not a trash item is named
	const t3 = lib.trash("Team/Plan 2.excalidraw");
	assert.equal(lib.trashThumb(t3), undefined);
	const other = lib.create("", "Other", ".drawio", B("x"));
	const t4 = lib.trash(other);
	lib.deleteForever(t3);
	assert.deepEqual(lib.contents().trash.map((i) => i.id), [t4]);
	assert.equal(lib.emptyTrash(), 1);
	assert.deepEqual(lib.contents().trash, []);
	for (const bad of ["../..", "..", "x", "20261128T100000Z-zzzzzzzz", ""]) refused(() => lib.deleteForever(bad), /not in the trash/);
	// (what the app keeps is not offered to a repository the library is in)
	assert.equal(fs.readFileSync(path.join(root, ".omnidraw", ".gitignore"), "utf8"), "*\n");
});

test("versions: one for a row of saves, one of its own for a point worth keeping, and a way back", () => {
	const lib = new Library(temp());
	const doc = lib.create("", "Plan", ".excalidraw", B("v0"));
	const t0 = Date.UTC(2026, 10, 28, 10, 0, 0);
	const min = 60 * 1000;
	// as it was opened: kept
	assert.equal(lib.snapshot(doc, B("v0"), { kept: true, now: t0 }), true);
	// saves within ten minutes are one version, the last of them; the opened state is not replaced
	assert.equal(lib.snapshot(doc, B("v1"), { now: t0 + 1 * min }), true);
	assert.equal(lib.snapshot(doc, B("v2"), { now: t0 + 4 * min }), true);
	assert.equal(lib.snapshot(doc, B("v2"), { now: t0 + 5 * min }), false);
	assert.deepEqual(lib.versions(doc).map((v) => [lib.versionBytes(doc, v.key).toString(), v.kept]), [["v2", false], ["v0", true]]);
	// later saves start a new one
	lib.snapshot(doc, B("v3"), { now: t0 + 1 * min + VERSION_WINDOW });
	lib.snapshot(doc, B("v4"), { now: t0 + 30 * min });
	assert.deepEqual(lib.versions(doc).map((v) => lib.versionBytes(doc, v.key).toString()), ["v4", "v3", "v2", "v0"]);
	assert.equal(lib.contents().docs[0].versions, 4);

	// going back: the document is the version again, and what it was is kept, so that this can be gone back on
	fs.writeFileSync(lib.pathOf(doc), "what it is now, and longer than a version");
	const v2 = lib.versions(doc).find((v) => lib.versionBytes(doc, v.key).toString() === "v2");
	// (the picture kept is of what it was until now: it goes, however close the two files' times are)
	lib.setThumb(doc, B("png of what it is now"));
	assert.ok(lib.thumb(doc));
	lib.restoreVersion(doc, v2.key, t0 + 40 * min);
	assert.equal(lib.read(doc).toString(), "v2");
	assert.equal(lib.thumb(doc), undefined);
	const after = lib.versions(doc);
	assert.deepEqual([lib.versionBytes(doc, after[0].key).toString(), after[0].kept, after.length], ["what it is now, and longer than a version", true, 5]);
	// a save after that is a version of its own, not the kept one's new state
	lib.snapshot(doc, B("v5"), { now: t0 + 41 * min });
	assert.equal(lib.versions(doc).length, 6);
	// going back from a state that was just saved: that save is the way back, and the next save does not take its place
	fs.writeFileSync(lib.pathOf(doc), "v5");
	lib.restoreVersion(doc, v2.key, t0 + 42 * min);
	assert.deepEqual([lib.versions(doc).length, lib.versions(doc)[0].kept, lib.versionBytes(doc, lib.versions(doc)[0].key).toString()], [6, true, "v5"]);
	lib.snapshot(doc, B("v6"), { now: t0 + 43 * min });
	assert.deepEqual(lib.versions(doc).slice(0, 2).map((v) => lib.versionBytes(doc, v.key).toString()), ["v6", "v5"]);
	lib.snapshot(doc, B("v5"), { now: t0 + 60 * min });
	refused(() => lib.versionBytes(doc, "../../../etc/passwd"), /not kept/);
	refused(() => lib.restoreVersion(doc, "20200101T000000Z-s-000000000000.excalidraw"), /not kept/);

	// versions follow the document where the app takes it
	const renamed = lib.rename(doc, "Roadmap");
	const moved = lib.move(renamed, "Team");
	assert.equal(lib.versions(moved).length, 8);
	assert.equal(lib.versions(doc).length, 0);

	// only so many are kept: the oldest go
	const many = lib.create("", "Busy", ".drawio", B("0"));
	for (let i = 1; i <= MAX_VERSIONS + 5; i++) lib.snapshot(many, B(`s${i}`), { now: t0 + i * 11 * min });
	const kept = lib.versions(many);
	assert.equal(kept.length, MAX_VERSIONS);
	assert.equal(lib.versionBytes(many, kept[0].key).toString(), `s${MAX_VERSIONS + 5}`);
	assert.equal(lib.versionBytes(many, kept[kept.length - 1].key).toString(), "s6");
});

test("a name whose capitals change keeps its history, a document's and a collection's", () => {
	// (on a disk that does not tell capitals apart, the new name's place is the old one's: nothing is in the way there)
	const lib = new Library(temp());
	const doc = lib.create("Team", "Plan", ".drawio", B("v1"));
	lib.snapshot(doc, B("v1"), { kept: true });
	lib.snapshot(doc, B("v2"));
	lib.setThumb(doc, B("png"));
	const lower = lib.rename(doc, "plan");
	assert.equal(lower, "Team/plan.drawio");
	assert.deepEqual(fs.readdirSync(path.dirname(lib.pathOf(lower))), ["plan.drawio"]);
	assert.deepEqual([lib.versions(lower).length, lib.thumb(lower)?.toString()], [2, "png"]);
	assert.equal(lib.renameCollection("Team", "TEAM"), "TEAM");
	assert.deepEqual(ids(lib), ["TEAM/plan.drawio"]);
	assert.deepEqual([lib.versions("TEAM/plan.drawio").length, lib.thumb("TEAM/plan.drawio")?.toString()], [2, "png"]);
	// and back again, with the versions still there
	assert.equal(lib.rename("TEAM/plan.drawio", "PLAN"), "TEAM/PLAN.drawio");
	assert.equal(lib.versions("TEAM/PLAN.drawio").length, 2);
});

test("two paths to one file are one place", () => {
	const dir = temp("real");
	const link = path.join(temp("links"), "by-link");
	fs.symlinkSync(dir, link);
	fs.writeFileSync(path.join(dir, "Plan.drawio"), "x");
	assert.equal(canonicalPath(path.join(link, "Plan.drawio")), path.join(dir, "Plan.drawio"));
	assert.equal(canonicalPath(path.join(dir, "Plan.drawio")), path.join(dir, "Plan.drawio"));
	// a file that is not there (it was moved a moment ago): its folder's place, and its name
	assert.equal(canonicalPath(path.join(link, "Gone.drawio")), path.join(dir, "Gone.drawio"));
	assert.equal(canonicalPath(path.join(dir, "no such folder", "x.drawio")), path.join(dir, "no such folder", "x.drawio"));
});

test("the picture kept of a document is for the document as it is, not as it was", () => {
	const lib = new Library(temp());
	const doc = lib.create("", "Plan", ".drawio", B("x"));
	assert.equal(lib.thumb(doc), undefined);
	lib.setThumb(doc, B("png"));
	assert.equal(lib.thumb(doc).toString(), "png");
	assert.ok(lib.contents().docs[0].pictured > 0);
	// changed since by another program: the picture is of an older state
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(lib.pathOf(doc), later, later);
	assert.equal(lib.thumb(doc), undefined);
	assert.equal(lib.contents().docs[0].pictured, 0);
	refused(() => lib.setThumb("../x.drawio", B("")), /not a document/);
});

test("recent documents: the latest first, each once, gone when the file is", () => {
	const dir = temp("recents");
	const file = path.join(dir, "data", "recent.json");
	const a = path.join(dir, "a.drawio"), b = path.join(dir, "b.excalidraw"), c = path.join(dir, "c.drawio");
	for (const f of [a, b, c]) fs.writeFileSync(f, "x");
	const recents = new Recents(file, 2);
	assert.deepEqual(recents.list(), []);
	recents.add(a, 100);
	recents.add(b, 200);
	recents.add(a, 300);
	assert.deepEqual(recents.list().map((r) => [r.path, r.at]), [[a, 300], [b, 200]]);
	// (each with which file it was, as the disk knows it)
	assert.deepEqual([recents.list()[0].dev, recents.list()[0].ino], [fs.statSync(a).dev, fs.statSync(a).ino]);
	// only so many are remembered
	recents.add(c, 400);
	assert.deepEqual(recents.list().map((r) => r.path), [c, a]);
	recents.moved(a, b);
	assert.deepEqual(recents.list().map((r) => r.path), [c, b]);
	fs.rmSync(c);
	assert.deepEqual(recents.list().map((r) => r.path), [b]);
	recents.remove(b);
	assert.deepEqual(recents.list(), []);
	// a file that is not a list is no list
	fs.writeFileSync(file, "not json");
	assert.deepEqual(new Recents(file).list(), []);
});

test("a file from the list is copied only as the very file that was opened", () => {
	const dir = temp("shared");
	const recents = new Recents(path.join(temp("data"), "recent.json"));
	const budget = path.join(dir, "Budget.drawio");
	fs.writeFileSync(budget, "the budget");
	recents.add(budget);
	const noted = () => recents.list().find((r) => r.path === budget);
	const no = (pattern) => assert.throws(() => readRecent(noted(), 1000), (e) => e instanceof RecentFileError && pattern.test(e.message));
	assert.equal(readRecent(noted(), 1000).toString(), "the budget");
	// written into again (as this app saves): the same file still
	fs.writeFileSync(budget, "the budget, revised");
	assert.equal(readRecent(noted(), 1000).toString(), "the budget, revised");
	assert.throws(() => readRecent(noted(), 5), (e) => e instanceof RecentFileError && /too large/.test(e.message));
	// someone who can write in that folder puts a link to a file of the user's in its place: not fetched
	const secret = path.join(temp("private"), "id_rsa");
	fs.writeFileSync(secret, "a private key");
	fs.rmSync(budget);
	fs.symlinkSync(secret, budget);
	no(/not the file that was opened here any more/);
	// another file under the name: not the one that was opened either
	fs.rmSync(budget);
	fs.writeFileSync(path.join(dir, "other"), "something else");
	fs.renameSync(path.join(dir, "other"), budget);
	no(/not the file that was opened here any more/);
	// opened again, it is the file that was opened
	recents.add(budget);
	assert.equal(readRecent(noted(), 1000).toString(), "something else");
	// an entry from before files were noted (or noted by hand) is opened from the list, not copied
	assert.throws(() => readRecent({ path: budget, at: 1 }, 1000), RecentFileError);
	fs.rmSync(budget);
	assert.throws(() => readRecent({ path: budget, at: 1, dev: 1, ino: 1 }, 1000), RecentFileError);
});

test("a sketch of a drawing: its shapes, lines and words, and nothing of the file written as it stands", () => {
	const svg = sketchExcalidraw({
		appState: { viewBackgroundColor: "#fffce8" },
		elements: [
			{ id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", roundness: { type: 3 }, angle: Math.PI / 2 },
			{ id: "b", type: "ellipse", x: 300, y: 0, width: 120, height: 80, strokeColor: "red; evil", backgroundColor: 'url("http://example.invalid/x")' },
			{ id: "d", type: "diamond", x: 0, y: 200, width: 100, height: 100, strokeStyle: "dashed", opacity: 50 },
			{ id: "l", type: "arrow", x: 160, y: 40, width: 140, height: 0, points: [[0, 0], [140, 0]], strokeColor: "#000000" },
			{ id: "t", type: "text", x: 10, y: 320, width: 200, height: 25, text: 'Hello <script>alert(1)</script> & "you"', fontSize: 20 },
			{ id: "gone", type: "rectangle", x: 5000, y: 5000, width: 10, height: 10, isDeleted: true },
			{ id: "bad", type: "rectangle", x: "0", y: 0, width: 10, height: 10 },
			null,
		],
	});
	assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="/);
	assert.match(svg, /<rect[^>]*fill="#fffce8"/);
	assert.match(svg, /<rect[^>]*rx=[^>]*stroke="#1971c2" fill="#a5d8ff"[^>]*transform="rotate\(90 80 40\)"/);
	assert.match(svg, /<ellipse[^>]*stroke="#1e1e1e" fill="none"/);
	assert.match(svg, /<polygon[^>]*stroke-dasharray[^>]*opacity="0.5"/);
	assert.equal((svg.match(/<polyline/g) ?? []).length, 2);
	assert.match(svg, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;you&quot;/);
	assert.ok(!/evil|example\.invalid|<script|5000/.test(svg), svg);
	// an empty drawing is an empty page, not an error
	assert.match(sketchExcalidraw({ elements: [] }), /^<svg /);
	assert.match(sketchExcalidraw({}), /^<svg /);
	assert.equal(safeColour("#ABCDEF", "x"), "#abcdef");
	assert.equal(safeColour("transparent", "x"), "none");
	for (const c of ["red", "rgb(1,2,3)", "#12", "#gggggg", 'x" onload="y', undefined, 5]) assert.equal(safeColour(c, "fallback"), "fallback");
});

const MODEL = `<mxGraphModel dx="800" dy="600"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="box" value="Web &lt;b&gt;server&lt;/b&gt;&lt;br&gt;nginx" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="group" value="" style="swimlane;fillColor=javascript:alert(1);" vertex="1" parent="1"><mxGeometry x="300" y="20" width="240" height="200" as="geometry"/></mxCell>
<mxCell id="db" value="DB" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="group"><mxGeometry x="60" y="80" width="80" height="80" as="geometry"/></mxCell>
<object label="Check &amp;amp; go" id="check"><mxCell style="rhombus;dashed=1;" vertex="1" parent="1"><mxGeometry x="60" y="200" width="80" height="80" as="geometry"/></mxCell></object>
<mxCell id="e1" style="endArrow=classic;strokeColor=#333333;" edge="1" parent="1" source="box" target="db"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="230" y="70"/></Array></mxGeometry></mxCell>
<mxCell id="e2" style="endArrow=none;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="10" y="10" as="sourcePoint"/><mxPoint x="30" y="300" as="targetPoint"/></mxGeometry></mxCell>
</root></mxGraphModel>`;

test("a sketch of a diagram: its first page, plain or packed, shapes placed in what holds them", () => {
	const plain = `<mxfile host="x"><diagram id="p1" name="Page-1">${MODEL}</diagram><diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="other" value="SECOND PAGE" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
	const svg = sketchDrawio(plain);
	assert.match(svg, /^<svg /);
	// the label's words, its HTML gone; the wrapped cell's label; colours that are colours
	assert.match(svg, /<rect[^>]*rx=[^>]*stroke="#6c8ebf" fill="#dae8fc"/);
	assert.match(svg, />Web server<\/tspan><tspan[^>]*>nginx</);
	assert.match(svg, /Check &amp; go/);
	assert.match(svg, /<polygon[^>]*stroke-dasharray/);
	// the ellipse is placed from its container's corner: (300 + 60 + 40, 20 + 80 + 40)
	assert.match(svg, /<ellipse cx="400" cy="140" rx="40" ry="40"/);
	// the line from the box's middle, by its bend, to the ellipse's middle; the other between its two points, with no head
	assert.match(svg, /<polyline points="100,70 230,70 400,140"/);
	assert.match(svg, /<polyline points="10,10 30,300"/);
	assert.equal((svg.match(/<polyline/g) ?? []).length, 3);
	// what holds shapes is drawn before the lines, the shapes after them
	assert.ok(svg.indexOf('x="300" y="20"') < svg.indexOf("<polyline") && svg.indexOf("<polyline") < svg.indexOf("<ellipse"), "order");
	assert.ok(!/javascript|SECOND PAGE/.test(svg), svg);

	// packed, as draw.io may keep a page: the same picture
	const packed = `<mxfile><diagram id="p1" name="Page-1">${zlib.deflateRawSync(Buffer.from(encodeURIComponent(MODEL))).toString("base64")}</diagram></mxfile>`;
	assert.equal(sketchDrawio(packed), svg);
	// a bare model, and files that are not diagrams
	assert.match(sketchDrawio(MODEL), /^<svg /);
	assert.equal(sketchDrawio("<svg><rect/></svg>"), undefined);
	assert.equal(sketchDrawio("<mxfile><diagram>not base64 at all !!!</diagram></mxfile>"), undefined);
	assert.equal(firstPage("x".repeat(13_000_000)), undefined);
});
