// draw.io shortcut text → accelerators shown in the system menu bar.
// Run from standalone/: node --test test/shortcuts.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/ts");
const { documentKey, toAccelerator } = require("../src/main/shortcuts");

test("draw.io shortcuts become menu accelerators", () => {
	assert.equal(toAccelerator("⌘+⇧+K", true), "Cmd+Shift+K");
	assert.equal(toAccelerator("⌘+Z", true), "Cmd+Z");
	assert.equal(toAccelerator("Ctrl+Shift+L", false), "Ctrl+Shift+L");
	assert.equal(toAccelerator("⌘+⌥+⇧+F", true), "Cmd+Alt+Shift+F");
	assert.equal(toAccelerator("Delete / Backspace", true), "Delete");
	assert.equal(toAccelerator("⌘++", true), "Cmd+Plus");
	assert.equal(toAccelerator("F2", true), "F2");
	assert.equal(toAccelerator("⌘+Enter", true), "Cmd+Enter");
	assert.equal(toAccelerator("⌘+Mousewheel", true), undefined);
	assert.equal(toAccelerator("Alt+Shift+Drag", true), undefined);
	assert.equal(toAccelerator(undefined, true), undefined);
});

test("the keys that are the document's in an Excalidraw window", () => {
	const key = (k, mods = {}) => ({ type: "keyDown", key: k, meta: false, control: false, alt: false, shift: false, ...mods });
	// macOS: Cmd
	assert.equal(documentKey(key("s", { meta: true }), true), "save");
	assert.equal(documentKey(key("S", { meta: true, shift: true }), true), "saveAs");
	assert.equal(documentKey(key("o", { meta: true }), true), "open");
	assert.equal(documentKey(key("E", { meta: true, shift: true }), true), "exportPng");
	assert.equal(documentKey(key("s", { control: true }), true), undefined);
	assert.equal(documentKey(key("s", { meta: true, control: true }), true), undefined);
	// elsewhere: Ctrl
	assert.equal(documentKey(key("s", { control: true }), false), "save");
	assert.equal(documentKey(key("s", { meta: true }), false), undefined);
	// AltGr (Ctrl+Alt) types a letter, and is no command
	assert.equal(documentKey(key("s", { control: true, alt: true }), false), undefined);
	// everything else is Excalidraw's, or text
	assert.equal(documentKey(key("s"), true), undefined);
	assert.equal(documentKey(key("e", { meta: true }), true), undefined);
	assert.equal(documentKey(key("o", { meta: true, shift: true }), true), undefined);
	assert.equal(documentKey(key("z", { meta: true }), true), undefined);
	assert.equal(documentKey({ ...key("s", { meta: true }), type: "keyUp" }, true), undefined);
	assert.equal(documentKey({ ...key("s", { meta: true }), isAutoRepeat: true }, true), undefined);
});
