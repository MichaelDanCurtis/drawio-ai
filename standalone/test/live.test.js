// Go live: one person's side of a shared diagram (the session), against a stand-in for an
// OmniPad server's boards. Nothing here is draw.io or reaches a network beyond this computer:
// the "diagram" is a small model with patches shaped like draw.io's, and the server is
// test/helpers/boardRelay.js, which speaks OmniPad's protocol as its reference describes it.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
require("./helpers/ts");
const { LiveSession } = require("../src/main/live/session");
const { createBoard, boardExists, closeBoard, openBoard, BoardError } = require("../src/main/live/connection");
const { parseBoardLink, boardLink, serverOrigin, socketUrl, touched, apart, wireChecksum, lockKey, cellOn } = require("../src/main/live/protocol");
const { LiveShare } = require("../src/main/live/liveShare");
const { startBoardRelay } = require("./helpers/boardRelay");

const until = async (what, ms = 4000) => {
	const end = Date.now() + ms;
	for (;;) {
		const v = await what();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 5));
	}
};

/** A diagram as cells with attributes on one page, changed by patches shaped like draw.io's. */
class Diagram {
	constructor(cells = {}) {
		this.cells = structuredClone(cells);
		this.replaced = 0;
	}
	checksum() {
		const sorted = Object.fromEntries(Object.keys(this.cells).sort().map((id) => [id, Object.fromEntries(Object.entries(this.cells[id]).sort())]));
		return crypto.createHash("sha1").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
	}
	xml() {
		return JSON.stringify(this.cells);
	}
	patch(p) {
		const cells = p.u?.p1?.cells ?? {};
		for (const c of cells.i ?? []) this.cells[c.id] = { ...c, id: undefined };
		for (const [id, change] of Object.entries(cells.u ?? {})) this.cells[id] = { ...(this.cells[id] ?? {}), ...change };
		for (const id of cells.r ?? []) delete this.cells[id];
		for (const id of Object.keys(this.cells)) for (const k of Object.keys(this.cells[id])) if (this.cells[id][k] === undefined) delete this.cells[id][k];
	}
	// what the session asks of an editor
	async replace(xml) {
		this.cells = JSON.parse(xml);
		this.replaced++;
		return this.checksum();
	}
	async apply(p) {
		// (a real editor takes a moment to answer; `slowMs` makes that moment long enough to do something in)
		if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
		this.applied = (this.applied ?? 0) + 1;
		this.patch(p);
		return this.checksum();
	}
	async snapshot() {
		return { xml: this.xml(), checksum: this.checksum() };
	}
}
const update = (id, change) => ({ u: { p1: { cells: { u: { [id]: change } } } } });
const insert = (id, attrs) => ({ u: { p1: { cells: { i: [{ id, ...attrs }] } } } });

/** Someone on a board: their diagram, their session, and a gate on what reaches them (to make changes cross on purpose). */
async function join(link, name, { cells } = {}) {
	const diagram = new Diagram(cells);
	const sent = [];
	const events = { replaced: [], problems: [], refused: [], closed: undefined, people: [] };
	let socket;
	let gate = null; // when an array: messages are kept here instead of being handed on
	const session = new LiveSession(
		diagram,
		(m) => {
			sent.push(m);
			socket.send(m);
		},
		{ replaced: (why) => events.replaced.push(why), problem: (t) => events.problems.push(t), refused: (reason, keys) => events.refused.push([reason, keys]), closed: (r) => (events.closed = r), people: (p) => (events.people = p) },
		{ snapshotQuietMs: 60_000 }
	);
	await new Promise((resolve, reject) => {
		socket = openBoard(link, { onOpen: resolve, onMessage: (m) => (gate ? gate.push(m) : session.receive(m)), onEnd: (why) => (events.ended = why, reject(new Error(why))) });
	});
	session.hello(link.board, name, 200);
	await until(() => session.ready);
	return {
		name,
		diagram,
		session,
		sent,
		events,
		socket,
		/** The person changes their diagram: it is changed at once, and the board is told. */
		change(patch) {
			diagram.patch(patch);
			session.localPatch(patch, diagram.checksum());
		},
		hold() {
			gate = [];
		},
		/** Hands on what was kept, all of it or the first `n`. */
		async release(n) {
			const kept = gate ?? [];
			const now = n === undefined ? kept.splice(0) : kept.splice(0, n);
			if (n === undefined || kept.length === 0) gate = n === undefined ? null : kept;
			for (const m of now) session.receive(m);
			await session.idle();
		},
		/** What is being kept, by kind: this person's own change coming back numbered is its "Receipt", someone else's a "Patch". */
		kept: () => (gate ?? []).map((m) => (m.BoardPatch ? (m.BoardPatch.from === session.id ? "Receipt" : "Patch") : Object.keys(m)[0])),
		/** How often this person asked for the board's diagram again after first opening it. */
		caughtUp: () => sent.filter((m) => m.BoardOpen).length - 1,
		patches: () => sent.filter((m) => m.BoardPatch).map((m) => m.BoardPatch),
		/** Selects shapes on page p1: the board holds them for this person. */
		select(...cells) {
			session.localPresence({ page: "p1", cursor: null, selected: cells.map((c) => `p1/${c}`), rect: null });
		},
	};
}
/** A session with nothing behind it: the board's messages are given to it by hand, and what it sends is kept. */
function alone(diagram, events = {}, options = { snapshotQuietMs: 60_000 }) {
	const sent = [];
	const session = new LiveSession(diagram, (m) => sent.push(m), events, options);
	session.hello("b1", "Me", 0);
	return { session, sent, patches: () => sent.filter((m) => m.BoardPatch).map((m) => m.BoardPatch), state: (d, revision = 0) => ({ BoardState: { board: "b1", revision, base: revision, content: d.xml(), patches: [] } }) };
}

const relays = [];
// (a test that fails half-way must not leave a server holding the run open)
test.after(() => Promise.all(relays.map((r) => r.close())));
async function board(cells = { a: { label: "start" }, b: { label: "other" } }, options) {
	const relay = await startBoardRelay(options);
	relays.push(relay);
	const first = new Diagram(cells);
	const made = await createBoard(relay.url, { title: "Test", xml: first.xml() });
	return { relay, ...made, cells };
}
const same = (...people) => people.every((p) => p.diagram.checksum() === people[0].diagram.checksum());

