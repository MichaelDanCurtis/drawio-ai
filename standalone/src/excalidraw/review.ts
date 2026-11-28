// The review of what an AI changed in an Excalidraw drawing. Its changes are in the drawing at
// once (the model can look at its own result) and stay pending until the user keeps or reverts
// them. Reverting gives every element back the state it had before the AI first touched it.
//
// This file is the bookkeeping: what each touched element was before, and what counts as a
// pending change now. It knows nothing of Excalidraw or of the page; the page applies what it
// says (src/renderer/excalidraw/ai.ts) and the tests load it as it is.
//
// As in the review of a draw.io diagram:
// - What the user changes themselves is theirs and is no part of the review, unless it is an
//   element with a pending change: that one stays pending, and reverting it gives back what it
//   was before the AI.
// - A change that is undone (Cmd/Ctrl+Z) is no longer pending; one that is then redone is again.
//
// Which lines and labels are attached to an element (`boundElements`) is left out of all of
// this: it says nothing that the lines and labels themselves do not say (a line names what it
// ends at, a label names its shape), and Excalidraw keeps it for them. An element that only had
// a line attached is not touched as far as the review goes, so what the user does to it
// meanwhile is never taken for the AI's, nor reverted. When a review is reverted the page puts
// those lists right from the lines and labels that are there then (`boundTo`).
import type { El } from "./geometry";

export interface Change {
	id: string;
	change: "added" | "changed" | "removed";
	/** The element as it is drawn: now, or before it was removed. */
	element: El;
}

export interface Summary {
	added: number;
	changed: number;
	removed: number;
}

/** What says nothing about how an element looks or what it is: it changes with every write, or follows from other elements. */
const UNSEEN = new Set(["version", "versionNonce", "updated", "index", "seed", "boundElements"]);

/** An element's content as one string: equal for two states that draw the same thing. */
export function contentKey(el: El): string {
	const keys = Object.keys(el).filter((k) => !UNSEEN.has(k)).sort();
	return JSON.stringify(keys.map((k) => [k, el[k]]));
}

const exists = (el: El | undefined | null): el is El => !!el && !el.isDeleted;
/** What an element is, there or not, as one string. */
const stateOf = (el: El | undefined | null): string => (exists(el) ? contentKey(el) : "");

/** Whether two states of an element differ in more than what is attached to it. */
export function differs(a: El | undefined | null, b: El | undefined | null): boolean {
	return stateOf(a) !== stateOf(b);
}

/**
 * What is attached to each element, read from the lines and labels themselves: a label names
 * its shape (`containerId`), an arrow names what it starts and ends at. For each element that
 * has something attached, the list as Excalidraw keeps it; an element's own order is kept where
 * `keep` has it.
 */
export function boundTo(elements: El[]): Map<string, { type: string; id: string }[]> {
	const live = elements.filter((e) => !e.isDeleted);
	const ids = new Set(live.map((e) => e.id));
	const lists = new Map<string, { type: string; id: string }[]>();
	const add = (to: unknown, bound: { type: string; id: string }) => {
		if (typeof to !== "string" || !ids.has(to)) return;
		const list = lists.get(to) ?? [];
		if (!list.some((b) => b.id === bound.id)) list.push(bound);
		lists.set(to, list);
	};
	for (const e of live) {
		if (e.type === "text") add(e.containerId, { type: "text", id: e.id });
		if (e.type === "arrow") {
			add(e.startBinding?.elementId, { type: "arrow", id: e.id });
			add(e.endBinding?.elementId, { type: "arrow", id: e.id });
		}
	}
	// (the order an element had its attachments in stays, with what is new at the end)
	for (const e of live) {
		const list = lists.get(e.id);
		if (!list || !Array.isArray(e.boundElements)) continue;
		const order = new Map<string, number>(e.boundElements.map((b: any, i: number) => [b?.id, i]));
		list.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
	}
	return lists;
}

