// OmniDraw: the Excalidraw editor page. It mounts the real Excalidraw editor (the npm package,
// unchanged) for one document, and talks to the app (src/main/excalidrawWindow.ts) through
// window.omnidrawHost: the app hands over the file's bytes, asks for the drawing back when it
// saves or exports, and is told when there are unsaved changes.
//
// Excalidraw's own canvas UI is left as it is, apart from its light and dark theme (which follow
// the app's). What is the app's here is the bar above the canvas, and the first entries of
// Excalidraw's menu: both only run the app's own commands.
import {
	CaptureUpdateAction,
	convertToExcalidrawElements,
	Excalidraw,
	exportToBlob,
	exportToSvg,
	hashElementsVersion,
	loadFromBlob,
	MainMenu,
	serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { boxOf } from "../../excalidraw/geometry";
import type { Change, Summary } from "../../excalidraw/review";
import { DrawingAi, OperationError, StoppedError } from "./ai";

type Format = "json" | "png" | "svg";
/** What the window around the page looks like: the chat beside it, and the app's icon style. */
interface Look {
	chatVisible: boolean;
	chatSide: "left" | "right";
	iconStyle: string;
}
/** The document the window was opened for (no bytes: a new drawing). */
interface HostDocument {
	name: string;
	saved: boolean;
	bytes?: Uint8Array;
	mime?: string;
	error?: string;
	look: Look;
}
type HostMessage =
	| { type: "serialize"; id: number; format: Format }
	| { type: "saved"; id: number; stamp: string }
	| { type: "look"; name: string; saved: boolean; look: Look }
	/** A tool call of an agent's, checked by the app (src/main/excalidrawTools.ts). */
	| { type: "tool"; id: number; name: string; args: any }
	/** The request that tool call belongs to was stopped: if the call has not changed the drawing yet, it must not. */
	| { type: "cancelTool"; id: number }
	| { type: "resolveReview"; decision: "accept" | "reject" }
	/** An agent is at work on the drawing (`text`: who), or has finished. */
	| { type: "aiStatus"; working: boolean; text?: string };

/** What is pending of an agent's changes: how many, and which elements (for the outlines on the canvas). */
interface Review {
	summary: Summary;
	changes: Change[];
}

interface Host {
	post(msg: unknown): void;
	onMessage(handler: (msg: HostMessage) => void): void;
	document(): Promise<HostDocument>;
	pathOf(file: File): string;
}

declare global {
	interface Window {
		omnidrawHost: Host;
		DrawAIIcons?: { apply(style: string, root?: ParentNode): void };
		/** For the app (menu commands that are Excalidraw's own keys) and for its end-to-end checks. */
		omnidrawExcalidraw?: unknown;
	}
}

const host = window.omnidrawHost;
const mac = /mac/i.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);
const command = (name: string) => host.post({ type: "command", command: name });

/**
 * What the drawing held when it was last saved, as one string: a change of any element changes
 * it, and so does a change of anything else a saved file holds (the background, the grid).
 * Which settings those are is Excalidraw's to say: they are what it writes for a drawing with
 * no elements, so a setting it starts to save one day counts here from that day.
 */
function stampOf(elements: Parameters<typeof hashElementsVersion>[0], appState: AppState): string {
	return `${hashElementsVersion(elements)}:${serializeAsJSON([], appState, {}, "local")}`;
}

/** The drawing as a file's contents, with what it held at that moment (so a change made while it is written still counts as unsaved). */
async function serialize(api: ExcalidrawImperativeAPI, format: Format): Promise<{ data: string | Uint8Array; stamp: string; elements: number }> {
	const elements = api.getSceneElements();
	const appState = api.getAppState();
	const files = api.getFiles();
	const stamp = stampOf(api.getSceneElementsIncludingDeleted(), appState);
	if (format === "json") return { data: serializeAsJSON(elements, appState, files, "local"), stamp, elements: elements.length };
	// (a picture carries the drawing inside it, so it opens again for editing)
	const exportState = { ...appState, exportEmbedScene: true };
	if (format === "svg") {
		const svg = await exportToSvg({ elements, appState: exportState, files });
		return { data: svg.outerHTML, stamp, elements: elements.length };
	}
	const blob = await exportToBlob({
		elements,
		appState: exportState,
		files,
		mimeType: "image/png",
		// twice the size, for sharp lines on any screen; a very large drawing stays within what a canvas can hold
		getDimensions: (width: number, height: number) => {
			const scale = Math.max(width, height) * 2 > 12_000 ? 1 : 2;
			return { width: width * scale, height: height * scale, scale };
		},
	});
	return { data: new Uint8Array(await blob.arrayBuffer()), stamp, elements: elements.length };
}

