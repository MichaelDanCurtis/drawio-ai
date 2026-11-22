import type * as acp from "@agentclientprotocol/sdk";
import { clipboard, dialog, shell, WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { ToolResult } from "../../../src/features/ai/DiagramToolbox";
import { describeContext, SelectionContext } from "../../../src/features/ai/systemPrompt";
import { AcpAgentSession, AuthRequiredError, SessionInfo } from "./acpSession";
import { agentDef, AgentId, agentStatuses, AgentStatus, launchSpec } from "./agents";
import type { WindowMcpServer } from "./mcpServer";
import { paths } from "./paths";
import { KnownModel, settings, settingsPath, updateSettings } from "./settings";
import { versionedName } from "./modelNames";
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
	/** Opens the Settings window. */
	openSettings?(): void;
	/** Slides the chat out of the window. */
	collapseChat?(): void;
	/** The chat's edge is dragged to `screenX` (screen coordinates); `done` when released. */
	resizeChatTo?(screenX: number, done: boolean): void;
}

const MAX_IMAGES = 4;
let versionCounter = 0;
/** Guards against windows re-recording each other's model lists (settings listeners are synchronous). */
let rememberingModels = false;

/**
 * The chat panel of one window: transcript, agent picker, and one ACP session
 * with the picked coding agent. Port of the extension's ChatViewProvider, with
 * its own model providers replaced by the user's agents.
 */
export class ChatController {
	private view: WebContents | undefined;
	private transcript: TranscriptItem[] = [];
	private version = ++versionCounter;
	private session: AcpAgentSession | undefined;
	private starting: Promise<AcpAgentSession | undefined> | undefined;
	private sessionError: string | undefined;
	private authMethods: acp.AuthMethod[] = [];
	private statuses: AgentStatus[] = [];
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
	/** This window's agent; the saved setting is only the default for new windows. */
	private agent: AgentId = settings().agent;
	/** Stop was pressed during the current turn (possibly before the agent finished starting). */
	private turnCancelled = false;
	/** Tests: answer permission requests automatically. */
	public autoApprove = false;
	/** Tests: called whenever a prompt turn ends. */
	public onTurnEnd: ((stop: string | undefined, error?: string) => void) | undefined;

	constructor(private readonly host: ChatHost, private readonly mcp: WindowMcpServer) {
		mcp.onToolResult = (name, result) => {
			this.toolSummaries.push({ name, result });
			if (this.toolSummaries.length > 50) this.toolSummaries.shift();
		};
		this.refreshStatuses();
	}

	/** The transcript so far (tests read it). */
	public get items(): readonly TranscriptItem[] {
		return this.transcript;
	}

