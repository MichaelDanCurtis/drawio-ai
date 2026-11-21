/**
 * A light HCL scanner for Terraform: finds the top-level `resource`, `data` and
 * `module` blocks of each file and the references in their bodies
 * (aws_instance.web.id, data.x.y, module.z...). Not a full HCL parser: it masks
 * comments, string contents and heredocs (keeping `${…}` interpolations) so
 * braces can be matched and references found reliably.
 */
import * as path from "path";
import { IacGroup, IacResource, keepAttr, lineAt, terraformCloud } from "./model";

/**
 * Same length as `src`; comments, string contents and heredoc bodies become
 * spaces (newlines kept), interpolations inside them stay as code.
 */
export function maskHcl(src: string): string {
	const out = src.split("");
	const blank = (a: number, b: number) => {
		for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	type Frame = { kind: "code"; depth: number } | { kind: "str" } | { kind: "heredoc"; marker: string };
	const stack: Frame[] = [{ kind: "code", depth: 0 }];
	let i = 0;
	while (i < src.length) {
		const top = stack[stack.length - 1];
		const c = src[i];
		if (top.kind === "code") {
			if (c === "#" || (c === "/" && src[i + 1] === "/")) {
				const e = src.indexOf("\n", i);
				const end = e < 0 ? src.length : e;
				blank(i, end);
				i = end;
				continue;
			}
			if (c === "/" && src[i + 1] === "*") {
				const e = src.indexOf("*/", i + 2);
				const end = e < 0 ? src.length : e + 2;
				blank(i, end);
				i = end;
				continue;
			}
			if (c === '"') {
				stack.push({ kind: "str" });
				i++;
				continue;
			}
			if (c === "<" && src[i + 1] === "<") {
				const m = /^<<-?[ \t]*"?([A-Za-z_][A-Za-z0-9_]*)"?[ \t]*\r?\n/.exec(src.slice(i, i + 120));
				if (m) {
					stack.push({ kind: "heredoc", marker: m[1] });
					i += m[0].length;
					continue;
				}
			}
			if (c === "{") top.depth++;
			else if (c === "}") {
				if (top.depth === 0 && stack.length > 1) {
					// End of an interpolation.
					out[i] = " ";
					stack.pop();
					i++;
					continue;
				}
				top.depth--;
			}
			i++;
			continue;
		}
		if (top.kind === "heredoc" && (i === 0 || src[i - 1] === "\n")) {
			const e = src.indexOf("\n", i);
			const line = src.slice(i, e < 0 ? src.length : e);
			if (line.trim() === top.marker) {
				stack.pop();
				i = e < 0 ? src.length : e;
				continue;
			}
		}
		if (c === "\\" && top.kind === "str") {
			blank(i, i + 2);
			i += 2;
			continue;
		}
		if (top.kind === "str" && c === '"') {
			stack.pop();
			i++;
			continue;
		}
		if (top.kind === "str" && c === "\n") {
			// Unterminated string: recover at the end of the line.
			stack.pop();
			i++;
			continue;
		}
		if ((c === "$" || c === "%") && src[i + 1] === "{") {
			if (src[i - 1] === c) {
				// $${ is an escaped literal.
				blank(i, i + 2);
				i += 2;
				continue;
			}
			blank(i, i + 2);
			stack.push({ kind: "code", depth: 0 });
			i += 2;
			continue;
		}
		blank(i, i + 1);
		i++;
	}
	return out.join("");
}

/** Index of the bracket closing the one at `open` in masked text, or -1. */
export function matchBracket(masked: string, open: number): number {
	const o = masked[open];
	const c = o === "{" ? "}" : o === "[" ? "]" : ")";
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === o) depth++;
		else if (masked[i] === c && --depth === 0) return i;
	}
	return -1;
}

export interface TfBlock {
	kind: "resource" | "data" | "module";
	type: string;
	name: string;
	start: number;
	bodyStart: number;
	bodyEnd: number;
}

