import { boardLink, parseBoardLink, socketUrl, type BoardLink, type ClientMessage, type ServerMessage } from "./protocol";

/**
 * The board itself: the calls that make and end one, and the socket to the pad it is in. See
 * docs/omnipad-boards-protocol.md. The link and the owner key are secrets: nothing here logs
 * them, and what is reported of a failure is the server's status, never an address with an id.
 */

export class BoardError extends Error {}

/** The most of an answer that is read: what these calls are answered with is a few lines. */
const MAX_ANSWER = 1024 * 1024;

/**
 * Asks the server and reads its answer, as JSON where it is JSON (`json` is undefined where it
 * is not, or is too long to be one of these answers). The time limit covers the whole of it: a
 * server that sends its headers and then goes quiet has not answered in time either.
 */
async function call(url: string, init: RequestInit, timeoutMs = 20_000): Promise<{ status: number; ok: boolean; json: any }> {
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...init, signal: stop.signal, redirect: "error" });
		const parts: Uint8Array[] = [];
		let size = 0;
		if (res.body) {
			for await (const part of res.body as any as AsyncIterable<Uint8Array>) {
				size += part.length;
				if (size > MAX_ANSWER) {
					stop.abort();
					break;
				}
				parts.push(part);
			}
		}
		let json: any;
		if (size <= MAX_ANSWER) {
			try {
				json = JSON.parse(Buffer.concat(parts).toString("utf8"));
			} catch {
				json = undefined;
			}
		}
		return { status: res.status, ok: res.ok, json };
	} catch (e: any) {
		throw new BoardError(stop.signal.aborted ? "The OmniPad server did not answer in time." : `The OmniPad server could not be reached (${String(e?.cause?.code ?? e?.code ?? "no connection").slice(0, 40)}).`);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether a server is an OmniPad that can share diagrams, for Settings. It is asked for the
 * boards of a pad that is not there: nothing is made, changed or sent but that question.
 */
export async function checkServer(server: string, timeoutMs = 8_000): Promise<{ ok: boolean; text: string }> {
	let res: { status: number; ok: boolean; json: any };
	try {
		res = await call(`${server}/api/pads/omnidraw-check-${Math.random().toString(36).slice(2, 12)}/boards`, { method: "GET" }, timeoutMs);
	} catch (e: any) {
		return { ok: false, text: String(e?.message ?? e) };
	}
	if (res.ok) {
		if (Array.isArray(res.json)) return { ok: true, text: "This server can share diagrams." };
		return { ok: false, text: "Something answers at that address, but not as an OmniPad server does." };
	}
	if (res.status === 404 || res.status === 405) return { ok: false, text: "Something answers at that address, but it has no boards: it is not an OmniPad server that can share diagrams." };
	return { ok: false, text: `The server answered with an error (${res.status}).` };
}

/**
 * Puts a diagram on the server as a shared board: a pad of its own, holding that one board.
 * `publicLink`: the link as the server itself writes it, when it knows its public address and
 * the link is to this same board. It is what is shown and handed to others, so that a server
 * that is reached under one name and known under another gives out the name it goes by; this
 * app keeps talking to the address it was given.
 */
export async function createBoard(server: string, board: { title: string; xml: string }): Promise<{ link: BoardLink; ownerKey: string; publicLink?: string }> {
	const res = await call(`${server}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "drawio", title: board.title, content: board.xml }) });
	if (res.status === 404 || res.status === 405) throw new BoardError("That server has no boards: it is not an OmniPad that can share diagrams (yet).");
	if (res.status === 413) throw new BoardError("The diagram is too large to share.");
	// (the server lets one address start only so many in a while)
	if (res.status === 503 || res.status === 429) throw new BoardError("The OmniPad server is not taking another shared diagram from here just now. Try again in a few minutes.");
	if (!res.ok) throw new BoardError(`The OmniPad server would not make a board (${res.status}).`);
	const made: any = res.json;
	// (read through a link, so that what comes back is held to what a link may be)
	const link = typeof made?.pad === "string" && typeof made?.board === "string" ? parseBoardLink(`${server}/b/${made.pad}/${made.board}`) : undefined;
	if (!link || typeof made.owner_key !== "string" || !made.owner_key) throw new BoardError("The OmniPad server's answer was not a board.");
	const named = typeof made.link === "string" ? parseBoardLink(made.link) : undefined;
	const publicLink = named && named.pad === link.pad && named.board === link.board ? boardLink(named) : undefined;
	return { link, ownerKey: made.owner_key, ...(publicLink ? { publicLink } : {}) };
}

/** Whether a board is there to join. */
export async function boardExists(link: BoardLink): Promise<boolean> {
	const res = await call(`${link.server}/api/pads/${link.pad}/boards`, { method: "GET" });
	if (res.status === 404) return false;
	if (res.status === 401 || res.status === 403) throw new BoardError("That shared diagram is in a private pad, which OmniDraw cannot open yet.");
	if (!res.ok) throw new BoardError(`The OmniPad server would not say whether the diagram is still shared (${res.status}).`);
	const boards: any = res.json;
	return Array.isArray(boards) && boards.some((b) => b?.id === link.board);
}

/** Ends a shared board, and with it the pad it was given: everyone on it is told. Only who shared it can. */
export async function closeBoard(link: BoardLink, ownerKey: string): Promise<void> {
	// (waited for when a window closes: a server that does not answer must not hold that up for long)
	await call(`${link.server}/api/boards/${link.pad}`, { method: "DELETE", headers: { "x-board-owner": ownerKey } }, 4_000).catch(() => undefined);
}

export interface BoardSocket {
	send(msg: ClientMessage): void;
	close(): void;
}

/**
 * Opens the socket to a board's pad. `onMessage` gets what the pad says; `onEnd` is called once when
 * the connection is gone for any reason other than `close()` here.
 */
export function openBoard(link: BoardLink, handlers: { onOpen(): void; onMessage(msg: ServerMessage): void; onEnd(why: string): void }): BoardSocket {
	const ws = new WebSocket(socketUrl(link));
	let done = false;
	const end = (why: string) => {
		if (done) return;
		done = true;
		handlers.onEnd(why);
	};
	ws.addEventListener("open", () => handlers.onOpen());
	ws.addEventListener("message", (e) => {
		if (typeof e.data !== "string") return;
		let msg: ServerMessage;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		if (msg && typeof msg === "object") handlers.onMessage(msg);
	});
	ws.addEventListener("close", () => end("The connection to the board was lost."));
	ws.addEventListener("error", () => end("The board could not be reached."));
	return {
		send(msg) {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		},
		close() {
			done = true;
			try {
				ws.close();
			} catch {
				// already closed
			}
		},
	};
}