test("a link to a shared diagram: read from what is pasted, and what is not one", () => {
	const pad = "A".repeat(22);
	const board = "k3x9m2p7qa";
	assert.deepEqual(parseBoardLink(`https://pad.example.com/b/${pad}/${board}`), { server: "https://pad.example.com", pad, board });
	assert.deepEqual(parseBoardLink(`  https://pad.example.com:8443/b/${pad}/${board}/  `), { server: "https://pad.example.com:8443", pad, board });
	// what the browser shows once the link has opened there, which is what people copy
	assert.deepEqual(parseBoardLink(`https://pad.example.com/?pad=${pad}&board=${board}`), { server: "https://pad.example.com", pad, board });
	// a board in someone's own pad
	assert.deepEqual(parseBoardLink(`https://pad.example.com/b/team-notes/${board}`), { server: "https://pad.example.com", pad: "team-notes", board });
	assert.deepEqual(parseBoardLink(`http://127.0.0.1:8787/b/${pad}/${board}`), { server: "http://127.0.0.1:8787", pad, board }, "a server on this computer may be plain http");
	assert.equal(boardLink({ server: "https://pad.example.com", pad, board }), `https://pad.example.com/b/${pad}/${board}`);
	assert.equal(socketUrl({ server: "https://pad.example.com", pad, board }), `wss://pad.example.com/api/socket/${pad}`, "a board is reached over its pad's socket");
	assert.equal(socketUrl({ server: "http://127.0.0.1:8787", pad, board }), `ws://127.0.0.1:8787/api/socket/${pad}`);
	for (const no of ["", "pad.example.com", `http://pad.example.com/b/${pad}/${board}`, `https://pad.example.com/b/${pad}`, `https://pad.example.com/b/${pad}/${board}/extra`, `https://pad.example.com/b/${pad}/UPPER`, `https://pad.example.com/b/a.b/${board}`, `https://pad.example.com/pads/${pad}/${board}`, `https://me:pw@pad.example.com/b/${pad}/${board}`, `https://pad.example.com/?pad=${pad}`, `https://pad.example.com/x?pad=${pad}&board=${board}`, `file:///b/${pad}/${board}`, `javascript:alert(1)//b/${pad}/${board}`, `https://pad.example.com/b/${"x".repeat(80)}/${board}`]) assert.equal(parseBoardLink(no), undefined, no);
	// a server's address, as typed into Settings
	assert.equal(serverOrigin("pad.example.com"), "https://pad.example.com");
	assert.equal(serverOrigin("https://pad.example.com/"), "https://pad.example.com");
	assert.equal(serverOrigin("http://localhost:8787"), "http://localhost:8787");
	for (const no of ["", "http://pad.example.com", "ftp://pad.example.com", "pad example"]) assert.equal(serverOrigin(no), undefined, no);
	// a checksum goes out as draw.io gives it, a number; anything that is not one stays as it is
	assert.deepEqual([wireChecksum("1882817077"), wireChecksum("-42"), wireChecksum("0123"), wireChecksum("ab12")], [1882817077, -42, "0123", "ab12"]);
	// the key the server knows a shape by
	assert.equal(lockKey("p1", "a"), "p1/a");
	assert.deepEqual([cellOn("p1", "p1/a"), cellOn("p1", "p2/a"), cellOn("p1", "p1/a/b")], ["a", undefined, "a/b"]);
});

test("which changes can be told apart: different cells, and nothing but cells", () => {
	assert.deepEqual([...touched(update("a", { label: "x" }))], ["p1/a"]);
	assert.deepEqual([...touched({})], []);
	// more than cells' own attributes: a new or removed cell (its place among the others), a move, a page's name, a new page
	for (const p of [insert("z", {}), { u: { p1: { cells: { r: ["a"] } } } }, update("a", { parent: "b" }), update("a", { previous: "b" }), { u: { p1: { name: "Page" } } }, { i: [{ id: "p2" }] }, { r: ["p1"] }, { f: { vars: "x" } }, null, "text"]) assert.equal(touched(p), undefined, JSON.stringify(p));
	assert.equal(apart([update("a", { label: "x" })], [update("b", { label: "y" })]), true);
	assert.equal(apart([update("a", { label: "x" })], [update("a", { color: "red" })]), false, "the same cell, even another attribute of it");
	assert.equal(apart([update("a", { label: "x" })], [insert("z", {})]), false);
	assert.equal(apart([], [insert("z", {})]), false);
});

test("two people on a board: each sees the other's changes, and someone who joins later gets the diagram as it is", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	assert.deepEqual(ann.events.replaced, ["joined"]);
	assert.deepEqual(bo.diagram.cells, b.cells, "the board's diagram is in place of what was there");
	await until(() => ann.session.others().length === 1);
	assert.deepEqual(ann.session.others().map((p) => p.name), ["Bo"]);
	assert.deepEqual(bo.session.others().map((p) => p.name), ["Ann"]);

	ann.change(update("a", { label: "from Ann" }));
	await until(() => bo.session.revision === 1);
	bo.change(insert("c", { label: "new" }));
	await until(() => ann.session.revision === 2 && bo.session.revision === 2 && ann.session.settled && bo.session.settled);
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.diagram.cells, { a: { label: "from Ann" }, b: { label: "other" }, c: { label: "new" } });
	// several quick changes in a row: each says what the diagram will be once the ones before it are in
	ann.change(update("a", { color: "red" }));
	ann.change(update("a", { color: "blue" }));
	ann.change(update("b", { color: "green" }));
	assert.deepEqual(ann.patches().slice(-3).map((p) => p.base), [2, 3, 4]);
	assert.ok(ann.patches().every((p) => p.board === b.link.board && p.epoch === 1 && "checksum" in p), "each says which board, in which epoch, and what the diagram should come to");
	await until(() => bo.session.revision === 5);
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined"], "nobody had to catch up");
	assert.deepEqual([...ann.events.problems, ...bo.events.problems], []);

	// where someone is
	bo.session.localPresence({ name: "Bo", hue: 200, page: "p1", cursor: { x: 10, y: 20 }, selected: ["p1/a"], rect: null });
	await until(() => ann.session.others()[0]?.presence);
	assert.deepEqual(ann.session.others()[0].presence, { name: "Bo", hue: 200, page: "p1", cursor: { x: 10, y: 20 }, selected: ["p1/a"], rect: null });
	// what he has selected is his for as long as it is: everyone is told who holds what
	await until(() => Object.keys(ann.session.locks).length === 1);
	assert.deepEqual(ann.session.locks, { "p1/a": bo.session.id });
	assert.deepEqual(bo.session.locks, { "p1/a": bo.session.id });

	const cy = await join(b.link, "Cy");
	assert.ok(same(ann, bo, cy));
	assert.equal(cy.session.revision, 5);
	// leaving: the others are told
	bo.socket.close();
	await until(() => ann.session.others().length === 1 && Object.keys(ann.session.locks).length === 0);
	assert.deepEqual(ann.session.others().map((p) => p.name), ["Cy"]);
	assert.deepEqual(ann.session.locks, {}, "and what he held is let go of");
	await b.relay.close();
});

