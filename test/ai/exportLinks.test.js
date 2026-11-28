// drawio_export on this computer's disk: an export is never written through a symbolic link
// (src/features/ai/exportDiagram.ts). Everything happens in a temporary folder.
// Run: node --test test/ai/exportLinks.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

// (the paths here are written the POSIX way, and making a link needs a special right on Windows)
const skip = process.platform === "win32" ? "links and paths as on macOS and Linux" : false;

class Uri {
	constructor(p) {
		this.path = p;
		this.fsPath = p;
		this.scheme = "file";
		this.authority = "";
	}
	static file(p) {
		return new Uri(p.replace(/\\/g, "/"));
	}
	static joinPath(u, ...segs) {
		return new Uri(path.posix.normalize([u.path, ...segs].join("/")));
	}
	with({ path: p }) {
		return new Uri(p ?? this.path);
	}
	toString() {
		return `file://${this.path}`;
	}
}

let workspaceFolder;
let dialogAnswer;
const dialogs = [];
/** How the file system answers a question about a link: as VS Code does (it says so), or as one that follows it and says nothing. */
let reportsLinks = true;
/** Writes that went through VS Code's file API, which follows links: there must be none for a disk. */
const throughVsCode = [];
/** Runs after the last look VS Code's API has at the path, right before the folders are made and the file is written. */
let beforeFolders = () => {};

class WorkspaceEdit {
	constructor() {
		this.ops = [];
	}
	createFile(uri, options) {
		this.ops.push({ uri, options });
	}
}
const notFound = () => Object.assign(new Error("not found"), { code: "FileNotFound" });
const vscodeStub = {
	Uri,
	WorkspaceEdit,
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	window: {
		showWarningMessage: async (message) => {
			dialogs.push(message);
			return dialogAnswer;
		},
	},
	workspace: {
		getWorkspaceFolder: () => workspaceFolder,
		asRelativePath: (u) => (workspaceFolder ? u.path.replace(workspaceFolder.uri.path + "/", "") : u.path),
		fs: {
			stat: async (u) => {
				const type = (s) => (s.isDirectory() ? 2 : s.isFile() ? 1 : 0);
				let own;
				try {
					own = fs.lstatSync(u.fsPath);
				} catch {
					throw notFound();
				}
				if (!own.isSymbolicLink()) return { type: type(own), size: own.size };
				let behind;
				try {
					behind = fs.statSync(u.fsPath);
				} catch {
					// a link to nothing: VS Code reports the link, with no type behind it
					if (reportsLinks) return { type: 64, size: 0 };
					throw notFound();
				}
				return { type: type(behind) | (reportsLinks ? 64 : 0), size: behind.size };
			},
			writeFile: async (u, data) => {
				throughVsCode.push(u.path);
				fs.writeFileSync(u.fsPath, data);
			},
			createDirectory: async (u) => {
				beforeFolders();
				fs.mkdirSync(u.fsPath, { recursive: true });
			},
		},
		applyEdit: async (edit) => {
			for (const { uri, options } of edit.ops) {
				throughVsCode.push(uri.path);
				if (fs.existsSync(uri.fsPath) && !options.overwrite) return false;
				fs.writeFileSync(uri.fsPath, options.contents);
			}
			return true;
		},
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const { exportDiagramToWorkspace } = require(path.resolve(__dirname, "../../src/features/ai/exportDiagram.ts"));

const MINE = "the user's own file";

/**
 * A workspace folder with a diagram in it, and beside it a folder that is not the workspace's,
 * with a file of the user's in it. `inWorkspace: false`: the diagram is open with no folder open.
 */
function setUp({ inWorkspace = true } = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "drawio-export-links-"));
	const ws = path.join(base, "ws");
	const outside = path.join(base, "outside");
	fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
	fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
	fs.writeFileSync(path.join(ws, "docs", "arch.drawio"), "<mxfile/>");
	const victim = path.join(outside, "notes.txt");
	fs.writeFileSync(victim, MINE);

	workspaceFolder = inWorkspace ? { uri: new Uri(ws) } : undefined;
	dialogAnswer = undefined;
	dialogs.length = 0;
	throughVsCode.length = 0;
	reportsLinks = true;
	beforeFolders = () => {};

	const made = [];
	let during = () => {};
	const make = (bytes) => {
		made.push(bytes);
		during();
		return Buffer.from(bytes);
	};
	const editor = {
		uri: new Uri(path.join(ws, "docs", "arch.drawio")),
		getUriWithExtension: (ext) => new Uri(path.join(ws, "docs", "arch" + ext)),
		drawioClient: {
			exportVsdx: async () => ({ data: make("PK-vsdx"), pages: 1, shapes: 1, connectors: 0, images: 0, warnings: [] }),
			exportPdf: async () => ({ data: make("%PDF-"), pages: 1, warnings: [] }),
			getXml: async () => make("<mxfile/>").toString(),
			export: async (ext) => make(`image ${ext}`),
		},
	};
	return {
		ws,
		outside,
		victim,
		editor,
		made,
		whileExporting: (fn) => (during = fn),
		export: (request) => exportDiagramToWorkspace(editor, request),
		/** Nothing of the user's outside the workspace was touched, and nothing was put there. */
		untouched() {
			assert.equal(fs.readFileSync(victim, "utf8"), MINE);
			assert.deepEqual(fs.readdirSync(outside).sort(), ["dir", "notes.txt"]);
			assert.deepEqual(fs.readdirSync(path.join(outside, "dir")), []);
		},
		done: () => fs.rmSync(base, { recursive: true, force: true }),
	};
}

