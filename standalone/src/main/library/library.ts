// The library: a folder of diagrams and drawings, as the home screen shows it.
// Nothing of Electron here: the tests load this file as it is.
//
// The library is a folder the user chose (Documents/OmniDraw unless they say otherwise) with
// plain files in it, there to be seen in Finder, kept in git, or synced. A folder at its top is
// a collection. What the app keeps of its own is in one hidden folder, `.omnidraw`:
//
//   .omnidraw/versions/<the document's path>/   earlier states of a document, one file each
//   .omnidraw/thumbs/<the document's path>.png  a picture of it as it was last saved here
//   .omnidraw/trash/<id>/                       a document moved to the trash, with its versions
//
// A document is known by its path in the library ("Team/Plan.excalidraw"): that is its id. Its
// versions follow it when the app renames or moves it; a file renamed in Finder is a new
// document to the app, with no history.
//
// Everything asked of the library stays in it. A name is a name, never a path; an id is taken
// apart and checked before it is used; and a link is never followed: not when the library is
// read (a linked folder could be anywhere), and not when a file is written.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type DocKind = "drawio" | "excalidraw";

/** The endings a document can have, the longest first (".drawio.svg" before ".svg" would matter, were ".svg" one). */
const ENDINGS: { ending: string; kind: DocKind }[] = [
	{ ending: ".excalidraw.png", kind: "excalidraw" },
	{ ending: ".excalidraw.svg", kind: "excalidraw" },
	{ ending: ".excalidraw", kind: "excalidraw" },
	{ ending: ".drawio.png", kind: "drawio" },
	{ ending: ".drawio.svg", kind: "drawio" },
	{ ending: ".drawio", kind: "drawio" },
	{ ending: ".dio", kind: "drawio" },
];

/** What a file's name says it is: undefined for anything that is not a diagram or a drawing. */
export function docType(fileName: string): { name: string; ending: string; kind: DocKind } | undefined {
	const lower = fileName.toLowerCase();
	for (const e of ENDINGS) {
		if (lower.endsWith(e.ending) && fileName.length > e.ending.length) return { name: fileName.slice(0, -e.ending.length), ending: fileName.slice(-e.ending.length), kind: e.kind };
	}
	return undefined;
}

export interface LibraryDoc {
	/** Its path in the library, with "/" between the parts. */
	id: string;
	/** Its name, without the ending. */
	name: string;
	ending: string;
	kind: DocKind;
	/** The collection it is in (the folder at the library's top), "" for none. */
	collection: string;
	/** The folders between the collection and the file ("" for none), for a file deeper down. */
	within: string;
	modified: number;
	size: number;
	/** How many earlier states of it are kept. */
	versions: number;
	/** When the picture kept of it was made, when there is one of the document as it is now; else 0. */
	pictured: number;
}

export interface Collection {
	name: string;
	count: number;
}

export interface TrashItem {
	id: string;
	/** Where it was: the document's id when it was moved to the trash. */
	from: string;
	name: string;
	ending: string;
	kind: DocKind;
	collection: string;
	/** When it was moved to the trash. */
	at: number;
	size: number;
}

export interface Version {
	/** The version's file name: its key. */
	key: string;
	/** When this state was saved. */
	at: number;
	size: number;
	/** Kept for good at a point of its own (as it was opened, before a restore), not one of a row of saves. */
	kept: boolean;
}

export interface LibraryContents {
	docs: LibraryDoc[];
	collections: Collection[];
	trash: TrashItem[];
	/** More documents are in the folder than are listed (the library is read up to a number). */
	more: boolean;
}

/** Something asked of the library cannot be done; the message is for the user as it is. */
export class LibraryError extends Error {}

const STORE = ".omnidraw";
/** How deep under the library a document is looked for, and how many are listed. */
const MAX_DEPTH = 5;
const MAX_DOCS = 4000;
/** Saves within this long of each other are one version: the last of them. */
export const VERSION_WINDOW = 10 * 60 * 1000;
/** How many versions of a document are kept; the oldest go first. */
export const MAX_VERSIONS = 100;

