import * as fs from "fs";
import * as path from "path";

/**
 * Keeps the npm ACP adapters (Claude Code's, Codex's) current. A copy the user installed
 * globally months ago still starts, but it offers the models of its day: the app looks up
 * the newest version on npm (at most twice a day) and starts that one with npx when the
 * installed copy is older.
 */
const CHECK_EVERY_MS = 12 * 3600 * 1000;

interface Seen {
	version: string;
	checkedAt: number;
}

let file: string | undefined;
let cache: Record<string, Seen> | undefined;

/** Where the versions seen on npm are kept (the app's data folder). */
export function useAdapterCache(cacheFile: string): void {
	file = cacheFile;
	cache = undefined;
}

function load(): Record<string, Seen> {
	if (cache) return cache;
	cache = {};
	if (file) {
		try {
			const j = JSON.parse(fs.readFileSync(file, "utf8"));
			for (const [k, v] of Object.entries(j ?? {})) {
				const s = v as Seen;
				if (s && isVersion(s.version) && Number.isFinite(s.checkedAt)) cache[k] = { version: s.version, checkedAt: s.checkedAt };
			}
		} catch {
			// nothing seen yet
		}
	}
	return cache;
}

export function isVersion(v: unknown): v is string {
	return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
}

/** Is version `a` newer than `b`? (Plain x.y.z only.) */
export function newerVersion(a: string, b: string): boolean {
	const x = a.split(".").map(Number), y = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
}

/** The newest version of an adapter seen on npm, if it was looked up. */
export function latestAdapterVersion(pkg: string): string | undefined {
	return load()[pkg]?.version;
}

/** The version of the package an installed executable belongs to (following its symlink). */
export function installedAdapterVersion(bin: string, pkg: string): string | undefined {
	try {
		let dir = path.dirname(fs.realpathSync(bin));
		for (let i = 0; i < 6; i++) {
			const p = path.join(dir, "package.json");
			if (fs.existsSync(p)) {
				const j = JSON.parse(fs.readFileSync(p, "utf8"));
				if (j?.name === pkg) return isVersion(j.version) ? j.version : undefined;
			}
			const up = path.dirname(dir);
			if (up === dir) break;
			dir = up;
		}
	} catch {
		// not an npm install
	}
	return undefined;
}

/**
 * Which adapter to start: the installed one when it is as new as npm's (or npm was never
 * reached), otherwise that exact newer version through npx (which keeps it for next time).
 */
export function chooseAdapter(installed: { bin: string; version?: string } | undefined, latest: string | undefined): { use: "installed" } | { use: "npx"; version?: string } {
	if (installed && (!latest || !installed.version || !newerVersion(latest, installed.version))) return { use: "installed" };
	return { use: "npx", version: latest };
}

/**
 * Looks the adapters' newest versions up on npm (only the package names are sent).
 * Returns true when one changed. Never throws: offline, the last answer stays.
 */
export function refreshAdapterVersions(pkgs: string[], opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<boolean> {
	const p = lookUp(pkgs, opts);
	pending = p;
	void p.finally(() => {
		if (pending === p) pending = undefined;
	});
	return p;
}

let pending: Promise<unknown> | undefined;

/** Resolves when a lookup that is under way has finished (or after `maxMs`): an agent started right after launch waits for it. */
export function adaptersSettled(maxMs = 4000): Promise<void> | undefined {
	if (!pending) return undefined;
	return Promise.race([pending.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, maxMs))]);
}

async function lookUp(pkgs: string[], opts: { force?: boolean; fetcher?: typeof fetch }): Promise<boolean> {
	const seen = load();
	const get = opts.fetcher ?? fetch;
	let changed = false;
	await Promise.all(
		pkgs.map(async (pkg) => {
			if (!opts.force && seen[pkg] && Date.now() - seen[pkg].checkedAt < CHECK_EVERY_MS) return;
			try {
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), 8000);
				const res = await get(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { headers: { Accept: "application/json" }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
				if (!res.ok) return;
				const version = (await res.json())?.version;
				if (!isVersion(version)) return;
				if (seen[pkg]?.version !== version) changed = true;
				seen[pkg] = { version, checkedAt: Date.now() };
			} catch {
				// offline: keep what is known
			}
		})
	);
	if (file) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(seen, null, "\t"));
		} catch {
			// a read-only data folder: the answer stays in memory
		}
	}
	return changed;
}
