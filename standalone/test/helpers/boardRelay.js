// A stand-in for an OmniPad server's boards: a small server that speaks the part of OmniPad's
// protocol (its packages/board-sync/PROTOCOL.md) that OmniDraw's Go live uses: a draw.io board
// in a pad, over the pad's socket. For the tests, and for trying Go live between two OmniDraw
// windows on one computer without an OmniPad (node standalone/test/helpers/boardRelay.js [port]).
//
// Written from that reference, not from OmniPad's code: it numbers edits in the order they
// arrive and passes them on, reads from each only which shapes it touches (to refuse one that
// touches a shape someone else holds), keeps the newest whole diagram and the edits since, and
// hands both to whoever opens the board. Nothing is saved to disk. It knows nothing of the
// pad's text, its files, private pads or Excalidraw.
const http = require("http");
const crypto = require("crypto");

const MAX_CONTENT = 8 * 1024 * 1024;
const MAX_PATCH = 1024 * 1024;
const MAX_SNAPSHOT = MAX_CONTENT;
const ASK_SNAPSHOT_EVERY = 50;
const TAKE_ANYWAY_AT = 200;
const BUSY_AT = 1000;

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

/** The shapes a draw.io edit touches, as `page/cell`, and the pages it touches whole; undefined when it is not shaped like one. */
function touched(patch) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined;
	const keys = new Set();
	const pages = new Set();
	try {
		for (const [page, diff] of Object.entries(patch.u ?? {})) {
			const cells = diff?.cells;
			if (!cells) continue;
			for (const cell of Object.keys(cells.u ?? {})) keys.add(`${page}/${cell}`);
			for (const cell of cells.r ?? []) {
				if (typeof cell !== "string") return undefined;
				keys.add(`${page}/${cell}`);
			}
			for (const cell of cells.i ?? []) {
				if (typeof cell?.id !== "string") return undefined;
				keys.add(`${page}/${cell.id}`);
				// (a cell with no parent can replace the page's whole model)
				if (typeof cell.parent !== "string" || !cell.parent) pages.add(page);
			}
		}
		for (const page of patch.r ?? []) {
			if (typeof page !== "string") return undefined;
			pages.add(page);
		}
	} catch {
		return undefined;
	}
	return { keys, pages };
}

/**
 * Starts a relay on this computer. Returns { url, pads, ended, close(), stats(link), board(link) }.
 * `options.askSnapshotEvery`: after how many edits clients are asked for the whole diagram (default 50).
 * `options.takeAnywayAt`, `options.busyAt`: as OmniPad's 200 and 1000.
 * `options.createDelayMs`, `options.deleteDelayMs`: how long sharing and ending a board take
 * (a slow server, for tests of what someone does meanwhile).
 */