const HEADER = /^[ \t]*(resource|data|module)[ \t]+"([^"\n]*)"(?:[ \t]+"([^"\n]*)")?[ \t]*\{/gm;

/** The top-level resource / data / module blocks of one file. */
export function terraformBlocks(text: string, masked = maskHcl(text)): TfBlock[] {
	const blocks: TfBlock[] = [];
	// Depth at each line start, so only top-level headers count.
	let depth = 0;
	let pos = 0;
	HEADER.lastIndex = 0;
	for (let m = HEADER.exec(masked); m; m = HEADER.exec(masked)) {
		for (; pos < m.index; pos++) {
			if (masked[pos] === "{") depth++;
			else if (masked[pos] === "}") depth--;
		}
		if (depth !== 0) continue;
		// Labels come from the original (string contents are masked).
		const orig = new RegExp(HEADER.source, "my");
		orig.lastIndex = m.index;
		const o = orig.exec(text);
		if (!o) continue;
		const kind = o[1] as TfBlock["kind"];
		if ((kind === "module") !== (o[3] === undefined)) continue;
		const open = m.index + m[0].length - 1;
		const close = matchBracket(masked, open);
		if (close < 0) break;
		blocks.push({ kind, type: kind === "module" ? "module" : o[2], name: kind === "module" ? o[2] : o[3]!, start: m.index, bodyStart: open + 1, bodyEnd: close });
		// Skip the body.
		pos = close + 1;
		HEADER.lastIndex = close + 1;
	}
	return blocks;
}

const REF = /(?<![\w.$-])(data\.[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*|module\.[A-Za-z_][A-Za-z0-9_-]*|[a-z][a-z0-9]*_[A-Za-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*)/g;

/** Candidate references in a (masked) body: aws_x.y, data.t.n, module.m. Resolved later. */
export function terraformRefs(maskedBody: string): string[] {
	const out = new Set<string>();
	for (const m of maskedBody.matchAll(REF)) out.add(m[1]);
	return [...out];
}

/** Top-level `key = value` lines of a body (original text), for a few telling settings. */
function topLevelAttrs(body: string, maskedBody: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	let depth = 0;
	let lineStart = 0;
	for (let i = 0; i <= maskedBody.length; i++) {
		const ch = maskedBody[i];
		if (i === maskedBody.length || ch === "\n") {
			if (depth === 0) {
				const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(body.slice(lineStart, i));
				if (m && /^(count|for_each)$/.test(m[1])) attrs[m[1]] = m[2].slice(0, 60);
				// Literal values only (expressions say little without their inputs).
				else if (m && /^("[^"$]*"|true|false|-?\d+(\.\d+)?)$/.test(m[2])) keepAttr(attrs, m[1], m[2]);
			}
			lineStart = i + 1;
		} else if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") depth--;
	}
	return attrs;
}

export interface TfFile {
	rel: string;
	text: string;
}

/** Resources, data sources and module calls of Terraform files, one group per folder. */
export function parseTerraform(files: TfFile[]): { groups: IacGroup[]; resources: IacResource[] } {
	const byDir = new Map<string, TfFile[]>();
	for (const f of files) {
		const dir = path.posix.dirname(f.rel);
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(f);
	}
	const groups: IacGroup[] = [];
	const resources: IacResource[] = [];
	for (const [dir, list] of byDir) {
		const group = `tf:${dir}`;
		groups.push({ id: group, label: `Terraform · ${dir === "." ? "root module" : dir}`, tool: "terraform", path: dir });
		const local: IacResource[] = [];
		for (const f of list) {
			const masked = maskHcl(f.text);
			for (const b of terraformBlocks(f.text, masked)) {
				const body = f.text.slice(b.bodyStart, b.bodyEnd);
				const mbody = masked.slice(b.bodyStart, b.bodyEnd);
				const attrs = topLevelAttrs(body, mbody);
				if (/0\.0\.0\.0\/0|::\/0/.test(body) && /security|firewall|ingress|rule|sg/i.test(b.type + body)) attrs.openToWorld = "true";
				const address = b.kind === "module" ? `module.${b.name}` : b.kind === "data" ? `data.${b.type}.${b.name}` : `${b.type}.${b.name}`;
				const r: IacResource = {
					id: `${group}::${address}`,
					address,
					type: b.type,
					name: b.name,
					kind: b.kind,
					cloud: b.kind === "module" ? "other" : terraformCloud(b.type),
					tool: "terraform",
					group,
					file: f.rel,
					line: lineAt(f.text, b.start),
					refs: terraformRefs(mbody),
					attrs,
				};
				if (b.kind === "module") {
					const src = /(?:^|\n)\s*source\s*=\s*"([^"]+)"/.exec(body)?.[1];
					if (src) {
						r.moduleSource = src;
						if (/^\.\.?\//.test(src)) r.moduleTarget = `tf:${path.posix.normalize(path.posix.join(dir, src)).replace(/\/$/, "")}`;
					}
				}
				local.push(r);
			}
		}
		// Keep only references to blocks of this module (module.x.y → module.x).
		const known = new Set(local.map((r) => r.address));
		for (const r of local) {
			r.refs = [
				...new Set(
					r.refs
						.map((ref) => {
							if (known.has(ref)) return ref;
							if (ref.startsWith("module.")) return known.has(ref) ? ref : undefined;
							return undefined;
						})
						.filter((x): x is string => !!x && x !== r.address)
				),
			];
		}
		resources.push(...local);
	}
	return { groups, resources };
}
