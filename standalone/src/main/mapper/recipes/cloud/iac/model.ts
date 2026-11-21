/** What the IaC parsers find, whatever the tool. */

export type Cloud = "aws" | "azure" | "gcp" | "other";
export type IacTool = "terraform" | "cloudformation" | "sam" | "cdk" | "bicep" | "arm" | "deployment-manager";

export interface IacResource {
	/** Unique in the scan: `${group}::${address}`. */
	id: string;
	/** How the code refers to it: aws_instance.web, data.aws_ami.x, module.net, a logical id, a Bicep symbol. */
	address: string;
	/** Provider type: aws_instance, AWS::S3::Bucket, Microsoft.Storage/storageAccounts, compute.v1.instance. */
	type: string;
	name: string;
	kind: "resource" | "data" | "module";
	cloud: Cloud;
	tool: IacTool;
	/** The container it belongs to (module folder, stack or template file). */
	group: string;
	/** Relative path, forward slashes. */
	file: string;
	line: number;
	/** Addresses it refers to, in the same group. */
	refs: string[];
	/** For modules / nested stacks: the referenced file or folder, relative to the scan root, when local. */
	moduleTarget?: string;
	/** For modules with a remote source: the source as written. */
	moduleSource?: string;
	/** A few telling settings (never secret values). */
	attrs: Record<string, string>;
}

export interface IacGroup {
	id: string;
	label: string;
	tool: IacTool;
	/** File or folder, relative. */
	path: string;
}

export interface IacScan {
	groups: IacGroup[];
	resources: IacResource[];
	/** Problems reading files; `cloud` when the file clearly belongs to one. */
	warnings: { text: string; cloud?: Cloud }[];
}

/** Settings worth showing and reviewing; values are kept short. Anything that looks like a secret is never kept. */
export const INTERESTING_ATTRS = new Set(
	[
		"name",
		"bucket",
		"acl",
		"publicly_accessible",
		"storage_encrypted",
		"encrypted",
		"multi_az",
		"instance_type",
		"instance_class",
		"engine",
		"engine_version",
		"runtime",
		"cidr_block",
		"map_public_ip_on_launch",
		"associate_public_ip_address",
		"internal",
		"load_balancer_type",
		"scheme",
		"location",
		"sku_name",
		"sku",
		"kind",
		"public_network_access_enabled",
		"public_network_access",
		"min_tls_version",
		"minimum_tls_version",
		"allow_nested_items_to_be_public",
		"https_only",
		"httpsonly",
		"region",
		"zone",
		"machine_type",
		"ip_cidr_range",
		"database_version",
		"uniform_bucket_level_access",
		"deletion_protection",
		"count",
		"for_each",
		"source",
		"version",
		"function_name",
		"table_name",
		"queue_name",
		"topic_name",
		"cluster_name",
		"bucketname",
		"functionname",
		"tablename",
		"queuename",
		"topicname",
		"publiclyaccessible",
		"storageencrypted",
		"multiaz",
		"instancetype",
		"dbinstanceclass",
		"cidrblock",
		"mappubliciponlaunch",
		"addressprefix",
		"address_space",
		"address_prefixes",
		"supportshttpstrafficonly",
		"allowblobpublicaccess",
		"publicnetworkaccess",
		"minimumtlsversion",
		"minimal_tls_version",
		"minimaltlsversion",
		"mintlsversion",
		"purge_protection_enabled",
		"enablepurgeprotection",
		"enable_https_traffic_only",
		"https_traffic_only_enabled",
		"container_access_type",
		"publicaccess",
		"accesscontrol",
		"deletionprotection",
		"block_public_acls",
		"block_public_policy",
		"ignore_public_acls",
		"restrict_public_buckets",
		"start_ip_address",
		"end_ip_address",
		"startipaddress",
		"endipaddress",
		"enable_non_ssl_port",
		"enablenonsslport",
		"public_access_prevention",
	].map((s) => s.toLowerCase())
);

