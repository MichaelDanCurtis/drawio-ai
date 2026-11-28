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
// - A change that is undone (Cmd/Ctrl+Z) is no longer pending.
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

/** What says nothing about how an element looks or what it is attached to: it changes with every write. */
const BOOKKEEPING = new Set(["version", "versionNonce", "updated", "index", "seed"]);

/** An element's content as one string: equal for two states that draw the same thing. */
export function contentKey(el: El, without: ReadonlySet<string> = BOOKKEEPING): string {
	const keys = Object.keys(el).filter((k) => !without.has(k)).sort();
	return JSON.stringify(keys.map((k) => [k, el[k]]));
}

/** For telling whether an element looks different: which lines and labels are attached to it does not show on it. */
const UNSEEN = new Set([...BOOKKEEPING, "boundElements"]);

const exists = (el: El | undefined | null): el is El => !!el && !el.isDeleted;

export class ReviewLedger {
	/** What each element the AI touched was before it first did; null for one that was not there. */
	private before = new Map<string, El | null>();

	public get open(): boolean {
		return this.before.size > 0;
	}

	/** The AI is about to change this element (or add it): what it is now is kept, the first time. */
	public touch(id: string, current: El | undefined): void {
		if (this.before.has(id)) return;
		this.before.set(id, exists(current) ? structuredClone(current) : null);
	}

	/** Forgets what is no longer different from before (it was undone, or put back by hand). */
	public prune(current: (id: string) => El | undefined): void {
		for (const [id, was] of this.before) {
			const now = current(id);
			if (was === null ? !exists(now) : exists(now) && contentKey(now) === contentKey(was)) this.before.delete(id);
		}
	}

	/**
	 * The pending changes, as the user sees them: a shape whose label changed is one changed
	 * shape (not a text that went and one that came), and an element that only had a line
	 * attached to it or taken off it is not listed at all.
	 */
	public changes(current: (id: string) => El | undefined): Change[] {
		const found = new Map<string, Change>();
		const labelled = new Map<string, El>();
		for (const [id, was] of this.before) {
			const now = current(id);
			const el = exists(now) ? now : was;
			if (!el) continue;
			let change: Change["change"] | undefined;
			if (was === null) change = exists(now) ? "added" : undefined;
			else if (!exists(now)) change = "removed";
			else if (contentKey(now, UNSEEN) !== contentKey(was, UNSEEN)) change = "changed";
			if (!change) continue;
			// a label is its shape's: the shape is what changed
			const containerId = el.type === "text" && typeof el.containerId === "string" ? el.containerId : undefined;
			if (containerId) {
				const container = current(containerId) ?? this.before.get(containerId) ?? undefined;
				if (container) {
					labelled.set(containerId, container);
					continue;
				}
			}
			found.set(id, { id, change, element: el });
		}
		for (const [id, container] of labelled) {
			if (found.has(id)) continue;
			// (the label of a shape that is itself gone or new is said by the shape)
			if (exists(current(id))) found.set(id, { id, change: "changed", element: current(id)! });
			else if (this.before.get(id)) found.set(id, { id, change: "removed", element: container });
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
		this.before.clear();
		return { restore, remove };
	}
}