test("changes made at the same moment: to different shapes nothing needs putting right; to the same shape everyone ends with the one the board numbered last", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");

	// different shapes
	bo.hold();
	ann.change(update("a", { label: "Ann's" }));
	await until(() => ann.session.settled && ann.session.revision === 1);
	bo.change(update("b", { label: "Bo's" }));
	await until(() => bo.kept().includes("Receipt"));
	assert.deepEqual(bo.kept(), ["Patch", "Receipt"], "the board put Ann's first: hers arrives before his own comes back numbered");
	await bo.release();
	await until(() => ann.session.revision === 2 && bo.session.settled);
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined"], "either order gives the same diagram: not reloaded");
	assert.equal(bo.caughtUp(), 0);

	// the same shape: the board takes Ann's, then Bo's. Bo made his first and then got Ann's on top
	bo.hold();
	ann.change(update("a", { label: "A" }));
	await until(() => ann.session.revision === 3 && ann.session.settled);
	bo.change(update("a", { label: "B" }));
	await until(() => bo.kept().includes("Receipt"));
	await bo.release();
	assert.equal(b.relay.stats(b.link).revision, 4);
	await until(() => bo.events.replaced.length === 2 && bo.session.settled && ann.session.revision === 4);
	assert.deepEqual(bo.events.replaced, ["joined", "caught-up"]);
	assert.deepEqual(bo.sent.filter((m) => m.BoardOpen).map((m) => m.BoardOpen.epoch), [1, 2], "asking for the board's diagram again starts a new epoch");
	assert.equal(ann.diagram.cells.a.label, "B", "the later one wins, for everyone");
	assert.equal(bo.diagram.cells.a.label, "B");
	assert.ok(same(ann, bo));
	assert.deepEqual(ann.events.replaced, ["joined"], "the one whose change came first has nothing to put right");
	await b.relay.close();
});

test("someone who keeps working after a crossed change does not vouch for their diagram until it is put right", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	bo.hold();
	ann.hold();
	bo.change(update("a", { label: "B" })); // numbered 1
	await until(() => b.relay.stats(b.link).revision === 1);
	ann.change(update("a", { label: "A" })); // made without Bo's: numbered 2, after his
	// (both are on their way to her: his, and her own coming back numbered after it)
	await until(() => ann.kept().length === 2);
	await ann.release(1); // Bo's change reaches Ann while hers is unacknowledged
	assert.deepEqual(ann.kept(), ["Receipt"]);
	assert.equal(ann.diagram.cells.a.label, "B", "on her side his went on top of hers: the other way round from the board");
	ann.change(update("b", { color: "red" })); // she keeps working; its base (2) is where the board is
	const last = ann.patches().at(-1);
	assert.deepEqual([last.base, "checksum" in last], [2, false], "no checksum: she cannot vouch for her diagram");
	await until(() => b.relay.stats(b.link).revision === 3);
	await ann.release();
	await bo.release();
	await until(() => ann.session.settled && bo.session.settled && bo.session.revision === 3 && ann.events.replaced.length === 2);
	assert.ok(same(ann, bo));
	assert.equal(bo.diagram.cells.a.label, "A", "Ann's was numbered last");
	assert.equal(bo.diagram.cells.b.color, "red");
	assert.deepEqual(bo.events.replaced, ["joined"], "Bo was never asked to check against a diagram that was not the board's");
	assert.deepEqual(bo.events.problems, []);
	// once she has caught up she vouches again
	ann.change(update("b", { color: "blue" }));
	assert.equal("checksum" in ann.patches().at(-1), true);
	await until(() => bo.session.revision === 4);
	assert.ok(same(ann, bo));
	await b.relay.close();
});

test("a change the board refuses is undone by the board's diagram; what the person does meanwhile is kept, and goes out in the next epoch", async () => {
	// (the session alone, with the board's messages given to it by hand: the order here is the point)
	const diagram = new Diagram();
	const refused = [];
	const { session, sent, patches, state } = alone(diagram, { refused: (reason, keys) => refused.push([reason, keys]) });
	const start = new Diagram({ a: { label: "start" }, b: { label: "other" } });
	assert.deepEqual(sent, [{ ClientInfo: { name: "Me", hue: 0 } }, { BoardList: {} }, { BoardOpen: { board: "b1", epoch: 1 } }], "first words: who this is, which boards there are, and this one opened");
	session.receive({ Identity: 2 });
	session.receive(state(start, 4));
	await session.idle();
	// a change to a shape someone else holds, and another right after it, before the board has answered
	diagram.patch(update("b", { color: "red" }));
	session.localPatch(update("b", { color: "red" }), diagram.checksum());
	diagram.patch(update("a", { color: "blue" }));
	session.localPatch(update("a", { color: "blue" }), diagram.checksum());
	assert.deepEqual(patches().map((p) => [p.base, p.epoch]), [[4, 1], [5, 1]]);
	session.receive({ BoardRejected: { board: "b1", reason: "locked", keys: ["p1/b"] } });
	await session.idle();
	assert.deepEqual(refused, [["locked", ["p1/b"]]]);
	assert.deepEqual([session.epoch, session.unsent, session.settled], [2, 0, false], "both are gone as far as the board goes: it dropped the second without a word");
	// something done before the board's diagram has arrived is held
	diagram.patch(update("a", { label: "kept" }));
	session.localPatch(update("a", { label: "kept" }), diagram.checksum());
	assert.equal(patches().length, 2, "not sent yet");
	session.receive(state(start, 4));
	await session.idle();
	assert.deepEqual(diagram.cells, { a: { label: "kept" }, b: { label: "other" } }, "the board's diagram, without the refused changes, with what was done since on top");
	assert.deepEqual([patches().at(-1).base, patches().at(-1).epoch, "checksum" in patches().at(-1)], [4, 2, false]);

	// a second diagram from the board right behind the first (this connection had asked for one just
	// as the board refused): the change that is on its way is not in it, and goes on top again
	const again = new Diagram({ a: { label: "start" }, b: { label: "other", note: "someone's" } });
	session.receive(state(again, 4));
	await session.idle();
	assert.deepEqual(diagram.cells, { a: { label: "kept" }, b: { label: "other", note: "someone's" } });
	assert.equal(session.unsent, 1, "still waiting to hear which revision it became");
	session.receive({ BoardPatch: { board: "b1", revision: 5, from: 2, patch: update("a", { label: "kept" }) } });
	await session.idle();
	assert.deepEqual([session.revision, session.unsent], [5, 0]);
	assert.equal(sent.filter((m) => m.BoardOpen).length, 1, "nothing crossed anything: no need to ask again");

	// what is about another board of the pad, or about the pad's text, is not this session's
	session.receive({ BoardState: { board: "other", revision: 9, base: 9, content: "{}", patches: [] } });
	session.receive({ BoardPatch: { board: "other", revision: 10, from: 7, patch: update("a", { label: "no" }) } });
	session.receive({ History: { start: 0, operations: [] } });
	session.receive({ Snapshot: { revision: 3, text: "the pad's text" } });
	await session.idle();
	assert.deepEqual([session.revision, diagram.cells.a.label], [5, "kept"]);
	// a revision that never arrived: the board's diagram is asked for
	session.receive({ BoardPatch: { board: "b1", revision: 8, from: 7, patch: update("b", { label: "late" }) } });
	await session.idle();
	assert.deepEqual(sent.at(-1), { BoardOpen: { board: "b1", epoch: 3 } });
	// someone who may only look: told once, and nothing of theirs is sent again
	session.receive(state(again, 8));
	await session.idle();
	session.localPatch(update("a", { label: "x" }), "sum");
	session.receive({ BoardRejected: { board: "b1", reason: "read-only" } });
	session.receive(state(again, 8));
	await session.idle();
	assert.deepEqual([session.role, refused.at(-1)[0]], ["viewer", "read-only"]);
	const count = patches().length;
	session.localPatch(update("a", { label: "y" }), "sum");
	assert.equal(patches().length, count);
	session.dispose();
});

