import { execFile } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MapperError } from "./types";

/**
 * A repository on GitHub as something to map: where a map takes a folder it also takes a
 * repository, by its address or as owner/name. The repository is downloaded (its newest state
 * only, no history) into the app's own folder and read there, like any folder.
 *
 * Read-only towards the repository: it is fetched, never pushed to. git runs none of the
 * repository's own programs for that (no hooks, no filters, no submodules, no file monitor),
 * and asks for nothing at a prompt: it works with the access this computer already has (git's
 * own saved sign-in, the GitHub CLI's, or an SSH key), or it says that it could not.
 */

export interface RepositorySpec {
	host: "github.com";
	owner: string;
	repo: string;
	/** A branch, a tag or a commit; the default branch when left out. */
	ref?: string;
	/** A folder inside the repository to map (from an address that names one). */
	subpath?: string;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_.\/+-]{0,199}$/;

function spec(owner: string, repo: string, ref?: string, subpath?: string): RepositorySpec | undefined {
	repo = repo.replace(/\.git$/i, "");
	if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return undefined;
	if (ref !== undefined && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock"))) return undefined;
	const sub = subpath
		?.split("/")
		.filter(Boolean)
		.join("/");
	if (sub && sub.split("/").some((p) => p === ".." || p === "." || p.startsWith("-") || /[\0\\]/.test(p))) return undefined;
	return { host: "github.com", owner, repo, ...(ref ? { ref } : {}), ...(sub ? { subpath: sub } : {}) };
}

/**
 * Reads what was typed as a repository: its address in the browser (also of a branch or a
 * folder in it: …/tree/main/services/api), its clone address (https or git@), or the short
 * owner/name, with `@branch` or `#branch` for another branch, tag or commit. Undefined when
 * it is none of these. (`owner/name` is also what a folder can be called: the caller looks
 * for a folder of that name first.)
 */
export function parseRepository(text: string): RepositorySpec | undefined {
	const t = text.trim();
	if (!t || /\s/.test(t) || t.length > 600) return undefined;
	const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/#@]+?)(?:\.git)?\/?(?:[#@](.+))?$/i.exec(t);
	if (ssh) return spec(ssh[1], ssh[2], ssh[3]);
	const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#@?]+?)(?:\.git)?(?:\/(.*?))?(?:\?[^#]*)?(?:#(.*))?$/i.exec(t);
	if (web) {
		const rest = (web[3] ?? "").split("/").filter(Boolean);
		// …/tree/<branch>/<folder…>, …/blob/<branch>/<file>: the branch is taken to be one word (a branch
		// with a slash in its name is given as owner/name@branch)
		if (rest[0] === "tree" && rest[1]) return spec(web[1], web[2], decodeURIComponent(rest[1]), rest.slice(2).map(decodeURIComponent).join("/"));
		if (rest[0] === "blob" && rest[1]) return spec(web[1], web[2], decodeURIComponent(rest[1]), rest.slice(2, -1).map(decodeURIComponent).join("/"));
		// (…/actions, …/pulls and the like are pages of the repository, not places in it)
		return spec(web[1], web[2], web[4] && !/[=&]/.test(web[4]) ? web[4] : undefined);
	}
	const short = /^([^/@#:]+)\/([^/@#:]+?)(?:[@#](.+))?$/.exec(t);
	if (short && !t.startsWith(".") && !t.startsWith("~")) return spec(short[1], short[2], short[3]);
	return undefined;
}

/** How a repository is named in a map's title and summary: github.com/owner/name@branch/folder. */
export function repositoryLabel(s: RepositorySpec): string {
	return `${s.host}/${s.owner}/${s.repo}${s.ref ? `@${s.ref}` : ""}${s.subpath ? `/${s.subpath}` : ""}`;
}

export interface FetchOptions {
	/** Where downloaded repositories are kept (the app's own folder). */
	cacheDir: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	progress?: (text: string) => void;
	/** Tests: where the repository is fetched from, in the order tried, in place of GitHub (a local repository). */
	remotes?: (spec: RepositorySpec) => { url: string; how: string; config?: string[]; env?: NodeJS.ProcessEnv }[];
	timeoutMs?: number;
}

export interface Fetched {
	/** The working copy. */
	dir: string;
	/** What to map: the working copy, or the folder in it that the address named. */
	root: string;
	/** The commit that was fetched. */
	head: string;
}

/** Nothing of the repository runs while git fetches it and writes its files. */
const SAFE = [
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "core.symlinks=false",
	"-c", "protocol.ext.allow=never",
	"-c", "submodule.recurse=false",
	"-c", "fetch.recurseSubmodules=false",
	"-c", "filter.lfs.smudge=",
	"-c", "filter.lfs.process=",
	"-c", "filter.lfs.required=false",
	"-c", "advice.detachedHead=false",
];

function git(args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd: o.cwd, env: o.env, signal: o.signal, timeout: o.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
			if (e?.code === "ENOENT") return reject(new MapperError("git is not installed or not on your PATH: it is what downloads a repository."));
			if (e?.name === "AbortError") return reject(new MapperError("Cancelled"));
			if (e?.killed) return resolve({ code: 124, stdout: String(stdout), stderr: "it took too long and was stopped" });
			resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** git's own words for a failure, without an address that could carry a sign-in. */
function said(stderr: string): string {
	return stderr
		.split("\n")
		.map((l) => l.replace(/^(fatal|error|remote):\s*/i, "").trim())
		.filter((l) => l && !/^(hint:|Cloning into|Initialized empty)/i.test(l))
		.slice(-2)
		.join(" ")
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, "https://")
		.slice(0, 300);
}

function hasProgram(name: string, env: NodeJS.ProcessEnv): boolean {
	return (env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

/**
 * Downloads the repository's newest state at `ref` into the cache and returns where it is. A
 * copy fetched before is replaced: a map is of the repository as it is now.
 */
export async function fetchRepository(s: RepositorySpec, o: FetchOptions): Promise<Fetched> {
	const env: NodeJS.ProcessEnv = { ...o.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: o.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes" };
	const timeoutMs = o.timeoutMs ?? 180_000;
	const run = (args: string[], cwd?: string, extra?: NodeJS.ProcessEnv) => git(args, { cwd, env: { ...env, ...extra }, signal: o.signal, timeoutMs });
	const home = path.join(o.cacheDir, s.host, s.owner.toLowerCase());
	const final = path.join(home, s.repo.toLowerCase());
	const fresh = `${final}.new-${randomBytes(4).toString("hex")}`;
	fs.mkdirSync(home, { recursive: true });
	// (the access this computer has, one way after the other: git's own saved sign-in, the GitHub CLI's, an SSH key)
	const https = `https://${s.host}/${s.owner}/${s.repo}.git`;
	const remotes = o.remotes?.(s) ?? [
		{ url: https, how: "git's saved sign-in" },
		...(hasProgram("gh", env) ? [{ url: https, how: "the GitHub CLI's sign-in", config: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] }] : []),
		{ url: `git@${s.host}:${s.owner}/${s.repo}.git`, how: "an SSH key" },
	];
	try {
		o.progress?.(`Downloading ${repositoryLabel({ ...s, subpath: undefined })}…`);
		const made = await run(["init", "-q", "--template=", fresh]);
		if (made.code !== 0) throw new MapperError(`Could not make a folder for the repository: ${said(made.stderr)}`);
		const tried: string[] = [];
		let fetched = false;
		for (const r of remotes) {
			if (o.signal?.aborted) throw new MapperError("Cancelled");
			const f = await run([...SAFE, ...(r.config ?? []), "fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", r.url, s.ref ?? "HEAD"], fresh, r.env);
			if (f.code === 0) {
				fetched = true;
				break;
			}
			tried.push(`${r.how}: ${said(f.stderr) || `git ended with ${f.code}`}`);
			// (the repository answered and has no such branch: another way of signing in will not find it either)
			if (/couldn't find remote ref|no such ref/i.test(f.stderr)) throw new MapperError(`${s.owner}/${s.repo} has no branch, tag or commit called ${s.ref}.`);
		}
		if (!fetched) {
			throw new MapperError(
				`Could not download ${s.owner}/${s.repo} from GitHub.\n${tried.map((t) => `- With ${t}`).join("\n")}`,
				"If the repository is private, sign in with `gh auth login` (or however you use git with GitHub) and try again. Or clone it yourself and choose its folder."
			);
		}
		const out = await run([...SAFE, "checkout", "-q", "--detach", "FETCH_HEAD"], fresh);
		if (out.code !== 0) throw new MapperError(`The repository was downloaded but its files could not be written: ${said(out.stderr)}`);
		const head = (await run(["rev-parse", "HEAD"], fresh)).stdout.trim();
		fs.rmSync(final, { recursive: true, force: true });
		fs.renameSync(fresh, final);
		const root = s.subpath ? path.join(final, ...s.subpath.split("/")) : final;
		if (!root.startsWith(final + path.sep) && root !== final) throw new MapperError("That folder is not inside the repository.");
		if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) throw new MapperError(`${s.owner}/${s.repo} has no folder ${s.subpath}${s.ref ? ` at ${s.ref}` : ""}.`);
		return { dir: final, root, head };
	} finally {
		fs.rmSync(fresh, { recursive: true, force: true });
	}
}
