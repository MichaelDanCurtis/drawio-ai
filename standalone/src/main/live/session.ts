import { apart, wireChecksum, type ClientMessage, type DiagramPatch, type PresenceState, type ServerMessage } from "./protocol";

/**
 * One person's side of a shared diagram: what goes to the board when they change something,
 * and what is done with what arrives. The protocol is OmniPad's (its
 * packages/board-sync/PROTOCOL.md); docs/omnipad-boards-protocol.md says what OmniDraw does
 * with it, and "How changes are ordered" there is what most of this file is.
 *
 * It knows nothing of draw.io or of sockets: the diagram is behind `LiveEditor`, the board
 * behind `send`. That is what lets it be tested without either.
 */

/** The diagram this person has open, as the session needs it. */
export interface LiveEditor {
	/**
	 * Puts this diagram in place of the one that is there (not merged with it). Resolves with its
	 * checksum; `expected` is the checksum it should have, for an editor that can try harder.
	 */
	replace(xml: string, expected?: string): Promise<string>;
	/** Applies someone's change. Resolves with the checksum of the diagram after it. */
	apply(patch: DiagramPatch): Promise<string>;
	/** The whole diagram and its checksum, now. */
	snapshot(): Promise<{ xml: string; checksum: string }>;
	/**
	 * An editor that can work out a diagram from a whole one and the changes since, without
	 * touching the one that is open. The board's diagram then goes in as one diagram, and only
	 * what differs from the open one changes (rather than the snapshot going in and every change
	 * since being made again, which takes shapes out and puts them back).
	 */
	compose?(xml: string, patches: DiagramPatch[]): Promise<{ xml: string; checksum: string }>;
	/**
	 * The board's diagram is about to be put in place, with this person's own changes going back
	 * on top (true), or all of that is done (false). In between, the diagram is not what it will be.
	 */
	loading?(on: boolean): void;
}

export interface Person {
	id: number;
	name: string;
	hue: number;
	presence?: Partial<PresenceState>;
}

export interface LiveSessionEvents {
	/** The people on the board, or where one of them is, changed. */
	people?(people: Person[]): void;
	/** The board is over, or this person was removed from it. */
	closed?(reason: string): void;
	/** This person's diagram was replaced by the board's (they joined, or had to catch up). */
	replaced?(why: "joined" | "caught-up"): void;
	/**
	 * The board refused a change of this person's: it, and whatever they did in the moment after
	 * it, is undone by the board's diagram that follows. `keys`: the shapes someone else holds.
	 */
	refused?(reason: string, keys: string[]): void;
	/** Who holds which shape (`<page>/<cell>` to their id) changed. */
	locks?(locks: Record<string, number>): void;
	/** Something that should not happen did; the session carries on. For the log, never holding a diagram's content. */
	problem?(text: string): void;
}

const SNAPSHOT_QUIET_MS = 3_000;

export class LiveSession {
	/** The board this is a session on (its id in the pad), once `hello` has said. */
	public board = "";
	/** The last revision this person's diagram has applied (or, for their own, been told of). */
	public revision = 0;
	/**
	 * This connection's count of the times it started over on the board (opening it, a refusal).
	 * A change says which it was made in; the server drops those from an earlier one.
	 */
	public epoch = 0;
	public id: number | undefined;
	public role: "editor" | "viewer" = "editor";
	/** Whether the board's diagram is in the editor (true once the first one has been loaded). */
	public ready = false;
	public closed: string | undefined;
	/** Who holds which shape, as the board last said. */
	public locks: Record<string, number> = {};

