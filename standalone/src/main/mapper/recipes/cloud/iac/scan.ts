/** Finds and parses the IaC files of a folder: Terraform, CloudFormation / SAM / CDK, Bicep, ARM, Deployment Manager. */
import * as yaml from "js-yaml";
import { readFiles } from "../../common";
import { isArmTemplate, parseArm } from "./arm";
import { parseBicep } from "./bicep";
import { CFN_SCHEMA, loadTemplate, parseCloudFormation } from "./cloudformation";
import { isDeploymentManager, parseDeploymentManager } from "./deploymentManager";
import type { IacScan } from "./model";
import { parseTerraform } from "./terraform";

const SKIP_JSON = /(^|\/)(package(-lock)?|tsconfig[^/]*|composer|bower|lerna|nx|project|angular|tslint|eslintrc|jsconfig|cdk|cdk\.context|manifest|tree)\.json$|\.(lock|map)\.json$|(^|\/)cdk\.out\/(asset\.|.*\.assets\.json$)/i;

export function scanIac(root: string, signal?: AbortSignal, progress?: (t: string) => void): IacScan {
	const files = readFiles(root, {
		match: (rel) => (/\.(tf|bicep|ya?ml|json|template)$/i.test(rel) && !SKIP_JSON.test(rel)) || false,
		maxFiles: 4000,
		maxBytes: 4_000_000,
		maxDepth: 12,
	});
	const scan: IacScan = { groups: [], resources: [], warnings: [] };
	const tf = files.filter((f) => /\.tf$/i.test(f.rel));
	if (tf.length) {
		progress?.(`Reading ${tf.length} Terraform file(s)…`);
		const r = parseTerraform(tf);
		scan.groups.push(...r.groups.filter((g) => r.resources.some((x) => x.group === g.id)));
		scan.resources.push(...r.resources);
	}
	for (const f of files) {
		if (signal?.aborted) break;
		if (/\.tf$/i.test(f.rel)) continue;
		try {
			if (/\.bicep$/i.test(f.rel)) {
				const r = parseBicep(f.rel, f.text);
				if (r.resources.length) {
					scan.groups.push(r.group);
					scan.resources.push(...r.resources);
				}
				continue;
			}
			const json = /\.json$/i.test(f.rel);
			// Cheap checks before parsing anything.
			const maybeCfn = /AWS::|AWSTemplateFormatVersion/.test(f.text);
			const maybeArm = json && /deploymentTemplate\.json/i.test(f.text);
			const maybeDm = !json && /^resources\s*:/m.test(f.text) && /\btype\s*:/.test(f.text);
			if (!maybeCfn && !maybeArm && !maybeDm) continue;
			if (maybeCfn) {
				const doc = loadTemplate(f.text, f.rel);
				if (doc) {
					const r = parseCloudFormation(f.rel, f.text, doc);
					scan.groups.push(r.group);
					scan.resources.push(...r.resources);
					continue;
				}
			}
			if (maybeArm) {
				const doc = JSON.parse(f.text);
				if (isArmTemplate(doc)) {
					const r = parseArm(f.rel, f.text, doc);
					scan.groups.push(r.group);
					scan.resources.push(...r.resources);
				}
				continue;
			}
			if (maybeDm) {
				const doc = yaml.load(f.text, { schema: CFN_SCHEMA });
				if (isDeploymentManager(doc)) {
					const r = parseDeploymentManager(f.rel, f.text, doc);
					scan.groups.push(r.group);
					scan.resources.push(...r.resources);
				}
			}
		} catch (e: any) {
			// Only files that clearly are templates are worth a warning.
			const text = `${f.rel}: ${String(e?.message ?? e).split("\n")[0]}`;
			if (/\.bicep$/i.test(f.rel) || /deploymentTemplate\.json/.test(f.text)) scan.warnings.push({ text, cloud: "azure" });
			else if (/AWSTemplateFormatVersion|^Resources\s*:/m.test(f.text)) scan.warnings.push({ text, cloud: "aws" });
		}
	}
	return scan;
}
