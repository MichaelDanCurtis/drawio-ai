/**
 * Bicep files: `resource sym 'Type@version' = {…}` (also `existing`, conditions,
 * loops and nested child resources) and `module sym 'path' = {…}`. Edges come
 * from symbol references in the bodies (sym.id, sym.properties.x, dependsOn,
 * parent: sym).
 */
import * as path from "path";
import { matchBracket } from "./terraform";
import { IacGroup, IacResource, IngressRule, keepAttr, lineAt, markOpenIngress, rulesFromPortSpecs } from "./model";

/** Same length as `src`; comments and string contents blanked, `${…}` interpolations kept. */
export function maskBicep(src: string): string {
	const out = src.split("");
	const blank = (a: number, b: number) => {
		for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	type Frame = { kind: "code"; depth: number } | { kind: "str" } | { kind: "multi" };
	const stack: Frame[] = [{ kind: "code", depth: 0 }];
	let i = 0;
	while (i < src.length) {
		const top = stack[stack.length - 1];
		const c = src[i];
		if (top.kind === "code") {
			if (c === "/" && src[i + 1] === "/") {
				const e = src.indexOf("\n", i);
				const end = e < 0 ? src.length : e;
				blank(i, end);
				i = end;
			} else if (c === "/" && src[i + 1] === "*") {
				const e = src.indexOf("*/", i + 2);
				const end = e < 0 ? src.length : e + 2;
				blank(i, end);
				i = end;
			} else if (src.startsWith("'''", i)) {
				stack.push({ kind: "multi" });
				i += 3;
			} else if (c === "'") {
				stack.push({ kind: "str" });
				i++;
			} else {
				if (c === "{") top.depth++;
				else if (c === "}") {
					if (top.depth === 0 && stack.length > 1) {
						out[i] = " ";
						stack.pop();
						i++;
						continue;
					}
					top.depth--;
				}
				i++;
			}
			continue;
		}
		if (top.kind === "multi") {
			if (src.startsWith("'''", i)) {
				stack.pop();
				i += 3;
			} else {
				blank(i, i + 1);
				i++;
			}
			continue;
		}
		// Single-quoted string with escapes and interpolation.
		if (c === "\\") {
			blank(i, i + 2);
			i += 2;
		} else if (c === "'") {
			stack.pop();
			i++;
		} else if (c === "$" && src[i + 1] === "{") {
			blank(i, i + 2);
			stack.push({ kind: "code", depth: 0 });
			i += 2;
		} else if (c === "\n") {
			stack.pop();
			i++;
		} else {
			blank(i, i + 1);
			i++;
		}
	}
	return out.join("");
}

const DECL = /(^|\n)([ \t]*)(resource|module)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+'([^'\n]*)'([ \t]+existing)?[ \t]*=/g;

interface Decl {
	kind: "resource" | "module";
	symbol: string;
	typeRaw: string;
	existing: boolean;
	start: number;
	bodyStart: number;
	bodyEnd: number;
}

/** Splits 'Microsoft.Storage/storageAccounts@2023-01-01' into type and API version. */
export function bicepType(raw: string): { type: string; apiVersion?: string } {
	const [type, apiVersion] = raw.split("@");
	return { type, apiVersion };
}

/** Inbound Allow rules in a Bicep body (NSG securityRules), from literal values; masked: same text with strings blanked. */
export function bicepIngress(text: string, masked: string): IngressRule[] {
	const out: IngressRule[] = [];
	const seen = new Set<number>();
	for (const m of masked.matchAll(/\bdirection\s*:/g)) {
		// The object that holds this setting.
		let depth = 0;
		let open = -1;
		for (let i = m.index! - 1; i >= 0; i--) {
			const c = masked[i];
			if (c === "}") depth++;
			else if (c === "{") {
				if (depth === 0) {
					open = i;
					break;
				}
				depth--;
			}
		}
		if (open < 0 || seen.has(open)) continue;
		seen.add(open);
		const close = matchBracket(masked, open);
		const obj = text.slice(open + 1, close < 0 ? text.length : close);
		const str = (k: string) => new RegExp(`\\b${k}\\s*:\\s*'([^'\\n]*)'`).exec(obj)?.[1];
		const list = (k: string) => {
			const l = new RegExp(`\\b${k}\\s*:\\s*\\[([^\\]]*)\\]`).exec(obj);
			return l ? [...l[1].matchAll(/'([^'\n]*)'/g)].map((x) => x[1]) : [];
		};
		if (!/^inbound$/i.test(str("direction") ?? "") || !/^allow$/i.test(str("access") ?? "")) continue;
		const sources = [str("sourceAddressPrefix"), ...list("sourceAddressPrefixes")].filter((x): x is string => !!x);
		const ports = [str("destinationPortRange"), ...list("destinationPortRanges")].filter((x): x is string => !!x);
		const literal = /destinationPortRanges?\s*:\s*('|\[\s*')/.test(obj) || !/destinationPortRange/.test(obj);
		out.push(...(literal ? rulesFromPortSpecs(str("protocol"), ports, sources) : [{ protocol: str("protocol"), literal: false, sources }]));
	}
	return out;
}

