/**
 * Go live: the messages between OmniDraw and a board on an OmniPad server, and the link to one.
 *
 * The protocol is OmniPad's: its packages/board-sync/PROTOCOL.md is the reference, and
 * docs/omnipad-boards-protocol.md here says what OmniDraw does with it. A board lives in a pad
 * and is reached over the pad's own socket, so some of what arrives is about the pad (who is
 * there) or about things OmniDraw has no part in (the pad's text): those are left alone.
 */

/** A change as draw.io describes it (EditorUi.diffPages): passed on untouched, read by the server only for which shapes it touches. */
export type DiagramPatch = Record<string, any>;

/** draw.io's checksum of a diagram: a number on the wire. (Anything else is passed on as it came.) */
export type Checksum = number | string;

export interface PresenceState {
	name?: string;
	hue?: number;
	/** The page the person is on. */
	page?: string;
	/** In diagram coordinates. */
	cursor: { x: number; y: number } | null;
	/** The shapes the person has selected, as `<page>/<cell>`: the server holds them for that person while they are. */
	selected: string[];
	/** The selection rectangle being dragged. */
	rect: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
}

export interface NumberedPatch {
	revision: number;
	/** Who made it (their connection's id on the pad). */
	from: number;
	patch: DiagramPatch;
	/** The sender's checksum after the change. Only there when the change was made on the latest revision: everyone in step has that checksum at this revision. */
	checksum?: Checksum | null;
}

export type ClientMessage =
	| { ClientInfo: { name: string; hue: number } }
	| { BoardList: Record<string, never> }
	| { BoardOpen: { board: string; epoch: number } }
	| { BoardClose: { board: string } }
	| { BoardPatch: { board: string; base: number; epoch: number; patch: DiagramPatch; checksum?: Checksum } }
	| { BoardSnapshot: { board: string; revision: number; content: string; epoch: number } }
	| { BoardPresence: { board: string; presence: PresenceState } };

export type ServerMessage =
	| { Identity: number }
	| { UserInfo: { id: number; info: { name: string; hue: number } | null } }
	| { Boards: { id: string }[] }
	| { BoardState: { board: string; revision: number; base: number; content: string; patches: NumberedPatch[] } }
	| { BoardPatch: { board: string } & NumberedPatch }
	| { BoardRejected: { board: string; reason: string; keys?: string[] } }
	| { BoardPresence: { board: string; from: number; presence: Partial<PresenceState> | null } }
	| { BoardLocks: { board: string; seq: number; locks: Record<string, number> } }
	| { BoardWantSnapshot: { board: string } }
	| { BoardError: { message: string } }
	| { Idle: Record<string, never> };

/** Where a shared diagram is: the OmniPad server, the pad it is in and its id there. For a diagram shared with Go live the pad's id is the permission. */
export interface BoardLink {
	/** The server's origin, https://pad.example. */
	server: string;
	pad: string;
	board: string;
}

// (a pad made for a shared diagram has a 22-character id; a board found in someone's own pad has whatever id that pad has)
const PAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_ID = /^[a-z0-9]{4,32}$/;

/**
 * Reads a link to a shared diagram: https://<omnipad>/b/<pad>/<board>, or the address the
 * browser shows once that link has opened, https://<omnipad>/?pad=<pad>&board=<board>. https
 * only, except for a server on this computer (a trial, a test). Undefined when it is not one.
 */
export function parseBoardLink(text: string): BoardLink | undefined {
	const t = text.trim();
	if (!t || t.length > 600 || /\s/.test(t)) return undefined;
	let u: URL;
	try {
		u = new URL(t);
	} catch {
		return undefined;
	}
	const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
	if (u.username || u.password) return undefined;
	const m = /^\/b\/([^/]+)\/([^/]+)\/?$/.exec(u.pathname);
	const pad = m ? m[1] : u.pathname === "/" ? u.searchParams.get("pad") : null;
	const board = m ? m[2] : u.pathname === "/" ? u.searchParams.get("board") : null;
	if (!pad || !board || !PAD_ID.test(pad) || !BOARD_ID.test(board)) return undefined;
	return { server: u.origin, pad, board };
}

export function boardLink(l: BoardLink): string {
	return `${l.server}/b/${l.pad}/${l.board}`;
}

/** A server address as typed in Settings: its origin, or undefined when it is not an address a board can be on. */
export function serverOrigin(text: string): string | undefined {
	const t = text.trim();
	if (!t) return undefined;
	return parseBoardLink(`${/^[a-z]+:\/\//i.test(t) ? t.replace(/\/+$/, "") : `https://${t.replace(/\/+$/, "")}`}/b/pad/board`)?.server;
}

/** The pad's socket: boards have none of their own. */
export function socketUrl(l: BoardLink): string {
	return `${l.server.replace(/^http/, "ws")}/api/socket/${l.pad}`;
}

/** A checksum as the editor gives it (text), as it goes on the wire: draw.io's is a number. */
export function wireChecksum(checksum: string): Checksum {
	// (only a number that reads back as the same text: the other side compares what it was sent)
	return /^-?\d{1,15}$/.test(checksum) && String(Number(checksum)) === checksum ? Number(checksum) : checksum;
}

/** The key the server knows a shape by. */
export function lockKey(page: string, cell: string): string {
	return `${page}/${cell}`;
}

/** The cell a key names, when it is on this page. */
export function cellOn(page: string, key: string): string | undefined {
	return key.startsWith(`${page}/`) ? key.slice(page.length + 1) : undefined;
}

/**
 * What a patch touches, as keys that can be compared with another patch's: `<page>/<cell>` for
 * every cell it adds, changes or removes. Undefined when it touches more than cells (a page
 * added, removed, renamed, reordered, its settings, the file's own), or where a cell's place
 * among its siblings changes (its parent, what it comes after): such patches cannot be told
 * apart from one another by what they touch.
 */
export function touched(patch: DiagramPatch): Set<string> | undefined {
	if (!patch || typeof patch !== "object") return undefined;
	const keys = new Set<string>();
	for (const k of Object.keys(patch)) if (k !== "u") return undefined;
	const pages = patch.u;
	if (pages === undefined) return keys;
	if (!pages || typeof pages !== "object") return undefined;
	for (const [page, diff] of Object.entries<any>(pages)) {
		if (!diff || typeof diff !== "object") return undefined;
		for (const k of Object.keys(diff)) if (k !== "cells") return undefined;
		const cells = diff.cells;
		if (cells === undefined) continue;
		if (!cells || typeof cells !== "object") return undefined;
		// (a new cell has a place among its siblings, and so has a removed one for those around it)
		if (cells.i !== undefined || cells.r !== undefined) return undefined;
		for (const k of Object.keys(cells)) if (k !== "u") return undefined;
		for (const [id, change] of Object.entries<any>(cells.u ?? {})) {
			if (!change || typeof change !== "object" || "parent" in change || "previous" in change) return undefined;
			keys.add(`${page}/${id}`);
		}
	}
	return keys;
}

/** Whether two sets of patches can be applied in either order with the same result: they change different cells and nothing else. */
export function apart(mine: DiagramPatch[], theirs: DiagramPatch[]): boolean {
	const a = new Set<string>();
	for (const p of mine) {
		const t = touched(p);
		if (!t) return false;
		for (const k of t) a.add(k);
	}
	for (const p of theirs) {
		const t = touched(p);
		if (!t) return false;
		for (const k of t) if (a.has(k)) return false;
	}
	return true;
}
