import type * as acp from "@agentclientprotocol/sdk";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createMcpListener, type McpTool } from "../../../src/features/ai/mcp";
import { AcpAgentSession, AuthRequiredError } from "./acpSession";
import type { AgentDef, LaunchSpec } from "./agents";
import { modelsFromSession } from "./modelNames";
import { CREATOR_TOOLS, creatorToolNamed, type CreatorSession, type CreatorTools } from "./workshop/creator";

/**
 * One agent started to draw icons for the Shape Creator, apart from any diagram's chat: in an
 * empty folder of its own, with a tool endpoint that has the Creator's two tools and nothing
 * else, and with every permission request refused except one use of those tools.
 * (Nothing here needs Electron or the app's settings: creatorRunner.ts chooses the agent.)
 */

const INSTRUCTIONS =
	"These tools belong to the Shape Creator of OmniDraw: an icon is drawn as SVG, looked at with workshop_render_preview and handed in with workshop_submit_svg. There is no diagram here and nothing else to do.";

/** Arguments as one of the Creator's tools takes them: an SVG, and for a hand-in a name and tags. */
function creatorInput(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
	const keys = Object.keys(raw as object);
	return typeof (raw as any).svg === "string" && keys.every((k) => k === "svg" || k === "name" || k === "tags");
}

/**
 * A title that is one of the Creator's tools and nothing more, in the spellings agents use for a
 * tool of a server: "workshop_submit_svg", "mcp__omnidraw__workshop_submit_svg",
 * "omnidraw: workshop_submit_svg", "Tool: omnidraw/workshop_submit_svg",
 * "workshop_submit_svg (omnidraw MCP Server)".
 */
const TOOL_ALONE = /^(?:Tool:\s*)?(?:mcp__[A-Za-z][\w-]*__|[A-Za-z][\w-]*[:/] ?)?(?:workshop_submit_svg|workshop_render_preview)(?:\s*\([A-Za-z][\w-]* MCP Server\))?$/i;
const TOOL_TITLES = new Set<string>(CREATOR_TOOLS.map((t) => t.title.toLowerCase()));
const TOOL_NAMES = new Set<string>(CREATOR_TOOLS.map((t) => t.name));
/** The name the session gives its tool endpoint (see AcpAgentSession). */
const SERVER_NAME = "omnidraw";

/** A title that is the arguments themselves, as JSON (how some agents describe a call). */
function argumentsAsTitle(title: string): boolean {
	if (!title.startsWith("{")) return false;
	try {
		return creatorInput(JSON.parse(title));
	} catch {
		return false;
	}
}

/** Whether a permission request is for one of the Creator's own tools. */
function creatorTool(call: acp.RequestPermissionRequest["toolCall"]): boolean {
	// a tool of the endpoint is "other" (or says nothing): reading, running, editing, fetching and the rest are the agent's own tools
	if (call.kind !== undefined && call.kind !== null && call.kind !== "other") return false;
	// Gemini says which server's tool it is, apart from the title (which is its description of the call)
	const named = (call as { _meta?: Record<string, any> | null })._meta?.["gemini-cli"]?.mcp;
	if (named && typeof named === "object") return named.server_name === SERVER_NAME && TOOL_NAMES.has(named.tool_name);
	if (typeof call.title !== "string") return false;
	const title = call.title.trim();
	// (not every agent shows the arguments when it asks: then the title has to be the tool and nothing
	// else, or, from an agent that says the call is a tool's, the arguments themselves)
	if (call.rawInput === undefined || call.rawInput === null) return TOOL_ALONE.test(title) || (call.kind === "other" && argumentsAsTitle(title));
	return creatorInput(call.rawInput) && (!!creatorToolNamed(title) || TOOL_TITLES.has(title.toLowerCase()));
}

/**
 * The answer to an agent's permission request while it draws: one use of one of the Creator's
 * own tools is allowed, everything else is refused. "Always" is never chosen: that would be
 * written into the agent's own configuration.
 */
export function creatorPermission(req: acp.RequestPermissionRequest): acp.RequestPermissionOutcome {
	const allow = creatorTool(req.toolCall) ? req.options.find((o) => o.kind === "allow_once") : undefined;
	if (allow) return { outcome: "selected", optionId: allow.optionId };
	const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind.startsWith("reject"));
	return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}

export interface CreatorSessionOptions {
	def: AgentDef;
	spec: LaunchSpec;
	/** The model to switch to, when the agent offers it (never a mode: a mode can be a permission mode). */
	model?: string;
	tools: CreatorTools;
	onText(text: string): void;
	onExit(message: string): void;
	/** The script that bridges stdio to the tool endpoint, for agents without HTTP MCP support. */
	stdioProxy: string;
	/** How long the agent gets to start. */
	startMs?: number;
}

