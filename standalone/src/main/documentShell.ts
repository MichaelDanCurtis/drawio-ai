// What a diagram window and an Excalidraw window share: where a new window goes, which document
// is in front, and the chat beside the editor (sliding in and out, its edge dragged to resize).
import { BaseWindow, screen, type WebContentsView } from "electron";
import { canonicalPath } from "./library/library";
import { settings, updateSettings } from "./settings";

/** A window with one document in it: a draw.io diagram or an Excalidraw drawing. */
export interface DocumentWindow {
	readonly kind: "drawio" | "excalidraw";
	readonly win: BaseWindow;
	readonly editorView: WebContentsView;
	readonly chatView: WebContentsView;
	file: string | undefined;
	/** It has changes that are not in its file. */
	readonly isDirty: boolean;
	save(): Promise<boolean>;
	saveAs(): Promise<boolean>;
	/** The app gave its file another name or place (the home screen did): the window is that file's from now on. */
	movedTo(file: string): void;
	/**
	 * A picture of the document as it was last saved (a PNG), for its card on the home screen.
	 * Undefined when what the editor shows is not that any more: a picture of changes that may
	 * never be saved is not the file's.
	 */
	picture(): Promise<Buffer | undefined>;
	toggleChat(): void;
	resizeChat(delta: number): void;
}

const open = new Set<DocumentWindow>();
let last: DocumentWindow | undefined;

/** What the rest of the app wants to know of the documents (main.ts sets these; the home screen listens). */
export const documentHooks: {
	/** A file was opened in a new window, by whatever way (the menus, the home screen, a file dropped, an agent's tool). */
	opened?: (w: DocumentWindow, file: string) => void;
	/** A document was written to `file`. */
	saved?: (w: DocumentWindow, file: string) => void;
	/** A document's window went. */
	closed?: (w: DocumentWindow) => void;
	/** A document got unsaved changes, or has none any more. */
	changed?: (w: DocumentWindow) => void;
} = {};

/** The document windows that are open, of both kinds. */
export const documentWindows = {
	add(w: DocumentWindow): void {
		open.add(w);
		last = w;
	},
	remove(w: DocumentWindow): void {
		open.delete(w);
		if (last === w) last = undefined;
		documentHooks.closed?.(w);
	},
	/** `w` got the focus. */
	used(w: DocumentWindow): void {
		if (open.has(w)) last = w;
	},
	get size(): number {
		return open.size;
	},
	/**
	 * The window a file is open in, if it is. By the file's real place: a window that was opened by
	 * a path with a link in it holds the same file as one opened by the path without.
	 */
	of(file: string): DocumentWindow | undefined {
		const real = canonicalPath(file);
		return [...open].find((w) => w.file && canonicalPath(w.file) === real);
	},
	all(): DocumentWindow[] {
		return [...open];
	},
	/** The document in front: the one whose window has the focus, else the one used last (Settings, or another app, is in front). */
	front(): DocumentWindow | undefined {
		const win = BaseWindow.getFocusedWindow();
		const focused = [...open].find((w) => w.win === win);
		if (focused) return focused;
		return last && open.has(last) ? last : [...open].pop();
	},
};

/**
 * Where a new window goes: on the display the pointer is on, inside its work area (never
 * partly off screen), a little down and right of the windows already open there.
 */
export function windowPlacement(): { x: number; y: number; width: number; height: number } {
	// (test runs use the primary display: another one may be asleep and not capturable)
	const area = (process.env.DRAWAI_E2E ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
	const width = Math.min(1500, Math.max(800, area.width - 48));
	const height = Math.min(950, Math.max(500, area.height - 48));
	const cascade = (open.size % 6) * 28;
	const x = Math.min(area.x + Math.round((area.width - width) / 2) + cascade, area.x + area.width - width);
	const y = Math.min(area.y + Math.round((area.height - height) / 2) + cascade, area.y + area.height - height);
	return { x: Math.max(area.x, x), y: Math.max(area.y, y), width, height };
}

/** The chat beside a window's editor: it slides in and out, and its inner edge is dragged to resize it. */
export class ChatDock {
	public visible = !settings().chat.startCollapsed;
	/** 0 = chat tucked away, 1 = shown; in between while it slides. */
	private shown = this.visible ? 1 : 0;
	private anim: NodeJS.Timeout | undefined;
	/** The chat width while its edge is dragged (saved when the drag ends). */
	private dragWidth: number | undefined;

	/**
	 * `hidden`: the chat is out of the way whatever its state (a presentation).
	 * `changed`: the chat was shown or tucked away (before the focus moves to it, or back to the editor).
	 */
	constructor(
		private readonly win: BaseWindow,
		private readonly editorView: WebContentsView,
		private readonly chatView: WebContentsView,
		private readonly options: { hidden?: () => boolean; changed?: () => void } = {}
	) {}

	private width(total: number): number {
		return Math.min(Math.max(280, this.dragWidth ?? settings().chatWidth), Math.floor(total * 0.6));
	}

	public layout(): void {
		const { width, height } = this.win.getContentBounds();
		const full = this.width(width);
		const shown = this.options.hidden?.() ? 0 : Math.round(full * easeOut(this.shown));
		const left = settings().chat.side === "left";
		// The chat keeps its full width while it slides, so its contents do not reflow.
		this.editorView.setBounds({ x: left ? shown : 0, y: 0, width: width - shown, height });
		this.chatView.setBounds({ x: left ? shown - full : width - shown, y: 0, width: full, height });
		this.chatView.setVisible(shown > 0);
	}

	public toggle(): void {
		this.setVisible(!this.visible);
	}

	/** Slides the chat in or out (about 220 ms; at once in tests). */
	public setVisible(visible: boolean): void {
		if (visible === this.visible && !this.anim) return;
		this.visible = visible;
		clearInterval(this.anim);
		this.anim = undefined;
		const target = visible ? 1 : 0;
		if (process.env.DRAWAI_E2E) {
			this.shown = target;
			this.layout();
		} else {
			const from = this.shown, start = Date.now(), dur = 220;
			this.anim = setInterval(() => {
				const t = Math.min(1, (Date.now() - start) / dur);
				this.shown = from + (target - from) * t;
				if (!this.win.isDestroyed()) this.layout();
				if (t >= 1) {
					clearInterval(this.anim);
					this.anim = undefined;
				}
			}, 16);
		}
		this.options.changed?.();
		const focusView = visible ? this.chatView : this.editorView;
		if (!focusView.webContents.isDestroyed()) focusView.webContents.focus();
	}

	/** The chat's edge is being dragged to `screenX`; the width is saved when the drag ends. */
	public resizeTo(screenX: number, done: boolean): void {
		if (!isFinite(screenX)) {
			// the drag ended without a position: keep the width it reached
			if (done && this.dragWidth !== undefined) {
				const final = this.dragWidth;
				this.dragWidth = undefined;
				updateSettings({ chatWidth: final });
			}
			return;
		}
		const b = this.win.getContentBounds();
		const left = settings().chat.side === "left";
		const w = Math.round(left ? screenX - b.x : b.x + b.width - screenX);
		this.dragWidth = Math.max(280, Math.min(900, Math.floor(b.width * 0.6), w));
		this.layout();
		if (done) {
			const final = this.dragWidth;
			this.dragWidth = undefined;
			updateSettings({ chatWidth: final });
		}
	}

	public resize(delta: number): void {
		updateSettings({ chatWidth: Math.max(280, Math.min(900, settings().chatWidth + delta)) });
		this.layout();
	}

	public dispose(): void {
		clearInterval(this.anim);
	}
}

function easeOut(t: number): number {
	return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}
