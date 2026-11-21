/**
 * Reads an AWS account with the `aws` CLI, read-only: only describe / list / get
 * calls (the read-only guard refuses anything else). Each call that fails
 * (access denied, a service not offered in a region) becomes a warning; a
 * region that is not enabled for the account is skipped as a whole.
 */
import type { CollectContext } from "../../../types";
import { MapperError } from "../../../types";
import { AWS_SERVICES, AwsInventory, AwsRegionInventory, AwsService, emptyRegion } from "./inventory";

/** Runs `fn` over `items`, at most `limit` at a time, stopping when cancelled. */
export async function pool<T, R>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			if (signal.aborted) throw new MapperError("Cancelled");
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** "An error occurred (AccessDenied) when calling ..." → "AccessDenied". */
export function awsErrorCode(stderr: string): string {
	const m = /An error occurred \(([^)]+)\)/.exec(stderr);
	if (m) return m[1];
	if (/session has expired|ExpiredToken|token has expired|re-?authenticate|aws (sso )?login/i.test(stderr)) return "ExpiredToken";
	if (/Unable to locate credentials|could not be found|NoCredentials/i.test(stderr)) return "NoCredentials";
	if (/Could not connect to the endpoint URL/i.test(stderr)) return "EndpointUnavailable";
	return (stderr.trim().split("\n").pop() ?? "").slice(0, 160) || "error";
}

const REGION_OFF = new Set(["AuthFailure", "UnrecognizedClientException", "InvalidClientTokenId", "OptInRequired", "UnauthorizedOperation_RegionDisabled"]);
const CREDENTIAL_PROBLEMS = new Set(["ExpiredToken", "ExpiredTokenException", "NoCredentials", "InvalidClientTokenId", "UnrecognizedClientException", "SignatureDoesNotMatch"]);

/** The aws CLI, with the profile, JSON output and per-call warnings. */
export class AwsCli {
	/** Regions that refused us as a whole (not enabled, no access). */
	readonly disabledRegions = new Set<string>();
	constructor(
		private readonly ctx: CollectContext,
		readonly profile: string,
		readonly warnings: string[]
	) {}

	args(service: string, op: string, args: string[], region?: string): string[] {
		return [service, op, ...args, "--output", "json", "--no-cli-pager", ...(region ? ["--region", region] : []), ...(this.profile ? ["--profile", this.profile] : [])];
	}

	/** A call whose failure stops the map (identity, region list). */
	async must(service: string, op: string, args: string[] = [], region?: string): Promise<any> {
		const r = await this.ctx.exec("aws", this.args(service, op, args, region), { timeoutMs: 120_000 });
		if (r.code !== 0) {
			const code = awsErrorCode(r.stderr || r.stdout);
			if (CREDENTIAL_PROBLEMS.has(code)) {
				throw new MapperError(
					`The AWS credentials${this.profile ? ` of profile "${this.profile}"` : ""} are missing or expired (${code}).`,
					`Sign in again, e.g. \`aws sso login${this.profile ? ` --profile ${this.profile}` : ""}\` or \`aws login\`, then map again.`
				);
			}
			throw new MapperError(`\`aws ${service} ${op}\` failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
		}
		return parse(r.stdout, `aws ${service} ${op}`);
	}

	/** A call whose failure is a warning; returns undefined then. */
	async call(region: string | undefined, service: string, op: string, args: string[] = []): Promise<any> {
		if (this.ctx.signal.aborted) throw new MapperError("Cancelled");
		if (region && this.disabledRegions.has(region)) return undefined;
		const r = await this.ctx.exec("aws", this.args(service, op, args, region), { timeoutMs: 180_000 });
		if (r.code === 0) {
			try {
				return parse(r.stdout, `aws ${service} ${op}`);
			} catch (e: any) {
				this.warnings.push(`${region ?? "global"}: ${service} ${op}: ${e.message}`);
				return undefined;
			}
		}
		const code = awsErrorCode(r.stderr || r.stdout);
		if (region && REGION_OFF.has(code)) {
			if (!this.disabledRegions.has(region)) this.warnings.push(`${region}: skipped (${code}: the region is not enabled for this account or not reachable with these credentials).`);
			this.disabledRegions.add(region);
			return undefined;
		}
		if (CREDENTIAL_PROBLEMS.has(code)) throw new MapperError(`AWS credentials stopped working while mapping (${code}).`, "Sign in again and map again.");
		this.warnings.push(`${region ?? "global"}: \`aws ${service} ${op}\` ${code}`);
		return undefined;
	}
}

function parse(stdout: string, what: string): any {
	const text = stdout.trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new MapperError(`\`${what}\` did not return JSON.`);
	}
}