	public get agentId(): AgentId {
		return this.agent;
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
					await this.send(
						msg.text.trim() || "Recreate the attached sketch/screenshot as an editable diagram.",
						undefined,
						sanitizeImages(msg.images)
					);
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
				this.host.openSettings?.();
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
				clipboard.writeText(agentDef(this.agentId).install);
				this.push({ kind: "note", text: "Install command copied to the clipboard." });
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

	private refreshStatuses(): void {
		this.statuses = agentStatuses();
	}

	private status(): AgentStatus | undefined {
		return this.statuses.find((s) => s.id === this.agentId);
	}

	private switchAgent(id: AgentId): void {
		if (!this.statuses.some((s) => s.id === id)) return;
		this.stop();
		this.resetSession();
		this.agent = id;
		updateSettings({ agent: id });
		if (this.transcript.length) this.push({ kind: "note", text: `Switched to ${agentDef(id).label}: a new conversation starts.` });
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

	/** Starts the picked agent and its session if needed; reports problems in the panel. */
	private ensureSession(): Promise<AcpAgentSession | undefined> {
		if (this.session?.info) return Promise.resolve(this.session);
		if (this.starting) return this.starting;
		const def = agentDef(this.agentId);
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
				this.handleStartError(e, session);
				throw e;
			} finally {
				if (this.session === session) this.starting = undefined;
			}
		})();
		return this.starting;
	}

	private handleStartError(e: any, session: AcpAgentSession): void {
		if (e instanceof AuthRequiredError) {
			this.authMethods = e.methods;
			this.sessionError = "Sign-in needed";
			// Keep the process: authenticate() runs on it.
		} else {
			session.dispose();
			this.session = undefined;
			this.sessionError = String(e?.message ?? e).split("\n")[0];
		}
		this.postState();
	}

	private async signIn(): Promise<void> {
		const session = this.session;
		const method = this.authMethods[0];
		if (!session || !method) {
			this.push({ kind: "note", text: `Run \`${agentDef(this.agentId).signIn}\` in a terminal, then press Retry.` });
			return;
		}
		this.push({ kind: "note", text: `Signing in to ${agentDef(this.agentId).label} (${method.name})… follow the browser or terminal prompt.` });
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
		if (e instanceof AuthRequiredError) return e.methods.length ? { title: "Sign In", command: "drawai.signIn" } : { title: "Retry", command: "drawai.retry" };
		if (status && !status.installed) return { title: "Copy Install Command", command: "drawai.copyInstall" };
		return { title: "Retry", command: "drawai.retry" };
	}

	/** Switches a new session to the model chosen in Settings, if the agent offers it. */
	private async applyPreferredModel(session: AcpAgentSession): Promise<void> {
		const preferred = settings().models[this.agentId]?.preferred;
		if (!preferred || !session.info) return;
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

	/**
	 * The models (or modes) the agent offers, with versions in their names. `value` is what
	 * Settings stores (hidden / preferred); `id` is what pickModel takes.
	 */
	private modelList(info: SessionInfo | undefined): { models: (KnownModel & { id: string })[]; current?: string; currentId?: string } {
		const models: (KnownModel & { id: string })[] = [];
		const modelOption = info?.configOptions?.find((o) => o.type === "select" && (o.category === "model" || /model/i.test(o.id)));
		if (modelOption && modelOption.type === "select") {
			for (const entry of modelOption.options as any[]) {
				const opts = "group" in entry ? entry.options : [entry];
				for (const o of opts) {
					const value = String(o.value);
					models.push({ id: `opt:${modelOption.id}:${value}`, value, name: versionedName(String(o.name ?? value), value, o.description), description: o.description ?? undefined });
				}
			}
			const current = String(modelOption.currentValue);
			return { models, current, currentId: `opt:${modelOption.id}:${current}` };
		}
		if (info?.modes?.availableModes?.length) {
			for (const m of info.modes.availableModes) models.push({ id: `mode:${m.id}`, value: `mode:${m.id}`, name: `Mode: ${m.name}`, description: m.description ?? undefined });
			return { models, current: `mode:${info.modes.currentModeId}`, currentId: `mode:${info.modes.currentModeId}` };
		}
		return { models };
	}

	/** Remembers what the agent offers, so Settings can list it while the agent is not running. */
	private rememberModels(models: KnownModel[]): void {
		if (!models.length || rememberingModels) return;
		const known = settings().modelCatalog[this.agentId] ?? [];
		const slim = models.map((m) => ({ value: m.value, name: m.name, ...(m.description ? { description: m.description } : {}) }));
		if (JSON.stringify(known) === JSON.stringify(slim)) return;
		rememberingModels = true;
		try {
			updateSettings({ modelCatalog: { ...settings().modelCatalog, [this.agentId]: slim } });
		} finally {
			rememberingModels = false;
		}
	}

	private async pickModel(value: string): Promise<void> {
		const session = await this.ensureSession().catch(() => undefined);
		if (!session?.info) return;
		try {
			const [kind, id, ...rest] = value.split(":");
			if (kind === "opt") await session.setConfigOption(id, rest.join(":"));
			else if (kind === "mode") await session.setMode([id, ...rest].join(":"));
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
			this.push({ kind: "error", text: "Still working on the previous request — press Stop first." });
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
		this.turnCancelled = false;
		let stop: string | undefined;
		let error: string | undefined;
		try {
			let session: AcpAgentSession | undefined;
			try {
				session = await this.ensureSession();
			} catch (e: any) {
				error = String(e?.message ?? e);
				this.push({ kind: "error", text: error, action: this.errorAction(e) });
				return;
			}
			if (!session?.info) return;
			if (this.turnCancelled) {
				// Stop was pressed while the agent was still starting: never send the request.
				stop = "cancelled";
				this.push({ kind: "error", text: "Stopped." });
				return;
			}
			client.aiSetStatus(true, `${session.label} is editing…`);
			const context = describeContext(this.host.fileName(), selection);
			const preamble = this.firstPrompt ? `${firstPromptNote(this.host.fileName())}\n\n` : "";
			this.firstPrompt = false;
			const blocks: acp.ContentBlock[] = [{ type: "text", text: `${preamble}<context>\n${context}\n</context>\n\n${text}` }];
			if (images.length) {
				if (session.info.images) {
					for (const img of images) blocks.push({ type: "image", mimeType: img.mimeType, data: img.base64 });
				} else {
					this.push({ kind: "note", text: `${session.label} does not accept images over ACP; sent the text only.` });
				}
			}
			this.assistant = undefined;
			this.thought = undefined;
			this.toolSummaries = [];
			stop = await session.prompt(blocks);
			if (stop === "cancelled") this.push({ kind: "error", text: "Stopped." });
			else if (stop === "refusal") this.push({ kind: "error", text: `${session.label} declined this request.` });
			else if (stop === "max_tokens" || stop === "max_turn_requests") this.push({ kind: "note", text: `${session.label} stopped early (${stop.replace(/_/g, " ")}).` });
		} catch (e: any) {
			error = String(e?.message ?? e);
			this.push({ kind: "error", text: error, action: this.session ? undefined : { title: "Restart Agent", command: "drawai.retry" } });
		} finally {
			for (const t of this.transcript) if (t.kind === "tool" && t.status === "running") t.status = stop === "end_turn" ? "ok" : "error";
			client.aiSetStatus(false);
			this.setBusy(false);
			this.postState(true);
			this.onTurnEnd?.(stop, error);
		}
	}

	public stop(): void {
		if (!this.busy) return;
		this.turnCancelled = true;
		this.session?.cancel();
		for (const resolve of this.permissions.values()) resolve({ outcome: "cancelled" });
	}

	public newChat(): void {
		this.stop();
		this.resetSession();
		this.transcript = [];
		this.version = ++versionCounter;
		this.postState(true);
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

	/** The summary our MCP server produced for a finished drawio_* call ("Applied 4 edits"). */
	private takeSummary(title: string): string | undefined {
		const name = /drawio_[a-z_]+/.exec(title)?.[0];
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
		const providers = this.statuses.map((s) => ({
			id: s.id,
			label: `${s.label}${!s.installed ? " — not installed" : !s.signedIn ? " — sign-in?" : ""}`,
		}));
		const starting = !!this.starting;
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
				providerTitle: status?.problem ?? (status?.launch ? `Runs: ${status.launch}` : undefined),
				models,
				modelId,
				modelsLoading: starting,
				modelsError: this.sessionError ?? (!starting && !info && status?.problem ? status.problem.split("\n")[0] : undefined),
				agentState: info ? "ready" : starting ? "starting" : this.sessionError || status?.problem ? "problem" : "",
				agentInfo: info
					? `${info.agentName} · ACP session ready · OmniDraw tools over MCP (${info.mcpTransport})${status?.viaNpx ? " · adapter via npx" : ""}`
					: starting
					? `Starting ${agentDef(this.agentId).label}${status?.viaNpx ? " (fetching the ACP adapter with npx)" : ""}…`
					: undefined,
				review: client?.pendingReview?.pending ? client.pendingReview.summary : undefined,
				allowAll: this.allowAll,
				iconStyle: settings().appearance.iconStyle,
				chatSide: settings().chat.side,
			},
		});
	}
}

