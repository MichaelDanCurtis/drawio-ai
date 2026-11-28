// Where a file that an agent asked for is written (the export tools), and how.
// Nothing of Electron here: the tests load this file as it is.
//
// An agent names where an export goes, or it goes beside the document under the document's
// name. Either way the name may already be something in that folder, put there by whoever made
// the folder (a checked-out repository, an unpacked archive). A link under that name would send
// the export to another file altogether, while the user is asked about the name they see. So
// an export is never written through a link: one in the way is refused, and the file is made
// in a way that does not follow one that appears meanwhile.
import * as crypto from "crypto";
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
 * and a file is replaced by putting the new one in its place whole, whatever is there by then.
 * The new file can be read and written by whom the old one could (a private export stays private).
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
		fill(made, real, bytes);
		return;
	}
	const still = exportTarget(real);
	if (!still.exists) return writeExport(real, bytes, false);
	// (who may read, write and run it; nothing else of its mode is carried over)
	const mode = fs.lstatSync(real).mode & 0o777;
	// (a short name of its own beside the file: a long file name leaves no room to add to)
	const temp = path.join(path.dirname(real), `.omnidraw-${crypto.randomBytes(8).toString("hex")}.tmp`);
	// (made anew, or not at all: a name that is taken is someone else's, and is left alone)
	const fd = fs.openSync(temp, "wx", mode);
	fill(fd, temp, bytes, mode);
	try {
		fs.renameSync(temp, real);
	} catch (e) {
		fs.rmSync(temp, { force: true });
		throw e;
	}
}

/**
 * Fills a file this code has just made (`fd`, at `file`) and closes it. When it cannot be
 * written whole (the disk is full, a quota is reached) it is taken away again: half an export is
 * left neither under the export's name nor beside it. `mode`: the permissions it gets, whatever
 * this process would give a new file by default.
 */
function fill(fd: number, file: string, bytes: Buffer, mode?: number): void {
	try {
		try {
			if (mode !== undefined) fs.fchmodSync(fd, mode);
			fs.writeFileSync(fd, bytes);
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		fs.rmSync(file, { force: true });
		throw e;
	}
}