/** Whether the keys typed now go into a text field (of Excalidraw's, or the label being written on the canvas). */
function typingText(): boolean {
	const el = document.activeElement as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * Undo, redo and select all from the app's menu. They are Excalidraw's own keys and it has no
 * other way to ask for them: the key is handed to it as if it had been pressed. False while text
 * is being typed (the menu then leaves the key to the text field).
 */
function edit(action: "undo" | "redo" | "selectAll"): boolean {
	if (typingText()) return false;
	const letter = action === "selectAll" ? "a" : "z";
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key: letter, code: `Key${letter.toUpperCase()}`, shiftKey: action === "redo", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })
	);
	return true;
}

// A drawing dropped on the window opens as a document of its own (Excalidraw would put it in
// place of this one, which would then be saved over this one's file). Pictures still drop into the canvas.
window.addEventListener(
	"drop",
	(e) => {
		const file = e.dataTransfer?.files?.[0];
		if (!file || !/\.excalidraw$/i.test(file.name)) return;
		const path = host.pathOf(file);
		if (!path) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		host.post({ type: "openPath", path });
	},
	true
);

const ICONS: Record<string, ReactNode> = {
	new: <path d="M4 2.5h5l3 3V13.5H4zM9 2.5v3h3M8 7.5v4M6 9.5h4" />,
	open: <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM2 7.5h12" />,
	save: <path d="M3 2.5h8l2 2v9H3zM5.5 2.5v3.5h5V2.5M5.5 13.5v-4h5v4" />,
	saveAs: <path d="M3 2.5h8l2 2v4M3 2.5v11h5M5.5 2.5v3.5h5V2.5M10 13.5l.5-2 3-3 1.5 1.5-3 3z" />,
	picture: <path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5M10.5 6.2a.6.6 0 1 0 0 .01" />,
};
function Icon({ name }: { name: keyof typeof ICONS }) {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{ICONS[name]}
		</svg>
	);
}

/** An agent's tool call, carried out. The app has checked the arguments (see src/excalidraw/tools.ts). */
async function runTool(ai: DrawingAi, name: string, args: any, stopped: () => boolean): Promise<unknown> {
	switch (name) {
		case "excalidraw_get_scene": return ai.getScene(args);
		case "excalidraw_apply_operations": return ai.apply(args.operations, args.select, stopped);
		case "excalidraw_select": return ai.select(args.ids);
		case "excalidraw_render_image": return ai.render(args.ids);
		case "excalidraw_from_mermaid": return ai.fromMermaid(args.definition, args, stopped);
	}
	throw new Error(`${name} is not a tool of the editor.`);
}

/**
 * The agent's pending changes, outlined on the canvas: what it added, what it changed, and
 * (dashed) where something it removed was. Only outlines: nothing of Excalidraw's is restyled,
 * and the mouse goes through them.
 */
function ReviewOverlay({ changes, view }: { changes: Change[]; view: { scrollX: number; scrollY: number; zoom: number } }) {
	const colour = { added: "var(--ok)", changed: "var(--warn)", removed: "var(--danger)" };
	return (
		<svg id="review-outlines" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 2, pointerEvents: "none", overflow: "hidden" }}>
			{changes.slice(0, 300).map((c) => {
				const box = boxOf(c.element as any);
				const pad = 6;
				const x = (box.x + view.scrollX) * view.zoom - pad, y = (box.y + view.scrollY) * view.zoom - pad;
				const width = box.width * view.zoom + pad * 2, height = box.height * view.zoom + pad * 2;
				const angle = (((c.element as any).angle ?? 0) * 180) / Math.PI;
				return (
					<rect
						key={c.id}
						data-change={c.change}
						data-element={c.id}
						x={x}
						y={y}
						width={width}
						height={height}
						rx={7}
						fill="none"
						stroke={colour[c.change]}
						strokeWidth={2}
						strokeDasharray={c.change === "removed" ? "6 5" : undefined}
						transform={angle ? `rotate(${angle} ${x + width / 2} ${y + height / 2})` : undefined}
					/>
				);
			})}
		</svg>
	);
}

