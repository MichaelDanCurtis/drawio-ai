import { apart, type ClientMessage, type DiagramPatch, type PresenceState, type ServerMessage } from "./protocol";

/**
 * One person's side of a shared diagram: what goes to the board when they change something,
 * and what is done with what arrives. docs/omnipad-boards-protocol.md has the rules; the
 * section "How changes are ordered" is what most of this file is.
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
}

export interface Person {
	id: number;
	name: string;
	hue: number;
	presence?: PresenceState;
}

export interface LiveSessionEvents {
	/** The people on the board, or where one of them is, changed. */
	people?(people: Person[]): void;
	/** The board is over, or this person was removed from it. */
	closed?(reason: string): void;
	/** This person's diagram was replaced by the board's (they joined, or had to catch up). */
	replaced?(why: "joined" | "caught-up"): void;
	/** Something that should not happen did; the session carries on. For the log, never holding a diagram's content. */
	problem?(text: string): void;
}

const SNAPSHOT_QUIET_MS = 20_000;

export class LiveSession {
	/** The last revision this person's diagram has applied (or, for their own, been told of). */
	public revision = 0;
	/** Counts the times the board sent everyone its diagram to settle a disagreement. A change says which it was made in. */
	public epoch = 0;
	public id: number | undefined;
	public role: "editor" | "viewer" = "editor";
	public owner = false;
	/** Whether the board's diagram is in the editor (true once the first `Board` has been loaded). */
	public ready = false;
	public closed: string | undefined;

	/** Own changes sent and not yet acknowledged, oldest first. */
	private pending: DiagramPatch[] = [];
	/** Since the last time nothing was pending: own changes the server put after someone else's, and those others. */
	private crossedMine: DiagramPatch[] = [];
	private crossedTheirs: DiagramPatch[] = [];
	/** Others' changes that arrived while own ones were unacknowledged (they cross, if the acknowledgement says so). */
	private arrivedWhilePending: DiagramPatch[] = [];
	/** Waiting for the board's diagram (`Board`): after joining, or after asking to catch up. */
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

	/** First words on a new connection. */
	public hello(name: string, hue: number, client: string, ownerKey?: string): void {
		this.send({ Hello: { name: name.slice(0, 60), hue: Math.round(hue) % 360, client, ...(ownerKey ? { owner: ownerKey } : {}) } });
	}

	/** The people on the board other than this one. */
	public others(): Person[] {
		return [...this.people.values()].filter((p) => p.id !== this.id);
	}

	/** Nothing of this person's is unacknowledged, held back or waiting to be put right: their diagram is in the server's order. */
	public get settled(): boolean {
		return this.ready && !this.awaitingBoard && !this.mustCatchUp && this.pending.length === 0 && this.held.length === 0;
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
		// while one of this person's was unacknowledged, and that is not put right yet)
		const sure = this.arrivedWhilePending.length === 0 && !this.mustCatchUp;
		this.sendPatch(patch, sure ? checksum : null);
	}

	private sendPatch(patch: DiagramPatch, checksum: string | null): void {
		this.send({ Patch: { base: this.revision + this.pending.length, epoch: this.epoch, patch, checksum } });
		this.pending.push(patch);
		this.touch();
	}

	/** Where this person is. (The caller keeps it to 30 a second.) */
	public localPresence(p: PresenceState): void {
		if (!this.closed) this.send({ Presence: p });
	}

	/** A message from the board. */
	public receive(msg: ServerMessage): void {
		this.work = this.work.then(() => this.handle(msg)).catch((e) => this.events.problem?.(`A message from the board could not be dealt with: ${String(e?.message ?? e).slice(0, 200)}`));
	}

	public dispose(): void {
		if (this.quiet) clearTimeout(this.quiet);
		this.closed ??= "left";
	}

