// Unit tests for the Visio export building blocks: ZIP writer, color and data URI
// handling, and where the drawio_export tool may write.
// Run: node --test test/ai/vsdx.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");
const { unzip } = require("./unzip");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

class Uri {
	constructor(p) {
		this.path = p;
		this.scheme = "file";
		this.authority = "";
	}
	static file(p) {
		return new Uri(p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, "/$1:"));
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
const files = new Map();
const symlinks = new Set();
let dialogAnswer;
const dialogs = [];
class WorkspaceEdit {
	constructor() {
		this.ops = [];
	}
	createFile(uri, options) {
		this.ops.push({ uri, options });
	}
}
const vscodeStub = {
	Uri,
	WorkspaceEdit,
	FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
	window: {
		showWarningMessage: async (message, options, ...items) => {
			dialogs.push({ message, modal: options?.modal, items });
			return dialogAnswer;
		},
	},
	workspace: {
		getWorkspaceFolder: () => workspaceFolder,
		getConfiguration: () => ({ get: (_k, d) => d }),
		asRelativePath: (u) => (workspaceFolder ? u.path.replace(workspaceFolder.uri.path + "/", "") : u.path),
		fs: {
			stat: async (u) => {
				const dir = [...files.keys()].some((f) => f.startsWith(u.path + "/"));
				if (symlinks.has(u.path)) return { type: (dir ? 2 : 1) | 64, size: 0 };
				if (dir) return { type: 2, size: 0 };
				if (!files.has(u.path)) throw Object.assign(new Error("not found"), { code: "FileNotFound" });
				return { type: 1, size: files.get(u.path).length };
			},
			writeFile: async (u, data) => void files.set(u.path, Buffer.from(data)),
			createDirectory: async () => {},
		},
		applyEdit: async (edit) => {
			for (const { uri, options } of edit.ops) {
				if (files.has(uri.path) && !options.overwrite) return false;
				files.set(uri.path, Buffer.from(options.contents));
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

const plugin = (p) => path.resolve(__dirname, "../../drawio-custom-plugins/src/vsdx", p);
const { createZip } = require(plugin("zip.ts"));
const { resolveColor } = require(plugin("colors.ts"));
const { parseDataUri } = require(plugin("images.ts"));
const { exportDiagramToWorkspace, resolveExportTarget } = require(path.resolve(__dirname, "../../src/features/ai/exportDiagram.ts"));

test("zip: entries round-trip; compressible ones are deflated, random ones stored", async () => {
	const text = Buffer.from("<Shape/>".repeat(500));
	const noise = crypto.randomBytes(2000);
	const zip = await createZip([
		{ name: "[Content_Types].xml", data: text },
		{ name: "visio/media/image1.png", data: noise },
		{ name: "empty.txt", data: new Uint8Array(0) },
	]);
	const files = unzip(Buffer.from(zip));
	assert.deepEqual(Object.keys(files), ["[Content_Types].xml", "visio/media/image1.png", "empty.txt"]);
	assert.ok(files["[Content_Types].xml"].data.equals(text));
	assert.equal(files["[Content_Types].xml"].method, 8);
	assert.ok(files["visio/media/image1.png"].data.equals(noise));
	assert.equal(files["visio/media/image1.png"].method, 0);
	assert.equal(files["empty.txt"].data.length, 0);
});

test("colors: draw.io's light-dark(), var(), hex, rgb and none resolve to Visio colors", () => {
	assert.equal(resolveColor("light-dark(#ffffff, var(--ge-dark-color, #121212))"), "#FFFFFF");
	assert.equal(resolveColor("light-dark(#ff0000,#00ff00)"), "#FF0000");
	assert.equal(resolveColor("light-dark(light-dark(#010203, #fff), #000)"), "#010203");
	assert.equal(resolveColor("var(--accent, #123456)"), "#123456");
	assert.equal(resolveColor("#abc"), "#AABBCC");
	assert.equal(resolveColor("#11223344"), "#112233");
	assert.equal(resolveColor("rgb(0, 128, 255)"), "#0080FF");
	assert.equal(resolveColor("rgba(10, 20, 30, 0.5)"), "#0A141E");
	assert.equal(resolveColor("rgba(0, 0, 0, 0)"), "none");
	assert.equal(resolveColor("none"), "none");
	assert.equal(resolveColor("default"), undefined);
	assert.equal(resolveColor(undefined), undefined);
	assert.equal(resolveColor("var(--only-a-variable)"), undefined);
});

test("data URIs: draw.io's style-safe base64 form, marked base64 and URI-encoded SVG", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
	const b64 = Buffer.from(svg).toString("base64");
	const decode = (uri) => {
		const { mime, data } = parseDataUri(uri);
		return [mime, Buffer.from(data).toString("utf8")];
	};
	assert.deepEqual(decode(`data:image/svg+xml,${b64}`), ["image/svg+xml", svg]);
	assert.deepEqual(decode(`data:image/svg+xml;base64,${b64}`), ["image/svg+xml", svg]);
	assert.deepEqual(decode(`data:image/svg+xml,${encodeURIComponent(svg)}`), ["image/svg+xml", svg]);
	assert.deepEqual(decode(`data:image/svg+xml;utf8,${svg}`), ["image/svg+xml", svg]);
	const png = parseDataUri("data:image/png;base64,iVBORw0KGgo=");
	assert.equal(png.mime, "image/png");
	assert.deepEqual([...png.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("drawio_export target: defaults next to the diagram and stays inside the workspace", () => {
	workspaceFolder = { uri: new Uri("/ws") };
	const diagram = new Uri("/ws/docs/arch.drawio");
	const withExt = (ext) => new Uri("/ws/docs/arch" + ext);
	const target = (format, p) => resolveExportTarget(diagram, withExt, format, p).path;

	assert.equal(target("vsdx", undefined), "/ws/docs/arch.vsdx");
	assert.equal(target("vsdx", "  "), "/ws/docs/arch.vsdx");
	assert.equal(target("vsdx", "out/arch"), "/ws/out/arch.vsdx");
	assert.equal(target("png", "out/arch.PNG"), "/ws/out/arch.PNG");
	assert.equal(target("svg", "out\\nested\\arch.svg"), "/ws/out/nested/arch.svg");
	assert.equal(target("vsdx", "/ws/exports/a.vsdx"), "/ws/exports/a.vsdx");
	assert.throws(() => target("vsdx", "../outside.vsdx"), /inside the workspace/);
	assert.throws(() => target("vsdx", "docs/../../outside"), /inside the workspace/);
	assert.throws(() => target("vsdx", "/etc/passwd"), /inside the workspace/);
	assert.throws(() => target("vsdx", "/wsx/a.vsdx"), /inside the workspace/);
	// Absolute paths are resolved before the check, so ".." cannot climb out.
	assert.throws(() => target("vsdx", "/ws/docs/../../etc/evil"), /inside the workspace/);
	assert.equal(target("vsdx", "/ws/docs/./../out/a"), "/ws/out/a.vsdx");
	// "Export as .drawio" next to a .drawio file writes a copy.
	assert.equal(target("drawio", undefined), "/ws/docs/arch-copy.drawio");

	// Windows: drive letters compare without case, ".." still cannot escape.
	workspaceFolder = { uri: new Uri("/c:/ws") };
	const winDiagram = new Uri("/c:/ws/arch.drawio");
	const win = (p) => resolveExportTarget(winDiagram, (ext) => new Uri("/c:/ws/arch" + ext), "vsdx", p).path;
	assert.equal(win("C:\\WS\\out\\a"), "/C:/WS/out/a.vsdx");
	assert.throws(() => win("C:/ws/../x"), /inside the workspace/);
	assert.throws(() => win("D:/ws/x"), /inside the workspace/);

	// Outside a workspace, the diagram's own folder is the limit.
	workspaceFolder = undefined;
	assert.equal(target("vsdx", "sub/a"), "/ws/docs/sub/a.vsdx");
	assert.throws(() => target("vsdx", "../a"), /diagram's folder/);
});

test("drawio_export: writes the Visio file, reports what was exported, never overwrites unasked", async () => {
	workspaceFolder = { uri: new Uri("/ws") };
	files.clear();
	const calls = [];
	const editor = {
		uri: new Uri("/ws/docs/arch.drawio"),
		getUriWithExtension: (ext) => new Uri("/ws/docs/arch" + ext),
		drawioClient: {
			exportVsdx: async (o) => {
				calls.push(o);
				return { data: Buffer.from("PK-vsdx"), pages: 2, shapes: 9, connectors: 3, images: 1, warnings: [] };
			},
			getXml: async () => "<mxfile/>",
			export: async (ext) => Buffer.from(`image ${ext}`),
		},
	};

	const r = await exportDiagramToWorkspace(editor, { format: "vsdx" });
	assert.equal(r.summary, "Exported docs/arch.vsdx");
	assert.deepEqual(JSON.parse(r.text), { path: "docs/arch.vsdx", format: "vsdx", bytes: 7, pages: 2, shapes: 9, connectors: 3, images: 1, warnings: [] });
	assert.deepEqual(calls, [{ currentPageOnly: false }]);
	assert.equal(files.get("/ws/docs/arch.vsdx").toString(), "PK-vsdx");

	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx" }), /already exists.*overwrite: true/);
	// overwrite: true still needs the user's yes, whatever surface called the tool.
	dialogs.length = 0;
	dialogAnswer = undefined;
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx", overwrite: true }), /chose not to replace docs\/arch\.vsdx/);
	assert.deepEqual(dialogs.map((d) => [d.modal, d.items]), [[true, ["Replace"]]]);
	assert.equal(calls.length, 1, "nothing is exported when the user declines");
	dialogAnswer = "Replace";
	await exportDiagramToWorkspace(editor, { format: "vsdx", overwrite: true, currentPageOnly: true });
	assert.deepEqual(calls[1], { currentPageOnly: true });
	// A new file needs no confirmation.
	dialogs.length = 0;
	await exportDiagramToWorkspace(editor, { format: "vsdx", path: "out/new", overwrite: true });
	assert.equal(dialogs.length, 0);

	await assert.rejects(exportDiagramToWorkspace(editor, { format: "drawio", path: "docs/ARCH.drawio", overwrite: true }), /open diagram itself/);
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "drawio", path: "docs/./sub/../arch", overwrite: true }), /open diagram itself/);
	await exportDiagramToWorkspace(editor, { format: "drawio" });
	assert.equal(files.get("/ws/docs/arch-copy.drawio").toString(), "<mxfile/>");
	// Other diagrams are never replaced, not even with overwrite.
	files.set("/ws/docs/other.drawio.svg", Buffer.from("<svg/>"));
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "svg", path: "docs/other.drawio.svg", overwrite: true }), /never replace diagrams/);
	assert.equal(files.get("/ws/docs/other.drawio.svg").toString(), "<svg/>");
	await exportDiagramToWorkspace(editor, { format: "drawio", path: "backup/arch" });
	assert.equal(files.get("/ws/backup/arch.drawio").toString(), "<mxfile/>");
	await exportDiagramToWorkspace(editor, { format: "png", path: "img/arch" });
	assert.equal(files.get("/ws/img/arch.png").toString(), "image .png");
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "pdf" }), /format must be one of: vsdx, svg, png, drawio/);
});

