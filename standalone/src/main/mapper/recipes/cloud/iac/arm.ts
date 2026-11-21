/**
 * Azure Resource Manager JSON templates: `resources` (array, nested child
 * resources, or the symbolic-name object of languageVersion 2.0), edges from
 * `dependsOn` and from resourceId(...) / reference(...) in properties, nested
 * deployments with a relative templateLink as module links.
 */
import * as path from "path";
import { IacGroup, IacResource, keepAttr, lineAt } from "./model";

export function isArmTemplate(doc: any): boolean {
	return !!doc && typeof doc === "object" && /deploymentTemplate\.json/i.test(String(doc.$schema ?? "")) && (Array.isArray(doc.resources) || (doc.resources && typeof doc.resources === "object"));
}

/** "[parameters('storageName')]" → "storageName"; other expressions shortened. */
export function armName(expr: unknown): string {
	const s = String(expr ?? "");
	if (!/^\[.*\]$/s.test(s)) return s;
	return s
		.slice(1, -1)
		.replace(/(parameters|variables)\('([^']+)'\)/g, "$2")
		.replace(/\s+/g, " ")
		.slice(0, 60);
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

interface Flat {
	key: string;
	type: string;
	nameExpr: string;
	symbol?: string;
	res: any;
	parentKey?: string;
}

/** The top-level arguments of each `fn(...)` call in an ARM expression (quotes and nesting respected). */
export function callArgs(text: string, fn: string): string[][] {
	const out: string[][] = [];
	const re = new RegExp(`\\b${fn}\\(`, "gi");
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const args: string[] = [];
		let depth = 0;
		let quoted = false;
		let cur = "";
		let i = m.index + m[0].length;
		for (; i < text.length; i++) {
			const c = text[i];
			if (quoted) {
				cur += c;
				if (c === "'") quoted = text[i + 1] === "'" ? (cur += text[++i], true) : false;
				continue;
			}
			if (c === "'") quoted = true;
			if (c === "(") depth++;
			if (c === ")" && depth-- === 0) break;
			if (c === "," && depth === 0) {
				args.push(cur.trim());
				cur = "";
				continue;
			}
			cur += c;
		}
		args.push(cur.trim());
		out.push(args);
		re.lastIndex = i;
	}
	return out;
}

