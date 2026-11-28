// Excalidraw drawings on disk: which files are one, what is in them, and what may be written.
// Nothing of Electron here: the tests load this file as it is.
//
// A drawing is Excalidraw's JSON ({ type: "excalidraw", version, source, elements, appState, files }),
// in a `.excalidraw` file, or carried inside a PNG or SVG that Excalidraw exported with its scene
// embedded (those open as drawings too, and are saved back as the picture they are).
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export type ExcalidrawFormat = "json" | "png" | "svg";

export const EXCALIDRAW_MIME: Record<ExcalidrawFormat, string> = {
	json: "application/vnd.excalidraw+json",
	png: "image/png",
	svg: "image/svg+xml",
};

/** What a drawing saved by this app names as where it came from (Excalidraw's `source`). */
export const EXCALIDRAW_SOURCE = "https://github.com/MichaelDanCurtis/drawio-ai";

/** The name of a scene inside a PNG's text chunk and an SVG's payload comment. */
const SCENE_TYPE = "application/vnd.excalidraw+json";
/** A scene, unpacked, is never larger than this (a guard against a few bytes that unpack without end). */
const MAX_SCENE_BYTES = 512 * 1024 * 1024;

/** Something that is not an Excalidraw drawing, said so that it can be shown to the user as it is. */
export class ExcalidrawFileError extends Error {}

export interface ExcalidrawScene {
	type: "excalidraw";
	version: number;
	source?: string;
	elements: unknown[];
	appState: Record<string, unknown>;
	files: Record<string, unknown>;
}

/** The format a file of this name is written in; undefined for a name that is no drawing's. */
export function formatForPath(file: string): ExcalidrawFormat | undefined {
	const name = file.toLowerCase();
	if (name.endsWith(".excalidraw")) return "json";
	if (name.endsWith(".png")) return "png";
	if (name.endsWith(".svg")) return "svg";
	return undefined;
}

/** The file's name without what marks it as a drawing or a picture ("a.excalidraw.png" → "a"). */
export function baseName(name: string): string {
	return name.replace(/(\.excalidraw)?\.(png|svg)$/i, "").replace(/\.excalidraw$/i, "");
}

/**
 * Whether a file is an Excalidraw drawing, and in which format: by its name for `.excalidraw`,
 * by what it carries for a picture (`read` is only called for a PNG or SVG). draw.io's own
 * editable pictures (`.drawio.png`, `.drawio.svg`) are never Excalidraw's.
 */
export function sniffExcalidraw(file: string, read: () => Buffer): ExcalidrawFormat | undefined {
	const format = formatForPath(file);
	if (!format || format === "json") return format;
	if (/\.(drawio|dio)\.(png|svg)$/i.test(file)) return undefined;
	let bytes: Buffer;
	try {
		bytes = read();
	} catch {
		return undefined;
	}
	if (format === "png") return pngText(bytes) === undefined ? undefined : "png";
	return SVG_PAYLOAD.test(bytes.toString("utf8")) ? "svg" : undefined;
}

/** The scene in a file's bytes. Throws ExcalidrawFileError (with `name` in the message) when there is none. */
export function readScene(format: ExcalidrawFormat, bytes: Buffer, name = "The file"): ExcalidrawScene {
	if (format === "json") return parseScene(bytes.toString("utf8"), name);
	let text: string | undefined;
	try {
		text = format === "png" ? embeddedInPng(bytes) : embeddedInSvg(bytes.toString("utf8"));
	} catch (e) {
		if (e instanceof ExcalidrawFileError) throw e;
		throw new ExcalidrawFileError(`${name} carries an Excalidraw drawing that cannot be read (${(e as Error).message}).`);
	}
	if (text === undefined) throw new ExcalidrawFileError(`${name} is a picture without an Excalidraw drawing in it. Export from Excalidraw with the scene embedded to get one that opens for editing.`);
	return parseScene(text, name);
}

/** Excalidraw's JSON, checked. Throws ExcalidrawFileError for anything else. */
export function parseScene(text: string, name = "The file"): ExcalidrawScene {
	const data = parseRaw(text, name);
	return {
		type: "excalidraw",
		version: typeof data.version === "number" ? data.version : 1,
		...(typeof data.source === "string" ? { source: data.source } : {}),
		elements: data.elements ?? [],
		appState: data.appState ?? {},
		files: data.files ?? {},
	};
}

