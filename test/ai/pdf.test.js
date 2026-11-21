// Unit tests for the PDF writer used by "Export to PDF" and drawio_export format "pdf".
// Run: node --test test/ai/pdf.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

require("ts-node").register({
	transpileOnly: true,
	compilerOptions: { module: "commonjs", target: "es2020" },
});

const { writePdf, rgbaToRgb, pdfString } = require("../../drawio-custom-plugins/src/pdf/pdfWriter");

function rgbImage(width, height, rgb) {
	const pixels = new Uint8Array(width * height * 3);
	for (let i = 0; i < pixels.length; i += 3) pixels.set(rgb, i);
	return { kind: "rgb", width, height, pixels };
}

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

test("writes a well-formed PDF whose xref points at every object", async () => {
	const pdf = await writePdf(
		[
			{ image: rgbImage(4, 3, [255, 0, 0]), widthPt: 300, heightPt: 225 },
			{ image: rgbImage(2, 2, [0, 0, 255]), widthPt: 150.5, heightPt: 150.5 },
		],
		{ title: "Architecture" }
	);
	const text = latin1(pdf);
	assert.ok(text.startsWith("%PDF-1.4\n"));
	assert.ok(text.endsWith("%%EOF\n"));

	const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
	assert.equal(text.slice(startxref, startxref + 4), "xref");
	const [, count] = /^xref\n0 (\d+)\n/.exec(text.slice(startxref)).map(Number);
	assert.equal(count, 4 + 2 * 3);
	const entries = text.slice(startxref).split("\n").slice(3, 3 + count - 1);
	entries.forEach((line, i) => {
		const offset = Number(line.slice(0, 10));
		assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`);
	});

	assert.match(text, /\/Count 2/);
	assert.match(text, /\/MediaBox \[0 0 300 225\]/);
	assert.match(text, /\/MediaBox \[0 0 150.5 150.5\]/);
	assert.match(text, /\/Title \(Architecture\)/);
});

test("image streams inflate back to the pixels, with a correct /Length", async () => {
	const image = rgbImage(5, 4, [10, 200, 30]);
	const pdf = await writePdf([{ image, widthPt: 10, heightPt: 8 }]);
	const text = latin1(pdf);
	const m = /\/Width 5 \/Height 4 [^>]*\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text);
	assert.ok(m, "image object with FlateDecode");
	const start = m.index + m[0].length;
	const length = Number(m[1]);
	assert.equal(text.slice(start + length, start + length + 10), "\nendstream");
	const inflated = zlib.inflateSync(Buffer.from(pdf.subarray(start, start + length)));
	assert.deepEqual(new Uint8Array(inflated), image.pixels);
});

test("JPEG images are embedded as they are", async () => {
	const data = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
	const pdf = await writePdf([{ image: { kind: "jpeg", width: 1, height: 1, data }, widthPt: 1, heightPt: 1 }]);
	const text = latin1(pdf);
	assert.match(text, /\/Filter \/DCTDecode \/Length 7 >>\nstream\n\xff\xd8\x01\x02\x03\xff\xd9\nendstream/);
});

test("refuses an empty document and mismatched pixel data", async () => {
	await assert.rejects(writePdf([]), /at least one page/);
	await assert.rejects(
		writePdf([{ image: { kind: "rgb", width: 2, height: 2, pixels: new Uint8Array(5) }, widthPt: 1, heightPt: 1 }]),
		/does not match/
	);
});

test("rgbaToRgb blends transparency onto white", () => {
	const rgb = rgbaToRgb(new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]));
	assert.deepEqual([...rgb], [255, 0, 0, 255, 255, 255, 127, 127, 127]);
});

test("pdfString escapes ASCII and encodes other text as UTF-16", () => {
	assert.equal(pdfString("a (b) \\c"), "(a \\(b\\) \\\\c)");
	assert.equal(pdfString("Ü"), "<FEFF00DC>");
});
