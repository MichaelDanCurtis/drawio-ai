import type { CustomizedDrawioClient } from "../../../../src/DrawioClient";
import { BoardError, closeBoard, createBoard, openBoard, type BoardSocket } from "./connection";
import { boardLink, type BoardLink, type DiagramPatch, type PresenceState } from "./protocol";
import { LiveSession, type LiveEditor, type Person } from "./session";

/**
 * A diagram window that is live: its editor joined to a board. The session (session.ts) has
 * the rules; this gives it draw.io to work on (diff sync, see DrawioClient.resetDiff) and the
 * socket, and carries pointers and selections both ways.
 */

/** What a live diagram needs of the window it is in. */
export interface LiveWindow {
	client: CustomizedDrawioClient;
	/** The diagram changed through someone else's doing. */
	remoteChanged(): void;
	/** Who is here, or whether it is still live, changed. */
	changed(): void;
	/** For the app's log: never a link, a key or anything of the diagram. */
	log(text: string): void;
}

export type LiveStatus = "connecting" | "live" | "ended";

const CLIENT = "omnidraw/1";
const PRESENCE_MS = 34;

/** A colour for a person, from the hue they came with: readable on paper and on black. */
export function personColor(hue: number): string {
	return `hsl(${((Math.round(hue) % 360) + 360) % 360} 72% 46%)`;
}

/** A hue from a name, so that the same person tends to get the same colour. */
export function hueOf(name: string): number {
	let h = 0;
	for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 360;
	return h;
}

/** draw.io behind what the session asks of an editor. */
class DrawioEditor implements LiveEditor {
	/** While a diagram is being put in place: what draw.io reports as changes then is that, not the user. */
	public replacing = false;
	/** How often a diagram had to be loaded from scratch because merging it in did not give it (it should not happen). */
	public fullLoads = 0;

	public constructor(private readonly client: CustomizedDrawioClient, private readonly remoteChanged: () => void) {}

	/** Turns diff sync on for the open diagram and makes it the state changes are counted from. Its checksum. */
	public async start(): Promise<string> {
		this.client.setDiffSync(true);
		return this.client.resetDiff();
	}

	public stop(): void {
		this.client.setDiffSync(false);
		this.client.updateLiveshareViewState({ cursors: [], selectedCells: [], selectedRectangles: [] });
	}

	public async replace(xml: string, expected?: string): Promise<string> {
		// The diagram is locked while another takes its place. What draw.io reports as changes until
		// the lock has taken hold is still the user's (it is passed on, and put on top again by the
		// session); what it reports from then until the new diagram is in is the replacing itself.
		await this.client.liveLock(true);
		this.replacing = true;
		try {
			// draw.io merges the diagram into the open one, which gives exactly that diagram unless the
			// open one had drifted in a way a merge does not undo: then it is loaded from scratch.
			let checksum = await this.client.resetDiff(xml);
			if (expected !== undefined && checksum !== expected) {
				this.fullLoads++;
				await this.client.loadXmlLike(xml);
				// (a diagram loaded from scratch can be changed again: locked once more until it is the starting point)
				await this.client.liveLock(true);
				checksum = await this.start();
			}
			this.remoteChanged();
			return checksum;
		} finally {
			this.replacing = false;
			void this.client.liveLock(false);
		}
	}

	public compose(xml: string, patches: DiagramPatch[]): Promise<{ xml: string; checksum: string }> {
		return this.client.liveCompose(xml, patches);
	}

	public loading(on: boolean): void {
		this.client.liveLoading(on);
	}

	public async apply(patch: DiagramPatch): Promise<string> {
		const checksum = await this.client.applyPatch(patch);
		this.remoteChanged();
		return checksum;
	}

	public async snapshot(): Promise<{ xml: string; checksum: string }> {
		const xml = await this.client.getXml();
		return { xml, checksum: await this.client.diffChecksum() };
	}
}