test("a shape someone has selected is theirs: a change to it by someone else is refused whole and undone; the rest goes on", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann");
	const bo = await join(b.link, "Bo");
	ann.select("a");
	await until(() => bo.session.locks["p1/a"] === ann.session.id);
	// Bo changes it all the same (his editor would not have let him; a change by other means)
	bo.change(update("a", { label: "Bo's" }));
	await until(() => bo.events.refused.length === 1 && bo.session.settled);
	assert.deepEqual(bo.events.refused, [["locked", ["p1/a"]]], "told which shape, to say whose it is");
	assert.equal(bo.diagram.cells.a.label, "start", "undone on his side");
	assert.equal(b.relay.stats(b.link).revision, 0, "and it never reached anyone");
	assert.deepEqual(bo.events.replaced, ["joined", "caught-up"]);
	// one change that touches a held shape and a free one is refused as a whole
	bo.change({ u: { p1: { cells: { u: { a: { color: "red" }, b: { color: "red" } } } } } });
	await until(() => bo.events.refused.length === 2 && bo.session.settled);
	assert.deepEqual(bo.diagram.cells, b.cells);
	// a free shape he can change, and what he sends now is in his new epoch
	bo.change(update("b", { label: "Bo's" }));
	await until(() => ann.diagram.cells.b.label === "Bo's" && bo.session.settled);
	assert.equal(bo.patches().at(-1).epoch, 3);
	// two people select the same shape: it is the first one's
	bo.select("a", "b");
	await until(() => ann.session.locks["p1/b"] === bo.session.id);
	assert.deepEqual(ann.session.locks, { "p1/a": ann.session.id, "p1/b": bo.session.id });
	// Ann lets go: now it is his (he still has it selected, and says so again)
	ann.select();
	await until(() => !("p1/a" in bo.session.locks));
	bo.select("a", "b");
	await until(() => ann.session.locks["p1/a"] === bo.session.id);
	bo.change(update("a", { label: "Bo's now" }));
	await until(() => ann.diagram.cells.a.label === "Bo's now");
	assert.ok(same(ann, bo));
	// a change sent with an epoch this connection has left is dropped without a word
	bo.socket.send({ BoardPatch: { board: b.link.board, base: bo.session.revision, epoch: 1, patch: update("b", { label: "stale" }) } });
	bo.change(update("b", { color: "green" }));
	await until(() => ann.diagram.cells.b.color === "green");
	assert.equal(ann.diagram.cells.b.label, "Bo's");
	assert.deepEqual([...ann.events.problems, ...bo.events.problems], []);
	await b.relay.close();
});

test("a diagram that has drifted is noticed at the next change and replaced by the board's; what its owner did meanwhile is kept", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	// (something went wrong on Bo's side that no message accounts for)
	bo.diagram.cells.b.label = "corrupted";
	bo.hold();
	ann.change(update("a", { label: "next" }));
	await until(() => bo.kept().includes("Patch"));
	await bo.release();
	// he has asked for the board's diagram, and changes something before it arrives
	assert.equal(bo.caughtUp(), 1);
	assert.match(bo.events.problems[0], /differs from the board's at revision 1/);
	assert.equal(bo.session.unsent, 0);
	bo.change(update("b", { color: "green" }));
	assert.equal(bo.patches().length, 0, "held back, not sent, until the board's diagram is in");
	assert.equal(bo.session.unsent, 1, "the board does not have it yet: not the moment to close the window");
	await until(() => bo.events.replaced.length === 2 && bo.session.settled && ann.session.revision === 2);
	assert.deepEqual(bo.diagram.cells, { a: { label: "next" }, b: { label: "other", color: "green" } });
	assert.ok(same(ann, bo));
	assert.equal(bo.session.unsent, 0, "now it has");
	await b.relay.close();
});

test("changes held back go out in the order they were made, also one made while the others are going back in; and the diagram is then checked against the board's", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	// Bo's diagram has drifted; at Ann's next change he asks for the board's
	bo.diagram.cells.b.label = "corrupted";
	bo.hold();
	ann.change(update("b", { color: "grey" }));
	await until(() => bo.kept().includes("Patch"));
	await bo.release(1);
	assert.equal(bo.caughtUp(), 1);
	// before it arrives he sets a label (held); while that is being put back on top he sets it again
	bo.change(update("a", { label: "A" }));
	bo.diagram.slowMs = 40;
	const released = bo.release();
	await until(() => bo.diagram.replaced === 2);
	bo.change(update("a", { label: "B" }));
	await released;
	const labels = () => bo.patches().map((p) => p.patch.u.p1.cells.u.a.label);
	await until(() => labels().length === 2);
	assert.deepEqual(labels(), ["A", "B"], "in the order he made them");
	assert.deepEqual(bo.patches().map((p) => "checksum" in p), [false, false], "not vouched for: his diagram at each is not his diagram with both");
	// the second was already in his diagram and is not put in again; where it sat among the rest is not
	// worked out: the board's diagram is fetched once more, and everyone has B
	bo.diagram.slowMs = 0;
	await until(() => bo.caughtUp() === 2 && bo.session.settled && ann.session.revision === 3);
	assert.equal(ann.diagram.cells.a.label, "B");
	assert.equal(bo.diagram.cells.a.label, "B");
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined", "caught-up", "caught-up"]);
});

