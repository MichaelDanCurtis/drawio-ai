/**
 * A light HCL scanner for Terraform: finds the top-level `resource`, `data` and
 * `module` blocks of each file and the references in their bodies
 * (aws_instance.web.id, data.x.y, module.z...). Not a full HCL parser: it masks
 * comments, string contents and heredocs (keeping `${…}` interpolations) so
 * braces can be matched and references found reliably.
 */
import * as path from "path";
import { IacGroup, IacResource, IngressRule, keepAttr, lineAt, markOpenIngress, rulesFromPortSpecs, terraformCloud } from "./model";

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

/** Nested blocks `name { … }` directly in a body (not deeper), with their text. */
export function nestedBlocks(body: string, maskedBody: string, name: string): { text: string; masked: string }[] {
	const out: { text: string; masked: string }[] = [];
	const re = new RegExp(`(^|\\n)[ \\t]*${name}[ \\t]*\\{`, "g");
	for (const m of maskedBody.matchAll(re)) {
		let depth = 0;
		for (let i = 0; i < m.index!; i++) {
			const c = maskedBody[i];
			if (c === "{" || c === "[" || c === "(") depth++;
			else if (c === "}" || c === "]" || c === ")") depth--;
		}
		if (depth !== 0) continue;
		const open = m.index! + m[0].length - 1;
		const close = matchBracket(maskedBody, open);
		if (close > open) out.push({ text: body.slice(open + 1, close), masked: maskedBody.slice(open + 1, close) });
	}
	return out;
}

const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `key = "value"` in a block's text. */
const hclString = (text: string, key: string): string | undefined => new RegExp(`(?:^|\\n)[ \\t]*${esc(key)}[ \\t]*=[ \\t]*"([^"\\n]*)"`).exec(text)?.[1];
/** `key = 22` or `key = "22"`. */
const hclNumber = (text: string, key: string): number | undefined => {
	const m = new RegExp(`(?:^|\\n)[ \\t]*${esc(key)}[ \\t]*=[ \\t]*"?(-?\\d+)"?[ \\t]*(?:\\n|$|#|//)`).exec(text);
	return m ? Number(m[1]) : undefined;
};
const hclBool = (text: string, key: string): boolean | undefined => {
	const m = new RegExp(`(?:^|\\n)[ \\t]*${esc(key)}[ \\t]*=[ \\t]*(true|false)\\b`).exec(text);
	return m ? m[1] === "true" : undefined;
};
/** The quoted strings of `key = ["a", "b"]` (also over several lines). */
const hclList = (text: string, key: string): string[] => {
	const m = new RegExp(`(?:^|\\n)[ \\t]*${esc(key)}[ \\t]*=[ \\t]*\\[([^\\]]*)\\]`).exec(text);
	return m ? [...m[1].matchAll(/"([^"\n]*)"/g)].map((x) => x[1]) : [];
};
const PUBLIC_MEMBER = /^(allUsers|allAuthenticatedUsers)$/;

