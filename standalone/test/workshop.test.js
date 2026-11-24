// Shape Gallery: source parsing (licence filters), the SVG sanitizer, search ranking, the
// gallery service (index cache, SVG cache, insertables, collections) — all from fixtures
// shaped like jsDelivr, through a fake downloader. No network.
// Run from standalone/: node --test test/workshop.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const MIRROR = "http://mirror.test";
process.env.OMNIDRAW_GALLERY_MIRROR = MIRROR;
const FIX = path.join(__dirname, "fixtures", "galleries", "mirror");
const read = (p) => JSON.parse(fs.readFileSync(path.join(FIX, p), "utf8"));

const src = require("../src/main/workshop/sources");
const { MAX_SVG_BYTES, sanitizeSvg, safeImageData, svgSize, svgStyleUri } = require("../src/main/workshop/svgSanitize");
const { workshopFetch } = require("../src/main/workshop/fetch");
const http = require("http");
const { GalleryService, rank } = require("../src/main/workshop/galleries");

/** Serves the fixture mirror; counts requests. */
function fakeFetcher() {
	const calls = [];
	const fetcher = async (url) => {
		calls.push(url);
		const file = path.join(FIX, decodeURIComponent(url.slice(MIRROR.length)));
		if (!file.startsWith(FIX) || !fs.existsSync(file)) return { ok: false, status: 404, text: "" };
		const text = fs.readFileSync(file, "utf8");
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return { ok: true, status: 200, text, json };
	};
	return { fetcher, calls };
}

test("theSVG: only open licences, never the cloud vendors' sets (their labels are wrong)", () => {
	const items = src.parseTheSvg(read("raw/glincker/thesvg/main/src/data/icons.json"));
	const ids = items.map((i) => i.id);
	assert.ok(ids.includes("thesvg:k8s-pod"), "Kubernetes (Apache-2.0) is in");
	assert.ok(ids.includes("thesvg:docker"));
	for (const i of items) {
		assert.ok(src.OPEN_LICENCES.has(i.licence), `${i.id} has ${i.licence}`);
		assert.match(i.url, /^http:\/\/mirror\.test\/cdn\/npm\/@thesvg\/static@latest\/dist\/svg\/[\w.-]+\/[\w.-]+\.svg$/);
	}
	const raw = read("raw/glincker/thesvg/main/src/data/icons.json");
	for (const e of raw.filter((x) => ["aws", "azure", "gcp"].includes(x.collection))) assert.ok(!ids.includes(`thesvg:${e.slug}`), `${e.collection} ${e.slug} is left out`);
	assert.ok(raw.some((x) => x.collection === "azure" && x.license === "MIT"), "the fixture has a MIT-labelled Azure icon");
});

test("theSVG: SVGs from its npm packages (flags from @thesvg/flags)", () => {
	const [flag, logo] = src.parseTheSvg([
		{ slug: "flag-vu", title: "Vanuatu", license: "MIT", collection: "flags", variants: { default: "/icons/flag-vu/default.svg" } },
		{ slug: "01dotai", title: "01.AI", license: "MIT", variants: { default: "/icons/01dotai/color.svg" } },
	]);
	assert.equal(flag.url, "http://mirror.test/cdn/npm/@thesvg/flags@latest/dist/svg/4x3/vu.svg");
	assert.equal(logo.url, "http://mirror.test/cdn/npm/@thesvg/static@latest/dist/svg/01dotai/color.svg");
});

test("devicon, Simple Icons, Lucide, Tabler and a GitHub listing parse; non-open logos are left out", () => {
	const dev = src.parseDevicon(read("cdn/npm/devicon@latest/devicon.json"));
	assert.ok(dev.find((i) => i.id === "devicon:react").url.endsWith("/icons/react/react-original.svg"));
	const si = src.parseSimpleIcons(read("cdn/npm/simple-icons@latest/data/simple-icons.json"));
	assert.ok(si.some((i) => i.id === "simpleicons:react" && i.fill === "#61DAFB"));
	assert.ok(si.every((i) => !/custom|SA/.test(i.licence)), "custom and share-alike logos are out");
	assert.equal(si.length, 5);
	const luc = src.parseLucide(read("cdn/npm/lucide-static@latest/tags.json"));
	assert.ok(luc.find((i) => i.id === "lucide:server").tags.length > 0);
	const tab = src.parseTabler(read("cdn/npm/@tabler/icons@latest/icons.json"));
	assert.ok(tab.find((i) => i.id === "tabler:home").url.endsWith("/icons/outline/home.svg"));
	const gh = src.parseGithubListing(read("data/v1/package/gh/acme/icons@main/flat"), "acme/icons", "main", "icons");
	assert.deepEqual(gh.map((i) => i.title).sort(), ["rack", "switch"], "only SVGs in the folder, no hidden files");
});

test("GitHub addresses", () => {
	assert.deepEqual(src.parseGithubUrl("https://github.com/acme/icons/tree/main/svg/line"), { repo: "acme/icons", ref: "main", path: "svg/line" });
	assert.deepEqual(src.parseGithubUrl("acme/icons"), { repo: "acme/icons" });
	assert.deepEqual(src.parseGithubUrl("https://github.com/acme/icons.git"), { repo: "acme/icons" });
	assert.equal(src.parseGithubUrl("https://gitlab.com/acme/icons"), undefined);
	assert.equal(src.parseGithubUrl("not a repo"), undefined);
});

