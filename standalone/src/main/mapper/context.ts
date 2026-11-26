import { execFile } from "child_process";
import { checkReadOnly } from "./readOnly";
import { fetchRepository, type RepositorySpec } from "./repository";
import type { CollectContext, ExecResult } from "./types";
import { MapperError } from "./types";

export interface ContextOptions {
	cwd: string;
	/** The user's shell environment (PATH with the cloud CLIs, their config). */
	env: NodeJS.ProcessEnv;
	progress?: (text: string) => void;
	signal?: AbortSignal;
	/** Where repositories that are mapped by their address are downloaded to (the app's own folder). */
	repoCache?: string;
}

/** A CollectContext that runs commands for real, refusing anything that is not read-only. */
export function createContext(options: ContextOptions): CollectContext {
	const signal = options.signal ?? new AbortController().signal;
	// git in a folder the Mapper is pointed at: a repository's config must not make `git status`
	// start a program (core.fsmonitor), and status must not write the index.
	const gitConfigs = Number(options.env.GIT_CONFIG_COUNT) || 0;
	const env = {
		...options.env,
		// az installs a missing extension silently when a command needs one: never from the Mapper.
		AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_COUNT: String(gitConfigs + 1),
		[`GIT_CONFIG_KEY_${gitConfigs}`]: "core.fsmonitor",
		[`GIT_CONFIG_VALUE_${gitConfigs}`]: "false",
	};
	const repoCache = options.repoCache;
	return {
		cwd: options.cwd,
		signal,
		progress: options.progress ?? (() => undefined),
		...(repoCache ? { repository: (spec: RepositorySpec) => fetchRepository(spec, { cacheDir: repoCache, env: options.env, signal, progress: options.progress }) } : {}),
		exec(command, args, opts = {}): Promise<ExecResult> {
			const refused = checkReadOnly(command, args);
			if (refused) return Promise.reject(new MapperError(`Refused: ${refused}. The Mapper only reads.`));
			if (signal.aborted) return Promise.reject(new MapperError("Cancelled"));
			return new Promise((resolve, reject) => {
				const child = execFile(
					command,
					args,
					{
						cwd: opts.cwd ?? options.cwd,
						env,
						timeout: opts.timeoutMs ?? 180_000,
						maxBuffer: 512 * 1024 * 1024,
						signal,
						windowsHide: true,
					},
					(error, stdout, stderr) => {
						const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
						if (error && (error as any).code === "ENOENT") {
							reject(new MapperError(`${command} is not installed or not on your PATH.`));
						} else if (error && (error as any).name === "AbortError") {
							reject(new MapperError("Cancelled"));
						} else if (error && (error as any).killed) {
							reject(new MapperError(`${command} ${args.slice(0, 3).join(" ")} took too long and was stopped.`));
						} else {
							resolve({ stdout: String(stdout), stderr: String(stderr), code });
						}
					}
				);
				if (opts.input !== undefined) child.stdin?.end(opts.input);
			});
		},
	};
}

/** Runs a command and parses its JSON output; a non-zero exit becomes a MapperError with stderr. */
export async function execJson<T = any>(ctx: CollectContext, command: string, args: string[], opts?: { timeoutMs?: number }): Promise<T> {
	const r = await ctx.exec(command, args, opts);
	if (r.code !== 0) {
		const msg = (r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n");
		throw new MapperError(`\`${command} ${args.slice(0, 4).join(" ")}\` failed: ${msg || `exit code ${r.code}`}`);
	}
	const text = r.stdout.trim();
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new MapperError(`\`${command} ${args.slice(0, 3).join(" ")}\` did not return JSON.`);
	}
}