test("what someone did before the board's diagram was read is in it; only what came after is held", async () => {
	// (the host changes the diagram while it is being read and sent: the session is told how many of
	// the changes it holds are already in what was read)
	const diagram = new Diagram({ a: { label: "start" } });
	const { session, patches, state } = alone(diagram);
	for (const label of ["one", "two", "three"]) {
		diagram.patch(update("a", { label }));
		session.localPatch(update("a", { label }), diagram.checksum());
	}
	assert.equal(session.heldCount, 3);
	assert.equal(patches().length, 0, "nothing goes out before the board's diagram is in");
	// the diagram was read after the second change
	const read = new Diagram({ a: { label: "two" } });
	session.forgetHeld(2);
	session.receive({ Identity: 1 });
	session.receive(state(read));
	await session.idle();
	assert.deepEqual(patches().map((p) => [p.base, p.patch.u.p1.cells.u.a.label]), [[0, "three"]]);
	assert.equal(diagram.cells.a.label, "three", "what the read diagram lacked is on top of it again");
	session.dispose();
});

test("a board's diagram that cannot be put in place ends the session; a change that cannot be applied makes it fetch the board's", async () => {
	// the first diagram does not load: not live, and nothing is held for a day that never comes
	const broken = new Diagram();
	broken.replace = async () => {
		throw new Error("the editor did not answer");
	};
	const events = { closed: undefined, problems: [] };
	const { session, patches } = alone(broken, { closed: (r) => (events.closed = r), problem: (t) => events.problems.push(t) });
	session.receive({ Identity: 2 });
	session.receive({ BoardState: { board: "b1", revision: 0, base: 0, content: "{}", patches: [] } });
	await session.idle();
	assert.deepEqual([session.ready, session.closed, events.closed], [false, "failed", "failed"]);
	assert.match(events.problems[0], /could not be dealt with: the editor did not answer/);
	session.localPatch(update("a", { label: "x" }), "sum");
	assert.equal(session.heldCount, 0, "a change after that is not kept waiting");
	assert.equal(patches().length, 0);

	// later on: one of someone's changes does not go in. This diagram now lacks it: the board's is fetched
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	const apply = bo.diagram.apply.bind(bo.diagram);
	let failOnce = true;
	bo.diagram.apply = async (p) => {
		if (failOnce) {
			failOnce = false;
			throw new Error("draw.io refused the change");
		}
		return apply(p);
	};
	ann.change(update("a", { label: "from Ann" }));
	await until(() => bo.events.replaced.length === 2 && bo.session.settled);
	assert.equal(bo.caughtUp(), 1);
	assert.equal(bo.diagram.cells.a.label, "from Ann");
	assert.ok(same(ann, bo));
	assert.equal(bo.session.closed, undefined, "still on the board");
});

/** A stand-in for the editor bridge (CustomizedDrawioClient), over the small diagram model: what LiveShare uses of it. */
function editorStub(diagram) {
	const event = () => {
		const subs = new Set();
		return { sub: (f) => (subs.add(f), { dispose: () => subs.delete(f) }), emit: (v) => subs.forEach((f) => f(v)) };
	};
	const wait = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
	const client = {
		onInit: event(),
		onLivePage: event(),
		shown: [],
		/** What is selected in the editor (the bridge keeps it from the editor's reports). */
		currentSelection: [],
		notices: [],
		liveNotice(text) {
			client.notices.push(text);
		},
		onPatch: event(),
		onCursorChanged: event(),
		onSelectedCellsChanged: event(),
		onSelectedRectangleChanged: event(),
		onFocusChanged: event(),
		calls: [],
		locked: false,
		/** The user changes the diagram: refused while it is locked, as the editor refuses. */
		userEdit(patch) {
			if (client.locked) return false;
			diagram.patch(patch);
			client.onPatch.emit({ patch, checksum: diagram.checksum() });
			return true;
		},
		setDiffSync(on) {
			client.calls.push(`sync:${on}`);
		},
		async liveCompose(xml, patches) {
			client.calls.push("compose");
			await wait(client.composeMs);
			const d = new Diagram(JSON.parse(xml));
			for (const p of patches) d.patch(p);
			return { xml: d.xml(), checksum: d.checksum() };
		},
		liveLoading(on) {
			client.calls.push(`loading:${on}`);
		},
		updateLiveshareViewState(state) {
			client.shown.push(state);
		},
		async liveLock(on) {
			client.calls.push(`lock:${on}`);
			client.beforeLock?.(on);
			await wait(client.lockMs);
			client.locked = on;
		},
		async resetDiff(xml) {
			if (xml === undefined) return diagram.checksum();
			client.calls.push("replace");
			const before = diagram.checksum();
			await wait(client.replaceMs);
			diagram.cells = JSON.parse(xml);
			// (the editor reports the replacing as if it were a change, as draw.io does)
			if (diagram.checksum() !== before) client.onPatch.emit({ patch: update("a", { label: "reported by the replacing" }), checksum: diagram.checksum() });
			return diagram.checksum();
		},
		async loadXmlLike(xml) {
			diagram.cells = JSON.parse(xml);
		},
		async applyPatch(p) {
			diagram.patch(p);
			return diagram.checksum();
		},
		getXml: async () => diagram.xml(),
		diffChecksum: async () => diagram.checksum(),
	};
	return client;
}