/** The JSON as it is in the file, once it is known to be a drawing (what Excalidraw itself takes for one, and no less). */
function parseRaw(text: string, name: string): { version?: unknown; source?: unknown; elements?: unknown[] | null; appState?: Record<string, unknown> | null; files?: Record<string, unknown> | null } {
	let data: any;
	try {
		data = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		throw new ExcalidrawFileError(`${name} is not an Excalidraw drawing: it is ${text.trim() ? "not JSON" : "empty"}.`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new ExcalidrawFileError(`${name} is not an Excalidraw drawing.`);
	if (data.type === "excalidrawlib") throw new ExcalidrawFileError(`${name} is an Excalidraw library, not a drawing.`);
	if (data.type !== "excalidraw") throw new ExcalidrawFileError(`${name} is not an Excalidraw drawing${typeof data.type === "string" ? ` (it says it is "${data.type.slice(0, 40)}")` : ""}.`);
	const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
	if (data.elements !== undefined && data.elements !== null && !Array.isArray(data.elements)) throw new ExcalidrawFileError(`${name} is damaged: its elements are not a list.`);
	if (data.appState !== undefined && data.appState !== null && !isObject(data.appState)) throw new ExcalidrawFileError(`${name} is damaged: its settings are not an object.`);
	if (data.files !== undefined && data.files !== null && !isObject(data.files)) throw new ExcalidrawFileError(`${name} is damaged: its pictures are not an object.`);
	return data;
}

/**
 * What the editor serialized for a `.excalidraw` file, checked before it replaces the user's file:
 * Excalidraw's JSON in full (type, version, source, elements, appState, files). Returns the text
 * to write, as Excalidraw wrote it.
 */
export function sceneTextToWrite(serialized: unknown): string {
	if (typeof serialized !== "string") throw new ExcalidrawFileError("The editor did not hand over the drawing.");
	const data = parseRaw(serialized, "What the editor handed over");
	if (typeof data.version !== "number" || typeof data.source !== "string" || !data.elements || !data.appState || !data.files) throw new ExcalidrawFileError("What the editor handed over is not a whole drawing.");
	return serialized;
}

/**
 * A picture the editor exported, checked before it is written: it must be a picture of that format
 * and carry the drawing. `elements` is how many elements the editor says the drawing holds: the
 * picture may carry fewer (Excalidraw leaves out elements too small to see when it writes an SVG),
 * never more, and never none of a drawing that has some. Returns the bytes to write.
 */
export function pictureToWrite(format: "png" | "svg", data: unknown, elements: number): Buffer {
	const bytes = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : typeof data === "string" ? Buffer.from(data, "utf8") : undefined;
	if (!bytes || bytes.length === 0) throw new ExcalidrawFileError("The editor did not hand over the picture.");
	if (format === "svg" && !/<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf8"))) throw new ExcalidrawFileError("What the editor handed over is not an SVG picture.");
	const scene = readScene(format, bytes, "The exported picture");
	if (scene.elements.length > elements || (elements > 0 && scene.elements.length === 0)) throw new ExcalidrawFileError(`The exported picture carries ${scene.elements.length} elements, the drawing has ${elements}.`);
	return bytes;
}

// ----- a file an agent asked for (excalidraw_export) -----
//
// An agent names where an export goes, or it goes beside the drawing under the drawing's name.
// Either way the name may already be something in that folder, put there by whoever made the
// folder (a checked-out repository, an unpacked archive). A link under that name would send the
// export to another file altogether, while the user is asked about the name they see. So an
// export is never written through a link: one in the way is refused, and the file is made in a
// way that does not follow one that appears meanwhile.

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
 * ExcalidrawFileError when it cannot go there: the name is a link, or is not a file, or the
 * folder is not there.
 */
export function exportTarget(target: string): { exists: boolean; real: string } {
	const name = path.basename(target);
	let folder: string;
	try {
		folder = fs.realpathSync(path.dirname(target));
	} catch {
		throw new ExcalidrawFileError(`The folder ${path.dirname(target)} does not exist.`);
	}
	const real = path.join(folder, name);
	let there: fs.Stats | undefined;
	try {
		there = fs.lstatSync(real);
	} catch {
		there = undefined;
	}
	if (there?.isSymbolicLink()) throw new ExcalidrawFileError(`${name} is a link to another file, and an export is not written through a link. Export under another name.`);
	if (there && !there.isFile()) throw new ExcalidrawFileError(`${name} is not a file.`);
	return { exists: !!there, real };
}

/**
 * Writes an export to where `exportTarget` said it lands (`real`). `replace`: a file is there
 * and the user agreed to replace it; otherwise there must be none. A link is never followed:
 * a new file is made only if nothing has that name (not even a link that appeared meanwhile),
 * and a file is replaced by putting the new one in its place whole, whatever is there by then.
 */
export function writeExport(real: string, bytes: Buffer, replace: boolean): void {
	if (!replace) {
		try {
			fs.writeFileSync(real, bytes, { flag: "wx" });
		} catch (e: any) {
			if (e?.code === "EEXIST") throw new ExcalidrawFileError(`${path.basename(real)} appeared while the export was made. Nothing was written.`);
			throw e;
		}
		return;
	}
	const still = exportTarget(real);
	if (!still.exists) return writeExport(real, bytes, false);
	const temp = path.join(path.dirname(real), `.${path.basename(real)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	fs.writeFileSync(temp, bytes, { flag: "wx" });
	try {
		fs.renameSync(temp, real);
	} catch (e) {
		fs.rmSync(temp, { force: true });
		throw e;
	}
}

// ----- a scene inside a picture (as Excalidraw's data/image.ts and data/encode.ts write it) -----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The text of the PNG's chunk that holds an Excalidraw scene; undefined when it has none (or is no PNG). */
function pngText(bytes: Buffer): string | undefined {
	if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(at);
		const type = bytes.toString("latin1", at + 4, at + 8);
		const end = at + 8 + length;
		if (end + 4 > bytes.length) return undefined;
		if (type === "tEXt") {
			const data = bytes.subarray(at + 8, end);
			const zero = data.indexOf(0);
			if (zero > 0 && data.toString("latin1", 0, zero) === SCENE_TYPE) return data.toString("latin1", zero + 1);
		}
		if (type === "IEND") return undefined;
		at = end + 4;
	}
	return undefined;
}

function embeddedInPng(bytes: Buffer): string | undefined {
	const text = pngText(bytes);
	return text === undefined ? undefined : unpack(text);
}

const SVG_PAYLOAD = /<!-- payload-type:application\/vnd\.excalidraw\+json -->/;

function embeddedInSvg(svg: string): string | undefined {
	if (!SVG_PAYLOAD.test(svg)) return undefined;
	const payload = /<!-- payload-start -->\s*([\s\S]+?)\s*<!-- payload-end -->/.exec(svg);
	if (!payload) throw new ExcalidrawFileError("The drawing inside the SVG is cut off.");
	const version = /<!-- payload-version:(\d+) -->/.exec(svg)?.[1] ?? "1";
	const decoded = Buffer.from(payload[1], "base64");
	// (version 1 held the text as UTF-8; since then it is a string of bytes, one character each)
	return unpack(version === "1" ? decoded.toString("utf8") : decoded.toString("latin1"));
}

/** A scene as it is packed into a picture: `{ encoded, encoding: "bstring", compressed }`, or (long ago) the scene itself. */
function unpack(text: string): string {
	let data: any;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ExcalidrawFileError("The drawing inside the picture is damaged.");
	}
	if (!data || typeof data !== "object" || !("encoded" in data)) return text;
	if (data.encoding !== "bstring" || typeof data.encoded !== "string") throw new ExcalidrawFileError("The drawing inside the picture is packed in a way this version does not read.");
	const packed = Buffer.from(data.encoded, "latin1");
	if (!data.compressed) return packed.toString("utf8");
	return zlib.inflateSync(packed, { maxOutputLength: MAX_SCENE_BYTES }).toString("utf8");
}
