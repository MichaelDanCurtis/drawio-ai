// Shape Shifter: one-colour icons, what a change does to the selected shapes, draw.io's own
// shapes as the Workshop shows them, and the Workshop's other half answering the Shifter's
// messages against a faked diagram. No network, no editor.
// Run from standalone/: node --test test/shifter.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const shifter = require("../src/main/workshop/shifter");
const { svgStyleUri } = require("../src/main/workshop/svgSanitize");
const { WorkshopCore } = require("../src/main/workshop/core");
const { GalleryService } = require("../src/main/workshop/galleries");

const iconStyle = (svg) => `shape=image;html=1;aspect=fixed;image=${svgStyleUri(svg)};`;
const svgOf = (style) => shifter.iconSvgOf(style);

test("colours: #rgb and #rrggbb, lower-cased; none only where it makes sense; nothing else", () => {
	assert.equal(shifter.colourOf("#FA0"), "#ffaa00");
	assert.equal(shifter.colourOf(" #12ABef "), "#12abef");
	assert.equal(shifter.colourOf("none"), "none");
	assert.equal(shifter.colourOf("none", false), undefined);
	for (const bad of ["red", "#12345", "#gggggg", "url(#a)", "#fff;shape=image", "", 7, null, undefined, "#ffffff80"]) assert.equal(shifter.colourOf(bad), undefined, String(bad));
	assert.equal(shifter.styleValue("rounded=1;fillColor=#dae8fc;image=data:image/svg+xml,AAA=;", "fillColor"), "#dae8fc");
	assert.equal(shifter.styleValue("rounded=1;fillColor=#dae8fc;", "strokeColor"), undefined);
	// a key is a whole key (fontColor is not found in labelBackgroundfontColor…)
	assert.equal(shifter.styleValue("xfillColor=#000000;", "fillColor"), undefined);
});

