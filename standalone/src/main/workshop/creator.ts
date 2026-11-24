import type { GalleryService, Insertable } from "./galleries";
import { MAX_SVG_BYTES, sanitizeSvg, svgImgUri, svgSize, svgStyleUri } from "./svgSanitize";
import { mapXml, tagInfo } from "./xmlScan";
import type { GalleryConfig } from "./types";

/**
 * The Shape Creator: an agent draws an icon from a description, the user looks at it, asks
 * for changes, and keeps it. This file is its logic and the page's other half for it
 * (CreatorCore). Nothing here starts an agent or imports Electron: the program showing the
 * Workshop does that through CreatorPorts (the desktop app: creatorRunner.ts).
 */

// ----- what the program showing the Workshop provides -----

/** An agent that can draw, as the page lists it. */
export interface CreatorAgent {
	id: string;
	label: string;
	/** It can be started as far as this program can tell. */
	ready: boolean;
	/** What to tell the user when it is not (one line). */
	problem?: string;
	/** The models it offered when it last ran, and the one preferred. */
	models: { value: string; name: string }[];
	model?: string;
	/**
	 * "api": a provider's models used with the user's own API key, not an agent program. One of
	 * its models is always named: there is no "its own choice".
	 */
	kind?: "api";
	/** What is missing when it is not ready, in two or three words for the list ("no key" when left out). */
	missing?: string;
}

export interface CreatorImage {
	mimeType: string;
	base64: string;
}

/** What a tool answers the agent. */
export interface CreatorToolResult {
	text: string;
	image?: { mimeType: string; base64: string };
	isError?: boolean;
}

/** The two tools a drawing agent gets, answered by the Workshop (see CREATOR_TOOLS). */
export interface CreatorTools {
	call(name: string, args: unknown): Promise<CreatorToolResult>;
}

/** One agent, started for drawing, with a session that stays open for revisions. */
export interface CreatorSession {
	label: string;
	/** Whether it takes images with a request. */
	images: boolean;
	/** Sends a request; resolves with why the agent stopped ("end_turn", "cancelled"…). */
	prompt(text: string, images: CreatorImage[]): Promise<string>;
	/**
	 * It remembers nothing of an earlier request, though it was open for one (a conversation
	 * over an API forgets a request that was stopped or failed): the next one says the rules again.
	 */
	fresh?(): boolean;
	cancel(): void;
	dispose(): void;
}

export interface CreatorPorts {
	agents(): CreatorAgent[];
	/**
	 * Starts `agent` (with `model`, when it offers it) in a folder of its own, with only the
	 * Creator's tools. `onText` gets what the agent says while it works; `onExit` is called when
	 * its process ends.
	 */
	open(options: { agent: string; model?: string; tools: CreatorTools; onText(text: string): void; onExit(message: string): void }): Promise<CreatorSession>;
	/** Opens where `agent` is set up (its program, or its API key), when this program has such a place. */
	settings?(agent: string): void;
}

/** What CreatorCore needs of the Workshop it is part of. */
export interface CreatorEnv {
	post(msg: unknown): void;
	creator(): CreatorPorts | undefined;
	service(): GalleryService;
	configs(): GalleryConfig[];
	save(list: GalleryConfig[]): void;
	/** Puts a shape into the diagram used last; its name, or undefined with none open. */
	insert(shape: Insertable): Promise<string | undefined>;
}

// ----- the tools -----

export const SUBMIT_TOOL = "workshop_submit_svg";
export const PREVIEW_TOOL = "workshop_render_preview";