test("what someone changes in the moment their diagram is being replaced is theirs and is kept; what the editor reports of the replacing is not sent", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	// Bo joins through the app's own wiring, with an editor that takes a moment to lock and to replace
	const diagram = new Diagram({ x: { label: "what was in his window" } });
	const client = editorStub(diagram);
	client.lockMs = 30;
	client.replaceMs = 30;
	const log = [];
	// he draws in the moment between the board's diagram arriving and the lock taking hold
	let drew = false;
	client.beforeLock = (on) => {
		if (on && !drew) {
			drew = true;
			setTimeout(() => assert.equal(client.userEdit(update("b", { color: "red" })), true), 5);
		}
	};
	const bo = await LiveShare.join({ client, remoteChanged() {}, changed() {}, log: (t) => log.push(t) }, b.link, { name: "Bo" });
	assert.equal(bo.status, "live");
	assert.equal(await bo.shared(3000), true);
	await until(() => ann.session.revision === 1);
	assert.deepEqual(client.calls.slice(0, 7), ["sync:true", "loading:true", "compose", "lock:true", "replace", "lock:false", "loading:false"], "the editor's tools are told for how long the diagram is not what it will be");
	assert.equal(client.locked, false, "and it can be changed again afterwards");
	assert.deepEqual(diagram.cells, { a: { label: "start" }, b: { label: "other", color: "red" } }, "the board's diagram, with what he drew on top");
	assert.deepEqual(ann.diagram.cells, diagram.cells, "and the board has it");
	assert.equal(b.relay.stats(b.link).revision, 1, "one change reached the board: his, not the replacing reported as one");
	// while it is locked the editor takes no change at all
	client.locked = true;
	assert.equal(client.userEdit(update("a", { label: "no" })), false);
	client.locked = false;
	// from here on what he does goes straight out
	client.userEdit(update("a", { label: "after" }));
	await until(() => ann.diagram.cells.a.label === "after");
	await bo.stop();
	assert.deepEqual(log, []);

	// people on a diagram with several pages: each is drawn only for those who are on the same page
	const diagram3 = new Diagram();
	const client3 = editorStub(diagram3);
	const dee = await LiveShare.join({ client: client3, remoteChanged() {}, changed() {}, log() {} }, b.link, { name: "Dee" });
	client3.onLivePage.emit({ page: "p1" });
	const drawn = () => {
		const last = client3.shown.at(-1) ?? { cursors: [], selectedCells: [], selectedRectangles: [] };
		return [last.cursors.length, last.selectedCells.length, last.selectedRectangles.length];
	};
	const where = { cursor: { x: 1, y: 2 }, rect: { start: { x: 0, y: 0 }, end: { x: 5, y: 5 } } };
	ann.session.localPresence({ page: "p2", selected: ["p2/a"], ...where });
	await until(() => dee.people().find((p) => p.name === "Ann")?.presence?.page === "p2" && dee.session.locks["p2/a"] !== undefined);
	assert.deepEqual(drawn(), [0, 0, 0], "Ann is on another page: nothing of hers is drawn on this one");
	assert.deepEqual(client3.shown.at(-1).lockedCells, [], "and the shape she holds there is not one of this page's");
	ann.session.localPresence({ page: "p1", selected: ["p1/a"], ...where });
	await until(() => drawn().join() === "1,1,1");
	// what she has selected is outlined in her colour, from what the board says she holds, and cannot be selected here
	assert.deepEqual(client3.shown.at(-1).selectedCells.map((c) => [c.id, c.selectedCellIds]), [[String(ann.session.id), ["a"]]]);
	assert.deepEqual(client3.shown.at(-1).lockedCells, ["a"]);
	// Dee selects another shape: the board is told as it knows shapes, and holds it for her
	client3.onSelectedCellsChanged.emit({ selectedCellIds: ["b"] });
	await until(() => ann.session.locks["p1/b"] === dee.session.id);
	assert.deepEqual(client3.shown.at(-1).lockedCells, ["a"], "her own is not locked for her");
	// she changes the one Ann holds all the same: the board refuses, it is undone, and she is told whose it is
	client3.userEdit(update("a", { label: "Dee's" }));
	await until(() => client3.notices.length === 1 && dee.session.settled);
	assert.equal(client3.notices[0], "Ann has a shape selected that your change touched, so it was undone.");
	assert.equal(diagram3.cells.a.label, "after");
	// Dee goes to the other page: Ann's pointer goes, what Dee held on the first page is let go of, and the others learn where she is
	client3.onLivePage.emit({ page: "p2" });
	assert.deepEqual(drawn(), [0, 0, 0]);
	await until(() => ann.session.others().find((p) => p.name === "Dee")?.presence?.page === "p2" && !("p1/b" in ann.session.locks));
	// (someone whose page is not known is drawn wherever one is; a shape that is held is always of a page)
	ann.session.localPresence({ selected: ["p1/a"], ...where });
	await until(() => drawn().join() === "1,0,1");
	await dee.stop();
	assert.deepEqual(client3.shown.at(-1), { cursors: [], selectedCells: [], selectedRectangles: [], lockedCells: [] }, "nothing of the others stays drawn, or locked, in a window that has left");

	// the editor's page is loaded anew while sharing: this window is no longer on the board, and says so
	const diagram2 = new Diagram();
	const client2 = editorStub(diagram2);
	let changes = 0;
	const cy = await LiveShare.join({ client: client2, remoteChanged() {}, changed: () => changes++, log() {} }, b.link, { name: "Cy" });
	await until(() => ann.session.others().some((p) => p.name === "Cy"));
	client2.onInit.emit();
	await until(() => cy.status === "ended");
	assert.match(cy.ended, /editor was reloaded, so sharing stopped/);
	await until(() => !ann.session.others().some((p) => p.name === "Cy"));
	// what is done in the reloaded editor is not sent anywhere
	const revision = b.relay.stats(b.link).revision;
	client2.userEdit(update("a", { label: "after the reload" }));
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(b.relay.stats(b.link).revision, revision);
	assert.ok(changes > 0, "the window was told");
});

test("an editor that can work the board's diagram out first gets it as one diagram: only what differs changes, and nothing is made again", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	for (const label of ["one", "two", "three"]) ann.change(update("a", { label }));
	ann.change(insert("c", { label: "new" }));
	await until(() => ann.session.settled && ann.session.revision === 4);
	// Bo's editor can compose; it notes what it was asked to do
	const diagram = new Diagram();
	const asked = [];
	diagram.compose = async (xml, patches) => {
		const d = new Diagram(JSON.parse(xml));
		for (const p of patches) d.patch(p);
		asked.push(`compose:${patches.length}`);
		return { xml: d.xml(), checksum: d.checksum() };
	};
	const apply = diagram.apply.bind(diagram);
	diagram.apply = async (p) => (asked.push("apply"), apply(p));
	const replace = diagram.replace.bind(diagram);
	diagram.replace = async (xml, expected) => (asked.push("replace"), assert.equal(new Diagram(JSON.parse(xml)).checksum(), expected), replace(xml));
	const sent = [];
	let socket;
	const session = new LiveSession(diagram, (m) => (sent.push(m), socket.send(m)), {}, { snapshotQuietMs: 60_000 });
	await new Promise((resolve, reject) => (socket = openBoard(b.link, { onOpen: resolve, onMessage: (m) => session.receive(m), onEnd: reject })));
	session.hello(b.link.board, "Bo", 10);
	await until(() => session.ready);
	assert.deepEqual(asked, ["compose:4", "replace"], "the whole diagram and its four changes as one diagram, put in once");
	assert.equal(diagram.checksum(), ann.diagram.checksum());
	assert.equal(session.revision, 4);
	// what he had made before it arrived still goes on top afterwards, by being applied
	session.localPatch(update("b", { color: "red" }), "x");
	await until(() => ann.diagram.cells.b.color === "red");
	socket.close();
});