/** "us-east-1, eu-west-1" / "all" → region names. */
export function parseRegions(text: string): string[] | "all" {
	const t = text.trim();
	if (/^all( enabled)?( regions)?$/i.test(t)) return "all";
	return [...new Set(t.split(/[\s,;]+/).filter((r) => /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(r)))];
}

/** "ec2, rds lambda" → service keys; empty or "all" → every service. */
export function parseServices(text: string | undefined): AwsService[] {
	const t = (text ?? "").trim().toLowerCase();
	if (!t || t === "all") return [...AWS_SERVICES];
	const alias: Record<string, AwsService> = { alb: "elb", elbv2: "elb", nlb: "elb", aurora: "rds", api: "apigateway", apigw: "apigateway", redis: "elasticache", cache: "elasticache", dynamo: "dynamodb", function: "lambda", functions: "lambda", cdn: "cloudfront" };
	const out = new Set<AwsService>();
	for (const w of t.split(/[\s,;]+/).filter(Boolean)) {
		const k = (alias[w] ?? w) as AwsService;
		if ((AWS_SERVICES as readonly string[]).includes(k)) out.add(k);
	}
	return out.size ? [...out] : [...AWS_SERVICES];
}

/** The profile's default region from `aws configure list`. */
export async function profileRegion(ctx: CollectContext, profile: string): Promise<string | undefined> {
	const r = await ctx.exec("aws", ["configure", "list", ...(profile ? ["--profile", profile] : [])], { timeoutMs: 30_000 }).catch(() => undefined);
	const m = r && /^\s*region\s*:?\s+([a-z]{2}(?:-gov)?-[a-z]+-\d)\b/m.exec(r.stdout);
	return m?.[1];
}

const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const arr = (x: any): any[] => (Array.isArray(x) ? x : []);

