import * as vscode from "vscode";
import { sha256 } from "js-sha256";
import type { ChatMessage, ChatPart } from "./providers/types";

export type TranscriptItem =
	| { kind: "user"; text: string; scope?: string; attachments?: string[] }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; id: string; summary: string; status: "running" | "ok" | "error" }
	| { kind: "error"; text: string; action?: { title: string; command: string } }
	| { kind: "note"; text: string };

export interface StoredChat {
	version: 1;
	uri: string;
	savedAt: string;
	messages: ChatMessage[];
	transcript: TranscriptItem[];
}

const MAX_TRANSCRIPT_ITEMS = 300;
const MAX_PART_CHARS = 20_000;
const MAX_TOOL_RESULT_CHARS = 4_000;
const MAX_BYTES = 1_500_000;

const isTurnStart = (m: ChatMessage) => m.role === "user" && m.parts.some((p) => p.type === "text");

function truncate(text: string, max: number, note: string): string {
	return text.length > max ? text.slice(0, max) + note : text;
}

/** Strips images, shortens large tool results and caps the size so a chat stays cheap to store and resend. */
export function prepareForStorage(uri: string, messages: readonly ChatMessage[], transcript: readonly TranscriptItem[]): StoredChat {
	let msgs: ChatMessage[] = messages.map((m) => ({
		role: m.role,
		parts: m.parts.map((p): ChatPart => {
			if (p.type === "image") return { type: "text", text: "[image omitted]" };
			if (p.type === "toolResult") {
				return { ...p, image: undefined, text: truncate(p.text, MAX_TOOL_RESULT_CHARS, "…[truncated when the chat was saved]") };
			}
			if (p.type === "text") return { type: "text", text: truncate(p.text, MAX_PART_CHARS, "…[truncated when the chat was saved]") };
			return p;
		}),
	}));
	let items = transcript
		.filter((t) => t.kind !== "note")
		.slice(-MAX_TRANSCRIPT_ITEMS)
		.map((t): TranscriptItem => (t.kind === "tool" && t.status === "running" ? { ...t, status: "error", summary: `${t.summary} (interrupted)` } : t));

	const build = (): StoredChat => ({ version: 1, uri, savedAt: new Date().toISOString(), messages: msgs, transcript: items });
	let stored = build();
	while (JSON.stringify(stored).length > MAX_BYTES) {
		// Drop the oldest whole turn so every tool call keeps its result.
		const next = msgs.findIndex((m, i) => i > 0 && isTurnStart(m));
		if (next > 0) {
			msgs = msgs.slice(next);
			if (items.length > 20) items = items.slice(Math.ceil(items.length / 10));
		} else if (items.length > 20) {
			items = items.slice(Math.floor(items.length / 2));
		} else {
			break;
		}
		stored = build();
	}
	return stored;
}

/** Validates a stored chat (it may come from an older version or be corrupted). */
export function parseStoredChat(text: string, uri: string): StoredChat | undefined {
	try {
		const data = JSON.parse(text);
		if (data?.version !== 1 || data.uri !== uri || !Array.isArray(data.messages) || !Array.isArray(data.transcript)) return undefined;
		const messages = (data.messages as ChatMessage[]).filter(
			(m) => (m.role === "user" || m.role === "assistant") && Array.isArray(m.parts)
		);
		// A history must start with a user turn and must not end on unanswered tool calls.
		const first = messages.findIndex(isTurnStart);
		let trimmed = first >= 0 ? messages.slice(first) : [];
		const last = trimmed[trimmed.length - 1];
		if (last?.role === "assistant" && last.parts.some((p) => p.type === "toolCall")) trimmed = trimmed.slice(0, -1);
		return { ...data, messages: trimmed };
	} catch {
		return undefined;
	}
}

export function storageKey(uri: string): string {
	return `${sha256(uri).slice(0, 32)}.json`;
}

/** One JSON file per diagram in the extension's (workspace) storage; never inside the repository. */
export class ChatStore {
	private queue = new Map<string, Promise<void>>();

	constructor(private readonly dir: vscode.Uri | undefined) {}

	private file(uri: string): vscode.Uri | undefined {
		return this.dir && vscode.Uri.joinPath(this.dir, storageKey(uri));
	}

	public async load(uri: string): Promise<StoredChat | undefined> {
		const file = this.file(uri);
		if (!file) return undefined;
		await this.queue.get(uri);
		try {
			return parseStoredChat(Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"), uri);
		} catch {
			return undefined;
		}
	}

	public save(uri: string, messages: readonly ChatMessage[], transcript: readonly TranscriptItem[]): Promise<void> {
		const empty = messages.length === 0 && !transcript.some((t) => t.kind !== "note");
		return this.enqueue(uri, async (file) => {
			if (empty) {
				await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
				return;
			}
			await vscode.workspace.fs.createDirectory(this.dir!);
			const text = JSON.stringify(prepareForStorage(uri, messages, transcript));
			await vscode.workspace.fs.writeFile(file, Buffer.from(text, "utf8"));
		});
	}

	public delete(uri: string): Promise<void> {
		return this.enqueue(uri, (file) => Promise.resolve(vscode.workspace.fs.delete(file)).then(undefined, () => undefined));
	}

	private enqueue(uri: string, work: (file: vscode.Uri) => Promise<void>): Promise<void> {
		const file = this.file(uri);
		if (!file) return Promise.resolve();
		const next = (this.queue.get(uri) ?? Promise.resolve()).then(() => work(file)).catch((e) => console.error("Draw.AI: saving chat failed", e));
		this.queue.set(uri, next);
		return next;
	}
}