test("sharing a diagram again while the last sharing is still being closed on the server: the new one keeps the editor", async () => {
	const relay = await startBoardRelay({ deleteDelayMs: 150 });
	relays.push(relay);
	const diagram = new Diagram({ a: { label: "start" } });
	const client = editorStub(diagram);
	const win = { client, remoteChanged() {}, changed() {}, log() {} };
	// (a shape the host had selected before sharing is held for them from the start, though nothing says the selection changed)
	client.currentSelection = ["a"];
	const first = await LiveShare.host(win, relay.url, { name: "Host", title: "T" });
	client.onLivePage.emit({ page: "p1" });
	await until(() => relay.stats(first.link)?.locks["p1/a"] === first.session.id);
	const stopping = first.stop();
	assert.equal(client.calls.at(-1), "sync:false", "the editor is let go of at once, not when the server has answered");
	// shared again before the server has closed the first board
	const second = await LiveShare.host(win, relay.url, { name: "Host", title: "T" });
	await stopping;
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(client.calls.filter((c) => c.startsWith("sync:")).at(-1), "sync:true", "nothing of the first sharing switched the second one's editor off");
	// and what is drawn now is shared
	client.userEdit(update("a", { label: "on the second board" }));
	assert.equal(await second.shared(3000), true);
	assert.equal(relay.stats(second.link).revision, 1);
	assert.equal(relay.pads.has(first.link.pad), false);
	assert.notEqual(second.link.pad, first.link.pad, "a new sharing is a new pad, with a new link");
	await second.stop();
});

test("sharing that is stopped half-way leaves nothing behind: no board that was still being made, and no diagram put into an editor it has let go of", async () => {
	// the editor is reloaded while the server is still making the board
	const relay = await startBoardRelay({ createDelayMs: 120 });
	relays.push(relay);
	const diagram = new Diagram({ a: { label: "start" } });
	const client = editorStub(diagram);
	const win = { client, remoteChanged() {}, changed() {}, log() {} };
	const starting = LiveShare.host(win, relay.url, { name: "Host", title: "T" });
	setTimeout(() => client.onInit.emit(), 40);
	await assert.rejects(starting, /editor was reloaded/);
	await until(() => relay.pads.size === 0);
	assert.equal(client.calls.filter((c) => c.startsWith("sync:")).at(-1), "sync:false");

	// someone leaves while the board's diagram is being worked out for them: it is not put in afterwards
	const b = await board();
	const ann = await join(b.link, "Ann", {});
	const diagram2 = new Diagram();
	const client2 = editorStub(diagram2);
	const bo = await LiveShare.join({ client: client2, remoteChanged() {}, changed() {}, log() {} }, b.link, { name: "Bo" });
	ann.change(update("a", { label: "from Ann" }));
	await until(() => diagram2.cells.a.label === "from Ann");
	client2.composeMs = 120;
	client2.calls.length = 0;
	bo.session.catchUp();
	await until(() => client2.calls.includes("compose"));
	await bo.stop();
	// (what he does in his window after leaving is his own)
	client2.userEdit(update("a", { label: "after leaving" }));
	await new Promise((r) => setTimeout(r, 250));
	const afterLeaving = client2.calls.slice(client2.calls.indexOf("sync:false") + 1);
	assert.deepEqual(afterLeaving.filter((c) => c === "replace" || c === "lock:true"), [], `nothing was put into the editor after it was let go of: ${afterLeaving.join(", ")}`);
	assert.equal(diagram2.cells.a.label, "after leaving");
	assert.equal(afterLeaving.at(-1), "loading:false", "and the editor's tools were told that the loading is over");
});

test("a diagram that cannot be read for the board this once changes nothing else: the next message is dealt with, and it is tried again", async () => {
	const diagram = new Diagram({ a: { label: "start" } });
	const start = new Diagram(diagram.cells);
	let fail = true;
	const read = diagram.snapshot.bind(diagram);
	diagram.snapshot = async () => {
		if (fail) throw new Error("draw.io did not answer");
		return read();
	};
	const problems = [];
	const { session, sent, state } = alone(diagram, { problem: (t) => problems.push(t) }, { snapshotQuietMs: 15 });
	session.receive({ Identity: 1 });
	session.receive(state(start));
	await session.idle();
	let revision = 0;
	const change = (label) => {
		diagram.patch(update("a", { label }));
		session.localPatch(update("a", { label }), diagram.checksum());
		// (the board numbers it and sends it back)
		session.receive({ BoardPatch: { board: "b1", revision: ++revision, from: 1, patch: update("a", { label }) } });
	};
	change("one");
	// things go quiet, the moment to send the whole diagram comes, and the editor does not give it
	await until(() => problems.length === 1);
	assert.match(problems[0], /could not be read for the board: draw\.io did not answer/);
	assert.equal(sent.filter((m) => m.BoardSnapshot).length, 0);
	// the session is none the worse: a change and its receipt go through
	change("two");
	await session.idle();
	assert.deepEqual([session.unsent, session.revision], [0, 2]);
	// and the diagram is sent once the editor gives it again: the whole of it, at the revision it is of, in this connection's epoch
	fail = false;
	await until(() => sent.some((m) => m.BoardSnapshot));
	assert.deepEqual(sent.filter((m) => m.BoardSnapshot).map((m) => m.BoardSnapshot), [{ board: "b1", revision: 2, content: diagram.xml(), epoch: 1 }]);
	// the same when the board asks for it outright
	fail = true;
	session.receive({ BoardWantSnapshot: { board: "b1" } });
	await session.idle();
	change("three");
	await session.idle();
	assert.equal(session.unsent, 0);
	// the pad was unused for too long and the server says it is disconnecting: that is the end, said as such
	let closed;
	const idle = alone(new Diagram(), { closed: (r) => (closed = r) });
	idle.session.receive({ Idle: {} });
	await idle.session.idle();
	assert.equal(closed, "idle");
	session.dispose();
});

