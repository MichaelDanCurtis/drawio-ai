import type { CancellationToken } from "vscode";
import { ProviderError } from "./types";

export interface SseMessage {
	event: string;
	data: string;
}

/** Links a VS Code cancellation token to fetch's AbortSignal. */
export function abortSignalFor(token: CancellationToken): {
	signal: AbortSignal;
	dispose(): void;
} {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const sub = token.onCancellationRequested(() => controller.abort());
	return { signal: controller.signal, dispose: () => sub.dispose() };
}

/** Never echoes response bodies verbatim beyond a short excerpt; they may contain request details. */
export async function throwForStatus(response: Response, provider: string): Promise<void> {
	if (response.ok) {
		return;
	}
	let detail = "";
	try {
		const body = await response.text();
		try {
			const json = JSON.parse(body);
			detail = json?.error?.message ?? json?.message ?? "";
		} catch {
			detail = body;
		}
	} catch {
		// ignore
	}
	detail = String(detail).slice(0, 300);
	const hint =
		response.status === 401 || response.status === 403
			? " Check the API key (Draw.io AI: Set API Key)."
			: response.status === 404
			? " Check the base URL and model name in settings."
			: "";
	throw new ProviderError(
		`${provider} request failed (${response.status})${detail ? `: ${detail}` : ""}.${hint}`
	);
}

/** Parses a text/event-stream body. Decodes bytes with a streaming decoder so multi-byte chars split across chunks survive. */
export async function* readSse(response: Response): AsyncIterable<SseMessage> {
	if (!response.body) {
		throw new ProviderError("Empty response body");
	}
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const msg = parseBlock(raw);
				if (msg) {
					yield msg;
				}
			}
			if (done) {
				const msg = parseBlock(buffer);
				if (msg) {
					yield msg;
				}
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseBlock(block: string): SseMessage | undefined {
	let event = "message";
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue;
		const idx = line.indexOf(":");
		const field = idx < 0 ? line : line.slice(0, idx);
		let value = idx < 0 ? "" : line.slice(idx + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}
