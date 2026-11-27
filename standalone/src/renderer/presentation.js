// OmniDraw: presentation mode, as a draw.io plugin. Shows only the diagram
// (no menus, toolbars, panels, grid or AI overlays), read-only: nothing can be
// selected or edited, dragging with either mouse button moves the view, the wheel
// scrolls and Ctrl/Cmd+wheel or a pinch zooms. Pages are dots in the bottom left;
// Tab / Shift+Tab, the arrow keys, Page Up/Down and Space step through them.
// Esc leaves. The host (the desktop app, or the VS Code extension) turns it on with
// { action: "desktopPresentation", enabled }.
// It never changes settings draw.io saves in the file (grid, page view, connect,
// arrows): changing those would auto-save them and mark the diagram as edited.
(function () {
	var STYLE = [
		"body.drawai-presenting > *:not(.geDiagramContainer):not(#drawai-page-dots):not(#drawai-present-hint):not(#drawai-tour-caption):not(#drawai-present-exit):not(#drawai-present-nav) { display: none !important; }",
		"body.drawai-presenting .geDiagramContainer { position: fixed !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; width: auto !important; height: auto !important; border: 0 !important; scrollbar-width: none; }",
		// No rulers either (they are fixed strips of their own, and the diagram keeps a margin for them).
		"body.drawai-presenting .geRuler { display: none !important; }",
		"body.drawai-presenting .geDiagramContainer.geRulerContainer { margin: 0 !important; }",
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
		// The overlay in the app's look (omni-design): ink on paper (light) or white on OLED black, mono caps labels, dots, one signal red.
		"@font-face { font-family: 'Space Grotesk'; font-weight: 400; font-display: swap; src: url('/ui/fonts/space-grotesk-latin-400-normal.woff2') format('woff2'); }",
		"@font-face { font-family: 'Space Grotesk'; font-weight: 500; font-display: swap; src: url('/ui/fonts/space-grotesk-latin-500-normal.woff2') format('woff2'); }",
		"@font-face { font-family: 'Space Mono'; font-weight: 400; font-display: swap; src: url('/ui/fonts/space-mono-latin-400-normal.woff2') format('woff2'); }",
		":root { --dp-surface: #ffffff; --dp-ink: #141414; --dp-muted: #5f5d59; --dp-faint: #8b8984; --dp-line: #d2cfc8; --dp-signal: #d71921; --dp-shadow: 0 18px 48px rgb(20 20 20 / 12%), 0 2px 6px rgb(20 20 20 / 6%); --dp-ease: cubic-bezier(0.16, 0.84, 0.3, 1); }",
		"html.drawai-dark { --dp-surface: #0f0f0f; --dp-ink: #ededed; --dp-muted: #9b9b9b; --dp-faint: #6b6b6b; --dp-line: #333333; --dp-signal: #e5262f; --dp-shadow: 0 18px 48px rgb(0 0 0 / 70%), 0 0 0 1px rgb(255 255 255 / 6%); }",
		"@keyframes drawai-rise { from { opacity: 0; transform: translateY(6px); } }",
		"@keyframes drawai-rise-x { from { opacity: 0; transform: translate(-50%, 6px); } }",
		// the two buttons: leave (bottom left) and the pages one after another (bottom right)
		"#drawai-present-exit, #drawai-present-nav { position: fixed; bottom: 16px; z-index: 20000; display: flex; align-items: center; gap: 2px; height: 34px; padding: 0 4px; border-radius: 999px; background: var(--dp-surface); border: 1px solid var(--dp-line); box-shadow: var(--dp-shadow); animation: drawai-rise 220ms var(--dp-ease); font: 500 12.5px 'Space Grotesk', system-ui, sans-serif; color: var(--dp-ink); }",
		"#drawai-present-exit { left: 18px; padding: 0; }",
		"#drawai-present-nav { right: 18px; }",
		"#drawai-present-exit button, #drawai-present-nav button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 28px; min-width: 28px; padding: 0 9px; border: 0; border-radius: 999px; background: none; color: inherit; font: inherit; cursor: pointer; transition: background 140ms ease-out; }",
		"#drawai-present-exit button { height: 32px; padding: 0 14px 0 12px; }",
		"#drawai-present-exit button:hover, #drawai-present-nav button:hover:not(:disabled) { background: color-mix(in srgb, var(--dp-ink) 10%, transparent); }",
		"#drawai-present-nav button:disabled { opacity: 0.3; cursor: default; }",
		"#drawai-present-nav .count { font: 10.5px 'Space Mono', ui-monospace, monospace; letter-spacing: .08em; color: var(--dp-muted); padding: 0 6px; min-width: 44px; text-align: center; }",
		"#drawai-present-exit svg, #drawai-present-nav svg { width: 12px; height: 12px; flex: none; }",
		"#drawai-page-dots { position: fixed; left: 116px; bottom: 16px; z-index: 20000; display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-radius: 999px; background: var(--dp-surface); border: 1px solid var(--dp-line); box-shadow: var(--dp-shadow); animation: drawai-rise 220ms var(--dp-ease); }",
		"#drawai-page-dots button { width: 8px; height: 8px; padding: 0; border-radius: 50%; border: 0; background: var(--dp-line); cursor: pointer; transition: transform 140ms var(--dp-ease), background 140ms ease-out; }",
		"#drawai-page-dots button:hover { transform: scale(1.35); background: var(--dp-faint); }",
		"#drawai-page-dots button.current { background: var(--dp-ink); transform: scale(1.25); }",
		"#drawai-page-dots .name { font: 10.5px 'Space Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dp-muted); margin-left: 4px; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
		"#drawai-page-dots .tour { width: auto; height: auto; border-radius: 999px; padding: 3px 11px; font: 500 12px 'Space Grotesk', system-ui, sans-serif; color: var(--dp-surface); background: var(--dp-ink); }",
		"#drawai-page-dots .tour:hover { transform: translateY(-1px); background: var(--dp-ink); }",
		"#drawai-tour-caption { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 20000; width: min(620px, 80vw); padding: 14px 18px 12px; border-radius: 14px; font: 14px/1.5 'Space Grotesk', system-ui, sans-serif; color: var(--dp-ink); background: var(--dp-surface); border: 1px solid var(--dp-line); box-shadow: var(--dp-shadow); animation: drawai-rise-x 220ms var(--dp-ease); }",
		"#drawai-tour-caption.again { animation: none; }",
		"#drawai-tour-caption .step { display: flex; align-items: center; gap: 10px; font: 10.5px 'Space Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dp-muted); margin-bottom: 6px; }",
		"#drawai-tour-caption .progress { display: inline-flex; gap: 4px; margin-left: auto; }",
		"#drawai-tour-caption .progress i { width: 5px; height: 5px; border-radius: 50%; background: var(--dp-line); transition: background 140ms ease-out; }",
		"#drawai-tour-caption .progress i.done { background: var(--dp-faint); }",
		"#drawai-tour-caption .progress i.now { background: var(--dp-signal); }",
		"#drawai-tour-caption .title { font-weight: 500; font-size: 16px; letter-spacing: -.01em; margin-bottom: 2px; }",
		"#drawai-tour-caption .text { color: var(--dp-ink); }",
		"#drawai-tour-caption .keys { font: 10.5px 'Space Mono', ui-monospace, monospace; letter-spacing: .04em; color: var(--dp-faint); margin-top: 10px; }",
		"#drawai-tour-caption > * { animation: drawai-rise 380ms var(--dp-ease) backwards; }",
		"#drawai-tour-caption > :nth-child(2) { animation-delay: 45ms; } #drawai-tour-caption > :nth-child(3) { animation-delay: 90ms; } #drawai-tour-caption > :nth-child(4) { animation-delay: 135ms; }",
		"@media (prefers-reduced-motion: reduce) { #drawai-present-exit, #drawai-present-nav, #drawai-page-dots, #drawai-tour-caption, #drawai-tour-caption > *, #drawai-page-dots button { animation: none !important; transition: none !important; } }",
		"#drawai-present-hint { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 20000; padding: 6px 14px; border-radius: 999px; font: 10.5px 'Space Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dp-surface); background: var(--dp-ink); pointer-events: none; transition: opacity .6s; }",
		// (the fonts are served by the host: next to the page in the desktop app, from the extension's folder in VS Code)
	].join("\n").replace(/url\('\/ui\//g, function () { return "url('" + ((window.omnidrawConfig || {}).base || "") + "/ui/"; });

	Draw.loadPlugin(function (ui) {
		var graph = ui.editor.graph;
		var active = false;
		var saved = null;
		var dots = null;
		var hint = null;
		var hintTimer = null;
		var pageListener = null;
		// Map tours: [{ mapId, title, steps: [{ title, caption, nodeIds }] }]; the one playing and its step.
		var tours = [];
		var tour = null;
		var tourStep = 0;
		var highlights = [];
		var caption = null;

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

		/** The map's shapes on the page shown, by node id (shapes carry mapId and mapperId). */
		function mapCells(mapId) {
			var out = {};
			var cells = graph.model.cells || {};
			for (var id in cells) {
				var c = cells[id];
				if (c && c.value && typeof c.value.getAttribute === "function" && c.value.getAttribute("mapId") === mapId && c.value.getAttribute("mapperId")) {
					var kind = c.value.getAttribute("mapperKind");
					if (kind !== "finding-badge" && kind !== "change-badge") out[c.value.getAttribute("mapperId")] = c;
				}
			}
			return out;
		}

		function toursHere() {
			return tours.filter(function (t) {
				return Object.keys(mapCells(t.mapId)).length > 0;
			});
		}

		function clearHighlights() {
			highlights.forEach(function (h) { h.destroy(); });
			highlights = [];
		}

		function startTour(t) {
			tour = t;
			tourStep = 0;
			// After presentation's own fit (scheduled when it starts), or it would undo the step's zoom.
			setTimeout(showStep, 120);
		}

		function endTour() {
			tour = null;
			clearHighlights();
			if (caption) caption.remove();
			caption = null;
			renderDots();
			fit();
		}

		function showStep() {
			if (!tour) return;
			var step = tour.steps[tourStep];
			var cells = mapCells(tour.mapId);
			clearHighlights();
			var states = step.nodeIds.map(function (id) { return cells[id] && graph.view.getState(cells[id]); }).filter(Boolean);
			if (states.length) {
				var b = null;
				states.forEach(function (st) {
					var r = new mxRectangle(st.x, st.y, st.width, st.height);
					if (b) b.add(r);
					else b = r;
					var h = new mxCellHighlight(graph, "#d71921", 3);
					h.highlight(st);
					highlights.push(h);
				});
				var s = graph.view.scale;
				var t = graph.view.translate;
				// Room for the caption at the bottom; don't blow single shapes up too far.
				graph.fitWindow(new mxRectangle(b.x / s - t.x, b.y / s - t.y, b.width / s, b.height / s + 140 / s), 80, 1.6);
				// Highlights follow the new view.
				setTimeout(function () {
					clearHighlights();
					step.nodeIds.forEach(function (id) {
						var st = cells[id] && graph.view.getState(cells[id]);
						if (!st) return;
						var h = new mxCellHighlight(graph, "#d71921", 3);
						h.highlight(st);
						highlights.push(h);
					});
				}, 60);
			}
			if (!caption) {
				caption = document.createElement("div");
				caption.id = "drawai-tour-caption";
				document.body.appendChild(caption);
			}
			caption.replaceChildren();
			// each step rises in again
			caption.classList.add("again");
			void caption.offsetWidth;
			caption.classList.remove("again");
			var meta = document.createElement("div");
			meta.className = "step";
			meta.textContent = tour.title + " · step " + (tourStep + 1) + " of " + tour.steps.length;
			var progress = document.createElement("span");
			progress.className = "progress";
			progress.setAttribute("aria-hidden", "true");
			for (var pi = 0; pi < tour.steps.length && pi < 24; pi++) {
				var pd = document.createElement("i");
				if (pi < tourStep) pd.className = "done";
				else if (pi === tourStep) pd.className = "now";
				progress.appendChild(pd);
			}
			meta.appendChild(progress);
			var title = document.createElement("div");
			title.className = "title";
			title.textContent = step.title || "";
			var text = document.createElement("div");
			text.className = "text";
			text.textContent = step.caption;
			var keys = document.createElement("div");
			keys.className = "keys";
			keys.textContent = "Tab or → next · Shift+Tab or ← back · Esc ends the tour";
			caption.append(meta, title, text, keys);
			renderDots();
		}

		function tourMove(delta) {
			if (!tour) return;
			var next = tourStep + delta;
			if (next >= tour.steps.length) return endTour();
			tourStep = Math.max(0, next);
			showStep();
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
			if (!tour) {
				toursHere().forEach(function (t) {
					var b = document.createElement("button");
					b.className = "tour";
					b.textContent = "▶ " + t.title;
					b.title = "Play the tour (" + t.steps.length + " steps)";
					b.addEventListener("click", function () { startTour(t); });
					dots.appendChild(b);
				});
				if (toursHere().length) dots.style.display = "flex";
			}
			var name = document.createElement("span");
			name.className = "name";
			name.textContent = (ui.currentPage && ui.currentPage.getName && ui.currentPage.getName()) || "";
			dots.appendChild(name);
			renderNav();
		}

		// The buttons: leave at the bottom left; previous page, "2 / 5" and next page at the bottom right.
		var exitBtn = null, nav = null;
		var ICON = {
			close: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>',
			prev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.5L4 6l3.5 3.5"/></svg>',
			next: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6 4.5 9.5"/></svg>',
		};
		function button(html, title, run) {
			var b = document.createElement("button");
			b.innerHTML = html;
			b.title = title;
			b.setAttribute("aria-label", title);
			b.addEventListener("click", function (evt) { evt.stopPropagation(); run(); });
			return b;
		}
		function makeButtons() {
			exitBtn = document.createElement("div");
			exitBtn.id = "drawai-present-exit";
			exitBtn.appendChild(button(ICON.close + "<span>Exit</span>", "Leave presentation mode (Esc)", function () { send("exitPresentation"); }));
			document.body.appendChild(exitBtn);
			nav = document.createElement("div");
			nav.id = "drawai-present-nav";
			var prev = button(ICON.prev, "Previous page (←)", function () { step(-1); });
			prev.className = "prev";
			var count = document.createElement("span");
			count.className = "count";
			var next = button("<span>Next</span>" + ICON.next, "Next page (→ or Tab)", function () { step(1); });
			next.className = "next";
			nav.appendChild(prev);
			nav.appendChild(count);
			nav.appendChild(next);
			document.body.appendChild(nav);
			renderNav();
		}
		function renderNav() {
			if (!nav) return;
			var list = pages(), i = list.indexOf(ui.currentPage);
			// one page: nothing to step through
			nav.style.display = list.length > 1 ? "flex" : "none";
			nav.querySelector(".count").textContent = i + 1 + " / " + list.length;
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
			if (tour) {
				switch (evt.key) {
					case "Escape": endTour(); break;
					case "Tab": tourMove(evt.shiftKey ? -1 : 1); break;
					case "ArrowRight": case "ArrowDown": case "PageDown": case " ": tourMove(1); break;
					case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": tourMove(-1); break;
					default: handled = !mod;
				}
				if (handled) {
					evt.preventDefault();
					evt.stopPropagation();
					evt.stopImmediatePropagation();
				}
				return;
			}
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

		// The overlay follows the editor's own dark mode (which can differ from the system's).
		function syncDark() {
			var dark = false;
			try { dark = typeof Editor !== "undefined" && typeof Editor.isDarkMode === "function" && Editor.isDarkMode(); } catch (e) { dark = false; }
			document.documentElement.classList.toggle("drawai-dark", !!dark);
		}

		function enter() {
			syncDark();
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
			makeButtons();
			pageListener = function () { renderDots(); };
			ui.editor.addListener("pageSelected", pageListener);
			window.addEventListener("keydown", onKey, true);
			graph.refresh();
			fit();
			showHint(pages().length > 1 ? "Presenting · drag to move · Tab or ← → for pages · Esc to leave" : "Presenting · drag to move · scroll or pinch to zoom · Esc to leave");
		}

		function leave() {
			if (!active) return;
			if (tour) {
				tour = null;
				clearHighlights();
				if (caption) caption.remove();
				caption = null;
			}
			active = false;
			window.removeEventListener("keydown", onKey, true);
			if (pageListener) ui.editor.removeListener(pageListener);
			pageListener = null;
			if (dots) dots.remove();
			dots = null;
			if (exitBtn) exitBtn.remove();
			if (nav) nav.remove();
			exitBtn = nav = null;
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
			// (in another host's page, see frame/host.js: only what the page that frames the editor says)
			if (window.omnidrawFromHost && !window.omnidrawFromHost(evt)) return;
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
					console.error("OmniDraw presentation mode:", e);
					try {
						leave();
					} catch (e2) {
						console.error(e2);
					}
					send("exitPresentation");
				}
			} else if (data && data.action === "desktopPresentationTours") {
				tours = Array.isArray(data.tours) ? data.tours : [];
				if (active) {
					renderDots();
					if (data.start) {
						var here = toursHere();
						if (here.length) startTour(here[0]);
						else showHint(window.omnidrawConfig && window.omnidrawConfig.host === "vscode" ? "No tour on this page. Build one from the Maps view: right-click a map → Build a Tour." : "No tour on this page. Build one from the chat: Map ▾ → Build a tour.");
					}
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
					tours: toursHere().map(function (t) { return t.title; }),
					tour: tour ? { title: tour.title, step: tourStep, steps: tour.steps.length, highlighted: highlights.length, caption: caption ? caption.textContent : "" } : null,
					scroll: { x: graph.container.scrollLeft, y: graph.container.scrollTop },
					scale: graph.view.scale,
				};
			},
		};
	});
})();
