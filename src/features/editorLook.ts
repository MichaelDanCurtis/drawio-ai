/**
 * The look and the editor tools the diagram editor shares with the desktop app (OmniDraw):
 * its theme, icon styles, the dot matrix, the toolbar's buttons and place, quick tooltips and
 * presentation mode. The files are the desktop app's own (standalone/src/renderer), copied
 * into dist/custom-drawio-plugins/omni when the plugins are built.
 *
 * Nothing here imports vscode: the unit tests load it as it is.
 */

export type LookTheme = "omni" | "drawio";
export type IconStyle = "classic" | "dots2d" | "dots" | "real";
export type MatrixStyle = "grey" | "green" | "off";
export type ToolbarSide = "top" | "left" | "right" | "bottom";

export interface EditorLook {
	/** The look, the toolbar buttons, quick tooltips, the matrix and presentation mode: off gives the editor as it was before 0.4. */
	editorTools: boolean;
	/** "omni": the desktop app's paper and black. "drawio": draw.io's own colours and font. */
	theme: LookTheme;
	icons: IconStyle;
	matrix: MatrixStyle;
	toolbar: ToolbarSide;
}

export const DEFAULT_LOOK: EditorLook = { editorTools: true, theme: "omni", icons: "dots2d", matrix: "grey", toolbar: "top" };

const THEMES: readonly LookTheme[] = ["omni", "drawio"];
const ICONS: readonly IconStyle[] = ["classic", "dots2d", "dots", "real"];
const MATRIX: readonly MatrixStyle[] = ["grey", "green", "off"];
const SIDES: readonly ToolbarSide[] = ["top", "left", "right", "bottom"];

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Settings as they were read (a settings file can hold anything) made into a look. */
export function cleanLook(raw: { [K in keyof EditorLook]?: unknown } | undefined): EditorLook {
	const r = raw ?? {};
	return {
		editorTools: typeof r.editorTools === "boolean" ? r.editorTools : DEFAULT_LOOK.editorTools,
		theme: oneOf(THEMES, r.theme, DEFAULT_LOOK.theme),
		icons: oneOf(ICONS, r.icons, DEFAULT_LOOK.icons),
		matrix: oneOf(MATRIX, r.matrix, DEFAULT_LOOK.matrix),
		toolbar: oneOf(SIDES, r.toolbar, DEFAULT_LOOK.toolbar),
	};
}

/** Where the shared files are, under the extension's folder. */
export const OMNI_DIR = "dist/custom-drawio-plugins/omni";

/**
 * draw.io's themes with toolbars of their own (floating, or a few large buttons): the desktop
 * app's toolbar buttons, icons, colours and matrix are made for the standard one ("kennedy").
 * With these the editor gets presentation mode and quick tooltips only.
 */
const OWN_TOOLBAR_THEMES: readonly string[] = ["min", "simple", "sketch"];

/** True when the whole look applies: draw.io's standard theme. */
export function fullLook(drawioTheme: string): boolean {
	return !OWN_TOOLBAR_THEMES.includes(drawioTheme.toLowerCase());
}

/** What decides the editor page's plugins and their settings. */
export interface EditorPageKind {
	/** Only shows the diagram (a diff, an old version): there is no toolbar to add to. */
	readOnly: boolean;
	/** draw.io's theme: the `ui` the page is opened with. */
	drawioTheme: string;
}

/**
 * What the editor page gets as window.omnidrawConfig, or null when the editor tools are off
 * or the editor only shows a diagram.
 *
 * `base` is the address of OMNI_DIR as the page sees it, without a slash at the end. What is
 * off: the Shape Workshop (not in the extension yet), a chat button (VS Code's chat has its own,
 * in the editor's title bar) and the desktop app's keyboard shortcuts (VS Code owns the keys).
 */
export function omniConfig(look: EditorLook, base: string, page: EditorPageKind): object | null {
	if (!look.editorTools || page.readOnly) {
		return null;
	}
	const full = fullLook(page.drawioTheme);
	return {
		host: "vscode",
		name: "Draw.AI",
		base,
		icons: look.icons,
		toolbar: look.toolbar,
		matrix: full ? look.matrix : "off",
		features: { workshop: false, chat: false, shortcuts: false, toolbar: full, matrix: full },
	};
}

/**
 * The plugin scripts of the editor page, in the order they must run: the icons, the mark and
 * the tooltips first (the toolbar draws with them), the theme before draw.io's plugins, then
 * the extension's own bundle, the toolbar and presentation mode.
 */
export function editorPluginPaths(look: EditorLook, base: string, bundle: string, page: EditorPageKind): string[] {
	if (!look.editorTools || page.readOnly) {
		return [bundle];
	}
	return [
		`${base}/ui/icons.js`,
		`${base}/ui/brandmark.js`,
		`${base}/ui/tips.js`,
		...(look.theme === "omni" && fullLook(page.drawioTheme) ? [`${base}/plugin/theme.js`] : []),
		bundle,
		`${base}/plugin/desktop-toolbar.js`,
		`${base}/plugin/presentation.js`,
	];
}

/**
 * A value as JavaScript source inside the page's <script>. JSON alone is not enough there:
 * "</script>" in a string would end the script, and U+2028 / U+2029 end a line in older engines.
 * (Put it into the page with a replacer function: as a plain replacement string, "$&" or "$1"
 * in the value would be read as a pattern.)
 */
export function scriptLiteral(value: unknown): string {
	return (JSON.stringify(value) ?? "null")
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * Fills a page template's $$name$$ placeholders in one pass. A value is put in as it is: it is
 * not searched for placeholders, and "$&" or "$1" in it is not read as a replacement pattern.
 * A placeholder without a value stays.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\$\$([A-Za-z][\w-]*)\$\$/g, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
	);
}
