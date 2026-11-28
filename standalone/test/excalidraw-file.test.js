// Excalidraw drawings on disk: which files are one, reading them, what is written, and what is refused.
// Run from standalone/: node --test test/excalidraw-file.test.js
// The two pictures in test/fixtures/excalidraw were exported by the app itself (Excalidraw 0.18.1,
// scene embedded): the sample with one more element added in each, seven in all.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
require("./helpers/ts");
const { baseName, EXCALIDRAW_SOURCE, ExcalidrawFileError, formatForPath, parseScene, pictureToWrite, readScene, sceneTextToWrite, sniffExcalidraw } = require("../src/main/excalidrawFile");

const fixture = (name) => path.join(__dirname, "fixtures/excalidraw", name);
const sample = fs.readFileSync(fixture("sample.excalidraw"));
const png = fs.readFileSync(fixture("exported.excalidraw.png"));
const svg = fs.readFileSync(fixture("exported.excalidraw.svg"));
const never = () => {
	throw new Error("the file should not have been read");
};
const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof ExcalidrawFileError && pattern.test(e.message), `expected a refusal matching ${pattern}`);

/** A PNG chunk (the reader does not check the CRC, so it is left at zero). */
function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, data, Buffer.alloc(4)]);
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG with the given text chunks (keyword → text) and no picture to speak of. */
function pngWith(texts) {
	return Buffer.concat([SIGNATURE, chunk("IHDR", Buffer.alloc(13)), ...Object.entries(texts).map(([k, v]) => chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "latin1")]))), chunk("IEND", Buffer.alloc(0))]);
}
const SCENE = JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [{ id: "a", type: "rectangle" }, { id: "é", type: "text", text: "naïve ✓" }], appState: {}, files: {} });
/** The scene packed the way Excalidraw packs it into a picture. */
const packed = (text, compressed) => JSON.stringify({ version: "1", encoding: "bstring", compressed, encoded: (compressed ? zlib.deflateSync(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8")).toString("latin1") });
const svgWith = (payload, version) => `<svg xmlns="http://www.w3.org/2000/svg"><!-- svg-source:excalidraw --><metadata><!-- payload-type:application/vnd.excalidraw+json -->${version ? `<!-- payload-version:${version} -->` : ""}<!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>`;

test("a file's name says how a drawing is written", () => {
	assert.equal(formatForPath("/a/b/plan.excalidraw"), "json");
	assert.equal(formatForPath("Plan.EXCALIDRAW"), "json");
	assert.equal(formatForPath("plan.excalidraw.png"), "png");
	assert.equal(formatForPath("plan.png"), "png");
	assert.equal(formatForPath("plan.excalidraw.svg"), "svg");
	assert.equal(formatForPath("plan.drawio"), undefined);
	assert.equal(formatForPath("plan.excalidrawlib"), undefined);
	assert.equal(formatForPath("plan"), undefined);
	assert.equal(baseName("plan.excalidraw"), "plan");
	assert.equal(baseName("plan.excalidraw.png"), "plan");
	assert.equal(baseName("plan.svg"), "plan");
	assert.equal(baseName("Untitled"), "Untitled");
});

test("which files are Excalidraw drawings", () => {
	// by its name, without a look inside
	assert.equal(sniffExcalidraw("plan.excalidraw", never), "json");
	// a picture, by what it carries
	assert.equal(sniffExcalidraw("exported.png", () => png), "png");
	assert.equal(sniffExcalidraw("exported.svg", () => svg), "svg");
	assert.equal(sniffExcalidraw("photo.png", () => pngWith({})), undefined);
	assert.equal(sniffExcalidraw("photo.png", () => pngWith({ Software: "something" })), undefined);
	assert.equal(sniffExcalidraw("logo.svg", () => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`)), undefined);
	assert.equal(sniffExcalidraw("not-a-png.png", () => Buffer.from("hello")), undefined);
	// draw.io's own editable pictures are draw.io's, and are not read here
	assert.equal(sniffExcalidraw("plan.drawio.png", never), undefined);
	assert.equal(sniffExcalidraw("plan.dio.svg", never), undefined);
	// anything else is not looked at
	assert.equal(sniffExcalidraw("plan.drawio", never), undefined);
	assert.equal(sniffExcalidraw("notes.txt", never), undefined);
	// a picture that cannot be read is not taken for a drawing
	assert.equal(
		sniffExcalidraw("gone.png", () => {
			throw new Error("ENOENT");
		}),
		undefined
	);
});

test("reading a .excalidraw file", () => {
	const scene = readScene("json", sample, "sample.excalidraw");
	assert.equal(scene.type, "excalidraw");
	assert.equal(scene.version, 2);
	assert.equal(scene.source, "https://excalidraw.com");
	assert.deepEqual(scene.elements.map((e) => e.type), ["rectangle", "text", "ellipse", "text", "arrow"]);
	assert.equal(scene.appState.viewBackgroundColor, "#ffffff");
	assert.deepEqual(scene.files, {});
	// what Excalidraw itself takes for a drawing is taken for one: parts that are missing are empty
	assert.deepEqual(parseScene(`{"type":"excalidraw"}`), { type: "excalidraw", version: 1, elements: [], appState: {}, files: {} });
	assert.equal(parseScene(`﻿{"type":"excalidraw","elements":[]}`).elements.length, 0);
	assert.deepEqual(parseScene(`{"type":"excalidraw","elements":null,"appState":null,"files":null}`).elements, []);
});

test("what is not an Excalidraw drawing is refused, by name", () => {
	refused(() => parseScene("", "empty.excalidraw"), /^empty\.excalidraw is not an Excalidraw drawing: it is empty\.$/);
	refused(() => parseScene("   \n", "blank.excalidraw"), /it is empty/);
	refused(() => parseScene("<mxfile></mxfile>", "diagram.excalidraw"), /^diagram\.excalidraw is not an Excalidraw drawing: it is not JSON\.$/);
	refused(() => parseScene("[]"), /^The file is not an Excalidraw drawing\.$/);
	refused(() => parseScene("null"), /not an Excalidraw drawing/);
	refused(() => parseScene(`"excalidraw"`), /not an Excalidraw drawing/);
	refused(() => parseScene(`{"type":"excalidrawlib","version":2,"libraryItems":[]}`, "shapes.excalidraw"), /^shapes\.excalidraw is an Excalidraw library, not a drawing\.$/);
	refused(() => parseScene(`{"type":"mxfile","elements":[]}`), /it says it is "mxfile"/);
	refused(() => parseScene(`{"elements":[]}`), /not an Excalidraw drawing\.$/);
	refused(() => parseScene(`{"type":"excalidraw","elements":{}}`), /its elements are not a list/);
	refused(() => parseScene(`{"type":"excalidraw","elements":"none"}`), /its elements are not a list/);
	refused(() => parseScene(`{"type":"excalidraw","elements":[],"appState":[]}`), /its settings are not an object/);
	refused(() => parseScene(`{"type":"excalidraw","elements":[],"files":"x"}`), /its pictures are not an object/);
});

test("reading the drawing inside an exported PNG and SVG", () => {
	for (const [format, bytes] of [["png", png], ["svg", svg]]) {
		const scene = readScene(format, bytes, `exported.${format}`);
		assert.equal(scene.type, "excalidraw");
		assert.equal(scene.version, 2);
		assert.equal(scene.source, EXCALIDRAW_SOURCE);
		assert.equal(scene.elements.length, 7, format);
		assert.ok(scene.elements.some((e) => e.id === "box-plan" && e.type === "rectangle"), format);
		assert.ok(scene.elements.some((e) => e.id === "e2e-diamond" && e.type === "diamond"), format);
		assert.ok(scene.elements.some((e) => e.type === "text" && e.text === "Sketch"), format);
	}
});

test("every way a drawing has been packed into a picture is read", () => {
	const ids = (scene) => scene.elements.map((e) => e.id);
	// compressed (what Excalidraw writes today), not compressed, and the scene as it is (long ago)
	assert.deepEqual(ids(readScene("png", pngWith({ "application/vnd.excalidraw+json": packed(SCENE, true) }))), ["a", "é"]);
	assert.deepEqual(ids(readScene("png", pngWith({ "application/vnd.excalidraw+json": packed(SCENE, false) }))), ["a", "é"]);
	assert.deepEqual(ids(readScene("png", pngWith({ Software: "x", "application/vnd.excalidraw+json": JSON.stringify({ type: "excalidraw", elements: [{ id: "a", type: "rectangle" }] }) }))), ["a"]);
	assert.equal(readScene("png", pngWith({ "application/vnd.excalidraw+json": packed(SCENE, true) })).elements[1].text, "naïve ✓");
	// an SVG: version 2 holds a string of bytes, version 1 (and none named) held UTF-8
	assert.deepEqual(ids(readScene("svg", Buffer.from(svgWith(Buffer.from(packed(SCENE, true), "latin1").toString("base64"), 2)))), ["a", "é"]);
	assert.equal(readScene("svg", Buffer.from(svgWith(Buffer.from(packed(SCENE, true), "latin1").toString("base64"), 2))).elements[1].text, "naïve ✓");
	assert.deepEqual(ids(readScene("svg", Buffer.from(svgWith(Buffer.from(SCENE, "utf8").toString("base64"), 1)))), ["a", "é"]);
	assert.deepEqual(ids(readScene("svg", Buffer.from(svgWith(Buffer.from(SCENE, "utf8").toString("base64"))))), ["a", "é"]);
});

test("a picture without a drawing, or with a damaged one, is refused", () => {
	refused(() => readScene("png", pngWith({}), "photo.png"), /^photo\.png is a picture without an Excalidraw drawing in it\./);
	refused(() => readScene("png", Buffer.from("not a png"), "x.png"), /without an Excalidraw drawing/);
	refused(() => readScene("svg", Buffer.from("<svg></svg>"), "logo.svg"), /^logo\.svg is a picture without an Excalidraw drawing in it\./);
	// cut off before the drawing: there is none to find
	refused(() => readScene("png", png.subarray(0, png.length - 4000), "cut.png"), /without an Excalidraw drawing/);
	// the drawing is there and cannot be read
	refused(() => readScene("png", pngWith({ "application/vnd.excalidraw+json": "{{{" }), "bad.png"), /The drawing inside the picture is damaged/);
	refused(() => readScene("png", pngWith({ "application/vnd.excalidraw+json": JSON.stringify({ encoded: "xx", encoding: "base64" }) })), /packed in a way this version does not read/);
	refused(() => readScene("png", pngWith({ "application/vnd.excalidraw+json": JSON.stringify({ encoded: "not deflated", encoding: "bstring", compressed: true }) }), "bad.png"), /^bad\.png carries an Excalidraw drawing that cannot be read/);
	refused(() => readScene("svg", Buffer.from("<svg><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->abc</svg>"), "cut.svg"), /The drawing inside the SVG is cut off/);
	// what is inside is not a drawing
	refused(() => readScene("png", pngWith({ "application/vnd.excalidraw+json": packed(`{"type":"excalidrawlib"}`, true) }), "lib.png"), /^lib\.png is an Excalidraw library, not a drawing\.$/);
});

test("what is written for a .excalidraw file is Excalidraw's JSON, whole, as the editor wrote it", () => {
	const text = JSON.stringify({ type: "excalidraw", version: 2, source: EXCALIDRAW_SOURCE, elements: [{ id: "a", type: "rectangle" }], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2);
	assert.equal(sceneTextToWrite(text), text);
	// through a file and back
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-excalidraw-test-"));
	try {
		const file = path.join(dir, "written.excalidraw");
		fs.writeFileSync(file, sceneTextToWrite(text));
		assert.equal(sniffExcalidraw(file, never), "json");
		const back = readScene("json", fs.readFileSync(file), "written.excalidraw");
		assert.deepEqual(back, { type: "excalidraw", version: 2, source: EXCALIDRAW_SOURCE, elements: [{ id: "a", type: "rectangle" }], appState: { viewBackgroundColor: "#ffffff" }, files: {} });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// the user's file is never replaced by something that is not a whole drawing
	refused(() => sceneTextToWrite(undefined), /did not hand over the drawing/);
	refused(() => sceneTextToWrite({ type: "excalidraw" }), /did not hand over the drawing/);
	refused(() => sceneTextToWrite("Error: something went wrong"), /not JSON/);
	refused(() => sceneTextToWrite(`{"type":"excalidrawlib"}`), /library/);
	for (const missing of ["version", "source", "elements", "appState", "files"]) {
		const part = JSON.parse(text);
		delete part[missing];
		refused(() => sceneTextToWrite(JSON.stringify(part)), /not a whole drawing/);
	}
});

test("a picture is only written when it carries the drawing", () => {
	assert.ok(pictureToWrite("png", new Uint8Array(png), 7).equals(png));
	assert.ok(pictureToWrite("svg", svg.toString("utf8"), 7).equals(svg));
	// Excalidraw leaves elements too small to see out of an SVG: fewer inside than the drawing has is still the drawing
	assert.ok(pictureToWrite("svg", svg.toString("utf8"), 9).equals(svg));
	// more inside than the drawing has, or none of a drawing that has some: not written
	refused(() => pictureToWrite("svg", svg.toString("utf8"), 6), /carries 7 elements, the drawing has 6/);
	refused(() => pictureToWrite("png", new Uint8Array(pngWith({ "application/vnd.excalidraw+json": packed(`{"type":"excalidraw","elements":[]}`, true) })), 3), /carries 0 elements, the drawing has 3/);
	assert.equal(pictureToWrite("png", new Uint8Array(pngWith({ "application/vnd.excalidraw+json": packed(`{"type":"excalidraw","elements":[]}`, true) })), 0).length > 0, true);
	// not a picture of that kind, no drawing in it, or nothing at all
	refused(() => pictureToWrite("png", new Uint8Array(pngWith({})), 0), /without an Excalidraw drawing/);
	refused(() => pictureToWrite("png", svg.toString("utf8"), 7), /without an Excalidraw drawing/);
	refused(() => pictureToWrite("svg", "Error: canvas too big", 7), /not an SVG picture/);
	refused(() => pictureToWrite("png", new Uint8Array(0), 0), /did not hand over the picture/);
	refused(() => pictureToWrite("png", undefined, 0), /did not hand over the picture/);
	refused(() => pictureToWrite("svg", { outerHTML: "<svg/>" }, 0), /did not hand over the picture/);
});