/**
 * An inbound rule as declared: protocol, port range (undefined = all ports),
 * sources. `literal` is false when the ports are expressions (variables...).
 */
export interface IngressRule {
	protocol?: string;
	from?: number;
	to?: number;
	literal: boolean;
	sources: string[];
}

/** A port range as written ("22", "1000-2000", "*", 22) → [from, to], or undefined. */
function rangeOf(spec: unknown): [number, number] | undefined {
	if (typeof spec === "number" && Number.isFinite(spec)) return [spec, spec];
	const s = String(spec ?? "").trim();
	if (s === "*" || /^all$/i.test(s)) return [0, 65535];
	const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
	return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
}

/** Rules from port specs as written: none = all ports of the protocol. */
export function rulesFromPortSpecs(protocol: string | undefined, specs: unknown[], sources: string[]): IngressRule[] {
	if (!specs.length) return [{ protocol, literal: true, sources }];
	return specs.map((spec) => {
		const r = rangeOf(spec);
		return r ? { protocol, from: r[0], to: r[1], literal: true, sources } : { protocol, literal: false, sources };
	});
}

/** "the internet" as declared: 0.0.0.0/0, ::/0, Azure's * / Internet / Any. */
export const WORLD_SOURCE = /^(0\.0\.0\.0\/0|::\/0|\*|internet|any)$/i;
/** AWS's "all protocols" ignores ports; Azure's "*" protocol keeps them. */
const ALL_PROTOCOLS = /^(-1|all)$/i;

/**
 * Records the inbound rules open to the internet on a resource:
 * openToWorld = "true", openPorts = "tcp/22, udp/*, all, tcp/?" (? = not a literal),
 * openSources = "0.0.0.0/0".
 */
export function markOpenIngress(attrs: Record<string, string>, rules: IngressRule[]): void {
	const open = rules.filter((r) => r.sources.some((s) => WORLD_SOURCE.test(s.trim())));
	if (!open.length) return;
	const text = (r: IngressRule): string => {
		const proto = String(r.protocol ?? "tcp").toLowerCase();
		if (ALL_PROTOCOLS.test(proto) || ((proto === "*" || proto === "any") && r.literal && (r.from === undefined || (r.from <= 1 && (r.to ?? 65535) >= 65535)))) return "all";
		if (!r.literal) return `${proto}/?`;
		if (r.from === undefined || (r.from <= 1 && (r.to ?? 65535) >= 65535)) return `${proto}/*`;
		return r.from === r.to ? `${proto}/${r.from}` : `${proto}/${r.from}-${r.to}`;
	};
	attrs.openToWorld = "true";
	attrs.openPorts = [...new Set(open.map(text))].join(", ");
	attrs.openSources = [...new Set(open.flatMap((r) => r.sources.map((s) => s.trim()).filter((s) => WORLD_SOURCE.test(s))))].join(", ");
}

const SECRETISH = /pass(word)?|secret|token|key|credential|connection_?string|private/i;

/** Keeps a setting if it is interesting and not secret-looking; shortens the value. */
export function keepAttr(attrs: Record<string, string>, key: string, value: unknown): void {
	if (!INTERESTING_ATTRS.has(key.toLowerCase()) || SECRETISH.test(key)) return;
	if (value === undefined || value === null || typeof value === "object") return;
	const v = String(value).trim().replace(/^"(.*)"$/s, "$1");
	if (!v || v.length > 120) return;
	attrs[key] = v;
}

/** The cloud a Terraform resource type belongs to, by its provider prefix. */
export function terraformCloud(type: string): Cloud {
	if (/^aws_/.test(type) || /^awscc_/.test(type)) return "aws";
	if (/^(azurerm|azuread|azapi|azurestack)_/.test(type)) return "azure";
	if (/^google(-beta)?_/.test(type)) return "gcp";
	return "other";
}

/** Line number (1-based) of an offset. */
export function lineAt(text: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}