	/** Own changes sent and not yet numbered by the board, oldest first. `crossed`: someone else's change arrived since, so the board put that one first. */
	private pending: { patch: DiagramPatch; crossed: boolean }[] = [];
	/** Since the last time nothing was pending: own changes the server put after someone else's, and those others. */
	private crossedMine: DiagramPatch[] = [];
	private crossedTheirs: DiagramPatch[] = [];
	/** Others' changes that arrived while own ones were unnumbered. */
	private arrivedWhilePending: DiagramPatch[] = [];
	/** Waiting for the board's diagram: after opening the board, asking to catch up, or a refusal. */
	private awaitingBoard = true;
	private mustCatchUp = false;
	/** With mustCatchUp: whatever the crossed changes touched (this person changed something while the board's diagram was going in). */
	private mustCatchUpWhatever = false;
	/**
	 * Own changes made while the board's diagram is awaited or being put in place: sent, in the
	 * order they were made, once it is in. The ones made before it replaced this diagram were
	 * wiped by that and are applied on top again first.
	 */
	private held: DiagramPatch[] = [];
	private snapshotWanted = false;
	private lastSnapshot = 0;
	private lockSeq = -1;
	private quiet: ReturnType<typeof setTimeout> | undefined;
	private readonly people = new Map<number, Person>();
	/** What arrives is dealt with one message at a time, in order: the editor's answers take a moment. */
	private work: Promise<void> = Promise.resolve();

	public constructor(
		private readonly editor: LiveEditor,
		private readonly send: (msg: ClientMessage) => void,
		private readonly events: LiveSessionEvents = {},
		private readonly options: { snapshotQuietMs?: number } = {}
	) {}

	/** First words on a new connection to the pad: who this is, and which of its boards is wanted. */
	public hello(board: string, name: string, hue: number): void {
		this.board = board;
		this.send({ ClientInfo: { name: name.slice(0, 60), hue: ((Math.round(hue) % 360) + 360) % 360 } });
		// (the list comes back even when it is empty: a board that is not in it is not there to open)
		this.send({ BoardList: {} });
		this.open();
	}

	/** The people on the pad other than this one. */
	public others(): Person[] {
		return [...this.people.values()].filter((p) => p.id !== this.id);
	}

	/** Nothing of this person's is unnumbered, held back or waiting to be put right: their diagram is in the server's order. */
	public get settled(): boolean {
		return this.ready && !this.awaitingBoard && !this.mustCatchUp && this.pending.length === 0 && this.held.length === 0;
	}

	/** How many of this person's changes the board has not confirmed: held back here, or sent and not yet numbered. */
	public get unsent(): number {
		return this.closed ? 0 : this.held.length + this.pending.length;
	}

	/** How many of this person's changes are held back (the board's diagram is awaited or going in). */
	public get heldCount(): number {
		return this.held.length;
	}

	/**
	 * Forgets the first `count` held changes: they are in the diagram the board starts from (the
	 * host made them while the diagram was being read to send it).
	 */
	public forgetHeld(count: number): void {
		this.held.splice(0, count);
	}

	/** Resolves when everything that has arrived so far has been dealt with. */
	public idle(): Promise<void> {
		return this.work;
	}

	/** This person changed their diagram. */
	public localPatch(patch: DiagramPatch, checksum: string): void {
		if (this.closed || this.role === "viewer") return;
		if (this.awaitingBoard) {
			// (the board's diagram is on its way or going in: the change is sent after that, in its turn)
			this.held.push(patch);
			return;
		}
		// (no checksum while this diagram may not be in the server's order: someone else's change arrived
		// while one of this person's was unnumbered, and that is not put right yet)
		const sure = this.arrivedWhilePending.length === 0 && !this.mustCatchUp;
		this.sendPatch(patch, sure ? checksum : null);
	}

	private sendPatch(patch: DiagramPatch, checksum: string | null): void {
		// (the revision this diagram will be at once everything sent so far is in)
		const base = this.revision + this.pending.length;
		this.send({ BoardPatch: { board: this.board, base, epoch: this.epoch, patch, ...(checksum === null ? {} : { checksum: wireChecksum(checksum) }) } });
		this.pending.push({ patch, crossed: false });
		this.touch();
	}

	/** Where this person is, and what they have selected. (The caller keeps it to 30 a second.) */
	public localPresence(p: PresenceState): void {
		if (!this.closed && this.ready) this.send({ BoardPresence: { board: this.board, presence: p } });
	}

	/** A message from the pad. */
	public receive(msg: ServerMessage): void {
		this.work = this.work
			.then(() => this.handle(msg))
			.catch((e) => {
				this.events.problem?.(`A message from the board could not be dealt with: ${String(e?.message ?? e).slice(0, 200)}`);
				if (this.closed) return;
				if ("BoardState" in msg) {
					// The board's diagram did not go in: this window has neither that nor a diagram it can
					// vouch for. Carrying on would hold every change back for good.
					this.end("failed");
				} else if ("BoardPatch" in msg) {
					// someone's change did not go in: this diagram lacks it, so the board's is fetched
					this.revision = Math.max(this.revision, Number(msg.BoardPatch.revision) || 0);
					this.mustCatchUp = this.mustCatchUpWhatever = true;
					if (this.pending.length === 0) this.catchUp();
				}
			});
	}

