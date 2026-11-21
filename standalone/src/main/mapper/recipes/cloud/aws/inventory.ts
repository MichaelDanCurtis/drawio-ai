/**
 * What the AWS collector reads: the CLI's JSON answers, kept per region. The
 * graph builder picks the fields it draws; nothing here is shown as-is.
 */

export interface AwsRegionInventory {
	region: string;
	vpcs: any[];
	subnets: any[];
	routeTables: any[];
	internetGateways: any[];
	natGateways: any[];
	vpcEndpoints: any[];
	peerings: any[];
	transitGateways: any[];
	tgwAttachments: any[];
	securityGroups: any[];
	instances: any[];
	loadBalancers: any[];
	targetGroups: any[];
	/** Target health per target group ARN. */
	targetHealth: Record<string, any[]>;
	classicLoadBalancers: any[];
	dbInstances: any[];
	dbClusters: any[];
	lambdas: any[];
	eventSourceMappings: any[];
	ecsClusters: any[];
	/** ECS services per cluster ARN. */
	ecsServices: Record<string, any[]>;
	eksClusters: any[];
	dynamoTables: string[];
	queueUrls: string[];
	topicArns: string[];
	subscriptions: any[];
	restApis: any[];
	/** REST API resources (with their methods' integrations) per API id. */
	restResources: Record<string, any[]>;
	httpApis: any[];
	/** HTTP/WebSocket API integrations per API id. */
	httpIntegrations: Record<string, any[]>;
	cacheClusters: any[];
	cacheSubnetGroups: any[];
}

export interface AwsInventory {
	account: string;
	/** The caller's ARN (who mapped it). */
	callerArn?: string;
	profile?: string;
	regions: AwsRegionInventory[];
	/** S3 buckets with their region. */
	buckets: { name: string; region?: string }[];
	distributions: any[];
	/** Service keys that were collected (network is always collected). */
	services: string[];
}

export const AWS_SERVICES = ["ec2", "elb", "rds", "lambda", "ecs", "eks", "dynamodb", "sqs", "sns", "apigateway", "elasticache", "s3", "cloudfront"] as const;
export type AwsService = (typeof AWS_SERVICES)[number];

export function emptyRegion(region: string): AwsRegionInventory {
	return {
		region,
		vpcs: [],
		subnets: [],
		routeTables: [],
		internetGateways: [],
		natGateways: [],
		vpcEndpoints: [],
		peerings: [],
		transitGateways: [],
		tgwAttachments: [],
		securityGroups: [],
		instances: [],
		loadBalancers: [],
		targetGroups: [],
		targetHealth: {},
		classicLoadBalancers: [],
		dbInstances: [],
		dbClusters: [],
		lambdas: [],
		eventSourceMappings: [],
		ecsClusters: [],
		ecsServices: {},
		eksClusters: [],
		dynamoTables: [],
		queueUrls: [],
		topicArns: [],
		subscriptions: [],
		restApis: [],
		restResources: {},
		httpApis: [],
		httpIntegrations: {},
		cacheClusters: [],
		cacheSubnetGroups: [],
	};
}
