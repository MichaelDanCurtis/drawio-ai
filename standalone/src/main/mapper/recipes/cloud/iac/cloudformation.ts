/**
 * CloudFormation and SAM templates (YAML with the short-form intrinsic tags, or
 * JSON), including CDK's synthesized templates in cdk.out. References come from
 * Ref, Fn::GetAtt, Fn::Sub and DependsOn; nested stacks become module links.
 */
import * as yaml from "js-yaml";
import * as path from "path";
import { IacGroup, IacResource, IacTool, keepAttr, lineAt } from "./model";

const scalar = (name: string, wrap: (v: string) => unknown) => yaml.defineScalarTag(name, { resolve: (s: string) => wrap(s), identify: () => false });
const sequence = (name: string, wrap: (v: unknown[]) => unknown) =>
	yaml.defineSequenceTag<unknown[], unknown>(name, {
		create: () => [],
		addItem: (c: unknown[], item: unknown) => void c.push(item),
		finalize: wrap,
		identify: () => false,
	});
const mapping = (name: string, wrap: (v: Record<string, unknown>) => unknown) =>
	yaml.defineMappingTag<Record<string, unknown>, unknown>(name, {
		create: () => ({}),
		addPair: (c: Record<string, unknown>, k: unknown, v: unknown) => {
			c[String(k)] = v;
			return "";
		},
		has: (c: Record<string, unknown>, k: unknown) => Object.prototype.hasOwnProperty.call(c, String(k)),
		keys: (r: any) => Object.keys(r ?? {}),
		get: (r: any, k: unknown) => r?.[String(k)],
		finalize: wrap,
		identify: () => false,
	});

const FN = ["And", "Base64", "Cidr", "Equals", "FindInMap", "GetAtt", "GetAZs", "If", "ImportValue", "Join", "Not", "Or", "Select", "Split", "Sub", "Transform", "Length", "ToJsonString", "Condition"];

/** js-yaml schema with CloudFormation's short-form tags (!Ref, !GetAtt, !Sub...) in every node kind. */
export const CFN_SCHEMA = yaml.CORE_SCHEMA.withTags(
	scalar("!Ref", (v) => ({ Ref: v })),
	...FN.flatMap((f) => {
		const key = f === "Condition" ? "Condition" : `Fn::${f}`;
		const wrapS = (v: unknown) => ({ [key]: f === "GetAtt" && typeof v === "string" ? v.split(".") : v });
		return [scalar(`!${f}`, wrapS), sequence(`!${f}`, (v) => ({ [key]: v })), mapping(`!${f}`, (v) => ({ [key]: v }))];
	})
);

/** Parses a YAML or JSON template; undefined when it is not a CloudFormation template. */
export function loadTemplate(text: string, file: string): any | undefined {
	if (!/AWSTemplateFormatVersion|Transform["']?\s*:\s*["']?AWS::Serverless|["']?Resources["']?\s*:/.test(text)) return undefined;
	if (!/["']?Type["']?\s*:\s*["']?(AWS|Alexa|Custom)::|Type"\s*:\s*"(AWS|Custom)::/.test(text)) return undefined;
	const doc: any = /\.json$/i.test(file) ? JSON.parse(text) : yaml.load(text, { schema: CFN_SCHEMA });
	if (!doc || typeof doc !== "object" || !doc.Resources || typeof doc.Resources !== "object") return undefined;
	return doc;
}

/** Logical ids a value refers to (Ref, GetAtt, Sub, and nested values). */
export function cfnRefs(value: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const v of value) cfnRefs(v, out);
	} else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === "Ref" && typeof v === "string") out.add(v);
			else if (k === "Fn::GetAtt") {
				const target = Array.isArray(v) ? v[0] : typeof v === "string" ? v.split(".")[0] : undefined;
				if (typeof target === "string") out.add(target);
				else cfnRefs(v, out);
			} else if (k === "Fn::Sub") {
				const [tpl, vars] = Array.isArray(v) ? [v[0], v[1]] : [v, undefined];
				const local = new Set(vars && typeof vars === "object" ? Object.keys(vars) : []);
				if (typeof tpl === "string") for (const m of tpl.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) if (!local.has(m[1])) out.add(m[1]);
				if (vars) cfnRefs(vars, out);
			} else cfnRefs(v, out);
		}
	}
	return out;
}

const PROP_ATTRS = ["BucketName", "FunctionName", "TableName", "QueueName", "TopicName", "Runtime", "InstanceType", "DBInstanceClass", "Engine", "PubliclyAccessible", "StorageEncrypted", "MultiAZ", "CidrBlock", "MapPublicIpOnLaunch", "Scheme"];

function lineOfLogicalId(text: string, id: string, json: boolean): number {
	const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = json ? new RegExp(`"${esc}"\\s*:\\s*\\{`) : new RegExp(`^[ \\t]+["']?${esc}["']?[ \\t]*:`, "m");
	const start = json ? 0 : Math.max(0, text.search(/^Resources\s*:/m));
	const m = re.exec(text.slice(start));
	return m ? lineAt(text, start + m.index) : 1;
}

/** One group per template; resources keyed by logical id. */
export function parseCloudFormation(file: string, text: string, doc: any): { group: IacGroup; resources: IacResource[] } {
	const json = /\.json$/i.test(file);
	const transform = [].concat(doc.Transform ?? []).map(String);
	const tool: IacTool = /(^|\/)cdk\.out\//.test(file) ? "cdk" : transform.some((t) => /Serverless/.test(t)) ? "sam" : "cloudformation";
	const group = `cfn:${file}`;
	const label = `${tool === "cdk" ? "CDK stack" : tool === "sam" ? "SAM template" : "CloudFormation"} · ${file}`;
	const ids = new Set(Object.keys(doc.Resources));
	const resources: IacResource[] = [];
	for (const [logicalId, r] of Object.entries<any>(doc.Resources)) {
		if (!r || typeof r !== "object") continue;
		const type = String(r.Type ?? "Unknown");
		if (type === "AWS::CDK::Metadata") continue;
		const refs = cfnRefs(r.Properties);
		for (const d of [].concat(r.DependsOn ?? [])) refs.add(String(d));
		const attrs: Record<string, string> = {};
		for (const k of PROP_ATTRS) keepAttr(attrs, k, r.Properties?.[k]);
		const propsText = JSON.stringify(r.Properties ?? {});
		if (/"0\.0\.0\.0\/0"|"::\/0"/.test(propsText)) attrs.openToWorld = "true";
		const cdkPath = r.Metadata?.["aws:cdk:path"];
		const name = typeof cdkPath === "string" ? cdkPath.split("/").filter((p: string) => p !== "Resource" && p !== "Default").slice(1).join("/") || logicalId : logicalId;
		const res: IacResource = {
			id: `${group}::${logicalId}`,
			address: logicalId,
			type,
			name,
			kind: "resource",
			cloud: "aws",
			tool,
			group,
			file,
			line: lineOfLogicalId(text, logicalId, json),
			refs: [...refs].filter((x) => ids.has(x) && x !== logicalId),
			attrs,
		};
		const nested = type === "AWS::CloudFormation::Stack" ? r.Properties?.TemplateURL : type === "AWS::Serverless::Application" ? r.Properties?.Location : undefined;
		if (typeof nested === "string") {
			if (/^https?:|^s3:/.test(nested)) res.moduleSource = nested;
			else res.moduleTarget = `cfn:${path.posix.normalize(path.posix.join(path.posix.dirname(file), nested))}`;
		}
		resources.push(res);
	}
	return { group: { id: group, label, tool, path: file }, resources };
}