/** Reads one region. Network is always read; the rest by `services`. */
export async function collectRegion(cli: AwsCli, region: string, services: AwsService[], ctx: CollectContext): Promise<AwsRegionInventory | undefined> {
	const inv = emptyRegion(region);
	const has = (s: AwsService) => services.includes(s);
	ctx.progress(`${region}: networks…`);
	// The first call also tells whether the region is usable at all.
	const vpcs = await cli.call(region, "ec2", "describe-vpcs");
	if (vpcs === undefined && cli.disabledRegions.has(region)) return undefined;
	inv.vpcs = arr(vpcs?.Vpcs);

	const tasks: (() => Promise<void>)[] = [
		async () => void (inv.subnets = arr((await cli.call(region, "ec2", "describe-subnets"))?.Subnets)),
		async () => void (inv.routeTables = arr((await cli.call(region, "ec2", "describe-route-tables"))?.RouteTables)),
		async () => void (inv.internetGateways = arr((await cli.call(region, "ec2", "describe-internet-gateways"))?.InternetGateways)),
		async () => void (inv.natGateways = arr((await cli.call(region, "ec2", "describe-nat-gateways"))?.NatGateways).filter((n) => n?.State !== "deleted")),
		async () => void (inv.vpcEndpoints = arr((await cli.call(region, "ec2", "describe-vpc-endpoints"))?.VpcEndpoints)),
		async () => void (inv.peerings = arr((await cli.call(region, "ec2", "describe-vpc-peering-connections"))?.VpcPeeringConnections).filter((p) => !["deleted", "rejected", "expired", "failed"].includes(p?.Status?.Code))),
		async () => void (inv.transitGateways = arr((await cli.call(region, "ec2", "describe-transit-gateways"))?.TransitGateways).filter((t) => t?.State !== "deleted")),
		async () => void (inv.tgwAttachments = arr((await cli.call(region, "ec2", "describe-transit-gateway-attachments"))?.TransitGatewayAttachments).filter((t) => t?.State !== "deleted")),
		async () => void (inv.securityGroups = arr((await cli.call(region, "ec2", "describe-security-groups"))?.SecurityGroups)),
	];
	if (has("ec2"))
		tasks.push(async () => {
			const r = await cli.call(region, "ec2", "describe-instances");
			inv.instances = arr(r?.Reservations)
				.flatMap((res: any) => arr(res?.Instances))
				.filter((i: any) => !["terminated", "shutting-down"].includes(i?.State?.Name));
		});
	if (has("elb")) {
		tasks.push(async () => {
			inv.loadBalancers = arr((await cli.call(region, "elbv2", "describe-load-balancers"))?.LoadBalancers);
			inv.targetGroups = arr((await cli.call(region, "elbv2", "describe-target-groups"))?.TargetGroups);
			const withLb = inv.targetGroups.filter((tg) => arr(tg?.LoadBalancerArns).length > 0).slice(0, 150);
			await pool(withLb, 4, ctx.signal, async (tg) => {
				const h = await cli.call(region, "elbv2", "describe-target-health", ["--target-group-arn", tg.TargetGroupArn]);
				inv.targetHealth[tg.TargetGroupArn] = arr(h?.TargetHealthDescriptions);
			});
		});
		tasks.push(async () => void (inv.classicLoadBalancers = arr((await cli.call(region, "elb", "describe-load-balancers"))?.LoadBalancerDescriptions)));
	}
	if (has("rds")) {
		tasks.push(async () => void (inv.dbInstances = arr((await cli.call(region, "rds", "describe-db-instances"))?.DBInstances)));
		tasks.push(async () => void (inv.dbClusters = arr((await cli.call(region, "rds", "describe-db-clusters"))?.DBClusters)));
	}
	if (has("lambda")) {
		// Pick fields in the query so environment variables (often secrets) never leave the CLI.
		tasks.push(
			async () =>
				void (inv.lambdas = arr(
					(
						await cli.call(region, "lambda", "list-functions", [
							"--query",
							"Functions[].{FunctionName:FunctionName,FunctionArn:FunctionArn,Runtime:Runtime,PackageType:PackageType,MemorySize:MemorySize,Timeout:Timeout,Architectures:Architectures,VpcConfig:VpcConfig}",
						])
					) ?? []
				))
		);
		tasks.push(async () => void (inv.eventSourceMappings = arr((await cli.call(region, "lambda", "list-event-source-mappings"))?.EventSourceMappings)));
	}
	if (has("ecs"))
		tasks.push(async () => {
			const arns: string[] = arr((await cli.call(region, "ecs", "list-clusters"))?.clusterArns).slice(0, 40);
			for (const batch of chunks(arns, 100)) {
				if (!batch.length) continue;
				inv.ecsClusters.push(...arr((await cli.call(region, "ecs", "describe-clusters", ["--clusters", ...batch]))?.clusters));
			}
			await pool(arns, 3, ctx.signal, async (cluster) => {
				const serviceArns: string[] = arr((await cli.call(region, "ecs", "list-services", ["--cluster", cluster]))?.serviceArns).slice(0, 100);
				const services: any[] = [];
				for (const batch of chunks(serviceArns, 10)) {
					services.push(...arr((await cli.call(region, "ecs", "describe-services", ["--cluster", cluster, "--services", ...batch]))?.services));
				}
				inv.ecsServices[cluster] = services;
			});
		});
	if (has("eks"))
		tasks.push(async () => {
			const names: string[] = arr((await cli.call(region, "eks", "list-clusters"))?.clusters).slice(0, 50);
			const described = await pool(names, 3, ctx.signal, async (name) => (await cli.call(region, "eks", "describe-cluster", ["--name", name]))?.cluster);
			inv.eksClusters = described.filter(Boolean);
		});
	if (has("dynamodb")) tasks.push(async () => void (inv.dynamoTables = arr((await cli.call(region, "dynamodb", "list-tables"))?.TableNames)));
	if (has("sqs")) tasks.push(async () => void (inv.queueUrls = arr((await cli.call(region, "sqs", "list-queues"))?.QueueUrls)));
	if (has("sns"))
		tasks.push(async () => {
			inv.topicArns = arr((await cli.call(region, "sns", "list-topics"))?.Topics)
				.map((t: any) => t?.TopicArn)
				.filter(Boolean);
			if (inv.topicArns.length) inv.subscriptions = arr((await cli.call(region, "sns", "list-subscriptions"))?.Subscriptions);
		});
	if (has("apigateway")) {
		tasks.push(async () => {
			inv.restApis = arr((await cli.call(region, "apigateway", "get-rest-apis"))?.items);
			await pool(inv.restApis.slice(0, 40), 3, ctx.signal, async (api) => {
				inv.restResources[api.id] = arr((await cli.call(region, "apigateway", "get-resources", ["--rest-api-id", api.id, "--embed", "methods"]))?.items);
			});
		});
		tasks.push(async () => {
			inv.httpApis = arr((await cli.call(region, "apigatewayv2", "get-apis"))?.Items);
			await pool(inv.httpApis.slice(0, 40), 3, ctx.signal, async (api) => {
				inv.httpIntegrations[api.ApiId] = arr((await cli.call(region, "apigatewayv2", "get-integrations", ["--api-id", api.ApiId]))?.Items);
			});
		});
	}
	if (has("elasticache")) {
		tasks.push(async () => void (inv.cacheClusters = arr((await cli.call(region, "elasticache", "describe-cache-clusters"))?.CacheClusters)));
		tasks.push(async () => void (inv.cacheSubnetGroups = arr((await cli.call(region, "elasticache", "describe-cache-subnet-groups"))?.CacheSubnetGroups)));
	}
	ctx.progress(`${region}: ${tasks.length} inventory calls…`);
	await pool(tasks, 6, ctx.signal, (t) => t());
	return inv;
}

