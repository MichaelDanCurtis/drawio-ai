/**
 * OmniDraw: draw.io's own chrome in the app's look (omni-design), so the editor
 * and the chat read as one app. Only draw.io's theme variables, its UI font and its
 * blue buttons change: diagrams, their fonts and their colours are never touched.
 * Loaded as a draw.io plugin, before the others.
 *
 * Also loaded by the VS Code extension's editor. A host that cannot put the look in the
 * page's address sets window.omnidrawConfig first: { base, matrix, ... } (base is where
 * /ui and /plugin are served from; the desktop app serves them from the page's own address).
 */
(function () {
	var CFG = window.omnidrawConfig || {};
	var BASE = CFG.base || "";
	var STYLE = [
		"@font-face { font-family: 'Space Grotesk'; font-weight: 400; font-display: swap; src: url('/ui/fonts/space-grotesk-latin-400-normal.woff2') format('woff2'); }",
		"@font-face { font-family: 'Space Grotesk'; font-weight: 500; font-display: swap; src: url('/ui/fonts/space-grotesk-latin-500-normal.woff2') format('woff2'); }",
		"@font-face { font-family: 'Space Grotesk'; font-weight: 400; font-display: swap; src: url('/ui/fonts/space-grotesk-latin-ext-400-normal.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }",
		":root {",
		// light: warm paper, white cards, ink
		"  --ge-panel-color: #f3f2ef; --toolbar-color: #f3f2ef; --workspace-color: #ecebe7; --dialog-color: #faf9f7; --card-color: #ffffff;",
		"  --border-color: #e6e4df; --strong-border-color: #8b8984; --field-color: #ffffff; --field-border-color: #d2cfc8;",
		"  --text-color: #3a3936; --strong-text-color: #141414; --secondary-text-color: #5f5d59; --faint-text-color: #8b8984;",
		"  --inactive-color: #ecebe7; --active-color: #d2cfc8; --highlight-color: #ecebe7;",
		"  --primary-color: #ecebe7; --primary-hover-color: #e6e4df; --accent-color: #ecebe7; --accent-hover-color: #e6e4df; --accent-text-color: #141414;",
		"  --focus-color: #141414; --selected-color: #ecebe7; --selected-hover-color: #e6e4df; --soft-color: #faf9f7; --soft-hover-color: #ecebe7; --scrollbar-color: #d2cfc8;",
		// dark: OLED black instrument panel
		"  --dark-toolbar-color: #000000; --ge-dark-panel-color: #000000; --dark-header-color: #000000; --dark-color: #0a0a0a; --dark-dialog-color: #141414; --dark-card-color: #141414;",
		"  --dark-border-color: #222222; --dark-strong-border-color: #6b6b6b; --dark-field-color: #0f0f0f; --dark-field-border-color: #333333;",
		"  --dark-text-color: #c8c8c8; --dark-strong-text-color: #ededed; --dark-secondary-text-color: #9b9b9b; --dark-faint-text-color: #6b6b6b;",
		"  --dark-accent-color: #1c1c1c; --dark-active-accent-color: #333333; --dark-accent-text-color: #ededed; --dark-highlight-color: #1c1c1c;",
		"  --dark-focus-color: #ffffff; --dark-soft-color: #1c1c1c; --dark-soft-hover-color: #222222; --dark-scrollbar-color: #222222;",
		"}",
		".geEditor, .mxPopupMenu, .geDialog, .geToolbarContainer, .geFormatContainer, .geSidebarContainer, .geFooterContainer { font-family: 'Space Grotesk', -apple-system, system-ui, sans-serif !important; }",
		// the blue "+ More Shapes" and dialog primary buttons become ink pills
		".gePrimaryBtn, .geBtn.gePrimaryBtn, .geSidebarContainer .geBtn.gePrimaryBtn { background: light-dark(#141414, #ededed) !important; color: light-dark(#ffffff, #000000) !important; border-color: transparent !important; border-radius: 999px !important; box-shadow: none !important; }",
		".gePrimaryBtn:hover { background: light-dark(#000000, #ffffff) !important; }",
		// "+ More Shapes" under the shapes: a hairline row across the sidebar, in the labels' mono caps
		".geSidebarFooter { padding: 8px 10px 10px !important; height: auto !important; box-sizing: border-box; border-top: 1px solid light-dark(#e6e4df, #222222); }",
		".geSidebarFooter .geBtn.gePrimaryBtn { width: 100%; padding: 7px 12px !important; display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: transparent !important; color: light-dark(#3a3936, #c8c8c8) !important; border: 1px solid light-dark(#d2cfc8, #333333) !important; border-radius: 8px !important; font: 11px 'Space Mono', ui-monospace, monospace !important; letter-spacing: 0.08em; text-transform: uppercase; box-shadow: none !important; }",
		".geSidebarFooter .geBtn.gePrimaryBtn:hover { background: light-dark(#ecebe7, #1c1c1c) !important; border-color: light-dark(#8b8984, #6b6b6b) !important; color: light-dark(#141414, #ededed) !important; }",
		".geSidebarFooter .geBtn.gePrimaryBtn span { font-size: 14px !important; margin: 0 !important; line-height: 1; }",
		"@font-face { font-family: 'Space Mono'; font-weight: 400; font-display: swap; src: url('/ui/fonts/space-mono-latin-400-normal.woff2') format('woff2'); }",
		".geBtn { border-radius: 999px !important; transition: background 140ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 90ms cubic-bezier(0.25, 0.1, 0.25, 1); }",
		".geBtn:active { transform: translateY(1px); }",
		// floating layers rise in, like the chat's menus
		"@keyframes drawai-rise { from { opacity: 0; transform: translateY(6px); } }",
		".mxPopupMenu, .geDialog { animation: drawai-rise 220ms cubic-bezier(0.16, 0.84, 0.3, 1); }",
		"@media (prefers-reduced-motion: reduce) { .mxPopupMenu, .geDialog, .geBtn { animation: none !important; transition: none !important; } }",
	].join("\n").replace(/url\('\/ui\//g, function () { return "url('" + BASE + "/ui/"; });
	var style = document.createElement("style");
	style.id = "drawai-theme";
	style.textContent = STYLE;
	(document.head || document.documentElement).appendChild(style);
	var matrix = CFG.matrix || (/[?&]matrix=([a-z]+)/.exec(location.search) || [])[1];
	if (matrix) document.documentElement.setAttribute("data-drawai-matrix", matrix);
	if (typeof Draw !== "undefined") Draw.loadPlugin(function () {});
})();
