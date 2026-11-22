import { fillTemplate } from "../editorLook";

/**
 * The Map Something page is the desktop app's own (standalone/src/renderer/mapper.html,
 * copied to dist/custom-drawio-plugins/omni when the plugins are built). The desktop app
 * serves it from its own address with a preload script as the bridge; a VS Code webview
 * needs the files' webview addresses and a bridge over postMessage.
 *
 * Nothing here imports vscode: the unit tests load it as it is.
 */

/** The page's file below OMNI_DIR (see editorLook.ts). */
export const MAPPER_PAGE = "mapper.html";

/**
 * The bridge the page expects as window.drawaiMapper ({ post, onMessage }), and the theme:
 * the page's colours follow `data-theme` on <html>, VS Code says dark or light with a class
 * on <body>.
 */
function bridgeScript(): string {
	return [
		"(function () {",
		"	var vs = acquireVsCodeApi();",
		"	window.drawaiMapper = {",
		"		post: function (msg) { vs.postMessage(msg); },",
		'		onMessage: function (handler) { window.addEventListener("message", function (e) { handler(e.data); }); },',
		"	};",
		'	window.omnidrawConfig = { host: "vscode", name: "Draw.AI" };',
		"	function theme() {",
		"		var c = document.body && document.body.classList;",
		"		if (!c) return;",
		'		if (c.contains("vscode-dark") || (c.contains("vscode-high-contrast") && !c.contains("vscode-high-contrast-light"))) document.documentElement.dataset.theme = "dark";',
		'		else if (c.contains("vscode-light") || c.contains("vscode-high-contrast-light")) document.documentElement.dataset.theme = "light";',
		"	}",
		// What the webview could load from the extension's folder (the extension's tests read it).
		'	window.addEventListener("load", function () {',
		"		var report = function (faces) {",
		"			var sheets = 0;",
		"			for (var i = 0; i < document.styleSheets.length; i++) {",
		"				try { if (document.styleSheets[i].href && document.styleSheets[i].cssRules.length) sheets++; } catch (e) { /* not readable: not loaded */ }",
		"			}",
		'			vs.postMessage({ type: "pageLoaded", sheets: sheets, scripts: !!(window.DrawAIIcons && window.DrawAIBrands && window.DrawAITips && window.DrawAIBrandmark), modules: !!window.omnidrawMatrix && typeof window.drawaiPulse === "function", font: !!(faces && faces.length) });',
		"		};",
		// (asked for by name: a font is otherwise only fetched once text in it is painted)
		'		document.fonts.load(\'14px "Space Grotesk"\').then(report, function () { report([]); });',
		"	});",
		'	document.addEventListener("DOMContentLoaded", function () {',
		"		theme();",
		'		new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ["class"] });',
		"	});",
		"})();",
	].join("\n");
}

export interface MapperPageOptions {
	/** For the page's Content-Security-Policy and its scripts and style sheets. */
	nonce: string;
	/** The webview's own origin for local files (webview.cspSource). */
	cspSource: string;
	/** The address of OMNI_DIR as the page sees it, without a slash at the end. */
	base: string;
}

/** The page as a VS Code webview loads it. */
export function mapperPageHtml(template: string, options: MapperPageOptions): string {
	if (!/^[A-Za-z0-9]+$/.test(options.nonce)) {
		throw new Error("The nonce must be letters and digits.");
	}
	const base = options.base.replace(/\/+$/, "");
	// The page names its files from the root ("/ui/tokens.css", import … from "/ui/dots.js").
	const located = template.replace(/(["'])\/ui\//g, (_m, quote: string) => `${quote}${base}/ui/`);
	const filled = fillTemplate(located, { nonce: options.nonce, cspSource: options.cspSource });
	const bridge = `<script nonce="${options.nonce}">\n${bridgeScript()}\n</script>`;
	const at = filled.indexOf("</title>");
	if (at < 0) {
		throw new Error("The Map Something page has no <title>.");
	}
	return filled.slice(0, at + "</title>".length) + "\n" + bridge + filled.slice(at + "</title>".length);
}

/** A nonce for one page load. */
export function pageNonce(random: (bytes: number) => Uint8Array): string {
	return Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("");
}
