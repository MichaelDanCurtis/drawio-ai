// Unit tests for opening files from other tools: format detection, where the new
// diagram goes (never over an existing file), and the drawio_import tool.
// The conversion itself runs in draw.io and is covered by plugin.e2e.test.js.
// Run: node --test test/ai/import.test.js
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

class Uri {
	constructor(p, scheme = "file") {
		this.path = p;
		this.scheme = scheme;
		this.authority = "";
	}
	static file(p) {
		return new Uri(p.replace(/\\/g, "/").replace(/^([a-zA-Z]):/, "/$1:"));
	}
	static joinPath(u, ...segs) {
		return new Uri(path.posix.normalize([u.path, ...segs].join("/")), u.scheme);
	}
	with({ path: p }) {
		return new Uri(p ?? this.path, this.scheme);
	}
	toString() {
		return `${this.scheme}://${this.path}`;
	}
}

let workspaceFolders;
const files = new Map();
const symlinks = new Set();
const commands = [];
/** Files that appear between the free-name check and the write, as if another process created them. */
const appearOnWrite = new Map();

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
	window: {},
	commands: { executeCommand: async (...args) => void commands.push(args) },
	workspace: {
		get workspaceFolders() {
			return workspaceFolders;
		},
		getWorkspaceFolder: (u) => workspaceFolders?.find((f) => u.path.startsWith(f.uri.path + "/")),
		getConfiguration: () => ({ get: (_k, d) => d }),
		asRelativePath: (u) => {
			const f = workspaceFolders?.find((w) => u.path.startsWith(w.uri.path + "/"));
			return f ? u.path.slice(f.uri.path.length + 1) : u.path;
		},
		applyEdit: async (edit) => {
			for (const { uri, options } of edit.ops) {
				if (appearOnWrite.has(uri.path)) {
					files.set(uri.path, appearOnWrite.get(uri.path));
					appearOnWrite.delete(uri.path);
				}
				if (files.has(uri.path) && !options.overwrite) return false;
				files.set(uri.path, Buffer.from(options.contents));
			}
			return true;
		},
		fs: {
			stat: async (u) => {
				const dir = [...files.keys()].some((f) => f.startsWith(u.path + "/"));
				if (symlinks.has(u.path)) return { type: (dir ? 2 : 1) | 64, size: 0 };
				if (dir) return { type: 2, size: 0 };
				if (!files.has(u.path)) throw Object.assign(new Error("not found"), { code: "FileNotFound" });
				return { type: 1, size: files.get(u.path).length };
			},
			readFile: async (u) => {
				if (!files.has(u.path)) throw new Error("not found");
				return new Uint8Array(files.get(u.path));
			},
		},
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const { detectImportFormat, diagramUriFor, importDiagramFile, importForAgent, describeImport, withoutLinks } = require(
	path.resolve(__dirname, "../../src/features/importDiagram.ts")
);
const { DiagramToolbox } = require(path.resolve(__dirname, "../../src/features/ai/DiagramToolbox.ts"));

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const ZIP = Buffer.from("PK\x03\x04rest of a package", "latin1");
const CFB = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
const DIAGRAM = '<mxfile host="65bd71144e"><diagram name="P" id="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';

/** Stands in for the draw.io webview. */
function fakeDrawio(result = {}) {
	const calls = [];
	const run = async (forUri, task) => {
		calls.push({ forUri: forUri.path });
		return task({
			importDiagram: async (format, fileName, data) => {
				calls.push({ format, fileName, bytes: data.length });
				if (result.error) throw new Error(result.error);
				return { xml: DIAGRAM, kind: "diagram", pages: 1, shapes: 1, connectors: 0, warnings: [], ...result };
			},
		});
	};
	return { run, calls };
}

beforeEach(() => {
	files.clear();
	symlinks.clear();
	appearOnWrite.clear();
	commands.length = 0;
	workspaceFolders = [{ uri: new Uri("/ws") }];
});

test("formats are told apart by extension and content", () => {
	assert.equal(detectImportFormat("net.vsdx", ZIP), "visio");
	assert.equal(detectImportFormat("Net.VSSX", ZIP), "visio");
	assert.equal(detectImportFormat("old.vsd", CFB), "visio");
	assert.equal(detectImportFormat("old.vst", CFB), "visio");
	// A binary drawing that was renamed still goes to the Visio importer.
	assert.equal(detectImportFormat("renamed.vsdx", CFB), "visio");
	assert.throws(() => detectImportFormat("fake.vsdx", Buffer.from("<html>")), /fake\.vsdx is not a Visio file/);
	assert.throws(() => detectImportFormat("old.vdx", Buffer.from("<?xml version='1.0'?><VisioDocument/>")), /Visio 2003-2010 XML.*\.vsdx/);

	assert.equal(detectImportFormat("a.gliffy", fixture("import.gliffy")), "gliffy");
	assert.equal(detectImportFormat("export.json", fixture("import.gliffy")), "gliffy");
	assert.equal(detectImportFormat("a.graphml", fixture("import.graphml")), "graphml");
	assert.equal(detectImportFormat("yed-export.xml", fixture("import.graphml")), "graphml");
	assert.equal(detectImportFormat("lucid.json", fixture("import-lucidchart.json")), "lucidchart");
	assert.equal(detectImportFormat("state.json", Buffer.from('﻿  {"state":"{\\"Properties\\":{}}"}')), "lucidchart");
	assert.equal(detectImportFormat("board.json", fixture("import-miro.json")), "miro");
	assert.equal(detectImportFormat("team.CSV", fixture("import.csv")), "csv");
	assert.equal(detectImportFormat("rows.csv", Buffer.from("a,b\n1,2\n")), "csv");
	assert.throws(() => detectImportFormat("package.json", Buffer.from('{"name":"x"}')), /not a file draw\.io can convert.*Visio.*Gliffy.*GraphML.*Lucidchart and Miro.*CSV/);
	assert.throws(() => detectImportFormat("notes.txt", Buffer.from("hello")), /not a file draw\.io can convert/);
});

test("text from the converted file cannot become a link in a notification", () => {
	const crafted = "Object 5 ([Show details](command:workbench.action.terminal.sendSequence?%7B%7D)) has no mapping";
	assert.equal(withoutLinks(crafted), "Object 5 ([Show details] (command:workbench.action.terminal.sendSequence?%7B%7D)) has no mapping");
	assert.equal(withoutLinks("a]   (b) and [c](d)"), "a] (b) and [c] (d)");
	assert.equal(withoutLinks("Converted net.vsdx (1 page)."), "Converted net.vsdx (1 page).");
});

test("the new diagram goes next to the source, under the first free name", () => {
	const src = new Uri("/ws/docs/network.v2.vsdx");
	assert.equal(diagramUriFor(src, 1).path, "/ws/docs/network.v2.drawio");
	assert.equal(diagramUriFor(src, 2).path, "/ws/docs/network.v2-2.drawio");
	assert.equal(diagramUriFor(new Uri("/ws/Makefile"), 1).path, "/ws/Makefile.drawio");
});

test("importing writes a formatted .drawio file and never replaces an existing one", async () => {
	files.set("/ws/docs/net.vsdx", ZIP);
	const drawio = fakeDrawio({ warnings: ["Object 5 has no mapping."] });
	const r = await importDiagramFile(new Uri("/ws/docs/net.vsdx"), drawio.run);
	assert.equal(r.target.path, "/ws/docs/net.drawio");
	assert.deepEqual(drawio.calls, [{ forUri: "/ws/docs/net.vsdx" }, { format: "visio", fileName: "net.vsdx", bytes: ZIP.length }]);
	assert.deepEqual(r.warnings, ["Object 5 has no mapping."]);
	// Formatted like the editor formats the files it saves.
	const written = files.get("/ws/docs/net.drawio").toString();
	assert.match(written, /^<mxfile host="65bd71144e">\r\n {4}<diagram name="P" id="p">/);
	assert.match(written, /\n\s+<mxCell id="a" value="A" vertex="1" parent="1">/);
	assert.equal(describeImport(r), "Converted net.vsdx from Visio to net.drawio (1 page, 1 shape, 0 connectors).");

	// The first diagram stays as it is; the next conversion gets the next free name.
	files.set("/ws/docs/net.drawio", Buffer.from("edited by hand"));
	const again = await importDiagramFile(new Uri("/ws/docs/net.vsdx"), fakeDrawio().run);
	assert.equal(again.target.path, "/ws/docs/net-2.drawio");
	assert.equal(files.get("/ws/docs/net.drawio").toString(), "edited by hand");

	// A file that appears between the check and the write is not replaced either.
	appearOnWrite.set("/ws/docs/net-3.drawio", Buffer.from("someone else's"));
	const raced = await importDiagramFile(new Uri("/ws/docs/net.vsdx"), fakeDrawio().run);
	assert.equal(raced.target.path, "/ws/docs/net-4.drawio");
	assert.equal(files.get("/ws/docs/net-3.drawio").toString(), "someone else's");

	const stencil = await importDiagramFile(new Uri("/ws/docs/net.vsdx"), fakeDrawio({ kind: "stencil", shapes: 4, connectors: 1 }).run);
	assert.match(describeImport(stencil), /\(4 shapes of the stencil laid out on one page\)/);
});

test("nothing is written when the file cannot be read or converted", async () => {
	files.set("/ws/bad.vsdx", Buffer.from("not a zip"));
	files.set("/ws/ok.graphml", fixture("import.graphml"));
	const drawio = fakeDrawio();
	await assert.rejects(importDiagramFile(new Uri("/ws/bad.vsdx"), drawio.run), /bad\.vsdx is not a Visio file/);
	await assert.rejects(importDiagramFile(new Uri("/ws/missing.vsdx"), drawio.run), /missing\.vsdx was not found/);
	await assert.rejects(importDiagramFile(new Uri("/ws/ok.graphml"), fakeDrawio({ error: "draw.io's converter failed: boom" }).run), /converter failed: boom/);
	assert.equal(drawio.calls.length, 0, "unreadable files never reach draw.io");
	assert.deepEqual([...files.keys()].filter((f) => f.endsWith(".drawio")), []);
});

test("drawio_import: converts workspace files only, opens the result unless asked not to", async () => {
	files.set("/ws/docs/flow.gliffy", fixture("import.gliffy"));
	const drawio = fakeDrawio({ pages: 2, shapes: 5, connectors: 2, warnings: ["w1"] });
	const r = await importForAgent({ path: "docs/flow.gliffy" }, drawio.run, () => undefined);
	assert.equal(r.summary, "Imported docs/flow.drawio");
	assert.deepEqual(JSON.parse(r.text), {
		path: "docs/flow.drawio",
		source: "docs/flow.gliffy",
		format: "gliffy",
		kind: "diagram",
		pages: 2,
		shapes: 5,
		connectors: 2,
		warnings: ["w1"],
		opened: true,
	});
	assert.deepEqual(commands.map((c) => [c[0], c[1].path, c[2]]), [["vscode.openWith", "/ws/docs/flow.drawio", "drawio-ai-text"]]);

	commands.length = 0;
	const quiet = JSON.parse((await importForAgent({ path: "/ws/docs/flow.gliffy", open: false }, drawio.run, () => undefined)).text);
	assert.equal(quiet.path, "docs/flow-2.drawio");
	assert.equal(quiet.opened, false);
	assert.equal(commands.length, 0);

	const fail = (p) => importForAgent({ path: p }, drawio.run, () => undefined);
	await assert.rejects(fail(""), /path is required/);
	await assert.rejects(fail("../outside.vsdx"), /inside the workspace/);
	await assert.rejects(fail("docs/../../etc/x.vsdx"), /inside the workspace/);
	await assert.rejects(fail("/etc/passwd"), /inside the workspace/);
	await assert.rejects(fail("docs/nope.vsdx"), /docs\/nope\.vsdx was not found/);

	// Files are not read through links that could point outside the workspace.
	files.set("/ws/linked/net.vsdx", ZIP);
	symlinks.add("/ws/linked");
	files.set("/ws/docs/link.vsdx", ZIP);
	symlinks.add("/ws/docs/link.vsdx");
	await assert.rejects(fail("linked/net.vsdx"), /linked is a symbolic link; files are not read through links/);
	await assert.rejects(fail("docs/link.vsdx"), /docs\/link\.vsdx is a symbolic link/);

	// Several workspace folders: the first one that has the file.
	workspaceFolders = [{ uri: new Uri("/ws") }, { uri: new Uri("/other") }];
	files.set("/other/b.graphml", fixture("import.graphml"));
	assert.equal(JSON.parse((await importForAgent({ path: "b.graphml", open: false }, drawio.run, () => undefined)).text).format, "graphml");
	assert.ok(files.has("/other/b.drawio"));
});

test("drawio_import: without a workspace, only the open diagram's folder is used", async () => {
	workspaceFolders = undefined;
	files.set("/tmp/d/x.graphml", fixture("import.graphml"));
	const drawio = fakeDrawio();
	await assert.rejects(importForAgent({ path: "x.graphml" }, drawio.run, () => undefined), /Open a folder or a draw\.io diagram first/);
	const r = JSON.parse((await importForAgent({ path: "x.graphml", open: false }, drawio.run, () => new Uri("/tmp/d"))).text);
	assert.equal(r.path, "/tmp/d/x.drawio");
	await assert.rejects(importForAgent({ path: "../y.graphml" }, drawio.run, () => new Uri("/tmp/d")), /inside the diagram's folder/);
});

test("drawio_import needs no open diagram, unlike the editing tools", async () => {
	files.set("/ws/a.graphml", fixture("import.graphml"));
	const drawio = fakeDrawio();
	const toolbox = new DiagramToolbox(() => undefined, undefined, undefined, undefined, (request) =>
		importForAgent(request, drawio.run, () => undefined)
	);
	const ok = await toolbox.invoke("drawio_import", { path: "a.graphml", open: false });
	assert.equal(ok.isError, undefined, ok.text);
	assert.equal(JSON.parse(ok.text).path, "a.drawio");
	const bad = await toolbox.invoke("drawio_import", JSON.stringify({ path: "../a.graphml" }));
	assert.equal(bad.isError, true);
	assert.match(bad.text, /^Error: path must be inside the workspace/);
	const edit = await toolbox.invoke("drawio_get_diagram", {});
	assert.match(edit.text, /No draw\.io diagram is open/);
});