/** "2 added, 1 changed": what is pending, in a few words. */
function pendingWords(s: Summary): string {
	return (["added", "changed", "removed"] as const).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`).join(", ");
}

/**
 * The app's bar above the canvas: which drawing this is, whether it has unsaved changes, Save, Export and the chat.
 * While an agent works it says so; while its changes are pending it holds Reject and Accept (the chat has them too).
 */
function Bar({ name, dirty, saved, look, review, working, onResolve }: { name: string; dirty: boolean; saved: boolean; look: Look; review: Review | undefined; working: string | undefined; onResolve: (decision: "accept" | "reject") => void }) {
	const [root] = useState(() => {
		const el = document.getElementById("bar")!;
		return el.shadowRoot ?? el.attachShadow({ mode: "open" });
	});
	const [styled, setStyled] = useState(0);
	useEffect(() => {
		window.DrawAIIcons?.apply(look.iconStyle, root);
	}, [root, look.iconStyle, look.chatVisible]);
	return createPortal(
		<>
			<link rel="stylesheet" href="/ui/motion.css" />
			<link rel="stylesheet" href="/ui/app.css" onLoad={() => setStyled((n) => n + 1)} />
			<link rel="stylesheet" href="/excalidraw/bar.css" onLoad={() => setStyled((n) => n + 1)} />
			{/* (nothing shows until both sheets are in: unstyled buttons would flash) */}
			<header className={`bar${look.chatSide === "left" ? " side-left" : ""}${review || working ? " busy" : ""}`} hidden={styled < 2}>
				<span className="brandmark" aria-hidden="true">
					{[1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 2, 0, 0, 0].map((lit, i) => (lit === 2 ? <i key={i} data-signal="" /> : lit ? <i key={i} data-on="" /> : <i key={i} />))}
				</span>
				<span className="name" id="name" title={name}>
					{name}
				</span>
				{dirty && <span className="unsaved" id="unsaved" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
				<span className="label kind">Excalidraw</span>
				<span className="spacer" />
				{working && (
					<span className="working" id="working" role="status">
						<span className="dot-loader" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span className="label">{working}</span>
					</span>
				)}
				{review && (
					<span className="review" id="review" role="status">
						<span className="label" id="pending" title="The agent's changes are in the drawing, outlined. Keep them or put the drawing back as it was.">
							{pendingWords(review.summary)}
						</span>
						<button className="btn btn-sm" id="reject" title="Revert every pending AI change" onClick={() => onResolve("reject")}>
							Reject
						</button>
						<button className="btn btn-sm" id="accept" title="Keep every pending AI change" onClick={() => onResolve("accept")}>
							Accept
						</button>
					</span>
				)}
				<span className="label export">Export</span>
				<button className="btn btn-sm btn-ghost export" id="exportPng" title={`Export as a PNG picture with the drawing inside it, so it opens again for editing (${key("⇧E")})`} onClick={() => command("exportPng")}>
					PNG
				</button>
				<button className="btn btn-sm btn-ghost export" id="exportSvg" title="Export as an SVG picture with the drawing inside it, so it opens again for editing" onClick={() => command("exportSvg")}>
					SVG
				</button>
				<button className={`btn btn-sm${dirty ? " btn-primary" : ""}`} id="save" title={`Save (${key("S")})`} disabled={saved && !dirty} onClick={() => command("save")}>
					Save
				</button>
				{!look.chatVisible && (
					<button className="icon-btn chat" id="chat" title={`Open the AI chat (${key("J")})`} aria-label="Open the AI chat" onClick={() => command("toggleChat")}>
						<span data-icon="sparkle" />
					</button>
				)}
			</header>
		</>,
		root
	);
}

function App({ doc, initial }: { doc: HostDocument; initial: ExcalidrawInitialDataState | null }) {
	const [dark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)"));
	// Light and dark follow the app's theme (Settings → Appearance), which the page sees as the system's.
	const [theme, setTheme] = useState<"light" | "dark">(dark.matches ? "dark" : "light");
	const [dirty, setDirty] = useState(false);
	const [name, setName] = useState(doc.name);
	const [saved, setSaved] = useState(doc.saved);
	const [look, setLook] = useState(doc.look);
	const api = useRef<ExcalidrawImperativeAPI | null>(null);
	/** What the drawing held when it was loaded or last saved (undefined until it has loaded). */
	const savedStamp = useRef<string | undefined>(undefined);
	const wasDirty = useRef(false);
	const ai = useRef<DrawingAi | null>(null);
	const [review, setReview] = useState<Review | undefined>(undefined);
	const [working, setWorking] = useState<string | undefined>(undefined);
	/** Where the canvas is looking, while there are outlines to draw on it. */
	const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1 });
	const reviewing = useRef(false);
	const selection = useRef("");
	/** The tool calls under way, by the app's number for each; one that is stopped is taken out. */
	const running = useRef(new Set<number>());
	const sceneVersion = useRef(-1);

	const report = useCallback((stamp: string, always = false) => {
		const now = stamp !== savedStamp.current;
		if (now === wasDirty.current && !always) return;
		wasDirty.current = now;
		setDirty(now);
		host.post({ type: "dirty", dirty: now });
	}, []);

	useEffect(() => {
		const onTheme = () => setTheme(dark.matches ? "dark" : "light");
		dark.addEventListener("change", onTheme);
		return () => dark.removeEventListener("change", onTheme);
	}, [dark]);

	useEffect(() => {
		host.onMessage((m) => {
			if (m.type === "serialize") {
				const editor = api.current;
				void (editor && savedStamp.current !== undefined ? serialize(editor, m.format) : Promise.reject(new Error("The drawing is still loading.")))
					.then((r) => host.post({ type: "serialized", id: m.id, ok: true, ...r }))
					.catch((e) => host.post({ type: "serialized", id: m.id, ok: false, error: String(e?.message ?? e) }));
			} else if (m.type === "saved") {
				savedStamp.current = m.stamp;
				const editor = api.current;
				if (editor) report(stampOf(editor.getSceneElementsIncludingDeleted(), editor.getAppState()), true);
				// (the app waits for this before it takes the drawing for saved: a change made while the file was written is not)
				host.post({ type: "savedState", id: m.id, dirty: wasDirty.current });
			} else if (m.type === "look") {
				setName(m.name);
				setSaved(m.saved);
				setLook(m.look);
			} else if (m.type === "tool") {
				const engine = ai.current;
				const id = m.id;
				running.current.add(id);
				void (engine && savedStamp.current !== undefined ? runTool(engine, m.name, m.args, () => !running.current.has(id)) : Promise.reject(new Error("The drawing is still loading. Try again in a moment.")))
					.then((result) => host.post({ type: "toolResult", id, ok: true, result }))
					// (`forModel`: the call could not be carried out as asked, and saying why lets the model try again)
					.catch((e) => host.post({ type: "toolResult", id, ok: false, forModel: e instanceof OperationError, stopped: e instanceof StoppedError, error: String(e?.message ?? e) }))
					.finally(() => running.current.delete(id));
			} else if (m.type === "cancelTool") {
				// (a call that is still waiting, for fonts or for Mermaid, finds this out before it changes anything)
				running.current.delete(m.id);
			} else if (m.type === "resolveReview") {
				ai.current?.resolve(m.decision);
			} else if (m.type === "aiStatus") {
				setWorking(m.working ? m.text || "Working…" : undefined);
			}
		});
	}, [report]);

	return (
		<>
			<Bar name={name} dirty={dirty} saved={saved} look={look} review={review} working={working} onResolve={(decision) => ai.current?.resolve(decision)} />
			{review && <ReviewOverlay changes={review.changes} view={view} />}
			<Excalidraw
				excalidrawAPI={(a) => {
					api.current = a;
					ai.current = new DrawingAi(
						{ api: a as any, convert: convertToExcalidrawElements as any, exportToBlob, captureNow: CaptureUpdateAction.IMMEDIATELY, captureNever: CaptureUpdateAction.NEVER },
						(pending, summary, changes) => {
							reviewing.current = pending;
							if (pending) {
								const s = a.getAppState();
								setView({ scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value });
							}
							setReview(pending ? { summary, changes } : undefined);
							host.post({ type: "review", pending, summary });
						}
					);
					window.omnidrawExcalidraw = { api: a, ai: ai.current, edit, typingText, convertToExcalidrawElements, CaptureUpdateAction };
				}}
				initialData={initial ? { ...initial, scrollToContent: true } : null}
				onChange={(elements, appState) => {
					const stamp = stampOf(elements, appState);
					if (savedStamp.current === undefined) {
						// the first word from the editor: the drawing as it was loaded
						savedStamp.current = stamp;
						host.post({ type: "loaded", elements: elements.filter((e) => !e.isDeleted).length });
					}
					report(stamp);
					// the agent's pending changes follow the drawing (one that is undone is no longer pending), and their outlines the view
					// (asked only when an element changed: this runs for every move of the view, too)
					if (ai.current?.reviewing) {
						const version = hashElementsVersion(elements);
						if (version !== sceneVersion.current) {
							sceneVersion.current = version;
							ai.current.sceneChanged();
						}
					}
					if (reviewing.current) setView((v) => (v.scrollX === appState.scrollX && v.scrollY === appState.scrollY && v.zoom === appState.zoom.value ? v : { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value }));
					// what is selected, for the chat (a request is about the selection when there is one)
					const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]).join(",");
					if (selected !== selection.current) {
						selection.current = selected;
						host.post({ type: "selection", ids: ai.current?.selection() ?? [] });
					}
				}}
				theme={theme}
				name={name.replace(/(\.excalidraw)?\.(png|svg)$|\.excalidraw$/i, "")}
				handleKeyboardGlobally
				// nothing outside the app is loaded (see main.ts), so a web page cannot be embedded in a drawing, and
				// Excalidraw's own AI features (which call a service) are off
				validateEmbeddable={false}
				aiEnabled={false}
				UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }}
			>
				<MainMenu>
					<MainMenu.Item icon={<Icon name="new" />} shortcut={key("⌥N")} onSelect={() => command("new")}>
						New drawing
					</MainMenu.Item>
					<MainMenu.Item icon={<Icon name="open" />} shortcut={key("O")} onSelect={() => command("open")}>
						Open…
					</MainMenu.Item>
					<MainMenu.Item icon={<Icon name="save" />} shortcut={key("S")} onSelect={() => command("save")}>
						Save
					</MainMenu.Item>
					<MainMenu.Item icon={<Icon name="saveAs" />} shortcut={key("⇧S")} onSelect={() => command("saveAs")}>
						Save as…
					</MainMenu.Item>
					<MainMenu.Item icon={<Icon name="picture" />} shortcut={key("⇧E")} onSelect={() => command("exportPng")}>
						Export as PNG…
					</MainMenu.Item>
					<MainMenu.Item icon={<Icon name="picture" />} onSelect={() => command("exportSvg")}>
						Export as SVG…
					</MainMenu.Item>
					<MainMenu.Separator />
					<MainMenu.DefaultItems.SearchMenu />
					<MainMenu.DefaultItems.Help />
					<MainMenu.DefaultItems.ClearCanvas />
					<MainMenu.Separator />
					<MainMenu.DefaultItems.ChangeCanvasBackground />
				</MainMenu>
			</Excalidraw>
		</>
	);
}

async function start(): Promise<void> {
	const root = document.getElementById("root")!;
	const problem = (message: string) => {
		const p = document.createElement("p");
		p.id = "problem";
		p.textContent = message;
		root.replaceChildren(p);
		host.post({ type: "loadFailed", message });
	};
	let doc: HostDocument;
	try {
		doc = await host.document();
	} catch (e: any) {
		return problem(String(e?.message ?? e));
	}
	if (doc.error) return problem(doc.error);
	let initial: ExcalidrawInitialDataState | null = null;
	if (doc.bytes) {
		try {
			// (Excalidraw's own reader: a .excalidraw file, or a PNG or SVG that carries a drawing)
			initial = await loadFromBlob(new Blob([doc.bytes], { type: doc.mime }), null, null);
		} catch (e: any) {
			return problem(`${doc.name} could not be opened: ${String(e?.message ?? e)}`);
		}
	}
	createRoot(root).render(<App doc={doc} initial={initial} />);
}

void start();
