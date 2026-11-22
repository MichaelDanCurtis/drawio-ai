import * as fs from "fs";
import * as path from "path";
import { withScratchpad } from "./shapeSets";

/**
 * draw.io's localStorage, kept by the app: its settings (panels, recent colours, which shape
 * sets show) and the Scratchpad's shapes. Every editor page starts with a copy and posts its
 * whole copy back whenever it sets a key.
 *
 * Several windows share it, so a page's post is compared with what that page was given or
 * posted last: only the keys it really changed are taken over (a window that knows nothing of
 * another's new Scratchpad shape cannot wipe it out), and the changes are passed on to the
 * other windows. The file is written whole to a temporary file first, and before the app quits.
 */
export class DrawioStorage {
	private map: Record<string, string> | undefined;
	private timer: NodeJS.Timeout | undefined;
	private dirty = false;

	constructor(private readonly file: () => string) {}

	/** Everything kept (with a Scratchpad in it: see withScratchpad). */
	all(): Record<string, string> {
		if (!this.map) {
			this.map = {};
			let text: string | undefined;
			try {
				text = fs.readFileSync(this.file(), "utf8");
			} catch {
				text = undefined; // nothing kept yet
			}
			if (text !== undefined && text.trim()) {
				try {
					const parsed = JSON.parse(text);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
					for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") this.map[k] = v;
				} catch {
					// unreadable (cut short by a crash, edited by hand): set it aside instead of writing over it
					try {
						fs.copyFileSync(this.file(), `${this.file()}.broken`);
					} catch {
						// nothing more to do
					}
				}
			}
		}
		return withScratchpad(this.map);
	}

	/** A copy for an editor page (also what that page is taken to know). */
	snapshot(): Record<string, string> {
		return { ...this.all() };
	}

	/**
	 * A page posted its storage. `seen` is what that page was given or posted last, and is
	 * brought up to date. Returns the keys it changed (null: removed), now kept.
	 */
	apply(posted: unknown, seen: Record<string, string>): Record<string, string | null> {
		const changes: Record<string, string | null> = {};
		if (!posted || typeof posted !== "object" || Array.isArray(posted)) return changes;
		const map = this.all();
		const next: Record<string, string> = {};
		for (const [k, v] of Object.entries(posted as Record<string, unknown>)) {
			if (typeof v !== "string" || k.length > 200) continue;
			next[k] = v;
			if (seen[k] !== v) {
				map[k] = v;
				changes[k] = v;
			}
		}
		for (const k of Object.keys(seen)) {
			if (!(k in next)) {
				delete map[k];
				changes[k] = null;
			}
		}
		for (const k of Object.keys(seen)) delete seen[k];
		Object.assign(seen, next);
		if (Object.keys(changes).length) this.schedule();
		return changes;
	}

	private schedule(): void {
		this.dirty = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), 400);
	}

	/** Writes what is kept now (whole, then moved into place, so a crash cannot leave half a file). */
	flush(): void {
		clearTimeout(this.timer);
		if (!this.dirty || !this.map) return;
		this.dirty = false;
		try {
			const file = this.file();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.map));
			fs.renameSync(`${file}.tmp`, file);
		} catch {
			this.dirty = true; // try again with the next change
		}
	}
}

/** An object of strings as a JavaScript literal that is safe inside an inline <script>. */
export function storageLiteral(storage: Record<string, string>): string {
	return JSON.stringify(storage).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