export async function openCreatorSession(o: CreatorSessionOptions): Promise<CreatorSession> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-creator-"));
	const token = randomBytes(24).toString("hex");
	let port = 0;
	const tools: McpTool[] = CREATOR_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, readOnly: t.readOnly }));
	const server = http.createServer(
		createMcpListener({
			token: () => token,
			port: () => port,
			deps: {
				serverVersion: "0.1.0",
				tools: () => tools,
				instructions: async () => INSTRUCTIONS,
				callTool: async (name, args) => (tools.some((t) => t.name === name) ? o.tools.call(name, args) : { text: `Unknown tool: ${String(name).slice(0, 60)}`, isError: true }),
			},
		})
	);
	let disposed = false;
	let session: AcpAgentSession | undefined;
	// A request that is waiting when the session is closed, or when the agent's process ends,
	// does not wait for ever: closing counts as a stop, the process ending is an error.
	let stopped: (reason: string) => void = () => undefined;
	let failed: (e: Error) => void = () => undefined;
	const ended = new Promise<string>((resolve, reject) => {
		stopped = resolve;
		failed = reject;
	});
	ended.catch(() => undefined);
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		stopped("cancelled");
		session?.dispose();
		server.close();
		server.closeAllConnections();
		// (at once, not in a while: the app may be quitting)
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {
			// a folder in the temporary directory that could not be removed is left to the system
		}
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		port = (server.address() as { port: number }).port;
		let exit: string | undefined;
		let endedItself = false;
		session = new AcpAgentSession(o.def, o.spec, cwd, { url: `http://127.0.0.1:${port}/mcp`, token, stdioProxy: o.stdioProxy }, {
			onUpdate: (u) => {
				if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") o.onText(u.content.text);
			},
			requestPermission: async (req) => {
				const answer = creatorPermission(req);
				const allowed = answer.outcome === "selected" && req.options.some((x) => x.optionId === answer.optionId && x.kind === "allow_once");
				// (said where the user sees it: an agent that is refused something usually tries another way, or gives up)
				if (!allowed) o.onText(`\n[Refused: ${String(req.toolCall.title ?? "a tool").replace(/\s+/g, " ").slice(0, 80)}]\n`);
				return answer;
			},
			onExit: (message) => {
				exit = message;
				failed(new Error(String(message).split("\n")[0]));
				if (disposed) return;
				endedItself = true;
				o.onExit(message);
				// the agent ended by itself: its endpoint and its folder go with it
				dispose();
			},
		});
		// (a first start through npx downloads the adapter: stopping that halfway could leave a broken copy)
		const wait = o.startMs ?? (path.basename(o.spec.command) === "npx" ? 180_000 : 45_000);
		const running = session;
		// Starting is everything up to an agent that can be asked: its session, and the model chosen.
		// One limit covers all of it (an agent that leaves the model unanswered would wait for ever otherwise).
		const start = async () => {
			const opened = await running.start();
			if (!o.model) return opened;
			const { models, current } = modelsFromSession(opened);
			const target = models.find((m) => m.value === o.model);
			const [kind, id, ...rest] = (target?.id ?? "").split(":");
			if (target && current !== o.model && kind === "opt") {
				try {
					await running.setConfigOption(id, rest.join(":"));
				} catch {
					// the agent keeps its own choice... unless it is ending: its process is seen to end a moment after its connection closes
					if (!exit) await new Promise((r) => setTimeout(r, 300));
				}
			}
			return opened;
		};
		const starting = start();
		starting.catch(() => undefined);
		let timer: NodeJS.Timeout | undefined;
		let info;
		try {
			info = await Promise.race([starting, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`${o.def.label} did not answer in time.`)), wait)))]);
		} catch (e: any) {
			if (e instanceof AuthRequiredError) throw new Error(String(e.message).split("\n").slice(0, 2).join(" "));
			throw new Error(String(e?.message ?? exit ?? e).split("\n")[0]);
		} finally {
			clearTimeout(timer);
		}
		// (an agent that ended while it started is not one to hand out)
		if (exit !== undefined || disposed) throw new Error(String(exit ?? `${o.def.label} stopped.`).split("\n")[0]);
		const started = session;
		return {
			label: started.label,
			images: info.images,
			prompt: async (text, images) => {
				const blocks: acp.ContentBlock[] = [{ type: "text", text }];
				for (const img of images) blocks.push({ type: "image", mimeType: img.mimeType, data: img.base64 });
				try {
					return await Promise.race([started.prompt(blocks), ended]);
				} catch (e) {
					// (the connection closes a moment before the process is seen to end: say why it ended)
					if (!exit && !disposed) await new Promise((r) => setTimeout(r, 300));
					throw exit && endedItself ? new Error(String(exit).split("\n")[0]) : e;
				}
			},
			cancel: () => started.cancel(),
			dispose,
		};
	} catch (e) {
		dispose();
		throw e;
	}
}
