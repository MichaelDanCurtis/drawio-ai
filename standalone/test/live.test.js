// Go live: one person's side of a shared diagram (the session), against a stand-in for
// OmniPad's boards. Nothing here is draw.io or reaches a network beyond this computer: the
// "diagram" is a small model with patches shaped like draw.io's, and the server is
// test/helpers/boardRelay.js.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
require("./helpers/ts");
const { LiveSession } = require("../src/main/live/session");
const { createBoard, boardExists, closeBoard, openBoard, BoardError } = require("../src/main/live/connection");
const { parseBoardLink, boardLink, serverOrigin, socketUrl, touched, apart } = require("../src/main/live/protocol");
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
async function join(link, name, { ownerKey, cells } = {}) {
	const diagram = new Diagram(cells);
	const sent = [];
	const events = { replaced: [], problems: [], closed: undefined, people: [] };
	let socket;
	let gate = null; // when an array: messages are kept here instead of being handed on
	const session = new LiveSession(
		diagram,
		(m) => {
			sent.push(m);
			socket.send(m);
		},
		{ replaced: (why) => events.replaced.push(why), problem: (t) => events.problems.push(t), closed: (r) => (events.closed = r), people: (p) => (events.people = p) },
		{ snapshotQuietMs: 60_000 }
	);
	await new Promise((resolve, reject) => {
		socket = openBoard(link, { onOpen: resolve, onMessage: (m) => (gate ? gate.push(m) : session.receive(m)), onEnd: (why) => (events.ended = why, reject(new Error(why))) });
	});
	session.hello(name, 200, "test/1", ownerKey);
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
		kept: () => (gate ?? []).map((m) => Object.keys(m)[0]),
	};
}

const relays = [];
// (a test that fails half-way must not leave a server holding the run open)
test.after(() => Promise.all(relays.map((r) => r.close())));
async function board(cells = { a: { label: "start" }, b: { label: "other" } }, options) {
	const relay = await startBoardRelay(options);
	relays.push(relay);
	const first = new Diagram(cells);
	const made = await createBoard(relay.url, { title: "Test", xml: first.xml(), checksum: first.checksum() });
	return { relay, ...made, cells };
}
const same = (...people) => people.every((p) => p.diagram.checksum() === people[0].diagram.checksum());

test("a link to a board: read from what is pasted, and what is not one", () => {
	const id = "A".repeat(22);
	assert.deepEqual(parseBoardLink(`https://pad.example.com/b/${id}`), { server: "https://pad.example.com", id });
	assert.deepEqual(parseBoardLink(`  https://pad.example.com:8443/b/${id}/?invite=rpi_abc12345  `), { server: "https://pad.example.com:8443", id, invite: "rpi_abc12345" });
	assert.deepEqual(parseBoardLink(`http://127.0.0.1:8787/b/${id}`), { server: "http://127.0.0.1:8787", id }, "a server on this computer may be plain http");
	assert.equal(boardLink({ server: "https://pad.example.com", id, invite: "rpi_abc12345" }), `https://pad.example.com/b/${id}?invite=rpi_abc12345`);
	assert.equal(socketUrl({ server: "https://pad.example.com", id }), `wss://pad.example.com/api/boards/${id}/socket`);
	assert.equal(socketUrl({ server: "http://127.0.0.1:8787", id }), `ws://127.0.0.1:8787/api/boards/${id}/socket`);
	for (const no of ["", "pad.example.com", `http://pad.example.com/b/${id}`, `https://pad.example.com/b/short`, `https://pad.example.com/b/${id}/extra`, `https://pad.example.com/pads/${id}`, `https://me:pw@pad.example.com/b/${id}`, `https://pad.example.com/b/${id}?invite=a b`, `file:///b/${id}`, `javascript:alert(1)//b/${id}`, `https://pad.example.com/b/${"x".repeat(80)}`]) assert.equal(parseBoardLink(no), undefined, no);
	// a server's address, as typed into Settings
	assert.equal(serverOrigin("pad.example.com"), "https://pad.example.com");
	assert.equal(serverOrigin("https://pad.example.com/"), "https://pad.example.com");
	assert.equal(serverOrigin("http://localhost:8787"), "http://localhost:8787");
	for (const no of ["", "http://pad.example.com", "ftp://pad.example.com", "pad example"]) assert.equal(serverOrigin(no), undefined, no);
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
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	assert.deepEqual([ann.session.owner, bo.session.owner], [true, false]);
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
	assert.deepEqual(ann.sent.filter((m) => m.Patch).slice(-3).map((m) => m.Patch.base), [2, 3, 4]);
	await until(() => bo.session.revision === 5);
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined"], "nobody had to catch up");
	assert.deepEqual([...ann.events.problems, ...bo.events.problems], []);

	// where someone is
	bo.session.localPresence({ page: "p1", cursor: { x: 10, y: 20 }, selection: ["a"], rect: null });
	await until(() => ann.session.others()[0]?.presence);
	assert.deepEqual(ann.session.others()[0].presence, { page: "p1", cursor: { x: 10, y: 20 }, selection: ["a"], rect: null });

	const cy = await join(b.link, "Cy");
	assert.ok(same(ann, bo, cy));
	assert.equal(cy.session.revision, 5);
	// leaving: the others are told
	bo.socket.close();
	await until(() => ann.session.others().length === 1);
	assert.deepEqual(ann.session.others().map((p) => p.name), ["Cy"]);
	await b.relay.close();
});