test("downloads only come from jsDelivr (or the test mirror)", () => {
	assert.ok(src.allowedUrl("http://mirror.test/cdn/x.svg"));
	delete process.env.OMNIDRAW_GALLERY_MIRROR;
	try {
		assert.ok(src.allowedUrl("https://cdn.jsdelivr.net/npm/lucide-static@latest/tags.json"));
		assert.ok(!src.allowedUrl("http://cdn.jsdelivr.net/x"), "https only");
		assert.ok(!src.allowedUrl("https://evil.example/x.svg"));
		assert.ok(src.allowedUrl("https://raw.githubusercontent.com/glincker/thesvg/main/src/data/icons.json"));
		assert.ok(!src.allowedUrl("https://raw.githubusercontent.com.evil.example/x"));
		assert.ok(!src.allowedUrl("https://cdn.jsdelivr.net.evil.example/x.svg"));
	} finally {
		process.env.OMNIDRAW_GALLERY_MIRROR = MIRROR;
	}
});

test("the sanitizer removes scripts, handlers, external links and embedded HTML", () => {
	const bad = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><foreignObject><div>hi</div></foreignObject><a href="https://evil.example"><rect width="5" height="5" style="fill:url(https://evil.example/f)"/></a><use xlink:href="#ok"/><image href="data:image/png;base64,AAAA"/><image href="http://evil.example/p.png"/></svg>';
	const out = sanitizeSvg(bad);
	assert.ok(out);
	assert.doesNotMatch(out, /script|onload|foreignObject|evil\.example|DOCTYPE|ENTITY/);
	assert.match(out, /xlink:href="#ok"/, "same-document links stay");
	assert.match(out, /href="data:image\/png;base64,AAAA"/, "embedded raster images stay");
	assert.match(out, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "an xmlns is added");
	assert.equal(sanitizeSvg("<html><svg></svg></html>"), undefined);
	assert.equal(sanitizeSvg('<svg><a href="javascript:alert(1)"/><x y="javascript:1"/></svg>'), undefined);
	assert.equal(sanitizeSvg("x".repeat(600 * 1024)), undefined);
	assert.match(sanitizeSvg('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>', { fill: "#61DAFB" }), /^<svg fill="#61DAFB"/);
	assert.match(svgStyleUri("<svg/>"), /^data:image\/svg\+xml,[A-Za-z0-9+/=]+$/, "no ';base64' in a draw.io style");
	assert.deepEqual(svgSize('<svg viewBox="0 0 24 24">'), { w: 48, h: 48 });
	assert.deepEqual(svgSize('<svg width="128" height="64">'), { w: 64, h: 32 });
});

test("ranking: title before tags, exact before prefix, every word must match", () => {
	const items = [
		{ id: "a", title: "database", tags: [] },
		{ id: "b", title: "database backup", tags: [] },
		{ id: "c", title: "server", tags: ["database"] },
		{ id: "d", title: "databases", tags: [] },
	];
	const order = items.map((i) => [i.id, rank(i, ["database"])]).sort((x, y) => y[1] - x[1]).map((x) => x[0]);
	assert.deepEqual(order, ["a", "b", "c", "d"].filter((id) => order.includes(id)).sort((x, y) => order.indexOf(x) - order.indexOf(y)));
	assert.equal(order[0], "a");
	assert.ok(rank(items[1], ["database"]) > rank(items[2], ["database"]), "a title word beats a tag");
	assert.equal(rank(items[2], ["database", "backup"]), 0, "AND across words");
});

test("the gallery service: index cache, cleaned SVG cache, search, insertables, collections", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const { fetcher, calls } = fakeFetcher();
	const s = new GalleryService(root, fetcher);
	const tech = { id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }, { kind: "simpleicons" }], enabled: true };
	const ui = { id: "ui-icons", title: "UI icons", sources: [{ kind: "lucide" }, { kind: "tabler" }], enabled: true };
	const gh = { id: "acme", title: "acme/icons", sources: [{ kind: "github", repo: "acme/icons", path: "icons" }], enabled: true };

	const items = await s.items(tech);
	assert.ok(items.length >= 10);
	assert.ok(fs.existsSync(path.join(root, "galleries", "tech-logos", "index.json")), "the index is cached");
	const before = calls.length;
	await s.items(tech);
	assert.equal(calls.length, before, "a fresh cached index is not fetched again");
	const cacheFile = path.join(root, "galleries", "tech-logos", "index.json");
	const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
	fs.writeFileSync(cacheFile, JSON.stringify({ items: cached.items, syncedAt: cached.syncedAt }));
	await new GalleryService(root, fetcher).items(tech);
	assert.ok(calls.length > before, "a cache from an older version is read again from its sources");

	const docker = items.find((i) => i.id === "devicon:docker");
	const svg = await s.svg(tech, docker);
	assert.ok(svg && !/script|onload|evil/.test(svg), "a hostile SVG arrives cleaned");
	const n = calls.length;
	assert.equal(await s.svg(tech, docker), svg);
	assert.equal(calls.length, n, "SVGs are cached");

	const ins = await s.insertable(tech, docker);
	assert.match(ins.style, /^shape=image;.*galleryItem=devicon:docker.*image=data:image\/svg\+xml,[A-Za-z0-9+/=]+;$/);
	assert.doesNotMatch(ins.style, /;base64,/);

	const hits = await s.search([tech, ui, gh], "server");
	assert.ok(hits.length >= 2 && hits.every((h) => /server/i.test(h.item.title + h.item.tags.join(" "))));
	assert.ok((await s.search([gh], "rack")).some((h) => h.item.title === "rack"), "GitHub galleries are searchable");
	assert.equal((await s.search([{ ...ui, enabled: false }], "server")).length, 0, "galleries that are off are not searched");

	const col = { id: "mine", title: "Mine", sources: [{ kind: "collection" }], enabled: true };
	s.createCollection("mine");
	await s.addToCollection(col, tech, docker);
	const react = items.find((i) => i.id === "devicon:react");
	await s.addToCollection(col, tech, react);
	let colItems = await s.items(col, true);
	assert.deepEqual(colItems.map((i) => i.title), ["docker", "react"]);
	assert.match(colItems[0].data, /^data:image\/svg\+xml;base64,/, "stored the library way (with ;base64)");
	const colIns = await s.insertable(col, colItems[0]);
	assert.doesNotMatch(colIns.style, /;base64,/, "and inserted the draw.io way");
	await s.removeFromCollection(col, colItems[0].id);
	colItems = await s.items(col, true);
	assert.deepEqual(colItems.map((i) => i.title), ["react"]);
	const lib = fs.readFileSync(s.collectionFile("mine"), "utf8");
	assert.match(lib, /^<mxlibrary>\[.*\]<\/mxlibrary>$/);
	assert.deepEqual(src.parseMxLibrary(lib, "x").map((i) => i.title), ["react"], "a collection is a valid draw.io library");

	s.remove(col);
	assert.ok(!fs.existsSync(s.collectionFile("mine")), "removing a collection deletes its file");
	s.remove(tech);
	assert.ok(!fs.existsSync(path.join(root, "galleries", "tech-logos")), "removing a gallery deletes its cache");
});