export class LiveShare {
	public status: LiveStatus = "connecting";
	/** The name this person is here under. */
	public me = "";
	/** Why it ended, in words for the person. */
	public ended: string | undefined;
	public readonly session: LiveSession;
	private readonly editor: DrawioEditor;
	private socket: BoardSocket | undefined;
	private readonly subscriptions: { dispose(): void }[] = [];
	private presence: PresenceState = { cursor: null, selection: [], rect: null };
	/** The page this person has in front of them (its id), once the editor has said. */
	private page: string | undefined;
	private presenceTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	/** Where the board is. (A host's is known once the server has made it.) */
	public link!: BoardLink;
	private ownerKey: string | undefined;

	private constructor(private readonly win: LiveWindow, public readonly role: "host" | "guest") {
		this.editor = new DrawioEditor(win.client, () => win.remoteChanged());
		this.session = new LiveSession(this.editor, (m) => this.socket?.send(m), {
			people: () => this.showPeople(),
			closed: (reason) =>
				this.end(
					reason === "host"
						? "The host stopped sharing."
						: reason === "expired"
						? "The shared diagram expired."
						: reason === "removed"
						? "You were removed from the shared diagram."
						: reason === "failed"
						? "The shared diagram could not be loaded into this window, so sharing stopped here."
						: "The shared diagram was closed."
				),
			replaced: () => win.changed(),
			problem: (text) => win.log(`live: ${text}`),
		});
		// The user's changes go to the session from the first moment: what they do while sharing is
		// still starting (the diagram being sent, the connection being made) is held there and goes
		// out once the board's diagram is in. (What draw.io reports while a diagram is being put in
		// place is that, not the user.)
		this.subscriptions.push(
			win.client.onPatch.sub(({ patch, checksum }) => {
				if (!this.editor.replacing) this.session.localPatch(patch, checksum);
			}),
			// Which page this person is on: sent with where they are, and others are only drawn on theirs.
			win.client.onLivePage.sub(({ page }) => {
				this.page = page || undefined;
				this.present({ page: this.page });
				this.showPeople();
			}),
			// The editor's page was loaded anew (Reload Editor): it holds the file again, not the diagram
			// at the session's revision, and reports no changes. Sharing cannot go on from that.
			win.client.onInit.sub(() => this.end("The editor was reloaded, so sharing stopped in this window. Go live again to share it."))
		);
	}

	/** The link to give to others. A secret: whoever has it can edit. */
	public get url(): string {
		return boardLink(this.link);
	}

	public people(): Person[] {
		return this.session.others();
	}

	/** How often the board's diagram had to be loaded from scratch instead of merged in (tests watch that it is not). */
	public get fullLoads(): number {
		return this.editor.fullLoads;
	}

