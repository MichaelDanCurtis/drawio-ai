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
const { sanitizeSvg, svgSize, svgStyleUri } = require("../src/main/workshop/svgSanitize");
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
	const items = src.parseTheSvg(read("cdn/gh/glincker/thesvg@main/src/data/icons.json"));
	const ids = items.map((i) => i.id);
	assert.ok(ids.includes("thesvg:k8s-pod"), "Kubernetes (Apache-2.0) is in");
	assert.ok(ids.includes("thesvg:docker"));
	for (const i of items) {
		assert.ok(src.OPEN_LICENCES.has(i.licence), `${i.id} has ${i.licence}`);
		assert.match(i.url, /^http:\/\/mirror\.test\/cdn\/gh\/glincker\/thesvg@main\/public\/icons\//);
	}
	const raw = read("cdn/gh/glincker/thesvg@main/src/data/icons.json");
	for (const e of raw.filter((x) => ["aws", "azure", "gcp"].includes(x.collection))) assert.ok(!ids.includes(`thesvg:${e.slug}`), `${e.collection} ${e.slug} is left out`);
	assert.ok(raw.some((x) => x.collection === "azure" && x.license === "MIT"), "the fixture has a MIT-labelled Azure icon");
});

test("devicon, Simple Icons, Lucide, Tabler and a GitHub listing parse; non-open logos are left out", () => {
	const dev = src.parseDevicon(read("cdn/gh/devicons/devicon@latest/devicon.json"));
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
	s.removeFromCollection(col, colItems[0].id);
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
