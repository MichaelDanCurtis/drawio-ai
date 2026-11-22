// draw.io shortcut text → accelerators shown in the system menu bar.
// Run from standalone/: node --test test/shortcuts.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/ts");
const { toAccelerator } = require("../src/main/shortcuts");

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
