import { digDeeperRequest } from "../../common";
import type { FieldOption, Recipe } from "../../../types";
import { collectAws, profileRegion } from "./collect";
import { awsInventoryToGraph } from "./graph";

export { awsInventoryToGraph, publicSubnets, collapseCrowds } from "./graph";
export { collectAws, collectRegion, parseRegions, parseServices, AwsCli, awsErrorCode } from "./collect";

/** Live inventory of an AWS account, read-only through the `aws` CLI. */
export const awsEnvironmentRecipe: Recipe = {
	id: "aws.environment",
	category: "aws",
	title: "AWS account",
	description:
		"Regions, VPCs, public and private subnets, gateways, EC2, load balancers and their targets, RDS, Lambda, ECS, EKS, DynamoDB, SQS, SNS, API Gateway, ElastiCache, S3 and CloudFront, with the connections between them. Read-only (aws describe / list / get).",
	mode: "inventory",
	fields: [
		{
			id: "profile",
			label: "AWS profile",
			type: "select",
			dynamic: true,
			help: "From `aws configure list-profiles`. Sign in first (aws sso login / aws login) if the session expired.",
		},
		{
			id: "regions",
			label: "Region",
			type: "select",
			dynamic: true,
			help: "The profile's own region, every region enabled for the account, or one region (from `aws ec2 describe-regions`).",
		},
		{
			id: "services",
			label: "Services",
			type: "text",
			placeholder: "all (or e.g. ec2, elb, rds, lambda, ecs, eks, dynamodb, sqs, sns, apigateway, elasticache, s3, cloudfront)",
			help: "Networks (VPCs, subnets, gateways, security groups) are always read.",
		},
	],
	async loadOptions(fieldId, input, ctx): Promise<FieldOption[]> {
		if (fieldId === "regions") {
			const profile = (input.profile ?? "").trim();
			const home = await profileRegion(ctx, profile);
			const options: FieldOption[] = [
				{ value: "", label: home ? `The profile's region (${home})` : "The profile's region (us-east-1 if it has none)" },
				{ value: "all", label: "All enabled regions" },
			];
			const r = await ctx
				.exec("aws", ["ec2", "describe-regions", "--output", "json", "--region", home ?? "us-east-1", ...(profile ? ["--profile", profile] : [])], { timeoutMs: 30_000 })
				.catch(() => undefined);
			let names: string[] = [];
			try {
				names = r && r.code === 0 ? ((JSON.parse(r.stdout).Regions ?? []) as any[]).map((x) => String(x.RegionName)).filter((n) => /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(n)).sort() : [];
			} catch {
				names = [];
			}
			if (!names.length) options.push({ value: "", label: "(Could not list regions: sign in with aws sso login / aws login, then ↻)" });
			return [...options, ...names.map((n) => ({ value: n, label: n === home ? `${n} · the profile's region` : n }))];
		}
		if (fieldId !== "profile") return [];
		const r = await ctx.exec("aws", ["configure", "list-profiles"], { timeoutMs: 30_000 });
		const profiles = r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
		return [{ value: "", label: "Default credentials (environment / default profile)" }, ...profiles.map((p) => ({ value: p, label: p }))];
	},
	async collect(input, ctx) {
		const warnings: string[] = [];
		const inv = await collectAws({ profile: (input.profile ?? "").trim(), regions: input.regions ?? "", services: input.services }, ctx, warnings);
		ctx.progress("Drawing the map…");
		const map = awsInventoryToGraph(inv);
		return { graph: map.graph, facts: map.facts, summary: map.summary, warnings, findings: map.findings, checked: map.checked };
	},
	agentPrompt: (input) =>
		`Review the AWS map on this page (account inventory collected read-only${input.profile ? `, profile "${input.profile}"` : ""}) as an architect. Add short review notes next to the shapes they concern: public exposure (internet-facing load balancers, public IPs with open security groups, publicly accessible databases, public EKS endpoints), single points of failure (single-AZ databases, one NAT gateway for several AZs, load balancers with one target, single-task services), missing encryption where the data shows it, and anything that looks unintended. Use only read-only \`aws\` describe / list / get commands with the ids, regions and profile stored in the shapes' data if you need more detail.`,
	digDeeper: (shapes, question) =>
		digDeeperRequest(
			"AWS resources (use only read-only `aws` describe-* / list-* / get-* commands, with --region and --profile from each shape's region and awsProfile data, and the ids or ARNs stored on the shapes; never print secrets such as environment variables)",
			shapes,
			question
		),
};

export const awsRecipes: Recipe[] = [awsEnvironmentRecipe];