/** Once with a file system that says what is a link, as VS Code does, and once with one that does not. */
function eitherWay(fn) {
	return async () => {
		for (const reports of [true, false]) {
			const f = setUp();
			reportsLinks = reports;
			try {
				await fn(f, reports);
			} finally {
				f.done();
			}
		}
	};
}

test("on a disk: an ordinary export is written as before, by the writer that follows no link", { skip }, async () => {
	const f = setUp();
	try {
		const file = path.join(f.ws, "docs", "arch.vsdx");
		const r = await f.export({ format: "vsdx" });
		assert.equal(r.summary, "Exported docs/arch.vsdx");
		assert.equal(JSON.parse(r.text).path, "docs/arch.vsdx");
		assert.equal(fs.readFileSync(file, "utf8"), "PK-vsdx");

		// a file that is there: not replaced unasked, nor when the user says no
		fs.writeFileSync(file, "an earlier export");
		fs.chmodSync(file, 0o600);
		await assert.rejects(f.export({ format: "vsdx" }), /already exists.*overwrite: true/);
		await assert.rejects(f.export({ format: "vsdx", overwrite: true }), /chose not to replace docs\/arch\.vsdx/);
		assert.equal(fs.readFileSync(file, "utf8"), "an earlier export");
		assert.equal(dialogs.length, 1);
		// replaced when they say yes: the same file, so who may read it stays as it was
		dialogAnswer = "Replace";
		await f.export({ format: "vsdx", overwrite: true });
		assert.equal(fs.readFileSync(file, "utf8"), "PK-vsdx");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);

		// folders that are not there are made, and a new file needs no question
		dialogs.length = 0;
		await f.export({ format: "png", path: "out/deep/new" });
		assert.equal(fs.readFileSync(path.join(f.ws, "out", "deep", "new.png"), "utf8"), "image .png");
		assert.equal(dialogs.length, 0);
		// a .drawio beside the .drawio is a copy; the diagram itself and other diagrams are never replaced
		await f.export({ format: "drawio" });
		assert.equal(fs.readFileSync(path.join(f.ws, "docs", "arch-copy.drawio"), "utf8"), "<mxfile/>");
		await assert.rejects(f.export({ format: "drawio", path: "docs/ARCH.drawio", overwrite: true }), /open diagram itself/);
		fs.writeFileSync(path.join(f.ws, "docs", "other.drawio.svg"), "<svg/>");
		await assert.rejects(f.export({ format: "svg", path: "docs/other.drawio.svg", overwrite: true }), /never replace diagrams/);
		assert.equal(fs.readFileSync(path.join(f.ws, "docs", "arch.drawio"), "utf8"), "<mxfile/>");
		assert.equal(fs.readFileSync(path.join(f.ws, "docs", "other.drawio.svg"), "utf8"), "<svg/>");
		// a path that leaves the workspace by its text, and one that goes through a file
		await assert.rejects(f.export({ format: "pdf", path: "../outside/a" }), /inside the workspace folder/);
		await assert.rejects(f.export({ format: "pdf", path: "docs/arch.drawio/a" }), /a part of its path is a file, not a folder/);

		assert.deepEqual(throughVsCode, [], "a file on a disk is not written through VS Code's file API, which follows links");
		f.untouched();
	} finally {
		f.done();
	}
});