/**
 * A name for a document or a collection, as the user typed it: trimmed, and refused when it
 * could be anything but a name in one folder (a path, a hidden file, a name no system takes).
 */
export function cleanName(typed: string, what = "name"): string {
	const name = String(typed ?? "").trim().replace(/\s+/g, " ");
	if (!name) throw new LibraryError(`Give it a ${what}.`);
	if (name.length > 120) throw new LibraryError(`That ${what} is too long.`);
	// eslint-disable-next-line no-control-regex
	if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new LibraryError(`A ${what} cannot have any of \\ / : * ? " < > | in it.`);
	if (name.startsWith(".") || name.endsWith(".")) throw new LibraryError(`A ${what} cannot start or end with a dot.`);
	if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new LibraryError(`${name} is a name the system keeps for itself.`);
	return name;
}

const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const hashOf = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);

export class Library {
	/**
	 * `folder`: where the library is, or is to be. A library nothing was put into yet need not
	 * have a folder: it is made with the first document or collection, not by being looked at.
	 */
	constructor(private readonly folder: string) {
		const there = fs.statSync(folder, { throwIfNoEntry: false });
		if (there && !there.isDirectory()) throw new LibraryError(`${folder} is not a folder.`);
	}

	/** The library's folder, with the links on the way to it followed (so that what is in it can be told from what is not). */
	public get root(): string {
		try {
			return fs.realpathSync(this.folder);
		} catch {
			// (not there yet: where it will be, as far as that can be said)
			try {
				return path.join(fs.realpathSync(path.dirname(this.folder)), path.basename(this.folder));
			} catch {
				return path.resolve(this.folder);
			}
		}
	}

	/** Whether the library's folder is there. */
	public get exists(): boolean {
		return fs.statSync(this.folder, { throwIfNoEntry: false })?.isDirectory() === true;
	}

	/** The library's folder, made if it is not there: for what puts something into the library. */
	private made(): string {
		try {
			fs.mkdirSync(this.folder, { recursive: true });
		} catch (e: any) {
			throw new LibraryError(`The library folder ${this.folder} could not be made: ${e?.message ?? e}`);
		}
		return this.root;
	}

	private store(...parts: string[]): string {
		const dir = path.join(this.made(), STORE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
			// (the app's own bookkeeping is not for a repository the library may be in: git has a history of its own)
			fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
		}
		// (a link in place of the store would take the trash and the versions elsewhere)
		if (fs.lstatSync(dir).isSymbolicLink()) throw new LibraryError(`${STORE} in the library is a link, and the app does not keep its files through a link.`);
		return path.join(dir, ...parts);
	}

	// ----- ids and paths -----

	/** The parts of an id, each checked to be a plain name: nothing in an id leads out of the library. */
	private parts(id: string): string[] {
		if (typeof id !== "string" || !id || id.length > 1000) throw new LibraryError("That is not a document in the library.");
		const parts = id.split("/");
		for (const p of parts) {
			// eslint-disable-next-line no-control-regex
			if (!p || p === "." || p === ".." || p.startsWith(".") || /[\\\u0000]/.test(p)) throw new LibraryError("That is not a document in the library.");
		}
		if (parts.length > MAX_DEPTH + 1) throw new LibraryError("That is not a document in the library.");
		return parts;
	}

	/** Where a document is, by its id. It need not be there. */
	public pathOf(id: string): string {
		return path.join(this.root, ...this.parts(id));
	}

	/**
	 * The document a file is, when the file is in the library (not in the app's own folder there,
	 * not under a hidden folder, and by a name that is a document's). Undefined for any other file.
	 */
	public idOf(file: string): string | undefined {
		let real: string;
		try {
			real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
		} catch {
			return undefined;
		}
		const rel = path.relative(this.root, real);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
		const parts = rel.split(path.sep);
		if (parts.length > MAX_DEPTH + 1 || parts.some((p) => p.startsWith("."))) return undefined;
		return docType(parts[parts.length - 1]) ? parts.join("/") : undefined;
	}

