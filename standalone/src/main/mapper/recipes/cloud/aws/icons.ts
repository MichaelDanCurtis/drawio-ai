/**
 * draw.io's AWS (2019+) shapes: `mxgraph.aws4.resourceIcon` service icons with a
 * category colour, resource glyphs such as `mxgraph.aws4.internet_gateway`, and the
 * `mxgraph.aws4.group` containers. Every name used here exists in draw.io's
 * Sidebar-AWS4.js (checked by the tests).
 */

/** Category colours of the AWS 2023 icon set, as in the draw.io sidebar. */
export const AWS_COLORS = {
	compute: "#ED7100",
	containers: "#ED7100",
	database: "#C925D1",
	network: "#8C4FFF",
	analytics: "#8C4FFF",
	storage: "#7AA116",
	integration: "#E7157B",
	management: "#E7157B",
	security: "#DD344C",
	ml: "#01A88D",
	devtools: "#C925D1",
	general: "#232F3E",
	frontend: "#DD344C",
} as const;
export type AwsColor = keyof typeof AWS_COLORS;

const RESOURCE_ICON =
	"sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];outlineConnect=0;fontColor=#232F3E;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;aspect=fixed;whiteSpace=wrap;shape=mxgraph.aws4.resourceIcon;";
const GLYPH =
	"sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;aspect=fixed;pointerEvents=1;whiteSpace=wrap;";

/** A service icon: `resIcon` must be one of draw.io's aws4 resource icons. */
export function awsServiceStyle(resIcon: string, color: AwsColor | string): string {
	const fill = (AWS_COLORS as Record<string, string>)[color] ?? color;
	return `${RESOURCE_ICON}fillColor=${fill};resIcon=mxgraph.aws4.${resIcon};`;
}

/** A resource glyph (internet gateway, load balancer, ECS service...). */
export function awsGlyphStyle(shape: string, color: AwsColor | string): string {
	const fill = (AWS_COLORS as Record<string, string>)[color] ?? color;
	return `${GLYPH}fillColor=${fill};shape=mxgraph.aws4.${shape};`;
}

const GROUP =
	"points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;align=left;spacingLeft=30;";

/** The AWS group containers (account, region, VPC, subnets, AZ). */
export const AWS_GROUPS = {
	cloud: `${GROUP}grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;fontColor=#232F3E;dashed=0;`,
	account: `${GROUP}grIcon=mxgraph.aws4.group_account;strokeColor=#CD2264;fillColor=none;fontColor=#CD2264;dashed=0;`,
	region: `${GROUP}grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fillColor=none;fontColor=#147EBA;dashed=1;`,
	vpc: `${GROUP}grIcon=mxgraph.aws4.group_vpc2;strokeColor=#8C4FFF;fillColor=none;fontColor=#AAB7B8;dashed=0;`,
	publicSubnet: `${GROUP}grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#7AA116;fillColor=#F2F6E8;fontColor=#248814;dashed=0;`,
	privateSubnet: `${GROUP}grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#00A4A6;fillColor=#E6F6F7;fontColor=#147EBA;dashed=0;`,
	autoScaling: `${GROUP.replace("shape=mxgraph.aws4.group;", "shape=mxgraph.aws4.groupCenter;").replace("align=left;spacingLeft=30;", "align=center;spacingTop=25;")}grIcon=mxgraph.aws4.group_auto_scaling_group;grStroke=1;strokeColor=#D86613;fillColor=none;fontColor=#D86613;dashed=1;`,
	az: "rounded=0;fillColor=none;strokeColor=#147EBA;dashed=1;verticalAlign=top;fontStyle=0;fontColor=#147EBA;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;align=center;",
	generic: "rounded=0;fillColor=none;strokeColor=#5A6C86;dashed=1;verticalAlign=top;fontStyle=0;fontColor=#5A6C86;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;align=left;spacingLeft=10;",
	ecsCluster: "rounded=0;fillColor=none;strokeColor=#ED7100;dashed=1;verticalAlign=top;fontStyle=1;fontColor=#ED7100;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;align=left;spacingLeft=10;",
	securityGroup: "rounded=0;fillColor=none;strokeColor=#DD3522;verticalAlign=top;fontStyle=0;fontColor=#DD3522;whiteSpace=wrap;html=1;",
} as const;

/** Group icon names used above (for the existence test). */
export const AWS_GROUP_ICONS = ["group_aws_cloud_alt", "group_account", "group_region", "group_vpc2", "group_security_group", "group_auto_scaling_group"];

export interface AwsIcon {
	/** A resourceIcon (`res`) or a resource glyph (`glyph`). */
	res?: string;
	glyph?: string;
	color: AwsColor;
}

