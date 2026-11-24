/*
 * OmniDraw desktop: the 4×4 dot mark, alive.
 *
 * At rest it is the brand mark (a square of dots, rows lit 4-3-2-1, one signal-red dot).
 * Every few seconds the dots leave the square along curved, staggered paths and draw
 * something (a circle, a face, a diamond, a plus, a wave, a heart, a spiral), hold it,
 * and come back to the square. Only transforms move; nothing loops while it rests.
 * Under "reduce motion" it stays a still mark. It pauses while the page is hidden or the
 * mark is off screen.
 *
 * A classic script: window.DrawAIBrandmark.mount(element, options) fills `element` with
 * an SVG and returns { destroy() }. Options: size (px, default 18), on / off / signal
 * colours (default: the page's --ink / --border-strong / --signal, or ink on paper).
 */
(function (root) {
	"use strict";

	var N = 16, TAU = Math.PI * 2;
	var LIT = [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 2, 0, 0, 0]; // 1 lit, 0 unlit, 2 signal

	function grid() {
		var p = [];
		for (var i = 0; i < N; i++) p.push([(i % 4) / 3, Math.floor(i / 4) / 3]);
		return p;
	}
	function onCircle(n, r, a0, a1, cx, cy) {
		var p = [];
		for (var i = 0; i < n; i++) {
			var a = a0 + ((a1 - a0) * i) / (a1 - a0 >= TAU - 1e-6 ? n : Math.max(1, n - 1));
			p.push([(cx == null ? 0.5 : cx) + r * Math.cos(a), (cy == null ? 0.5 : cy) + r * Math.sin(a)]);
		}
		return p;
	}
	var SHAPES = {
		circle: function () { return onCircle(16, 0.5, -Math.PI / 2, -Math.PI / 2 + TAU); },
		face: function () {
			// head (10), eyes (2), smile (4)
			return onCircle(9, 0.5, -Math.PI / 2, -Math.PI / 2 + TAU)
				.concat([[0.3, 0.34], [0.7, 0.34]])
				.concat(onCircle(5, 0.3, 0.45, Math.PI - 0.45, 0.5, 0.46));
		},
		diamond: function () {
			var c = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], p = [];
			for (var s = 0; s < 4; s++) for (var k = 0; k < 4; k++) {
				var a = c[s], b = c[(s + 1) % 4], t = k / 4;
				p.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			}
			return p;
		},
		plus: function () {
			var p = [], s = [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1];
			for (var i = 0; i < 8; i++) p.push([s[i], 0.5]);
			var v = [0, 0.15, 0.3, 0.42, 0.58, 0.7, 0.85, 1];
			for (var j = 0; j < 8; j++) p.push([0.5, v[j]]);
			return p;
		},
		wave: function () {
			var p = [];
			for (var i = 0; i < N; i++) { var x = i / 15; p.push([x, 0.5 - 0.3 * Math.sin(x * TAU)]); }
			return p;
		},
		heart: function () {
			var p = [];
			for (var i = 0; i < N; i++) {
				var t = (i / N) * TAU, x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
				p.push([0.5 + x / 34, 0.46 - y / 34]);
			}
			return p;
		},
		spiral: function () {
			var p = [];
			for (var i = 0; i < N; i++) { var t = i / 15, r = 0.06 + 0.44 * t, a = t * TAU * 1.6 - Math.PI / 2; p.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]); }
			return p;
		},
	};
	var SEQUENCE = ["circle", "face", "diamond", "plus", "wave", "heart", "spiral"];

	/** Pairs dots and targets by angle around the centre, so the dots swirl instead of crossing. */
	function assign(from, to) {
		var ang = function (p) { return Math.atan2(p[1] - 0.5, p[0] - 0.5); };
		var fi = from.map(function (p, i) { return i; }).sort(function (a, b) { return ang(from[a]) - ang(from[b]); });
		var ti = to.map(function (p, i) { return i; }).sort(function (a, b) { return ang(to[a]) - ang(to[b]); });
		var out = new Array(N);
		for (var k = 0; k < N; k++) out[fi[k]] = to[ti[k]];
		return out;
	}

	function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

	function mount(el, opts) {
		opts = opts || {};
		var size = opts.size || 18;
		var colors;
		function readColors() {
			var css = getComputedStyle(el);
			var v = function (name, fallback) { var x = css.getPropertyValue(name).trim(); return x || fallback; };
			var c = typeof opts.colors === "function" ? opts.colors() : opts;
			colors = { on: c.on || v("--ink", "#141414"), off: c.off || v("--border-strong", "#d2cfc8"), signal: c.signal || v("--signal", "#d71921") };
		}
		readColors();
		el.style.display = "inline-block";
		el.style.width = size + "px";
		el.style.height = size + "px";
		var ns = "http://www.w3.org/2000/svg";
		var svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "-1 -1 20 20");
		svg.setAttribute("width", size);
		svg.setAttribute("height", size);
		svg.setAttribute("aria-hidden", "true");
		svg.style.overflow = "visible";
		svg.style.display = "block";
		var home = grid();
		var dots = [];
		for (var i = 0; i < N; i++) {
			var c = document.createElementNS(ns, "circle");
			c.setAttribute("r", "1.5");
			c.setAttribute("cx", "0");
			c.setAttribute("cy", "0");
			svg.appendChild(c);
			dots.push({ el: c, p: home[i].slice(), kind: LIT[i] });
		}
		el.textContent = "";
		el.appendChild(svg);

		var reduce = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
		var away = 0; // 0 at home (brand colours), 1 drawing a shape (all lit)
		if (opts.pose && SHAPES[opts.pose]) {
			// a still pose (previews and screenshots)
			var posed = assign(home, SHAPES[opts.pose]());
			for (var pi = 0; pi < N; pi++) dots[pi].p = posed[pi];
			away = 1;
		}
		function paint() {
			for (var i = 0; i < N; i++) {
				var d = dots[i], x = 1.5 + d.p[0] * 15, y = 1.5 + d.p[1] * 15;
				d.el.setAttribute("transform", "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")" + (d.s && d.s !== 1 ? " scale(" + d.s.toFixed(3) + ")" : ""));
				var fill = d.kind === 2 ? colors.signal : d.kind === 1 || away > 0.5 ? colors.on : colors.off;
				d.el.setAttribute("fill", fill);
			}
		}
		paint();
		// colours follow the theme (system appearance, or the app's own setting)
		var scheme = root.matchMedia ? root.matchMedia("(prefers-color-scheme: dark)") : null;
		var recolor = function () { readColors(); paint(); };
		if (scheme && scheme.addEventListener) scheme.addEventListener("change", recolor);
		if (reduce || opts.still || opts.pose) return { recolor: recolor, destroy: function () { if (scheme && scheme.removeEventListener) scheme.removeEventListener("change", recolor); el.textContent = ""; } };

		var visible = true, hidden = false, raf = 0, timer = 0, destroyed = false, step = 0;
		var io = root.IntersectionObserver ? new IntersectionObserver(function (es) { visible = es[0] && es[0].isIntersecting; }) : null;
		if (io) io.observe(el);
		var onVis = function () { hidden = document.hidden; };
		document.addEventListener("visibilitychange", onVis);

		/** Moves every dot to `targets` over `dur` ms: staggered, along curved paths, a little swell mid-flight. */
		function move(targets, dur, done) {
			var start = null, from = dots.map(function (d) { return d.p.slice(); });
			var bend = dots.map(function (d, i) { return (i % 2 ? 1 : -1) * (0.18 + 0.12 * ((i * 7) % 5) / 4); });
			var lag = 26, total = dur + lag * (N - 1);
			function frame(t) {
				if (destroyed) return;
				if (start == null) start = t;
				var e = t - start;
				for (var i = 0; i < N; i++) {
					var k = Math.max(0, Math.min(1, (e - lag * i) / dur)), q = ease(k);
					var a = from[i], b = targets[i];
					// quadratic curve: control point pushed sideways from the straight path
					var mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * bend[i], my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * bend[i];
					var u = 1 - q;
					dots[i].p = [u * u * a[0] + 2 * u * q * mx + q * q * b[0], u * u * a[1] + 2 * u * q * my + q * q * b[1]];
					dots[i].s = 1 + 0.45 * Math.sin(Math.PI * k);
				}
				paint();
				if (e < total) raf = requestAnimationFrame(frame);
				else {
					for (var j = 0; j < N; j++) { dots[j].p = targets[j].slice(); dots[j].s = 1; }
					paint();
					done();
				}
			}
			raf = requestAnimationFrame(frame);
		}

		function wait(ms, then) {
			timer = setTimeout(function tick() {
				if (destroyed) return;
				// hold still (and spend nothing) while hidden or off screen
				if (hidden || !visible) { timer = setTimeout(tick, 1000); return; }
				then();
			}, ms);
		}

		function cycle() {
			var name = SEQUENCE[step++ % SEQUENCE.length];
			var target = assign(home, SHAPES[name]());
			away = 1;
			move(target, 760, function () {
				wait(1500, function () {
					move(home, 700, function () {
						away = 0;
						paint();
						wait(opts.rest || 2600, cycle);
					});
				});
			});
		}
		wait(opts.delay != null ? opts.delay : 1400, cycle);

		return {
			recolor: recolor,
			destroy: function () {
				destroyed = true;
				if (scheme && scheme.removeEventListener) scheme.removeEventListener("change", recolor);
				cancelAnimationFrame(raf);
				clearTimeout(timer);
				if (io) io.disconnect();
				document.removeEventListener("visibilitychange", onVis);
				el.textContent = "";
			},
		};
	}

	root.DrawAIBrandmark = { mount: mount, shapes: Object.keys(SHAPES) };
})(typeof window !== "undefined" ? window : globalThis);
