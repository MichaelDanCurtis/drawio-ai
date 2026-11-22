// Model names with versions, and the user's shape folders and libraries (Settings → Shapes).
// Run from standalone/: node --test test/settings-polish.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const { versionedName } = require("../src/main/modelNames");
const { shapeLibraries, imageSize } = require("../src/main/shapeLocations");

test("model names: a version the agent reports is added to a bare family name", () => {
	assert.equal(versionedName("Opus", "opus", "Opus 4.7 · Most capable"), "Opus 4.7");
	assert.equal(versionedName("Sonnet", "claude-sonnet-4-5-20250929", ""), "Sonnet 4.5");
	assert.equal(versionedName("Opus 4.8", "opus", "Opus 4.8 with 1M context"), "Opus 4.8", "already versioned");
	assert.equal(versionedName("Default (recommended)", "default", "Opus 4.8 with 1M context"), "Default (recommended)", "not a family name");
	assert.equal(versionedName("Haiku", "haiku", undefined), "Haiku", "nothing to go on");
	assert.equal(versionedName("gpt-5", "gpt-5", "x"), "gpt-5");
});

test("shape folders: SVG and PNG files become palette images; links out of the folder are skipped", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drawai-shapes-test-"));
	fs.mkdirSync(path.join(dir, "network"));
	fs.writeFileSync(path.join(dir, "network", "load_balancer.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64"><rect width="128" height="64"/></svg>');
	const png = Buffer.alloc(33);
	png.write("\x89PNG\r\n\x1a\n", 0, "latin1");
	png.writeUInt32BE(13, 8);
	png.write("IHDR", 12, "latin1");
	png.writeUInt32BE(200, 16);
	png.writeUInt32BE(100, 20);
	fs.writeFileSync(path.join(dir, "server.png"), png);
	fs.writeFileSync(path.join(dir, "notes.txt"), "not a shape");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "drawai-outside-"));
	fs.writeFileSync(path.join(outside, "secret.svg"), "<svg/>");
	fs.symlinkSync(path.join(outside, "secret.svg"), path.join(dir, "linked.svg"));
	const lib = path.join(dir, "..", path.basename(dir) + "-lib.xml");
	fs.writeFileSync(lib, '<mxlibrary>[{"data":"data:image/png;base64,AAA","w":40,"h":40,"title":"x"}]</mxlibrary>');

	const libs = await shapeLibraries([
		{ path: dir, name: "My shapes", enabled: true },
		{ path: lib, enabled: true },
		{ path: path.join(dir, "missing"), enabled: true },
		{ path: dir, enabled: false },
	]);
	assert.equal(libs.length, 3, "disabled locations are left out");
	const [folder, xml, missing] = libs;
	assert.equal(folder.kind, "images");
	assert.equal(folder.title, "My shapes");
	assert.deepEqual(folder.images.map((i) => i.title).sort(), ["network/load balancer", "server"]);
	const lb = folder.images.find((i) => i.title === "network/load balancer");
	assert.deepEqual([lb.w, lb.h], [64, 32], "scaled to at most 64 px, aspect kept");
	assert.ok(lb.data.startsWith("data:image/svg+xml;base64,"));
	assert.equal(xml.kind, "xml");
	assert.match(xml.xml, /mxlibrary/);
	assert.equal(missing.kind, "missing");
});

test("image sizes: SVG width/height, viewBox, PNG header, default", () => {
	assert.deepEqual(imageSize(Buffer.from('<svg width="30px" height="20" xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"), { w: 30, h: 20 });
	assert.deepEqual(imageSize(Buffer.from('<svg viewBox="0 0 10 40"/>'), "image/svg+xml"), { w: 10, h: 40 });
	assert.deepEqual(imageSize(Buffer.from("<svg/>"), "image/svg+xml"), { w: 64, h: 64 });
});
