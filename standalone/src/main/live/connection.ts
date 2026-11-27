import { parseBoardLink, socketUrl, type BoardLink, type ClientMessage, type ServerMessage } from "./protocol";

/**
 * The board itself: the calls that make and end one, and the socket to the pad it is in. See
 * docs/omnipad-boards-protocol.md. The link and the owner key are secrets: nothing here logs
 * them, and what is reported of a failure is the server's status, never an address with an id.
 */

export class BoardError extends Error {}

async function call(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: stop.signal, redirect: "error" });
	} catch (e: any) {
		throw new BoardError(stop.signal.aborted ? "The OmniPad server did not answer in time." : `The OmniPad server could not be reached (${String(e?.cause?.code ?? e?.code ?? "no connection").slice(0, 40)}).`);
	} finally {
		clearTimeout(timer);
	}
}

/** Puts a diagram on the server as a shared board: a pad of its own, holding that one board. */
export async function createBoard(server: string, board: { title: string; xml: string }): Promise<{ link: BoardLink; ownerKey: string }> {
	const res = await call(`${server}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "drawio", title: board.title, content: board.xml }) });
	if (res.status === 404 || res.status === 405) throw new BoardError("That server has no boards: it is not an OmniPad that can share diagrams (yet).");
	if (res.status === 413) throw new BoardError("The diagram is too large to share.");
	// (the server lets one address start only so many in a while)
	if (res.status === 503 || res.status === 429) throw new BoardError("The OmniPad server is not taking another shared diagram from here just now. Try again in a few minutes.");
	if (!res.ok) throw new BoardError(`The OmniPad server would not make a board (${res.status}).`);
	const made: any = await res.json().catch(() => undefined);
	// (read through a link, so that what comes back is held to what a link may be)
	const link = typeof made?.pad === "string" && typeof made?.board === "string" ? parseBoardLink(`${server}/b/${made.pad}/${made.board}`) : undefined;
	if (!link || typeof made.owner_key !== "string" || !made.owner_key) throw new BoardError("The OmniPad server's answer was not a board.");
	return { link, ownerKey: made.owner_key };
}

/** Whether a board is there to join. */
export async function boardExists(link: BoardLink): Promise<boolean> {
	const res = await call(`${link.server}/api/pads/${link.pad}/boards`, { method: "GET" });
	if (res.status === 404) return false;
	if (res.status === 401 || res.status === 403) throw new BoardError("That shared diagram is in a private pad, which OmniDraw cannot open yet.");
	if (!res.ok) throw new BoardError(`The OmniPad server would not say whether the diagram is still shared (${res.status}).`);
	const boards: any = await res.json().catch(() => undefined);
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
