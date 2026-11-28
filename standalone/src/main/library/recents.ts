// The documents opened lately, wherever they are: the home screen's "Recent".
// Nothing of Electron here: the tests load this file as it is.
//
// The system keeps such a list too (File → Open Recent), but does not let an app read it. This
// one is the app's own, in a file in its data folder: paths and times, nothing of the documents.
import * as fs from "fs";
import * as path from "path";

export interface Recent {
	path: string;
	/** When it was last opened or saved here. */
	at: number;
}

export class Recents {
	constructor(private readonly file: string, private readonly max = 40) {}

	private read(): Recent[] {
		try {
			const list = JSON.parse(fs.readFileSync(this.file, "utf8"));
			return Array.isArray(list) ? list.filter((r) => r && typeof r.path === "string" && path.isAbsolute(r.path) && typeof r.at === "number").slice(0, this.max) : [];
		} catch {
			return [];
		}
	}

	private write(list: Recent[]): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify(list.slice(0, this.max), null, "\t"));
		} catch {
			// (a list that cannot be kept is a list that starts again: nothing of the user's is lost)
		}
	}

	/** The documents opened lately that are still there, the latest first. */
	public list(): Recent[] {
		return this.read()
			.filter((r) => {
				try {
					return fs.statSync(r.path).isFile();
				} catch {
					return false;
				}
			})
			.sort((a, b) => b.at - a.at);
	}

	public add(file: string, now = Date.now()): void {
		const resolved = path.resolve(file);
		this.write([{ path: resolved, at: now }, ...this.read().filter((r) => r.path !== resolved)]);
	}

	public remove(file: string): void {
		const resolved = path.resolve(file);
		this.write(this.read().filter((r) => r.path !== resolved));
	}

	/** A document that the app gave another name or place: it is the same one in the list. */
	public moved(from: string, to: string): void {
		const a = path.resolve(from), b = path.resolve(to);
		this.write(this.read().map((r) => (r.path === a ? { ...r, path: b } : r)));
	}
}