/** Icons by a short service key, shared by the live inventory and the IaC maps. */
export const AWS_ICONS: Record<string, AwsIcon> = {
	ec2: { res: "ec2", color: "compute" },
	ami: { glyph: "ami", color: "compute" },
	autoscaling: { res: "auto_scaling2", color: "compute" },
	lambda: { res: "lambda", color: "compute" },
	batch: { res: "batch", color: "compute" },
	beanstalk: { res: "elastic_beanstalk", color: "compute" },
	lightsail: { res: "lightsail", color: "compute" },
	apprunner: { res: "app_runner", color: "compute" },
	ecs: { res: "ecs", color: "containers" },
	ecsService: { glyph: "ecs_service", color: "containers" },
	ecsTask: { glyph: "ecs_task", color: "containers" },
	eks: { res: "eks", color: "containers" },
	ecr: { res: "ecr", color: "containers" },
	fargate: { res: "fargate", color: "containers" },
	rds: { res: "rds", color: "database" },
	aurora: { res: "aurora", color: "database" },
	dynamodb: { res: "dynamodb", color: "database" },
	elasticache: { res: "elasticache", color: "database" },
	documentdb: { res: "documentdb_with_mongodb_compatibility", color: "database" },
	neptune: { res: "neptune", color: "database" },
	memorydb: { res: "memorydb_for_redis", color: "database" },
	keyspaces: { res: "keyspaces", color: "database" },
	timestream: { res: "timestream", color: "database" },
	redshift: { res: "redshift", color: "analytics" },
	s3: { res: "s3", color: "storage" },
	efs: { res: "elastic_file_system", color: "storage" },
	ebs: { res: "elastic_block_store", color: "storage" },
	fsx: { res: "fsx", color: "storage" },
	glacier: { res: "glacier", color: "storage" },
	backup: { res: "backup", color: "storage" },
	sqs: { res: "sqs", color: "integration" },
	sns: { res: "sns", color: "integration" },
	eventbridge: { res: "eventbridge", color: "integration" },
	stepfunctions: { res: "step_functions", color: "integration" },
	apigateway: { res: "api_gateway", color: "integration" },
	appsync: { res: "appsync", color: "integration" },
	mq: { res: "mq", color: "integration" },
	kinesis: { res: "kinesis_data_streams", color: "analytics" },
	firehose: { res: "kinesis_data_firehose", color: "analytics" },
	msk: { res: "managed_streaming_for_kafka", color: "analytics" },
	glue: { res: "glue", color: "analytics" },
	athena: { res: "athena", color: "analytics" },
	opensearch: { res: "elasticsearch_service", color: "analytics" },
	emr: { res: "emr", color: "analytics" },
	cloudfront: { res: "cloudfront", color: "network" },
	route53: { res: "route_53", color: "network" },
	vpc: { res: "vpc", color: "network" },
	subnet: { glyph: "vpc_virtual_private_cloud_vpc", color: "network" },
	elb: { res: "elastic_load_balancing", color: "network" },
	alb: { glyph: "application_load_balancer", color: "network" },
	nlb: { glyph: "network_load_balancer", color: "network" },
	gwlb: { glyph: "gateway_load_balancer", color: "network" },
	clb: { glyph: "classic_load_balancer", color: "network" },
	igw: { glyph: "internet_gateway", color: "network" },
	nat: { glyph: "nat_gateway", color: "network" },
	endpoint: { glyph: "endpoints", color: "network" },
	routeTable: { glyph: "route_table", color: "network" },
	peering: { glyph: "peering", color: "network" },
	transitGateway: { res: "transit_gateway", color: "network" },
	tgwAttachment: { glyph: "transit_gateway_attachment", color: "network" },
	vpnGateway: { glyph: "vpn_gateway", color: "network" },
	customerGateway: { glyph: "customer_gateway", color: "network" },
	eni: { glyph: "elastic_network_interface", color: "network" },
	eip: { glyph: "elastic_ip_address", color: "compute" },
	nacl: { glyph: "network_access_control_list", color: "network" },
	directConnect: { res: "direct_connect", color: "network" },
	globalAccelerator: { res: "global_accelerator", color: "network" },
	iam: { res: "identity_and_access_management", color: "security" },
	iamRole: { glyph: "role", color: "security" },
	kms: { res: "key_management_service", color: "security" },
	secrets: { res: "secrets_manager", color: "security" },
	acm: { res: "certificate_manager_3", color: "security" },
	waf: { res: "waf", color: "security" },
	cognito: { res: "cognito", color: "security" },
	shield: { res: "shield", color: "security" },
	guardduty: { res: "guardduty", color: "security" },
	securityGroup: { glyph: "generic_firewall", color: "security" },
	cloudwatch: { res: "cloudwatch_2", color: "management" },
	cloudwatchLogs: { glyph: "cloudwatch_logs", color: "management" },
	cloudtrail: { res: "cloudtrail", color: "management" },
	config: { res: "config", color: "management" },
	ssm: { res: "systems_manager", color: "management" },
	ssmParameter: { glyph: "parameter_store", color: "management" },
	cloudformation: { res: "cloudformation", color: "management" },
	organizations: { res: "organizations", color: "management" },
	codebuild: { res: "codebuild", color: "devtools" },
	codepipeline: { res: "codepipeline", color: "devtools" },
	codecommit: { res: "codecommit", color: "devtools" },
	codedeploy: { res: "codedeploy", color: "devtools" },
	sagemaker: { res: "sagemaker", color: "ml" },
	bedrock: { res: "bedrock", color: "ml" },
	amplify: { res: "amplify", color: "frontend" },
	ses: { res: "simple_email_service", color: "frontend" },
	internet: { glyph: "internet_alt2", color: "general" },
	users: { glyph: "users", color: "general" },
	general: { res: "general", color: "general" },
};

export function awsIconStyle(key: string): string {
	const icon = AWS_ICONS[key] ?? AWS_ICONS.general;
	return icon.res ? awsServiceStyle(icon.res, icon.color) : awsGlyphStyle(icon.glyph!, icon.color);
}

/** Every aws4 shape name the styles above can produce (for the existence test). */
export function awsShapeNames(): { resIcons: string[]; glyphs: string[]; groups: string[] } {
	const icons = Object.values(AWS_ICONS);
	return {
		resIcons: [...new Set(icons.filter((i) => i.res).map((i) => i.res!))],
		glyphs: [...new Set(icons.filter((i) => i.glyph).map((i) => i.glyph!))],
		groups: AWS_GROUP_ICONS,
	};
}
