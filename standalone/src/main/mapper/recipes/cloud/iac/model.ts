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
	].map((s) => s.toLowerCase())
);

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
