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
	/** Which file that was, as the disk knows it (its device and its number there): a path can come to lead to another file. */
	dev?: number;
	ino?: number;
}

/** A file from the list cannot be read as the file it was; the message is for the user as it is. */
export class RecentFileError extends Error {}

/**
 * The bytes of a file from the list, for copying it somewhere: only if it is still the very
 * file that was opened here. A path stays in the list long after the file was opened, in a
 * folder that may be other people's too; what is under that path by now may be a link to a
 * file of the user's that nobody else can read, put there for this app to fetch. So the file is
 * opened without following a link, checked to be a plain file and the one that was noted (the
 * same device and number), and read from what was opened, not from the path again.
 */
export function readRecent(recent: Recent, limit: number): Buffer {
	const name = path.basename(recent.path);
	const changed = () => new RecentFileError(`${name} is not the file that was opened here any more (it was replaced, or is a link now). Open it first, then copy it.`);
	if (recent.dev === undefined || recent.ino === undefined) throw changed();
	let fd: number;
	try {
		fd = fs.openSync(recent.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch (e: any) {
		if (e?.code === "ELOOP" || e?.code === "EMLINK") throw changed();
		throw new RecentFileError(`${name} could not be read: ${e?.message ?? e}`);
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.dev !== recent.dev || stat.ino !== recent.ino) throw changed();
		if (stat.size > limit) throw new RecentFileError(`${name} is too large to copy from here. Copy it into the library folder yourself.`);
		const bytes = Buffer.alloc(stat.size);
		let at = 0;
		while (at < bytes.length) {
			const n = fs.readSync(fd, bytes, at, bytes.length - at, at);
			if (n === 0) break;
			at += n;
		}
		return bytes.subarray(0, at);
	} finally {
		fs.closeSync(fd);
	}
}

export class Recents {
	constructor(private readonly file: string, private readonly max = 40) {}

	private read(): Recent[] {
		try {
			const list = JSON.parse(fs.readFileSync(this.file, "utf8"));
			return Array.isArray(list)
				? list
						.filter((r) => r && typeof r.path === "string" && path.isAbsolute(r.path) && typeof r.at === "number")
						.map((r) => ({ path: r.path, at: r.at, ...(typeof r.dev === "number" && typeof r.ino === "number" ? { dev: r.dev, ino: r.ino } : {}) }))
						.slice(0, this.max)
				: [];
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

	/** Notes a file that was just opened or saved here: where it is, when, and which file that is. */
	public add(file: string, now = Date.now()): void {
		const resolved = path.resolve(file);
		let which: { dev?: number; ino?: number } = {};
		try {
			const stat = fs.statSync(resolved);
			which = { dev: stat.dev, ino: stat.ino };
		} catch {
			// (noted without: it can be opened from the list, and not copied from it)
		}
		this.write([{ path: resolved, at: now, ...which }, ...this.read().filter((r) => r.path !== resolved)]);
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
