/*
 * OmniDraw: quick tooltips. The system's own tooltip (the title attribute) waits about a
 * second; these show after a tenth of one, and at once when moving from one control to the
 * next. Any element with a title gets one: the title is moved to data-tip when the pointer
 * arrives (so the slow system tooltip does not also appear) and kept as the accessible name.
 *
 * A classic script: the app's pages load it with <script src>, draw.io loads it as a plugin.
 */
(function (root) {
	"use strict";
	if (!root.document || root.DrawAITips) return;
	var doc = root.document;
	var DELAY = 110, WARM_FOR = 500;
	var tip = null, timer = 0, target = null, hiddenAt = 0;

	function box() {
		if (tip) return tip;
		tip = doc.createElement("div");
		tip.setAttribute("role", "tooltip");
		var s = tip.style;
		s.position = "fixed";
		s.zIndex = "2147483000";
		s.pointerEvents = "none";
		s.maxWidth = "280px";
		s.padding = "5px 9px";
		s.borderRadius = "7px";
		s.background = "#1c1c1c";
		s.color = "#ededed";
		s.border = "1px solid #3a3a3a";
		s.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.28)";
		s.font = '12px/1.4 "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif';
		s.whiteSpace = "normal";
		s.opacity = "0";
		s.transition = "opacity 90ms ease-out";
		s.left = "0";
		s.top = "0";
		s.display = "none";
		(doc.body || doc.documentElement).appendChild(tip);
		return tip;
	}

	/** The element's tooltip text; its title is moved out of the system tooltip's reach. */
	function textOf(el) {
		var t = el.getAttribute("title");
		if (t === "") el.removeAttribute("data-tip"); // cleared by the page: no tooltip any more
		if (t) {
			el.setAttribute("data-tip", t);
			el.removeAttribute("title");
			if (!el.getAttribute("aria-label") && !(el.textContent || "").trim()) el.setAttribute("aria-label", t);
		}
		return el.getAttribute("data-tip") || "";
	}
	function owner(node) {
		for (var el = node; el && el.nodeType === 1; el = el.parentNode) {
			if (el.hasAttribute("title") || el.hasAttribute("data-tip")) return el;
		}
		return null;
	}

	function show(el, text) {
		if (!el.isConnected) return;
		var t = box(), r = el.getBoundingClientRect();
		if (!r.width && !r.height) return;
		t.textContent = text;
		t.style.display = "block";
		var w = t.offsetWidth, h = t.offsetHeight, vw = root.innerWidth, vh = root.innerHeight;
		var x = Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2));
		var y = r.bottom + 7;
		if (y + h > vh - 6) y = Math.max(6, r.top - h - 7);
		t.style.left = Math.round(x) + "px";
		t.style.top = Math.round(y) + "px";
		t.style.opacity = "1";
	}
	function hide() {
		clearTimeout(timer);
		if (tip && tip.style.display !== "none") {
			tip.style.opacity = "0";
			tip.style.display = "none";
			hiddenAt = Date.now();
		}
		target = null;
	}

	doc.addEventListener("mouseover", function (e) {
		var el = owner(e.target);
		if (el === target) {
			// the page gave it a new title while the pointer was on it: take that, and keep the system's tooltip away
			if (el && el.getAttribute("title")) {
				var fresh = textOf(el);
				if (tip && tip.style.display !== "none") show(el, fresh);
			}
			return;
		}
		hide();
		if (!el) return;
		var text = textOf(el);
		if (!text) return;
		target = el;
		timer = setTimeout(function () { if (target === el) show(el, text); }, Date.now() - hiddenAt < WARM_FOR ? 0 : DELAY);
	}, true);
	// (leaving the window; moving between a control's own parts is not leaving it)
	doc.addEventListener("mouseout", function (e) { if (!e.relatedTarget) hide(); }, true);
	// a title that changes while its tooltip shows
	if (root.MutationObserver) {
		new root.MutationObserver(function () {
			if (!target || !target.hasAttribute("title")) return;
			var fresh = textOf(target);
			if (!fresh) hide();
			else if (tip && tip.style.display !== "none") show(target, fresh);
		}).observe(doc.documentElement, { attributes: true, attributeFilter: ["title"], subtree: true });
	}
	doc.addEventListener("mousedown", hide, true);
	doc.addEventListener("keydown", hide, true);
	doc.addEventListener("scroll", hide, true);
	root.addEventListener("blur", hide);

	root.DrawAITips = { hide: hide, delay: DELAY };
})(typeof window !== "undefined" ? window : globalThis);
