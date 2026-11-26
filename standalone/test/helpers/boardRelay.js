// A stand-in for OmniPad's boards: a small server that speaks the protocol in
// docs/omnipad-boards-protocol.md (version 1 links: the board's id is the permission).
// For the tests, and for trying Go live between two OmniDraw windows on one computer before
// OmniPad has boards (node standalone/test/helpers/boardRelay.js [port]).
//
// It does what the note asks of the server and no more: it numbers patches in the order they
// arrive and passes them on without reading them, keeps the newest snapshot and the patches
// since, and hands both to whoever joins or asks to catch up. Nothing is saved to disk.
const http = require("http");
const crypto = require("crypto");

const MAX_PATCHES = 500;
const MAX_SNAPSHOT = 8 * 1024 * 1024;
const MAX_PATCH = 1024 * 1024;
const MAX_PEOPLE = 32;

/** A WebSocket, server side: text messages in whole frames, which is all the protocol sends. */
class Socket {
	constructor(socket) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.parts = [];
		this.onmessage = () => {};
		this.onclose = () => {};
		this.open = true;
		socket.on("data", (d) => this.read(d));
		socket.on("close", () => this.ended());
		socket.on("error", () => this.ended());
	}
	ended() {
		if (!this.open) return;
		this.open = false;
		this.onclose();
	}
	read(data) {
		this.buffer = Buffer.concat([this.buffer, data]);
		for (;;) {
			if (this.buffer.length < 2) return;
			const fin = (this.buffer[0] & 0x80) !== 0;
			const op = this.buffer[0] & 0x0f;
			const masked = (this.buffer[1] & 0x80) !== 0;
			let len = this.buffer[1] & 0x7f;
			let at = 2;
			if (len === 126) {
				if (this.buffer.length < 4) return;
				len = this.buffer.readUInt16BE(2);
				at = 4;
			} else if (len === 127) {
				if (this.buffer.length < 10) return;
				len = Number(this.buffer.readBigUInt64BE(2));
				at = 10;
			}
			if (len > MAX_SNAPSHOT + 1024 * 1024) return this.close(1009);
			const need = at + (masked ? 4 : 0) + len;
			if (this.buffer.length < need) return;
			let payload = this.buffer.subarray(at + (masked ? 4 : 0), need);
			if (masked) {
				const mask = this.buffer.subarray(at, at + 4);
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			}
			this.buffer = this.buffer.subarray(need);
			if (op === 0x8) return this.close(1000);
			if (op === 0x9) this.frame(0xa, payload);
			else if (op === 0x1 || op === 0x0) {
				this.parts.push(payload);
				if (fin) {
					const text = Buffer.concat(this.parts).toString("utf8");
					this.parts = [];
					this.onmessage(text);
				}
			}
		}
	}
	frame(op, payload) {
		if (!this.open) return;
		const len = payload.length;
		const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
		this.socket.write(Buffer.concat([head, payload]));
	}
	send(message) {
		this.frame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
	}
	close(code = 1000) {
		if (!this.open) return;
		const b = Buffer.alloc(2);
		b.writeUInt16BE(code);
		this.frame(0x8, b);
		this.socket.end();
		this.ended();
	}
}

/**
 * Starts a relay on this computer. Returns { url, boards, close(), stats(id) }.
 * `options.maxPatches`: how many patches are kept before a snapshot is asked for (default 500).
 * `options.createDelayMs`: how long making a board takes (a slow server, for tests of what
 * someone does meanwhile).
 */
