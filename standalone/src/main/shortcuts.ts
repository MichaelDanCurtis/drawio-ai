/**
 * draw.io's shortcut text ("⌘+⇧+K", "Ctrl+Shift+L", "Delete / Backspace") → an Electron
 * accelerator for the system menu ("Cmd+Shift+K"), or undefined when it has no exact one.
 * The menus only show these (registerAccelerator: false): draw.io's own key handler still
 * does the work, so nothing changes about how keys behave.
 */
export function toAccelerator(shortcut: string | undefined, mac = process.platform === "darwin"): string | undefined {
	if (!shortcut) return undefined;
	// "Delete / Backspace", "Alt+Shift+X or Alt+Shift+Y": the first form
	const first = shortcut.split(/\s+\/\s+|\s+or\s+/i)[0].trim();
	if (!first || /\s/.test(first.replace(/\+\s*\+$/, "+"))) return undefined;
	const tokens = first.endsWith("++") ? [...first.slice(0, -2).split("+"), "Plus"] : first.split("+");
	const mods: string[] = [];
	let key: string | undefined;
	for (const raw of tokens.map((t) => t.trim()).filter(Boolean)) {
		const t = raw.toLowerCase();
		if (raw === "⌘" || t === "cmd" || t === "command" || t === "meta") mods.push(mac ? "Cmd" : "Ctrl");
		else if (raw === "⇧" || t === "shift") mods.push("Shift");
		else if (raw === "⌥" || t === "alt" || t === "option") mods.push("Alt");
		else if (raw === "⌃" || t === "ctrl" || t === "control") mods.push(mac ? "Ctrl" : "Ctrl");
		else if (key) return undefined;
		else key = keyName(raw);
	}
	if (!key) return undefined;
	return [...new Set(mods), key].join("+");
}

const NAMED: Record<string, string> = {
	delete: "Delete", del: "Delete", backspace: "Backspace", enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape",
	home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: "Space", insert: "Insert",
	"↑": "Up", "↓": "Down", "←": "Left", "→": "Right", up: "Up", down: "Down", left: "Left", right: "Right",
	"⌫": "Backspace", "⌦": "Delete", "⏎": "Enter", "↩": "Enter", "⇥": "Tab", plus: "Plus", "-": "-", "=": "=", ",": ",", ".": ".", "/": "/", ";": ";", "'": "'", "[": "[", "]": "]", "\\": "\\", "`": "`",
};

function keyName(raw: string): string | undefined {
	const t = raw.toLowerCase();
	if (NAMED[raw] ?? NAMED[t]) return NAMED[raw] ?? NAMED[t];
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return t.toUpperCase();
	if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
	return undefined;
}

/** The document command a key press stands for in an Excalidraw window (Cmd on macOS, Ctrl elsewhere), if any. */
export function documentKey(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean; isAutoRepeat?: boolean }, darwin = process.platform === "darwin"): "save" | "saveAs" | "open" | "exportPng" | undefined {
	if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return undefined;
	if (darwin ? !input.meta || input.control : !input.control || input.meta) return undefined;
	const key = input.key.toLowerCase();
	if (key === "s") return input.shift ? "saveAs" : "save";
	if (key === "o" && !input.shift) return "open";
	if (key === "e" && input.shift) return "exportPng";
	return undefined;
}