test("changes made at the same moment: to different shapes nothing needs putting right; to the same shape everyone ends with the one the board numbered last", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");

	// different shapes
	bo.hold();
	ann.change(update("a", { label: "Ann's" }));
	await until(() => ann.session.settled && ann.session.revision === 1);
	bo.change(update("b", { label: "Bo's" }));
	await until(() => bo.kept().includes("Ack"));
	await bo.release();
	await until(() => ann.session.revision === 2 && bo.session.settled);
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined"], "either order gives the same diagram: not reloaded");
	assert.equal(bo.sent.filter((m) => m.Resync).length, 0);

	// the same shape: the board takes Ann's, then Bo's. Bo made his first and then got Ann's on top
	bo.hold();
	ann.change(update("a", { label: "A" }));
	await until(() => ann.session.revision === 3 && ann.session.settled);
	bo.change(update("a", { label: "B" }));
	await until(() => bo.kept().includes("Ack"));
	await bo.release();
	assert.equal(b.relay.stats(b.link.id).revision, 4);
	await until(() => bo.events.replaced.length === 2 && bo.session.settled && ann.session.revision === 4);
	assert.deepEqual(bo.events.replaced, ["joined", "caught-up"]);
	assert.equal(ann.diagram.cells.a.label, "B", "the later one wins, for everyone");
	assert.equal(bo.diagram.cells.a.label, "B");
	assert.ok(same(ann, bo));
	assert.deepEqual(ann.events.replaced, ["joined"], "the one whose change came first has nothing to put right");
	await b.relay.close();
});

test("someone who keeps working after a crossed change does not vouch for their diagram until it is put right", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	bo.hold();
	ann.hold();
	bo.change(update("a", { label: "B" })); // numbered 1
	await until(() => b.relay.stats(b.link.id).revision === 1);
	ann.change(update("a", { label: "A" })); // made without Bo's: numbered 2, after his
	await until(() => b.relay.stats(b.link.id).revision === 2);
	await ann.release(1); // Bo's change reaches Ann while hers is unacknowledged
	assert.deepEqual(ann.kept(), ["Ack"]);
	assert.equal(ann.diagram.cells.a.label, "B", "on her side his went on top of hers: the other way round from the board");
	ann.change(update("b", { color: "red" })); // she keeps working; its base (2) is where the board is
	const last = ann.sent.filter((m) => m.Patch).at(-1).Patch;
	assert.deepEqual([last.base, last.checksum], [2, null], "no checksum: she cannot vouch for her diagram");
	await until(() => b.relay.stats(b.link.id).revision === 3);
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
	assert.equal(typeof ann.sent.filter((m) => m.Patch).at(-1).Patch.checksum, "string");
	await until(() => bo.session.revision === 4);
	assert.ok(same(ann, bo));
	await b.relay.close();
});

