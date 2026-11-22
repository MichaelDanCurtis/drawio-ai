import { allowedUrl } from "./sources";

export interface FetchResult {
	ok: boolean;
	status: number;
	text: string;
	json?: any;
}

export interface FetchOptions {
	timeoutMs?: number;
	/** The most bytes of body read; a longer answer fails. */
	maxBytes?: number;
	signal?: AbortSignal;
}

const MAX_REDIRECTS = 3;

/**
 * A GET for the Workshop: only from the allowed hosts, every redirect checked against them
 * too (at most three), and the body read up to `maxBytes`, so a host that is allowed cannot
 * send the app elsewhere or fill memory.
 */
export async function workshopFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
	const onAbort = () => ctrl.abort();
	opts.signal?.addEventListener("abort", onAbort);
	const maxBytes = opts.maxBytes ?? 512 * 1024;
	try {
		let current = url;
		for (let hop = 0; ; hop++) {
			if (!allowedUrl(current)) throw new Error(`Downloads only come from jsDelivr and GitHub (cdn.jsdelivr.net, data.jsdelivr.com, raw.githubusercontent.com), not ${hostOf(current)}.`);
			const res = await fetch(current, { headers: { Accept: "application/json, image/svg+xml, */*" }, redirect: "manual", signal: ctrl.signal });
			if (res.status >= 300 && res.status < 400) {
				const to = res.headers.get("location");
				await res.body?.cancel().catch(() => undefined);
				if (!to || hop >= MAX_REDIRECTS) throw new Error(`${hostOf(url)} redirected too often.`);
				current = new URL(to, current).toString();
				continue;
			}
			const declared = Number(res.headers.get("content-length"));
			if (declared > maxBytes) {
				await res.body?.cancel().catch(() => undefined);
				throw new Error(`${new URL(current).pathname} is larger than ${Math.round(maxBytes / 1024)} KB.`);
			}
			const text = await readCapped(res, maxBytes);
			let json: any;
			try {
				json = text ? JSON.parse(text) : undefined;
			} catch {
				json = undefined;
			}
			return { ok: res.ok, status: res.status, text, json };
		}
	} catch (e: any) {
		if (opts.signal?.aborted) throw new Error("Stopped.");
		if (ctrl.signal.aborted) throw new Error(`${hostOf(url)} did not answer in time.`);
		throw e instanceof Error ? e : new Error(String(e));
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`${new URL(res.url || "https://x/").pathname} is larger than ${Math.round(maxBytes / 1024)} KB.`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "that address";
	}
}