/** S3 buckets with their regions, and CloudFront distributions (global). */
export async function collectGlobal(cli: AwsCli, services: AwsService[], ctx: CollectContext): Promise<Pick<AwsInventory, "buckets" | "distributions">> {
	const out: Pick<AwsInventory, "buckets" | "distributions"> = { buckets: [], distributions: [] };
	if (services.includes("s3")) {
		ctx.progress("S3 buckets…");
		const r = await cli.call(undefined, "s3api", "list-buckets");
		const buckets: any[] = arr(r?.Buckets);
		out.buckets = buckets.map((b) => ({ name: String(b.Name), region: b.BucketRegion ? String(b.BucketRegion) : undefined }));
		const unknown = out.buckets.filter((b) => !b.region).slice(0, 300);
		await pool(unknown, 6, ctx.signal, async (b) => {
			const loc = await cli.call(undefined, "s3api", "get-bucket-location", ["--bucket", b.name]);
			if (loc) b.region = loc.LocationConstraint ? (loc.LocationConstraint === "EU" ? "eu-west-1" : String(loc.LocationConstraint)) : "us-east-1";
		});
	}
	if (services.includes("cloudfront")) {
		ctx.progress("CloudFront distributions…");
		out.distributions = arr((await cli.call(undefined, "cloudfront", "list-distributions"))?.DistributionList?.Items);
	}
	return out;
}

export interface CollectOptions {
	profile: string;
	regions: string;
	services?: string;
}

/** Reads the account: identity, regions, then each region (4 at a time) and the global services. */
export async function collectAws(opts: CollectOptions, ctx: CollectContext, warnings: string[]): Promise<AwsInventory> {
	const cli = new AwsCli(ctx, opts.profile, warnings);
	ctx.progress("Checking the AWS identity…");
	const who = await cli.must("sts", "get-caller-identity");
	const services = parseServices(opts.services);
	let regions = parseRegions(opts.regions ?? "");
	const home = (await profileRegion(ctx, opts.profile)) ?? "us-east-1";
	if (regions === "all") {
		ctx.progress("Listing enabled regions…");
		const r = await cli.must("ec2", "describe-regions", [], home);
		regions = arr(r?.Regions)
			.map((x: any) => String(x.RegionName))
			.sort();
	} else if (regions.length === 0) {
		regions = [home];
	}
	const inv: AwsInventory = { account: String(who?.Account ?? "unknown"), callerArn: who?.Arn, profile: opts.profile || undefined, regions: [], buckets: [], distributions: [], services };
	const perRegion = await pool(regions as string[], 4, ctx.signal, (region) => collectRegion(cli, region, services, ctx));
	inv.regions = perRegion.filter((r): r is AwsRegionInventory => !!r);
	Object.assign(inv, await collectGlobal(cli, services, ctx));
	return inv;
}
