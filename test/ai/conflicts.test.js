// Unit tests for living alongside Draw.io Integration (hediet.vscode-drawio), the extension
// Draw.AI is forked from, and older Draw.AI builds.
// Run: node --test test/ai/conflicts.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const Module = require("module");
const path = require("path");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let settings = {};
const installed = new Set();
const shown = [];
const commands = [];
const registeredSchemes = [];
let tabGroups = [];
class Uri {
	constructor(p) {
		this.path = p;
		this.scheme = "file";
	}
}
const vscodeStub = {
	Uri,
	ConfigurationTarget: { Global: 1 },
	extensions: { getExtension: (id) => (installed.has(id) ? { id } : undefined) },
	workspace: {
		getConfiguration: (section) => ({
			get: (key) => settings[`${section}.${key}`],
			update: async (key, value) => void (settings[`${section}.${key}`] = value),
		}),
		registerFileSystemProvider: (scheme) => (registeredSchemes.push(scheme), { dispose() {} }),
	},
	window: {
		showWarningMessage: (message, ...items) => (shown.push({ kind: "warning", message, items }), Promise.resolve(undefined)),
		showErrorMessage: (message, ...items) => (shown.push({ kind: "error", message, items }), Promise.resolve(undefined)),
		showInformationMessage: () => Promise.resolve(undefined),
		get tabGroups() {
			return {
				all: tabGroups,
				close: async (tab) => {
					for (const g of tabGroups) g.tabs = g.tabs.filter((t) => t !== tab);
				},
			};
		},
	},
	commands: { executeCommand: async (...args) => void commands.push(args), registerCommand: () => ({ dispose() {} }) },
	EventEmitter: class {
		constructor() {
			this.event = () => ({ dispose() {} });
		}
		fire() {}
	},
	FileType: { File: 1, Directory: 2 },
	FileSystemError: { FileNotFound: () => new Error("not found") },
	Disposable: class {
		constructor(f) {
			this.dispose = f;
		}
	},
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === "vscode") return "vscode";
	return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const conflicts = require(path.join(root, "src/features/conflictingExtensions.ts"));
const context = (id = "AiLuxis.draw-ai") => {
	const state = new Map();
	return { extension: { id }, globalState: { get: (k) => state.get(k), update: async (k, v) => void state.set(k, v) } };
};
const reset = () => {
	settings = {};
	installed.clear();
	shown.length = 0;
	commands.length = 0;
	tabGroups = [];
};

test("nothing Draw.AI registers collides with Draw.io Integration's names", () => {
	// VS Code fails the activation of the second extension that registers a file system scheme.
	const { DrawioFileSystemController } = require(path.join(root, "src/vscode-utils/VirtualFileSystemProvider.ts"));
	new DrawioFileSystemController();
	assert.deepEqual(registeredSchemes, ["drawio-ai"]);
	for (const e of pkg.contributes.customEditors) assert.doesNotMatch(e.viewType, /^hediet\./);
	for (const c of pkg.contributes.commands) assert.doesNotMatch(c.command, /^hediet\./);
	assert.ok(pkg.contributes.commands.some((c) => c.command === conflicts.USE_FOR_DIAGRAMS_COMMAND));
	// Every draw.io file pattern maps to one of Draw.AI's own editors.
	const ours = new Map(pkg.contributes.customEditors.filter((e) => e.priority === "default").flatMap((e) => e.selector.map((s) => [s.filenamePattern, e.viewType])));
	for (const [pattern, viewType] of Object.entries(conflicts.DRAWIO_EDITOR_ASSOCIATIONS)) {
		assert.equal(ours.get(pattern), viewType, pattern);
	}
});

test("Use Draw.AI for Diagram Files: sets the associations, keeps others, reopens clean diagrams only", async () => {
	reset();
	settings["workbench.editorAssociations"] = { "*.md": "vscode.markdown.preview.editor", "*.drawio": "hediet.vscode-drawio-text" };
	assert.equal(conflicts.drawAiOpensDiagrams(), false);
	const clean = { input: { viewType: "hediet.vscode-drawio-text", uri: new Uri("/ws/a.drawio") }, isDirty: false };
	const png = { input: { viewType: "hediet.vscode-drawio", uri: new Uri("/ws/b.drawio.png") }, isDirty: false };
	const dirty = { input: { viewType: "hediet.vscode-drawio-text", uri: new Uri("/ws/c.drawio") }, isDirty: true };
	const other = { input: { uri: new Uri("/ws/readme.md") }, isDirty: false };
	tabGroups = [{ viewColumn: 1, tabs: [clean, dirty, other] }, { viewColumn: 2, tabs: [png] }];

	assert.equal(conflicts.diagramOpenInOtherEditor().path, "/ws/a.drawio");
	assert.deepEqual(await conflicts.useDrawAiForDiagrams(), { reopened: 2, skippedDirty: 1 });
	assert.equal(settings["workbench.editorAssociations"]["*.md"], "vscode.markdown.preview.editor");
	assert.equal(conflicts.drawAiOpensDiagrams(), true);
	assert.deepEqual(
		commands.map(([id, uri, viewType, opts]) => [id, uri.path, viewType, opts.viewColumn]),
		[
			["vscode.openWith", "/ws/a.drawio", "drawio-ai-text", 1],
			["vscode.openWith", "/ws/b.drawio.png", "drawio-ai", 2],
		]
	);
	assert.deepEqual(tabGroups[0].tabs, [dirty, other], "the dirty diagram stays open");
});

test("the older array form of editorAssociations is understood", () => {
	reset();
	settings["workbench.editorAssociations"] = Object.entries(conflicts.DRAWIO_EDITOR_ASSOCIATIONS).map(([filenamePattern, viewType]) => ({ filenamePattern, viewType }));
	assert.equal(conflicts.drawAiOpensDiagrams(), true);
});

test("warnings: Draw.io Integration until Draw.AI opens diagrams; older builds always, but never this build", () => {
	reset();
	conflicts.warnAboutConflictingExtensions(context());
	assert.deepEqual(shown, [], "nothing else installed");

	installed.add("hediet.vscode-drawio");
	conflicts.warnAboutConflictingExtensions(context());
	assert.equal(shown.length, 1);
	assert.equal(shown[0].kind, "warning");
	assert.match(shown[0].message, /Draw\.io Integration \(hediet\.vscode-drawio\) is also enabled/);
	assert.deepEqual(shown[0].items, ["Use Draw.AI for Diagrams", "Show Draw.io Integration", "Don't Show Again"]);

	shown.length = 0;
	settings["workbench.editorAssociations"] = { ...conflicts.DRAWIO_EDITOR_ASSOCIATIONS };
	conflicts.warnAboutConflictingExtensions(context());
	assert.deepEqual(shown, [], "already set up: no warning");

	installed.add("drawio-ai.vscode-drawio-ai");
	installed.add("drawio-ai.draw-ai");
	conflicts.warnAboutConflictingExtensions(context("drawio-ai.draw-ai"));
	assert.equal(shown.length, 1);
	assert.equal(shown[0].kind, "error");
	assert.match(shown[0].message, /drawio-ai\.vscode-drawio-ai/);
	assert.doesNotMatch(shown[0].message, /drawio-ai\.draw-ai[,)]/, "an extension never warns about itself");
});