async function startBoardRelay(options = {}) {
	/** pad id -> { id, ownerKey, boards: Map, people: Map, nextId } */
	const pads = new Map();
	/** Pads of shared boards that were ended: nothing of them answers any more. */
	const ended = new Set();
	const askEvery = options.askSnapshotEvery ?? ASK_SNAPSHOT_EVERY;
	const takeAnywayAt = options.takeAnywayAt ?? TAKE_ANYWAY_AT;
	const busyAt = options.busyAt ?? BUSY_AT;

	const padOf = (id) => {
		if (!pads.has(id)) pads.set(id, { id, ownerKey: undefined, boards: new Map(), people: new Map(), nextId: 0 });
		return pads.get(id);
	};
	const newBoard = (name, content) => ({ id: crypto.randomBytes(8).toString("hex").slice(0, 10), name, kind: "drawio", created_at: new Date().toISOString(), revision: 0, snapshot: { revision: 0, content }, patches: [], askedAt: 0, locks: new Map(), lockSeq: 0, presence: new Map(), epochs: new Map(), open: new Set() });
	const list = (pad) => [...pad.boards.values()].map((b) => ({ id: b.id, name: b.name, kind: b.kind, created_at: b.created_at }));

	const json = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://relay");
		const live = /^\/api\/boards\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
		const boards = /^\/api\/pads\/([A-Za-z0-9_-]{1,64})\/boards$/.exec(url.pathname);
		if (req.method === "POST" && url.pathname === "/api/boards") {
			const chunks = [];
			let size = 0;
			req.on("data", (c) => {
				size += c.length;
				if (size > MAX_CONTENT + 4096) req.destroy();
				else chunks.push(c);
			});
			req.on("end", () => {
				let body;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					return json(res, 400, { error: "not JSON" });
				}
				if (body?.kind !== "drawio" || (body.content !== undefined && typeof body.content !== "string")) return json(res, 400, { error: "kind and content are needed" });
				// (a pad of its own, whose id is the permission)
				const pad = padOf(crypto.randomBytes(16).toString("base64url"));
				pad.ownerKey = crypto.randomBytes(24).toString("base64url");
				const board = newBoard(String(body.title ?? "").slice(0, 80) || "Board", body.content ?? "");
				pad.boards.set(board.id, board);
				const path = `/b/${pad.id}/${board.id}`;
				setTimeout(() => json(res, 200, { pad: pad.id, board: board.id, path, link: path, owner_key: pad.ownerKey }), options.createDelayMs ?? 0);
			});
			return;
		}
		if (boards && req.method === "GET") {
			if (ended.has(boards[1])) return json(res, 404, { error: "not found" });
			return json(res, 200, pads.has(boards[1]) ? list(pads.get(boards[1])) : []);
		}
		if (live && req.method === "DELETE") {
			const pad = pads.get(live[1]);
			if (!pad || !pad.ownerKey) return json(res, 404, { error: "not found" });
			if (req.headers["x-board-owner"] !== pad.ownerKey) return json(res, 403, { error: "only whoever shared this board can end it" });
			// everyone hears that the board is gone, then their connection closes
			for (const p of pad.people.values()) {
				p.socket.send({ Boards: [] });
				p.socket.close();
			}
			pads.delete(pad.id);
			ended.add(pad.id);
			return void setTimeout(() => json(res, 200, { ended: true }), options.deleteDelayMs ?? 0);
		}
		json(res, 404, { error: "not found" });
	});

	server.on("upgrade", (req, raw) => {
		const url = new URL(req.url, "http://relay");
		const m = /^\/api\/socket\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
		const key = req.headers["sec-websocket-key"];
		if (!m || !key || ended.has(m[1])) {
			raw.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const pad = padOf(m[1]);
		const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		const socket = new Socket(raw);
		const me = { id: pad.nextId++, socket, info: null };
		pad.people.set(me.id, me);
		socket.send({ Identity: me.id });
		for (const p of pad.people.values()) if (p.info) socket.send({ UserInfo: { id: p.id, info: p.info } });
		if (pad.boards.size) socket.send({ Boards: list(pad) });

		const everyone = (msg) => {
			for (const p of pad.people.values()) p.socket.send(msg);
		};
		const opened = (board, msg, but) => {
			for (const p of board.open) if (p !== but) p.socket.send(msg);
		};
		const locksOf = (board) => ({ BoardLocks: { board: board.id, seq: board.lockSeq, locks: Object.fromEntries(board.locks) } });
		const stateOf = (board) => ({ BoardState: { board: board.id, revision: board.revision, base: board.snapshot.revision, content: board.snapshot.content, patches: board.patches } });
		const othersHold = (board) => [...board.locks.values()].some((holder) => holder !== me.id);
		const leave = (board) => {
			board.open.delete(me);
			board.epochs.delete(me.id);
			const had = board.presence.delete(me.id);
			let changed = false;
			for (const [k, holder] of [...board.locks]) {
				if (holder === me.id) {
					board.locks.delete(k);
					changed = true;
				}
			}
			if (had) opened(board, { BoardPresence: { board: board.id, from: me.id, presence: null } });
			if (changed) {
				board.lockSeq++;
				opened(board, locksOf(board));
			}
		};

		socket.onmessage = (text) => {
			let msg;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;
			if (msg.ClientInfo) {
				me.info = { name: String(msg.ClientInfo.name ?? "").slice(0, 60) || "Someone", hue: Number(msg.ClientInfo.hue) || 0 };
				return everyone({ UserInfo: { id: me.id, info: me.info } });
			}
			if (msg.BoardList) return socket.send({ Boards: list(pad) });
			const kind = Object.keys(msg)[0];
			const body = msg[kind];
			if (!kind?.startsWith("Board") || !body || typeof body !== "object") return;
			const board = pad.boards.get(body.board);
			if (kind === "BoardOpen") {
				if (!board) return socket.send({ BoardError: { message: "That board is gone" } });
				board.epochs.set(me.id, Math.max(board.epochs.get(me.id) ?? 0, Number(body.epoch) || 0));
				board.open.add(me);
				socket.send(stateOf(board));
				socket.send(locksOf(board));
				for (const [from, presence] of board.presence) if (from !== me.id) socket.send({ BoardPresence: { board: board.id, from, presence } });
				return;
			}
			if (!board || !board.open.has(me)) return;
			if (kind === "BoardClose") return leave(board);
			if (kind === "BoardPatch") {
				const { base, epoch, patch, checksum } = body;
				// (made before this connection last started over: dropped without a word)
				if ((Number(epoch) || 0) < (board.epochs.get(me.id) ?? 0)) return;
				const refuse = (reason, keys) => {
					board.epochs.set(me.id, (Number(epoch) || 0) + 1);
					socket.send({ BoardRejected: { board: board.id, reason, ...(keys?.length ? { keys } : {}) } });
					socket.send(stateOf(board));
					socket.send(locksOf(board));
				};
				if (typeof base !== "number" || base > board.revision) return refuse("ahead");
				const touches = text.length > MAX_PATCH ? undefined : touched(patch);
				if (!touches) return refuse("invalid");
				const held = [...board.locks].filter(([k, holder]) => holder !== me.id && (touches.keys.has(k) || touches.pages.has(k.split("/")[0]))).map(([k]) => k).sort();
				if (held.length) return refuse("locked", held);
				if (board.patches.length >= busyAt) return refuse("busy");
				// (the checksum is of the sender's diagram, which is everyone's only if nothing came in between)
				const made = base === board.revision;
				const numbered = { revision: ++board.revision, from: me.id, patch, ...(made && checksum !== undefined && checksum !== null ? { checksum } : {}) };
				board.patches.push(numbered);
				opened(board, { BoardPatch: { board: board.id, ...numbered } });
				if (board.patches.length >= board.askedAt + askEvery) {
					board.askedAt = board.patches.length;
					opened(board, { BoardWantSnapshot: { board: board.id } });
				}
			} else if (kind === "BoardSnapshot") {
				const { revision, content, epoch } = body;
				// taken only from someone in step, and while nobody else holds a shape (or the list has grown long)
				if (typeof content !== "string" || content.length > MAX_SNAPSHOT || (Number(epoch) || 0) < (board.epochs.get(me.id) ?? 0) || revision !== board.revision) return;
				if (othersHold(board) && board.patches.length <= takeAnywayAt) return;
				board.snapshot = { revision, content };
				board.patches = [];
				board.askedAt = 0;
				board.snapshots = (board.snapshots ?? 0) + 1;
			} else if (kind === "BoardPresence") {
				const presence = body.presence && typeof body.presence === "object" ? body.presence : {};
				// what someone has selected is held for them: a free shape becomes theirs, someone else's stays
				const wanted = new Set((Array.isArray(presence.selected) ? presence.selected : []).filter((k) => typeof k === "string" && k.length <= 300).slice(0, 500));
				let changed = false;
				for (const [k, holder] of [...board.locks]) {
					if (holder === me.id && !wanted.has(k)) {
						board.locks.delete(k);
						changed = true;
					}
				}
				for (const k of wanted) {
					if (!board.locks.has(k)) {
						board.locks.set(k, me.id);
						changed = true;
					}
				}
				board.presence.set(me.id, presence);
				opened(board, { BoardPresence: { board: board.id, from: me.id, presence } }, me);
				if (changed) {
					board.lockSeq++;
					opened(board, locksOf(board));
				}
			}
		};
		socket.onclose = () => {
			if (!pad.people.delete(me.id)) return;
			for (const board of pad.boards.values()) leave(board);
			everyone({ UserInfo: { id: me.id, info: null } });
		};
	});

	await new Promise((r) => server.listen(options.port ?? 0, "127.0.0.1", r));
	const boardAt = (link) => pads.get(link.pad)?.boards.get(link.board);
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		pads,
		ended,
		board: boardAt,
		stats: (link) => {
			const b = boardAt(link);
			return b && { revision: b.revision, snapshot: b.snapshot.revision, snapshots: b.snapshots ?? 0, patches: b.patches.length, people: b.open.size, locks: Object.fromEntries(b.locks) };
		},
		close: () =>
			new Promise((r) => {
				for (const pad of pads.values()) for (const p of pad.people.values()) p.socket.close();
				server.close(() => r());
				server.closeAllConnections?.();
			}),
	};
}

module.exports = { startBoardRelay };

if (require.main === module) {
	startBoardRelay({ port: Number(process.argv[2]) || 8787 }).then((r) => console.log(`Board relay (a stand-in for an OmniPad server's boards) at ${r.url}\nPut that address in OmniDraw: File → Go Live…, OmniPad server.`));
}