	/** The document's file as it is on disk: there, a plain file, not a link. */
	private existing(id: string): { file: string; stat: fs.Stats; type: { name: string; ending: string; kind: DocKind } } {
		const parts = this.parts(id);
		const type = docType(parts[parts.length - 1]);
		if (!type) throw new LibraryError("That is not a document in the library.");
		// (no folder on the way to it is a link either)
		let dir = this.root;
		for (const p of parts.slice(0, -1)) {
			dir = path.join(dir, p);
			const s = fs.lstatSync(dir, { throwIfNoEntry: false });
			if (!s || !s.isDirectory()) throw new LibraryError(`${parts[parts.length - 1]} is not in the library any more.`);
		}
		const file = path.join(dir, parts[parts.length - 1]);
		const stat = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!stat || !stat.isFile()) throw new LibraryError(`${parts[parts.length - 1]} is not in the library any more.`);
		return { file, stat, type };
	}

	/** The folder of a collection ("" is the library itself), made if it is not there. */
	private collectionFolder(collection: string): string {
		if (!collection) return this.made();
		const name = cleanName(collection, "collection name");
		const dir = path.join(this.made(), name);
		const s = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (s && !s.isDirectory()) throw new LibraryError(`${name} is not a folder in the library.`);
		if (!s) fs.mkdirSync(dir);
		return dir;
	}

	/** A name nothing in `dir` has yet: the one asked for, or that with a number after it. */
	private free(dir: string, name: string, ending: string): string {
		const taken = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
		for (let n = 1; n < 10000; n++) {
			const candidate = `${n === 1 ? name : `${name} ${n}`}${ending}`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
		throw new LibraryError("No free name was found.");
	}

	private static idIn(collection: string, fileName: string): string {
		return collection ? `${collection}/${fileName}` : fileName;
	}

	// ----- reading -----

	/** What is in the library now: read from the folder each time, which is where the truth is. */
	public contents(): LibraryContents {
		const docs: LibraryDoc[] = [];
		const collections = new Map<string, number>();
		let more = false;
		const walk = (dir: string, rel: string[]) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				// (hidden things, the app's own folder among them, and what a project keeps of other people's code)
				if (e.name.startsWith(".") || e.name === "node_modules") continue;
				// (a link is not followed: it could lead anywhere)
				if (e.isSymbolicLink()) continue;
				if (e.isDirectory()) {
					if (rel.length === 0) collections.set(e.name, collections.get(e.name) ?? 0);
					if (rel.length < MAX_DEPTH) walk(path.join(dir, e.name), [...rel, e.name]);
					continue;
				}
				const type = e.isFile() ? docType(e.name) : undefined;
				if (!type) continue;
				if (docs.length >= MAX_DOCS) {
					more = true;
					continue;
				}
				let stat: fs.Stats;
				try {
					stat = fs.statSync(path.join(dir, e.name));
				} catch {
					continue;
				}
				const id = [...rel, e.name].join("/");
				const collection = rel[0] ?? "";
				if (collection) collections.set(collection, (collections.get(collection) ?? 0) + 1);
				docs.push({ id, ...type, collection, within: rel.slice(1).join("/"), modified: stat.mtimeMs, size: stat.size, versions: this.versionFiles(id).length, pictured: this.pictured(id, stat.mtimeMs) });
			}
		};
		walk(this.root, []);
		docs.sort((a, b) => b.modified - a.modified);
		return {
			docs,
			collections: [...collections].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
			trash: this.trashItems(),
			more,
		};
	}

	public read(id: string): Buffer {
		return fs.readFileSync(this.existing(id).file);
	}

	// ----- documents -----

	/** A new document with these contents, in a collection ("" for none), under a name that is free. Returns its id. */
	public create(collection: string, name: string, ending: string, bytes: Buffer): string {
		const type = docType(`x${ending}`);
		if (!type || type.ending !== ending) throw new LibraryError(`${ending} is not an ending for a diagram or a drawing.`);
		const dir = this.collectionFolder(collection);
		const fileName = this.free(dir, cleanName(name), ending);
		// (made anew, or not at all)
		fs.writeFileSync(path.join(dir, fileName), bytes, { flag: "wx" });
		return Library.idIn(collection ? path.basename(dir) : "", fileName);
	}

	/** Gives a document another name (its ending stays). Returns its new id. */
	public rename(id: string, newName: string): string {
		const { file, type } = this.existing(id);
		const name = cleanName(newName);
		if (name === type.name) return id;
		const dir = path.dirname(file);
		const target = path.join(dir, `${name}${type.ending}`);
		// (another spelling of the same name is the same file on some disks: that is this file, not one in the way)
		const there = fs.lstatSync(target, { throwIfNoEntry: false });
		if (there && !(there.ino === fs.lstatSync(file).ino && there.dev === fs.lstatSync(file).dev)) throw new LibraryError(`There is a ${path.basename(target)} already.`);
		fs.renameSync(file, target);
		const parts = this.parts(id);
		const next = [...parts.slice(0, -1), path.basename(target)].join("/");
		this.carry(id, next);
		return next;
	}

	/** Moves a document to a collection ("" for none), keeping its name if it is free there. Returns its new id. */
	public move(id: string, collection: string): string {
		const { file, type } = this.existing(id);
		const dir = this.collectionFolder(collection);
		if (path.dirname(file) === dir) return id;
		const fileName = this.free(dir, type.name, type.ending);
		fs.renameSync(file, path.join(dir, fileName));
		const next = Library.idIn(collection ? path.basename(dir) : "", fileName);
		this.carry(id, next);
		return next;
	}

	/** A copy of a document beside it. Returns the copy's id. */
	public duplicate(id: string): string {
		const { file, type } = this.existing(id);
		const dir = path.dirname(file);
		const fileName = this.free(dir, `${type.name} copy`, type.ending);
		fs.copyFileSync(file, path.join(dir, fileName), fs.constants.COPYFILE_EXCL);
		return [...this.parts(id).slice(0, -1), fileName].join("/");
	}

	/** What the app keeps of a document (its versions, its picture) goes where the document went. */
	private carry(from: string, to: string): void {
		for (const [a, b] of [[this.versionsFolder(from), this.versionsFolder(to)], [this.thumbFile(from), this.thumbFile(to)]]) {
			try {
				if (!fs.existsSync(a)) continue;
				fs.rmSync(b, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(b), { recursive: true });
				fs.renameSync(a, b);
			} catch {
				// (the document is where it should be; its history staying behind is no reason to say the move failed)
			}
		}
	}

	// ----- collections -----

	public createCollection(name: string): string {
		const clean = cleanName(name, "collection name");
		const dir = path.join(this.made(), clean);
		if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new LibraryError(`There is a ${clean} already.`);
		fs.mkdirSync(dir);
		return clean;
	}

	/** Renames a collection: its documents, their versions and pictures go with it. */
	public renameCollection(name: string, newName: string): string {
		const from = this.collectionDir(name);
		const clean = cleanName(newName, "collection name");
		if (clean === name) return name;
		const to = path.join(this.root, clean);
		const there = fs.lstatSync(to, { throwIfNoEntry: false });
		if (there && !(there.ino === fs.lstatSync(from).ino && there.dev === fs.lstatSync(from).dev)) throw new LibraryError(`There is a ${clean} already.`);
		fs.renameSync(from, to);
		for (const kind of ["versions", "thumbs"]) {
			try {
				const a = this.store(kind, name), b = this.store(kind, clean);
				if (!fs.existsSync(a)) continue;
				fs.rmSync(b, { recursive: true, force: true });
				fs.renameSync(a, b);
			} catch {
				// (as in carry)
			}
		}
		return clean;
	}

	/**
	 * Takes a collection away. Its documents are not thrown out with it: they go to the top of the
	 * library (`moved`: where each was, and where it is now). The folder goes if nothing else is
	 * left in it; `kept` says when it stayed.
	 */
	public removeCollection(name: string): { moved: { from: string; to: string }[]; kept: boolean } {
		const dir = this.collectionDir(name);
		const moved = this.contents()
			.docs.filter((d) => d.collection === name)
			.map((d) => ({ from: d.id, to: this.move(d.id, "") }));
		let kept = false;
		try {
			// (empty folders that held documents go; a folder with anything else in it stays, and so does the collection's)
			const prune = (folder: string): boolean => {
				let empty = true;
				for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
					if (e.isDirectory() && !e.isSymbolicLink() && prune(path.join(folder, e.name))) continue;
					// (what Finder leaves in every folder it showed is not something of the user's)
					if (e.name === ".DS_Store") continue;
					empty = false;
				}
				if (empty) fs.rmSync(folder, { recursive: true, force: true });
				return empty;
			};
			kept = !prune(dir);
		} catch {
			kept = true;
		}
		return { moved, kept };
	}

	private collectionDir(name: string): string {
		const clean = cleanName(name, "collection name");
		const dir = path.join(this.root, clean);
		const s = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (!s || !s.isDirectory()) throw new LibraryError(`${clean} is not a collection in the library.`);
		return dir;
	}

	// ----- the trash -----

	/** Moves a document to the trash, with its versions and its picture. Returns the trash item's id. */
	public trash(id: string, now = Date.now()): string {
		const { file, type, stat } = this.existing(id);
		// (a picture of an older state is not what the document looks like in the trash: it stays behind, and goes)
		if (!this.pictured(id, stat.mtimeMs)) fs.rmSync(this.thumbFile(id), { force: true });
		const trashId = `${stamp(now)}-${crypto.randomBytes(4).toString("hex")}`;
		const dir = this.store("trash", trashId);
		fs.mkdirSync(dir, { recursive: true });
		fs.renameSync(file, path.join(dir, `item${type.ending}`));
		fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify({ from: id, at: now }));
		for (const [a, b] of [[this.versionsFolder(id), path.join(dir, "versions")], [this.thumbFile(id), path.join(dir, "thumb.png")]]) {
			try {
				if (fs.existsSync(a)) fs.renameSync(a, b);
			} catch {
				// (the document is in the trash; what goes with it is not worth failing for)
			}
		}
		return trashId;
	}

	private trashDir(trashId: string): string {
		if (typeof trashId !== "string" || !/^[0-9TZ]+-[0-9a-f]{8}$/.test(trashId)) throw new LibraryError("That is not in the trash.");
		const dir = this.store("trash", trashId);
		const s = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (!s || !s.isDirectory()) throw new LibraryError("That is not in the trash any more.");
		return dir;
	}

	private trashEntry(trashId: string): { dir: string; file: string; item: TrashItem } | undefined {
		try {
			const dir = this.trashDir(trashId);
			const info = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
			const parts = this.parts(String(info.from));
			const type = docType(parts[parts.length - 1]);
			if (!type) return undefined;
			const file = path.join(dir, `item${type.ending}`);
			const stat = fs.lstatSync(file);
			if (!stat.isFile()) return undefined;
			return { dir, file, item: { id: trashId, from: parts.join("/"), ...type, collection: parts.length > 1 ? parts[0] : "", at: Number(info.at) || stat.mtimeMs, size: stat.size } };
		} catch {
			return undefined;
		}
	}

	private trashItems(): TrashItem[] {
		const dir = path.join(this.root, STORE, "trash");
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return [];
		}
		return names
			.map((n) => this.trashEntry(n)?.item)
			.filter((i): i is TrashItem => !!i)
			.sort((a, b) => b.at - a.at);
	}

	/** The file of something in the trash (for its picture). */
	public trashFile(trashId: string): string {
		const entry = this.trashEntry(trashId);
		if (!entry) throw new LibraryError("That is not in the trash any more.");
		return entry.file;
	}

	/** Puts a document back where it was, under its name if that is still free. Returns its id. */
	public restore(trashId: string): string {
		const entry = this.trashEntry(trashId);
		if (!entry) throw new LibraryError("That is not in the trash any more.");
		const parts = this.parts(entry.item.from);
		// (the folders it was in, made again if they went meanwhile)
		let dir = this.root;
		for (const p of parts.slice(0, -1)) {
			dir = path.join(dir, p);
			const s = fs.lstatSync(dir, { throwIfNoEntry: false });
			if (s && !s.isDirectory()) throw new LibraryError(`${p} is not a folder in the library any more.`);
			if (!s) fs.mkdirSync(dir);
		}
		const fileName = this.free(dir, entry.item.name, entry.item.ending);
		fs.renameSync(entry.file, path.join(dir, fileName));
		const id = [...parts.slice(0, -1), fileName].join("/");
		for (const [a, b] of [[path.join(entry.dir, "versions"), this.versionsFolder(id)], [path.join(entry.dir, "thumb.png"), this.thumbFile(id)]]) {
			try {
				if (!fs.existsSync(a)) continue;
				fs.rmSync(b, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(b), { recursive: true });
				fs.renameSync(a, b);
			} catch {
				// (as in carry)
			}
		}
		fs.rmSync(entry.dir, { recursive: true, force: true });
		return id;
	}

	/** Takes something out of the trash for good, with its versions. */
	public deleteForever(trashId: string): void {
		fs.rmSync(this.trashDir(trashId), { recursive: true, force: true });
	}

	/** Empties the trash. Returns how many documents went. */
	public emptyTrash(): number {
		const items = this.trashItems();
		for (const i of items) this.deleteForever(i.id);
		return items.length;
	}

	// ----- versions -----

	private versionsFolder(id: string): string {
		return this.store("versions", ...this.parts(id));
	}

	private versionFiles(id: string): string[] {
		try {
			return fs
				.readdirSync(path.join(this.root, STORE, "versions", ...this.parts(id)))
				.filter((n) => /^\d{8}T\d{6}Z-[sk]-[0-9a-f]{12}\./.test(n))
				.sort()
				.reverse();
		} catch {
			return [];
		}
	}

	/**
	 * Notes a state of a document as a version of it. `kept`: a point of its own (the document as
	 * it was opened, or as it was before a restore), which later saves never take the place of.
	 * Without it: a save. Saves within ten minutes of each other are one version, the last of them,
	 * so that saving often does not fill the history. A state that is the newest version already
	 * is not noted twice (asked to be kept, that version is, from then on). Returns whether a
	 * version was written or marked.
	 */
	public snapshot(id: string, bytes: Buffer, options: { kept?: boolean; now?: number } = {}): boolean {
		const { type } = this.existing(id);
		const now = options.now ?? Date.now();
		const dir = this.versionsFolder(id);
		const files = this.versionFiles(id);
		const hash = hashOf(bytes);
		const newest = files[0];
		if (newest && newest.split("-")[2].startsWith(hash)) {
			// It is the newest version already. Asked to be kept, and so far only one of a row of saves,
			// it becomes a point of its own: the next save must not take its place.
			if (!options.kept || newest.split("-")[1] === "k") return false;
			fs.renameSync(path.join(dir, newest), path.join(dir, newest.replace("-s-", "-k-")));
			return true;
		}
		fs.mkdirSync(dir, { recursive: true });
		// (the newest is a save of the last ten minutes: this save is that version's new state)
		const started = newest ? Date.parse(newest.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z.*$/, "$1-$2-$3T$4:$5:$6Z")) : NaN;
		const sameRow = !options.kept && !!newest && newest.split("-")[1] === "s" && now - started < VERSION_WINDOW && now >= started;
		const name = `${sameRow ? newest.split("-")[0] : stamp(now)}-${options.kept ? "k" : "s"}-${hash}${type.ending}`;
		fs.writeFileSync(path.join(dir, name), bytes);
		if (sameRow && newest !== name) fs.rmSync(path.join(dir, newest), { force: true });
		for (const old of this.versionFiles(id).slice(MAX_VERSIONS)) fs.rmSync(path.join(dir, old), { force: true });
		return true;
	}

	/** The versions of a document, the newest first. */
	public versions(id: string): Version[] {
		const dir = path.join(this.root, STORE, "versions", ...this.parts(id));
		return this.versionFiles(id)
			.map((key) => {
				try {
					const stat = fs.lstatSync(path.join(dir, key));
					return stat.isFile() ? { key, at: stat.mtimeMs, size: stat.size, kept: key.split("-")[1] === "k" } : undefined;
				} catch {
					return undefined;
				}
			})
			.filter((v): v is Version => !!v);
	}

	public versionBytes(id: string, key: string): Buffer {
		if (!this.versionFiles(id).includes(key)) throw new LibraryError("That version is not kept any more.");
		const file = path.join(this.versionsFolder(id), key);
		if (!fs.lstatSync(file).isFile()) throw new LibraryError("That version is not kept any more.");
		return fs.readFileSync(file);
	}

	/**
	 * Makes a version the document again. What the document is now is kept as a version first, so
	 * that going back can itself be gone back on.
	 */
	public restoreVersion(id: string, key: string, now = Date.now()): void {
		const bytes = this.versionBytes(id, key);
		const { file } = this.existing(id);
		this.snapshot(id, fs.readFileSync(file), { kept: true, now });
		// (into the file that is there, which `existing` has seen to be a plain file and no link)
		fs.writeFileSync(file, bytes, { flag: "r+" });
		fs.truncateSync(file, bytes.length);
	}

	// ----- pictures -----

	private thumbFile(id: string): string {
		const parts = this.parts(id);
		return this.store("thumbs", ...parts.slice(0, -1), `${parts[parts.length - 1]}.png`);
	}

	/** Keeps a picture of a document as it was just saved. */
	public setThumb(id: string, png: Buffer): void {
		this.existing(id);
		const file = this.thumbFile(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, png);
	}

	/** When the picture kept of a document was made, if it is of the document as it is now (`modified`); else 0. */
	private pictured(id: string, modified: number): number {
		try {
			const t = fs.lstatSync(path.join(this.root, STORE, "thumbs", ...this.parts(id).slice(0, -1), `${this.parts(id).pop()}.png`));
			return t.isFile() && t.mtimeMs + 1000 >= modified ? t.mtimeMs : 0;
		} catch {
			return 0;
		}
	}

	/** The picture kept of a document, when it is of the document as it is now (not of an older state). */
	public thumb(id: string): Buffer | undefined {
		try {
			const { stat } = this.existing(id);
			const file = this.thumbFile(id);
			const t = fs.lstatSync(file);
			// (a document changed since, by another program: the picture is of what it was)
			if (!t.isFile() || t.mtimeMs + 1000 < stat.mtimeMs) return undefined;
			return fs.readFileSync(file);
		} catch {
			return undefined;
		}
	}

	/** The picture that went to the trash with a document. */
	public trashThumb(trashId: string): Buffer | undefined {
		try {
			const file = path.join(this.trashDir(trashId), "thumb.png");
			return fs.lstatSync(file).isFile() ? fs.readFileSync(file) : undefined;
		} catch {
			return undefined;
		}
	}
}