/** The tools as an MCP server lists them (the shape of McpTool in src/features/ai/mcp.ts). */
export const CREATOR_TOOLS = [
	{
		name: SUBMIT_TOOL,
		title: "Hand in an icon",
		description:
			"Hands in one finished icon as SVG. This is the only way to deliver an icon: the user sees it at once and can insert it into a diagram. Call it once per variation. Returns an error that says what to fix when the SVG is not acceptable.",
		inputSchema: {
			type: "object",
			properties: {
				svg: { type: "string", description: "The whole SVG document: one <svg> element with a viewBox." },
				name: { type: "string", description: "A short name for the icon, e.g. \"Load balancer\"." },
				tags: { type: "array", items: { type: "string" }, description: "Up to 6 words someone would search for." },
			},
			required: ["svg"],
			additionalProperties: false,
		},
		readOnly: false,
	},
	{
		name: PREVIEW_TOOL,
		title: "Look at an icon",
		description: "Draws an SVG and returns the picture (PNG, on white), so you can check your work before handing it in. Nothing is shown to the user.",
		inputSchema: {
			type: "object",
			properties: { svg: { type: "string", description: "The whole SVG document." } },
			required: ["svg"],
			additionalProperties: false,
		},
		readOnly: true,
	},
] as const;

/** Whether a name is one of the Creator's tools, however the agent spells its server ("mcp__omnidraw__workshop_submit_svg"). */
export function creatorToolNamed(title: unknown): typeof SUBMIT_TOOL | typeof PREVIEW_TOOL | undefined {
	const m = typeof title === "string" ? /(?:^|[^a-z0-9])(workshop_submit_svg|workshop_render_preview)(?:[^a-z0-9_]|$)/i.exec(title) : undefined;
	return m ? (m[1].toLowerCase() as typeof SUBMIT_TOOL) : undefined;
}

// ----- the request -----

/** The looks the user can ask for. */
export const CREATOR_STYLES: Record<string, { label: string; hint: string }> = {
	any: { label: "Any", hint: "" },
	line: { label: "Line", hint: "Draw it as an outline: strokes of one width (2 in a 48 box, round caps and joins), no filled areas." },
	solid: { label: "Solid", hint: "Draw it as a filled silhouette: solid shapes, with gaps (not strokes) where parts meet." },
	isometric: { label: "Isometric", hint: "Draw it as a small isometric object (30° axes), in two or three tones of the one colour made with opacity." },
	dots: { label: "Dot matrix", hint: "Draw it as a dot matrix: circles of one size on a regular grid, nothing else." },
};

export interface CreatorRequest {
	agent: string;
	model?: string;
	prompt: string;
	style: string;
	variations: 1 | 3;
	images: CreatorImage[];
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

/** The images of a request: up to four, of the kinds an agent takes, each within the size limit. */
export function creatorImages(raw: unknown): CreatorImage[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((i) => i && typeof i.base64 === "string" && i.base64.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/=]+$/.test(i.base64) && /^image\/(png|jpeg|gif|webp)$/.test(i.mimeType))
		.slice(0, MAX_IMAGES)
		.map((i) => ({ mimeType: i.mimeType, base64: i.base64 }));
}

/** A model as the page names it: nothing for "the agent's own choice", and never a mode (a mode can be a permission mode). */
function modelNamed(v: unknown): string | undefined {
	return typeof v === "string" && v && !v.startsWith("mode:") ? v.slice(0, 120) : undefined;
}

/** A request from the page, checked. Throws what to tell the user when something is missing. */
export function creatorRequest(msg: any): CreatorRequest {
	const prompt = String(msg?.prompt ?? "").trim().slice(0, 2000);
	if (!prompt) throw new Error("Describe the icon first.");
	const agent = String(msg?.agent ?? "").slice(0, 40);
	if (!agent) throw new Error("Choose an agent first.");
	const model = modelNamed(msg?.model);
	return { agent, model, prompt, style: Object.hasOwn(CREATOR_STYLES, msg?.style) ? msg.style : "any", variations: Number(msg?.variations) === 3 ? 3 : 1, images: creatorImages(msg?.images) };
}

const RULES = [
	`One <svg xmlns="http://www.w3.org/2000/svg"> element with viewBox="0 0 48 48" and no width or height.`,
	"Shapes only: path, rect, circle, ellipse, line, polyline, polygon, and g to group them. No scripts, no <foreignObject>, no <image>, no links or references to anything outside the SVG, and no <text> unless the request asks for letters.",
	`Colour: fill="var(--fill, #141414)" for filled parts, stroke="var(--stroke, #141414)" for lines, and fill="none" where a part is not filled, so that the icon can be recoloured later. Use fixed colours only where the request asks for colour.`,
	"It has to read at 16 pixels: few, clear shapes, nothing thinner than 2 in the 48 box, and 3 of padding on every side.",
	"Keep it small: a few hundred to a few thousand characters.",
];

