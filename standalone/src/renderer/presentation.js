// Draw.AI desktop: presentation mode, as a draw.io plugin. Shows only the diagram
// (no menus, toolbars, panels, grid or AI overlays), read-only: nothing can be
// selected or edited, dragging with either mouse button moves the view, the wheel
// scrolls and Ctrl/Cmd+wheel or a pinch zooms. Pages are dots in the bottom left;
// Tab / Shift+Tab, the arrow keys, Page Up/Down and Space step through them.
// Esc leaves. The app turns it on with { action: "desktopPresentation", enabled }.
// It never changes settings draw.io saves in the file (grid, page view, connect,
// arrows): changing those would auto-save them and mark the diagram as edited.
(function () {
	var STYLE = [
		"body.drawai-presenting > *:not(.geDiagramContainer):not(#drawai-page-dots):not(#drawai-present-hint) { display: none !important; }",
		"body.drawai-presenting .geDiagramContainer { position: fixed !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; width: auto !important; height: auto !important; border: 0 !important; scrollbar-width: none; }",
		// Scrollbars stay on (draw.io positions the view with them) but are not shown.
		"body.drawai-presenting .geDiagramContainer::-webkit-scrollbar { display: none; }",
		// No paper: the whole area takes the page's colour (draw.io redraws the page element, so CSS hides it).
		"body.drawai-presenting .geBackgroundPage { display: none !important; }",
		"body.drawai-presenting, body.drawai-presenting .geDiagramContainer { background-color: var(--drawai-present-bg, transparent) !important; }",
		"body.drawai-presenting .geDiagramContainer, body.drawai-presenting .geDiagramContainer * { cursor: grab; }",
		// The grid is a CSS background image (of the container, or of the page shape): hide it without changing the saved grid setting.
		"body.drawai-presenting .geDiagramContainer, body.drawai-presenting .geDiagramContainer > svg, body.drawai-presenting .geDiagramContainer > div:not(.geEditor) { background-image: none !important; }",
		"body.drawai-presenting.drawai-panning .geDiagramContainer, body.drawai-presenting.drawai-panning .geDiagramContainer * { cursor: grabbing !important; }",
		// Desktop app, always: draw.io's GitHub link in the page-tab bar.
		'a:has(> img[title="jgraph/drawio"]), img[title="jgraph/drawio"] { display: none !important; }',
		"#drawai-page-dots { position: fixed; left: 18px; bottom: 16px; z-index: 20000; display: flex; gap: 9px; align-items: center; padding: 7px 10px; border-radius: 999px; background: rgba(127,127,127,.14); backdrop-filter: blur(6px); }",
		"#drawai-page-dots button { width: 11px; height: 11px; padding: 0; border-radius: 50%; border: 1.5px solid rgba(127,127,127,.85); background: transparent; cursor: pointer; transition: transform .12s, background .12s; }",
		"#drawai-page-dots button:hover { transform: scale(1.3); }",
		"#drawai-page-dots button.current { background: #7c3aed; border-color: #7c3aed; transform: scale(1.15); }",
		"#drawai-page-dots .name { font: 12px -apple-system, system-ui, sans-serif; color: rgba(127,127,127,.95); margin-left: 4px; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
		"#drawai-present-hint { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 20000; padding: 6px 14px; border-radius: 999px; font: 12px -apple-system, system-ui, sans-serif; color: #fff; background: rgba(30,30,34,.78); pointer-events: none; transition: opacity .6s; }",
	].join("\n");

	Draw.loadPlugin(function (ui) {
		var graph = ui.editor.graph;
		var active = false;
		var saved = null;
		var dots = null;
		var hint = null;
		var hintTimer = null;
		var pageListener = null;

		var style = document.createElement("style");
		style.textContent = STYLE;
		document.head.appendChild(style);

		function send(command) {
			window.VsCodeApi.postMessage(JSON.stringify({ event: "desktopCommand", command: command }));
		}

		function pages() {
			return ui.pages && ui.pages.length ? ui.pages : [];
		}

		function fit() {
			// After the layout changed: let draw.io measure the container first.
			// A one-off fit (draw.io's fitWindow action instead toggles a keep-fitting mode).
			setTimeout(function () {
				if (ui.setFitWindowEnabled && ui.fitWindowEnabled) ui.setFitWindowEnabled(false);
				var b = graph.getGraphBounds();
				if (!b || b.width <= 0 || b.height <= 0) return;
				var s = graph.view.scale;
				var t = graph.view.translate;
				graph.fitWindow(new mxRectangle(b.x / s - t.x, b.y / s - t.y, b.width / s, b.height / s), 48, 2);
			}, 30);
		}

		function goTo(index) {
			var list = pages();
			if (list.length < 2) return;
			var i = (index + list.length) % list.length;
			if (list[i] !== ui.currentPage) ui.selectPage(list[i]);
			renderDots();
			fit();
		}

		function step(delta) {
			goTo(pages().indexOf(ui.currentPage) + delta);
		}

		function renderDots() {
			if (!dots) return;
			var list = pages();
			dots.replaceChildren();
			dots.style.display = list.length > 1 ? "flex" : "none";
			list.forEach(function (page, i) {
				var b = document.createElement("button");
				b.title = (page.getName && page.getName()) || "Page " + (i + 1);
				b.setAttribute("aria-label", b.title);
				if (page === ui.currentPage) b.className = "current";
				b.addEventListener("click", function () { goTo(i); });
				dots.appendChild(b);
			});
			var name = document.createElement("span");
			name.className = "name";
			name.textContent = (ui.currentPage && ui.currentPage.getName && ui.currentPage.getName()) || "";
			dots.appendChild(name);
		}

		function showHint(text) {
			if (!hint) {
				hint = document.createElement("div");
				hint.id = "drawai-present-hint";
				document.body.appendChild(hint);
			}
			hint.textContent = text;
			hint.style.opacity = "1";
			clearTimeout(hintTimer);
			hintTimer = setTimeout(function () { if (hint) hint.style.opacity = "0"; }, 2600);
		}

		/** The colour of draw.io's page (its "paper"), or of the canvas when page view is off. */
		function pageColor() {
			var page = document.querySelector(".geBackgroundPage");
			var c = page ? getComputedStyle(page).backgroundColor : "";
			if (!c || c === "rgba(0, 0, 0, 0)" || c === "transparent") c = getComputedStyle(graph.container).backgroundColor;
			return c;
		}

		function onKey(evt) {
			if (!active) return;
			var mod = evt.metaKey || evt.ctrlKey;
			var handled = true;
			switch (evt.key) {
				case "Escape": send("exitPresentation"); break;
				case "Tab": step(evt.shiftKey ? -1 : 1); break;
				case "ArrowRight": case "ArrowDown": case "PageDown": case " ": step(1); break;
				case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": step(-1); break;
				case "Home": goTo(0); break;
				case "End": goTo(pages().length - 1); break;
				case "f": case "F": case "0": if (!mod) fit(); else handled = false; break;
				case "+": case "=": graph.zoomIn(); break;
				case "-": case "_": graph.zoomOut(); break;
				default: handled = !mod; // swallow plain keys so nothing edits the diagram
			}
			if (handled) {
				evt.preventDefault();
				evt.stopPropagation();
				evt.stopImmediatePropagation();
			}
		}

		function enter() {
			if (active) return;
			active = true;
			if (graph.isEditing()) graph.stopEditing(false);
			graph.clearSelection();
			var ph = graph.panningHandler;
			saved = {
				selectable: graph.isCellsSelectable(),
				movable: graph.isCellsMovable(),
				resizable: graph.isCellsResizable(),
				editable: graph.isCellsEditable(),
				deletable: graph.isCellsDeletable(),
				hadOwnIsCellConnectable: Object.prototype.hasOwnProperty.call(graph, "isCellConnectable"),
				isCellConnectable: graph.isCellConnectable,
				dropEnabled: graph.isDropEnabled(),
				pageBreaks: graph.pageBreaksVisible,
				popupMenu: graph.popupMenuHandler.isEnabled(),
				leftPan: ph.useLeftButtonForPanning,
				ignoreCell: ph.ignoreCell,
				panning: ph.panningEnabled,
				tooltips: graph.tooltipHandler ? graph.tooltipHandler.isEnabled() : null,
				scale: graph.view.scale,
				translate: { x: graph.view.translate.x, y: graph.view.translate.y },
				scroll: { left: graph.container.scrollLeft, top: graph.container.scrollTop },
				page: ui.currentPage,
			};
			graph.setCellsSelectable(false);
			graph.setCellsMovable(false);
			graph.setCellsResizable(false);
			graph.setCellsEditable(false);
			graph.setCellsDeletable(false);
			// No connections from cells (the saved "connect" setting stays as it is).
			graph.isCellConnectable = function () {
				return false;
			};
			graph.setDropEnabled(false);
			graph.popupMenuHandler.setEnabled(false);
			graph.setPanning(true);
			ph.useLeftButtonForPanning = true;
			ph.ignoreCell = true;
			document.body.classList.add("drawai-presenting");
			// Page break lines (not saved in the file).
			graph.pageBreaksVisible = false;
			graph.view.validateBackground();
			document.documentElement.style.setProperty("--drawai-present-bg", pageColor());
			dots = document.createElement("div");
			dots.id = "drawai-page-dots";
			document.body.appendChild(dots);
			renderDots();
			pageListener = function () { renderDots(); };
			ui.editor.addListener("pageSelected", pageListener);
			window.addEventListener("keydown", onKey, true);
			graph.refresh();
			fit();
			showHint(pages().length > 1 ? "Presenting · drag to move · Tab or ← → for pages · Esc to leave" : "Presenting · drag to move · scroll or pinch to zoom · Esc to leave");
		}

		function leave() {
			if (!active) return;
			active = false;
			window.removeEventListener("keydown", onKey, true);
			if (pageListener) ui.editor.removeListener(pageListener);
			pageListener = null;
			if (dots) dots.remove();
			dots = null;
			if (hint) hint.remove();
			hint = null;
			document.body.classList.remove("drawai-presenting");
			var s = saved;
			saved = null;
			if (s) {
				graph.setCellsSelectable(s.selectable);
				graph.setCellsMovable(s.movable);
				graph.setCellsResizable(s.resizable);
				graph.setCellsEditable(s.editable);
				graph.setCellsDeletable(s.deletable);
				if (s.hadOwnIsCellConnectable) graph.isCellConnectable = s.isCellConnectable;
				else delete graph.isCellConnectable;
				graph.setDropEnabled(s.dropEnabled);
				graph.popupMenuHandler.setEnabled(s.popupMenu);
				graph.panningHandler.useLeftButtonForPanning = s.leftPan;
				graph.panningHandler.ignoreCell = s.ignoreCell;
				graph.setPanning(s.panning);
				graph.pageBreaksVisible = s.pageBreaks;
				graph.view.validateBackground();
			}
			document.documentElement.style.removeProperty("--drawai-present-bg");
			graph.refresh();
			setTimeout(function () {
				ui.refresh();
				graph.sizeDidChange();
				// Back to the view from before presenting, when still on that page.
				if (s && s.page === ui.currentPage) {
					graph.view.scaleAndTranslate(s.scale, s.translate.x, s.translate.y);
					graph.container.scrollLeft = s.scroll.left;
					graph.container.scrollTop = s.scroll.top;
				} else {
					// Another page: show all of it, at no more than 100%.
					var b = graph.getGraphBounds();
					var sc = graph.view.scale;
					var t = graph.view.translate;
					if (b && b.width > 0) graph.fitWindow(new mxRectangle(b.x / sc - t.x, b.y / sc - t.y, b.width / sc, b.height / sc), 40, 1);
				}
			}, 30);
		}

		// Grab cursor while dragging the view.
		graph.panningHandler.addListener(mxEvent.PAN_START, function () {
			if (active) document.body.classList.add("drawai-panning");
		});
		graph.panningHandler.addListener(mxEvent.PAN_END, function () {
			document.body.classList.remove("drawai-panning");
		});

		window.addEventListener("message", function (evt) {
			var data = evt.data;
			if (typeof data === "string") {
				if (data.indexOf("desktopPresentation") < 0) return;
				try {
					data = JSON.parse(data);
				} catch (e) {
					return;
				}
			}
			if (data && data.action === "desktopPresentation") {
				// Never let an error escape: draw.io reports uncaught errors with a blocking alert.
				try {
					if (data.enabled) enter();
					else leave();
				} catch (e) {
					console.error("Draw.AI presentation mode:", e);
					try {
						leave();
					} catch (e2) {
						console.error(e2);
					}
					send("exitPresentation");
				}
			} else if (data && data.action === "desktopPresentationStep" && active) {
				if (typeof data.page === "number") goTo(data.page);
				else step(data.delta || 1);
			}
		});

		// Tests read this.
		window.drawaiPresentation = {
			isActive: function () { return active; },
			state: function () {
				return {
					active: active,
					page: pages().indexOf(ui.currentPage),
					pages: pages().length,
					dots: dots ? dots.querySelectorAll("button").length : 0,
					selectable: graph.isCellsSelectable(),
					editable: graph.isCellsEditable(),
					movable: graph.isCellsMovable(),
					grid: graph.isGridEnabled(),
					connect: graph.isConnectable(),
					pageVisible: graph.pageVisible,
					visibleChrome: Array.prototype.filter.call(document.body.children, function (c) {
						return c.offsetParent !== null && c !== dots && c !== hint && !c.classList.contains("geDiagramContainer");
					}).map(function (c) { return c.className || c.tagName; }),
					translate: { x: graph.view.translate.x, y: graph.view.translate.y },
					scroll: { x: graph.container.scrollLeft, y: graph.container.scrollTop },
					scale: graph.view.scale,
				};
			},
		};
	});
})();
