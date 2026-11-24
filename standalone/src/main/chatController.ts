import type * as acp from "@agentclientprotocol/sdk";
import { clipboard, dialog, shell, WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { ToolResult } from "../../../src/features/ai/DiagramToolbox";
import { describeContext, SelectionContext } from "../../../src/features/ai/systemPrompt";
import { AcpAgentSession, AuthRequiredError, ChatSession, SessionInfo } from "./acpSession";
import { adaptersSettled, noteAdapterFailure } from "./adapterVersions";
import { agentDef, AgentId, agentStatuses, AgentStatus, launchSpec } from "./agents";
import { apiAccess } from "./api/catalog";
import { apiChatAgents, ApiChatSession, ApiSetupError } from "./api/chatSession";
import type { ApiProvider } from "./api/chat";
import { ADDITIONS_NOTE, chatSystemPrompt, type WindowMcpServer } from "./mcpServer";
import { paths } from "./paths";
import { ChatAgent, KnownModel, settings, settingsPath, updateSettings } from "./settings";
import { modelsFromSession } from "./modelNames";
import { rememberModels } from "./modelProbe";
import type { CustomizedDrawioClient } from "../../../src/DrawioClient/CustomizedDrawioClient";

type TranscriptItem =
	| { kind: "user"; text: string; scope?: string; attachments?: string[] }
	| { kind: "assistant"; text: string }
	| { kind: "thought"; text: string }
	| { kind: "tool"; id: string; summary: string; status: "running" | "ok" | "error" }
	| { kind: "note"; text: string }
	| { kind: "error"; text: string; action?: { title: string; command: string } }
	| { kind: "permission"; id: string; title: string; detail?: string; options: acp.PermissionOption[]; outcome?: string; auto?: boolean }
	| ReportItem;

/** A card in the transcript (map findings, recent changes, refresh results) with per-row buttons. */
export interface ReportItem {
	kind: "report";
	title: string;
	subtitle?: string;
	rows: { text: string; detail?: string; color?: string; actions?: { title: string; action: unknown }[] }[];
	footer?: string;
}

interface ImageData {
	mimeType: string;
	base64: string;
}

/** What the window gives the chat. */
export interface ChatHost {
	client(): CustomizedDrawioClient | undefined;
	fileName(): string | undefined;
	/** Folder the agent works in: the diagram's folder. */
	cwd(): string;
	/** The diagram is loaded and the Draw.AI draw.io plugin is ready. */
	ready(): boolean;
	/** Mapper: open its dialog, and the number of mapped shapes in the selection. */
	openMapper?(): void;
	mappedSelectionCount?(): number;
	digDeeper?(question: string): void;
	/** Maps on the page shown (count, active findings), and the Map menu's actions. */
	pageMaps?(): { maps: number; findings: number };
	mapAction?(action: string, text: string): void;
	reportAction?(action: unknown): void;
	/** Opens the Settings window (`section`: on that part of it, "api" for the API keys). */
	openSettings?(section?: string): void;
	/** Slides the chat out of the window. */
	collapseChat?(): void;
	/** The chat's edge is dragged to `screenX` (screen coordinates); `done` when released. */
	resizeChatTo?(screenX: number, done: boolean): void;
}

/**
 * Who can answer a chat, as the picker lists them: the agent programs, then the providers
 * whose models are used with an API key (`api`: no program is started for those).
 */
type Answerer = Omit<AgentStatus, "id"> & { id: ChatAgent; api?: boolean; detail?: string };

const MAX_IMAGES = 4;
/** How many messages may wait while a request is under way. */
const MAX_WAITING = 8;
/** How something that waits is named in the chat: a request of the app by what the chat shows for it. */
function labelOf(w: { text: string; own?: { shown?: string } }): string {
	if (!w.own) return w.text;
	const label = (w.own.shown ?? w.text).replace(/\s+/g, " ").trim();
	return label.length > 120 ? `${label.slice(0, 117)}…` : label;
}

/** Something the user sent while a request was under way. */
type Waiting = {
	id: number;
	text: string;
	images: ImageData[];
	/** What was selected in the diagram as it was sent. */
	selected: string[];
	/**
	 * A request the app made (the Mapper, the Shape Workshop, markup), not words typed into the box:
	 * it is a task of its own, so it is never handed to the model in the middle of another. It
	 * follows as the next request, with what it is about and how the chat shows it.
	 */
	own?: { origin?: SelectionContext; shown?: string };
};
/** What a diagram that has no file yet is called for the model. */
const UNSAVED = "Untitled (a new diagram, not saved to a file yet)";
let versionCounter = 0;

/**
 * The chat panel of one window: transcript, agent picker, and one session with whoever was
 * picked to answer: a coding agent over ACP, or a provider's model over its API with the
 * user's key (api/chatSession.ts). Port of the extension's ChatViewProvider, with its own
 * model providers replaced by the user's agents and API keys.
 */
export class ChatController {
	private view: WebContents | undefined;
	private transcript: TranscriptItem[] = [];
	private version = ++versionCounter;
	private session: ChatSession | undefined;
	private starting: Promise<ChatSession | undefined> | undefined;
	private sessionError: string | undefined;
	private authMethods: acp.AuthMethod[] = [];
	private statuses: Answerer[] = [];
	private busy = false;
	private lassoActive = false;
	private firstPrompt = true;
	private assistant: { kind: "assistant"; text: string } | undefined;
	private thought: { kind: "thought"; text: string } | undefined;
	private permissions = new Map<string, (outcome: acp.RequestPermissionOutcome) => void>();
	/** Options of the requests waiting for an answer, to approve them all at once. */
	private permissionOptions = new Map<string, acp.PermissionOption[]>();
	/** "Allow all": approve every request in this chat until New Chat, switching agents, or turning it off. */
	private allowAll = settings().chat.allowAllByDefault;
	private nextPermission = 1;
	private toolSummaries: { name: string; result: ToolResult }[] = [];
	/** Who answers in this window; the saved setting is only the default for new windows. */
	private agent: ChatAgent = settings().agent;
	/** Ends this chat's watch on the API keys. */
	private unwatch: (() => void)[] = [];
	/** Stop was pressed during the current turn (possibly before the agent finished starting). */
	private turnCancelled = false;
	/**
	 * What the user sent while a request was under way, in order. Words alone are handed to the
	 * model with the next answer of one of the window's tools (it reads them as it works); what
	 * is left when the request ends is sent as the next one.
	 */
	private waiting: Waiting[] = [];
	private waitingIds = 0;
	/** Counts the requests: a tool call that outlives its request takes nothing meant for the next. */
	private turn = 0;
	/** The window is gone: nothing is sent any more. */
	private closed = false;
	/** Tests: answer permission requests automatically. */
	public autoApprove = false;
	/** Tests: called whenever a prompt turn ends. */
	public onTurnEnd: ((stop: string | undefined, error?: string) => void) | undefined;

	constructor(private readonly host: ChatHost, private readonly mcp: WindowMcpServer) {
		mcp.onToolResult = (name, result) => {
			this.toolSummaries.push({ name, result });
			if (this.toolSummaries.length > 50) this.toolSummaries.shift();
		};
		mcp.additions = () => {
			const turn = this.turn;
			return () => this.takeAdditions(turn);
		};
		this.refreshStatuses();
		// (a saved choice that is no longer one: an agent of an earlier version, a provider that is gone)
		if (!this.statuses.some((s) => s.id === this.agent)) this.agent = "claude";
		const access = apiAccess();
		this.unwatch.push(
			access.onKeyChange((id) => this.apiKeyChanged(id)),
			access.onRejected(() => {
				this.refreshStatuses();
				this.postState();
			})
		);
	}

	/** The transcript so far (tests read it). */
	public get items(): readonly TranscriptItem[] {
		return this.transcript;
	}

	public get agentId(): ChatAgent {
		return this.agent;
	}

	/** The provider whose model answers this chat with the user's API key, when it is not an agent program. */
	private api(): ApiProvider | undefined {
		return apiAccess().providerOfAgent(this.agent);
	}

	/** What the one who answers is called ("Claude Code", "Anthropic API"). */
	private agentLabel(id: ChatAgent = this.agent): string {
		return apiAccess().providerOfAgent(id)?.label ?? agentDef(id as AgentId).label;
	}

	public attach(view: WebContents): void {
		this.view = view;
	}

	// ----- messages from the panel -----

	public async onMessage(msg: any): Promise<void> {
		switch (msg?.type) {
			case "ready":
				this.refreshStatuses();
				this.postState();
				void this.ensureSession().catch(() => undefined);
				break;
			case "send":
				if (typeof msg.text === "string" && (msg.text.trim() || msg.images?.length)) {
					const text = msg.text.trim() || "Recreate the attached sketch/screenshot as an editable diagram.";
					// (sent while a request is under way: it joins that request, or follows it)
					const images = sanitizeImages(msg.images);
					// (the page emptied its box as it sent: what cannot wait goes back into it)
					if (!this.busy) await this.send(text, undefined, images);
					else if (!this.addWhileWorking(text, images)) this.giveBack([{ text: msg.text.trim(), images }]);
				}
				break;
			case "unqueue":
				// (by its id: the page's list may be older than this one, and a place in it another item's by now)
				if (this.waiting.some((w) => w.id === msg.id)) {
					this.waiting = this.waiting.filter((w) => w.id !== msg.id);
					this.postState();
				}
				break;
			case "stop":
				this.stop();
				break;
			case "newChat":
				this.newChat();
				break;
			case "lasso":
				this.host.client()?.aiSetLassoMode(!this.lassoActive);
				break;
			case "askInDiagram":
				this.host.client()?.aiOpenPrompt();
				break;
			case "review":
				if (msg.decision === "accept" || msg.decision === "reject") this.host.client()?.aiResolveReview(msg.decision);
				break;
			case "pickProvider":
				if (msg.providerId !== this.agentId) this.switchAgent(msg.providerId);
				break;
			case "pickModel":
				await this.pickModel(String(msg.modelId ?? ""));
				break;
			case "allowAll":
				this.setAllowAll(!!msg.on);
				break;
			case "permissionReply": {
				const resolve = this.permissions.get(msg.id);
				if (resolve) resolve(msg.optionId ? { outcome: "selected", optionId: String(msg.optionId) } : { outcome: "cancelled" });
				break;
			}
			case "pickImage": {
				const r = await dialog.showOpenDialog({
					properties: ["openFile", "multiSelections"],
					filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
				});
				const images = r.filePaths.slice(0, MAX_IMAGES).map((f) => ({
					mimeType: `image/${path.extname(f).slice(1).toLowerCase().replace("jpg", "jpeg")}`,
					base64: fs.readFileSync(f).toString("base64"),
				}));
				this.post({ type: "addImages", images });
				break;
			}
			case "command":
				await this.command(String(msg.command ?? ""));
				break;
			case "openMapper":
				this.host.openMapper?.();
				break;
			case "digDeeper":
				this.host.digDeeper?.(String(msg.text ?? ""));
				break;
			case "mapAction":
				this.host.mapAction?.(String(msg.action ?? ""), String(msg.text ?? ""));
				break;
			case "reportAction":
				this.host.reportAction?.(msg.action);
				break;
			case "collapseChat":
				this.host.collapseChat?.();
				break;
			case "resizeChat":
				if (typeof msg.screenX === "number" && isFinite(msg.screenX)) this.host.resizeChatTo?.(msg.screenX, !!msg.done);
				else if (msg.done) this.host.resizeChatTo?.(NaN, true);
				break;
			case "openSettings":
				this.host.openSettings?.(msg.section === "agents" || msg.section === "api" ? msg.section : undefined);
				break;
		}
	}

	private async command(command: string): Promise<void> {
		switch (command) {
			case "drawio-ai.markup":
				this.host.client()?.aiSetMarkupMode(true);
				break;
			case "drawio-ai.reviewDiagram":
				await this.send(
					"Review this diagram: call drawio_lint, fix the errors and warnings it reports (plus anything else that is clearly wrong), and tell me about judgement calls instead of applying them."
				);
				break;
			case "drawai.signIn":
				await this.signIn();
				break;
			case "drawai.retry":
				this.resetSession();
				this.refreshStatuses();
				this.postState();
				void this.ensureSession().catch(() => undefined);
				break;
			case "drawai.copyInstall":
				if (this.api()) break;
				clipboard.writeText(agentDef(this.agentId as AgentId).install);
				this.push({ kind: "note", text: "Install command copied to the clipboard." });
				break;
			case "drawai.openApiKeys":
				this.host.openSettings?.("api");
				break;
			case "drawai.openSettings":
				if (this.host.openSettings) this.host.openSettings();
				else {
					if (!fs.existsSync(settingsPath())) updateSettings({});
					void shell.openPath(settingsPath());
				}
				break;
		}
	}

	// ----- agent session -----

	/** Settings changed: agents' launch commands may have, so re-check them, then redraw. */
	public settingsChanged(agentsChanged: boolean): void {
		if (agentsChanged) this.refreshStatuses();
		this.postState();
	}

	/** The models a provider listed for its key changed (in Settings, or as a request found them). */
	public catalogChanged(): void {
		if (this.api()) this.postState();
	}

	/**
	 * A provider's key was kept, replaced or removed. The conversation with that provider was
	 * held with the key that is gone: a request under way ends as stopped, and the next one
	 * starts over with the key kept now.
	 */
	private apiKeyChanged(id: string): void {
		this.refreshStatuses();
		if (this.agent !== `api:${id}`) return void this.postState();
		const held = this.busy || this.transcript.some((t) => t.kind === "user");
		this.stop();
		this.resetSession();
		if (held) this.push({ kind: "note", text: `The ${this.agentLabel()} key changed: a new conversation starts.` });
		this.postState();
		void this.ensureSession().catch(() => undefined);
	}

	private refreshStatuses(): void {
		this.statuses = [
			...agentStatuses().map((s): Answerer => ({ ...s, ...(!s.installed ? { detail: "not installed" } : !s.signedIn ? { detail: "sign-in?" } : {}) })),
			...apiChatAgents(apiAccess()).map((a): Answerer => ({ id: a.id as ChatAgent, label: a.label, api: true, installed: true, signedIn: a.hasKey, ...(a.detail ? { detail: a.detail } : {}), ...(a.problem ? { problem: a.problem } : {}) })),
		];
	}

	private status(): Answerer | undefined {
		return this.statuses.find((s) => s.id === this.agentId);
	}

	private switchAgent(id: ChatAgent): void {
		if (!this.statuses.some((s) => s.id === id)) return;
		this.stop();
		this.resetSession();
		this.agent = id;
		updateSettings({ agent: id });
		if (this.transcript.length) this.push({ kind: "note", text: `Switched to ${this.agentLabel(id)}: a new conversation starts.` });
		this.postState();
		void this.ensureSession().catch(() => undefined);
	}

	private resetSession(): void {
		this.session?.dispose();
		this.session = undefined;
		this.starting = undefined;
		this.sessionError = undefined;
		this.authMethods = [];
		this.firstPrompt = true;
		this.allowAll = settings().chat.allowAllByDefault;
		for (const resolve of this.permissions.values()) resolve({ outcome: "cancelled" });
	}

	/**
	 * A session with a provider's model, used with the user's API key. Nothing is started and
	 * nothing is asked of the keychain or the provider: it is ready when a key is kept.
	 */
	private startApi(provider: ApiProvider): Promise<ChatSession | undefined> {
		const session: ApiChatSession = new ApiChatSession({
			access: apiAccess(),
			provider,
			system: () => chatSystemPrompt(this.mcp.maps),
			tools: { list: () => this.mcp.chatTools(), call: (name, args, signal) => this.mcp.call(name, args, { signal, chat: true }) },
			handlers: {
				onUpdate: (u) => {
					if (this.session === session) this.onUpdate(u);
				},
				requestPermission: (req, signal) => this.requestPermission(req, signal),
				onExit: () => undefined,
				onNote: (text) => {
					if (this.session === session) this.push({ kind: "note", text });
				},
			},
		});
		this.session = session;
		this.sessionError = undefined;
		this.starting = (async () => {
			try {
				await session.start();
				return session;
			} catch (e: any) {
				if (this.session !== session) return undefined;
				// (nothing was started that could be tried again: the next request looks for the key anew)
				this.starting = undefined;
				this.handleStartError(e, session);
				throw e;
			} finally {
				if (this.session === session) this.starting = undefined;
			}
		})();
		// (shown once it is no longer starting: a provider whose models are not listed yet has none to wait for)
		void this.starting.then(
			() => this.session === session && this.postState(),
			() => undefined
		);
		return this.starting;
	}

	/** Starts the picked agent and its session if needed; reports problems in the panel. */
	private ensureSession(waited = false): Promise<ChatSession | undefined> {
		if (this.session?.info) return Promise.resolve(this.session);
		if (this.starting) return this.starting;
		const provider = this.api();
		if (provider) return this.startApi(provider);
		// just after launch, the lookup of the newest adapters may still be under way: wait for it once
		const settling = waited ? undefined : adaptersSettled();
		if (settling) {
			const waiting: Promise<ChatSession | undefined> = settling.then(() => {
				if (this.starting === waiting) this.starting = undefined;
				this.refreshStatuses();
				return this.ensureSession(true);
			});
			this.starting = waiting;
			return waiting;
		}
		const def = agentDef(this.agentId as AgentId);
		const status = this.status();
		if (status && !status.installed) {
			this.sessionError = `${def.label} is not installed`;
			this.postState();
			return Promise.reject(new Error(status.problem));
		}
		const spec = launchSpec(def);
		if ("error" in spec) {
			this.sessionError = spec.error;
			this.postState();
			return Promise.reject(new Error(spec.error));
		}
		this.mcp.compactDescriptions = !!spec.compactTools;
		const session = new AcpAgentSession(def, spec, this.host.cwd(), { url: this.mcp.url, token: this.mcp.token, stdioProxy: paths.stdioProxy }, {
			onUpdate: (u) => this.onUpdate(u),
			requestPermission: (req, signal) => this.requestPermission(req, signal),
			onExit: (message) => {
				if (this.session !== session) return;
				this.session = undefined;
				this.starting = undefined;
				this.sessionError = "Agent stopped";
				if (this.busy || session.info) this.push({ kind: "error", text: message, action: { title: "Restart Agent", command: "drawai.retry" } });
				this.postState();
			},
		});
		this.session = session;
		this.sessionError = undefined;
		this.postState();
		this.starting = (async () => {
			try {
				await session.start();
				this.rememberModels(this.modelList(session.info).models);
				await this.applyPreferredModel(session);
				this.postState();
				return session;
			} catch (e: any) {
				if (this.session !== session) return undefined;
				// the newer adapter could not be started through npx (offline, a registry mirror without
				// it…): the copy that is installed still works, so use that for the rest of this run
				if (spec.adapterFallback && !(e instanceof AuthRequiredError)) {
					noteAdapterFailure(spec.adapterFallback);
					session.dispose();
					this.session = undefined;
					this.starting = undefined;
					this.refreshStatuses();
					return this.ensureSession(true);
				}
				this.handleStartError(e, session);
				throw e;
			} finally {
				if (this.session === session) this.starting = undefined;
			}
		})();
		return this.starting;
	}

	private handleStartError(e: any, session: ChatSession): void {
		if (e instanceof AuthRequiredError) {
			this.authMethods = e.methods;
			this.sessionError = "Sign-in needed";
			// Keep the process: authenticate() runs on it.
		} else {
			session.dispose();
			this.session = undefined;
			// (the chip beside the model has room for a few words; the request's own error says the rest)
			this.sessionError = e instanceof ApiSetupError ? String(e.message).split(". ")[0] : String(e?.message ?? e).split("\n")[0];
		}
		this.postState();
	}

	private async signIn(): Promise<void> {
		const session = this.session;
		const method = this.authMethods[0];
		if (this.api()) return void this.host.openSettings?.("api");
		if (!session || !method) {
			this.push({ kind: "note", text: `Run \`${agentDef(this.agentId as AgentId).signIn}\` in a terminal, then press Retry.` });
			return;
		}
		this.push({ kind: "note", text: `Signing in to ${this.agentLabel()} (${method.name})… follow the browser or terminal prompt.` });
		try {
			await session.authenticate(method.id);
			this.authMethods = [];
			this.sessionError = undefined;
			this.push({ kind: "note", text: "Signed in." });
		} catch (e: any) {
			this.push({ kind: "error", text: `Sign-in failed: ${e?.message ?? e}`, action: { title: "Retry", command: "drawai.retry" } });
		}
		this.postState();
	}

	private errorAction(e: any): { title: string; command: string } | undefined {
		const status = this.status();
		// (a key that is missing, unreadable or not accepted, or no model switched on: put right in Settings)
		if (e instanceof ApiSetupError) return { title: "Open Settings", command: "drawai.openApiKeys" };
		if (e instanceof AuthRequiredError) return e.methods.length ? { title: "Sign In", command: "drawai.signIn" } : { title: "Retry", command: "drawai.retry" };
		if (status && !status.installed) return { title: "Copy Install Command", command: "drawai.copyInstall" };
		return { title: "Retry", command: "drawai.retry" };
	}

	/** Switches a new session to the model chosen in Settings, if the agent offers it. */
	private async applyPreferredModel(session: ChatSession): Promise<void> {
		const preferred = settings().models[this.agentId]?.preferred;
		if (!preferred || preferred.startsWith("mode:") || !session.info) return;
		const { models, current } = this.modelList(session.info);
		const target = models.find((m) => m.value === preferred);
		if (!target || current === preferred) return;
		try {
			const [kind, id, ...rest] = target.id.split(":");
			if (kind === "opt") await session.setConfigOption(id, rest.join(":"));
			else if (kind === "mode") await session.setMode([id, ...rest].join(":"));
		} catch {
			// keep the agent's own default
		}
	}

	private modelList(info: SessionInfo | undefined) {
		return modelsFromSession(info);
	}

	/** Remembers what the agent offers, so Settings can list it while the agent is not running. */
	private rememberModels(models: KnownModel[]): void {
		// (what a provider lists for a key is kept by api/access.ts, with more than a session knows of it)
		if (!this.api()) rememberModels(this.agentId as AgentId, models);
	}

	private async pickModel(value: string): Promise<void> {
		const session = await this.ensureSession().catch(() => undefined);
		if (!session?.info) return;
		try {
			const [kind, id, ...rest] = value.split(":");
			if (kind === "opt") await session.setConfigOption(id, rest.join(":"));
			else if (kind === "mode") await session.setMode([id, ...rest].join(":"));
			// a new chat with this agent starts with the model picked last. Only a model: a mode can be
			// a permission mode ("accept everything"), which must never come back by itself.
			const picked = kind === "opt" ? this.modelList(session.info).models.find((m) => m.id === value)?.value : undefined;
			if (picked && settings().models[this.agentId]?.preferred !== picked) updateSettings({ models: { ...settings().models, [this.agentId]: { ...settings().models[this.agentId], preferred: picked } } });
		} catch (e: any) {
			this.push({ kind: "error", text: `Could not change it: ${e?.message ?? e}` });
		}
		this.postState();
	}

	// ----- prompting -----

	/** `shown` replaces the request in the transcript (e.g. a Mapper request with its facts). */
	public async send(text: string, origin?: SelectionContext, images: ImageData[] = [], shown?: string): Promise<void> {
		const client = this.host.client();
		if (this.busy) {
			// (asked for elsewhere in the app while it works: it waits its turn with what was typed meanwhile)
			this.addWhileWorking(text, images, { origin: origin ?? { cellIds: [...(client?.currentSelection ?? [])] }, shown });
			return;
		}
		const selection: SelectionContext = origin ?? { cellIds: client?.currentSelection ?? [] };
		const scope =
			selection.source === "markup"
				? `✎ ${selection.markCount ?? ""} mark${selection.markCount === 1 ? "" : "s"}`
				: selection.source === "image"
				? "🖼 image → diagram"
				: selection.cellIds.length > 0
				? `${selection.viaLasso ? "◌ lasso" : "◉"} ${selection.cellIds.length} selected`
				: selection.region
				? "◌ empty area"
				: undefined;
		this.push({ kind: "user", text: shown ?? text, scope, attachments: images.length ? [`🖼 ${images.length} image${images.length === 1 ? "" : "s"}`] : undefined });
		if (!client || !this.host.ready()) {
			this.push({ kind: "error", text: "The diagram is still loading. Try again in a moment." });
			return;
		}

		this.setBusy(true);
		this.turn++;
		this.turnCancelled = false;
		// (New Chat ends a request under way: what that request then says of its end belongs to the chat that is gone)
		const chat = this.version;
		const say = (item: Parameters<ChatController["push"]>[0]) => chat === this.version && this.push(item);
		let stop: string | undefined;
		let error: string | undefined;
		try {
			let session: ChatSession | undefined;
			try {
				session = await this.ensureSession();
			} catch (e: any) {
				error = String(e?.message ?? e);
				say({ kind: "error", text: error, action: this.errorAction(e) });
				return;
			}
			if (!session?.info) return;
			if (this.turnCancelled) {
				// Stop was pressed while the agent was still starting: never send the request.
				stop = "cancelled";
				say({ kind: "error", text: "Stopped." });
				return;
			}
			client.aiSetStatus(true, `${session.label} is editing…`);
			// (a window always has its diagram: one that is not saved yet has no file name, which must not read as "none open")
			const context = describeContext(this.host.fileName() ?? UNSAVED, selection);
			// (an agent program is told where it is and which tools to use; a model used through its API has only these tools, and is told so with every request)
			const viaApi = session instanceof ApiChatSession;
			const preamble = this.firstPrompt && !viaApi ? `${firstPromptNote(this.host.fileName())}\n\n` : "";
			this.firstPrompt = false;
			const blocks: acp.ContentBlock[] = [{ type: "text", text: `${preamble}<context>\n${context}\n</context>\n\n${text}` }];
			if (images.length) {
				if (session.info.images) {
					for (const img of images) blocks.push({ type: "image", mimeType: img.mimeType, data: img.base64 });
				} else {
					say({ kind: "note", text: viaApi ? `${session.label} takes no pictures; sent the text only.` : `${session.label} does not accept images over ACP; sent the text only.` });
				}
			}
			this.assistant = undefined;
			this.thought = undefined;
			this.toolSummaries = [];
			stop = await session.prompt(blocks);
			if (stop === "cancelled") say({ kind: "error", text: "Stopped." });
			else if (stop === "refusal") say({ kind: "error", text: `${session.label} declined this request.` });
			else if (stop === "max_tokens" || stop === "max_turn_requests") say({ kind: "note", text: `${session.label} stopped early (${stop.replace(/_/g, " ")}).` });
		} catch (e: any) {
			error = String(e?.message ?? e);
			say({ kind: "error", text: error, action: e instanceof ApiSetupError ? this.errorAction(e) : this.session ? undefined : { title: "Restart Agent", command: "drawai.retry" } });
		} finally {
			for (const t of this.transcript) if (t.kind === "tool" && t.status === "running") t.status = stop === "end_turn" ? "ok" : "error";
			client.aiSetStatus(false);
			this.setBusy(false);
			const next = this.waiting.splice(0);
			this.postState(true);
			this.onTurnEnd?.(stop, error);
			// (a request that was stopped can still come back as ended, when the two crossed: it counts as stopped)
			const finished = !this.turnCancelled && !this.closed && (stop === "end_turn" || stop === "max_tokens" || stop === "max_turn_requests");
			if (next.length) this.afterTurn(next, finished);
		}
	}

	/** Something sent while a request is under way: kept until the model can be handed it, or the request ends. */
	private addWhileWorking(text: string, images: ImageData[], own?: Waiting["own"]): boolean {
		if (this.waiting.length >= MAX_WAITING) {
			this.push({ kind: "error", text: own ? `${labelOf({ text, own })} was not taken: a lot is waiting already. Ask again when it has finished.` : "That is a lot to add while it works. Wait for it to finish, or press Stop." });
			return false;
		}
		// (what is left at the end goes as one request, which takes this many pictures)
		if (images.length && this.waiting.reduce((n, w) => n + w.images.length, images.length) > MAX_IMAGES) {
			this.push({ kind: "error", text: `Only ${MAX_IMAGES} pictures can wait at a time. ${own ? "Ask again" : "Send this one"} when it has finished.` });
			return false;
		}
		if (own) {
			this.waiting.push({ id: ++this.waitingIds, text, images, selected: [], own });
			this.postState();
			return true;
		}
		// (what "the selected one" means is settled as it is sent, as for a request: not when it is its turn)
		this.waiting.push({ id: ++this.waitingIds, text, images, selected: [...(this.host.client()?.currentSelection ?? [])] });
		this.postState();
		return true;
	}

	/**
	 * What the user added that the model can be handed right now, for the end of a tool's answer
	 * (mcpServer.ts): the words of what is waiting, up to the first that has images (those go as
	 * a request of their own). Shown in the chat where it reached the model.
	 */
	private takeAdditions(turn: number): string | undefined {
		// (`turn`: the request the tool call began in. One that ends during a later request is not read by anyone.)
		if (!this.busy || this.turnCancelled || turn !== this.turn) return undefined;
		const taken: Waiting[] = [];
		while (this.waiting.length && !this.waiting[0].images.length && !this.waiting[0].own) taken.push(this.waiting.shift()!);
		if (!taken.length) return undefined;
		for (const w of taken) this.push({ kind: "user", text: w.text, scope: `↪ added while it works${w.selected.length ? ` · ◉ ${w.selected.length} selected` : ""}` });
		this.postState();
		return taken.map((w) => (w.selected.length ? `${w.text}\n(Selected in the diagram as this was sent: ${w.selected.length} item(s) with ids ${w.selected.slice(0, 80).join(", ")}${w.selected.length > 80 ? ", ..." : ""}.)` : w.text)).join("\n\n");
	}

	/**
	 * What was still waiting when a request ended. After one that ran to its end the first is
	 * sent as the next request, with its pictures and what was selected as it was sent; the
	 * others wait on, for that request. After one that was stopped or failed nothing is sent by
	 * itself: it all goes back into the box, for the user to send or drop.
	 */
	private afterTurn(left: Waiting[], finished: boolean): void {
		if (!finished) return this.giveBack(left);
		const [first, ...rest] = left;
		this.waiting = [...rest, ...this.waiting];
		void this.send(first.text, first.own ? first.own.origin : { cellIds: first.selected }, first.images, first.own?.shown);
		// (it did not start, e.g. the diagram is loading: nothing would ever come for what still waits)
		if (!this.busy) this.giveBack(this.waiting.splice(0));
		else if (rest.length) this.postState();
	}

	/** Puts what was not sent back into the box: the user sends it again, or drops it. */
	private giveBack(all: { text: string; images: ImageData[]; own?: Waiting["own"] }[]): void {
		if (this.closed || !all.length) return;
		// (a request the app made is not the user's words: it is not put into the box, the chat says it was not sent)
		const dropped = all.filter((w) => w.own);
		if (dropped.length) this.push({ kind: "note", text: `Not sent: ${dropped.map(labelOf).join("; ")}. Ask again where you asked.` });
		const left = all.filter((w) => !w.own);
		if (!left.length) return;
		this.post({ type: "restoreInput", text: left.map((w) => w.text).filter(Boolean).join("\n\n"), images: left.flatMap((w) => w.images) });
	}

	public stop(): void {
		if (!this.busy) return;
		this.turnCancelled = true;
		this.session?.cancel();
		for (const resolve of this.permissions.values()) resolve({ outcome: "cancelled" });
	}

	public newChat(): void {
		// (what was waiting was not sent, and is not part of the chat that ends: it stays with the user)
		const left = this.waiting.splice(0);
		this.stop();
		this.resetSession();
		this.transcript = [];
		this.version = ++versionCounter;
		this.postState(true);
		this.giveBack(left);
		void this.ensureSession().catch(() => undefined);
	}

	private onUpdate(u: acp.SessionUpdate): void {
		switch (u.sessionUpdate) {
			case "agent_message_chunk":
				if (u.content.type === "text") {
					this.thought = undefined;
					if (!this.assistant) {
						this.assistant = { kind: "assistant", text: "" };
						this.transcript.push(this.assistant);
					}
					this.assistant.text += u.content.text;
					this.post({ type: "appendText", text: u.content.text });
				}
				break;
			case "agent_thought_chunk":
				if (u.content.type === "text") {
					this.assistant = undefined;
					if (!this.thought) {
						this.thought = { kind: "thought", text: "" };
						this.transcript.push(this.thought);
					}
					this.thought.text += u.content.text;
					this.post({ type: "appendThought", text: u.content.text });
				}
				break;
			case "tool_call": {
				this.assistant = undefined;
				this.thought = undefined;
				const existing = this.transcript.find((t) => t.kind === "tool" && t.id === u.toolCallId);
				if (!existing) this.push({ kind: "tool", id: u.toolCallId, summary: toolTitle(u.title, u.rawInput), status: toolStatus(u.status) });
				break;
			}
			case "tool_call_update": {
				const item = this.transcript.find((t) => t.kind === "tool" && t.id === u.toolCallId) as Extract<TranscriptItem, { kind: "tool" }> | undefined;
				if (!item) {
					if (u.title) this.push({ kind: "tool", id: u.toolCallId, summary: toolTitle(u.title, u.rawInput), status: toolStatus(u.status) });
					break;
				}
				if (u.title) item.summary = toolTitle(u.title, u.rawInput);
				if (u.status) item.status = toolStatus(u.status);
				if (u.status === "completed" || u.status === "failed") {
					const summary = this.takeSummary(u.title ?? item.summary);
					if (summary) item.summary = summary;
				}
				this.post({ type: "tool", id: item.id, summary: item.summary, status: item.status });
				break;
			}
			case "plan":
				this.push({
					kind: "note",
					text: "Plan: " + u.entries.map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${e.content}`).join("  "),
				});
				break;
			case "current_mode_update":
				if (this.session?.info?.modes) this.session.info.modes.currentModeId = u.currentModeId;
				this.postState();
				break;
			case "config_option_update":
				if (this.session?.info) {
					this.session.info.configOptions = u.configOptions;
					this.rememberModels(this.modelList(this.session.info).models);
				}
				this.postState();
				break;
		}
	}

	/** The summary the window's tools produced for a finished call of one of them ("Applied 4 edits"). */
	private takeSummary(title: string): string | undefined {
		const name = ownTool(title);
		if (!name) return undefined;
		const i = this.toolSummaries.findIndex((s) => s.name === name);
		if (i < 0) return undefined;
		const [s] = this.toolSummaries.splice(i, 1);
		return s.result.summary;
	}

	/** Turns "Allow all" on (approving what is waiting now) or off. */
	public setAllowAll(on: boolean): void {
		if (on === this.allowAll) return;
		this.allowAll = on;
		if (on) {
			for (const [id, options] of [...this.permissionOptions]) {
				const allow = allowOption(options);
				if (allow) this.permissions.get(id)?.({ outcome: "selected", optionId: allow.optionId });
			}
		}
		this.push({ kind: "note", text: on ? "Allow all is on: the agent's requests in this chat are approved without asking. Turn it off from the chip at the top." : "Allow all is off: the agent asks again." });
		this.postState();
	}

	public get allowingAll(): boolean {
		return this.allowAll;
	}

	private requestPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionOutcome> {
		// (a request that was given up before it got here: a card for it would wait for ever)
		if (signal.aborted) return Promise.resolve({ outcome: "cancelled" });
		const id = `p${this.nextPermission++}`;
		const item: Extract<TranscriptItem, { kind: "permission" }> = {
			kind: "permission",
			id,
			title: `${this.session?.label ?? "The agent"} asks to ${permissionTitle(req.toolCall.title ?? "use a tool")}`,
			detail: describeInput(req.toolCall.rawInput),
			options: req.options,
		};
		if (this.autoApprove || this.allowAll) {
			const allow = allowOption(req.options);
			if (allow) {
				this.push({ ...item, auto: this.allowAll, outcome: this.allowAll ? `✓ ${allow.name} (Allow all is on)` : `Auto-approved (test mode): ${allow.name}` });
				return Promise.resolve({ outcome: "selected", optionId: allow.optionId });
			}
		}
		this.push(item);
		return new Promise((resolve) => {
			const finish = (outcome: acp.RequestPermissionOutcome) => {
				if (!this.permissions.has(id)) return;
				this.permissions.delete(id);
				this.permissionOptions.delete(id);
				const chosen = outcome.outcome === "selected" ? req.options.find((o) => o.optionId === outcome.optionId) : undefined;
				item.outcome = chosen ? `${chosen.kind.startsWith("allow") ? "✓" : "✕"} ${chosen.name}` : "Cancelled";
				this.post({ type: "permissionResolved", id, outcome: item.outcome });
				resolve(outcome);
			};
			this.permissions.set(id, finish);
			this.permissionOptions.set(id, req.options);
			signal.addEventListener("abort", () => finish({ outcome: "cancelled" }), { once: true });
		});
	}

	// ----- diagram events -----

	/** Adds a card to the transcript (map findings, changes...). */
	public report(item: Omit<ReportItem, "kind">): void {
		this.push({ kind: "report", ...item });
	}

	/** A plain note in the transcript. */
	public note(text: string): void {
		this.push({ kind: "note", text });
	}

	public setLassoActive(active: boolean): void {
		this.lassoActive = active;
		this.postState();
	}

	public dispose(): void {
		this.closed = true;
		for (const end of this.unwatch.splice(0)) end();
		this.stop();
		this.resetSession();
	}

	// ----- view -----

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.post({ type: "busy", busy });
	}

	private push(item: TranscriptItem): void {
		this.transcript.push(item);
		if (item.kind !== "assistant") this.assistant = undefined;
		if (item.kind !== "thought") this.thought = undefined;
		this.post({ type: "append", item });
	}

	private post(msg: unknown): void {
		if (this.view && !this.view.isDestroyed()) this.view.send("chat:toWebview", msg);
	}

	public postState(transcriptChanged = false): void {
		if (transcriptChanged) this.version = ++versionCounter;
		const client = this.host.client();
		const info: SessionInfo | undefined = this.session?.info;
		const status = this.status();
		const list = this.modelList(info);
		// Models hidden in Settings stay out of the picker, except the one in use.
		const hidden = new Set(settings().models[this.agentId]?.hidden ?? []);
		const models = list.models.filter((m) => !hidden.has(m.value) || m.value === list.current).map((m) => ({ id: m.id, name: m.name, description: m.description }));
		const modelId = list.currentId;
		const providers = this.statuses.map((s) => ({ id: s.id, label: `${s.label}${s.detail ? ` — ${s.detail}` : ""}`, group: s.api ? "With an API key" : "Agents" }));
		const starting = !!this.starting;
		// (a key the provider stopped accepting: the session is there, and no request will get through)
		const trouble = status?.api ? status.problem : undefined;
		this.post({
			type: "state",
			state: {
				file: this.host.fileName() ?? "Untitled diagram",
				selectionCount: client?.currentSelection.length ?? 0,
				mappedSelection: this.host.mappedSelectionCount?.() ?? 0,
				pageMaps: this.host.pageMaps?.().maps ?? 0,
				pageFindings: this.host.pageMaps?.().findings ?? 0,
				lassoActive: this.lassoActive,
				busy: this.busy,
				transcript: this.transcript,
				transcriptVersion: this.version,
				providers,
				providerId: this.agentId,
				providerTitle: status?.problem ?? (status?.api ? "Uses your API key. OmniDraw runs the tools itself." : status?.launch ? `Runs: ${status.launch}` : undefined),
				models,
				modelId,
				modelsLoading: starting,
				modelsError: this.sessionError ?? (!starting && !info && status?.problem ? status.problem.split("\n")[0] : undefined),
				agentState: info && !trouble ? "ready" : starting ? "starting" : this.sessionError || status?.problem ? "problem" : "",
				agentInfo: trouble
					? trouble
					: info
					? info.mcpTransport
						? `${info.agentName} · ACP session ready · OmniDraw tools over MCP (${info.mcpTransport})${status?.viaNpx ? " · adapter via npx" : ""}`
						: `${info.agentName} · your API key · OmniDraw runs the tools itself`
					: starting
					? `Starting ${this.agentLabel()}${status?.viaNpx ? " (fetching the ACP adapter with npx)" : ""}…`
					: undefined,
				review: client?.pendingReview?.pending ? client.pendingReview.summary : undefined,
				allowAll: this.allowAll,
				queued: this.waiting.map((w) => ({ id: w.id, text: labelOf(w), images: w.images.length })),
				iconStyle: settings().appearance.iconStyle,
				matrix: settings().appearance.matrix,
				chatSide: settings().chat.side,
			},
		});
	}
}

function firstPromptNote(fileName: string | undefined): string {
	return [
		`You are working inside the OmniDraw app. The user has the draw.io diagram ${fileName ? `"${fileName}"` : "(not saved yet)"} open next to this chat.`,
		"Read and change it ONLY with the drawio_* tools of the \"omnidraw\" MCP server (drawio_get_diagram, drawio_apply_operations, drawio_search_shapes, drawio_render_image, drawio_lint, ...). They edit the open diagram live and the user can keep or revert your changes. Never edit diagram files on disk or with shell commands.",
		ADDITIONS_NOTE,
		"Reply with a brief summary of what you changed.",
	].join("\n");
}

/** The option that allows this one request (not the agent's own "always" rules), else any allow. */
function allowOption(options: acp.PermissionOption[]): acp.PermissionOption | undefined {
	return options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
}

function toolStatus(s: acp.ToolCallStatus | null | undefined): "running" | "ok" | "error" {
	return s === "completed" ? "ok" : s === "failed" ? "error" : "running";
}

const TOOL_LABELS: Record<string, string> = {
	drawio_get_diagram: "Reading diagram…",
	drawio_apply_operations: "Editing diagram…",
	drawio_find_cells: "Searching cells…",
	drawio_select_cells: "Selecting…",
	drawio_pages: "Working on pages…",
	drawio_render_image: "Rendering preview…",
	drawio_search_shapes: "Searching shape libraries…",
	drawio_style_reference: "Looking up styles…",
	drawio_lint: "Checking the diagram…",
	drawio_get_template: "Reading the design template…",
	drawio_get_xml: "Reading XML…",
	drawio_export: "Exporting…",
	mapper_maps: "Reading the maps…",
	mapper_list_recipes: "Looking up what can be mapped…",
	mapper_run: "Mapping…",
	mapper_find: "Searching the map…",
	mapper_show: "Reading the map…",
	mapper_path: "Tracing a path on the map…",
	mapper_findings: "Reading the map's findings…",
	mapper_worksheet: "Reading the map's worksheet…",
	mapper_set_descriptions: "Writing descriptions…",
	mapper_recent_changes: "Reading recent changes…",
	mapper_refresh: "Refreshing the map…",
	mapper_set_tour: "Saving a tour…",
	mapper_answer: "Drawing the answer…",
};

/**
 * One of the window's own tools in a title, however the agent wraps its name ("omnidraw:
 * drawio_lint", "mcp__omnidraw__drawio_lint"). Only a name that is one: a title that merely
 * holds something like it ("cat mapper_notes.txt") is shown as the agent gave it.
 */
function ownTool(title: string): string | undefined {
	const name = /(?:drawio|mapper)_[a-z_]+/.exec(title)?.[0];
	return name && Object.hasOwn(TOOL_LABELS, name) ? name : undefined;
}

/** "mcp__draw-ai__drawio_apply_operations" → "Editing diagram…"; other titles as the agent gave them. */
function toolTitle(title: string, _input?: unknown): string {
	const name = ownTool(title);
	if (name) return TOOL_LABELS[name];
	return title.length > 120 ? title.slice(0, 117) + "…" : title;
}

/** "mcp__draw-ai__drawio_get_diagram" → "use OmniDraw's drawio_get_diagram (reading diagram)". */
function permissionTitle(title: string): string {
	const name = ownTool(title);
	if (name) return `use OmniDraw's ${name} (${TOOL_LABELS[name].replace(/…$/, "").toLowerCase()})`;
	return `run: ${title.length > 120 ? title.slice(0, 117) + "…" : title}`;
}

function describeInput(input: unknown): string | undefined {
	if (input === undefined || input === null) return undefined;
	let s: string;
	try {
		s = typeof input === "string" ? input : JSON.stringify(input, null, 1);
	} catch {
		return undefined;
	}
	if (!s || s === "{}") return undefined;
	return s.length > 1200 ? s.slice(0, 1200) + "\n…" : s;
}

function sanitizeImages(raw: unknown): ImageData[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((i) => i && typeof i.base64 === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i.mimeType))
		.slice(0, MAX_IMAGES)
		.map((i) => ({ mimeType: i.mimeType, base64: i.base64 }));
}