/** What the agent is asked on a new request. */
export function creatorBrief(r: Pick<CreatorRequest, "prompt" | "style" | "variations">, images: number): string {
	const hint = CREATOR_STYLES[r.style]?.hint;
	return [
		"You are drawing an icon for a diagram, as SVG.",
		"",
		`What to draw: ${r.prompt}`,
		...(images ? ["", `The attached image${images === 1 ? " shows" : "s show"} what the user means. Use ${images === 1 ? "it" : "them"} as a reference for the subject, not as something to trace.`] : []),
		...(hint ? ["", `Look: ${hint}`] : []),
		"",
		"Rules for the SVG:",
		...RULES.map((x) => `- ${x}`),
		"",
		`How to work: draw it, look at it with the tool ${PREVIEW_TOOL} (it returns a picture of your SVG), fix what looks wrong, and then hand it in with the tool ${SUBMIT_TOOL}. Handing it in with that tool is the only way to deliver it: SVG in your reply is not used.`,
		r.variations === 3
			? `Hand in three variations that really differ (in composition or in what they show, not in size), each with its own call to ${SUBMIT_TOOL}, a short name and a few tags.`
			: `Hand in one icon with a short name and a few tags.`,
		"Then stop, with one short sentence about what you drew. You need no other tool: do not read or write files, run commands or search the web. Such requests are refused.",
	].join("\n");
}

/** What the agent is asked when the user wants a change to an icon it sees. */
export function creatorRevision(text: string, current?: { title: string; svg: string }): string {
	return [
		`Change the icon${current ? ` “${current.title}”` : ""} like this: ${text.trim()}`,
		...(current ? ["", "The icon as it is now (the user may have edited it):", current.svg] : []),
		"",
		`Keep to the rules for the SVG from before, look at the result with ${PREVIEW_TOOL}, and hand it in with ${SUBMIT_TOOL} (the same name). Then stop.`,
	].join("\n");
}

// ----- what comes back -----

/** An icon the agent handed in (or the user edited), cleaned. */
export interface Created {
	id: string;
	title: string;
	tags: string[];
	svg: string;
}

const NOT_ACCEPTABLE = "That is not an SVG this app accepts. It must be one <svg> element, with no script, event handler, <foreignObject>, DTD or link to anything outside it.";
const NOT_WELL_FORMED =
	"The SVG is not well-formed XML, so it cannot be drawn. There has to be one <svg> element with nothing after it, every element closed and properly nested, every attribute value in quotes and given once, and no & except in &amp; &lt; &gt; &quot; &apos; or a numbered reference.";

const XML_NAME = /^[A-Za-z_][\w.:-]*$/;

/**
 * Whether a cleaned SVG is one well-formed element: a picture that is not does not draw at
 * all (an SVG shown as an image is read as XML, which forgives nothing). The cleaner looks at
 * what an SVG holds, not at how it is built: two documents in a row, a tag left open, an
 * attribute without quotes or an entity XML does not know all pass it.
 */
function oneWellFormedElement(svg: string): boolean {
	// (a stray & or an entity that XML does not define ends the reading)
	if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(svg)) return false;
	const open: string[] = [];
	let roots = 0;
	let ok = true;
	const walked = mapXml(svg, {
		text: (text) => {
			if (!open.length && text.trim()) ok = false;
			return text;
		},
		tag: (tag) => {
			const { name, closing, empty } = tagInfo(tag);
			if (!XML_NAME.test(name)) ok = false;
			else if (closing) {
				if (open.pop() !== name || !/^<\/[^\s>]+\s*>$/.test(tag)) ok = false;
			} else {
				if (!open.length) roots++;
				// its attributes, one after the other: each named once, with its value in quotes and no "<" in it
				const seen = new Set<string>();
				const rest = tag.replace(/\s+([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_all, attribute: string, a?: string, b?: string) => {
					if (seen.has(attribute) || !XML_NAME.test(attribute) || (a ?? b ?? "").includes("<")) ok = false;
					seen.add(attribute);
					return "";
				});
				if (!/^<[^\s/>]+\s*\/?>$/.test(rest)) ok = false;
				if (!empty) open.push(name);
			}
			return tag;
		},
	});
	return walked !== undefined && ok && roots === 1 && open.length === 0;
}