/** resourceId('Microsoft.X/y', name1, name2) → { type, last name argument }. */
function parseResourceIds(text: string): { type: string; name: string }[] {
	const out: { type: string; name: string }[] = [];
	for (const args of callArgs(text, "resourceId")) {
		const ti = args.findIndex((a) => /^'[A-Za-z]+\.[A-Za-z]+\//.test(a));
		if (ti < 0) continue;
		const names = args.slice(ti + 1);
		out.push({ type: args[ti].replace(/'/g, ""), name: names[names.length - 1] ?? "" });
	}
	return out;
}

export function parseArm(file: string, text: string, doc: any): { group: IacGroup; resources: IacResource[] } {
	const group = `arm:${file}`;
	const flat: Flat[] = [];
	const visit = (list: any, parent?: Flat) => {
		const entries: [string | undefined, any][] = Array.isArray(list) ? list.map((r) => [undefined, r]) : Object.entries(list ?? {});
		entries.forEach(([symbol, r], i) => {
			if (!r || typeof r !== "object" || !r.type) return;
			const childType = String(r.type);
			const type = parent && !childType.includes("/") ? `${parent.type}/${childType}` : childType;
			const nameExpr = parent && !String(r.name ?? "").includes("/") ? `${parent.nameExpr}/${r.name}` : String(r.name ?? "");
			const f: Flat = { key: symbol ?? `${parent ? parent.key + "." : ""}r${i}`, type, nameExpr, symbol, res: r, parentKey: parent?.key };
			flat.push(f);
			if (r.resources) visit(r.resources, f);
		});
	};
	visit(doc.resources);
	const byResourceId = (id: { type: string; name: string }): Flat | undefined => {
		const sameType = flat.filter((f) => norm(f.type) === norm(id.type));
		const name = norm(id.name.replace(/^'|'$/g, ""));
		const exact = sameType.find((f) => norm(f.nameExpr).endsWith(name) || norm(f.nameExpr).includes(norm(id.name)));
		return exact ?? (sameType.length === 1 ? sameType[0] : undefined);
	};
	// Resolve a dependsOn entry or a resourceId(...) reference to a resource.
	const resolve = (dep: string): Flat | undefined => {
		const d = dep.trim();
		const bySymbol = flat.find((f) => f.symbol === d);
		if (bySymbol) return bySymbol;
		for (const id of parseResourceIds(d)) {
			const t = byResourceId(id);
			if (t) return t;
		}
		// "Microsoft.Network/virtualNetworks/vnet1" or a plain name.
		const m = /^(Microsoft\.[A-Za-z]+\/[A-Za-z/]+?)\/([^/]+)$/.exec(d);
		if (m) return flat.find((f) => norm(f.type) === norm(m[1]) && norm(armName(f.nameExpr)) === norm(m[2]));
		return flat.find((f) => norm(armName(f.nameExpr)) === norm(armName(d)) || norm(f.nameExpr) === norm(d));
	};
	// Lines: the n-th occurrence of each "type" value, in order.
	const typeSeen = new Map<string, number>();
	const lineOf = (f: Flat): number => {
		const raw = String(f.res.type);
		const nth = (typeSeen.get(raw) ?? 0) + 1;
		typeSeen.set(raw, nth);
		const re = new RegExp(`"type"\\s*:\\s*"${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
		let m: RegExpExecArray | null = null;
		for (let k = 0; k < nth; k++) m = re.exec(text);
		return m ? lineAt(text, m.index) : 1;
	};
	const resources: IacResource[] = [];
	for (const f of flat) {
		const refs = new Set<string>();
		for (const dep of [].concat(f.res.dependsOn ?? [])) {
			const t = resolve(String(dep));
			if (t && t !== f) refs.add(t.key);
		}
		const props = JSON.stringify(f.res.properties ?? {});
		for (const id of parseResourceIds(props)) {
			const t = byResourceId(id);
			if (t && t !== f) refs.add(t.key);
		}
		for (const m of props.matchAll(/reference\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
			const t = flat.find((x) => x.symbol === m[1]);
			if (t && t !== f) refs.add(t.key);
		}
		if (f.parentKey) refs.add(f.parentKey);
		const attrs: Record<string, string> = {};
		if (f.res.apiVersion) attrs.apiVersion = String(f.res.apiVersion);
		keepAttr(attrs, "location", typeof f.res.location === "string" && !f.res.location.startsWith("[") ? f.res.location : undefined);
		keepAttr(attrs, "kind", f.res.kind);
		if (f.res.sku && typeof f.res.sku === "object") keepAttr(attrs, "sku", f.res.sku.name);
		for (const k of ["publicNetworkAccess", "allowBlobPublicAccess", "supportsHttpsTrafficOnly", "minimumTlsVersion", "addressPrefix"]) keepAttr(attrs, k, f.res.properties?.[k]);
		if (/"sourceAddressPrefix":"(\*|Internet|0\.0\.0\.0\/0)"/.test(props)) attrs.openToWorld = "true";
		if (f.res.condition !== undefined) attrs.condition = String(f.res.condition).slice(0, 60);
		if (f.res.copy) attrs.copy = String(f.res.copy.name ?? "loop");
		const r: IacResource = {
			id: `${group}::${f.key}`,
			address: f.key,
			type: f.type,
			name: f.symbol ?? armName(f.nameExpr),
			kind: "resource",
			cloud: "azure",
			tool: "arm",
			group,
			file,
			line: lineOf(f),
			refs: [...refs],
			attrs,
		};
		if (/^Microsoft\.Resources\/deployments$/i.test(f.type)) {
			const link = f.res.properties?.templateLink;
			if (link?.relativePath) r.moduleTarget = `arm:${path.posix.normalize(path.posix.join(path.posix.dirname(file), String(link.relativePath)))}`;
			else if (link?.uri) r.moduleSource = String(link.uri).slice(0, 120);
		}
		resources.push(r);
	}
	return { group: { id: group, label: `ARM template · ${file}`, tool: "arm", path: file }, resources };
}