	/** Puts the window's diagram on the server as a board and joins it as its host. */
	public static async host(win: LiveWindow, server: string, who: { name: string; title: string }): Promise<LiveShare> {
		const live = new LiveShare(win, "host");
		try {
			// (the editor first: a diagram that cannot be shared should not leave a board behind)
			try {
				await live.editor.start();
			} catch (e) {
				win.log(`live: diff sync did not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
				throw new BoardError("This diagram's editor cannot share (it did not turn on draw.io's diff sync). Reload the window and try again.");
			}
			// The diagram the board starts from. A change made while it is being read may or may not be
			// in it: it is read again until nothing changed meanwhile, so that what is held from here on
			// is exactly what it lacks.
			let snap = await live.editor.snapshot();
			for (let i = 0; i < 6; i++) {
				const held = live.session.heldCount;
				snap = await live.editor.snapshot();
				if (live.session.heldCount === held) {
					live.session.forgetHeld(held);
					break;
				}
			}
			const made = await createBoard(server, { title: who.title.slice(0, 200), xml: snap.xml, checksum: snap.checksum });
			live.link = made.link;
			live.ownerKey = made.ownerKey;
			await live.connect(who.name);
		} catch (e) {
			await live.stop();
			throw e;
		}
		return live;
	}

	/** Joins a board: its diagram takes the place of the window's. */
	public static async join(win: LiveWindow, link: BoardLink, who: { name: string }): Promise<LiveShare> {
		const live = new LiveShare(win, "guest");
		live.link = link;
		try {
			await live.editor.start();
			// (what was in the window is replaced by the board's diagram, not sent to it)
			live.session.forgetHeld(live.session.heldCount);
			await live.connect(who.name);
		} catch (e) {
			await live.stop();
			throw e instanceof BoardError ? e : new BoardError(String((e as Error)?.message ?? e));
		}
		return live;
	}

	/**
	 * Waits until the board has all of this person's changes, for at most `ms`. False when some
	 * still have not reached it then (a slow connection, a diagram on its way in).
	 */
	public async shared(ms: number): Promise<boolean> {
		const end = Date.now() + ms;
		for (;;) {
			await this.session.idle();
			if (this.status !== "live" || this.session.unsent === 0) return this.status !== "live" || this.session.unsent === 0;
			if (Date.now() >= end) return false;
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** Leaves; the host's leaving ends the board for everyone. */
	public async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.status = "ended";
		this.ended ??= this.role === "host" ? "You stopped sharing." : "You left the shared diagram.";
		for (const s of this.subscriptions.splice(0)) s.dispose();
		if (this.presenceTimer) clearTimeout(this.presenceTimer);
		this.session.dispose();
		this.socket?.close();
		// The editor is let go of at once, before anything is waited for: by the time the server has
		// answered, the diagram may be shared anew, and that sharing's editor is this same one.
		try {
			this.editor.stop();
		} catch {
			// the window is gone
		}
		if (this.role === "host" && this.ownerKey && this.link) await closeBoard(this.link, this.ownerKey);
		this.win.changed();
	}

	private end(why: string): void {
		if (this.stopped) return;
		this.ended = why;
		void this.stop();
	}

	private connect(name: string): Promise<void> {
		this.me = name || "Someone";
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => fail(new BoardError("The shared diagram did not arrive in time.")), 30_000);
			const fail = (e: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(e);
			};
			this.socket = openBoard(this.link, {
				onOpen: () => this.session.hello(name || "Someone", hueOf(name || String(Math.random())), CLIENT, this.ownerKey),
				onMessage: (msg) => {
					this.session.receive(msg);
					if (!settled && "Board" in msg) {
						// (the diagram is in once the session has dealt with it)
						void this.session.idle().then(() => {
							if (settled) return;
							// (it arrived and could not be put in place: that is not being live)
							if (!this.session.ready) return fail(new BoardError("The shared diagram arrived but could not be loaded into this window."));
							settled = true;
							clearTimeout(timer);
							this.status = "live";
							this.wire();
							this.win.changed();
							resolve();
						});
					}
				},
				onEnd: (why) => {
					fail(new BoardError(why));
					this.end(why);
				},
			});
		});
	}

	/** The user's pointer and selection go to the board from here on. */
	private wire(): void {
		const c = this.win.client;
		this.subscriptions.push(
			c.onCursorChanged.sub(({ newPosition }) => this.present({ cursor: newPosition ?? null })),
			c.onSelectedCellsChanged.sub(({ selectedCellIds }) => this.present({ selection: selectedCellIds.slice(0, 500) })),
			c.onSelectedRectangleChanged.sub(({ rectangle }) => this.present({ rect: rectangle ?? null })),
			c.onFocusChanged.sub(({ hasFocus }) => !hasFocus && this.present({ cursor: null, rect: null }))
		);
	}

	private present(change: Partial<PresenceState>): void {
		this.presence = { ...this.presence, ...change };
		if (this.presenceTimer) return;
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = undefined;
			if (this.status === "live") this.session.localPresence(this.presence);
		}, PRESENCE_MS);
	}

	/** Draws the others' pointers, selections and selection rectangles in the editor. */
	private showPeople(): void {
		// (someone on another page of the diagram is here, but not on what this person is looking at)
		const people = this.session.others().filter((p) => !p.presence?.page || !this.page || p.presence.page === this.page);
		const id = (p: Person) => String(p.id);
		this.win.client.updateLiveshareViewState({
			cursors: people.filter((p) => p.presence?.cursor).map((p) => ({ id: id(p), position: p.presence!.cursor!, label: p.name, color: personColor(p.hue) })),
			selectedCells: people.filter((p) => p.presence?.selection?.length).map((p) => ({ id: id(p), color: personColor(p.hue), selectedCellIds: p.presence!.selection })),
			selectedRectangles: people.filter((p) => p.presence?.rect).map((p) => ({ id: id(p), color: personColor(p.hue), rectangle: p.presence!.rect! })),
		});
		this.win.changed();
	}
}