function firstPromptNote(fileName: string | undefined): string {
	return [
		`You are working inside the OmniDraw app. The user has the draw.io diagram ${fileName ? `"${fileName}"` : "(not saved yet)"} open next to this chat.`,
		"Read and change it ONLY with the drawio_* tools of the \"omnidraw\" MCP server (drawio_get_diagram, drawio_apply_operations, drawio_search_shapes, drawio_render_image, drawio_lint, ...). They edit the open diagram live and the user can keep or revert your changes. Never edit diagram files on disk or with shell commands.",
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
};

/** "mcp__draw-ai__drawio_apply_operations" → "Editing diagram…"; other titles as the agent gave them. */
function toolTitle(title: string, _input?: unknown): string {
	const name = /drawio_[a-z_]+/.exec(title)?.[0];
	if (name && TOOL_LABELS[name]) return TOOL_LABELS[name];
	return title.length > 120 ? title.slice(0, 117) + "…" : title;
}

/** "mcp__draw-ai__drawio_get_diagram" → "use OmniDraw's drawio_get_diagram (reading diagram)". */
function permissionTitle(title: string): string {
	const name = /drawio_[a-z_]+/.exec(title)?.[0];
	if (name) return `use OmniDraw's ${name}${TOOL_LABELS[name] ? ` (${TOOL_LABELS[name].replace(/…$/, "").toLowerCase()})` : ""}`;
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

