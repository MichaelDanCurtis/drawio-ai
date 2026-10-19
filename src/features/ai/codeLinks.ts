import { sha256 } from "js-sha256";

// Pure helpers for "live" code links: a link stores a fingerprint of the code it
// points to, so the diagram can tell when that code changed, moved or vanished.

export const LINK_PREFIX = "hedietLinkedDataV1_";

export interface LinkPos {
	line: number;
	col: number;
}

export interface CodeLink {
	/** Relative to the diagram file (as written by the Code Link feature). */
	path?: string;
	symbol?: string;
	start?: LinkPos;
	end?: LinkPos;
	/** Fingerprint of the linked lines when the link was made. */
	hash?: string;
	/** The first linked line (trimmed), used to find the code again after it moved. */
	anchor?: string;
}

export type LinkStatus = "ok" | "moved" | "changed" | "missing-code" | "out-of-range" | "missing-file" | "unverified";

export interface LinkCheck {
	status: LinkStatus;
	message: string;
	/** Where the code is now, when it could be found again. */
	newRange?: { start: LinkPos; end: LinkPos };
}

export function parseLink(data: Record<string, string> | undefined): CodeLink | undefined {
	if (!data) return undefined;
	const get = (k: string) => data[LINK_PREFIX + k];
	const num = (k: string) => {
		const v = get(`${k}_x-num`);
		return v === undefined || v === "" || isNaN(Number(v)) ? undefined : Number(v);
	};
	const path = get("path");
	const symbol = get("symbol");
	if (!path && !symbol) return undefined;
	const sl = num("start_line");
	const el = num("end_line");
	return {
		path,
		symbol,
		start: sl !== undefined ? { line: sl, col: num("start_col") ?? 0 } : undefined,
		end: el !== undefined ? { line: el, col: num("end_col") ?? 0 } : undefined,
		hash: get("hash"),
		anchor: get("anchor"),
	};
}

/** Data attributes for a range link (0-based lines), including its fingerprint. */
export function linkData(path: string, lines: readonly string[], startLine: number, endLine: number): Record<string, string> {
	const last = Math.min(endLine, lines.length - 1);
	return {
		[`${LINK_PREFIX}path`]: path,
		[`${LINK_PREFIX}start_line_x-num`]: String(startLine),
		[`${LINK_PREFIX}start_col_x-num`]: "0",
		[`${LINK_PREFIX}end_line_x-num`]: String(last),
		[`${LINK_PREFIX}end_col_x-num`]: String(lines[last]?.length ?? 0),
		...fingerprintData(lines, startLine, last),
	};
}

export function fingerprintData(lines: readonly string[], startLine: number, endLine: number): Record<string, string> {
	return {
		[`${LINK_PREFIX}hash`]: fingerprint(lines.slice(startLine, endLine + 1)),
		[`${LINK_PREFIX}anchor`]: anchorOf(lines[startLine] ?? ""),
	};
}

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** Whitespace-insensitive at line ends and around the block, so reformatting a blank line does not flag a change. */
export function fingerprint(lines: readonly string[]): string {
	const norm = lines.map((l) => l.trimEnd());
	while (norm.length && !norm[0]) norm.shift();
	while (norm.length && !norm[norm.length - 1]) norm.pop();
	return sha256(norm.join("\n")).slice(0, 16);
}

export function anchorOf(line: string): string {
	return line.trim().slice(0, 200);
}

export function checkLink(link: CodeLink, fileText: string | undefined): LinkCheck {
	if (fileText === undefined) return { status: "missing-file", message: `${link.path} no longer exists.` };
	if (!link.start || !link.end) {
		return link.symbol
			? { status: "unverified", message: `Linked to symbol ${link.symbol}.` }
			: { status: "ok", message: `Linked to ${link.path}.` };
	}
	const lines = splitLines(fileText);
	const span = Math.max(0, link.end.line - link.start.line);
	const where = (l: number) => `${link.path}:${l + 1}`;
	const inRange = link.end.line < lines.length;
	const hashAt = (start: number) => fingerprint(lines.slice(start, start + span + 1));
	const range = (start: number) => ({
		start: { line: start, col: 0 },
		end: { line: start + span, col: lines[start + span]?.length ?? 0 },
	});

	if (!link.hash && !link.anchor) {
		return inRange
			? { status: "ok", message: `Linked to ${where(link.start.line)}.` }
			: { status: "out-of-range", message: `${where(link.start.line)} is past the end of the file (${lines.length} lines).` };
	}
	if (inRange && (link.hash ? hashAt(link.start.line) === link.hash : anchorOf(lines[link.start.line]) === link.anchor)) {
		return { status: "ok", message: `Linked to ${where(link.start.line)}; unchanged.` };
	}

	// Look for the code elsewhere: first by exact content, then by its first line.
	const candidates: number[] = [];
	if (link.anchor) {
		lines.forEach((l, i) => {
			if (anchorOf(l) === link.anchor) candidates.push(i);
		});
		candidates.sort((a, b) => Math.abs(a - link.start!.line) - Math.abs(b - link.start!.line));
	}
	if (link.hash) {
		const exact = candidates.find((c) => hashAt(c) === link.hash);
		if (exact !== undefined) {
			return { status: "moved", message: `The code moved from line ${link.start.line + 1} to ${exact + 1}; it is unchanged.`, newRange: range(exact) };
		}
	}
	const at = candidates[0];
	if (at !== undefined) {
		return {
			status: "changed",
			message: `The linked code (${where(at)}${at !== link.start.line ? `, was line ${link.start.line + 1}` : ""}) changed since it was linked.`,
			newRange: range(at),
		};
	}
	if (link.anchor) {
		return { status: "missing-code", message: `"${link.anchor.slice(0, 60)}" is no longer in ${link.path}; it was renamed or removed.` };
	}
	return inRange
		? { status: "changed", message: `The linked code at ${where(link.start.line)} changed since it was linked.`, newRange: range(link.start.line) }
		: { status: "out-of-range", message: `${where(link.start.line)} is past the end of the file (${lines.length} lines).` };
}

export const PROBLEM_STATUSES: ReadonlySet<LinkStatus> = new Set(["moved", "changed", "missing-code", "out-of-range", "missing-file"]);

export function badgeKind(status: LinkStatus): "error" | "warning" | "info" | undefined {
	switch (status) {
		case "missing-file":
		case "missing-code":
		case "out-of-range":
			return "error";
		case "changed":
			return "warning";
		case "moved":
			return "info";
		default:
			return undefined;
	}
}