async function startBoardRelay(options = {}) {
	const boards = new Map();
	const maxPatches = options.maxPatches ?? MAX_PATCHES;

	const json = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://relay");
		const one = /^\/api\/boards\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
		if (req.method === "POST" && url.pathname === "/api/boards") {
			const chunks = [];
			let size = 0;
			req.on("data", (c) => {
				size += c.length;
				if (size > MAX_SNAPSHOT + 4096) req.destroy();
				else chunks.push(c);
			});
			req.on("end", () => {
				let body;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					return json(res, 400, { error: "not JSON" });
				}
				if (body?.kind !== "drawio" || typeof body.xml !== "string" || typeof body.checksum !== "string") return json(res, 400, { error: "kind, xml and checksum are needed" });
				const id = crypto.randomBytes(16).toString("base64url");
				const ownerKey = crypto.randomBytes(24).toString("base64url");
				boards.set(id, { id, kind: "drawio", title: String(body.title ?? "").slice(0, 200), ownerKey, revision: 0, snapshot: { revision: 0, xml: body.xml, checksum: body.checksum }, patches: [], people: new Map(), nextPerson: 1, resyncs: new Map(), asked: false, epoch: 0 });
				setTimeout(() => json(res, 201, { id, revision: 0, owner_key: ownerKey, expires_at: null }), options.createDelayMs ?? 0);
			});
			return;
		}
		if (one && req.method === "GET") {
			const b = boards.get(one[1]);
			return b ? json(res, 200, { kind: b.kind, title: b.title, revision: b.revision, role: "editor", people: b.people.size }) : json(res, 404, { error: "no such board" });
		}
		if (one && req.method === "DELETE") {
			const b = boards.get(one[1]);
			if (!b) return json(res, 404, { error: "no such board" });
			if (req.headers["x-board-owner"] !== b.ownerKey) return json(res, 403, { error: "only who made the board closes it" });
			for (const p of b.people.values()) {
				p.socket.send({ Closed: { reason: "host" } });
				p.socket.close();
			}
			boards.delete(b.id);
			return json(res, 200, { closed: true });
		}
		json(res, 404, { error: "not found" });
	});

	server.on("upgrade", (req, raw) => {
		const url = new URL(req.url, "http://relay");
		const m = /^\/api\/boards\/([A-Za-z0-9_-]{16,64})\/socket$/.exec(url.pathname);
		const board = m && boards.get(m[1]);
		const key = req.headers["sec-websocket-key"];
		if (!board || !key || board.people.size >= MAX_PEOPLE) {
			raw.end(`HTTP/1.1 ${board ? 503 : 404} ${board ? "Full" : "Not Found"}\r\n\r\n`);
			return;
		}
		const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		const socket = new Socket(raw);
		const me = { id: board.nextPerson++, socket, info: null, owner: false };
		const others = () => [...board.people.values()].filter((p) => p !== me);
		const sendBoard = (to) => to.socket.send({ Board: { revision: board.revision, epoch: board.epoch, xml: board.snapshot.xml, checksum: board.snapshot.checksum, patches: board.patches } });
		const host = () => [...board.people.values()].find((p) => p.owner) ?? [...board.people.values()][0];

		socket.onmessage = (text) => {
			let msg;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}
			if (msg.Hello) {
				if (me.info) return;
				me.info = { name: String(msg.Hello.name ?? "").slice(0, 60) || "Someone", hue: Number(msg.Hello.hue) || 0 };
				// (who made the board says so with the key it was given, in its first message: a browser cannot add a header to a socket)
				me.owner = typeof msg.Hello.owner === "string" && msg.Hello.owner === board.ownerKey;
				board.people.set(me.id, me);
				socket.send({ Identity: { id: me.id, role: "editor", owner: me.owner } });
				for (const p of board.people.values()) socket.send({ UserInfo: { id: p.id, info: p.info } });
				for (const p of others()) p.socket.send({ UserInfo: { id: me.id, info: me.info } });
				sendBoard(me);
				return;
			}
			if (!me.info) return;
			if (msg.Patch) {
				const { base, epoch, patch, checksum } = msg.Patch;
				if (typeof base !== "number" || !patch || typeof patch !== "object" || text.length > MAX_PATCH) return;
				// (a change made before the board last sent everyone its diagram is of a diagram that is gone)
				const clean = base === board.revision && typeof checksum === "string" && epoch === board.epoch;
				const numbered = { revision: ++board.revision, from: me.id, patch, checksum: typeof checksum === "string" ? checksum : null, clean };
				board.patches.push(numbered);
				for (const p of others()) p.socket.send({ Patch: numbered });
				socket.send({ Ack: { revision: numbered.revision, clean } });
				if (board.patches.length > maxPatches && !board.asked) {
					board.asked = true;
					host()?.socket.send({ NeedSnapshot: {} });
				}
			} else if (msg.Snapshot) {
				const { revision, xml, checksum } = msg.Snapshot;
				if (typeof revision !== "number" || typeof xml !== "string" || typeof checksum !== "string" || xml.length > MAX_SNAPSHOT) return;
				board.asked = false;
				// (kept only if it is newer than what is there, and of a revision the board has reached)
				if (revision <= board.snapshot.revision || revision > board.revision) return;
				board.snapshot = { revision, xml, checksum };
				board.patches = board.patches.filter((p) => p.revision > revision);
				if (board.settle) {
					// (asked of the host to settle a disagreement: everyone gets the board as the host has it)
					board.settle = false;
					board.epoch++;
					sendBoard(me);
					for (const p of board.people.values()) if (p !== me) sendBoard(p);
				}
			} else if (msg.Presence) {
				const { page, cursor, selection, rect } = msg.Presence;
				for (const p of others()) p.socket.send({ Presence: { id: me.id, page, cursor: cursor ?? null, selection: Array.isArray(selection) ? selection.slice(0, 500) : [], rect: rect ?? null } });
			} else if (msg.Resync) {
				const now = Date.now();
				const recent = (board.resyncs.get(me.id) ?? []).filter((t) => now - t < 60_000);
				recent.push(now);
				board.resyncs.set(me.id, recent);
				sendBoard(me);
				// the same person, three times in a minute: the host's copy settles it
				if (recent.length >= 3 && host() && host() !== me) {
					board.resyncs.set(me.id, []);
					board.settle = true;
					host().socket.send({ NeedSnapshot: {} });
				}
			}
		};
		socket.onclose = () => {
			if (!board.people.delete(me.id)) return;
			for (const p of board.people.values()) p.socket.send({ UserInfo: { id: me.id, info: null } });
		};
	});

	await new Promise((r) => server.listen(options.port ?? 0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		boards,
		stats: (id) => {
			const b = boards.get(id);
			return b && { revision: b.revision, snapshot: b.snapshot.revision, patches: b.patches.length, people: b.people.size };
		},
		close: () =>
			new Promise((r) => {
				for (const b of boards.values()) for (const p of b.people.values()) p.socket.close();
				server.close(() => r());
				server.closeAllConnections?.();
			}),
	};
}

module.exports = { startBoardRelay };

if (require.main === module) {
	startBoardRelay({ port: Number(process.argv[2]) || 8787 }).then((r) => console.log(`Board relay (a stand-in for OmniPad's boards) at ${r.url}\nPut that address in OmniDraw: File → Go Live…, OmniPad server.`));
}