export function parseBicep(file: string, text: string): { group: IacGroup; resources: IacResource[] } {
	const masked = maskBicep(text);
	const group = `bicep:${file}`;
	const decls: Decl[] = [];
	DECL.lastIndex = 0;
	for (let m = DECL.exec(masked); m; m = DECL.exec(masked)) {
		const start = m.index + m[1].length + m[2].length;
		// The type / path string is masked: read it from the original at the same place.
		const orig = new RegExp(DECL.source, "y");
		orig.lastIndex = m.index;
		const o = orig.exec(text);
		if (!o) continue;
		let open = m.index + m[0].length;
		while (open < masked.length && masked[open] !== "{" && masked[open] !== "[") open++;
		const close = open < masked.length ? matchBracket(masked, open) : -1;
		decls.push({ kind: o[3] as Decl["kind"], symbol: o[4], typeRaw: o[5], existing: !!o[6], start, bodyStart: open + 1, bodyEnd: close < 0 ? masked.length : close });
		DECL.lastIndex = m.index + m[0].length;
	}
	const symbols = new Set(decls.map((d) => d.symbol));
	const resources: IacResource[] = [];
	for (const d of decls) {
		// Nested child resources: the innermost declaration whose body holds this one.
		const parent = decls.filter((p) => p !== d && p.bodyStart <= d.start && d.start < p.bodyEnd).sort((a, b) => b.bodyStart - a.bodyStart)[0];
		let { type, apiVersion } = d.kind === "resource" ? bicepType(d.typeRaw) : { type: "module", apiVersion: undefined as string | undefined };
		if (d.kind === "resource" && parent && !type.includes("/") && parent.kind === "resource") type = `${bicepType(parent.typeRaw).type}/${type}`;
		const mbody = masked.slice(d.bodyStart, d.bodyEnd);
		const body = text.slice(d.bodyStart, d.bodyEnd);
		// Leave out nested declarations' bodies: they get their own references.
		let own = mbody;
		let ownText = body;
		for (const n of decls) {
			if (n === d || n.start <= d.bodyStart || n.bodyEnd > d.bodyEnd) continue;
			const a = n.start - d.bodyStart;
			const b = Math.min(own.length, n.bodyEnd + 1 - d.bodyStart);
			own = own.slice(0, a) + own.slice(a, b).replace(/[^\n]/g, " ") + own.slice(b);
			ownText = ownText.slice(0, a) + ownText.slice(a, b).replace(/[^\n]/g, " ") + ownText.slice(b);
		}
		const refs = new Set<string>();
		for (const m of own.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*:(?!:))/g)) if (symbols.has(m[1]) && m[1] !== d.symbol) refs.add(m[1]);
		if (parent && parent.kind === "resource") refs.add(parent.symbol);
		const attrs: Record<string, string> = {};
		if (apiVersion) attrs.apiVersion = apiVersion;
		if (d.existing) attrs.existing = "true";
		if (masked[d.bodyStart - 1] === "[" && /^\s*for\b/.test(mbody)) attrs.for_each = "for loop";
		let depth = 0;
		let ls = 0;
		for (let i = 0; i <= own.length; i++) {
			const ch = own[i];
			if (i === own.length || ch === "\n") {
				// The resource's own settings and those of its `properties`.
				if (depth <= 1) {
					const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(ownText.slice(ls, i));
					if (kv && /^('[^'$]*'|true|false|-?\d+)$/.test(kv[2])) keepAttr(attrs, kv[1], kv[2].replace(/^'(.*)'$/, "$1"));
				}
				ls = i + 1;
			} else if (ch === "{" || ch === "[" || ch === "(") depth++;
			else if (ch === "}" || ch === "]" || ch === ")") depth--;
		}
		if (/networkSecurityGroups(\/securityRules)?$/i.test(type)) markOpenIngress(attrs, bicepIngress(ownText, own));
		if (/Microsoft\.ContainerService\/managedClusters$/i.test(type)) {
			attrs.privateCluster = String(/enablePrivateCluster\s*:\s*true\b/.test(own));
			attrs.authorizedIpRanges = String(/authorizedIPRanges\s*:\s*\[\s*'/.test(ownText));
		}
		if (/publicNetworkAccess\s*:\s*'Enabled'/.test(body)) attrs.publicNetworkAccess = "Enabled";
		if (/allowBlobPublicAccess\s*:\s*true/.test(body)) attrs.allowBlobPublicAccess = "true";
		const nameMatch = /(?:^|\n)\s*name\s*:\s*'([^'\n]*)'/.exec(ownText);
		const r: IacResource = {
			id: `${group}::${d.symbol}`,
			address: d.symbol,
			type,
			name: d.symbol,
			kind: d.kind,
			cloud: d.kind === "module" ? "other" : "azure",
			tool: "bicep",
			group,
			file,
			line: lineAt(text, d.start),
			refs: [...refs],
			attrs: { ...attrs, ...(nameMatch && !nameMatch[1].includes("${") ? { name: nameMatch[1] } : {}) },
		};
		if (d.kind === "module") {
			const src = d.typeRaw;
			if (/^(br|ts)[:/]/.test(src)) r.moduleSource = src;
			else r.moduleTarget = `bicep:${path.posix.normalize(path.posix.join(path.posix.dirname(file), src))}`;
		}
		resources.push(r);
	}
	return { group: { id: group, label: `Bicep · ${file}`, tool: "bicep", path: file }, resources };
}