test("the board sends everyone its diagram while a change is on its way: the change is kept, and is not vouched for", async () => {
	// (the session alone, with the board's messages given to it by hand: the order here is the point)
	const diagram = new Diagram();
	const sent = [];
	const session = new LiveSession(diagram, (m) => sent.push(m), {}, { snapshotQuietMs: 60_000 });
	const start = new Diagram({ a: { label: "start" }, b: { label: "other" } });
	session.receive({ Identity: { id: 2, role: "editor", owner: false } });
	session.receive({ Board: { revision: 4, epoch: 0, xml: start.xml(), checksum: start.checksum(), patches: [] } });
	await session.idle();
	// this person changes something; before the board has numbered it, the board sends everyone the host's diagram
	diagram.patch(update("b", { color: "red" }));
	session.localPatch(update("b", { color: "red" }), diagram.checksum());
	assert.deepEqual([sent.at(-1).Patch.base, sent.at(-1).Patch.epoch], [4, 0]);
	const hosts = new Diagram({ a: { label: "host's" }, b: { label: "other" } });
	session.receive({ Board: { revision: 4, epoch: 1, xml: hosts.xml(), checksum: hosts.checksum(), patches: [] } });
	await session.idle();
	assert.deepEqual(diagram.cells, { a: { label: "host's" }, b: { label: "other", color: "red" } }, "the host's diagram, with this person's change on top again");
	assert.equal(session.settled, false, "still waiting to hear which revision it became");
	session.receive({ Ack: { revision: 5, clean: false } });
	await session.idle();
	assert.equal(session.revision, 5);
	// (it crossed nothing of anyone's, so there is nothing to put right; and from here on changes say the new count)
	assert.equal(sent.filter((m) => m.Resync).length, 0);
	diagram.patch(update("a", { color: "blue" }));
	session.localPatch(update("a", { color: "blue" }), diagram.checksum());
	assert.deepEqual([sent.at(-1).Patch.base, sent.at(-1).Patch.epoch, typeof sent.at(-1).Patch.checksum], [5, 1, "string"]);
	session.dispose();

	// through the board: someone asks for its diagram three times in a minute, and the host's copy settles it for everyone
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	const cy = await join(b.link, "Cy");
	ann.change(update("a", { label: "one" }));
	await until(() => cy.session.revision === 1 && bo.session.revision === 1);
	for (let i = 0; i < 3; i++) cy.socket.send({ Resync: {} });
	await until(() => bo.session.epoch === 1 && cy.session.epoch === 1 && ann.session.epoch === 1);
	assert.equal(ann.sent.filter((m) => m.Snapshot).length, 1);
	assert.ok(same(ann, bo, cy));
	// a change that says the old count is not vouched for by the board, whatever else matches
	bo.socket.send({ Patch: { base: 1, epoch: 0, patch: update("b", { label: "late" }), checksum: "anything" } });
	await until(() => ann.session.revision === 2);
	assert.deepEqual(ann.events.problems, [], "not compared, so nobody reloads");
	await b.relay.close();
});

test("a diagram that has drifted is noticed at the next change and replaced by the board's; what its owner did meanwhile is kept", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	// (something went wrong on Bo's side that no message accounts for)
	bo.diagram.cells.b.label = "corrupted";
	bo.hold();
	ann.change(update("a", { label: "next" }));
	await until(() => bo.kept().includes("Patch"));
	await bo.release();
	// he has asked for the board's diagram, and changes something before it arrives
	assert.equal(bo.sent.filter((m) => m.Resync).length, 1);
	assert.match(bo.events.problems[0], /differs from the board's at revision 1/);
	assert.equal(bo.session.unsent, 0);
	bo.change(update("b", { color: "green" }));
	assert.equal(bo.sent.filter((m) => m.Patch).length, 0, "held back, not sent, until the board's diagram is in");
	assert.equal(bo.session.unsent, 1, "the board does not have it yet: not the moment to close the window");
	await until(() => bo.events.replaced.length === 2 && bo.session.settled && ann.session.revision === 2);
	assert.deepEqual(bo.diagram.cells, { a: { label: "next" }, b: { label: "other", color: "green" } });
	assert.ok(same(ann, bo));
	assert.equal(bo.session.unsent, 0, "now it has");
	await b.relay.close();
});

