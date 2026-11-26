/**
 * Go live: the messages between OmniDraw and an OmniPad board, and the link to one.
 * The protocol is written down in docs/omnipad-boards-protocol.md; this is its shape in code.
 */

/** A change as draw.io describes it (EditorUi.diffPages): passed on untouched, never read by the server. */
export type DiagramPatch = Record<string, any>;

export interface PresenceState {
	/** The page the person is on. */
	page?: string;
	/** In diagram coordinates. */
	cursor: { x: number; y: number } | null;
	selection: string[];
	rect: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
}

export interface NumberedPatch {
	revision: number;
	/** Who made it (their id on the board). */
	from: number;
	patch: DiagramPatch;
	/** The sender's checksum after the change; null when the sender could not vouch that its diagram was in the server's order. */
	checksum: string | null;
	/** Nothing of anyone else's arrived between the sender making it and the server numbering it, and it has a checksum: everyone should have that checksum at this revision. */
	clean: boolean;
}

export type ClientMessage =
	| { Hello: { name: string; hue: number; client: string; /** The key the board's maker was given, from the maker only. */ owner?: string } }
	| { Patch: { base: number; epoch: number; patch: DiagramPatch; checksum: string | null } }
	| { Snapshot: { revision: number; xml: string; checksum: string } }
	| { Presence: PresenceState }
	| { Resync: Record<string, never> };

export type ServerMessage =
	| { Identity: { id: number; role: "editor" | "viewer"; owner: boolean } }
	| { Board: { revision: number; epoch: number; xml: string; checksum: string; patches: NumberedPatch[] } }
	| { Patch: NumberedPatch }
	| { Ack: { revision: number; clean: boolean } }
	| { NeedSnapshot: Record<string, never> }
	| { UserInfo: { id: number; info: { name: string; hue: number } | null } }
	| { Presence: { id: number } & PresenceState }
	| { Closed: { reason: string } };

/** Where a board is: the OmniPad server and the board's id (which, in a version 1 link, is the permission). */
export interface BoardLink {
	/** The server's origin, https://pad.example. */
	server: string;
	id: string;
	/** An OmniPad invite code, when the board is private. */
	invite?: string;
}

const BOARD_ID = /^[A-Za-z0-9_-]{16,64}$/;
const INVITE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Reads a link to a board: https://<omnipad>/b/<boardId>[?invite=<code>]. https only, except
 * for a server on this computer (a trial, a test). Undefined when it is not one.
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
	const m = /^\/b\/([^/]+)\/?$/.exec(u.pathname);
	if (!m || !BOARD_ID.test(m[1])) return undefined;
	const invite = u.searchParams.get("invite") ?? undefined;
	if (invite !== undefined && !INVITE.test(invite)) return undefined;
	return { server: u.origin, id: m[1], ...(invite ? { invite } : {}) };
}

export function boardLink(l: BoardLink): string {
	return `${l.server}/b/${l.id}${l.invite ? `?invite=${l.invite}` : ""}`;
}

/** A server address as typed in Settings: its origin, or undefined when it is not an address a board can be on. */
export function serverOrigin(text: string): string | undefined {
	const t = text.trim();
	if (!t) return undefined;
	return parseBoardLink(`${/^[a-z]+:\/\//i.test(t) ? t.replace(/\/+$/, "") : `https://${t.replace(/\/+$/, "")}`}/b/${"0".repeat(22)}`)?.server;
}

export function socketUrl(l: BoardLink, ticket?: string): string {
	return `${l.server.replace(/^http/, "ws")}/api/boards/${l.id}/socket${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`;
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
