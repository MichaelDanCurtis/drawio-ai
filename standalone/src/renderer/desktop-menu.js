// OmniDraw: draw.io's in-editor File menu for a desktop app. Loaded as a
// draw.io plugin after the Draw.AI plugin (drawio-custom-plugins, shared with the VS Code extension), whose File menu
// entries are written for VS Code. This replaces that menu with desktop commands,
// which the app handles ({ event: "desktopCommand", command }).
(function () {
	function send(command) {
		window.VsCodeApi.postMessage(JSON.stringify({ event: "desktopCommand", command: command }));
	}

	Draw.loadPlugin(function (ui) {
		var ctrl = Editor.ctrlKey;
		var commands = [
			["desktop.new", "New Diagram", "new", ctrl + "+N"],
			["desktop.open", "Open...", "open", ctrl + "+O"],
			["desktop.saveAs", "Save As...", "saveAs", ctrl + "+Shift+S"],
			["desktop.exportPdf", "Export as PDF...", "exportPdf", ctrl + "+Shift+E"],
			["desktop.export", "Export (PDF, SVG, PNG, Visio, draw.io)...", "export", null],
			["desktop.openOther", "Open from Another Tool (Visio, Gliffy, yEd, Lucidchart)...", "importDiagram", null],
			["desktop.print", "Print...", "print", ctrl + "+P"],
		];
		commands.forEach(function (c) {
			mxResources.parse(c[0] + "=" + c[1]);
			ui.actions.addAction(c[0], function () { send(c[2]); }, null, null, c[3]);
		});

		// Wait for the Draw.AI plugin's File menu (it is loaded alongside this one).
		var tries = 0;
		(function install() {
			if (!ui.actions.get("vscode.import") && tries++ < 100) return setTimeout(install, 50);
			var fileMenu = ui.menus.get("file");
			fileMenu.funct = function (menu, parent) {
				var items = [
					"desktop.new", "desktop.open", "-",
					"save", "desktop.saveAs", "-",
					"desktop.exportPdf", "desktop.export", "-",
					"vscode.import", "desktop.openOther", "-",
					"properties", "pageSetup", "desktop.print",
				];
				ui.menus.addMenuItems(menu, items.filter(function (n) { return n === "-" || ui.actions.get(n); }), parent);
				if (ui.menus.get("embed")) {
					menu.addSeparator(parent);
					ui.menus.addSubmenu("embed", menu, parent);
				}
			};
		})();
	});
})();
