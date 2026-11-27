// OmniDraw's editor add-ons in someone else's page: the first script of omnidraw-frame.js.
//
// The add-ons were written for hosts whose editor page gives them `window.VsCodeApi` to post
// to (VS Code's webview, the desktop app). Loaded into a plain framed draw.io there is none:
// what they post goes to the page that frames the editor, as JSON text, the way draw.io's own
// embed mode talks to it. To the frame's own origin unless `omnidrawConfig.hostOrigin` names
// another ("*" for any: that hands what the editor says to whichever page frames it).
(function () {
	if (window.VsCodeApi) return;
	var cfg = window.omnidrawConfig || {};
	var host = window.opener || (window.parent !== window ? window.parent : null);
	var origin = typeof cfg.hostOrigin === "string" && cfg.hostOrigin ? cfg.hostOrigin : location.origin;
	window.VsCodeApi = {
		postMessage: function (message) {
			if (!host) return;
			if (window.opener) host.postMessage(message, "*");
			else host.postMessage(message, origin);
		},
	};
})();
