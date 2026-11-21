// Checks a draw.io model fragment the way insertXml needs it: well-formed XML,
// unique ids, and every parent / source / target defined before or in the fragment.
const assert = require("node:assert/strict");
const { XMLParser, XMLValidator } = (() => {
	try {
		return require("fast-xml-parser");
	} catch {
		return {};
	}
})();

function checkModelXml(xml) {
	assert.ok(XMLValidator, "fast-xml-parser is needed to check the XML");
	{
		const v = XMLValidator.validate(xml);
		assert.equal(v, true, `not well-formed: ${JSON.stringify(v)}`);
	}
	const ids = [...xml.matchAll(/<(?:object|mxCell) id="([^"]+)"/g)].map((m) => m[1]);
	assert.equal(new Set(ids).size, ids.length, "duplicate ids");
	const known = new Set();
	for (const m of xml.matchAll(/<(object|mxCell) id="([^"]+)"|parent="([^"]+)"|source="([^"]+)"|target="([^"]+)"/g)) {
		if (m[2]) known.add(m[2]);
		const ref = m[3] ?? m[4] ?? m[5];
		if (ref) assert.ok(ids.includes(ref), `reference to unknown cell ${ref}`);
	}
}

module.exports = { checkModelXml };