test("drawio_export: a file or link that appears while exporting is not written over or through", async () => {
	workspaceFolder = { uri: new Uri("/ws") };
	files.clear();
	symlinks.clear();
	let during = () => {};
	const editor = {
		uri: new Uri("/ws/docs/arch.drawio"),
		getUriWithExtension: (ext) => new Uri("/ws/docs/arch" + ext),
		drawioClient: {
			exportVsdx: async () => {
				during();
				return { data: Buffer.from("PK-new"), pages: 1, shapes: 1, connectors: 0, images: 0, warnings: [] };
			},
		},
	};
	// Another process creates the target while the diagram is being exported.
	during = () => files.set("/ws/docs/arch.vsdx", Buffer.from("someone else's"));
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx" }), /docs\/arch\.vsdx was created by something else while the diagram was being exported/);
	assert.equal(files.get("/ws/docs/arch.vsdx").toString(), "someone else's");

	// A replacement the user agreed to is still refused if the path became a link meanwhile.
	dialogAnswer = "Replace";
	during = () => symlinks.add("/ws/docs/arch.vsdx");
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx", overwrite: true }), /docs\/arch\.vsdx is a symbolic link/);
	assert.equal(files.get("/ws/docs/arch.vsdx").toString(), "someone else's");
	symlinks.clear();
	during = () => {};
	await exportDiagramToWorkspace(editor, { format: "vsdx", overwrite: true });
	assert.equal(files.get("/ws/docs/arch.vsdx").toString(), "PK-new");
});