test("the board asks for the whole diagram when its list of changes is long, and takes it from someone in step; a later joiner starts from that", async () => {
	const b = await board(undefined, { askSnapshotEvery: 3, takeAnywayAt: 6 });
	const ann = await join(b.link, "Ann");
	const bo = await join(b.link, "Bo");
	for (let i = 0; i < 3; i++) bo.change(update("a", { label: `v${i}` }));
	await until(() => b.relay.stats(b.link).snapshot === 3);
	assert.equal(b.relay.stats(b.link).patches, 0, "the changes it had kept are in the whole diagram now");
	assert.ok(ann.sent.some((m) => m.BoardSnapshot) || bo.sent.some((m) => m.BoardSnapshot));
	for (let i = 3; i < 5; i++) bo.change(update("a", { label: `v${i}` }));
	await until(() => ann.session.revision === 5 && bo.session.settled);
	const cy = await join(b.link, "Cy");
	assert.ok(same(ann, bo, cy));
	// a whole diagram of an older revision, of one the board has not reached, or from an epoch its sender has left, is not taken
	const taken = b.relay.stats(b.link).snapshots;
	bo.socket.send({ BoardSnapshot: { board: b.link.board, revision: 1, content: "{}", epoch: 1 } });
	bo.socket.send({ BoardSnapshot: { board: b.link.board, revision: 99, content: "{}", epoch: 1 } });
	bo.socket.send({ BoardSnapshot: { board: b.link.board, revision: 5, content: "{}", epoch: 0 } });
	const dee = await join(b.link, "Dee");
	assert.ok(same(ann, dee));
	assert.equal(b.relay.stats(b.link).snapshots, taken);
	// nor from someone while another person holds a shape (their copy cannot be checked against the changes)
	const pause = () => new Promise((r) => setTimeout(r, 60));
	ann.select("a");
	await until(() => bo.session.locks["p1/a"] === ann.session.id);
	bo.socket.send({ BoardSnapshot: { board: b.link.board, revision: 5, content: bo.diagram.xml(), epoch: 1 } });
	await pause();
	assert.equal(b.relay.stats(b.link).snapshot, 3, "not Bo's: Ann holds a shape");
	// the one who holds it is the one the board can take it from
	bo.change(update("b", { label: "more" }));
	await until(() => b.relay.stats(b.link).snapshot === 6);
	assert.ok(ann.sent.some((m) => m.BoardSnapshot?.revision === 6));
	// two people each hold a shape: nobody's copy is taken, however often the board asks...
	dee.select("b");
	await until(() => bo.session.locks["p1/b"] === dee.session.id);
	for (let i = 0; i < 6; i++) bo.change(update("c", { label: `w${i}` }));
	await until(() => ann.session.revision === 12 && bo.session.settled && ann.session.settled);
	await pause();
	assert.deepEqual([b.relay.stats(b.link).snapshot, b.relay.stats(b.link).patches], [6, 6]);
	// ...until the list has grown long: then one is taken all the same, so that the board never has to stop taking changes
	for (let i = 6; i < 9; i++) bo.change(update("c", { label: `w${i}` }));
	await until(() => b.relay.stats(b.link).snapshot === 15);
	await until(() => ann.session.revision === 15 && dee.session.revision === 15);
	assert.ok(same(ann, bo, dee));
	await b.relay.close();
});

test("making, finding and ending a board; what the app says when the server is not one", async () => {
	const b = await board();
	assert.match(b.link.pad, /^[A-Za-z0-9_-]{22}$/, "a pad of its own, with an id nobody can guess: the link is the permission");
	assert.match(b.link.board, /^[a-z0-9]{10}$/);
	assert.equal(typeof b.ownerKey, "string");
	assert.equal(await boardExists(b.link), true);
	assert.equal(await boardExists({ ...b.link, pad: "B".repeat(22) }), false);
	assert.equal(await boardExists({ ...b.link, board: "nosuchone1" }), false);
	const ann = await join(b.link, "Ann", {});
	const bo = await join(b.link, "Bo");
	// only who made it ends it
	await closeBoard(b.link, "not-the-key");
	assert.equal(await boardExists(b.link), true);
	await closeBoard(b.link, b.ownerKey);
	await until(() => bo.events.closed && ann.events.closed);
	assert.deepEqual([ann.events.closed, bo.events.closed], ["gone", "gone"], "the board leaving the pad's list is how its end is told");
	assert.equal(await boardExists(b.link), false);
	// after that nothing more is sent, and the link leads nowhere
	bo.change(update("a", { label: "late" }));
	assert.equal(bo.patches().length, 0);
	await assert.rejects(new Promise((resolve, reject) => openBoard(b.link, { onOpen: resolve, onMessage() {}, onEnd: (why) => reject(new Error(why)) })), /could not be reached|was lost/);
	// a link to a board that is not there (it has ended, or the link was cut short): said at once, in words
	const nobody = editorStub(new Diagram());
	const started = Date.now();
	await assert.rejects(LiveShare.join({ client: nobody, remoteChanged() {}, changed() {}, log() {} }, { ...b.link, pad: "C".repeat(22) }, { name: "Eve" }), /leads to no shared diagram/);
	assert.ok(Date.now() - started < 5000, "not after a long wait");
	assert.equal(nobody.calls.filter((c) => c.startsWith("sync:")).at(-1), "sync:false", "and the editor is let go of");
	await b.relay.close();

	// a server that is not an OmniPad with boards, and one that is not there
	const http = require("http");
	const other = http.createServer((req, res) => res.writeHead(404).end("no"));
	await new Promise((r) => other.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${other.address().port}`;
	await assert.rejects(createBoard(url, { title: "T", xml: "{}" }), (e) => e instanceof BoardError && /has no boards/.test(e.message));
	other.close();
	await assert.rejects(createBoard(url, { title: "T", xml: "{}" }), (e) => e instanceof BoardError && /could not be reached/.test(e.message) && !e.message.includes("api/boards"));
	// a server that has had enough shared diagrams from this address for now, and one whose answer is not a board
	for (const [status, body, says] of [[503, "{}", /not taking another shared diagram/], [200, JSON.stringify({ pad: "../etc", board: "x", owner_key: "k" }), /answer was not a board/], [200, JSON.stringify({ pad: "A".repeat(22), board: "k3x9m2p7qa" }), /answer was not a board/]]) {
		const odd = http.createServer((req, res) => res.writeHead(status, { "content-type": "application/json" }).end(body));
		await new Promise((r) => odd.listen(0, "127.0.0.1", r));
		await assert.rejects(createBoard(`http://127.0.0.1:${odd.address().port}`, { title: "T", xml: "{}" }), (e) => e instanceof BoardError && says.test(e.message));
		odd.close();
	}
});