	public dispose(): void {
		if (this.quiet) clearTimeout(this.quiet);
		this.closed ??= "left";
	}

	private end(reason: string): void {
		this.closed = reason;
		if (this.quiet) clearTimeout(this.quiet);
		this.events.closed?.(reason);
	}

	private async handle(msg: ServerMessage): Promise<void> {
		if (this.closed || !msg || typeof msg !== "object") return;
		// the pad's own
		if ("Identity" in msg) {
			if (typeof msg.Identity === "number") this.id = msg.Identity;
			return;
		}
		if ("UserInfo" in msg) {
			const { id, info } = msg.UserInfo;
			if (info) this.people.set(id, { ...(this.people.get(id) ?? {}), id, name: String(info.name ?? "").slice(0, 60) || "Someone", hue: Number(info.hue) || 0 });
			else this.people.delete(id);
			this.events.people?.(this.others());
			return;
		}
		if ("Boards" in msg) {
			// The pad's boards, sent when asked for and whenever the list changes. This one no longer
			// being in it is how its end is told: whoever shared it stopped, or the server cleared it.
			if (this.board && Array.isArray(msg.Boards) && !msg.Boards.some((b) => b?.id === this.board)) this.end("gone");
			return;
		}
		if ("Idle" in msg) return this.end("idle");
		if ("BoardError" in msg) {
			this.events.problem?.(`The board could not do something that was asked of it: ${String(msg.BoardError?.message ?? "").slice(0, 200)}`);
			return;
		}
		// this board's (a pad can hold others; and the pad's text is not this session's business)
		const about = (m: { board?: string } | undefined) => !!m && m.board === this.board;
		if ("BoardState" in msg) {
			if (about(msg.BoardState)) await this.load(msg.BoardState);
		} else if ("BoardPatch" in msg) {
			if (about(msg.BoardPatch)) await this.numbered(msg.BoardPatch);
		} else if ("BoardRejected" in msg) {
			if (!about(msg.BoardRejected)) return;
			const reason = String(msg.BoardRejected.reason ?? "");
			// The refused change, and everything sent since, was made in an epoch the server has closed:
			// it drops them without a word, and its diagram follows. What this person does until that
			// is in is held, and goes on top of it.
			this.epoch += 1;
			this.pending.length = 0;
			this.arrivedWhilePending.length = 0;
			this.crossedMine.length = 0;
			this.crossedTheirs.length = 0;
			this.mustCatchUp = this.mustCatchUpWhatever = false;
			this.awaitingBoard = true;
			if (reason === "read-only") this.role = "viewer";
			// (too many changes since the board last had the whole diagram: it wants one)
			if (reason === "busy") this.snapshotWanted = true;
			const keys = Array.isArray(msg.BoardRejected.keys) ? msg.BoardRejected.keys.filter((k) => typeof k === "string").slice(0, 500) : [];
			this.events.refused?.(reason, keys);
		} else if ("BoardLocks" in msg) {
			if (!about(msg.BoardLocks)) return;
			const { seq, locks } = msg.BoardLocks;
			// (an answer can overtake an older list sent to everyone: the newest counts)
			if (typeof seq === "number" && seq < this.lockSeq) return;
			this.lockSeq = Number(seq) || 0;
			this.locks = locks && typeof locks === "object" ? locks : {};
			this.events.locks?.(this.locks);
		} else if ("BoardWantSnapshot" in msg) {
			if (!about(msg.BoardWantSnapshot)) return;
			if (this.settled) await this.sendSnapshot();
			else this.snapshotWanted = true;
		} else if ("BoardPresence" in msg) {
			if (!about(msg.BoardPresence)) return;
			const { from, presence } = msg.BoardPresence;
			if (from === this.id) return;
			let who = this.people.get(from);
			if (!presence) {
				// (they closed the board, or left)
				if (who) delete who.presence;
			} else {
				// (someone the pad has not introduced yet says who they are with where they are)
				if (!who) this.people.set(from, (who = { id: from, name: String(presence.name ?? "").slice(0, 60) || "Someone", hue: Number(presence.hue) || 0 }));
				who.presence = presence;
			}
			this.events.people?.(this.others());
		}
	}

