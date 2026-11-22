// OmniDraw: draw.io's toolbar and menu bar for the desktop app.
//  - the OmniDraw dot mark starts the toolbar (it opens Settings)
//  - Layers, Tags and Outline are toolbar buttons, with Presentation mode next to them
//  - the first button shows and hides the Shapes panel (one click, no menu); Ruler is a
//    button next to Layers, Tags and Outline; Fullscreen is at the right end
//  - an arrow at the right end closes and opens the agent chat, pointing the way it goes
//  - the icons follow Settings → Appearance → Icons (ui/icons.js draws them)
//  - the user's own shape folders and libraries (Settings → Shapes) become palettes
// The app sends { action: "desktopPrefs" | "desktopShapes", ... } as window messages.
(function () {
	function send(command) {
		window.VsCodeApi.postMessage(JSON.stringify({ event: "desktopCommand", command: command }));
	}

	// draw.io's own images, kept before anything replaces them (classic style puts them back).
	var ICON_MAP = {
		dockRightImage: "panels", zoomInImage: "zoomIn", zoomOutImage: "zoomOut", undoImage: "undo", redoImage: "redo",
		trashImage: "trash", toFrontImage: "toFront", toBackImage: "toBack", fillColorImage: "fillColor", strokeColorImage: "strokeColor",
		shadowImage: "shadow", plusImage: "plus", shapesImage: "shapes", tableImage: "table", freehandImage: "freehand",
		sparklesImage: "sparkle", layoutImage: "layout", fullscreenImage: "fullscreen", fullscreenExitImage: "fullscreenExit",
		rightPanelOpenImage: "formatOpen", rightPanelCloseImage: "format", layersImage: "layers", tagsImage: "tags", outlineImage: "outline",
	};
	var ORIGINAL = {};
	var current = {};
	for (var k in ICON_MAP) if (typeof Editor !== "undefined" && Editor[k]) ORIGINAL[k] = current[k] = Editor[k];
	// Our own buttons' classic look: the flat glyphs.
	var EXTRA = { present: null, chatArrow: null, workshop: null, ruler: null };
	// which glyph each of them shows now (the chat's arrow changes with the chat)
	var EXTRA_GLYPH = { present: "present", chatArrow: "chevronRight", workshop: "workshop", ruler: "ruler" };
	var style = (/[?&]icons=([a-z0-9]+)/.exec(location.search) || [])[1] || "dots2d";
	var side = (/[?&]toolbar=([a-z]+)/.exec(location.search) || [])[1] || "top";

	/**
	 * Toolbar on the top, left, right or bottom: draw.io lays the editor out with a CSS grid
	 * (menu bar / toolbar / sidebar · split · diagram · format / page tabs), so a class on the
	 * editor moves the toolbar and shifts the other areas.
	 */
	var SIDE_CSS = [
		// left / right: one more column for a vertical toolbar
		".drawai-tb-left.geEditor, .drawai-tb-right.geEditor { grid-template-rows: min-content 1fr min-content !important; }",
		".drawai-tb-left.geEditor { grid-template-columns: min-content min-content min-content 1fr min-content !important; }",
		".drawai-tb-right.geEditor { grid-template-columns: min-content min-content 1fr min-content min-content !important; }",
		".drawai-tb-left.geEditor > .geToolbarContainer, .drawai-tb-right.geEditor > .geToolbarContainer { grid-row: 2 / 4 !important; width: 46px !important; height: auto !important; padding: 6px 0 !important; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; display: flex !important; flex-direction: column; align-items: center; }",
		".drawai-tb-left.geEditor > .geToolbarContainer { grid-column: 1 !important; border-right: 1px solid light-dark(#e6e4df, #222222); }",
		".drawai-tb-right.geEditor > .geToolbarContainer { grid-column: 5 !important; border-left: 1px solid light-dark(#e6e4df, #222222); }",
		".drawai-tb-left.geEditor > .geToolbarContainer .geToolbar, .drawai-tb-right.geEditor > .geToolbarContainer .geToolbar { flex-direction: column; height: auto !important; flex-grow: 0; gap: 2px; }",
		".drawai-tb-left.geEditor > .geToolbarContainer .geToolbarEnd, .drawai-tb-right.geEditor > .geToolbarContainer .geToolbarEnd { flex-direction: column; margin-top: auto; height: auto !important; flex-grow: 0; }",
		".drawai-tb-left.geEditor > .geToolbarContainer .geSeparator, .drawai-tb-right.geEditor > .geToolbarContainer .geSeparator { width: 22px !important; height: 1px !important; margin: 5px 0 !important; }",
		".drawai-tb-left.geEditor > .geToolbarContainer .geZoomInput, .drawai-tb-right.geEditor > .geToolbarContainer .geZoomInput { width: 40px !important; padding: 0 !important; font-size: 11px !important; background-image: none !important; text-align: center; }",
		".drawai-tb-left.geEditor > .geSidebarContainer:not(.geFormatContainer) { grid-column: 2 !important; grid-row: 2 !important; }",
		".drawai-tb-left.geEditor > .geHsplit { grid-column: 3 !important; grid-row: 2 !important; }",
		".drawai-tb-left.geEditor > .geDiagramContainer { grid-column: 4 !important; grid-row: 2 !important; }",
		".drawai-tb-left.geEditor > .geFormatContainer { grid-column: 5 !important; grid-row: 2 !important; }",
		".drawai-tb-left.geEditor > .geTabContainer { grid-column: 2 / -1 !important; grid-row: 3 !important; }",
		".drawai-tb-right.geEditor > .geSidebarContainer:not(.geFormatContainer) { grid-column: 1 !important; grid-row: 2 !important; }",
		".drawai-tb-right.geEditor > .geHsplit { grid-column: 2 !important; grid-row: 2 !important; }",
		".drawai-tb-right.geEditor > .geDiagramContainer { grid-column: 3 !important; grid-row: 2 !important; }",
		".drawai-tb-right.geEditor > .geFormatContainer { grid-column: 4 !important; grid-row: 2 !important; }",
		".drawai-tb-right.geEditor > .geTabContainer { grid-column: 1 / 5 !important; grid-row: 3 !important; }",
		// bottom: the toolbar row moves under the diagram, above the page tabs
		".drawai-tb-bottom.geEditor { grid-template-rows: min-content 1fr min-content min-content !important; }",
		".drawai-tb-bottom.geEditor > .geSidebarContainer, .drawai-tb-bottom.geEditor > .geHsplit, .drawai-tb-bottom.geEditor > .geDiagramContainer { grid-row: 2 !important; }",
		".drawai-tb-bottom.geEditor > .geToolbarContainer { grid-row: 3 !important; border-top: 1px solid light-dark(#e6e4df, #222222); }",
		".drawai-tb-bottom.geEditor > .geTabContainer { grid-row: 4 !important; }",
	].join("\n");
	function setSide(next, ui) {
		side = next;
		var editor = (ui && ui.container) || document.querySelector(".geEditor");
		if (!editor) return;
		["top", "left", "right", "bottom"].forEach(function (s) { editor.classList.toggle("drawai-tb-" + s, s === side); });
		if (ui) {
			try { ui.refresh(); } catch (e) { /* layout catches up on the next resize */ }
			try { window.dispatchEvent(new Event("resize")); } catch (e) { /* old engines */ }
		}
	}

	function glyphUri(name, s) {
		// draw.io inverts toolbar images in dark mode, so the icons are drawn in ink.
		return window.DrawAIIcons ? window.DrawAIIcons.dataUri(name, s, { size: 24, color: "#141414" }) : "";
	}
	function uriFor(key, s) {
		return s === "classic" ? ORIGINAL[key] : glyphUri(ICON_MAP[key], s);
	}

	/** Sets every Editor icon for the style, and swaps the images already on screen. */
	function setStyle(s, ui) {
		style = s;
		var swaps = [];
		for (var key in ORIGINAL) {
			var next = uriFor(key, s);
			if (!next || next === current[key]) continue;
			swaps.push([current[key], next]);
			current[key] = next;
			Editor[key] = next;
		}
		if (ui) {
			var els = document.querySelectorAll(".geToolbarContainer [style*='background-image'], .geMenubarContainer [style*='background-image'], .mxPopupMenu img");
			for (var i = 0; i < els.length; i++) {
				var el = els[i];
				for (var j = 0; j < swaps.length; j++) {
					if (el.tagName === "IMG" && el.getAttribute("src") === swaps[j][0]) el.setAttribute("src", swaps[j][1]);
					else if (el.style.backgroundImage && el.style.backgroundImage.indexOf(swaps[j][0]) >= 0) el.style.backgroundImage = "url('" + swaps[j][1] + "')";
				}
			}
			for (var name in EXTRA) if (EXTRA[name]) EXTRA[name].style.backgroundImage = "url('" + glyphUri(EXTRA_GLYPH[name], s) + "')";
			markOwn();
		}
	}
	/**
	 * draw.io turns its toolbar images into negatives in dark mode. Icons with colours of
	 * their own (the realistic style) must not be: the buttons that show ours are marked.
	 */
	function markOwn() {
		var coloured = !!(window.DrawAIIcons && window.DrawAIIcons.coloured && window.DrawAIIcons.coloured(style));
		var els = document.querySelectorAll(".geToolbarContainer [style*='background-image']");
		for (var i = 0; i < els.length; i++) {
			var bg = els[i].style.backgroundImage, own = false;
			if (style !== "classic") for (var key in current) if (bg.indexOf(current[key]) >= 0) { own = true; break; }
			for (var name in EXTRA) if (EXTRA[name] === els[i]) own = true;
			// ours are drawn finer than draw.io's own: shown at full strength
			els[i].classList.toggle("drawai-own", own);
			els[i].classList.toggle("drawai-coloured", own && coloured);
		}
	}
	// Before the editor builds its toolbar, so it starts with the right icons.
	if (typeof Editor !== "undefined") setStyle(style, null);

	Draw.loadPlugin(function (ui) {
		var ctrl = Editor.ctrlKey;
		mxResources.parse("desktop.present=Presentation Mode");
		mxResources.parse("desktop.toggleChat=Show or Hide the Chat");
		mxResources.parse("desktop.settings=Settings");
		ui.actions.addAction("desktop.present", function () { send("present"); }, null, null, "F5");
		ui.actions.addAction("desktop.toggleChat", function () { send("toggleChat"); }, null, null, ctrl + "+J");
		ui.actions.addAction("desktop.settings", function () { send("settings"); }, null, null, ctrl + "+,");
		mxResources.parse("desktop.workshop=Shape Workshop");
		ui.actions.addAction("desktop.workshop", function () { send("workshop"); }, null, null, ctrl + "+Alt+K");
		setStyle(style, ui);

		// The first button shows and hides the Shapes panel: one click, no menu.
		// (draw.io builds it as a menu of panels: swap it for a plain button.)
		var oldBtn = null;
		var candidates = ui.toolbar && ui.toolbar.container ? ui.toolbar.container.querySelectorAll("a.geButton") : [];
		for (var c = 0; c < candidates.length && !oldBtn; c++) if (candidates[c].style.backgroundImage.indexOf(current.dockRightImage) >= 0) oldBtn = candidates[c];
		if (oldBtn) {
			var shapesBtn = document.createElement("a");
			shapesBtn.className = oldBtn.className;
			shapesBtn.style.backgroundImage = oldBtn.style.backgroundImage;
			shapesBtn.setAttribute("title", "Show or hide the Shapes panel (" + ctrl + "+Shift+K)");
			shapesBtn.setAttribute("aria-label", "Show or hide the Shapes panel");
			shapesBtn.setAttribute("data-drawai", "shapes-toggle");
			mxEvent.addListener(shapesBtn, "click", function (evt) {
				var act = ui.actions.get("toggleShapes");
				if (act) act.funct();
				mxEvent.consume(evt);
			});
			mxEvent.preventDefault(shapesBtn);
			oldBtn.parentNode.replaceChild(shapesBtn, oldBtn);
		}

		// Layers, Tags, Outline and Presentation mode as toolbar buttons, after the layout menu.
		var tb = ui.toolbar;
		if (tb && tb.container) {
			tb.addSeparator();
			var group = tb.addItems(["layers", "tags", "outline"], null, null, [Editor.layersImage, Editor.tagsImage, Editor.outlineImage]);
			for (var i = 0; i < group.length; i++) group[i].setAttribute("data-drawai", "panel");
			var ruler = tb.addItems(["ruler"], null, null, [glyphUri("ruler", style)])[0];
			if (ruler) {
				ruler.setAttribute("title", "Show or hide the ruler");
				ruler.setAttribute("data-drawai", "ruler");
				EXTRA.ruler = ruler;
			}
			tb.addSeparator();
			var present = tb.addItems(["desktop.present"], null, null, [glyphUri("present", style)])[0];
			if (present) {
				present.setAttribute("title", "Presentation mode (F5): only the diagram, pages as dots, Esc leaves");
				EXTRA.present = present;
			}
			var workshop = tb.addItems(["desktop.workshop"], null, null, [glyphUri("workshop", style)])[0];
			if (workshop) {
				workshop.setAttribute("title", "Shape Workshop (" + ctrl + "+Alt+K): galleries of icons and logos, and your own collections");
				EXTRA.workshop = workshop;
			}
		}

		// The chat button, at the right end of the toolbar.
		var end = document.querySelector(".geToolbarEnd");
		if (end) {
			var chat = document.createElement("a");
			chat.className = "geButton drawai-chat-toggle";
			chat.setAttribute("title", "Close the chat (" + ctrl + "+J)");
			chat.setAttribute("aria-label", "Close or open the chat");
			chat.style.backgroundImage = "url('" + glyphUri("chevronRight", style) + "')";
			mxEvent.addListener(chat, "click", function (evt) { send("toggleChat"); mxEvent.consume(evt); });
			mxEvent.preventDefault(chat);
			end.appendChild(chat);
			EXTRA.chatArrow = chat;
		}

		// The mark at the start of the toolbar (draw.io's menus are in the system menu bar): it opens Settings.
		var bar = ui.toolbar && ui.toolbar.container;
		if (bar) {
			var mark = document.createElement("a");
			mark.className = "geButton drawai-mark";
			mark.setAttribute("title", "OmniDraw · Settings (" + ctrl + "+,)");
			mark.setAttribute("aria-label", "OmniDraw settings");
			var dotsEl = document.createElement("span");
			dotsEl.className = "drawai-brandmark";
			mark.appendChild(dotsEl);
			if (window.DrawAIBrandmark) {
				// the live mark: ink on paper, or white on black, following draw.io's own dark mode
				var live = window.DrawAIBrandmark.mount(dotsEl, {
					size: 18,
					colors: function () {
						var dark = typeof Editor.isDarkMode === "function" && Editor.isDarkMode();
						return dark ? { on: "#ededed", off: "#333333", signal: "#e5262f" } : { on: "#141414", off: "#d2cfc8", signal: "#d71921" };
					},
				});
				try { ui.addListener("darkModeChanged", function () { live.recolor(); }); } catch (e) { /* older draw.io */ }
			} else {
				dotsEl.innerHTML = [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 2, 0, 0, 0].map(function (v) { return "<i" + (v === 1 ? " data-on" : v === 2 ? " data-signal" : "") + "></i>"; }).join("");
			}
			mxEvent.addListener(mark, "click", function (evt) { send("settings"); mxEvent.consume(evt); });
			bar.insertBefore(mark, bar.firstChild);
		}

		var sideCss = document.createElement("style");
		sideCss.textContent = SIDE_CSS;
		document.head.appendChild(sideCss);
		setSide(side, ui);
		markOwn();

		var css = document.createElement("style");
		css.textContent = [
			".drawai-mark { display: inline-flex !important; align-items: center; justify-content: center; width: 28px !important; flex: none; margin-right: 4px; cursor: pointer; background: none !important; filter: none !important; }",
			".drawai-brandmark { display: inline-grid; grid-template-columns: repeat(4, 3px); gap: 2px; }",
			".drawai-brandmark i { display: block; width: 3px; height: 3px; border-radius: 50%; background: light-dark(#d2cfc8, #333333); }",
			".drawai-brandmark i[data-on] { background: light-dark(#141414, #ededed); }",
			".drawai-brandmark i[data-signal] { background: light-dark(#d71921, #e5262f); }",
			".drawai-mark:hover .drawai-brandmark i[data-on] { background: light-dark(#000000, #ffffff); }",
			// the arrow that closes and opens the chat: a small tab of its own at the end of the toolbar
			".drawai-chat-toggle { border: 1px solid light-dark(#d2cfc8, #333333) !important; border-radius: 7px !important; margin-left: 4px !important; }",
			".drawai-chat-toggle:hover { border-color: light-dark(#8b8984, #6b6b6b) !important; }",
			// while the chat is open its own arrow (next to this one, across the edge) closes it: one arrow at a time
			".drawai-chat-toggle[data-chat='open'] { display: none !important; }",
			".drawai-coloured { filter: none !important; }",
			".drawai-dots-host { position: relative; isolation: isolate; }",
			".drawai-backdrop { position: absolute; top: 0; left: 0; right: 0; height: 150px; z-index: -1; pointer-events: none; -webkit-mask-image: linear-gradient(to left, #000 0%, rgb(0 0 0 / 55%) 45%, transparent 85%), linear-gradient(to bottom, #000 30%, transparent 100%); -webkit-mask-composite: source-in; mask-image: linear-gradient(to left, #000 0%, rgb(0 0 0 / 55%) 45%, transparent 85%), linear-gradient(to bottom, #000 30%, transparent 100%); mask-composite: intersect; }",
			".drawai-backdrop canvas { display: block; width: 100%; height: 100%; }",
			".geEditor .geToolbarContainer .drawai-own:not(.mxDisabled, [disabled]) { opacity: 0.95 !important; }",
		].join("\n");
		document.head.appendChild(css);

		// ----- the live dot field in the top right of the Format panel, like the chat's head -----
		// (dots near the pointer brighten and lean; it drifts slowly; still under reduced motion)
		(function formatDots() {
			var box = ui.format && ui.format.container;
			if (!box) return;
			box.setAttribute("data-dot-host", "");
			box.classList.add("drawai-dots-host");
			var back = document.createElement("div");
			back.className = "drawai-backdrop";
			var canvas = document.createElement("canvas");
			back.appendChild(canvas);
			var colours = function () {
				var dark = typeof Editor.isDarkMode === "function" && Editor.isDarkMode();
				back.style.setProperty("--dot", dark ? "#7d7d7d" : "#8b8984");
				back.style.setProperty("--ink", dark ? "#ededed" : "#141414");
				back.style.setProperty("--signal", dark ? "#e5262f" : "#d71921");
			};
			colours();
			// draw.io empties the panel whenever the selection changes: put the layer back each time
			var clear = ui.format.clear;
			ui.format.clear = function () {
				clear.apply(this, arguments);
				box.insertBefore(back, box.firstChild);
			};
			box.insertBefore(back, box.firstChild);
			import("/ui/dots.js").then(function (m) {
				var fieldLayer = m.mountDotField(canvas, { density: 0.42, grid: 7, anchor: "viewport" });
				if (!fieldLayer) return;
				window.omnidrawFormatDots = fieldLayer;
				try { ui.addListener("darkModeChanged", function () { colours(); fieldLayer.engine.readColours(); }); } catch (e) { /* older draw.io */ }
			}).catch(function () { /* the panel is complete without it */ });
		})();

		// ----- the matrix: the chat's dot field over all of the editor's chrome, never over the diagram -----
		var matrixLayer = null;
		var matrixMode = document.documentElement.getAttribute("data-drawai-matrix") || "grey";
		import("/ui/matrix.js").then(function (m) {
			var diagram = ui.diagramContainer;
			matrixLayer = m.mountMatrix({
				mode: matrixMode,
				zIndex: 9000, // under draw.io's menus and dialogs
				holes: function () { return diagram && diagram.offsetWidth ? [diagram.getBoundingClientRect()] : []; },
				colour: function (mode) {
					var dark = typeof Editor.isDarkMode === "function" && Editor.isDarkMode();
					return mode === "green" ? (dark ? "#6fd69b" : "#2f8f5b") : dark ? "#7d7d7d" : "#8b8984";
				},
			});
			if (!matrixLayer) return;
			window.omnidrawMatrix = matrixLayer;
			// the diagram's place changes when panels open and close or the toolbar moves
			if (typeof ResizeObserver !== "undefined" && diagram) new ResizeObserver(function () { matrixLayer.check(); }).observe(diagram);
			try { ui.addListener("darkModeChanged", function () { matrixLayer.refresh(); }); } catch (e) { /* older draw.io */ }
		}).catch(function () { /* the editor is complete without it */ });

		// ----- draw.io's own shape sets (what its "More Shapes" dialog chooses) live in the Shape Workshop -----
		function shapeSets() {
			var groups = [];
			if (typeof ui.isScratchpadEnabled !== "function" || ui.isScratchpadEnabled()) {
				groups.push({ title: "Yours", entries: [{ id: ".scratchpad", title: mxResources.get("scratchpad") || "Scratchpad", on: ui.scratchpad != null }] });
			}
			(ui.sidebar.entries || []).forEach(function (g) {
				var entries = (g.entries || []).filter(function (e) { return e.id !== "search" && e.id !== ".scratchpad"; }).map(function (e) {
					return { id: e.id, title: e.title, on: !!ui.sidebar.isEntryVisible(e.id) };
				});
				if (entries.length) groups.push({ title: g.title, entries: entries });
			});
			return groups;
		}
		var setsTimer = 0;
		function postShapeSets() {
			clearTimeout(setsTimer);
			setsTimer = setTimeout(function () {
				window.VsCodeApi.postMessage(JSON.stringify({ event: "desktopShapeSets", groups: shapeSets() }));
			}, 150);
		}
		/** Shows or hides one of draw.io's shape sets, and remembers it (as "More Shapes" did with "Remember this setting"). */
		function setShapeSet(id, on) {
			if (id === ".scratchpad") {
				if ((ui.scratchpad != null) !== !!on) ui.toggleScratchpad();
			} else {
				var ids = [];
				(ui.sidebar.entries || []).forEach(function (g) {
					(g.entries || []).forEach(function (e) {
						if (e.id === "search" || e.id === ".scratchpad") return;
						if (e.id === id ? on : ui.sidebar.isEntryVisible(e.id)) ids.push(e.id);
					});
				});
				ui.sidebar.showEntries(ids.join(";"), true, true);
			}
			postShapeSets();
			setTimeout(postShapeSets, 900); // (the Scratchpad opens a moment later)
		}
		// "+ More Shapes" under the sidebar opens the Workshop: one place for every kind of shape
		var moreShapes = ui.actions.get("shapes");
		if (moreShapes) moreShapes.funct = function () { send("shapeSets"); };
		postShapeSets();
		setTimeout(postShapeSets, 1500);

		// ----- a shape from the Workshop: in the middle of the view, selected -----
		function insertShape(shape) {
			var graph = ui.editor.graph;
			if (!graph.isEnabled()) return;
			var w = Number(shape.w) || 48, h = Number(shape.h) || 48;
			var pt = graph.getFreeInsertPoint ? graph.getFreeInsertPoint() : null;
			var c = graph.getCenterInsertPoint ? graph.getCenterInsertPoint(new mxRectangle(0, 0, w, h)) : pt || new mxPoint(40, 40);
			var cells;
			graph.getModel().beginUpdate();
			try {
				if (shape.xml) {
					var xml = shape.xml.charAt(0) === "<" ? shape.xml : Graph.decompress(shape.xml);
					var imported = ui.stringToCells(xml);
					cells = graph.importCells(imported, c.x, c.y);
				} else if (shape.style) {
					cells = [graph.insertVertex(graph.getDefaultParent(), null, "", c.x, c.y, w, h, shape.style)];
				}
			} finally {
				graph.getModel().endUpdate();
			}
			if (cells && cells.length) {
				graph.setSelectionCells(cells);
				graph.scrollCellToVisible(cells[0]);
			}
		}

		// ----- draw.io's own search also finds gallery shapes (asked of the app, page 1 only) -----
		var pendingSearches = {};
		var lastInsertSeq = 0;
		var searchSeq = 0;
		var sidebarSearch = ui.sidebar.searchEntries;
		ui.sidebar.searchEntries = function (terms, count, page, success, error, closedLibs, imagesOnly) {
			var self = this;
			if (imagesOnly || page > 0 || !terms || !String(terms).trim()) return sidebarSearch.apply(this, arguments);
			return sidebarSearch.call(this, terms, count, page, function (results, len, more, words) {
				var id = ++searchSeq;
				var done = false;
				var finish = function (shapes) {
					if (done) return;
					done = true;
					var extra = (shapes || []).map(function (s) {
						return function () {
							var elt = s.xml
								? self.createVertexTemplateFromData(s.xml.charAt(0) === "<" ? Graph.compress(s.xml) : s.xml, s.w, s.h, s.title)
								: self.createVertexTemplate(s.style, s.w || 48, s.h || 48, "", s.title);
							if (elt && elt.setAttribute) {
								elt.setAttribute("title", s.title + " (gallery)");
								elt.setAttribute("data-omnidraw-gallery", s.title);
							}
							return elt;
						};
					});
					success(results.concat(extra), (len || results.length) + extra.length, more, words);
				};
				pendingSearches[id] = finish;
				// the app answers quickly from its indexes; draw.io's results show regardless after 2.5 s
				setTimeout(function () { if (pendingSearches[id]) { delete pendingSearches[id]; finish([]); } }, 2500);
				window.VsCodeApi.postMessage(JSON.stringify({ event: "desktopGallerySearch", reqId: id, query: String(terms), limit: Math.max(12, Math.min(48, count)) }));
			}, error, closedLibs, imagesOnly);
		};

		/** Tests: draw.io's sidebar search (with gallery shapes), and the palettes shown. */
		window.omnidrawShapes = {
			search: function (terms) {
				return new Promise(function (resolve) {
					ui.sidebar.searchEntries(terms, 50, 0, function (results) {
						var titles = [];
						for (var i = 0; i < results.length; i++) {
							try { var elt = results[i](); titles.push(elt && (elt.getAttribute("title") || elt.textContent || "")); } catch (e) { /* skip */ }
						}
						resolve(titles);
					}, function () { resolve([]); });
				});
			},
			palettes: function () {
				return Array.from(document.querySelectorAll(".geSidebarContainer .geTitle")).map(function (t) { return t.textContent.trim(); });
			},
			sets: shapeSets,
			/** The Scratchpad: add a new shape to it the way its "+" does, and say what it holds and where it is kept. */
			scratchpad: function (add) {
				var elts = ui.sidebar.palettes["L.scratchpad"] || [];
				if (add && elts[0]) {
					var graph = ui.editor.graph;
					graph.setSelectionCell(graph.insertVertex(graph.getDefaultParent(), null, add, 20, 20, 90, 40));
					var want = mxResources.get("add");
					var btn = Array.from(elts[0].querySelectorAll("img")).find(function (i) { return i.getAttribute("title") === want || i.getAttribute("data-tip") === want; });
					if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				}
				return {
					open: ui.scratchpad != null,
					database: ui.database != null,
					items: elts[1] ? elts[1].querySelectorAll("a.geItem").length : 0,
				};
			},
		};

		// ----- the user's shape folders and libraries -----
		var palettes = [];
		function showShapes(libraries) {
			// (draw.io's removePalette expects the palette directly in the sidebar's container,
			// which its newer sidebar no longer guarantees: remove the elements wherever they are.)
			for (var i = 0; i < palettes.length; i++) {
				var elts = ui.sidebar.palettes[palettes[i]] || [];
				for (var j = 0; j < elts.length; j++) {
					try { ui.sidebar.unobserveElements(elts[j]); } catch (e) { /* not observed */ }
					if (elts[j] && elts[j].parentNode) elts[j].parentNode.removeChild(elts[j]);
				}
				ui.sidebar.palettes[palettes[i]] = null;
			}
			palettes = [];
			(libraries || []).forEach(function (lib, n) {
				var id = "drawai-shapes-" + n;
				var images = null;
				if (lib.kind === "images") images = lib.images;
				else if (lib.kind === "gallery") images = lib.shapes;
				else if (lib.kind === "xml") {
					try {
						var doc = mxUtils.parseXml(lib.xml);
						var root = doc.documentElement;
						images = root && root.nodeName === "mxlibrary" ? JSON.parse(mxUtils.getTextContent(root)) : [];
					} catch (e) {
						images = [];
					}
				}
				if (!images) return;
				var fns = images.map(function (img) {
					return function () {
						var title = img.title || "";
						if (img.xml) return ui.sidebar.createVertexTemplateFromData(img.xml.charAt(0) === "<" ? Graph.compress(img.xml) : img.xml, img.w, img.h, title);
						if (img.style) return ui.sidebar.createVertexTemplate(img.style, img.w || 48, img.h || 48, "", title);
						// draw.io styles separate keys with ";", so data URIs are written without ";base64".
						var data = String(img.data || "").replace(/^data:([^;,]+);base64,/, "data:$1,");
						return ui.sidebar.createVertexTemplate("shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;image=" + data + ";", img.w || 48, img.h || 48, "", title);
					};
				});
				var label = lib.title + (lib.truncated ? " (first 400)" : "") + (lib.more > 0 ? " · search for " + lib.more.toLocaleString() + " more" : "");
				ui.sidebar.addPaletteFunctions(id, label, lib.kind !== "gallery", fns);
				palettes.push(id);
			});
		}

		window.addEventListener("message", function (evt) {
			var data = evt.data;
			if (typeof data === "string") {
				if (data.indexOf('"desktopPrefs"') < 0 && data.indexOf('"desktopShapes"') < 0 && data.indexOf('"desktopInsertShape"') < 0 && data.indexOf('"desktopGalleryResults"') < 0 && data.indexOf('"desktopSetShapeSet"') < 0 && data.indexOf('"desktopStorage"') < 0 && data.indexOf('"desktopReportShapeSets"') < 0) return;
				try { data = JSON.parse(data); } catch (e) { return; }
			}
			if (!data) return;
			if (data.action === "desktopPrefs") {
				if (data.iconStyle && data.iconStyle !== style) setStyle(data.iconStyle, ui);
				if (data.toolbar && data.toolbar !== side) setSide(data.toolbar, ui);
				if (data.matrix && data.matrix !== matrixMode) {
					matrixMode = data.matrix;
					document.documentElement.setAttribute("data-drawai-matrix", matrixMode);
					if (matrixLayer) matrixLayer.setMode(matrixMode);
				}
				if (matrixLayer) matrixLayer.check();
				if (EXTRA.chatArrow) {
					// the arrow points the way the chat goes: away to close it, back to open it
					var right = data.chatSide !== "left";
					var glyph = !!data.chatVisible === right ? "chevronRight" : "chevronLeft";
					EXTRA_GLYPH.chatArrow = glyph;
					EXTRA.chatArrow.style.backgroundImage = "url('" + glyphUri(glyph, style) + "')";
					EXTRA.chatArrow.removeAttribute("data-tip");
					EXTRA.chatArrow.setAttribute("title", (data.chatVisible ? "Close" : "Open") + " the chat (" + ctrl + "+J)");
					EXTRA.chatArrow.setAttribute("data-chat", data.chatVisible ? "open" : "closed");
					markOwn();
				}
			} else if (data.action === "desktopShapes") {
				try { showShapes(data.libraries); } catch (e) { console.warn("OmniDraw: could not show the shape libraries", e); }
			} else if (data.action === "desktopInsertShape" && data.shape) {
				if (data.seq && data.seq <= lastInsertSeq) return;
				lastInsertSeq = data.seq || lastInsertSeq;
				try { insertShape(data.shape); } catch (e) { ui.handleError(e); }
			} else if (data.action === "desktopReportShapeSets") {
				postShapeSets();
			} else if (data.action === "desktopStorage" && data.changes && window.omnidrawStorage) {
				// another window changed draw.io's storage: this page takes it over, so it does not write its old copy back
				var store = window.omnidrawStorage, settingsChanged = false, padChanged = false;
				for (var key in data.changes) {
					var value = data.changes[key];
					if (value === null) { delete store[key]; continue; }
					if (typeof value !== "string" || store[key] === value) continue;
					store[key] = value;
					if (key.indexOf(".drawio-config") === 0) settingsChanged = true;
					if (key === ".scratchpad") padChanged = true;
				}
				try { if (settingsChanged && typeof mxSettings !== "undefined") mxSettings.load(); } catch (e) { /* keeps its own */ }
				try { if (padChanged && ui.scratchpad != null) ui.loadScratchpad(true); } catch (e) { /* shows it after a reload */ }
			} else if (data.action === "desktopSetShapeSet" && typeof data.id === "string") {
				try { setShapeSet(data.id, !!data.on); } catch (e) { console.warn("OmniDraw: could not switch the shape set", e); }
			} else if (data.action === "desktopGalleryResults") {
				var waiting = pendingSearches[data.reqId];
				if (waiting) { delete pendingSearches[data.reqId]; waiting(data.shapes || []); }
			}
		});
	});
})();