test("changes held back go out in the order they were made, also one made while the others are going back in; and the diagram is then checked against the board's", async () => {
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	// Bo's diagram has drifted; at Ann's next change he asks for the board's
	bo.diagram.cells.b.label = "corrupted";
	bo.hold();
	ann.change(update("b", { color: "grey" }));
	await until(() => bo.kept().includes("Patch"));
	await bo.release(1);
	assert.equal(bo.sent.filter((m) => m.Resync).length, 1);
	// before it arrives he sets a label (held); while that is being put back on top he sets it again
	bo.change(update("a", { label: "A" }));
	bo.diagram.slowMs = 40;
	const released = bo.release();
	await until(() => bo.diagram.replaced === 2);
	bo.change(update("a", { label: "B" }));
	await released;
	const labels = () => bo.sent.filter((m) => m.Patch).map((m) => m.Patch.patch.u.p1.cells.u.a.label);
	await until(() => labels().length === 2);
	assert.deepEqual(labels(), ["A", "B"], "in the order he made them");
	assert.deepEqual(bo.sent.filter((m) => m.Patch).map((m) => m.Patch.checksum), [null, null], "not vouched for: his diagram at each is not his diagram with both");
	// the second was already in his diagram and is not put in again; where it sat among the rest is not
	// worked out: the board's diagram is fetched once more, and everyone has B
	bo.diagram.slowMs = 0;
	await until(() => bo.sent.filter((m) => m.Resync).length === 2 && bo.session.settled && ann.session.revision === 3);
	assert.equal(ann.diagram.cells.a.label, "B");
	assert.equal(bo.diagram.cells.a.label, "B");
	assert.ok(same(ann, bo));
	assert.deepEqual(bo.events.replaced, ["joined", "caught-up", "caught-up"]);
});

test("what someone did before the board's diagram was read is in it; only what came after is held", async () => {
	// (the host changes the diagram while it is being read and sent: the session is told how many of
	// the changes it holds are already in what was read)
	const diagram = new Diagram({ a: { label: "start" } });
	const sent = [];
	const session = new LiveSession(diagram, (m) => sent.push(m), {}, { snapshotQuietMs: 60_000 });
	for (const label of ["one", "two", "three"]) {
		diagram.patch(update("a", { label }));
		session.localPatch(update("a", { label }), diagram.checksum());
	}
	assert.equal(session.heldCount, 3);
	assert.equal(sent.length, 0, "nothing goes out before the board's diagram is in");
	// the diagram was read after the second change
	const read = new Diagram({ a: { label: "two" } });
	session.forgetHeld(2);
	session.receive({ Identity: { id: 1, role: "editor", owner: true } });
	session.receive({ Board: { revision: 0, epoch: 0, xml: read.xml(), checksum: read.checksum(), patches: [] } });
	await session.idle();
	assert.deepEqual(sent.filter((m) => m.Patch).map((m) => [m.Patch.base, m.Patch.patch.u.p1.cells.u.a.label]), [[0, "three"]]);
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
	const sent = [];
	const session = new LiveSession(broken, (m) => sent.push(m), { closed: (r) => (events.closed = r), problem: (t) => events.problems.push(t) }, { snapshotQuietMs: 60_000 });
	session.receive({ Identity: { id: 2, role: "editor", owner: false } });
	session.receive({ Board: { revision: 0, epoch: 0, xml: "{}", checksum: "x", patches: [] } });
	await session.idle();
	assert.deepEqual([session.ready, session.closed, events.closed], [false, "failed", "failed"]);
	assert.match(events.problems[0], /could not be dealt with: the editor did not answer/);
	session.localPatch(update("a", { label: "x" }), "sum");
	assert.equal(session.heldCount, 0, "a change after that is not kept waiting");
	assert.equal(sent.length, 0);

	// later on: one of someone's changes does not go in. This diagram now lacks it: the board's is fetched
	const b = await board();
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
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
	assert.equal(bo.sent.filter((m) => m.Resync).length, 1);
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
		setDiffSync() {},
		updateLiveshareViewState() {},
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
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
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
	assert.deepEqual(client.calls.slice(0, 3), ["lock:true", "replace", "lock:false"]);
	assert.equal(client.locked, false, "and it can be changed again afterwards");
	assert.deepEqual(diagram.cells, { a: { label: "start" }, b: { label: "other", color: "red" } }, "the board's diagram, with what he drew on top");
	assert.deepEqual(ann.diagram.cells, diagram.cells, "and the board has it");
	assert.equal(b.relay.stats(b.link.id).revision, 1, "one change reached the board: his, not the replacing reported as one");
	// while it is locked the editor takes no change at all
	client.locked = true;
	assert.equal(client.userEdit(update("a", { label: "no" })), false);
	client.locked = false;
	// from here on what he does goes straight out
	client.userEdit(update("a", { label: "after" }));
	await until(() => ann.diagram.cells.a.label === "after");
	await bo.stop();
	assert.deepEqual(log, []);
});