test("an icon in one colour: fills and strokes that paint change, none and gradients stay, the default black gets the colour", () => {
	// a filled logo
	assert.equal(
		shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#E34F26" d="M0 0h24v24H0z"/><path fill="none" stroke="#fff" d="M1 1"/></svg>', "#0055FF"),
		'<svg fill="#0055ff" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0055ff" d="M0 0h24v24H0z"/><path fill="none" stroke="#0055ff" d="M1 1"/></svg>'
	);
	// a line icon (Lucide's form): the root's fill stays none, its stroke takes the colour
	const line = shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/></svg>', "#ff0000");
	assert.match(line, /^<svg xmlns="[^"]+" viewBox="0 0 24 24" fill="none" stroke="#ff0000" stroke-width="2">/);
	// paths without a fill are black by default: the root gives them the colour
	assert.match(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', "#00aa00"), /^<svg fill="#00aa00" /);
	// colours in style attributes, and references to gradients, which stay
	const styled = shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="g"/></defs><rect style="fill: #123456; stroke:red; stroke-width:2" width="8" height="8"/><circle fill="url(#g)" r="2"/></svg>', "#abcdef");
	assert.match(styled, /style="fill: #abcdef; stroke:#abcdef; stroke-width:2"/);
	assert.match(styled, /fill="url\(#g\)"/);
	// what comes back is cleaned like any SVG, and what is not an SVG or a colour gives nothing
	assert.doesNotMatch(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><path fill="#000" d="M0 0"/></svg>', "#111111"), /script|onload|alert/);
	assert.equal(shifter.recolourSvg("<p>not an svg</p>", "#111111"), undefined);
	assert.equal(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', 'red" onload="x'), undefined);
	// nothing in it paints: there is nothing to recolour
	assert.equal(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M0 0"/></svg>', "#111111"), undefined);
});

test("an icon in one colour: only what paints is rewritten; text, titles, other attributes, masks, clip paths and patterns stay", () => {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="a > b fill=\'red\'">' +
		"<title>Pump stroke: high</title><desc>fill: none; really</desc>" +
		'<mask id="m"><rect width="24" height="24" fill="white"/><circle r="4" fill="black"/></mask>' +
		'<clipPath id="c"><rect width="8" height="8" fill="#000"/></clipPath>' +
		'<pattern id="p"><path stroke="#f00" d="M0 0"/></pattern>' +
		"<style>.a{fill:#123456 !important;stroke-width:2}.b:hover{stroke: red}</style>" +
		'<path class="a" mask="url(#m)" fill="#E34F26" data-note="stroke=\'x\' > fill: y" d="M0 0h24v24H0z"/>' +
		"<text fill='#333' x=\"1\" style='stroke:red;stroke-width:1'>stroke: 2px</text></svg>";
	assert.equal(
		shifter.recolourSvg(svg, "#0055ff"),
		'<svg fill="#0055ff" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="a > b fill=\'red\'">' +
			"<title>Pump stroke: high</title><desc>fill: none; really</desc>" +
			'<mask id="m"><rect width="24" height="24" fill="white"/><circle r="4" fill="black"/></mask>' +
			'<clipPath id="c"><rect width="8" height="8" fill="#000"/></clipPath>' +
			'<pattern id="p"><path stroke="#f00" d="M0 0"/></pattern>' +
			"<style>.a{fill:#0055ff !important;stroke-width:2}.b:hover{stroke: #0055ff}</style>" +
			'<path class="a" mask="url(#m)" fill="#0055ff" data-note="stroke=\'x\' > fill: y" d="M0 0h24v24H0z"/>' +
			"<text fill='#0055ff' x=\"1\" style='stroke:#0055ff;stroke-width:1'>stroke: 2px</text></svg>"
	);
	// names are as XML reads them: FILL is not fill, <MASK> is not a mask
	assert.equal(
		shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" FILL="#222"><MASK><path fill="#fff" d="M0 0"/></MASK></svg>', "#00aa00"),
		'<svg fill="#00aa00" xmlns="http://www.w3.org/2000/svg" FILL="#222"><MASK><path fill="#00aa00" d="M0 0"/></MASK></svg>'
	);
	// a long run of spaces inside a value costs no more than its length
	const started = Date.now();
	const wide = shifter.recolourSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:a${" ".repeat(150000)}b}</style><path style="stroke:a${" ".repeat(150000)}b;" d="M0 0"/></svg>`, "#00aa00");
	assert.match(wide, /<style>\.a\{fill:#00aa00\}<\/style><path style="stroke:#00aa00;" d="M0 0"\/>/);
	assert.ok(Date.now() - started < 1500, `recolouring took ${Date.now() - started} ms`);
	// a root whose fill comes after an attribute with ">" in it is still seen: no second fill is added
	assert.equal(
		shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" aria-label="a > b" fill="#222"><path d="M0 0"/></svg>', "#00aa00"),
		'<svg xmlns="http://www.w3.org/2000/svg" aria-label="a > b" fill="#00aa00"><path d="M0 0"/></svg>'
	);
	// a picture that is only a mask's cut-outs has nothing to recolour once the root says none
	assert.equal(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="none"><mask id="m"><rect fill="white" width="4" height="4"/></mask></svg>', "#111111"), undefined);
	// a tag that never ends is not rewritten
	assert.equal(shifter.recolourSvg('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M0 0</svg>', "#111111"), undefined);
});

test("the picture a shape keeps: draw.io's base64 form and the URI-encoded one; other images are not icons", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="10" fill="#f00"/></svg>';
	assert.equal(svgOf(iconStyle(svg)), svg);
	assert.equal(svgOf(`shape=image;image=data:image/svg+xml,${encodeURIComponent(svg)};`), svg);
	assert.equal(svgOf("shape=image;image=img/lib/clip_art/computers/Database_128x128.png;"), undefined);
	assert.equal(svgOf("shape=image;image=data:image/png,iVBORw0KGgo=;"), undefined);
	assert.equal(svgOf("rounded=1;fillColor=#fff;"), undefined);
	assert.equal(svgOf("shape=image;image=data:image/svg+xml,%E0%A4%A;"), undefined);
});

test("the selection as the Shifter shows it, and the edits a change makes to it", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#E34F26" d="M0 0h24v24H0z"/></svg>';
	const cells = [
		{ id: "a", style: "rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#333333;", edge: false },
		{ id: "b", style: "ellipse;fillColor=#DAE8FC;strokeColor=#000000;", edge: false },
		{ id: "e", style: "edgeStyle=orthogonalEdgeStyle;strokeColor=#6c8ebf;", edge: true },
		{ id: "i", style: iconStyle(svg), edge: false },
	];
	// a colour shows when every selected shape that has one agrees on it
	assert.deepEqual(shifter.selectionInfo(cells), { count: 4, icons: 1, fill: "#dae8fc", stroke: undefined, font: "#333333" });
	assert.deepEqual(shifter.selectionInfo([]), { count: 0, icons: 0, fill: undefined, stroke: undefined, font: undefined });

	// fill is for shapes, not connectors; the line and text colours are for all
	assert.deepEqual(shifter.styleEdits(cells, { fill: "#ff8800", stroke: "none" }), [
		{ id: "a", props: { fillColor: "#ff8800", strokeColor: "none" } },
		{ id: "b", props: { fillColor: "#ff8800", strokeColor: "none" } },
		{ id: "e", props: { strokeColor: "none" } },
		{ id: "i", props: { fillColor: "#ff8800", strokeColor: "none" } },
	]);
	// text is never "none"; a value that is not a colour changes nothing
	assert.deepEqual(shifter.styleEdits(cells, { font: "none", fill: "red;image=x" }), []);
	// the icon colour only touches pictures drawn from an SVG kept in the shape
	const edits = shifter.styleEdits(cells, { icon: "#0055ff" });
	assert.deepEqual(edits.map((e) => [e.id, Object.keys(e.props)]), [["i", ["image"]]]);
	assert.match(edits[0].props.image, /^data:image\/svg\+xml,[A-Za-z0-9+/=]+$/, "the picture would split the style");
	assert.match(svgOf(`image=${edits[0].props.image};`), /fill="#0055ff"/);
});

test("draw.io's own shapes in the Workshop: as they are in a diagram, with a cleaned thumbnail", () => {
	assert.deepEqual(shifter.builtInInsertable({ title: "Process", style: "rounded=1;", width: 120, height: 60 }), { style: "rounded=1;", w: 120, h: 60, title: "Process" });
	// several cells (a UML class): its XML; a shape without a size gets a usual one
	assert.deepEqual(shifter.builtInInsertable({ title: "Class", style: "swimlane;", width: 0, height: 0, xml: "<mxGraphModel/>" }), { xml: "<mxGraphModel/>", w: 120, h: 60, title: "Class" });
	const preview = shifter.builtInPreview({ title: "x", style: "", width: 1, height: 1, preview: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="http://127.0.0.1:1/webapp/img/x.png"/><foreignObject><div>label</div></foreignObject><rect onclick="x()" width="8" height="8"/></svg>' });
	const text = Buffer.from(preview.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
	assert.doesNotMatch(text, /href|foreignObject|onclick|127\.0\.0\.1/);
	assert.match(text, /<rect width="8" height="8"\/>/);
	assert.equal(shifter.builtInPreview({ title: "x", style: "", width: 1, height: 1 }), undefined);
	assert.equal(shifter.builtInPreview({ title: "x", style: "", width: 1, height: 1, preview: "<b>not an svg</b>" }), undefined);
	assert.match(shifter.restyleRequest("  make it red  ", 1), /^Change the selected shape like this: make it red\n\nOnly change how they look/);
	assert.match(shifter.restyleRequest("round them", 3), /^Change the 3 selected shapes like this: round them/);
});

/** The Workshop's other half with a faked diagram behind the Shape Shifter. */
function workshop(overrides = {}) {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-shifter-"));
	const shapes = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-shifter-shapes-"));
	fs.writeFileSync(path.join(shapes, "router.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#336791"/></svg>');
	const service = new GalleryService(data, async (url) => assert.fail(`no downloads: ${url}`));
	let configs = [{ id: "mine", title: "My shapes", sources: [{ kind: "folder", path: shapes }], enabled: true }];
	const posted = [];
	const inserted = [];
	const applied = [];
	const asked = [];
	const selected = overrides.selected ?? [{ id: "c1", style: "rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;", edge: false }];
	const shifterHost = {
		searchBuiltIn: async (query, limit) => [
			{ title: "Router", library: "cisco", style: "shape=mxgraph.cisco.routers.router;", width: 78, height: 53, preview: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="8" height="8"/></svg>' },
			{ title: "Link", style: "endArrow=classic;", width: 50, height: 50, isEdge: true },
			{ title: `asked ${query} ${limit}`, style: "rounded=1;", width: 120, height: 60 },
		],
		selectedCells: async () => selected,
		applyStyles: async (edits) => void applied.push(...edits),
		askAgent: async (request, shown) => void asked.push({ request, shown }),
		convertStencil: async (file) => ({
			library: `<mxlibrary>${JSON.stringify([{ xml: "&lt;mxGraphModel&gt;&lt;root/&gt;&lt;/mxGraphModel&gt;", w: 80, h: 40, title: "Switch" }, { xml: "<mxGraphModel><root/></mxGraphModel>", w: null, h: null, title: "Hub" }, { title: "No shape" }])}</mxlibrary>`,
			warnings: [`read ${path.basename(file)}`],
		}),
	};
	const ports = {
		post: (msg) => posted.push(msg),
		service: () => service,
		configs: () => configs,
		save: (next) => (configs = next),
		host: () => (overrides.noDiagram ? undefined : { insert: async (shape) => (inserted.push(shape), "net.drawio"), diagramName: () => "net.drawio", shapeSets: () => undefined, setShapeSet: () => undefined, refreshShapeSets: () => undefined, ...(overrides.off ? {} : { shifter: { ...shifterHost, ...(overrides.host ?? {}) } }) }),
		look: () => ({ iconStyle: "dots2d", matrix: "grey" }),
		version: () => "0.1.0",
		confirm: async () => true,
		pickLocal: async () => undefined,
		pickExport: async () => undefined,
		reveal: () => undefined,
		openExternal: () => undefined,
		...(overrides.off ? {} : { shifter: true, pickStencil: async () => ("pickStencil" in overrides ? overrides.pickStencil : "/stencils/Network Devices.vssx") }),
	};
	const core = new WorkshopCore(ports);
	return { core, posted, inserted, applied, asked, service, shifterHost, configs: () => configs, settle: () => new Promise((r) => setTimeout(r, 200)) };
}

test("find by words: draw.io's own shapes and the galleries' in one answer; a found shape goes into the diagram", async () => {
	const w = workshop();
	await w.core.onMessage({ type: "ready" });
	await w.settle();
	assert.equal(w.posted.filter((m) => m.type === "state").pop().shifter, true);
	w.posted.length = 0;
	await w.core.onMessage({ type: "find", query: "  router ", reqId: 3 });
	const found = w.posted.find((m) => m.type === "found");
	assert.equal(found.reqId, 3);
	assert.equal(found.diagram, true);
	// connectors are left out; each shape has a key, never its style
	assert.deepEqual(found.own.map((o) => [o.title, o.library, !!o.src]), [["Router", "cisco", true], ["asked router 36", "", false]]);
	assert.ok(found.own.every((o) => /^own:\d+:\d+$/.test(o.key) && !("style" in o)));
	assert.deepEqual(found.hits.map((h) => [h.galleryId, h.title]), [["mine", "router"]]);
	assert.equal(w.posted.filter((m) => m.type === "previews").flatMap((m) => m.previews).length, 1);

	await w.core.onMessage({ type: "insertFound", key: found.own[0].key });
	assert.deepEqual(w.inserted, [{ style: "shape=mxgraph.cisco.routers.router;", w: 78, h: 53, title: "Router" }]);
	assert.deepEqual(w.posted.filter((m) => m.type === "notice").pop(), { type: "notice", message: "Added Router to net.drawio." });
	// a key from an older search is refused, not guessed
	await w.core.onMessage({ type: "find", query: "hub", reqId: 4 });
	await assert.rejects(w.core.onMessage({ type: "insertFound", key: found.own[0].key }), /Search again/);
	// nothing typed: nothing asked of the editor
	w.posted.length = 0;
	await w.core.onMessage({ type: "find", query: "  ", reqId: 5 });
	assert.deepEqual(w.posted.find((m) => m.type === "found"), { type: "found", reqId: 5, diagram: true, own: [], hits: [] });
	w.core.dispose();

	// a diagram whose editor fails leaves the galleries' answer as it is
	const failing = workshop({ host: { searchBuiltIn: async () => Promise.reject(new Error("The diagram is still loading.")) } });
	await failing.core.onMessage({ type: "find", query: "router", reqId: 1 });
	const g = failing.posted.find((m) => m.type === "found");
	assert.deepEqual([g.diagram, g.own.length, g.hits.length], [true, 0, 1]);
	failing.core.dispose();

	// with no diagram open the galleries answer alone
	const alone = workshop({ noDiagram: true });
	await alone.core.onMessage({ type: "find", query: "router", reqId: 1 });
	const f = alone.posted.find((m) => m.type === "found");
	assert.deepEqual([f.diagram, f.own.length, f.hits.length], [false, 0, 1]);
	alone.core.dispose();
});

test("change a shape: the selection is shown, colours are applied to it, a description goes to the agent", async () => {
	const w = workshop();
	w.core.postSelection();
	await w.settle();
	assert.deepEqual(w.posted.filter((m) => m.type === "selection").pop(), { type: "selection", count: 1, icons: 0, fill: "#dae8fc", stroke: "#6c8ebf", font: undefined });
	await w.core.onMessage({ type: "restyle", fill: "#FF8800" });
	assert.deepEqual(w.applied, [{ id: "c1", props: { fillColor: "#ff8800" } }]);
	assert.match(w.posted.filter((m) => m.type === "notice").pop().message, /^Changed 1 shape\. Undo in the diagram takes it back\.$/);
	// what is not a colour never reaches the diagram
	await assert.rejects(w.core.onMessage({ type: "restyle", fill: "red;shape=image;image=http://evil.example/x.svg" }), /Pick a colour first/);
	await assert.rejects(w.core.onMessage({ type: "restyle", icon: "#000000" }), /None of the selected shapes is an icon/);
	assert.equal(w.applied.length, 1);

	await w.core.onMessage({ type: "describeChange", text: "  make it rounded and blue " });
	assert.deepEqual(w.asked.map((a) => a.shown), ["✎ Change 1 shape: make it rounded and blue"]);
	assert.match(w.asked[0].request, /^Change the selected shape like this: make it rounded and blue\n/);
	await assert.rejects(w.core.onMessage({ type: "describeChange", text: "   " }), /Say what to change first/);
	w.core.dispose();

	// nothing selected, or no diagram: said, not done
	const none = workshop({ selected: [] });
	await assert.rejects(none.core.onMessage({ type: "restyle", fill: "#000000" }), /Select the shapes to change/);
	await assert.rejects(none.core.onMessage({ type: "describeChange", text: "bigger" }), /Select the shapes to change/);
	none.core.dispose();
	const closed = workshop({ noDiagram: true });
	await assert.rejects(closed.core.onMessage({ type: "restyle", fill: "#000000" }), /Open a diagram first/);
	closed.core.postSelection();
	await closed.settle();
	assert.deepEqual(closed.posted.filter((m) => m.type === "selection").pop(), { type: "selection", count: 0, icons: 0 });
	closed.core.dispose();
});

test("a Visio stencil: converted, named by the user, then a collection of their own", async () => {
	const w = workshop();
	await w.core.onMessage({ type: "importStencil" });
	const asked = w.posted.find((m) => m.type === "stencil");
	// (an entry without a shape is left out)
	assert.deepEqual([asked.name, asked.count, asked.titles, asked.warnings], ["Network Devices", 2, ["Switch", "Hub"], ["read Network Devices.vssx"]]);
	assert.equal(w.configs().length, 1, "nothing is kept before the user has named it");
	await assert.rejects(w.core.onMessage({ type: "saveStencil", token: "wrong", title: "x" }), /no longer waiting/);
	await w.core.onMessage({ type: "saveStencil", token: asked.token, title: "  Network kit  " });
	const col = w.configs().find((g) => g.id === "network-kit");
	assert.deepEqual([col.title, col.sources, col.enabled], ["Network kit", [{ kind: "collection" }], true]);
	assert.deepEqual((await w.service.items(col)).map((i) => [i.title, !!i.xml, i.w, i.h]), [["Switch", true, 80, 40], ["Hub", true, 48, 48]]);
	assert.match(fs.readFileSync(w.service.collectionFile("network-kit"), "utf8"), /^<mxlibrary>\[.*Switch.*Hub.*\]<\/mxlibrary>$/s);
	assert.deepEqual(w.posted.slice(-2), [{ type: "notice", message: "2 shapes are in the new collection “Network kit”." }, { type: "selectGallery", id: "network-kit" }]);
	// saved once: the same answer again finds nothing waiting
	await assert.rejects(w.core.onMessage({ type: "saveStencil", token: asked.token, title: "Again" }), /no longer waiting/);

	// declined: dropped
	await w.core.onMessage({ type: "importStencil" });
	const second = w.posted.filter((m) => m.type === "stencil").pop();
	await w.core.onMessage({ type: "dropStencil", token: second.token });
	await assert.rejects(w.core.onMessage({ type: "saveStencil", token: second.token, title: "Late" }), /no longer waiting/);
	w.core.dispose();

	// the file dialog cancelled: nothing happens; no diagram to convert with: said
	const cancelled = workshop({ pickStencil: undefined });
	await cancelled.core.onMessage({ type: "importStencil" });
	assert.equal(cancelled.posted.some((m) => m.type === "stencil"), false);
	cancelled.core.dispose();
	const closed = workshop({ noDiagram: true });
	await assert.rejects(closed.core.onMessage({ type: "importStencil" }), /Open a diagram first/);
	closed.core.dispose();
});

test("find by words: an editor that never answers does not hold the galleries' answer back", async (t) => {
	const w = workshop({ host: { searchBuiltIn: () => new Promise(() => undefined) } });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const finding = w.core.onMessage({ type: "find", query: "router", reqId: 9 });
	// (the galleries are read from disk, with no timers; then the wait for the editor runs out)
	for (let i = 0; i < 50 && !w.posted.some((m) => m.type === "found"); i++) {
		await new Promise((r) => setImmediate(r));
		t.mock.timers.tick(1000);
	}
	t.mock.timers.reset();
	await finding;
	const found = w.posted.find((m) => m.type === "found");
	assert.deepEqual([found.reqId, found.diagram, found.own.length, found.hits.map((h) => h.title)], [9, true, 0, ["router"]]);
	w.core.dispose();
});

test("with the Shape Shifter off (the extension, for now) its messages change nothing", async () => {
	const w = workshop({ off: true });
	await w.core.onMessage({ type: "ready" });
	await w.settle();
	assert.equal(w.posted.filter((m) => m.type === "state").pop().shifter, false);
	w.posted.length = 0;
	// a search still answers with the galleries; nothing is asked of a diagram
	await w.core.onMessage({ type: "find", query: "router", reqId: 1 });
	const found = w.posted.find((m) => m.type === "found");
	assert.deepEqual([found.diagram, found.own, found.hits.length], [false, [], 1]);
	await assert.rejects(w.core.onMessage({ type: "insertFound", key: "own:1:0" }), /Search again/);
	await assert.rejects(w.core.onMessage({ type: "restyle", fill: "#ff0000" }), /not available here yet/);
	await assert.rejects(w.core.onMessage({ type: "describeChange", text: "make it red" }), /not available here yet/);
	await w.core.onMessage({ type: "importStencil" });
	await assert.rejects(w.core.onMessage({ type: "saveStencil", token: "s1", title: "x" }), /no longer waiting/);
	await w.core.onMessage({ type: "dropStencil", token: "s1" });
	await w.core.onMessage({ type: "selection" });
	await w.settle();
	assert.deepEqual(w.posted.filter((m) => m.type === "selection").pop(), { type: "selection", count: 0, icons: 0 });
	assert.deepEqual([w.inserted, w.applied, w.asked, w.configs().length, w.posted.some((m) => m.type === "stencil")], [[], [], [], 1, false]);
	w.core.dispose();
});

test("a stencil that waits for its name: only its own answer drops it, and a closed page does", async () => {
	const w = workshop();
	await w.core.onMessage({ type: "importStencil" });
	const first = w.posted.find((m) => m.type === "stencil");
	// an answer for another stencil (an older dialog, a message that arrived twice) leaves this one waiting
	await w.core.onMessage({ type: "dropStencil", token: "s0" });
	await w.core.onMessage({ type: "dropStencil" });
	await w.core.onMessage({ type: "saveStencil", token: first.token, title: "Kept" });
	assert.ok(w.configs().some((g) => g.title === "Kept"));
	// the page closed while the name was asked: nothing is kept for it
	await w.core.onMessage({ type: "importStencil" });
	const second = w.posted.filter((m) => m.type === "stencil").pop();
	w.core.pageGone();
	await assert.rejects(w.core.onMessage({ type: "saveStencil", token: second.token, title: "Late" }), /no longer waiting/);
	w.core.dispose();

	// the page closed while the stencil was still being converted: it is not kept either
	let finish;
	const slow = workshop({ host: { convertStencil: () => new Promise((resolve) => (finish = resolve)) } });
	const importing = slow.core.onMessage({ type: "importStencil" });
	for (let i = 0; i < 50 && !finish; i++) await new Promise((r) => setImmediate(r));
	slow.core.pageGone();
	finish(await slow.shifterHost.convertStencil("/stencils/Network Devices.vssx"));
	await importing;
	assert.equal(slow.posted.some((m) => m.type === "stencil"), false);
	await assert.rejects(slow.core.onMessage({ type: "saveStencil", token: "s1", title: "Late" }), /no longer waiting/);
	slow.core.dispose();
});

test("the selection shown is the latest one asked for, also when an older answer comes late", async () => {
	const answers = [];
	const w = workshop({ host: { selectedCells: () => new Promise((resolve) => answers.push(resolve)) } });
	w.core.postSelection();
	await w.settle();
	w.core.postSelection();
	await w.settle();
	assert.equal(answers.length, 2);
	answers[1]([{ id: "new", style: "fillColor=#00ff00;", edge: false }]);
	answers[0]([{ id: "old", style: "fillColor=#ff0000;", edge: false }, { id: "old2", style: "", edge: false }]);
	await w.settle();
	assert.deepEqual(w.posted.filter((m) => m.type === "selection"), [{ type: "selection", count: 1, icons: 0, fill: "#00ff00", stroke: undefined, font: undefined }]);
	w.core.dispose();
});

test("pictures inside a library's shapes are checked like every other image", () => {
	const { cleanShapeXml, parseMxLibrary } = require("../src/main/workshop/sources");
	const zlib = require("zlib");
	const pack = (xml) => zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");
	const unpack = (data) => decodeURIComponent(zlib.inflateRawSync(Buffer.from(data, "base64")).toString("utf8"));
	const shape = (style) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A &amp; B" style="${style}" vertex="1" parent="1"><mxGeometry width="40" height="40" as="geometry"/></mxCell></root></mxGraphModel>`;
	const bad = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="https://evil.example/x"><circle r="4" fill="#f00"/></a></svg>';
	const b64 = (svg) => Buffer.from(svg).toString("base64");
	const imageOf = (xml) => /image=data:image\/svg\+xml,([A-Za-z0-9+/=]+)/.exec(xml)?.[1];

	// nothing embedded, or a raster image: the shape comes back as it was, in the form it was in
	const plain = shape("rounded=1;fillColor=#dae8fc;");
	assert.equal(cleanShapeXml(plain), plain);
	assert.equal(cleanShapeXml(pack(plain)), pack(plain));
	const png = pack(shape("shape=image;image=data:image/png,iVBORw0KGgo=;aspect=fixed;"));
	assert.equal(cleanShapeXml(png), png);
	// names of files and web addresses are not embedded content
	for (const image of ["img/lib/clip_art/computers/Database_128x128.png", "https://example.com/logo.png"]) assert.equal(cleanShapeXml(shape(`shape=image;image=${image};`)), shape(`shape=image;image=${image};`));

	// an SVG is cleaned: draw.io's base64 form, the URI-encoded one, deflated or plain
	for (const [input, deflated] of [[pack(shape(`shape=image;image=data:image/svg+xml,${b64(bad)};aspect=fixed;`)), true], [shape(`shape=image;image=data:image/svg+xml,${encodeURIComponent(bad)};aspect=fixed;`), false]]) {
		const out = cleanShapeXml(input);
		assert.notEqual(out, input);
		assert.equal(out.startsWith("<"), !deflated, "the form it came in");
		const xml = deflated ? unpack(out) : out;
		const svg = Buffer.from(imageOf(xml), "base64").toString("utf8");
		assert.doesNotMatch(svg, /script|onload|alert|evil/);
		assert.match(svg, /<circle r="4" fill="#f00"\/>/);
		// the rest of the shape is as it was
		assert.match(xml, /value="A &amp; B" style="shape=image;image=data:image\/svg\+xml,[A-Za-z0-9+/=]+;aspect=fixed;" vertex="1"/);
		// cleaned once, it stays as it is
		assert.equal(cleanShapeXml(out), out);
	}
	// what claims to be embedded and is not an image loses the picture, not the shape
	assert.equal(cleanShapeXml(shape("shape=image;image=data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;;aspect=fixed;")), shape("shape=image;aspect=fixed;"));
	assert.equal(cleanShapeXml(shape(`shape=image;image=data:image/svg+xml,${b64("<p>not an svg</p>")};`)), shape("shape=image;"));
	// a character reference does not hide a picture from the check
	const hidden = cleanShapeXml(shape(`shape=image;image=&#100;ata:image/svg+xml,${b64(bad)};`));
	assert.doesNotMatch(Buffer.from(imageOf(hidden), "base64").toString("utf8"), /script|onload|evil/);
	// a style that is rewritten keeps what else it says, quotes and line breaks included
	assert.match(cleanShapeXml(shape(`shape=image;image=data:image/svg+xml,${b64(bad)};note=a &amp; &quot;b&quot;&#10;c;`)), /;note=a &amp; &quot;b&quot;&#10;c;" vertex="1"/);
	// the bitmaps a converted Visio stencil keeps (draw.io's importer writes these types) stay as they are
	for (const type of ["jpg", "jpeg", "gif", "bmp", "tiff"]) assert.equal(cleanShapeXml(shape(`shape=image;image=data:image/${type},AAAA;`)), shape(`shape=image;image=data:image/${type},AAAA;`));
	// an attribute's value that looks like a style attribute does not hide the real one
	const decoy = cleanShapeXml(`<mxGraphModel><root><mxCell id="2" value="a style='" style="image=data:image/svg+xml,${b64(bad)};shape=image;" b='x' vertex="1"/></root></mxGraphModel>`);
	assert.match(decoy, /^<mxGraphModel><root><mxCell id="2" value="a style='" style="image=data:image\/svg\+xml,[A-Za-z0-9+/=]+;shape=image;" b='x' vertex="1"\/><\/root><\/mxGraphModel>$/);
	assert.doesNotMatch(Buffer.from(imageOf(decoy), "base64").toString("utf8"), /script|onload|evil/);
	// every key that holds a picture is checked, not only image=
	const indicator = cleanShapeXml(shape(`shape=label;indicatorImage=data:image/svg+xml,${b64(bad)};IMAGE=data:text/html,x;`));
	assert.match(indicator, /style="shape=label;indicatorImage=data:image\/svg\+xml,[A-Za-z0-9+/=]+;"/);
	assert.doesNotMatch(Buffer.from(/indicatorImage=data:image\/svg\+xml,([A-Za-z0-9+/=]+)/.exec(indicator)[1], "base64").toString("utf8"), /script|onload|evil/);
	// an inline stencil's pictures are checked too; the stencil is packed again as draw.io reads it
	const stencilOf = (src) => `<shape name="s" w="10" h="10"><foreground><image src="${src}" x="0" y="0" w="10" h="10"/><rect x="0" y="0" w="10" h="10"/><stroke/></foreground></shape>`;
	const withStencil = cleanShapeXml(shape(`shape=stencil(${pack(stencilOf(`data:image/svg+xml;base64,${b64(bad)}`))});fillColor=#fff;`));
	const inner = unpack(/shape=stencil\(([A-Za-z0-9+/=]+)\);fillColor=#fff;/.exec(withStencil)[1]);
	assert.match(inner, /^<shape name="s" w="10" h="10"><foreground><image src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" x="0" y="0" w="10" h="10"\/><rect /);
	assert.doesNotMatch(Buffer.from(/base64,([A-Za-z0-9+/=]+)/.exec(inner)[1], "base64").toString("utf8"), /script|onload|evil/);
	const plainStencil = shape(`shape=stencil(${pack(stencilOf("data:image/png;base64,iVBORw0KGgo="))});`);
	assert.equal(cleanShapeXml(plainStencil), plainStencil);
	assert.match(unpack(/stencil\(([A-Za-z0-9+/=]+)\)/.exec(cleanShapeXml(shape(`shape=stencil(${pack(stencilOf("data:text/html,x"))});`)))[1]), /<image src="" x="0"/);
	// what cannot be checked is left out: a stencil that does not unpack, an SVG in a label's HTML, a DTD
	assert.equal(cleanShapeXml(shape("shape=stencil(@@@notdeflated@@@);")), undefined);
	assert.equal(cleanShapeXml(`<mxGraphModel><root><mxCell id="2" value="&lt;img src=&quot;data:image/svg+xml;base64,${b64(bad)}&quot;&gt;" style="html=1;" vertex="1"/></root></mxGraphModel>`), undefined);
	assert.equal(cleanShapeXml(`<!DOCTYPE mxGraphModel [<!ENTITY e "image=data:image/svg+xml,${b64(bad)}">]>${shape("shape=image;&e;")}`), undefined);
	assert.equal(cleanShapeXml(`<mxGraphModel><root><mxCell id="2" style="rounded=1;" vertex="1"><!-- an open comment</mxCell></root></mxGraphModel>`), undefined);
	// draw.io unpacks more than a shape's own XML; each of those ways in is checked or refused:
	// a file's pages around the model
	assert.equal(cleanShapeXml(`<mxfile><diagram id="a">${pack(shape(`shape=image;image=data:image/svg+xml,${b64(bad)};`))}</diagram></mxfile>`), undefined);
	assert.equal(cleanShapeXml(pack(`<mxfile><diagram id="a">${pack(plain)}</diagram></mxfile>`)), undefined);
	// a stencil that does not end the way draw.io writes it (draw.io drops the last character, whatever it is)
	assert.equal(cleanShapeXml(shape(`shape=stencil(${pack(stencilOf(`data:image/svg+xml;base64,${b64(bad)}`))}X;`)), undefined);
	assert.equal(cleanShapeXml(shape(`shape=stencil(${pack(stencilOf("data:image/png;base64,iVBORw0KGgo="))}) ;`)), undefined);
	// pictures and stencils that cells share, kept once in <defs>
	const shared = cleanShapeXml(
		`<mxGraphModel><defs><def data="stencil(${pack(stencilOf(`data:image/svg+xml;base64,${b64(bad)}`))})"/><def data="data:image/svg+xml,${b64(bad)}"/><def data="data:text/html,x"/><def data="data:image/png,iVBORw0KGgo="/></defs>` +
			`<root><mxCell id="0"/><mxCell id="2" style="shape=def(0);image=def(1);" vertex="1" parent="0"/></root></mxGraphModel>`
	);
	const defs = [...shared.matchAll(/<def data="([^"]*)"\/>/g)].map((m) => m[1]);
	assert.equal(defs.length, 4);
	assert.doesNotMatch(Buffer.from(/base64,([A-Za-z0-9+/=]+)/.exec(unpack(/^stencil\(([A-Za-z0-9+/=]+)\)$/.exec(defs[0])[1]))[1], "base64").toString("utf8"), /script|onload|evil/);
	assert.doesNotMatch(Buffer.from(/^data:image\/svg\+xml,([A-Za-z0-9+/=]+)$/.exec(defs[1])[1], "base64").toString("utf8"), /script|onload|evil/);
	assert.deepEqual(defs.slice(2), ["", "data:image/png,iVBORw0KGgo="]);
	assert.match(shared, /<mxCell id="2" style="shape=def\(0\);image=def\(1\);" vertex="1" parent="0"\/>/);
	// an address the browser would still read as data: (a tab inside it, spaces before it, upper case)
	for (const spelled of [`da&#9;ta:image/svg+xml,${b64(bad)}`, `  data:image/svg+xml,${b64(bad)}`, `d&#10;ata:image/svg+xml,${encodeURIComponent(bad)}`]) {
		const out = cleanShapeXml(shape(`shape=image;image=${spelled};`));
		assert.doesNotMatch(Buffer.from(imageOf(out), "base64").toString("utf8"), /script|onload|evil/, spelled);
		assert.doesNotMatch(out, /&#9;|&#10;/, spelled);
	}
	assert.equal(cleanShapeXml(shape(`shape=image;image=DATA:image/svg+xml,${b64(bad)};`)), shape("shape=image;"));
	// an SVG spelled with entities in a label is still one that was not checked
	for (const label of [`&lt;img src=&quot;data&amp;colon;image/svg+xml,x&quot;&gt;`, `&lt;img src=&quot;d&amp;#97;ta:image/svg+xml,x&quot;&gt;`, `&lt;img src=&quot;da&amp;Tab;ta:  image/svg+xml,x&quot;&gt;`])
		assert.equal(cleanShapeXml(`<mxGraphModel><root><mxCell id="2" value="${label}" style="html=1;" vertex="1"/></root></mxGraphModel>`), undefined, label);
	// ... and ordinary words in a label are not
	const prose = `<mxGraphModel><root><mxCell id="2" value="Metadata: images, SVG data" style="rounded=1;" vertex="1"/></root></mxGraphModel>`;
	assert.equal(cleanShapeXml(prose), prose);
	// the marks used while cleaning are not something a shape may bring along
	assert.equal(cleanShapeXml(shape(`rounded=1;note=\uFDD0data:image/svg+xml,x\uFDD1;`)), undefined);
	// size costs no more than size: a tag with a very long run of spaces, thousands of pictures
	const timed = Date.now();
	const spaced = `<mxGraphModel><root><mxCell id="2"${" ".repeat(300000)}style="shape=image;image=data:image/svg+xml,${b64(bad)};" vertex="1"/></root></mxGraphModel>`;
	assert.doesNotMatch(Buffer.from(imageOf(cleanShapeXml(spaced)), "base64").toString("utf8"), /script|onload|evil/);
	const many = `<mxGraphModel><root>${Array.from({ length: 3000 }, (_v, i) => `<mxCell id="p${i}" style="image=data:image/png,${Buffer.from(`png ${i}`).toString("base64")};" vertex="1"/><mxCell id="s${i}" style="image=data:image/svg+xml,${b64(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="${i}"/></svg>`)};" vertex="1"/>`).join("")}</root></mxGraphModel>`;
	assert.equal(cleanShapeXml(many), many);
	assert.ok(Date.now() - timed < 3000, `cleaning took ${Date.now() - timed} ms`);
	// a character reference that names no character is a space, not an error (also in an SVG)
	assert.equal(cleanShapeXml(shape("rounded=1;note=&#99999999;&#x110000;;")), shape("rounded=1;note=&#99999999;&#x110000;;"));
	assert.match(cleanShapeXml(shape(`note=&#99999999;;image=data:image/svg+xml,${b64(bad)};`)), /style="note= ;image=data:image\/svg\+xml,/);
	const { sanitizeSvg } = require("../src/main/workshop/svgSanitize");
	assert.match(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><title>&#99999999; &#x110000; &#0;</title><path d="M0 0"/></svg>'), /^<svg /);
	// what cannot be read is left out
	assert.equal(cleanShapeXml("not a deflated shape"), undefined);
	assert.equal(cleanShapeXml(""), undefined);

	// a library (a converted stencil is one): each shape's XML is cleaned, an unreadable one is left out
	const library = `<mxlibrary>${JSON.stringify([{ xml: pack(shape(`shape=image;image=data:image/svg+xml,${b64(bad)};`)), w: 40, h: 40, title: "Icon" }, { xml: "@@@", title: "Broken" }, { xml: pack(plain), title: "Box" }])}</mxlibrary>`;
	const items = parseMxLibrary(library, "Stencil");
	assert.deepEqual(items.map((i) => i.title), ["Icon", "Box"]);
	assert.doesNotMatch(Buffer.from(imageOf(unpack(items[0].xml)), "base64").toString("utf8"), /script|onload|evil/);
	assert.equal(items[1].xml, pack(plain));
});