test(
	"on a disk: a link under the export's name is refused, to a file outside or to nothing",
	{ skip },
	eitherWay(async (f, reports) => {
		const refusal = (shown) => (reports ? new RegExp(`${shown.replace(/\./g, "\\.")} is a symbolic link; exports are not written through links`) : /is a link to another file, and an export is not written through a link/);
		dialogAnswer = "Replace";

		fs.symlinkSync(f.victim, path.join(f.ws, "docs", "arch.pdf"));
		await assert.rejects(f.export({ format: "pdf" }), refusal("docs/arch.pdf"));
		await assert.rejects(f.export({ format: "pdf", overwrite: true }), refusal("docs/arch.pdf"));

		// a link to nothing: a plain write would make the file it points at
		fs.symlinkSync(path.join(f.outside, "not-there.svg"), path.join(f.ws, "docs", "arch.svg"));
		await assert.rejects(f.export({ format: "svg" }), refusal("docs/arch.svg"));
		await assert.rejects(f.export({ format: "svg", overwrite: true }), refusal("docs/arch.svg"));

		assert.deepEqual(dialogs, [], "the user is not asked about a link");
		assert.deepEqual(f.made, [], "refused before the export is made");
		assert.deepEqual(throughVsCode, []);
		f.untouched();
	})
);

test(
	"on a disk: a linked folder on the way is refused, whether it leads outside or nowhere",
	{ skip },
	eitherWay(async (f, reports) => {
		fs.symlinkSync(path.join(f.outside, "dir"), path.join(f.ws, "linked"));
		const out = reports ? /^Error: linked is a symbolic link; exports are not written through links\.$/ : /is reached through a symbolic link that leads out of the workspace folder; exports are not written through links\.$/;
		await assert.rejects(f.export({ format: "vsdx", path: "linked/out" }), out);
		await assert.rejects(f.export({ format: "vsdx", path: "linked/deeper/out" }), out);

		// a link to a folder that is not there: making the folder would make it outside
		fs.symlinkSync(path.join(f.outside, "nowhere"), path.join(f.ws, "gone"));
		const nowhere = reports ? /^Error: gone is a symbolic link/ : /is reached through a symbolic link that leads nowhere; exports are not written through links\.$/;
		await assert.rejects(f.export({ format: "vsdx", path: "gone/out" }), nowhere);
		await assert.rejects(f.export({ format: "vsdx", path: "gone/deeper/out" }), nowhere);

		assert.deepEqual(f.made, [], "refused before the export is made");
		assert.deepEqual(throughVsCode, []);
		f.untouched();
	})
);

test("on a disk: a link that stays inside the workspace is refused as before", { skip }, async () => {
	const f = setUp();
	try {
		fs.symlinkSync(path.join(f.ws, "docs"), path.join(f.ws, "alias"));
		await assert.rejects(f.export({ format: "vsdx", path: "alias/out" }), /^Error: alias is a symbolic link/);
		assert.deepEqual(fs.readdirSync(path.join(f.ws, "docs")), ["arch.drawio"]);
	} finally {
		f.done();
	}
});