	/** A change the board has numbered: someone else's, or this person's own coming back as its receipt. */
	private async numbered(p: { revision: number; from: number; patch: DiagramPatch; checksum?: number | string | null }): Promise<void> {
		if (p.from === this.id) {
			const mine = this.pending.shift();
			// (a receipt for something sent before the board's diagram was asked for: that diagram has it)
			if (this.awaitingBoard) return;
			if (p.revision !== this.revision + 1) return this.missed(p.revision);
			this.revision = p.revision;
			if (mine?.crossed) {
				// the server put someone else's change before this one; here it was the other way round
				this.crossedMine.push(mine.patch);
				this.crossedTheirs.push(...this.arrivedWhilePending.splice(0));
				this.mustCatchUp = true;
			}
			if (this.pending.length === 0) {
				this.arrivedWhilePending.length = 0;
				if (this.mustCatchUp) {
					// (changes to different cells give the same diagram in either order: nothing to put right)
					if (!this.mustCatchUpWhatever && apart(this.crossedMine, this.crossedTheirs)) this.mustCatchUp = false;
					this.crossedMine.length = 0;
					this.crossedTheirs.length = 0;
					if (this.mustCatchUp) this.catchUp();
				}
				if (this.snapshotWanted && this.settled) await this.sendSnapshot();
			}
			this.touch();
			return;
		}
		// (a change from before the diagram that is on its way: that diagram has it already)
		if (this.awaitingBoard || p.revision <= this.revision) return;
		if (p.revision !== this.revision + 1) return this.missed(p.revision);
		const checksum = await this.editor.apply(p.patch);
		this.revision = p.revision;
		if (this.pending.length > 0) {
			// Made at the same moment as something of this person's that the server has not numbered
			// yet: it comes before all of that in the server's order, and after it here. No checksum
			// is compared: this diagram also holds what is still unnumbered.
			for (const mine of this.pending) mine.crossed = true;
			this.arrivedWhilePending.push(p.patch);
		} else if (p.checksum !== undefined && p.checksum !== null && !this.mustCatchUp && checksum !== String(p.checksum)) {
			// this diagram is not what everyone else's is
			this.events.problem?.(`This diagram differs from the board's at revision ${p.revision}: getting the board's.`);
			this.catchUp();
		}
		this.touch();
	}

	/** A revision went by that never arrived here. */
	private missed(revision: number): void {
		this.events.problem?.(`Revision ${this.revision + 1} of the board never arrived (the next was ${revision}): getting the board's diagram.`);
		this.catchUp();
	}

	/** (Re)opens the board: its diagram comes back, to take this one's place. A new epoch starts with it. */
	private open(): void {
		this.awaitingBoard = true;
		this.mustCatchUp = this.mustCatchUpWhatever = false;
		this.epoch += 1;
		this.send({ BoardOpen: { board: this.board, epoch: this.epoch } });
	}

	/** Asks for the board's diagram, to put it in place of this one. */
	private catchUp(): void {
		if (this.awaitingBoard) return;
		this.open();
	}

	/** The board's diagram: the whole one it keeps, and the changes since, in the server's order. */
	private async load(board: { revision: number; content: string; patches: { revision: number; patch: DiagramPatch }[] }): Promise<void> {
		const first = !this.ready;
		// From here until everything held has gone out, this person's changes are held: one sent now
		// would overtake those waiting, which were made before it.
		this.awaitingBoard = true;
		this.editor.loading?.(true);
		try {
			await this.put(board);
		} finally {
			this.editor.loading?.(false);
		}
		if (this.closed) return;
		this.events.replaced?.(first ? "joined" : "caught-up");
		if (this.snapshotWanted && this.settled) await this.sendSnapshot();
		this.touch();
	}

