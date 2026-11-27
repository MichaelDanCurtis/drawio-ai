/**
 * The page this editor answers to. In VS Code and in the desktop app the editor's own page puts a
 * stand-in at `window.opener`; in a browser, framed by another page (OmniPad runs the editor
 * that way), it is the page that frames it.
 */
export function hostWindow(): any {
	const w = window as any;
	if (w.opener) return w.opener;
	return w.parent && w.parent !== w ? w.parent : null;
}

/**
 * The origin messages to a framing page are sent to, and must come from: this page's own
 * unless `omnidrawConfig.hostOrigin` names another ("*" for any, which hands what the editor
 * says to whichever page frames it).
 */
function hostOrigin(): string {
	const set = (window as any).omnidrawConfig?.hostOrigin;
	return typeof set === "string" && set ? set : location.origin;
}

/** Whether a message is the host's. */
export function fromHost(evt: MessageEvent): boolean {
	const host = hostWindow();
	if (!host || evt.source !== host) return false;
	if ((window as any).opener) return true;
	const origin = hostOrigin();
	return origin === "*" || evt.origin === origin;
}

export function sendEvent(data: CustomDrawioEvent) {
	const w = window as any;
	if (w.opener) {
		w.opener.postMessage(JSON.stringify(data), "*");
	} else if (w.parent && w.parent !== w) {
		w.parent.postMessage(JSON.stringify(data), hostOrigin());
	} else {
		console.log("sending >>>", data);
	}
}