/** An SVG as the Creator accepts it: cleaned, with a viewBox. Returns what is wrong otherwise (words for the agent, or the user who edited it). */
export function creatorSvg(svg: unknown): { svg: string } | { error: string } {
	if (typeof svg !== "string" || !svg.trim()) return { error: "There is no SVG: pass the whole document as `svg`." };
	if (svg.length > MAX_SVG_BYTES) return { error: `The SVG is too large (${svg.length.toLocaleString("en")} characters; at most ${MAX_SVG_BYTES.toLocaleString("en")}). An icon needs far less.` };
	let clean: string | undefined;
	try {
		clean = sanitizeSvg(svg.trim());
	} catch {
		clean = undefined;
	}
	if (!clean) return { error: NOT_ACCEPTABLE };
	if (!oneWellFormedElement(clean)) return { error: NOT_WELL_FORMED };
	const root = /^<svg\b[^>]*>/i.exec(clean)?.[0] ?? "";
	if (!/\sviewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*["']/.test(root)) return { error: `The <svg> element needs a viewBox, for example viewBox="0 0 48 48".` };
	if (!/<(path|rect|circle|ellipse|line|polyline|polygon|use|text|image)\b/i.test(clean)) return { error: "The SVG draws nothing: it has no shapes." };
	return { svg: clean };
}

/** A name and tags as they are kept: plain text, short. */
export function creatorLabels(name: unknown, tags: unknown, fallback: string): { title: string; tags: string[] } {
	const plain = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
	const title = plain(name, 60) || fallback;
	const list = Array.isArray(tags) ? tags.map((t) => plain(t, 24).toLowerCase()).filter(Boolean) : [];
	return { title, tags: [...new Set(list)].slice(0, 8) };
}

/** A created icon as the diagram takes it: an image shape, like a gallery's icon. */
export function creatorInsertable(c: Pick<Created, "title" | "svg">): Insertable {
	return { style: `shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;image=${svgStyleUri(c.svg)};`, ...svgSize(c.svg), title: c.title };
}

/** The gallery created icons are saved to unless the user picks another collection. */
export const MY_SHAPES = { id: "my-shapes", title: "My shapes" };

// ----- the page's other half -----

/**
 * How long things may take: a request before it is stopped, an agent that was asked to stop
 * before it is closed, and the page drawing a preview. (An object, so that tests can shorten it.)
 */
export const CREATOR_TIMING = { turnMs: 8 * 60 * 1000, stopMs: 5000, renderMs: 10_000 };
/** How many icons one request may hand in, and how many are kept for the page. */
const MAX_PER_TURN = 6;
const MAX_KEPT = 24;
const MAX_PNG_DATA = 4 * 1024 * 1024;

export class CreatorCore {
	private session: CreatorSession | undefined;
	private sessionKey = "";
	/** Stands for the session whose tools may hand something in: a call from one that was replaced or closed is refused. */
	private sessionOwner: object | undefined;
	/** The request that is running: its number (stale events are dropped), what it handed in, what was refused. */
	private turn: { seq: number; handedIn: number; timer?: NodeJS.Timeout; stopTimer?: NodeJS.Timeout } | undefined;
	private seq = 0;
	private created = new Map<string, Created>();
	private createdSeq = 0;
	private renders = new Map<number, (png: string | undefined) => void>();
	private renderSeq = 0;
	private last: { agent: string; model?: string } | undefined;
	private saidSeq = 0;

	constructor(private readonly env: CreatorEnv) {}

	private ports(): CreatorPorts {
		const c = this.env.creator();
		if (!c) throw new Error("The Shape Creator is not available here yet.");
		return c;
	}

	/** The page is gone (or the Workshop is): the agent is stopped and nothing is kept for it. */
	public close(): void {
		this.endTurn();
		this.seq++;
		this.dropSession();
		this.created.clear();
		for (const done of this.renders.values()) done(undefined);
		this.renders.clear();
	}

	private endTurn(): void {
		clearTimeout(this.turn?.timer);
		clearTimeout(this.turn?.stopTimer);
		this.turn = undefined;
	}

	/** Tells the page who can draw (again, when that changed: a key was added, a model hidden). */
	public postAgents(): void {
		const creator = this.env.creator();
		this.env.post({ type: "creatorAgents", agents: creator?.agents() ?? [], last: this.last ?? null, settings: !!creator?.settings });
	}

	/**
	 * What `agent` runs with changed (its API key was replaced or removed): the one that is
	 * open is closed, so that the next request starts it afresh. A request it is working on
	 * ends as stopped.
	 */
	public restart(agent: (id: string) => boolean): void {
		if (this.session && agent(this.sessionKey.split("\n")[0])) this.dropSession();
	}

	/** Closes the agent that is running, if any. */
	private dropSession(): void {
		this.session?.dispose();
		this.session = undefined;
		this.sessionKey = "";
		this.sessionOwner = undefined;
	}

	/**
	 * Stops the request that is running: the agent is asked to stop, and closed when it has not
	 * done so a little later (a request that is waiting on a closed agent ends as stopped).
	 */
	private stopTurn(): void {
		const turn = this.turn;
		const session = this.session;
		if (!turn) return;
		if (!session) {
			// the agent is still starting: the request ends now, and the agent is closed as soon as it has started
			this.endTurn();
			this.seq++;
			this.env.post({ type: "creating", state: "idle", stop: "cancelled", count: 0 });
			this.env.post({ type: "notice", message: "Stopped." });
			return;
		}
		session.cancel();
		if (turn.stopTimer) return;
		turn.stopTimer = setTimeout(() => {
			if (this.turn === turn && this.session === session) this.dropSession();
		}, CREATOR_TIMING.stopMs);
	}

	/** Whether a message is the Creator's. */
	public static handles(type: unknown): boolean {
		return typeof type === "string" && ["creatorAgents", "creatorSettings", "create", "revise", "stopCreating", "rasterised", "insertCreated", "saveCreated", "editCreated", "dropCreated"].includes(type);
	}

	public async onMessage(msg: any): Promise<void> {
		const before = this.seq;
		try {
			await this.handle(msg);
		} catch (e) {
			// (a request that was refused before it began leaves the page waiting otherwise; one that
			// began says so itself, and one refused because another is running changes nothing)
			if ((msg?.type === "create" || msg?.type === "revise") && this.seq === before && !this.turn) this.env.post({ type: "creating", state: "idle" });
			throw e;
		}
	}

	private async handle(msg: any): Promise<void> {
		switch (msg?.type) {
			case "creatorAgents":
				this.postAgents();
				break;
			case "creatorSettings":
				this.env.creator()?.settings?.(String(msg.agent ?? "").slice(0, 40));
				break;
			case "create": {
				const r = creatorRequest(msg);
				await this.run(r, (session) => creatorBrief(r, session.images ? r.images.length : 0), r.images);
				break;
			}
			case "revise": {
				const text = String(msg.text ?? "").trim().slice(0, 1000);
				if (!text) throw new Error("Say what to change first.");
				const current = this.created.get(String(msg.id));
				// (the agent and model the page shows; the ones used last only when it names none)
				const named = typeof msg.agent === "string" && !!msg.agent;
				const agent = named ? String(msg.agent).slice(0, 40) : this.last?.agent ?? "";
				if (!agent) throw new Error("Choose an agent first.");
				const model = named ? modelNamed(msg.model) : this.last?.model;
				// (an agent that drew it knows the rules; one started for this revision gets them again)
				const fresh = this.sessionKey !== `${agent}\n${model ?? ""}` || !!this.session?.fresh?.();
				await this.run({ agent, model }, () => (fresh ? `${creatorRevision(text, current)}\n\nRules for the SVG:\n${RULES.map((x) => `- ${x}`).join("\n")}` : creatorRevision(text, current)), []);
				break;
			}
			case "stopCreating":
				this.stopTurn();
				break;
			case "rasterised": {
				const done = this.renders.get(Number(msg.reqId));
				if (!done) return;
				this.renders.delete(Number(msg.reqId));
				const m = typeof msg.png === "string" && msg.png.length <= MAX_PNG_DATA ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(msg.png) : undefined;
				done(m?.[1]);
				break;
			}
			case "insertCreated": {
				const c = this.get(msg.id);
				const where = await this.env.insert(creatorInsertable(c));
				this.env.post({ type: "notice", message: where ? `Added ${c.title} to ${where}.` : "Open a diagram first." });
				break;
			}
			case "saveCreated": {
				const c = this.get(msg.id);
				const col = this.collection(msg.collectionId);
				await this.env.service().addShape(col, { title: c.title, data: svgImgUri(c.svg), ...svgSize(c.svg) });
				this.env.post({ type: "collectionChanged", id: col.id });
				this.env.post({ type: "notice", message: `Saved ${c.title} to ${col.title}.` });
				break;
			}
			case "editCreated": {
				const c = this.get(msg.id);
				const checked = creatorSvg(msg.svg);
				if ("error" in checked) throw new Error(checked.error);
				const { title } = creatorLabels(msg.title, [], c.title);
				const next = { ...c, title, svg: checked.svg };
				this.created.set(c.id, next);
				this.postCreated(next);
				break;
			}
			case "dropCreated":
				this.created.delete(String(msg.id));
				break;
		}
	}

	private get(id: unknown): Created {
		const c = this.created.get(String(id));
		if (!c) throw new Error("That icon is no longer here. Create it again.");
		return c;
	}

	/** The collection a created icon is saved to: the one named, or "My shapes" (made when it is first needed). */
	private collection(id: unknown): GalleryConfig {
		const configs = this.env.configs();
		if (id !== undefined && id !== null && id !== MY_SHAPES.id) {
			const g = configs.find((x) => x.id === id);
			if (!g || !g.sources.some((s) => s.kind === "collection")) throw new Error("That collection is gone.");
			return g;
		}
		const mine = configs.find((x) => x.id === MY_SHAPES.id);
		if (mine) {
			if (!mine.sources.some((s) => s.kind === "collection")) throw new Error(`“${mine.title}” is not a collection. Save to one of your collections instead.`);
			return mine;
		}
		const made: GalleryConfig = { id: MY_SHAPES.id, title: MY_SHAPES.title, sources: [{ kind: "collection" }], enabled: true };
		this.env.service().createCollection(made.id);
		this.env.save([...configs, made]);
		return made;
	}

	private postCreated(c: Created): void {
		this.env.post({ type: "created", id: c.id, title: c.title, tags: c.tags, svg: c.svg, src: svgImgUri(c.svg) });
	}

	/** Starts the agent if it is not the one running, sends a request and waits for the agent to finish. */
	private async run(who: { agent: string; model?: string }, text: (session: CreatorSession) => string, images: CreatorImage[]): Promise<void> {
		const ports = this.ports();
		if (this.turn) throw new Error("The agent is still drawing. Wait for it, or stop it first.");
		const seq = ++this.seq;
		const turn = { seq, handedIn: 0 } as NonNullable<CreatorCore["turn"]>;
		this.turn = turn;
		const state = (s: string, extra: object = {}) => {
			if (seq === this.seq) this.env.post({ type: "creating", state: s, ...extra });
		};
		const key = `${who.agent}\n${who.model ?? ""}`;
		let stop = "";
		try {
			if (!this.session || this.sessionKey !== key) {
				this.dropSession();
				state("starting", { agent: ports.agents().find((a) => a.id === who.agent)?.label ?? who.agent });
				const owner = {};
				let session: CreatorSession | undefined;
				session = await ports.open({
					agent: who.agent,
					model: who.model,
					tools: { call: (name, args) => this.tool(owner, name, args) },
					onText: (t) => {
						if (this.turn && this.sessionOwner === owner) this.say(String(t).slice(0, 4000));
					},
					onExit: (message) => {
						if (this.sessionOwner !== owner) return;
						// (the agent ended by itself: what it held is closed with it)
						this.dropSession();
						this.say(`\n${String(message).split("\n")[0]}\n`);
					},
				});
				// (the page closed, or the request was stopped, while the agent started)
				if (seq !== this.seq) {
					session.dispose();
					return;
				}
				this.session = session;
				this.sessionKey = key;
				this.sessionOwner = owner;
			}
			const session = this.session;
			// (who drew last, for the page's next visit: not the request itself, which has the images in it)
			this.last = { agent: who.agent, ...(who.model ? { model: who.model } : {}) };
			state("working", { agent: session.label });
			turn.timer = setTimeout(() => this.stopTurn(), CREATOR_TIMING.turnMs);
			stop = await session.prompt(text(session), session.images ? images : []);
			if (seq !== this.seq) return;
			if (images.length && !session.images) this.env.post({ type: "notice", message: `${session.label} does not take images here: it got the description only.` });
			if (!turn.handedIn) {
				this.env.post({
					type: "notice",
					message:
						stop === "cancelled"
							? "Stopped."
							: stop === "refusal"
							? `${session.label} declined this request.`
							: stop === "max_tokens"
							? `${session.label} ran out of room before it handed in an icon. Ask for something simpler, or choose another model.`
							: `${session.label} finished without handing in an icon. Ask again, or try another agent.`,
				});
			}
		} catch (e) {
			// (what goes wrong for a request that was stopped or whose page is gone is nobody's news)
			if (seq !== this.seq) return;
			throw e;
		} finally {
			if (this.turn === turn) this.endTurn();
			state("idle", { stop, count: turn.handedIn });
		}
	}

	/** What the agent says while it draws, numbered so that the page shows each piece once. */
	private say(text: string): void {
		this.env.post({ type: "creatorText", n: ++this.saidSeq, text });
	}

	/** A call of one of the Creator's tools by the agent that is drawing. */
	private async tool(owner: object, name: string, args: any): Promise<CreatorToolResult> {
		const turn = this.turn;
		if (!turn || owner !== this.sessionOwner) return { text: "No request is running: nothing can be handed in now.", isError: true };
		const tool = creatorToolNamed(name);
		if (!tool) return { text: `Unknown tool: ${String(name).slice(0, 60)}`, isError: true };
		const checked = creatorSvg(args?.svg);
		if ("error" in checked) return { text: checked.error, isError: true };
		if (tool === PREVIEW_TOOL) {
			const png = await this.render(checked.svg);
			if (!png) return { text: "The picture could not be drawn just now. Hand the icon in if you are confident in it.", isError: true };
			return { text: "This is how the SVG looks (on white, enlarged). It is shown at 16 to 64 pixels in a diagram.", image: { mimeType: "image/png", base64: png } };
		}
		if (turn !== this.turn) return { text: "The request was stopped: nothing can be handed in now.", isError: true };
		if (turn.handedIn >= MAX_PER_TURN) return { text: `That is enough for one request (${MAX_PER_TURN} icons). Stop now.`, isError: true };
		turn.handedIn++;
		const { title, tags } = creatorLabels(args?.name, args?.tags, `Icon ${this.createdSeq + 1}`);
		const c: Created = { id: `c${++this.createdSeq}`, title, tags, svg: checked.svg };
		this.created.set(c.id, c);
		// (the oldest go when there are many: the page drops them with the same rule)
		for (const id of [...this.created.keys()].slice(0, Math.max(0, this.created.size - MAX_KEPT))) this.created.delete(id);
		this.postCreated(c);
		return { text: `Received “${title}”. The user sees it now.` };
	}

	/** Asks the page to draw an SVG and give back the PNG (base64); undefined when it does not answer. */
	private render(svg: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			const reqId = ++this.renderSeq;
			const timer = setTimeout(() => {
				this.renders.delete(reqId);
				resolve(undefined);
			}, CREATOR_TIMING.renderMs);
			this.renders.set(reqId, (png) => {
				clearTimeout(timer);
				resolve(png);
			});
			this.env.post({ type: "rasterise", reqId, src: svgImgUri(svg), size: 384 });
		});
	}
}
