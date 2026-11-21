import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { settings } from "./settings";

export type AgentId = "gemini" | "claude" | "codex" | "copilot" | "kimi";

export interface AgentDef {
	id: AgentId;
	label: string;
	/** The CLI(s) the user has installed and signed in to; any one is enough. */
	cli: string[];
	/**
	 * Executable that speaks ACP on stdio, and its args: one command, an npx-installable
	 * adapter, or several CLIs of which the first one installed is used.
	 */
	acp:
		| { command: string; args: string[] }
		| { npxPackage: string; bin: string }
		| { candidates: { command: string; args: string[]; label: string; compactTools?: boolean }[] };
	install: string;
	signIn: string;
	/** Heuristic: is there a saved sign-in or an API key? (The agent has the final word.) */
	hasCredentials(env: NodeJS.ProcessEnv): boolean;
}

const home = os.homedir();
const exists = (...p: string[]) => fs.existsSync(path.join(...p));

export const AGENTS: AgentDef[] = [
	{
		id: "claude",
		label: "Claude Code",
		cli: ["claude"],
		// Zed's adapter, now published by the ACP project (was @zed-industries/claude-code-acp).
		acp: { npxPackage: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
		install: "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp",
		signIn: "claude  (then /login)",
		hasCredentials: (env) =>
			!!env.ANTHROPIC_API_KEY ||
			!!env.CLAUDE_CODE_OAUTH_TOKEN ||
			exists(home, ".claude", ".credentials.json") ||
			hasOauthAccount(path.join(home, ".claude.json")),
	},
	{
		id: "gemini",
		label: "Gemini",
		// Google's Antigravity CLI (`agy`, ACP via its `acp` subcommand) replaces Gemini CLI for
		// personal Google accounts; plain Gemini CLI (`gemini --acp`) is the fallback.
		cli: ["agy", "gemini"],
		acp: {
			candidates: [
				// Antigravity drops MCP tools with long descriptions: send compact ones.
				{ command: "agy", args: ["acp"], label: "Gemini (Antigravity CLI)", compactTools: true },
				{ command: "gemini", args: ["--acp"], label: "Gemini CLI" },
			],
		},
		install: "Install the Antigravity CLI (agy) from https://antigravity.google, or: npm install -g @google/gemini-cli",
		signIn: "agy acp --login  (or `gemini` for Gemini CLI)",
		hasCredentials: (env) =>
			!!env.GEMINI_API_KEY ||
			!!env.GOOGLE_API_KEY ||
			!!env.GOOGLE_GENAI_USE_VERTEXAI ||
			exists(home, ".gemini", "antigravity-cli") ||
			exists(home, ".gemini", "oauth_creds.json") ||
			exists(home, ".gemini", "google_accounts.json"),
	},
	{
		id: "codex",
		label: "Codex",
		cli: ["codex"],
		acp: { npxPackage: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
		install: "npm install -g @openai/codex @agentclientprotocol/codex-acp",
		signIn: "codex login",
		hasCredentials: (env) => !!env.OPENAI_API_KEY || !!env.CODEX_API_KEY || exists(env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json"),
	},
	{
		id: "copilot",
		label: "GitHub Copilot",
		cli: ["copilot"],
		// GitHub Copilot CLI speaks ACP itself.
		acp: { command: "copilot", args: ["--acp"] },
		install: "npm install -g @github/copilot",
		signIn: "copilot  (then /login)",
		hasCredentials: (env) =>
			!!env.COPILOT_GITHUB_TOKEN ||
			!!env.GH_TOKEN ||
			!!env.GITHUB_TOKEN ||
			fileMentions(path.join(home, ".copilot", "config.json"), /logged_in_users|last_logged_in_user/) ||
			exists(home, ".config", "github-copilot", "apps.json"),
	},
	{
		id: "kimi",
		label: "Kimi",
		cli: ["kimi"],
		// Moonshot's Kimi Code CLI speaks ACP with its `acp` subcommand.
		acp: { command: "kimi", args: ["acp"] },
		install: "Install Kimi Code CLI from https://moonshotai.github.io/kimi-code/",
		signIn: "kimi login",
		hasCredentials: (env) =>
			!!env.KIMI_API_KEY ||
			!!env.MOONSHOT_API_KEY ||
			hasFiles(path.join(home, ".kimi-code", "credentials")) ||
			hasFiles(path.join(home, ".kimi", "credentials")),
	},
];

function fileMentions(file: string, pattern: RegExp): boolean {
	try {
		return pattern.test(fs.readFileSync(file, "utf8"));
	} catch {
		return false;
	}
}

function hasFiles(dir: string): boolean {
	try {
		return fs.readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function hasOauthAccount(file: string): boolean {
	try {
		return !!JSON.parse(fs.readFileSync(file, "utf8"))?.oauthAccount;
	} catch {
		return false;
	}
}

// ----- environment -----

let shellEnv: NodeJS.ProcessEnv | undefined;

/**
 * The user's login-shell environment. Apps started from Finder/Dock get a bare
 * PATH, which would hide CLIs installed with npm, nvm, Homebrew or ~/.local/bin.
 */
export function agentEnv(): NodeJS.ProcessEnv {
	if (shellEnv) return shellEnv;
	const base: NodeJS.ProcessEnv = { ...process.env };
	for (const k of Object.keys(base)) {
		if (k.startsWith("ELECTRON_") || k === "NODE_OPTIONS" || k === "ORIGINAL_XDG_CURRENT_DESKTOP") delete base[k];
	}
	if (process.platform !== "win32") {
		const shell = process.env.SHELL || "/bin/zsh";
		const marker = "__DRAWAI_ENV__";
		const r = spawnSync(shell, ["-ilc", `printf '${marker}'; env -0; printf '${marker}'`], {
			encoding: "utf8",
			timeout: 8000,
			env: { ...base, DRAWAI_RESOLVING_ENV: "1" },
		});
		const body = r.stdout?.split(marker)[1];
		if (body) {
			for (const pair of body.split("\0")) {
				const i = pair.indexOf("=");
				if (i > 0) {
					const k = pair.slice(0, i);
					if (k === "PATH" || !(k in base)) base[k] = pair.slice(i + 1);
				}
			}
		}
		const extra = [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
		const parts = (base.PATH ?? "").split(path.delimiter).filter(Boolean);
		for (const p of extra) if (!parts.includes(p)) parts.push(p);
		base.PATH = parts.join(path.delimiter);
	}
	delete base.DRAWAI_RESOLVING_ENV;
	shellEnv = base;
	return base;
}

export function which(cmd: string, env = agentEnv()): string | undefined {
	if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : undefined;
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const p = path.join(dir, cmd);
		try {
			if (fs.statSync(p).isFile()) {
				fs.accessSync(p, fs.constants.X_OK);
				return p;
			}
		} catch {
			// keep looking
		}
	}
	return undefined;
}

// ----- status -----

export interface AgentStatus {
	id: AgentId;
	label: string;
	/** The agent's own CLI is installed. */
	installed: boolean;
	/** Some saved sign-in or API key was found. */
	signedIn: boolean;
	/** How it will be launched (for the tooltip). */
	launch?: string;
	/** Launching fetches the ACP adapter with npx first. */
	viaNpx?: boolean;
	/** What to tell the user when it is not usable. */
	problem?: string;
}

export interface LaunchSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** Which CLI this is, when an agent has several (e.g. "Gemini (Antigravity CLI)"). */
	label?: string;
	/** The agent needs short MCP tool descriptions (see compactTools in mcpServer.ts). */
	compactTools?: boolean;
}

export function launchSpec(def: AgentDef): LaunchSpec | { error: string } {
	const env = agentEnv();
	const override = settings().agents[def.id];
	if (override?.command) {
		const command = which(override.command, env);
		if (!command) return { error: `${override.command} (from settings.json) was not found.` };
		return { command, args: override.args ?? [], env: { ...env, ...(override.env ?? {}) } };
	}
	if ("candidates" in def.acp) {
		for (const c of def.acp.candidates) {
			const command = which(c.command, env);
			if (command) return { command, args: c.args, env, label: c.label, compactTools: c.compactTools };
		}
		return { error: `${def.label} is not installed. ${def.install}` };
	}
	if ("command" in def.acp) {
		const command = which(def.acp.command, env);
		return command ? { command, args: def.acp.args, env } : { error: `${def.label} is not installed. Install it with: ${def.install}` };
	}
	const adapter = which(def.acp.bin, env);
	if (adapter) return { command: adapter, args: [], env };
	const npx = which("npx", env);
	if (!npx) return { error: `${def.acp.bin} is not installed and npx was not found. Install it with: ${def.install}` };
	return { command: npx, args: ["-y", def.acp.npxPackage], env };
}

export function agentStatuses(): AgentStatus[] {
	const env = agentEnv();
	return AGENTS.map((def) => {
		const installed = def.cli.some((c) => !!which(c, env)) || !!settings().agents[def.id]?.command;
		const signedIn = def.hasCredentials(env);
		const spec = launchSpec(def);
		const viaNpx = !("error" in spec) && path.basename(spec.command) === "npx";
		const problem = !installed
			? `${def.label} is not installed. Install it with:\n${def.install}`
			: "error" in spec
			? spec.error
			: !signedIn
			? `${def.label} does not look signed in. Run \`${def.signIn}\` in a terminal first.`
			: undefined;
		return {
			id: def.id,
			label: ("error" in spec ? undefined : spec.label) ?? def.label,
			installed,
			signedIn,
			viaNpx,
			launch: "error" in spec ? undefined : [spec.command, ...spec.args].join(" "),
			problem,
		};
	});
}

export function agentDef(id: AgentId): AgentDef {
	return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}
