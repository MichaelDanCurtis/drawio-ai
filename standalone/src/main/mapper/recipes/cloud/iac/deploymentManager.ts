/**
 * Google Cloud Deployment Manager configurations: a YAML `resources:` list of
 * { name, type, properties }, with $(ref.NAME.field) references. Templates
 * (.jinja / .py types) are drawn as modules.
 */
import * as path from "path";
import { IacGroup, IacResource, IngressRule, keepAttr, lineAt, markOpenIngress, rulesFromPortSpecs } from "./model";

const DM_TYPE = /^([a-z0-9-]+\.v\d[a-z0-9]*\.[A-Za-z.]+|gcp-types\/.+|[\w./-]+\.(jinja|py))$/;

export function isDeploymentManager(doc: any): boolean {
	return (
		!!doc &&
		typeof doc === "object" &&
		!doc.Resources &&
		Array.isArray(doc.resources) &&
		doc.resources.length > 0 &&
		doc.resources.every((r: any) => r && typeof r === "object" && typeof r.name === "string" && typeof r.type === "string") &&
		doc.resources.some((r: any) => DM_TYPE.test(r.type))
	);
}

export function parseDeploymentManager(file: string, text: string, doc: any): { group: IacGroup; resources: IacResource[] } {
	const group = `dm:${file}`;
	const names = new Set<string>(doc.resources.map((r: any) => r.name));
	const resources: IacResource[] = [];
	for (const r of doc.resources) {
		const body = JSON.stringify(r.properties ?? {}) + JSON.stringify(r.metadata ?? {});
		const refs = new Set<string>();
		for (const m of body.matchAll(/\$\(ref\.([A-Za-z0-9_-]+)\./g)) if (names.has(m[1]) && m[1] !== r.name) refs.add(m[1]);
		for (const d of [].concat(r.metadata?.dependsOn ?? [])) if (names.has(String(d))) refs.add(String(d));
		const attrs: Record<string, string> = {};
		for (const k of ["zone", "region", "machineType", "databaseVersion", "ipCidrRange", "location"]) keepAttr(attrs, k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), typeof r.properties?.[k] === "string" ? (k === "machineType" ? String(r.properties[k]).split("/").pop() : String(r.properties[k])) : undefined);
		const p = r.properties ?? {};
		if (/firewall$/i.test(String(r.type)) && !/^egress$/i.test(String(p.direction ?? "")) && p.disabled !== true) {
			const sources: string[] = Array.isArray(p.sourceRanges) ? p.sourceRanges.filter((x: unknown) => typeof x === "string") : [];
			const rules: IngressRule[] = (Array.isArray(p.allowed) ? p.allowed : []).flatMap((a: any) => rulesFromPortSpecs(a?.IPProtocol === undefined ? undefined : String(a.IPProtocol), Array.isArray(a?.ports) ? a.ports : [], sources));
			markOpenIngress(attrs, rules);
		}
		if (/sqladmin\.v1\w*\.instance$/i.test(String(r.type))) {
			const nets: any[] = p.settings?.ipConfiguration?.authorizedNetworks ?? [];
			const world = (Array.isArray(nets) ? nets : []).map((n) => n?.value).filter((v) => v === "0.0.0.0/0");
			if (world.length) attrs.authorizedNetworks = world.join(", ");
		}
		const template = /\.(jinja|py)$/.test(r.type);
		const esc = String(r.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const at = new RegExp(`name\\s*:\\s*["']?${esc}["']?\\s*$`, "m").exec(text);
		const res: IacResource = {
			id: `${group}::${r.name}`,
			address: r.name,
			type: r.type,
			name: r.name,
			kind: template ? "module" : "resource",
			cloud: template ? "other" : "gcp",
			tool: "deployment-manager",
			group,
			file,
			line: at ? lineAt(text, at.index) : 1,
			refs: [...refs],
			attrs,
		};
		if (template) res.moduleSource = r.type;
		resources.push(res);
	}
	return { group: { id: group, label: `Deployment Manager · ${path.posix.basename(file)}`, tool: "deployment-manager", path: file }, resources };
}