export class ReviewLedger {
	/** What each element the AI changed was before it first did; null for one that was not there. */
	private before = new Map<string, El | null>();
	/** Every state the AI left an element in: one that is there again (after an undo and a redo) is the AI's again. */
	private left = new Map<string, Set<string>>();
	/** Elements whose change was undone: back as they were, and pending again if the change is redone. */
	private undone = new Map<string, El | null>();

	/** There are changes to keep or revert. */
	public get open(): boolean {
		return this.before.size > 0;
	}

	/** There is something to follow the drawing for: pending changes, or undone ones that may be redone. */
	public get watching(): boolean {
		return this.before.size > 0 || this.undone.size > 0;
	}

	/**
	 * The AI changed this element from `was` (undefined: it was not there) to `now`. What it was
	 * is kept the first time; what it is now is noted as the AI's doing. A change in nothing but
	 * what is attached to it is not one.
	 */
	public changed(id: string, was: El | undefined, now: El | undefined): void {
		const known = this.before.has(id) || this.undone.has(id);
		if (!known && !differs(was, now)) return;
		if (!this.before.has(id)) {
			// (one whose change was undone is as it was before the AI: that is still what it goes back to)
			const first = this.undone.has(id) ? this.undone.get(id)! : exists(was) ? structuredClone(was) : null;
			this.undone.delete(id);
			this.before.set(id, first);
		}
		const states = this.left.get(id) ?? new Set<string>();
		states.add(stateOf(now));
		this.left.set(id, states);
	}

	/**
	 * The drawing changed, by anyone: a pending change that is no longer one (it was undone, or put
	 * back by hand) is set aside, and one that was set aside and is there again (redone) is pending
	 * again. Something else done to an element that was set aside is the user's: it is forgotten here.
	 */
	public follow(current: (id: string) => El | undefined): void {
		for (const [id, was] of this.before) {
			if (differs(current(id), was)) continue;
			this.before.delete(id);
			this.undone.set(id, was);
		}
		for (const [id, was] of this.undone) {
			const now = current(id);
			if (!differs(now, was)) continue;
			this.undone.delete(id);
			if (this.left.get(id)?.has(stateOf(now))) this.before.set(id, was);
			else this.left.delete(id);
		}
	}

	/**
	 * The pending changes, as the user sees them: a shape whose label changed is one changed
	 * shape (not a text that went and one that came).
	 */
	public changes(current: (id: string) => El | undefined): Change[] {
		const found = new Map<string, Change>();
		const relabelled = new Set<string>();
		for (const [id, was] of this.before) {
			const now = current(id);
			const el = exists(now) ? now : was;
			if (!el || !differs(now, was)) continue;
			const change: Change["change"] = was === null ? "added" : exists(now) ? "changed" : "removed";
			// a label is its shape's: the shape is what changed
			if (el.type === "text" && typeof el.containerId === "string" && (current(el.containerId) || this.before.get(el.containerId))) {
				relabelled.add(el.containerId);
				continue;
			}
			found.set(id, { id, change, element: el });
		}
		for (const id of relabelled) {
			// (the label of a shape that is itself new or gone is said by the shape)
			if (found.has(id)) continue;
			const shape = current(id);
			if (exists(shape)) found.set(id, { id, change: "changed", element: shape });
		}
		return [...found.values()];
	}

	public summary(current: (id: string) => El | undefined): Summary {
		const out: Summary = { added: 0, changed: 0, removed: 0 };
		for (const c of this.changes(current)) out[c.change]++;
		return out;
	}

	/** Keeps everything: nothing is pending any more. */
	public accept(): void {
		this.before.clear();
		this.left.clear();
		this.undone.clear();
	}

	/**
	 * Reverts everything, and ends the review. Returns what to put back (each element as it was
	 * before the AI touched it) and what to take away (the elements the AI added); the page writes that.
	 */
	public revert(): { restore: El[]; remove: string[] } {
		const restore: El[] = [], remove: string[] = [];
		for (const [id, was] of this.before) {
			if (was === null) remove.push(id);
			else restore.push(structuredClone(was));
		}
		this.accept();
		return { restore, remove };
	}
}
