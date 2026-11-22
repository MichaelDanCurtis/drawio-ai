// OmniDraw desktop: draw.io's menus in the system menu bar, like a normal Mac app.
//
// draw.io builds each menu on the fly by calling its menu function with a popup menu. This
// plugin calls them with a popup that is never shown and records what they add: labels,
// enabled state, checkmarks, shortcuts, submenus and separators. It sends that snapshot to
// the app ({ event: "desktopMenus" }) whenever the editor's state may have changed; the app
// builds the native menus from it and runs an item with { action: "desktopMenuInvoke", id }.
// draw.io's own in-window menu bar is hidden.
(function () {
	var NAMES = ["file", "edit", "view", "arrange", "extras"];

	Draw.loadPlugin(function (ui) {
		var nextId = 1;
		var fns = {};
		// The menu bar is rebuilt a moment after each snapshot: keep the last few snapshots'
		// items runnable, so a click from a menu built just before a newer snapshot still works.
		var older = [];

		function post(msg) {
			window.VsCodeApi.postMessage(JSON.stringify(msg));
		}

		function record(name) {
			var menu = ui.menus.get(name);
			if (!menu) return null;
			var popup = new mxPopupMenu();
			// (without a factory function mxPopupMenu does not build its table: build it, never show it)
			if (!popup.tbody) popup.init();
			popup.showDisabled = true;
			var root = [];
			var listFor = function (parent) {
				if (parent && parent.__drawaiNode) return parent.__drawaiNode.children || (parent.__drawaiNode.children = []);
				return root;
			};
			popup.addItem = function (title, image, funct, parent, iconCls, enabled) {
				var tr = mxPopupMenu.prototype.addItem.apply(this, arguments);
				var node = { id: nextId++, label: title == null ? "" : String(title), enabled: enabled !== false, checked: false };
				if (typeof funct === "function") fns[node.id] = funct;
				listFor(parent).push(node);
				if (tr) tr.__drawaiNode = node;
				return tr;
			};
			popup.addSeparator = function (parent) {
				listFor(parent).push({ separator: true });
				return mxPopupMenu.prototype.addSeparator.apply(this, arguments);
			};
			popup.addCheckmark = function (item) {
				if (item && item.__drawaiNode) item.__drawaiNode.checked = true;
				return mxPopupMenu.prototype.addCheckmark.apply(this, arguments);
			};
			var addShortcut = ui.menus.addShortcut, addMenuItem = ui.menus.addMenuItem;
			ui.menus.addShortcut = function (item, action) {
				if (item && item.__drawaiNode && action && action.shortcut) item.__drawaiNode.shortcut = String(action.shortcut);
				return addShortcut.apply(this, arguments);
			};
			ui.menus.addMenuItem = function (m, key) {
				var tr = addMenuItem.apply(this, arguments);
				if (tr && tr.__drawaiNode) tr.__drawaiNode.key = key;
				return tr;
			};
			try {
				menu.execute(popup, null);
			} finally {
				ui.menus.addShortcut = addShortcut;
				ui.menus.addMenuItem = addMenuItem;
				try { popup.destroy(); } catch (e) { /* never shown */ }
			}
			return tidy(root);
		}

		/** No separators at the ends or twice in a row, no empty submenus. */
		function tidy(list) {
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var n = list[i];
				if (n.separator) {
					if (out.length && !out[out.length - 1].separator) out.push(n);
					continue;
				}
				if (n.children) {
					n.children = tidy(n.children);
					if (!n.children.length) n.children = null;
				}
				if (!n.label && !n.children) continue;
				out.push(n);
			}
			while (out.length && out[out.length - 1].separator) out.pop();
			return out;
		}

		function snapshot(keep) {
			if (keep) {
				var saved = fns, savedId = nextId;
				try { return snapshot(false); } finally { fns = saved; nextId = savedId; older.shift(); }
			}
			older.unshift(fns);
			if (older.length > 5) older.pop();
			fns = {};
			var menus = {};
			for (var i = 0; i < NAMES.length; i++) {
				try {
					menus[NAMES[i]] = record(NAMES[i]);
				} catch (e) {
					console.warn("OmniDraw: could not read the " + NAMES[i] + " menu", e);
				}
			}
			return menus;
		}

		var timer = null;
		function schedule() {
			clearTimeout(timer);
			timer = setTimeout(function () { post({ event: "desktopMenus", menus: snapshot() }); }, 250);
		}

		var graph = ui.editor.graph;
		graph.getSelectionModel().addListener(mxEvent.CHANGE, schedule);
		graph.getModel().addListener(mxEvent.CHANGE, schedule);
		if (ui.editor.undoManager) ui.editor.undoManager.addListener(mxEvent.CHANGE, schedule);
		graph.view.addListener(mxEvent.SCALE, schedule);
		["darkModeChanged", "formatWidthChanged", "shapesPanelChanged", "pageSelected", "pagesPatched", "gridEnabledChanged", "pageViewChanged", "backgroundColorChanged"].forEach(function (name) {
			try { ui.addListener(name, schedule); } catch (e) { /* not in this version */ }
		});
		// Toggles through toolbars and panels: catch-all, debounced.
		document.addEventListener("mouseup", schedule, true);
		document.addEventListener("keyup", schedule, true);
		schedule();

		window.drawaiMenubar = {
			/** Text is being typed (a label, a panel field): the system's copy/paste/undo apply. */
			isTextFocus: function () {
				var a = document.activeElement;
				return !!(graph.isEditing() || (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)));
			},
			/** Runs a draw.io action by name (undo, copy, …) if it can run now. */
			run: function (key) {
				var action = ui.actions.get(key);
				if (action && action.isEnabled()) action.funct();
				schedule();
				return !!action;
			},
			/** Tests: whether the grid is on. */
			gridEnabled: function () { return graph.isGridEnabled(); },
			/** The menus as they would be built now, without changing what the menu bar runs (tests). */
			peek: function () { return snapshot(true); },
		};

		var lastSeq = 0;
		window.addEventListener("message", function (evt) {
			var data = evt.data;
			if (typeof data === "string") {
				if (data.indexOf("desktopMenuInvoke") < 0 && data.indexOf("desktopMenusRefresh") < 0) return;
				try { data = JSON.parse(data); } catch (e) { return; }
			}
			if (!data) return;
			if (data.action === "desktopMenuInvoke") {
				if (data.seq <= lastSeq) return;
				lastSeq = data.seq;
				var fn = fns[data.id];
				for (var i = 0; !fn && i < older.length; i++) fn = older[i][data.id];
				if (fn) {
					try { fn(new MouseEvent("mouseup")); } catch (e) { ui.handleError(e); }
				}
				schedule();
			} else if (data.action === "desktopMenusRefresh") {
				schedule();
			}
		});

		// The system menu bar has these menus now: hide draw.io's own.
		var css = document.createElement("style");
		css.textContent = ".geEditor > .geMenubarContainer { display: none !important; }";
		document.head.appendChild(css);
		try { ui.refresh(); } catch (e) { /* next resize */ }
	});
})();