test("drawio_export: never writes through a symbolic link inside the workspace", async () => {
	workspaceFolder = { uri: new Uri("/ws") };
	files.clear();
	symlinks.clear();
	files.set("/ws/linked/placeholder.txt", Buffer.from(""));
	files.set("/ws/docs/link.png", Buffer.from("old"));
	symlinks.add("/ws/linked");
	symlinks.add("/ws/docs/link.png");
	const written = [];
	const editor = {
		uri: new Uri("/ws/docs/arch.drawio"),
		getUriWithExtension: (ext) => new Uri("/ws/docs/arch" + ext),
		drawioClient: {
			exportVsdx: async () => ({ data: Buffer.from("PK"), pages: 1, shapes: 1, connectors: 0, images: 0, warnings: [] }),
			getXml: async () => "<mxfile/>",
			export: async (ext) => (written.push(ext), Buffer.from("png")),
		},
	};
	dialogAnswer = "Replace";
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx", path: "linked/out" }), /linked is a symbolic link/);
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "vsdx", path: "linked/deeper/out" }), /linked is a symbolic link/);
	await assert.rejects(exportDiagramToWorkspace(editor, { format: "png", path: "docs/link.png", overwrite: true }), /docs\/link\.png is a symbolic link/);
	assert.equal(files.get("/ws/docs/link.png").toString(), "old");
	assert.deepEqual(written, []);
	assert.ok(![...files.keys()].some((f) => f.startsWith("/ws/linked/out")));
	// Missing folders below the root are fine: they are created as real folders.
	await exportDiagramToWorkspace(editor, { format: "vsdx", path: "fresh/dir/out" });
	assert.equal(files.get("/ws/fresh/dir/out.vsdx").toString(), "PK");
	symlinks.clear();
});