test("a source that fails keeps the last good index and reports the error", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const { fetcher } = fakeFetcher();
	let down = false;
	const s = new GalleryService(root, async (url, o) => (down ? { ok: false, status: 503, text: "" } : fetcher(url, o)));
	const ui = { id: "ui-icons", title: "UI icons", sources: [{ kind: "lucide" }], enabled: true };
	const first = await s.items(ui);
	assert.ok(first.length > 0);
	down = true;
	const again = await s.items(ui, true);
	assert.equal(again.length, first.length);
	assert.match(s.status([ui])[0].error, /503/);
});

test("the sanitizer: namespaced scripts, animations that swap links, encoded and unquoted tricks", () => {
	const cases = {
		nsScript: '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
		setHref: '<svg><use href="#a"><set attributeName="href" to="https://evil.example/x.svg#a"/></use></svg>',
		animate: '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><rect width="9" height="9"/></a></svg>',
		entJs: '<svg><a href="&#106;avascript:alert(1)"><rect width="9" height="9"/></a></svg>',
		unquotedHref: "<svg><image href=https://evil.example/p.png /></svg>",
	};
	for (const [name, svg] of Object.entries(cases)) {
		const out = sanitizeSvg(svg);
		assert.ok(out === undefined || !/script|evil\.example|javascript|<set|<animate/i.test(out), `${name}: ${out}`);
	}
	assert.equal(sanitizeSvg('<svg><rect style="fill:u\\72l(https://evil.example/f)"/></svg>'), undefined, "CSS escapes");
	assert.equal(sanitizeSvg('<svg><rect style="fill:url&#40;https://evil.example/f&#41;"/></svg>'), undefined, "entities in CSS");
	assert.match(sanitizeSvg(`<svg><rect fill="url('#g')"/><rect fill="url(#h)"/></svg>`), /url\('#g'\).*url\(#h\)/, "same-document gradients stay");
	assert.match(sanitizeSvg('<svg><filter><feImage href="#x"/></filter></svg>'), /href="#x"/);
});

test("the sanitizer: size costs no more than size, also when one opener fills the SVG and never closes", async (t) => {
	// an SVG as large as one may be, made of `opener` again and again
	const filled = (opener, before = "<svg>", after = "</svg>") => before + opener.repeat(Math.floor((MAX_SVG_BYTES - before.length - after.length) / opener.length)) + after;
	const cases = {
		"<?": filled("<?"),
		"<!--": filled("<!--"),
		"<![CDATA[": filled("<![CDATA["),
		"<!DOCTYPE ": filled("<!DOCTYPE ", "", ""), // (a ">" anywhere after it would end the first one)
		"<!DOCTYPE svg [": filled("<!DOCTYPE svg ["),
		"<script ": filled("<script "),
		"<script>": filled("<script>"),
		"<a:set ": filled("<a:set "),
		"url( in a style attribute": filled("url(", '<svg><rect style="fill:', '"/></svg>'),
		"url( in a style element": filled("url(", "<svg><style>a{fill:", "}</style></svg>"),
		'<a b="': filled('<a b="'),
	};
	// (the slowest of these takes some 10 ms, and the fastest of them took 1.5 s)
	const QUICK = 500;
	for (const [name, svg] of Object.entries(cases)) {
		await t.test(name, () => {
			assert.ok(svg.length <= MAX_SVG_BYTES && svg.length > MAX_SVG_BYTES - 32, "as large as an SVG may be");
			const started = performance.now();
			const out = sanitizeSvg(svg);
			const took = Math.round(performance.now() - started);
			assert.ok(took < QUICK, `took ${took} ms`);
			assert.equal(out, undefined, "not a usable SVG");
		});
	}
	// ... and what does close is taken out, or kept, as fast
	const closed = {
		"<!---->": [filled("<!---->"), /^<svg xmlns="[^"]+"><\/svg>$/],
		"<?x?>": [filled("<?x?>"), /^<svg xmlns="[^"]+"><\/svg>$/],
		"<set><set/></set>": [filled("<set><set/></set>"), /^<svg xmlns="[^"]+"><\/svg>$/],
		"url(x) ": [filled("url(x) ", '<svg><rect style="fill:', '"/></svg>'), /^<svg xmlns="[^"]+"><rect style="fill:(none )+"\/><\/svg>$/],
		"<![CDATA[x]]>": [filled("<![CDATA[x]]>"), /^<svg xmlns="[^"]+">x+<\/svg>$/],
		' a="1"': [filled(' a="1"', '<svg xmlns="http://www.w3.org/2000/svg"><rect', "/></svg>"), /^<svg xmlns="[^"]+"><rect( a="1")+\/><\/svg>$/],
		"an ordinary drawing": [filled('<path d="M0 0h1v1z" fill="url(#g)"/>', '<svg xmlns="http://www.w3.org/2000/svg">'), /^<svg xmlns="[^"]+">(<path d="M0 0h1v1z" fill="url\(#g\)"\/>)+<\/svg>$/],
	};
	for (const [name, [svg, expected]] of Object.entries(closed)) {
		await t.test(name, () => {
			const started = performance.now();
			const out = sanitizeSvg(svg);
			const took = Math.round(performance.now() - started);
			assert.ok(took < QUICK, `took ${took} ms`);
			assert.match(out, expected);
		});
	}
});

test("the sanitizer: what it took out or refused, it still does, read tag by tag", () => {
	const SVG = '<svg xmlns="http://www.w3.org/2000/svg">';
	const rect = `${SVG}<rect/></svg>`;
	// script elements: plain, with a prefix, in capitals, empty, one inside another, inside another dropped element
	assert.equal(sanitizeSvg("<svg><script>alert(1)</script><rect/></svg>"), rect);
	assert.equal(sanitizeSvg('<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><rect/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><rect/></svg>');
	assert.equal(sanitizeSvg('<svg><SCRIPT type="text/javascript">alert(1)</SCRIPT ><rect/></svg>'), rect);
	assert.equal(sanitizeSvg('<svg><script href="https://evil.example/x.js"/><rect/></svg>'), rect);
	assert.equal(sanitizeSvg("<svg><script><script>a()</script>b()</script><rect/></svg>"), rect, "all of a script inside a script (b() and a closing tag used to stay)");
	assert.equal(sanitizeSvg("<svg><foreignObject><div><script>a()</script></div><foreignObject/></foreignObject><rect/></svg>"), rect);
	assert.equal(sanitizeSvg('<svg><animate attributeName="href" values="javascript:alert(1)"/><animateTransform/><x:set to="1"></x:set><rect/></svg>'), rect);
	// a prefix is whatever stands before the last colon (these two used to pass as they were)
	for (const prefix of ["a.b", "é"]) assert.equal(sanitizeSvg(`<svg xmlns:${prefix}="http://www.w3.org/2000/svg"><${prefix}:script>alert(1)</${prefix}:script><rect/></svg>`), `<svg xmlns="http://www.w3.org/2000/svg" xmlns:${prefix}="http://www.w3.org/2000/svg"><rect/></svg>`);
	// an empty dropped element is dropped alone (it used to take everything up to the next closing tag of its name)
	assert.equal(sanitizeSvg('<svg><set a="b"/><rect id="kept"/><set>x</set></svg>'), `${SVG}<rect id="kept"/></svg>`);
	// one that never closes, or that is no tag of its own, leaves no usable SVG (the text of the script used to stay)
	for (const svg of ["<svg><script>alert(1)</svg>", "<svg><script>a()</script><rect/><s:script>b()</svg>", '<svg><rect title="<script>alert(1)</script>"/></svg>', "<svg><script-x>alert(1)</script-x></svg>", '<svg><rect title="<set to=1>"/></svg>', '<svg><rect title=" onx=<set>hello</set>"/></svg>'])
		assert.equal(sanitizeSvg(svg), undefined, svg);
	// ... and so does one that is closed and not open: everything up to that closing tag used to go, and what is
	// between is not kept on a guess
	const unopened = ["<svg><rect/></script></svg>", '<svg><foreignObject><script></foreignObject><rect id="k"/></script></svg>', '<svg><script>a()</script x><rect id="k"/></script></svg>', '<svg><script src=x/><rect id="k"/></script></svg>'];
	for (const svg of unopened) assert.equal(sanitizeSvg(svg), undefined, svg);

	// event handlers, links, styles
	assert.equal(sanitizeSvg(`<svg onload="a()"><rect onclick='b()' onmouseover=c() width="1"/></svg>`), `${SVG}<rect width="1"/></svg>`);
	assert.equal(sanitizeSvg(`<svg><a href="https://evil.example/"><use xlink:href="//evil.example/x.svg#a"/><image href='http://evil.example/p.png'/><image href=evil.png /></a></svg>`), `${SVG}<a><use/><image/><image /></a></svg>`);
	assert.equal(sanitizeSvg('<svg><style>@import url("https://evil.example/x.css"); .a{fill:red}</style><rect/></svg>'), `${SVG}<style> .a{fill:red}</style><rect/></svg>`);
	assert.equal(
		sanitizeSvg(`<svg><rect style="fill:url(https://evil.example/f.svg#a);stroke:url( #b)" filter="url('evil.svg#f')" mask="URL(x)"/></svg>`),
		`${SVG}<rect style="fill:none;stroke:none" filter="none" mask="none"/></svg>`
	);
	assert.equal(sanitizeSvg(`<svg><rect fill="url(#a)" stroke="url('#b')" filter='url("#c")'/></svg>`), `${SVG}<rect fill="url(#a)" stroke="url('#b')" filter='url("#c")'/></svg>`);
	assert.equal(sanitizeSvg('<svg><rect style="fill:url(https://evil.example/f"/></svg>'), undefined, "a url( that never closes");
	// javascript: spelled with entities: taken out of a link, and anywhere else the SVG is refused
	assert.equal(sanitizeSvg('<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>'), `${SVG}<a><rect/></a></svg>`);
	assert.equal(sanitizeSvg('<svg><a xlink:title="&#x6a;avascript:alert(1)"><rect/></a></svg>'), undefined);
	assert.equal(sanitizeSvg('<svg><a data-x="java&Tab;script&colon;alert(1)"><rect/></a></svg>'), undefined);
	assert.equal(sanitizeSvg('<svg><rect style="background:url(&#106;avascript:alert(1))"/></svg>'), `${SVG}<rect style="background:none)"/></svg>`);

	// the prolog, the DOCTYPE with what it declares, comments and processing instructions go with all they hold;
	// what a CDATA section holds is text, cleaned like the rest
	const dressed =
		'\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: x > y <script>z()</script> -->\n' +
		'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n] >\n' +
		'<svg viewBox="0 0 1 1"><style><![CDATA[.a{fill:url(https://evil.example/f)}]]></style><?php x ?><rect/></svg>\n';
	assert.equal(sanitizeSvg(dressed), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>.a{fill:none}</style><rect/></svg>');
	assert.equal(sanitizeSvg("<!doctype svg><svg><rect/></svg>"), rect);
	// one that never ends (it used to stay in what came back), a DOCTYPE whose "[" never gets its "]>" (it used
	// to end at the first ">"), a declaration on its own, a comment that taking another out puts together, a tag
	// that never ends: no usable SVG
	const open = ["<svg><!-- <rect/></svg>", "<svg><? <rect/></svg>", "<svg><style><![CDATA[ .a{fill:red} </style></svg>", '<!DOCTYPE svg [ <!ENTITY x "y"> <svg><rect/></svg>'];
	for (const svg of [...open, '<svg><!ENTITY x "y"><rect/></svg>', "<svg><!-<!-- -->- x --><rect/></svg>", '<svg><path d="M0 0/></svg>']) assert.equal(sanitizeSvg(svg), undefined, svg);
	// what is not an SVG at all is an answer, not an error
	assert.equal(sanitizeSvg("<svg @import</svg>"), undefined);
	// text stays text
	const prose = `${SVG}<text>a &lt; b &amp; c</text><title>one = two</title></svg>`;
	assert.equal(sanitizeSvg(prose), prose);
});

test("the sanitizer: taking one thing out never puts another together", () => {
	// each of these came back with the handler, the link or the element its two halves make
	const spliced = [
		'<svg o href="x"nload="alert(1)"><rect/></svg>', // onload, once the link between its halves is gone
		'<svg o@import;nload="alert(1)"><rect/></svg>',
		'<svg><rect  onclick="a()"onload="b()"/></svg>', // onload, at the space onclick leaves
		'<svg><a hr href="x"ef="https://evil.example/"><rect/></a></svg>',
		'<svg><a hr@import;ef="https://evil.example/"><rect/></a></svg>',
		"<svg><foreign@import;Object><p>hi</p></foreign@import;Object></svg>",
		'<svg><foreign onx="1"Object><p>hi</p></foreignObject></svg>',
		'<svg><rect style="width:expressionexpression((1))"/></svg>',
		"<svg><@import;!-- x --><rect/></svg>",
		"<svg><@import;?x ?><rect/></svg>",
		"<svg><style>a{fill:red}@import</style></svg>", // the end of the SVG goes with the @import
	];
	for (const svg of spliced) assert.equal(sanitizeSvg(svg), undefined, svg);
	// halves that an earlier step puts together are seen by the later ones, as before
	assert.equal(sanitizeSvg('<svg><a hr onx="1"ef="https://evil.example/"><rect/></a></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><a><rect/></a></svg>');
	assert.equal(sanitizeSvg('<svg><rect style="fill:u@import;rl(https://evil.example/f)"/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:none"/></svg>');
	// what comes back can be cleaned again and stays as it is, with or without a colour, small or large
	const bad = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><foreignObject><div>hi</div></foreignObject><a href="https://evil.example"><rect width="5" height="5" style="fill:url(https://evil.example/f)"/></a><use xlink:href="#ok"/><image href="data:image/png;base64,AAAA"/></svg>';
	const paths = (room) => "<svg>" + '<path d="M0 0h1v1z"/>'.repeat(Math.floor((MAX_SVG_BYTES - room) / 21)) + "</svg>";
	const large = paths(100); // (room for the xmlns and the colour it gets)
	for (const svg of [bad, large, '<svg><style>@import "x.css"; .a{fill:url(#g)}</style><text>one = two, on = off</text></svg>']) {
		for (const fill of [undefined, "#61DAFB"]) {
			const out = sanitizeSvg(svg, { fill });
			assert.ok(out, svg.slice(0, 80));
			assert.ok(sanitizeSvg(out) === out, `cleaned again, it changed: ${svg.slice(0, 80)}`);
			assert.ok(sanitizeSvg(out, { fill: "#000000" }) === (fill ? out : out.replace("<svg", '<svg fill="#000000"')), `a colour changed more than the colour: ${svg.slice(0, 80)}`);
		}
	}
	// one that its xmlns takes over the size limit could not be cleaned again (a collection's shapes are): it is refused now
	const full = paths(11);
	assert.ok(full.length <= MAX_SVG_BYTES && full.length + 35 > MAX_SVG_BYTES);
	assert.equal(sanitizeSvg(full), undefined);
});

test("the sanitizer: tags as an XML parser reads them, the root's own attributes, CSS kept in CDATA", () => {
	const SVG = '<svg xmlns="http://www.w3.org/2000/svg">';
	// the root tag ends at its ">" outside quotes, and xmlns and fill are looked for among its attributes
	const labelled = '<svg aria-label="a > b" xmlns="http://www.w3.org/2000/svg" fill="#222"><rect/></svg>';
	assert.equal(sanitizeSvg(labelled), labelled, "no second xmlns");
	assert.equal(sanitizeSvg(labelled, { fill: "#61DAFB" }), labelled, "no second fill");
	assert.equal(
		sanitizeSvg('<svg aria-label="its xmlns = x, its fill = y" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>', { fill: "#61DAFB" }),
		'<svg fill="#61DAFB" xmlns="http://www.w3.org/2000/svg" aria-label="its xmlns = x, its fill = y" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>',
		"a value that talks about them is not them"
	);

	// CSS that an SVG keeps in a CDATA section (Illustrator writes it so) stays, as text, and is cleaned like any other
	assert.equal(
		sanitizeSvg('<svg><style type="text/css"><![CDATA[.st0{fill:#f00} a > b{stroke:url(#g)} @import "x.css"; .c{fill:url(https://evil.example/f)}]]></style><path class="st0"/></svg>'),
		`${SVG}<style type="text/css">.st0{fill:#f00} a &gt; b{stroke:url(#g)}  .c{fill:none}</style><path class="st0"/></svg>`
	);
	// ... and so does any other CDATA section: it is text wherever it stands, with "<", ">" and "&" as references
	assert.equal(sanitizeSvg("<svg><text><![CDATA[a < b & c]]></text><desc><![CDATA[x]]]]><![CDATA[>y]]></desc></svg>"), `${SVG}<text>a &lt; b &amp; c</text><desc>x]]&gt;y</desc></svg>`);
	assert.equal(sanitizeSvg("<svg><desc><![CDATA[<script>alert(1)</script> &#106;avascript:]]></desc></svg>"), `${SVG}<desc>&lt;script&gt;alert(1)&lt;/script&gt; &amp;#106;avascript:</desc></svg>`);
	// in a dropped element it goes with the element
	assert.equal(sanitizeSvg("<svg><script><![CDATA[alert(1)]]></script><rect/></svg>"), `${SVG}<rect/></svg>`);
	// what a CDATA section helps to spell is cleaned like what is written out
	assert.equal(sanitizeSvg("<svg><<![CDATA[script]]>>alert(1)</script><rect/></svg>"), `${SVG}<rect/></svg>`);
	assert.equal(sanitizeSvg('<svg><rect a="<![CDATA[" onload="alert(1)]]>"/></svg>'), `${SVG}<rect a=""/></svg>`);
	assert.equal(sanitizeSvg("<svg><style><![CDATA[a{b:url(javascript:alert(1))}]]></style></svg>"), `${SVG}<style>a{b:none)}</style></svg>`);
	assert.equal(sanitizeSvg("<svg><style><![CDATA[c{d:u\\72l(https://evil.example/f)}]]></style></svg>"), undefined);

	// a tag an XML parser would not take as it is written (an HTML parser would, and find the handler): no usable SVG
	const loose = [
		'<svg><rect width="9"onclick="a()"/></svg>', // nothing between two attributes
		'<svg><rect/onclick="a()"></rect></svg>', // "/" for a space
		'<svg><rect width="9" /onclick="a()"></rect></svg>',
		"<svg><rect width=9 height=9/></svg>", // no quotes
		'<svg><rect hidden width="9"/></svg>', // no value
		'<svg><rect title="a <b> c"/></svg>', // "<" in a value, in either kind of quote
		"<svg><rect title='a <b> c'/></svg>",
		"<svg><text>a < b</text></svg>", // "<" in text that begins no tag
		'<svg><g></g x="1"></svg>', // more than a name in a closing tag
		'<svg><rect width="9"\u00A0height="9"/></svg>', // a space that is none of XML's
	];
	for (const svg of loose) assert.equal(sanitizeSvg(svg), undefined, svg);
	// a link is a link under any prefix (the link step knows prefixes of letters, digits, "_" and "-"), in any
	// case, in either kind of quote
	const dotted = (href, name = "a.b:href") => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:a.b="http://www.w3.org/1999/xlink"><use ${name}=${href}/></svg>`;
	for (const name of ["a.b:href", "a.b:HREF", "a:b.c:href", "é:href"]) {
		assert.equal(sanitizeSvg(dotted('"https://evil.example/x.svg#a"', name)), undefined, name);
		assert.equal(sanitizeSvg(dotted("'https://evil.example/x.svg#a'", name)), undefined, name);
		assert.equal(sanitizeSvg(dotted("'#a'", name)), dotted("'#a'", name), name);
	}
	// ... and what XML allows stays as it is: either quote, ">" in a value, line breaks, spaces around "=", any name
	const fine = `${SVG}<rect\n\tdata-a='x "y" > z'  title = "it's"\n/><a:b-c.d xmlns:a="urn:x" a:é="&lt;&amp;"></a:b-c.d\r\n><use href='#a'/><text>a > "b" 'c'</text></svg\n>`;
	assert.equal(sanitizeSvg(fine), fine);
	// the size is read from the same root tag
	assert.deepEqual(svgSize('<svg aria-label="a > b" width="128" height="64"><rect/></svg>'), { w: 64, h: 32 });
});

test("images from libraries, folders and collections: plain images only, SVGs cleaned", () => {
	assert.equal(safeImageData("data:image/png;base64,AA;image=https://evil.example/t.png"), undefined, "cannot end the style's image key");
	assert.equal(safeImageData("https://evil.example/t.png"), undefined);
	assert.equal(safeImageData("data:text/html;base64,PHNjcmlwdD4="), undefined);
	assert.deepEqual(safeImageData("data:image/png;base64,iVBORw0K"), { style: "data:image/png,iVBORw0K", img: "data:image/png;base64,iVBORw0K" });
	const dirty = Buffer.from('<svg viewBox="0 0 9 9" onload="alert(1)"><script>x()</script><rect width="9" height="9"/></svg>').toString("base64");
	const clean = safeImageData(`data:image/svg+xml;base64,${dirty}`);
	assert.ok(clean);
	assert.doesNotMatch(Buffer.from(clean.img.split(",")[1], "base64").toString(), /script|onload/);
	assert.match(clean.style, /^data:image\/svg\+xml,[A-Za-z0-9+/=]+$/);
	assert.ok(safeImageData("data:image/svg+xml," + encodeURIComponent('<svg viewBox="0 0 9 9"></svg>')), "URL-encoded SVGs too");

	const lib = src.toMxLibrary([
		{ title: "ok", data: "data:image/png;base64,iVBORw0K" },
		{ title: "bad", data: "data:image/png;base64,AA;image=https://evil.example/t.png" },
		{ title: "shape", xml: "<mxGraphModel/>" },
	]);
	const items = src.parseMxLibrary(lib, "x");
	assert.deepEqual(items.map((i) => i.title), ["ok", "shape"], "an entry with a crafted image is left out");
});

test("library ids come from the shape, so a stale list never names a different one", async () => {
	const lib = (titles) => src.toMxLibrary(titles.map((t) => ({ title: t, xml: `<mxGraphModel id="${t}"/>` })));
	const before = src.parseMxLibrary(lib(["a", "b", "c"]), "x");
	const after = src.parseMxLibrary(lib(["b", "c"]), "x");
	assert.equal(after.find((i) => i.title === "c").id, before.find((i) => i.title === "c").id);
	const twice = src.parseMxLibrary(lib(["a", "a"]), "x");
	assert.notEqual(twice[0].id, twice[1].id, "the same shape twice still has two ids");
	// a shape without a name gets one by its place: also where a converter wrote the word "null" for it (Visio stencils)
	const unnamed = `<mxlibrary>${JSON.stringify([{ title: "null", xml: '<mxGraphModel id="a"/>' }, { title: "Router", xml: '<mxGraphModel id="b"/>' }, { title: " Undefined ", xml: '<mxGraphModel id="c"/>' }, { xml: '<mxGraphModel id="d"/>' }, { title: "Null modem", xml: '<mxGraphModel id="e"/>' }])}</mxlibrary>`;
	assert.deepEqual(src.parseMxLibrary(unnamed, "x").map((i) => i.title), ["Shape 1", "Router", "Shape 3", "Shape 4", "Null modem"]);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const s = new GalleryService(root, fakeFetcher().fetcher);
	const col = { id: "mine", title: "Mine", sources: [{ kind: "collection" }], enabled: true };
	fs.mkdirSync(path.dirname(s.collectionFile("mine")), { recursive: true });
	fs.writeFileSync(s.collectionFile("mine"), lib(["a", "b", "c"]));
	const stale = await s.items(col, true);
	await s.removeFromCollection(col, stale[0].id);
	assert.equal(await s.removeFromCollection(col, stale[0].id), false, "removing it again from the stale list removes nothing");
	assert.deepEqual((await s.items(col, true)).map((i) => i.title), ["b", "c"]);
});

test("a collection file that cannot be read is never overwritten", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const s = new GalleryService(root, fakeFetcher().fetcher);
	const tech = { id: "tech-logos", title: "Tech logos", sources: [{ kind: "devicon" }], enabled: true };
	const col = { id: "mine", title: "Mine", sources: [{ kind: "collection" }], enabled: true };
	fs.mkdirSync(path.dirname(s.collectionFile("mine")), { recursive: true });
	fs.writeFileSync(s.collectionFile("mine"), "<mxlibrary>[{broken</mxlibrary>");
	const react = (await s.items(tech)).find((i) => i.id === "devicon:react");
	await assert.rejects(s.addToCollection(col, tech, react));
	await assert.rejects(s.removeFromCollection(col, "lib:x"));
	assert.equal(fs.readFileSync(s.collectionFile("mine"), "utf8"), "<mxlibrary>[{broken</mxlibrary>");
});

test("a week-old index answers at once and refreshes behind; a failed refresh waits before trying again", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const { fetcher, calls } = fakeFetcher();
	let down = false;
	let release;
	let gate = Promise.resolve();
	const s = new GalleryService(root, async (url, o) => {
		await gate;
		return down ? { ok: false, status: 503, text: "" } : fetcher(url, o);
	});
	const ui = { id: "ui-icons", title: "UI icons", sources: [{ kind: "lucide" }], enabled: true };
	const first = await s.items(ui);
	const file = path.join(root, "galleries", "ui-icons", "index.json");
	const old = JSON.parse(fs.readFileSync(file, "utf8"));
	old.syncedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
	fs.writeFileSync(file, JSON.stringify(old));

	const s2 = new GalleryService(root, async (url, o) => {
		await gate;
		calls.push(url);
		return down ? { ok: false, status: 503, text: "" } : fetcher(url, o);
	});
	gate = new Promise((r) => (release = r));
	down = true;
	const n = calls.length;
	const t0 = Date.now();
	const answer = await s2.items(ui);
	assert.ok(Date.now() - t0 < 200, "the old index answers without waiting for the refresh");
	assert.equal(answer.length, first.length);
	release();
	gate = Promise.resolve();
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(calls.length > n, "a refresh was started");
	assert.match(s2.status([ui])[0].error, /503/);
	const m = calls.length;
	await s2.items(ui);
	await s2.items(ui);
	assert.equal(calls.length, m, "not tried again straight after failing");
	void s;
});

test("making a gallery offline: one run at a time, one download per file, stopped by removing it", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const { fetcher, calls } = fakeFetcher();
	const s = new GalleryService(root, async (url, o) => {
		await new Promise((r) => setTimeout(r, 5));
		return fetcher(url, o);
	});
	const ui = { id: "ui-icons", title: "UI icons", sources: [{ kind: "lucide" }], enabled: true };
	const items = await s.items(ui);
	const server = items.find((i) => i.id === "lucide:server");
	const n = calls.length;
	const [a, b] = await Promise.all([s.svg(ui, server), s.svg(ui, server)]);
	assert.equal(a, b);
	assert.equal(calls.filter((c) => c === server.url).length, 1, "two asks, one download");
	assert.equal(calls.length, n + 1);

	const r1 = s.makeOffline(ui);
	const r2 = s.makeOffline(ui);
	assert.equal(r1, r2, "a second click joins the run");
	await r1;

	const tabler = { id: "tabler", title: "Tabler", sources: [{ kind: "tabler" }], enabled: true };
	await s.items(tabler);
	const run = s.makeOffline(tabler);
	s.remove(tabler);
	const r = await run;
	assert.equal(r.done + r.failed, 0, "it stopped before downloading anything");
	assert.ok(!fs.existsSync(path.join(root, "galleries", "tabler")), "and left no files behind");
});

test("Simple Icons entries without a slug get Simple Icons' own one", () => {
	assert.equal(src.simpleIconsSlug("Node.js"), "nodedotjs");
	assert.equal(src.simpleIconsSlug("C++"), "cplusplus");
	assert.equal(src.simpleIconsSlug("AT&T"), "atandt");
	assert.equal(src.simpleIconsSlug("Citroën"), "citroen");
	const items = src.parseSimpleIcons([{ title: "Node.js", hex: "5FA04E" }]);
	assert.equal(items[0].id, "simpleicons:nodedotjs");
	assert.match(items[0].url, /\/icons\/nodedotjs\.svg$/);
});

test("a GitHub gallery without a branch tries main, then master", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-galleries-"));
	const { fetcher } = fakeFetcher();
	const listing = read("data/v1/package/gh/acme/icons@main/flat");
	const asked = [];
	const s = new GalleryService(root, async (url, o) => {
		asked.push(url);
		if (url.includes("/gh/acme/old@master/flat")) return { ok: true, status: 200, text: JSON.stringify(listing), json: listing };
		if (url.includes("/gh/acme/old")) return { ok: false, status: 404, text: "" };
		return fetcher(url, o);
	});
	const g = { id: "old", title: "acme/old", sources: [{ kind: "github", repo: "acme/old", path: "icons" }], enabled: true };
	const items = await s.items(g);
	assert.deepEqual(items.map((i) => i.title).sort(), ["rack", "switch"]);
	assert.ok(items.every((i) => i.url.includes("/gh/acme/old@master/")));
	assert.ok(asked.findIndex((u) => u.includes("@main/")) < asked.findIndex((u) => u.includes("@master/")));
});

test("downloads: every redirect is checked against the allowed hosts, and answers are size-capped", async () => {
	const server = http.createServer((req, res) => {
		if (req.url === "/go-away") return res.writeHead(302, { location: "http://127.0.0.2:9/evil.svg" }).end();
		if (req.url === "/hop") return res.writeHead(302, { location: "/ok.svg" }).end();
		if (req.url === "/ok.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg/>");
		if (req.url === "/big") {
			res.writeHead(200);
			res.write("x".repeat(4096));
			return res.end("x".repeat(4096));
		}
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	process.env.OMNIDRAW_GALLERY_MIRROR = base;
	try {
		assert.equal((await workshopFetch(`${base}/hop`)).text, "<svg/>", "a redirect within the allowed hosts is followed");
		await assert.rejects(workshopFetch(`${base}/go-away`), /only come from jsDelivr/);
		await assert.rejects(workshopFetch(`${base}/big`, { maxBytes: 5000 }), /larger than/);
		await assert.rejects(workshopFetch("https://evil.example/x.svg"), /only come from jsDelivr/);
	} finally {
		process.env.OMNIDRAW_GALLERY_MIRROR = MIRROR;
		server.close();
	}
});