test("the board asks its host for the whole diagram when the list of changes is long; a later joiner starts from that", async () => {
	const b = await board(undefined, { maxPatches: 3 });
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	for (let i = 0; i < 5; i++) bo.change(update("a", { label: `v${i}` }));
	await until(() => b.relay.stats(b.link.id).snapshot > 0);
	const stats = b.relay.stats(b.link.id);
	assert.ok(stats.snapshot >= 4 && stats.patches <= 1, JSON.stringify(stats));
	assert.equal(ann.sent.filter((m) => m.Snapshot).length, 1, "from the host, once");
	await until(() => ann.session.revision === 5);
	const cy = await join(b.link, "Cy");
	assert.ok(same(ann, bo, cy));
	// a snapshot of an older revision, or of one the board has not reached, is not taken
	bo.socket.send({ Snapshot: { revision: 1, xml: "{}", checksum: "x" } });
	bo.socket.send({ Snapshot: { revision: 99, xml: "{}", checksum: "x" } });
	const dee = await join(b.link, "Dee");
	assert.ok(same(ann, dee));
	await b.relay.close();
});

test("making, finding and ending a board; what the app says when the server is not one", async () => {
	const b = await board();
	assert.match(b.link.id, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(await boardExists(b.link), true);
	assert.equal(await boardExists({ server: b.link.server, id: "B".repeat(22) }), false);
	const ann = await join(b.link, "Ann", { ownerKey: b.ownerKey });
	const bo = await join(b.link, "Bo");
	// only who made it ends it
	await closeBoard(b.link, "not-the-key");
	assert.equal(await boardExists(b.link), true);
	await closeBoard(b.link, b.ownerKey);
	await until(() => bo.events.closed && ann.events.closed);
	assert.deepEqual([ann.events.closed, bo.events.closed], ["host", "host"]);
	assert.equal(await boardExists(b.link), false);
	// after that nothing more is sent
	bo.change(update("a", { label: "late" }));
	assert.equal(bo.sent.filter((m) => m.Patch).length, 0);
	await b.relay.close();

	// a server that is not an OmniPad with boards, and one that is not there
	const http = require("http");
	const other = http.createServer((req, res) => res.writeHead(404).end("no"));
	await new Promise((r) => other.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${other.address().port}`;
	await assert.rejects(createBoard(url, { title: "T", xml: "{}", checksum: "x" }), (e) => e instanceof BoardError && /has no boards/.test(e.message));
	other.close();
	await assert.rejects(createBoard(url, { title: "T", xml: "{}", checksum: "x" }), (e) => e instanceof BoardError && /could not be reached/.test(e.message) && !e.message.includes("api/boards"));
});
