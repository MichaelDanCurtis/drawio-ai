// Where a file that an agent asked for is written (the export tools), and how.
// Nothing of Electron here: the tests load this file as it is.
//
// An agent names where an export goes, or it goes beside the document under the document's
// name. Either way the name may already be something in that folder, put there by whoever made
// the folder (a checked-out repository, an unpacked archive). A link under that name would send
// the export to another file altogether, while the user is asked about the name they see. So
// an export is never written through a link, soft or hard: one in the way is refused, and the
// file is made (or opened, to be replaced) in a way that does not follow one that appears
// meanwhile.
//
// A file that is replaced is written into as it is, not swapped for a new one: it stays whose
// it was, with its permissions and whatever else says who may read it (an access list), which a
// new file put in its place would not have.
import * as fs from "fs";
import * as path from "path";

/** The export cannot go where it was asked to; the message is for the agent and the user as it is. */
export class ExportTargetError extends Error {}

/** A file's real place (links in the folders above it followed); the path itself when there is no such file yet. */
export function realPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/**
 * Where an export to `target` would land: whether a file is there already, and its real place
 * (the folder's links followed, for showing the user what they are asked about). Throws
 * ExportTargetError when it cannot go there: the name is a link, or is not a file, or the
 * folder is not there.
 */
export function exportTarget(target: string): { exists: boolean; real: string } {
	const name = path.basename(target);
	let folder: string;
	try {
		folder = fs.realpathSync(path.dirname(target));
	} catch {
		throw new ExportTargetError(`The folder ${path.dirname(target)} does not exist.`);
	}
	const real = path.join(folder, name);
	let there: fs.Stats | undefined;
	try {
		there = fs.lstatSync(real);
	} catch {
		there = undefined;
	}
	if (there?.isSymbolicLink()) throw new ExportTargetError(`${name} is a link to another file, and an export is not written through a link. Export under another name.`);
	if (there && !there.isFile()) throw new ExportTargetError(`${name} is not a file.`);
	return { exists: !!there, real };
}

/**
 * Writes an export to where `exportTarget` said it lands (`real`). `replace`: a file is there
 * and the user agreed to replace it; otherwise there must be none. A link is never followed:
 * a new file is made only if nothing has that name (not even a link that appeared meanwhile),
 * and a file is replaced only if it is a plain file with this one name (see `replaceContents`).
 */
export function writeExport(real: string, bytes: Buffer, replace: boolean): void {
	if (!replace) {
		let made: number;
		try {
			made = fs.openSync(real, "wx");
		} catch (e: any) {
			if (e?.code === "EEXIST") throw new ExportTargetError(`${path.basename(real)} appeared while the export was made. Nothing was written.`);
			throw e;
		}
		try {
			try {
				writeAll(made, bytes);
			} finally {
				fs.closeSync(made);
			}
		} catch (e) {
			// (the disk is full, a quota is reached: half an export is not left under the export's name)
			fs.rmSync(real, { force: true });
			throw e;
		}
		return;
	}
	if (!exportTarget(real).exists) return writeExport(real, bytes, false);
	replaceContents(real, bytes);
}

/** Up to this size a file's old contents are kept while it is replaced, to be put back if the writing fails. */
const KEPT_FOR_PUTTING_BACK = 64 * 1024 * 1024;

/**
 * Puts `bytes` into the file at `real` in place of what is in it. The file stays the one it is
 * (its owner, group, permissions and access list are not touched), so who could read the export
 * before can read it now, and nobody else. It is opened without following a link, and written
 * only if what was opened is a plain file that is still the one under this name, and has no
 * other name: a hard link would be another file's contents too. When the writing fails (the
 * disk is full) the old contents are put back.
 */
function replaceContents(real: string, bytes: Buffer): void {
	const name = path.basename(real);
	const link = () => new ExportTargetError(`${name} is a link to another file, and an export is not written through a link. Export under another name.`);
	// (where the system has no such flag, Windows, the check below is what keeps a link from being followed)
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	let fd: number;
	let readable = true;
	try {
		try {
			fd = fs.openSync(real, fs.constants.O_RDWR | noFollow);
		} catch (e: any) {
			// (a file that may be written but not read: replaced all the same, with no way back)
			if (e?.code !== "EACCES") throw e;
			fd = fs.openSync(real, fs.constants.O_WRONLY | noFollow);
			readable = false;
		}
	} catch (e: any) {
		// (a link that took the file's place meanwhile)
		if (e?.code === "ELOOP" || e?.code === "EMLINK") throw link();
		if (e?.code === "ENOENT") return writeExport(real, bytes, false);
		throw e;
	}
	try {
		const open = fs.fstatSync(fd);
		let named: fs.Stats | undefined;
		try {
			named = fs.lstatSync(real);
		} catch {
			named = undefined;
		}
		// what was opened is not what has this name: the name is a link now, or was one a moment ago
		if (!named || named.isSymbolicLink() || named.dev !== open.dev || named.ino !== open.ino) throw link();
		if (!open.isFile()) throw new ExportTargetError(`${name} is not a file.`);
		if (open.nlink > 1) throw new ExportTargetError(`${name} is one of several names of the same file (a hard link), and an export is not written through a link. Export under another name.`);

		const old = readable && open.size <= KEPT_FOR_PUTTING_BACK ? readAll(fd, open.size) : undefined;
		try {
			writeAll(fd, bytes);
		} catch (e) {
			if (old) {
				try {
					writeAll(fd, old);
				} catch {
					// (it could not be put back either: the error below is what the user is told)
				}
			}
			throw e;
		}
	} finally {
		fs.closeSync(fd);
	}
}

/** The first `size` bytes of an open file. */
function readAll(fd: number, size: number): Buffer {
	const buffer = Buffer.alloc(size);
	let at = 0;
	while (at < size) {
		const n = fs.readSync(fd, buffer, at, size - at, at);
		if (n === 0) break;
		at += n;
	}
	return buffer.subarray(0, at);
}

/** Makes these bytes the whole contents of an open file. */
function writeAll(fd: number, bytes: Buffer): void {
	fs.ftruncateSync(fd, 0);
	let at = 0;
	while (at < bytes.length) at += fs.writeSync(fd, bytes, at, bytes.length - at, at);
}
