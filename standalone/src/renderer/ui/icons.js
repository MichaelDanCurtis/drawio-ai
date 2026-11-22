/*
 * OmniDraw: the app's icons, drawn in one of four styles.
 *
 * Every icon is a flat glyph on a 16×16 grid (lines, closed outlines, filled shapes).
 * The engine stands it up in 3D, gives it depth, turns it a little and draws it as:
 *   classic    flat ink lines (no depth), like draw.io's own icons
 *   isometric  thin ink lines with their back edges and depth edges: a small wire object
 *   dots       the same object in dots, near dots larger and darker (the dot-matrix look)
 *   extruded   solid side walls shaded by the way they face, ink on the front: small blocks
 * One glyph set, so an icon reads the same in every style.
 *
 * A classic script (no module): the chat, Settings and the Mapper load it with
 * <script src>, and draw.io loads it as a plugin. It sets window.DrawAIIcons.
 */
(function (root) {
	"use strict";

	// ---------- glyphs: 16×16, y down ----------

	var TAU = Math.PI * 2;
	function L() { return { k: "line", pts: pairs(arguments) }; }
	function P() { return { k: "poly", pts: pairs(arguments) }; }
	function F() { return { k: "fill", pts: pairs(arguments) }; }
	function pairs(a) { var out = []; for (var i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; }
	function arc(cx, cy, rx, ry, a0, a1, n) {
		var pts = [];
		n = n || Math.max(6, Math.round(Math.abs(a1 - a0) / TAU * 28));
		for (var i = 0; i <= n; i++) {
			var a = a0 + (a1 - a0) * (i / n);
			pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
		}
		return pts;
	}
	function circle(cx, cy, r) { var p = arc(cx, cy, r, r, 0, TAU, 28); p.pop(); return { k: "poly", pts: p }; }
	function ellipse(cx, cy, rx, ry, dash) { var p = arc(cx, cy, rx, ry, 0, TAU, 32); p.pop(); return { k: "poly", pts: p, dash: dash }; }
	function curve(pts) { return { k: "line", pts: pts }; }
	function rect(x, y, w, h) { return P(x, y, x + w, y, x + w, y + h, x, y + h); }
	function arrowHead(x, y, dx, dy, s) {
		// a small open head at (x, y) pointing along (dx, dy)
		var len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, px = -uy, py = ux;
		return L(x - ux * s + px * s * 0.8, y - uy * s + py * s * 0.8, x, y, x - ux * s - px * s * 0.8, y - uy * s - py * s * 0.8);
	}
	function star(cx, cy, r, inner) {
		var pts = [];
		for (var i = 0; i < 8; i++) {
			var a = -Math.PI / 2 + i * Math.PI / 4, rr = i % 2 ? r * inner : r;
			pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
		}
		return { k: "fill", pts: pts };
	}

	var G = {
		// chat
		lasso: [ellipse(8, 7, 6, 4.6, true), curve(arc(4.6, 12.2, 1.6, 1.6, -1.2, 1.9, 8))],
		sparkle: [star(7, 8.5, 5.8, 0.28), star(12.6, 3.4, 2.2, 0.32)],
		pen: [P(10.5, 2.5, 13.5, 5.5, 5.5, 13.5, 2.5, 13.5, 2.5, 10.5), L(9, 4, 12, 7)],
		check: [circle(8, 8, 6), L(5.3, 8.2, 7.1, 10, 10.7, 6.2)],
		map: [P(1.5, 3.5, 5.5, 2, 10.5, 3.5, 14.5, 2, 14.5, 12.5, 10.5, 14, 5.5, 12.5, 1.5, 14), L(5.5, 2, 5.5, 12.5), L(10.5, 3.5, 10.5, 14)],
		search: [circle(7, 7, 4.5), L(10.3, 10.3, 14, 14)],
		plus: [L(8, 2.5, 8, 13.5), L(2.5, 8, 13.5, 8)],
		minus: [L(2.5, 8, 13.5, 8)],
		image: [rect(2, 3, 12, 10), circle(5.8, 6.4, 1.2), L(2.4, 11.8, 6.2, 8.4, 9, 10.8, 10.8, 9.2, 13.6, 11.8)],
		gear: (function () {
			var pts = [];
			for (var i = 0; i < 8; i++) {
				var a0 = (i / 8) * TAU, w = TAU / 8;
				pts.push.apply(pts, [[8 + 6 * Math.cos(a0 - w * 0.18), 8 + 6 * Math.sin(a0 - w * 0.18)], [8 + 6 * Math.cos(a0 + w * 0.18), 8 + 6 * Math.sin(a0 + w * 0.18)], [8 + 4.6 * Math.cos(a0 + w * 0.32), 8 + 4.6 * Math.sin(a0 + w * 0.32)], [8 + 4.6 * Math.cos(a0 + w * 0.68), 8 + 4.6 * Math.sin(a0 + w * 0.68)]]);
			}
			return [{ k: "poly", pts: pts }, circle(8, 8, 1.9)];
		})(),
		chatPanel: [rect(1.5, 2.5, 13, 11), L(10, 2.5, 10, 13.5), L(11.6, 5.5, 12.9, 5.5), L(11.6, 7.5, 12.9, 7.5)],
		collapseRight: [rect(1.5, 2.5, 13, 11), L(10, 2.5, 10, 13.5), L(5, 5.5, 7.5, 8, 5, 10.5)],
		collapseLeft: [rect(1.5, 2.5, 13, 11), L(6, 2.5, 6, 13.5), L(11, 5.5, 8.5, 8, 11, 10.5)],
		send: [P(2, 8, 14, 2.5, 10.5, 14, 8, 9.5), L(8, 9.5, 14, 2.5)],
		// draw.io toolbar
		panels: [rect(1.5, 2.5, 13, 11), L(5.5, 2.5, 5.5, 13.5), L(2.8, 5, 4.2, 5), L(2.8, 7, 4.2, 7), L(2.8, 9, 4.2, 9)],
		format: [rect(1.5, 2.5, 13, 11), L(10.5, 2.5, 10.5, 13.5), L(11.8, 5, 13.2, 5), L(11.8, 7, 13.2, 7), L(11.8, 9, 13.2, 9)],
		formatOpen: [rect(1.5, 2.5, 13, 11), L(10.5, 2.5, 10.5, 13.5), L(8.2, 5.8, 6, 8, 8.2, 10.2)],
		zoomIn: [circle(7, 7, 4.8), L(10.5, 10.5, 14.2, 14.2), L(7, 4.8, 7, 9.2), L(4.8, 7, 9.2, 7)],
		zoomOut: [circle(7, 7, 4.8), L(10.5, 10.5, 14.2, 14.2), L(4.8, 7, 9.2, 7)],
		undo: [curve(arc(8.5, 9, 5, 4.5, -Math.PI * 0.95, 0.15 * Math.PI)), arrowHead(3.6, 8.4, -0.15, 1, 2.4)],
		redo: [curve(arc(7.5, 9, 5, 4.5, Math.PI * 0.85, Math.PI * 1.95)), arrowHead(12.4, 8.4, 0.15, 1, 2.4)],
		trash: [L(2.5, 4, 13.5, 4), P(4, 4, 12, 4, 11.2, 14, 4.8, 14), L(6.2, 4, 6.6, 2, 9.4, 2, 9.8, 4), L(6.8, 6.5, 6.8, 11.5), L(9.2, 6.5, 9.2, 11.5)],
		toFront: [rect(2, 2, 8, 8), F(6, 6, 14, 6, 14, 14, 6, 14)],
		toBack: [F(2, 2, 10, 2, 10, 10, 2, 10), rect(6, 6, 8, 8)],
		fillColor: [P(3, 7, 8, 2, 13, 7, 8, 12), L(1.5, 14.5, 14.5, 14.5), F(12.6, 9.6, 13.8, 11.6, 12.6, 12.4, 11.4, 11.6)],
		strokeColor: [L(3, 12.5, 11, 4.5), P(11, 4.5, 12.8, 2.7, 14, 3.9, 12.2, 5.7), L(1.5, 14.5, 14.5, 14.5)],
		shadow: [rect(2, 2, 9, 9), F(13, 5, 14, 5, 14, 14, 5, 14, 5, 13, 13, 13)],
		shapes: [circle(4.8, 4.8, 3.2), rect(9, 1.8, 5.6, 5.6), P(4.8, 8.8, 8.6, 14.6, 1, 14.6), F(11.8, 9, 14.6, 11.8, 11.8, 14.6, 9, 11.8)],
		table: [rect(1.5, 2.5, 13, 11), L(1.5, 6.2, 14.5, 6.2), L(1.5, 9.9, 14.5, 9.9), L(6, 2.5, 6, 13.5), L(10.3, 2.5, 10.3, 13.5)],
		freehand: [curve([[1.8, 11.5], [3.4, 6.5], [5.4, 4.8], [6.8, 6.8], [6.4, 10.6], [7.6, 12.6], [9.6, 10.4], [10.6, 6.2], [12.4, 4.4], [14.2, 6]])],
		layout: [rect(6, 1.6, 4, 3.2), rect(1.6, 11.2, 4, 3.2), rect(10.4, 11.2, 4, 3.2), L(8, 4.8, 8, 8, 3.6, 8, 3.6, 11.2), L(8, 8, 12.4, 8, 12.4, 11.2)],
		fullscreen: [L(1.8, 5.5, 1.8, 1.8, 5.5, 1.8), L(10.5, 1.8, 14.2, 1.8, 14.2, 5.5), L(14.2, 10.5, 14.2, 14.2, 10.5, 14.2), L(5.5, 14.2, 1.8, 14.2, 1.8, 10.5)],
		fullscreenExit: [L(5.5, 1.8, 5.5, 5.5, 1.8, 5.5), L(10.5, 1.8, 10.5, 5.5, 14.2, 5.5), L(14.2, 10.5, 10.5, 10.5, 10.5, 14.2), L(5.5, 14.2, 5.5, 10.5, 1.8, 10.5)],
		layers: [P(8, 1.8, 14.4, 5.2, 8, 8.6, 1.6, 5.2), L(1.6, 8.2, 8, 11.6, 14.4, 8.2), L(1.6, 11.2, 8, 14.6, 14.4, 11.2)],
		tags: [P(1.8, 1.8, 8.2, 1.8, 14.4, 8, 8, 14.4, 1.8, 8.2), circle(5, 5, 1.2)],
		outline: [rect(1.5, 2.5, 13, 11), rect(7.5, 6.5, 5, 4.6)],
		present: [rect(1.5, 2, 13, 9), L(8, 11, 8, 14.5), L(5, 14.5, 11, 14.5), F(6.6, 4.6, 10.6, 6.5, 6.6, 8.4)],
		workshop: [rect(1.6, 7.6, 6.2, 6.2), circle(11.4, 10.7, 3.1), P(4.7, 1.6, 7.8, 6.2, 1.6, 6.2), star(12.3, 3.8, 2.6, 0.3)],
		dots: [circle(3.5, 8, 1.1), circle(8, 8, 1.1), circle(12.5, 8, 1.1)],
	};

	// ---------- 3D: stand the glyph up, give it depth, turn it ----------

	var DEPTH = 2.8;
	var YAW = 0.5, PITCH = 0.36; // radians: turned right, seen from a little above
	var cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
	function project(x, y, z) {
		var X = x - 8, Y = y - 8, Z = z;
		var x1 = X * cy + Z * sy, z1 = -X * sy + Z * cy;
		var y2 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp;
		return [x1, y2, z2];
	}
	// One fit for every icon (from the 16×16 square's eight corners), so they line up.
	var FIT = (function () {
		var xs = [], ys = [];
		[0, 16].forEach(function (x) { [0, 16].forEach(function (y) { [0, DEPTH].forEach(function (z) { var p = project(x, y, z); xs.push(p[0]); ys.push(p[1]); }); }); });
		var minX = Math.min.apply(0, xs), maxX = Math.max.apply(0, xs), minY = Math.min.apply(0, ys), maxY = Math.max.apply(0, ys);
		var s = 22 / Math.max(maxX - minX, maxY - minY);
		return { s: s, ox: 12 - ((minX + maxX) / 2) * s, oy: 12 - ((minY + maxY) / 2) * s };
	})();
	function view(x, y, z) {
		var p = project(x, y, z);
		return [p[0] * FIT.s + FIT.ox, p[1] * FIT.s + FIT.oy, p[2]];
	}
	function flat(x, y) { return [x * 1.25 + 2, y * 1.25 + 2]; }

	function segments(item) {
		var pts = item.pts, out = [];
		for (var i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
		if (item.k !== "line" && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
		return out;
	}
	function n(v) { return Math.round(v * 100) / 100; }
	function path(points, close) {
		return points.map(function (p, i) { return (i ? "L" : "M") + n(p[0]) + " " + n(p[1]); }).join("") + (close ? "Z" : "");
	}
	// Corners where the line turns sharply (and line ends): where depth edges are drawn.
	function corners(item) {
		var pts = item.pts, out = [], closed = item.k !== "line";
		for (var i = 0; i < pts.length; i++) {
			var prev = pts[i - 1] || (closed ? pts[pts.length - 1] : null), next = pts[i + 1] || (closed ? pts[0] : null);
			if (!prev || !next) { out.push(pts[i]); continue; }
			var a = Math.atan2(pts[i][1] - prev[1], pts[i][0] - prev[0]), b = Math.atan2(next[1] - pts[i][1], next[0] - pts[i][0]);
			var turn = Math.abs(((b - a + Math.PI * 3) % TAU) - Math.PI);
			if (turn > 0.5) out.push(pts[i]);
		}
		// round outlines have no corners: use their silhouette (leftmost and rightmost points)
		if (closed && out.length === 0 && pts.length > 8) {
			var l = pts[0], r = pts[0];
			pts.forEach(function (p) { var v = view(p[0], p[1], 0); if (v[0] < view(l[0], l[1], 0)[0]) l = p; if (v[0] > view(r[0], r[1], 0)[0]) r = p; });
			out.push(l, r);
		}
		return out;
	}

	// ---------- renderers ----------

	function svgWrap(body, opts) {
		var size = opts.size || 16;
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + "</svg>";
	}

	function classic(items, c) {
		return items.map(function (it) {
			var pts = it.pts.map(function (p) { return flat(p[0], p[1]); });
			if (it.k === "fill") return '<path d="' + path(pts, true) + '" fill="' + c + '"/>';
			return '<path d="' + path(pts, it.k === "poly") + '" stroke="' + c + '" stroke-width="1.7"' + (it.dash ? ' stroke-dasharray="2.6 2.4"' : "") + "/>";
		}).join("");
	}

	function isometric(items, c) {
		var back = "", edges = "", front = "";
		items.forEach(function (it) {
			var f = it.pts.map(function (p) { return view(p[0], p[1], 0); });
			var b = it.pts.map(function (p) { return view(p[0], p[1], DEPTH); });
			var closed = it.k !== "line";
			back += '<path d="' + path(b, closed) + '" stroke="' + c + '" stroke-opacity="0.32" stroke-width="1"' + (it.dash ? ' stroke-dasharray="2 2.2"' : "") + "/>";
			corners(it).forEach(function (p) {
				var a = view(p[0], p[1], 0), z = view(p[0], p[1], DEPTH);
				edges += '<path d="M' + n(a[0]) + " " + n(a[1]) + "L" + n(z[0]) + " " + n(z[1]) + '" stroke="' + c + '" stroke-opacity="0.55" stroke-width="1"/>';
			});
			if (it.k === "fill") front += '<path d="' + path(f, true) + '" fill="' + c + '" fill-opacity="0.92" stroke="' + c + '" stroke-width="1.1"/>';
			else front += '<path d="' + path(f, closed) + '" stroke="' + c + '" stroke-width="1.55"' + (it.dash ? ' stroke-dasharray="2.6 2.4"' : "") + "/>";
		});
		return back + edges + front;
	}

	function extruded(items, c) {
		var walls = [], fronts = "";
		items.forEach(function (it) {
			segments(it).forEach(function (s) {
				var a = view(s[0][0], s[0][1], 0), b = view(s[1][0], s[1][1], 0), b2 = view(s[1][0], s[1][1], DEPTH), a2 = view(s[0][0], s[0][1], DEPTH);
				// how the wall faces: its glyph-space direction decides the shade (light from above left)
				var dx = s[1][0] - s[0][0], dy = s[1][1] - s[0][1], len = Math.hypot(dx, dy) || 1;
				var nx = dy / len, ny = -dx / len; // a normal of the segment in the glyph plane
				var light = Math.abs(nx * 0.55 + ny * 0.83);
				walls.push({ z: (a[2] + b[2] + a2[2] + b2[2]) / 4, d: path([a, b, b2, a2], true), o: 0.16 + 0.34 * (1 - light) });
			});
			var f = it.pts.map(function (p) { return view(p[0], p[1], 0); });
			if (it.k === "fill") fronts += '<path d="' + path(f, true) + '" fill="' + c + '" stroke="' + c + '" stroke-width="1"/>';
			else fronts += '<path d="' + path(f, it.k === "poly") + '" stroke="' + c + '" stroke-width="2.1"' + (it.dash ? ' stroke-dasharray="2.6 2.4"' : "") + "/>";
		});
		walls.sort(function (p, q) { return q.z - p.z; });
		return walls.map(function (w) { return '<path d="' + w.d + '" fill="' + c + '" fill-opacity="' + n(w.o) + '" stroke="' + c + '" stroke-opacity="0.35" stroke-width="0.5"/>'; }).join("") + fronts;
	}

	function sample(pts, closed, step) {
		var out = [], list = closed ? pts.concat([pts[0]]) : pts, carry = 0;
		for (var i = 0; i + 1 < list.length; i++) {
			var a = list[i], b = list[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
			var t = carry;
			while (t <= len) { out.push([a[0] + (b[0] - a[0]) * (t / len), a[1] + (b[1] - a[1]) * (t / len)]); t += step; }
			carry = t - len;
		}
		if (!closed) out.push(list[list.length - 1]);
		return out;
	}

	function dots(items, c) {
		var all = [];
		items.forEach(function (it) {
			var closed = it.k !== "line";
			if (it.k === "fill") {
				// fill the shape with a dot grid
				var xs = it.pts.map(function (p) { return p[0]; }), ys = it.pts.map(function (p) { return p[1]; });
				for (var x = Math.min.apply(0, xs); x <= Math.max.apply(0, xs); x += 1.3)
					for (var y = Math.min.apply(0, ys); y <= Math.max.apply(0, ys); y += 1.3)
						if (inside([x, y], it.pts)) all.push({ p: view(x, y, 0), r: 0.95, o: 1 });
			}
			sample(it.pts, closed, 1.5).forEach(function (p) { all.push({ p: view(p[0], p[1], 0), r: 0.95, o: 1 }); });
			sample(it.pts, closed, 2.2).forEach(function (p) { all.push({ p: view(p[0], p[1], DEPTH), r: 0.6, o: 0.4 }); });
			corners(it).forEach(function (p) { all.push({ p: view(p[0], p[1], DEPTH * 0.5), r: 0.72, o: 0.65 }); });
		});
		all.sort(function (a, b) { return b.p[2] - a.p[2]; });
		return all.map(function (d) { return '<circle cx="' + n(d.p[0]) + '" cy="' + n(d.p[1]) + '" r="' + n(d.r) + '" fill="' + c + '"' + (d.o < 1 ? ' fill-opacity="' + d.o + '"' : "") + "/>"; }).join("");
	}
	function inside(pt, poly) {
		var c = false;
		for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			if (poly[i][1] > pt[1] !== poly[j][1] > pt[1] && pt[0] < ((poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
		}
		return c;
	}

	var RENDER = { classic: classic, isometric: isometric, dots: dots, extruded: extruded };
	var cache = {};

	var api = {
		styles: ["classic", "isometric", "dots", "extruded"],
		labels: { classic: "Classic (flat)", isometric: "Isometric line", dots: "Dot-matrix 3D", extruded: "Soft extruded" },
		names: Object.keys(G),
		/** The icon as SVG markup. opts: { size (px, default 16), color (default currentColor) }. */
		svg: function (name, style, opts) {
			opts = opts || {};
			var glyph = G[name];
			if (!glyph) return "";
			var render = RENDER[style] || RENDER.isometric;
			var key = name + "|" + style + "|" + (opts.color || "") + "|" + (opts.size || "");
			if (!cache[key]) cache[key] = svgWrap(render(glyph, opts.color || "currentColor"), opts);
			return cache[key];
		},
		/** The icon as a data: URI (for CSS backgrounds and draw.io's toolbar). */
		dataUri: function (name, style, opts) {
			return "data:image/svg+xml;base64," + btoa(api.svg(name, style, opts));
		},
		/** Fills every element with a data-icon attribute in `rootEl` (default: the document). */
		apply: function (style, rootEl) {
			var els = (rootEl || document).querySelectorAll("[data-icon]");
			for (var i = 0; i < els.length; i++) {
				var el = els[i], name = el.getAttribute("data-icon");
				var existing = el.querySelector("svg.icon");
				var holder = document.createElement("span");
				holder.innerHTML = api.svg(name, style, { size: Number(el.getAttribute("data-icon-size")) || 16 });
				var svg = holder.firstChild;
				if (!svg) continue;
				svg.setAttribute("class", "icon");
				if (existing) existing.replaceWith(svg);
				else el.insertBefore(svg, el.firstChild);
			}
		},
	};
	root.DrawAIIcons = api;
})(typeof window !== "undefined" ? window : globalThis);