	private async put(board: { revision: number; content: string; patches: { revision: number; patch: DiagramPatch }[] }): Promise<void> {
		const patches = Array.isArray(board.patches) ? board.patches : [];
		// The board's diagram: its whole one with the changes since. Worked out first where the editor
		// can, so that it goes in as one diagram, and so that what it should come to is known.
		let whole: { xml: string; checksum?: string } = { xml: String(board.content ?? "") };
		let after = patches;
		if (this.editor.compose) {
			whole = await this.editor.compose(whole.xml, after.map((p) => p.patch));
			after = [];
		}
		// (the session ended while that was being worked out: the editor is no longer its to change)
		if (this.closed) return;
		const loaded = await this.editor.replace(whole.xml, whole.checksum);
		if (this.closed) return;
		// (what was held up to this moment was made on the diagram that has just been replaced)
		const wiped = this.held.length;
		if (whole.checksum !== undefined && loaded !== whole.checksum) this.events.problem?.("The board's diagram did not load as the board has it.");
		for (const p of after) {
			if (this.closed) return;
			await this.editor.apply(p.patch);
		}
		if (this.closed) return;
		this.revision = Number(board.revision) || 0;
		// Own changes still unnumbered when a board's diagram arrives (a second one, sent because this
		// connection's opening of the board crossed the server's answer to a refusal) are not in it:
		// the board numbers them after it. They go on top again.
		for (const mine of this.pending) {
			if (this.closed) return;
			await this.editor.apply(mine.patch);
			mine.crossed = false;
		}
		this.arrivedWhilePending.length = 0;
		this.crossedMine.length = 0;
		this.crossedTheirs.length = 0;
		this.mustCatchUp = this.mustCatchUpWhatever = false;
		this.ready = true;
		// What this person did meanwhile, in the order they did it: the changes the replacing wiped go
		// on top again, the ones made since are in the diagram already; all are sent. None carries a
		// checksum: the diagram at each of them is not the diagram once all of them are in.
		//
		// A change made while all this was going in sits somewhere among what was applied around it,
		// which need not be where the board puts it (last). Rather than work out where, the board's
		// diagram is fetched once more when these have been numbered.
		for (let i = 0; i < this.held.length; i++) {
			const patch = this.held[i];
			if (this.closed) return;
			if (i < wiped) await this.editor.apply(patch);
			else this.mustCatchUp = this.mustCatchUpWhatever = true;
			if (this.role !== "viewer") this.sendPatch(patch, null);
		}
		this.held.length = 0;
		this.awaitingBoard = false;
	}

	private async sendSnapshot(): Promise<void> {
		this.snapshotWanted = false;
		if (this.role === "viewer") return;
		const { revision, epoch } = this;
		let xml: string;
		try {
			({ xml } = await this.editor.snapshot());
		} catch (e: any) {
			// The editor did not give the diagram this time. Nothing else depends on it: the board goes
			// on with the whole diagram it has, and it is tried again when things are next quiet or settled.
			this.events.problem?.(`The diagram could not be read for the board: ${String(e?.message ?? e).slice(0, 200)}`);
			this.snapshotWanted = true;
			return;
		}
		// (something happened while the editor answered: this is no longer the diagram at that revision)
		if (!this.settled || this.revision !== revision || this.epoch !== epoch || this.closed) {
			this.snapshotWanted = true;
			return;
		}
		this.lastSnapshot = revision;
		this.send({ BoardSnapshot: { board: this.board, revision, content: xml, epoch } });
	}

	/**
	 * Something changed: once things have been quiet for a moment, whoever is in step sends the whole
	 * diagram, so that the board's own copy (what a newcomer starts from, and what is downloaded
	 * from it) is not far behind. The board takes it from whom it can.
	 */
	private touch(): void {
		if (this.closed || this.role === "viewer") return;
		if (this.quiet) clearTimeout(this.quiet);
		// (not everyone at the same instant)
		const wait = this.options.snapshotQuietMs ?? SNAPSHOT_QUIET_MS + Math.random() * 1000;
		this.quiet = setTimeout(() => {
			// (whatever goes wrong in here stays in here: the messages queued behind it are dealt with all the same)
			this.work = this.work
				.then(async () => {
					if (this.settled && this.revision > this.lastSnapshot) await this.sendSnapshot();
				})
				.catch((e) => this.events.problem?.(`The diagram could not be sent to the board: ${String(e?.message ?? e).slice(0, 200)}`));
		}, wait);
		(this.quiet as any).unref?.();
	}
}