/** Settings read from nested blocks that matter for health checks (open rules, public members, endpoints). */
export function terraformDerived(type: string, body: string, maskedBody: string, attrs: Record<string, string>): void {
	const rules: IngressRule[] = [];
	const awsRule = (t: string): IngressRule => {
		const protocol = hclString(t, "protocol") ?? hclString(t, "ip_protocol");
		const from = hclNumber(t, "from_port");
		const to = hclNumber(t, "to_port");
		const sources = [...hclList(t, "cidr_blocks"), ...hclList(t, "ipv6_cidr_blocks"), hclString(t, "cidr_ipv4"), hclString(t, "cidr_ipv6")].filter((x): x is string => !!x);
		const all = /^(-1|all)$/i.test(protocol ?? "");
		return { protocol, from, to, literal: all || (from !== undefined && to !== undefined), sources };
	};
	const azureRule = (t: string): IngressRule[] => {
		if (!/^inbound$/i.test(hclString(t, "direction") ?? "") || !/^allow$/i.test(hclString(t, "access") ?? "")) return [];
		const sources = [hclString(t, "source_address_prefix"), ...hclList(t, "source_address_prefixes")].filter((x): x is string => !!x);
		const ports = [hclString(t, "destination_port_range"), ...hclList(t, "destination_port_ranges")].filter((x): x is string => !!x);
		const literal = /destination_port_ranges?\s*=\s*("|\[\s*")/.test(t) || !/destination_port_range/.test(t);
		return literal ? rulesFromPortSpecs(hclString(t, "protocol"), ports, sources) : [{ protocol: hclString(t, "protocol"), literal: false, sources }];
	};
	switch (type) {
		case "aws_security_group":
			for (const b of nestedBlocks(body, maskedBody, "ingress")) rules.push(awsRule(b.text));
			break;
		case "aws_security_group_rule":
			if (hclString(body, "type") === "ingress") rules.push(awsRule(body));
			break;
		case "aws_vpc_security_group_ingress_rule":
			rules.push(awsRule(body));
			break;
		case "google_compute_firewall":
			if (!/^egress$/i.test(hclString(body, "direction") ?? "") && hclBool(body, "disabled") !== true) {
				const sources = hclList(body, "source_ranges");
				for (const b of nestedBlocks(body, maskedBody, "allow")) {
					const ports = hclList(b.text, "ports");
					rules.push(...(/ports\s*=/.test(b.masked) && !ports.length ? [{ protocol: hclString(b.text, "protocol"), literal: false, sources }] : rulesFromPortSpecs(hclString(b.text, "protocol"), ports, sources)));
				}
			}
			break;
		case "azurerm_network_security_group":
			for (const b of nestedBlocks(body, maskedBody, "security_rule")) rules.push(...azureRule(b.text));
			break;
		case "azurerm_network_security_rule":
			rules.push(...azureRule(body));
			break;
		case "google_storage_bucket_iam_member":
		case "google_storage_bucket_iam_binding": {
			const members = [hclString(body, "member"), ...hclList(body, "members")].filter((m): m is string => !!m && PUBLIC_MEMBER.test(m));
			if (members.length) {
				attrs.publicMembers = [...new Set(members)].join(", ");
				const role = hclString(body, "role");
				if (role) attrs.role = role;
			}
			break;
		}
		case "google_sql_database_instance": {
			const nets = [...body.matchAll(/authorized_networks\s*\{([^}]*)\}/g)].flatMap((m) => [hclString(m[1], "value")].filter((v): v is string => !!v));
			const world = nets.filter((v) => /^0\.0\.0\.0\/0$/.test(v));
			if (world.length) attrs.authorizedNetworks = world.join(", ");
			const ipv4 = hclBool(body, "ipv4_enabled");
			if (ipv4 !== undefined) attrs.ipv4_enabled = String(ipv4);
			break;
		}
		case "google_container_cluster":
			attrs.privateEndpoint = String(/enable_private_endpoint\s*=\s*true\b/.test(maskedBody));
			attrs.masterAuthorizedNetworks = String(/(^|\n)\s*master_authorized_networks_config\s*\{/.test(maskedBody));
			break;
		case "azurerm_kubernetes_cluster":
			attrs.privateCluster = String(/private_cluster_enabled\s*=\s*true\b/.test(maskedBody));
			attrs.authorizedIpRanges = String(/authorized_ip_ranges\s*=\s*\[\s*"/.test(body));
			break;
		case "aws_eks_cluster": {
			const vpc = nestedBlocks(body, maskedBody, "vpc_config")[0];
			if (vpc) {
				const pub = hclBool(vpc.text, "endpoint_public_access");
				attrs.endpointPublicAccess = String(pub !== false);
				const cidrs = hclList(vpc.text, "public_access_cidrs");
				attrs.publicAccessCidrs = /public_access_cidrs\s*=/.test(vpc.masked) ? (cidrs.length ? cidrs.join(", ") : "(expression)") : "0.0.0.0/0 (default)";
			}
			break;
		}
	}
	markOpenIngress(attrs, rules);
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
				if (b.kind === "resource") terraformDerived(b.type, body, mbody, attrs);
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