	private async handle(msg: ServerMessage): Promise<void> {
		if (this.closed) return;
		if ("Identity" in msg) {
			this.id = msg.Identity.id;
			this.role = msg.Identity.role;
			this.owner = msg.Identity.owner;
		} else if ("Board" in msg) {
			await this.load(msg.Board);
		} else if ("Patch" in msg) {
			const p = msg.Patch;
			// (a change from before the diagram that is on its way: that diagram has it already)
			if (this.awaitingBoard) return;
			const checksum = await this.editor.apply(p.patch);
			this.revision = p.revision;
			if (this.pending.length > 0) {
				// made at the same moment as something of this person's that the server has not numbered yet
				this.arrivedWhilePending.push(p.patch);
			} else if (p.clean && !this.mustCatchUp && checksum !== p.checksum) {
				// this diagram is not what everyone else's is
				this.events.problem?.(`This diagram differs from the board's at revision ${p.revision}: getting the board's.`);
				this.catchUp();
			}
			this.touch();
		} else if ("Ack" in msg) {
			const mine = this.pending.shift();
			this.revision = msg.Ack.revision;
			if (mine && !msg.Ack.clean) {
				// the server put someone else's change before this one; here it was the other way round
				this.crossedMine.push(mine);
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
		} else if ("NeedSnapshot" in msg) {
			if (this.settled) await this.sendSnapshot();
			else this.snapshotWanted = true;
		} else if ("UserInfo" in msg) {
			const { id, info } = msg.UserInfo;
			if (info) this.people.set(id, { ...(this.people.get(id) ?? {}), id, name: String(info.name).slice(0, 60), hue: Number(info.hue) || 0 });
			else this.people.delete(id);
			this.events.people?.(this.others());
		} else if ("Presence" in msg) {
			const { id, ...presence } = msg.Presence;
			const who = this.people.get(id);
			if (who && id !== this.id) {
				who.presence = presence;
				this.events.people?.(this.others());
			}
		} else if ("Closed" in msg) {
			this.closed = msg.Closed.reason || "closed";
			if (this.quiet) clearTimeout(this.quiet);
			this.events.closed?.(this.closed);
		}
	}

	/** Asks for the board's diagram, to put it in place of this one. */
	private catchUp(): void {
		if (this.awaitingBoard) return;
		this.awaitingBoard = true;
		this.mustCatchUp = this.mustCatchUpWhatever = false;
		this.send({ Resync: {} });
	}

	/** The board's diagram: the snapshot, and the changes since, in the server's order. */
	private async load(board: { revision: number; epoch?: number; xml: string; checksum: string; patches: { revision: number; patch: DiagramPatch }[] }): Promise<void> {
		const first = !this.ready;
		// From here until everything held has gone out, this person's changes are held: one sent now
		// would overtake those waiting, which were made before it.
		this.awaitingBoard = true;
		const loaded = await this.editor.replace(board.xml, board.checksum);
		// (what was held up to this moment was made on the diagram that has just been replaced)
		const wiped = this.held.length;
		if (loaded !== board.checksum) this.events.problem?.("The board's diagram did not load as the board has it.");
		let revision = board.revision - board.patches.length;
		for (const p of board.patches) {
			await this.editor.apply(p.patch);
			revision = p.revision;
		}
		this.revision = Math.max(revision, board.revision);
		this.epoch = Number(board.epoch) || 0;
		// Own changes still unacknowledged when the board's diagram arrives (it was not asked for: the
		// board sent it to everyone) are not in it: the board numbers them after it. They go on top again.
		for (const patch of this.pending) await this.editor.apply(patch);
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
		// diagram is fetched once more when these have been acknowledged.
		for (let i = 0; i < this.held.length; i++) {
			const patch = this.held[i];
			if (i < wiped) await this.editor.apply(patch);
			else this.mustCatchUp = this.mustCatchUpWhatever = true;
			this.sendPatch(patch, null);
		}
		this.held.length = 0;
		this.awaitingBoard = false;
		this.events.replaced?.(first ? "joined" : "caught-up");
		if (this.snapshotWanted && this.settled) await this.sendSnapshot();
		this.touch();
	}

	private async sendSnapshot(): Promise<void> {
		this.snapshotWanted = false;
		const revision = this.revision;
		const { xml, checksum } = await this.editor.snapshot();
		// (something happened while the editor answered: this is no longer the diagram at that revision)
		if (!this.settled || this.revision !== revision || this.closed) {
			this.snapshotWanted = true;
			return;
		}
		this.lastSnapshot = revision;
		this.send({ Snapshot: { revision, xml, checksum } });
	}

	/** Something changed: the host sends the whole diagram once things have been quiet for a while. */
	private touch(): void {
		if (!this.owner || this.closed) return;
		if (this.quiet) clearTimeout(this.quiet);
		this.quiet = setTimeout(() => {
			this.work = this.work.then(async () => {
				if (this.settled && this.revision > this.lastSnapshot) await this.sendSnapshot();
			});
		}, this.options.snapshotQuietMs ?? SNAPSHOT_QUIET_MS);
		(this.quiet as any).unref?.();
	}
}