test("on a disk: with no folder open the diagram's own folder is the limit", { skip }, async () => {
	for (const reports of [true, false]) {
		const f = setUp({ inWorkspace: false });
		reportsLinks = reports;
		try {
			const docs = path.join(f.ws, "docs");
			await f.export({ format: "pdf", path: "sub/a" });
			assert.equal(fs.readFileSync(path.join(docs, "sub", "a.pdf"), "utf8"), "%PDF-");
			fs.symlinkSync(path.join(f.outside, "dir"), path.join(docs, "linked"));
			await assert.rejects(f.export({ format: "pdf", path: "linked/a" }), reports ? /linked is a symbolic link/ : /leads out of the diagram's folder/);
			fs.symlinkSync(f.victim, path.join(docs, "arch.png"));
			await assert.rejects(f.export({ format: "png", overwrite: true }), reports ? /arch\.png is a symbolic link/ : /is a link to another file/);
			await assert.rejects(f.export({ format: "pdf", path: "../a" }), /inside the diagram's folder/);
			assert.deepEqual(throughVsCode, []);
			f.untouched();
		} finally {
			f.done();
		}
	}
});

test(
	"on a disk: a file or a link that appears while the export is made is not written over or through",
	{ skip },
	eitherWay(async (f) => {
		const file = path.join(f.ws, "docs", "arch.vsdx");
		// a file that someone else made meanwhile stays theirs
		f.whileExporting(() => fs.writeFileSync(file, "someone else's"));
		await assert.rejects(f.export({ format: "vsdx" }), /arch\.vsdx appeared while the export was made\. Nothing was written\./);
		assert.equal(fs.readFileSync(file, "utf8"), "someone else's");

		// a link under the new file's name
		fs.rmSync(file);
		f.whileExporting(() => fs.symlinkSync(f.victim, file));
		await assert.rejects(f.export({ format: "vsdx" }), /is a symbolic link|is a link to another file/);

		// the file the user agreed to replace becomes a link
		fs.rmSync(file);
		fs.writeFileSync(file, "an earlier export");
		dialogAnswer = "Replace";
		f.whileExporting(() => {
			fs.rmSync(file);
			fs.symlinkSync(f.victim, file);
		});
		await assert.rejects(f.export({ format: "vsdx", overwrite: true }), /is a symbolic link|is a link to another file/);

		assert.deepEqual(throughVsCode, []);
		f.untouched();
	})
);

test("on a disk: what changes after VS Code's own last look at the path is still not followed", { skip }, async () => {
	const f = setUp();
	try {
		const file = path.join(f.ws, "docs", "arch.vsdx");
		const once = (fn) => {
			beforeFolders = () => {
				beforeFolders = () => {};
				fn();
			};
		};
		// a link under the new file's name, to a file and to nothing
		once(() => fs.symlinkSync(f.victim, file));
		await assert.rejects(f.export({ format: "vsdx" }), /^Error: arch\.vsdx is a link to another file, and an export is not written through a link\. Export under another name\.$/);
		fs.rmSync(file);
		once(() => fs.symlinkSync(path.join(f.outside, "not-there.vsdx"), file));
		await assert.rejects(f.export({ format: "vsdx" }), /is a link to another file/);
		fs.rmSync(file);

		// the file the user agreed to replace becomes a link, or one more name of another file
		dialogAnswer = "Replace";
		fs.writeFileSync(file, "an earlier export");
		once(() => {
			fs.rmSync(file);
			fs.symlinkSync(f.victim, file);
		});
		await assert.rejects(f.export({ format: "vsdx", overwrite: true }), /is a link to another file/);
		fs.rmSync(file);
		fs.writeFileSync(file, "an earlier export");
		once(() => {
			fs.rmSync(file);
			fs.linkSync(f.victim, file);
		});
		await assert.rejects(f.export({ format: "vsdx", overwrite: true }), /one of several names of the same file \(a hard link\)/);
		fs.rmSync(file);

		// a folder on the way becomes a link that leads outside
		fs.mkdirSync(path.join(f.ws, "out"));
		once(() => {
			fs.rmdirSync(path.join(f.ws, "out"));
			fs.symlinkSync(path.join(f.outside, "dir"), path.join(f.ws, "out"));
		});
		await assert.rejects(f.export({ format: "vsdx", path: "out/a" }), /is reached through a symbolic link that leads out of the workspace folder/);

		assert.deepEqual(throughVsCode, []);
		f.untouched();
	} finally {
		f.done();
	}
});
