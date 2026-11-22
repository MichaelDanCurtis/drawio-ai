// Draw.AI desktop: draw.io's toolbar and menu bar for the desktop app.
//  - the Draw.AI dot mark sits before File (it opens Settings)
//  - Layers, Tags and Outline are toolbar buttons, with Presentation mode next to them
//  - the panel menu keeps only what is nowhere else (Shapes, Ruler, Fullscreen)
//  - a chat button at the right end shows and hides the agent chat
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
	var EXTRA = { present: null, chatPanel: null };
	var style = (/[?&]icons=([a-z]+)/.exec(location.search) || [])[1] || "isometric";
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
			for (var name in EXTRA) if (EXTRA[name]) EXTRA[name].style.backgroundImage = "url('" + glyphUri(name, s === "classic" ? "classic" : s) + "')";
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
		setStyle(style, ui);

		// The panel menu: only what has no other place.
		// (draw.io binds the toolbar button to the menu's function when it builds it: swap the button.)
		var panels = ui.menus.get("viewPanels");
		if (panels) {
			panels.funct = function (menu, parent) {
				ui.menus.addMenuItems(menu, ["toggleShapes", "ruler", "-", "fullscreen"], parent);
			};
			var oldBtn = null;
			var candidates = ui.toolbar && ui.toolbar.container ? ui.toolbar.container.querySelectorAll("a.geButton") : [];
			for (var c = 0; c < candidates.length && !oldBtn; c++) if (candidates[c].style.backgroundImage.indexOf(current.dockRightImage) >= 0) oldBtn = candidates[c];
			if (oldBtn && typeof ui.createMenuElement === "function") {
				var btn = ui.createMenuElement("", panels.funct);
				ui.menus.menuCreated(panels, btn, "geButton");
				btn.style.backgroundImage = oldBtn.style.backgroundImage;
				btn.setAttribute("title", oldBtn.getAttribute("title") || "View");
				oldBtn.parentNode.replaceChild(btn, oldBtn);
			}
		}

		// Layers, Tags, Outline and Presentation mode as toolbar buttons, after the layout menu.
		var tb = ui.toolbar;
		if (tb && tb.container) {
			tb.addSeparator();
			var group = tb.addItems(["layers", "tags", "outline"], null, null, [Editor.layersImage, Editor.tagsImage, Editor.outlineImage]);
			for (var i = 0; i < group.length; i++) group[i].setAttribute("data-drawai", "panel");
			tb.addSeparator();
			var present = tb.addItems(["desktop.present"], null, null, [glyphUri("present", style)])[0];
			if (present) {
				present.setAttribute("title", "Presentation mode (F5): only the diagram, pages as dots, Esc leaves");
				EXTRA.present = present;
			}
		}

		// The chat button, at the right end of the toolbar.
		var end = document.querySelector(".geToolbarEnd");
		if (end) {
			var chat = document.createElement("a");
			chat.className = "geButton drawai-chat-toggle";
			chat.setAttribute("title", "Show or hide the chat (" + ctrl + "+J)");
			chat.setAttribute("aria-label", "Show or hide the chat");
			chat.style.backgroundImage = "url('" + glyphUri("chatPanel", style) + "')";
			mxEvent.addListener(chat, "click", function (evt) { send("toggleChat"); mxEvent.consume(evt); });
			mxEvent.preventDefault(chat);
			end.appendChild(chat);
			EXTRA.chatPanel = chat;
		}

		// The Draw.AI mark before File: it opens Settings.
		var bar = ui.menubar && ui.menubar.container;
		if (bar) {
			var mark = document.createElement("a");
			mark.className = "geItem drawai-mark";
			mark.setAttribute("title", "Draw.AI · Settings (" + ctrl + "+,)");
			mark.setAttribute("aria-label", "Draw.AI settings");
			mark.innerHTML = '<span class="drawai-brandmark" aria-hidden="true">' + [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 2, 0, 0, 0].map(function (v) { return "<i" + (v === 1 ? " data-on" : v === 2 ? " data-signal" : "") + "></i>"; }).join("") + "</span>";
			mxEvent.addListener(mark, "click", function (evt) { send("settings"); mxEvent.consume(evt); });
			bar.insertBefore(mark, bar.firstChild);
		}

		var sideCss = document.createElement("style");
		sideCss.textContent = SIDE_CSS;
		document.head.appendChild(sideCss);
		setSide(side, ui);

		var css = document.createElement("style");
		css.textContent = [
			".drawai-mark { display: inline-flex !important; align-items: center; padding: 0 8px 0 4px !important; cursor: pointer; }",
			".drawai-brandmark { display: inline-grid; grid-template-columns: repeat(4, 3px); gap: 2px; }",
			".drawai-brandmark i { display: block; width: 3px; height: 3px; border-radius: 50%; background: light-dark(#d2cfc8, #333333); }",
			".drawai-brandmark i[data-on] { background: light-dark(#141414, #ededed); }",
			".drawai-brandmark i[data-signal] { background: light-dark(#d71921, #e5262f); }",
			".drawai-mark:hover .drawai-brandmark i[data-on] { background: light-dark(#000000, #ffffff); }",
			".drawai-chat-toggle.drawai-off { opacity: 0.55; }",
		].join("\n");
		document.head.appendChild(css);

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
						// draw.io styles separate keys with ";", so data URIs are written without ";base64".
						var data = String(img.data || "").replace(/^data:([^;,]+);base64,/, "data:$1,");
						return ui.sidebar.createVertexTemplate("shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;image=" + data + ";", img.w || 48, img.h || 48, "", title);
					};
				});
				ui.sidebar.addPaletteFunctions(id, lib.title + (lib.truncated ? " (first 400)" : ""), true, fns);
				palettes.push(id);
			});
		}

		window.addEventListener("message", function (evt) {
			var data = evt.data;
			if (typeof data === "string") {
				if (data.indexOf('"desktopPrefs"') < 0 && data.indexOf('"desktopShapes"') < 0) return;
				try { data = JSON.parse(data); } catch (e) { return; }
			}
			if (!data) return;
			if (data.action === "desktopPrefs") {
				if (data.iconStyle && data.iconStyle !== style) setStyle(data.iconStyle, ui);
				if (data.toolbar && data.toolbar !== side) setSide(data.toolbar, ui);
				if (EXTRA.chatPanel) EXTRA.chatPanel.classList.toggle("drawai-off", !data.chatVisible);
			} else if (data.action === "desktopShapes") {
				try { showShapes(data.libraries); } catch (e) { console.warn("Draw.AI: could not show the shape libraries", e); }
			}
		});
	});
})();
