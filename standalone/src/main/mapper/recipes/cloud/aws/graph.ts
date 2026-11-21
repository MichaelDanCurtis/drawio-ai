/**
 * Turns an AWS inventory into a map: account › region › VPC › AZ › subnet ›
 * resources, regional services in their region, global ones in the account, and
 * the connections that can be read from configuration (load balancer targets,
 * CloudFront origins, API integrations, event sources, subscriptions,
 * security-group references, peering and transit gateways).
 */
import type { MapEdge, MapGraph, MapNode } from "../../../types";
import { AWS_GROUPS, awsIconStyle } from "./icons";
import type { AwsInventory, AwsRegionInventory } from "./inventory";

const EDGE = {
	network: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#8C4FFF;fontSize=10;",
	traffic: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#232F3E;fontSize=10;",
	event: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;strokeColor=#E7157B;fontSize=10;",
	sg: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;strokeColor=#DD344C;fontSize=10;fontColor=#DD344C;",
	member: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=none;dashed=1;dashPattern=1 3;strokeColor=#C925D1;",
	link: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;startArrow=block;endFill=1;startFill=1;strokeColor=#8C4FFF;fontSize=10;",
};
const EXTERNAL_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#999999;fontColor=#555555;fontSize=11;";

export const tagName = (tags: any, key = "Name"): string | undefined => (Array.isArray(tags) ? tags.find((t: any) => t?.Key === key)?.Value : undefined) || undefined;
const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
const str = (x: any): string | undefined => (x === undefined || x === null || x === "" ? undefined : String(x));

/** Lambda ARNs may carry a version or alias: arn:aws:lambda:r:a:function:name[:qualifier]. */
export const baseLambdaArn = (arn: string) => arn.split(":").slice(0, 7).join(":");
/** https://sqs.us-east-1.amazonaws.com/123/name → arn:aws:sqs:us-east-1:123:name */
export function queueArn(url: string): string | undefined {
	const m = /^https:\/\/(?:sqs\.)?([a-z0-9-]+)\.(?:queue\.)?amazonaws\.com(?:\.cn)?\/(\d{12})\/([^/?]+)$/.exec(url) ?? /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/([^/?]+)$/.exec(url);
	return m ? `arn:aws:sqs:${m[1]}:${m[2]}:${m[3]}` : undefined;
}
/** A Lambda ARN in an API Gateway integration URI (either form). */
export function lambdaInUri(uri: string | undefined): string | undefined {
	if (!uri) return undefined;
	const m = /(arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_$-]+)?)/.exec(uri);
	return m ? baseLambdaArn(m[1]) : undefined;
}

function portLabel(p: any): string {
	const proto = p?.IpProtocol === "-1" ? "all" : String(p?.IpProtocol ?? "");
	if (proto === "all") return "all traffic";
	const from = p?.FromPort;
	const to = p?.ToPort;
	if (from === undefined || from === -1) return proto;
	return from === to ? `${proto}/${from}` : `${proto}/${from}-${to}`;
}

export interface Finding {
	severity: "high" | "medium" | "info";
	text: string;
}

export interface AwsMap {
	graph: MapGraph;
	facts: string;
	summary: string;
	findings: Finding[];
	counts: Record<string, number>;
}

/** Subnets whose route table sends traffic to an internet gateway (explicit association, else the VPC's main table). */
export function publicSubnets(region: AwsRegionInventory): Map<string, { public: boolean; routeTable?: string; defaultRoute?: string }> {
	const out = new Map<string, { public: boolean; routeTable?: string; defaultRoute?: string }>();
	const mainByVpc = new Map<string, any>();
	const bySubnet = new Map<string, any>();
	for (const rt of region.routeTables) {
		for (const a of arr(rt?.Associations)) {
			if (a?.Main) mainByVpc.set(rt.VpcId, rt);
			if (a?.SubnetId) bySubnet.set(a.SubnetId, rt);
		}
	}
	for (const s of region.subnets) {
		const rt = bySubnet.get(s.SubnetId) ?? mainByVpc.get(s.VpcId);
		const routes = arr(rt?.Routes).filter((r: any) => r?.State !== "blackhole");
		const toIgw = routes.some((r: any) => /^igw-/.test(r?.GatewayId ?? ""));
		const def = routes.find((r: any) => r?.DestinationCidrBlock === "0.0.0.0/0" || r?.DestinationIpv6CidrBlock === "::/0");
		const defaultRoute = def ? str(def.GatewayId ?? def.NatGatewayId ?? def.TransitGatewayId ?? def.VpcPeeringConnectionId ?? def.NetworkInterfaceId ?? def.InstanceId) : undefined;
		out.set(s.SubnetId, { public: toIgw, routeTable: rt?.RouteTableId, defaultRoute });
	}
	return out;
}

/** Collapses more than `max` same-kind leaves in one container into a single counted node. */
export function collapseCrowds(graph: MapGraph, max = 24, groupKey: (n: MapNode) => string = (n) => n.kind): number {
	const groups = new Map<string, MapNode[]>();
	const parents = new Set(graph.nodes.map((n) => n.parent).filter(Boolean));
	for (const n of graph.nodes) {
		if (n.container || parents.has(n.id)) continue;
		const k = `${n.parent ?? ""}\u0000${groupKey(n)}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(n);
	}
	let collapsed = 0;
	const replace = new Map<string, string>();
	const added: MapNode[] = [];
	for (const [k, list] of groups) {
		if (list.length <= max) continue;
		const rest = list.slice(max - 1);
		const id = `crowd:${k.replace(/\u0000/g, "|")}`;
		const sample = rest[0];
		added.push({
			id,
			label: `+${rest.length} more ${groupKey(sample).split(/[:/_]/).pop()}`,
			kind: `${sample.kind}:group`,
			parent: sample.parent,
			shape: sample.shape,
			style: sample.style,
			data: { count: String(rest.length), ids: rest.map((n) => n.data?.id ?? n.id).slice(0, 200).join(", "), ...(sample.data?.region ? { region: sample.data.region } : {}) },
		});
		for (const n of rest) replace.set(n.id, id);
		collapsed += rest.length;
	}
	if (!collapsed) return 0;
	graph.nodes = [...graph.nodes.filter((n) => !replace.has(n.id)), ...added];
	const seen = new Set<string>();
	graph.edges = graph.edges
		.map((e) => ({ ...e, from: replace.get(e.from) ?? e.from, to: replace.get(e.to) ?? e.to }))
		.filter((e) => {
			if (e.from === e.to) return false;
			const key = `${e.from}\u0000${e.to}\u0000${e.kind ?? ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	return collapsed;
}

export interface AwsGraphOptions {
	/**
	 * Group subnets in availability-zone boxes. Off by default: subnets then sit
	 * directly in the VPC, where the layered layout puts them in tiers (public,
	 * application, data), and each subnet's label names its AZ.
	 */
	azGroups?: boolean;
}

/** Builds the map, the agent's facts and review findings from an inventory. */
export function awsInventoryToGraph(inv: AwsInventory, options: AwsGraphOptions = {}): AwsMap {
	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const byId = new Map<string, MapNode>();
	const findings: Finding[] = [];
	const counts: Record<string, number> = {};
	const legendExtra: string[] = [];
	const acct = inv.account;
	const accountId = `account:${acct}`;
	const common = (region?: string): Record<string, string> => ({ account: acct, ...(region ? { region } : {}), ...(inv.profile ? { awsProfile: inv.profile } : {}) });

	const add = (n: MapNode): MapNode => {
		if (byId.has(n.id)) return byId.get(n.id)!;
		nodes.push(n);
		byId.set(n.id, n);
		if (!n.container && !n.kind.startsWith("external")) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
		return n;
	};
	const edgeKeys = new Map<string, MapEdge>();
	const link = (from: string | undefined, to: string | undefined, kind: keyof typeof EDGE, label?: string) => {
		if (!from || !to || from === to) return;
		const key = `${from}\u0000${to}\u0000${kind}`;
		const existing = edgeKeys.get(key);
		if (existing) {
			if (label && existing.label !== label && !(existing.label ?? "").split(", ").includes(label)) existing.label = [existing.label, label].filter(Boolean).join(", ").slice(0, 80);
			return;
		}
		const e: MapEdge = { from, to, kind, style: EDGE[kind], ...(label ? { label } : {}) };
		edgeKeys.set(key, e);
		edges.push(e);
	};
	const icon = (id: string, label: string, kind: string, iconKey: string, parent: string, data: Record<string, string | undefined>) =>
		add({
			id,
			label,
			kind,
			parent,
			shape: "icon",
			style: awsIconStyle(iconKey),
			width: 48,
			height: 48,
			data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>,
		});

	add({ id: accountId, label: `AWS account ${acct}`, kind: "aws:account", container: true, style: AWS_GROUPS.cloud, data: { ...common(), type: "aws:account" } });

	let internetId: string | undefined;
	const internet = () => {
		if (!internetId) {
			internetId = "internet";
			add({ id: internetId, label: "Internet", kind: "external:internet", shape: "icon", style: awsIconStyle("internet"), width: 56, height: 56, data: { type: "internet" } });
		}
		return internetId;
	};

	// Resources by id for edges across services and regions.
	const lambdaIds = new Set<string>();
	const queueIds = new Set<string>();
	const lbByArn = new Map<string, any>();
	const lbByDns = new Map<string, string>();
	const apiIds = new Map<string, string>(); // api id → node id
	const bucketNode = new Map<string, string>();
	const mappedRegions = new Set(inv.regions.map((r) => r.region));

	for (const region of inv.regions) {
		const R = region.region;
		const regionId = `region:${acct}:${R}`;
		add({ id: regionId, label: `Region ${R}`, kind: "aws:region", container: true, parent: accountId, style: AWS_GROUPS.region, data: { ...common(R), type: "aws:region" } });

		// ----- networks -----
		const vpcInfo = new Map<string, any>(region.vpcs.map((v) => [v.VpcId, v]));
		const isPublic = publicSubnets(region);
		for (const v of region.vpcs) {
			const name = tagName(v.Tags);
			add({
				id: v.VpcId,
				label: `VPC ${name ? `${name} · ` : ""}${v.VpcId} · ${v.CidrBlock ?? ""}${v.IsDefault ? " (default)" : ""}`,
				kind: "aws:ec2:vpc",
				container: true,
				parent: regionId,
				style: AWS_GROUPS.vpc,
				data: { ...common(R), type: "AWS::EC2::VPC", id: v.VpcId, cidr: v.CidrBlock, ...(v.IsDefault ? { default: "true" } : {}), ...(name ? { name } : {}) },
			});
		}
		const azNode = (vpcId: string, az: string) => {
			const id = `az:${vpcId}:${az}`;
			if (!byId.has(id)) add({ id, label: az, kind: "aws:az", container: true, parent: vpcId, style: AWS_GROUPS.az, data: { ...common(R), type: "aws:availability-zone", az } });
			return id;
		};
		for (const s of region.subnets) {
			if (!vpcInfo.has(s.VpcId)) continue;
			const info = isPublic.get(s.SubnetId)!;
			const name = tagName(s.Tags);
			add({
				id: s.SubnetId,
				label: `${info.public ? "Public" : "Private"} subnet · ${name ? `${name} · ` : ""}${s.CidrBlock ?? s.SubnetId}${options.azGroups ? "" : ` · ${s.AvailabilityZone ?? ""}`}`,
				kind: info.public ? "aws:ec2:subnet:public" : "aws:ec2:subnet:private",
				container: true,
				parent: options.azGroups ? azNode(s.VpcId, s.AvailabilityZone ?? "az?") : s.VpcId,
				style: info.public ? AWS_GROUPS.publicSubnet : AWS_GROUPS.privateSubnet,
				data: {
					...common(R),
					type: "AWS::EC2::Subnet",
					id: s.SubnetId,
					cidr: s.CidrBlock,
					az: s.AvailabilityZone,
					public: String(info.public),
					...(info.routeTable ? { routeTable: info.routeTable } : {}),
					...(info.defaultRoute ? { defaultRoute: info.defaultRoute } : {}),
					...(s.MapPublicIpOnLaunch ? { mapPublicIpOnLaunch: "true" } : {}),
					...(name ? { name } : {}),
				},
			});
		}
		/** The subnet a resource sits in, else its VPC, else the region. */
		const place = (subnetId?: string, vpcId?: string) => (subnetId && byId.has(subnetId) ? subnetId : vpcId && byId.has(vpcId) ? vpcId : regionId);
		/** For resources given by subnet group + AZ (RDS, ElastiCache). */
		const subnetInAz = (subnets: any[], az?: string) => arr(subnets).find((s: any) => (s?.SubnetAvailabilityZone?.Name ?? s?.AvailabilityZone) === az)?.SubnetIdentifier;

		const igwByVpc = new Map<string, string>();
		for (const g of region.internetGateways) {
			for (const a of arr(g.Attachments)) {
				if (!vpcInfo.has(a.VpcId)) continue;
				icon(g.InternetGatewayId, tagName(g.Tags) ?? g.InternetGatewayId, "aws:ec2:internet-gateway", "igw", a.VpcId, { ...common(R), type: "AWS::EC2::InternetGateway", id: g.InternetGatewayId });
				igwByVpc.set(a.VpcId, g.InternetGatewayId);
				link(internet(), g.InternetGatewayId, "traffic");
			}
		}
		for (const n of region.natGateways) {
			icon(n.NatGatewayId, tagName(n.Tags) ?? n.NatGatewayId, "aws:ec2:nat-gateway", "nat", place(n.SubnetId, n.VpcId), {
				...common(R),
				type: "AWS::EC2::NatGateway",
				id: n.NatGatewayId,
				connectivity: n.ConnectivityType,
				state: n.State,
			});
			const igw = igwByVpc.get(n.VpcId);
			if (igw && n.ConnectivityType !== "private" && isPublic.get(n.SubnetId)?.public) link(n.NatGatewayId, igw, "network", "egress");
		}
		for (const e of region.vpcEndpoints) {
			const svc = String(e.ServiceName ?? "").split(".").pop() ?? "";
			icon(e.VpcEndpointId, `${svc || "endpoint"} (${String(e.VpcEndpointType ?? "").toLowerCase() || "endpoint"})`, "aws:ec2:vpc-endpoint", "endpoint", place(undefined, e.VpcId), {
				...common(R),
				type: "AWS::EC2::VPCEndpoint",
				id: e.VpcEndpointId,
				service: e.ServiceName,
				endpointType: e.VpcEndpointType,
			});
		}
		for (const p of region.peerings) {
			const req = p.RequesterVpcInfo ?? {};
			const acc = p.AccepterVpcInfo ?? {};
			const ends = [req, acc].map((v: any) => {
				if (byId.has(v.VpcId)) return v.VpcId;
				const id = `peer:${v.VpcId}`;
				add({
					id,
					label: `Peer VPC ${v.VpcId}${v.OwnerId && v.OwnerId !== acct ? `\naccount ${v.OwnerId}` : ""}${v.Region ? `\n${v.Region}` : ""}`,
					kind: "external:vpc",
					style: EXTERNAL_STYLE,
					width: 170,
					height: 60,
					data: { type: "AWS::EC2::VPC", id: v.VpcId ?? "", ...(v.OwnerId ? { account: String(v.OwnerId) } : {}), ...(v.Region ? { region: v.Region } : {}) },
				});
				return id;
			});
			link(ends[0], ends[1], "link", `peering ${p.VpcPeeringConnectionId}${p.Status?.Code && p.Status.Code !== "active" ? ` (${p.Status.Code})` : ""}`);
		}
		for (const t of region.transitGateways) {
			icon(t.TransitGatewayId, tagName(t.Tags) ?? t.TransitGatewayId, "aws:ec2:transit-gateway", "transitGateway", regionId, {
				...common(R),
				type: "AWS::EC2::TransitGateway",
				id: t.TransitGatewayId,
				arn: t.TransitGatewayArn,
				owner: t.OwnerId,
			});
		}
		for (const a of region.tgwAttachments) {
			const tgw = a.TransitGatewayId;
			if (!byId.has(tgw)) {
				add({ id: tgw, label: `Transit gateway ${tgw}${a.TransitGatewayOwnerId && a.TransitGatewayOwnerId !== acct ? `\n(account ${a.TransitGatewayOwnerId})` : ""}`, kind: "external:transit-gateway", style: EXTERNAL_STYLE, width: 170, height: 50, data: { type: "AWS::EC2::TransitGateway", id: tgw } });
			}
			if (a.ResourceType === "vpc" && byId.has(a.ResourceId)) link(a.ResourceId, tgw, "link", "TGW attachment");
			else if (a.ResourceType && a.ResourceType !== "vpc") {
				const id = `tgw-attach:${a.TransitGatewayAttachmentId}`;
				add({ id, label: `${a.ResourceType} ${a.ResourceId ?? ""}`.trim(), kind: "external:tgw-attachment", style: EXTERNAL_STYLE, width: 160, height: 40, data: { type: "AWS::EC2::TransitGatewayAttachment", id: a.TransitGatewayAttachmentId, resourceType: a.ResourceType } });
				link(tgw, id, "link");
			}
		}

		// ----- security groups: who is in which group, and what is open to the internet -----
		const sgMembers = new Map<string, Set<string>>();
		const member = (sgIds: any[], nodeId: string) => {
			for (const sg of arr(sgIds)) {
				const id = typeof sg === "string" ? sg : sg?.GroupId ?? sg?.VpcSecurityGroupId ?? sg?.SecurityGroupId;
				if (!id) continue;
				if (!sgMembers.has(id)) sgMembers.set(id, new Set());
				sgMembers.get(id)!.add(nodeId);
			}
		};
		const sgById = new Map<string, any>(region.securityGroups.map((g) => [g.GroupId, g]));
		const openPorts = (sgIds: any[]): string[] => {
			const out = new Set<string>();
			for (const sg of arr(sgIds)) {
				const g = sgById.get(typeof sg === "string" ? sg : sg?.GroupId ?? sg?.VpcSecurityGroupId ?? sg?.SecurityGroupId);
				for (const p of arr(g?.IpPermissions)) {
					const world = arr(p.IpRanges).some((r: any) => r?.CidrIp === "0.0.0.0/0") || arr(p.Ipv6Ranges).some((r: any) => r?.CidrIpv6 === "::/0");
					if (world) out.add(portLabel(p));
				}
			}
			return [...out];
		};
		const riskyOpen = (ports: string[]) => ports.filter((p) => /all traffic|^-1|\/(22|3389|3306|5432|1433|1521|6379|11211|27017|9200|5601|2375|2379)(\b|-)/.test(p));

		// ----- compute -----
		const instanceByIp = new Map<string, string>();
		for (const i of region.instances) {
			const name = tagName(i.Tags);
			const sgs = arr(i.SecurityGroups).map((g: any) => g.GroupId);
			const open = openPorts(sgs);
			const asg = tagName(i.Tags, "aws:autoscaling:groupName");
			icon(i.InstanceId, name ? `${name}\n${i.InstanceId}` : i.InstanceId, "aws:ec2:instance", "ec2", place(i.SubnetId, i.VpcId), {
				...common(R),
				type: "AWS::EC2::Instance",
				id: i.InstanceId,
				arn: `arn:aws:ec2:${R}:${acct}:instance/${i.InstanceId}`,
				instanceType: i.InstanceType,
				state: i.State?.Name,
				az: i.Placement?.AvailabilityZone,
				publicIp: i.PublicIpAddress ? "yes" : "no",
				securityGroups: sgs.join(", "),
				openToInternet: open.join(", "),
				autoScalingGroup: asg,
				iamInstanceProfile: i.IamInstanceProfile?.Arn,
				...(name ? { name } : {}),
			});
			member(sgs, i.InstanceId);
			if (i.PrivateIpAddress) instanceByIp.set(i.PrivateIpAddress, i.InstanceId);
			if (i.PublicIpAddress && open.length) {
				const igw = igwByVpc.get(i.VpcId);
				link(igw ?? internet(), i.InstanceId, "sg", open.slice(0, 4).join(", "));
				const risky = riskyOpen(open);
				if (risky.length) findings.push({ severity: "high", text: `EC2 ${name ?? i.InstanceId} (${R}) has a public IP and allows ${risky.join(", ")} from 0.0.0.0/0.` });
			}
		}

		// ----- load balancers -----
		const tgInfo = new Map<string, any>(region.targetGroups.map((t) => [t.TargetGroupArn, t]));
		for (const lb of region.loadBalancers) {
			const type = String(lb.Type ?? "application");
			const iconKey = type === "network" ? "nlb" : type === "gateway" ? "gwlb" : "alb";
			const azs = arr(lb.AvailabilityZones);
			const open = openPorts(arr(lb.SecurityGroups));
			icon(lb.LoadBalancerArn, lb.LoadBalancerName, `aws:elbv2:${type}`, iconKey, place(undefined, lb.VpcId), {
				...common(R),
				type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
				arn: lb.LoadBalancerArn,
				id: lb.LoadBalancerName,
				lbType: type,
				scheme: lb.Scheme,
				dnsName: lb.DNSName,
				zones: azs.map((z: any) => z.ZoneName).join(", "),
				securityGroups: arr(lb.SecurityGroups).join(", "),
				openToInternet: open.join(", "),
			});
			lbByArn.set(lb.LoadBalancerArn, lb);
			if (lb.DNSName) lbByDns.set(String(lb.DNSName).toLowerCase(), lb.LoadBalancerArn);
			member(arr(lb.SecurityGroups), lb.LoadBalancerArn);
			if (lb.Scheme === "internet-facing") {
				link(igwByVpc.get(lb.VpcId) ?? internet(), lb.LoadBalancerArn, "traffic", open.length ? open.slice(0, 3).join(", ") : "internet-facing");
				findings.push({ severity: "info", text: `Load balancer ${lb.LoadBalancerName} (${R}) is internet-facing${open.length ? ` (${open.join(", ")} open to the world)` : ""}.` });
			}
			if (azs.length === 1) findings.push({ severity: "medium", text: `Load balancer ${lb.LoadBalancerName} (${R}) spans a single AZ (${azs[0]?.ZoneName}).` });
		}
		// ECS services registered in target groups (drawn instead of their task IPs).
		const servicesByTg = new Map<string, string[]>();
		for (const [cluster, services] of Object.entries(region.ecsServices)) {
			for (const s of services) for (const l of arr(s.loadBalancers)) if (l?.targetGroupArn) servicesByTg.set(l.targetGroupArn, [...(servicesByTg.get(l.targetGroupArn) ?? []), s.serviceArn ?? `${cluster}/${s.serviceName}`]);
		}
		const lbTargets = new Map<string, Set<string>>();
		const targetEdges: [string, string, string][] = [];
		for (const [tgArn, health] of Object.entries(region.targetHealth)) {
			const tg = tgInfo.get(tgArn);
			if (!tg) continue;
			for (const lbArn of arr(tg.LoadBalancerArns)) {
				const viaEcs = servicesByTg.get(tgArn);
				const targets: { id: string; state?: string }[] = [];
				if (viaEcs?.length) targets.push(...viaEcs.map((id) => ({ id })));
				else
					for (const h of health) {
						const tid = String(h?.Target?.Id ?? "");
						const id = tg.TargetType === "ip" ? instanceByIp.get(tid) : tg.TargetType === "lambda" ? baseLambdaArn(tid) : tid;
						if (id) targets.push({ id, state: h?.TargetHealth?.State });
					}
				const healthy = health.filter((h) => h?.TargetHealth?.State === "healthy").length;
				for (const t of targets) {
					targetEdges.push([lbArn, t.id, `${tg.TargetGroupName}${tg.Port ? ` :${tg.Port}` : ""}${health.length ? ` (${healthy}/${health.length} healthy)` : ""}`]);
					if (!lbTargets.has(lbArn)) lbTargets.set(lbArn, new Set());
					lbTargets.get(lbArn)!.add(t.id);
				}
				if (health.length > 0 && healthy === 0) findings.push({ severity: "medium", text: `Target group ${tg.TargetGroupName} (${R}) has no healthy targets.` });
			}
		}
		for (const [lbArn, targets] of lbTargets) {
			if (targets.size === 1) findings.push({ severity: "medium", text: `Load balancer ${lbByArn.get(lbArn)?.LoadBalancerName ?? lbArn} (${R}) has a single target: a single point of failure.` });
		}
		for (const clb of region.classicLoadBalancers) {
			const id = `arn:aws:elasticloadbalancing:${R}:${acct}:loadbalancer/${clb.LoadBalancerName}`;
			icon(id, clb.LoadBalancerName, "aws:elb:classic", "clb", place(undefined, clb.VPCId), {
				...common(R),
				type: "AWS::ElasticLoadBalancing::LoadBalancer",
				arn: id,
				id: clb.LoadBalancerName,
				scheme: clb.Scheme,
				dnsName: clb.DNSName,
			});
			if (clb.DNSName) lbByDns.set(String(clb.DNSName).toLowerCase(), id);
			member(arr(clb.SecurityGroups), id);
			if (clb.Scheme === "internet-facing") link(igwByVpc.get(clb.VPCId) ?? internet(), id, "traffic", "internet-facing");
			for (const i of arr(clb.Instances)) targetEdges.push([id, i.InstanceId, "classic"]);
		}

		// ----- databases -----
		const dbVpc = new Map<string, string>();
		for (const d of region.dbInstances) {
			const sg = d.DBSubnetGroup ?? {};
			const subnet = subnetInAz(sg.Subnets, d.AvailabilityZone);
			const vpcSgs = arr(d.VpcSecurityGroups).map((g: any) => g.VpcSecurityGroupId);
			const aurora = /aurora/.test(d.Engine ?? "");
			icon(d.DBInstanceArn ?? d.DBInstanceIdentifier, d.DBInstanceIdentifier, "aws:rds:db-instance", aurora ? "aurora" : "rds", place(subnet, sg.VpcId), {
				...common(R),
				type: "AWS::RDS::DBInstance",
				arn: d.DBInstanceArn,
				id: d.DBInstanceIdentifier,
				engine: `${d.Engine ?? ""} ${d.EngineVersion ?? ""}`.trim(),
				instanceClass: d.DBInstanceClass,
				multiAZ: String(!!d.MultiAZ),
				publiclyAccessible: String(!!d.PubliclyAccessible),
				storageEncrypted: String(!!d.StorageEncrypted),
				az: d.AvailabilityZone,
				cluster: d.DBClusterIdentifier,
				securityGroups: vpcSgs.join(", "),
			});
			if (sg.VpcId) dbVpc.set(d.DBInstanceIdentifier, sg.VpcId);
			// Cluster members are reached through their cluster (drawn once, below).
			if (!d.DBClusterIdentifier) member(vpcSgs, d.DBInstanceArn ?? d.DBInstanceIdentifier);
			if (d.PubliclyAccessible) findings.push({ severity: "high", text: `RDS ${d.DBInstanceIdentifier} (${R}) is publicly accessible.` });
			if (!d.StorageEncrypted) findings.push({ severity: "medium", text: `RDS ${d.DBInstanceIdentifier} (${R}) storage is not encrypted.` });
			if (!d.MultiAZ && !d.DBClusterIdentifier) findings.push({ severity: "medium", text: `RDS ${d.DBInstanceIdentifier} (${R}) is single-AZ.` });
		}
		const dbArnById = new Map(region.dbInstances.map((d) => [d.DBInstanceIdentifier, d.DBInstanceArn ?? d.DBInstanceIdentifier]));
		for (const c of region.dbClusters) {
			const members = arr(c.DBClusterMembers);
			const vpc = members.map((m: any) => dbVpc.get(m.DBInstanceIdentifier)).find(Boolean);
			const aurora = /aurora/.test(c.Engine ?? "");
			const id = c.DBClusterArn ?? c.DBClusterIdentifier;
			const vpcSgs = arr(c.VpcSecurityGroups).map((g: any) => g.VpcSecurityGroupId);
			icon(id, c.DBClusterIdentifier, "aws:rds:db-cluster", aurora ? "aurora" : "rds", place(undefined, vpc), {
				...common(R),
				type: "AWS::RDS::DBCluster",
				arn: c.DBClusterArn,
				id: c.DBClusterIdentifier,
				engine: `${c.Engine ?? ""} ${c.EngineVersion ?? ""}`.trim(),
				multiAZ: String(!!c.MultiAZ),
				storageEncrypted: String(!!c.StorageEncrypted),
				members: members.map((m: any) => `${m.DBInstanceIdentifier}${m.IsClusterWriter ? " (writer)" : ""}`).join(", "),
			});
			for (const m of members) link(id, dbArnById.get(m.DBInstanceIdentifier), "member");
			member(vpcSgs, id);
			if (!c.StorageEncrypted) findings.push({ severity: "medium", text: `RDS cluster ${c.DBClusterIdentifier} (${R}) storage is not encrypted.` });
			if (members.length === 1) findings.push({ severity: "medium", text: `RDS cluster ${c.DBClusterIdentifier} (${R}) has a single instance.` });
		}
		const cacheGroups = new Map<string, any>(region.cacheSubnetGroups.map((g) => [g.CacheSubnetGroupName, g]));
		for (const c of region.cacheClusters) {
			const g = cacheGroups.get(c.CacheSubnetGroupName);
			const subnet = subnetInAz(g?.Subnets, c.PreferredAvailabilityZone);
			const id = c.ARN ?? c.CacheClusterId;
			const sgs = arr(c.SecurityGroups).map((s: any) => s.SecurityGroupId);
			icon(id, c.CacheClusterId, "aws:elasticache:cluster", "elasticache", place(subnet, g?.VpcId), {
				...common(R),
				type: "AWS::ElastiCache::CacheCluster",
				arn: c.ARN,
				id: c.CacheClusterId,
				engine: `${c.Engine ?? ""} ${c.EngineVersion ?? ""}`.trim(),
				nodeType: c.CacheNodeType,
				replicationGroup: c.ReplicationGroupId,
				atRestEncryption: String(!!c.AtRestEncryptionEnabled),
				transitEncryption: String(!!c.TransitEncryptionEnabled),
				az: c.PreferredAvailabilityZone,
			});
			member(sgs, id);
			if (!c.AtRestEncryptionEnabled || !c.TransitEncryptionEnabled)
				findings.push({ severity: "medium", text: `ElastiCache ${c.CacheClusterId} (${R}): encryption at rest ${c.AtRestEncryptionEnabled ? "on" : "off"}, in transit ${c.TransitEncryptionEnabled ? "on" : "off"}.` });
		}
		for (const name of region.dynamoTables) {
			const id = `arn:aws:dynamodb:${R}:${acct}:table/${name}`;
			icon(id, name, "aws:dynamodb:table", "dynamodb", regionId, { ...common(R), type: "AWS::DynamoDB::Table", arn: id, id: name });
		}

		// ----- serverless and containers -----
		for (const f of region.lambdas) {
			const vpc = f.VpcConfig?.VpcId;
			const sgs = arr(f.VpcConfig?.SecurityGroupIds);
			icon(f.FunctionArn, f.FunctionName, "aws:lambda:function", "lambda", place(undefined, vpc || undefined), {
				...common(R),
				type: "AWS::Lambda::Function",
				arn: f.FunctionArn,
				id: f.FunctionName,
				runtime: f.Runtime ?? f.PackageType,
				memoryMB: str(f.MemorySize),
				timeoutS: str(f.Timeout),
				subnets: arr(f.VpcConfig?.SubnetIds).join(", "),
				securityGroups: sgs.join(", "),
			});
			lambdaIds.add(f.FunctionArn);
			member(sgs, f.FunctionArn);
		}
		for (const c of region.ecsClusters) {
			const services = region.ecsServices[c.clusterArn] ?? [];
			const cid = c.clusterArn;
			add({
				id: cid,
				label: `ECS cluster ${c.clusterName}`,
				kind: "aws:ecs:cluster",
				container: true,
				parent: regionId,
				style: AWS_GROUPS.ecsCluster,
				data: { ...common(R), type: "AWS::ECS::Cluster", arn: cid, id: c.clusterName, status: c.status, runningTasks: str(c.runningTasksCount) ?? "0", services: str(c.activeServicesCount) ?? "0" },
			});
			for (const s of services) {
				const net = s.networkConfiguration?.awsvpcConfiguration;
				const sid = s.serviceArn ?? `${cid}/${s.serviceName}`;
				icon(sid, `${s.serviceName}\n${s.runningCount ?? 0}/${s.desiredCount ?? 0} tasks`, "aws:ecs:service", "ecsService", cid, {
					...common(R),
					type: "AWS::ECS::Service",
					arn: s.serviceArn,
					id: s.serviceName,
					cluster: c.clusterName,
					launchType: s.launchType ?? arr(s.capacityProviderStrategy).map((p: any) => p.capacityProvider).join(", "),
					desired: str(s.desiredCount),
					running: str(s.runningCount),
					subnets: arr(net?.subnets).join(", "),
					securityGroups: arr(net?.securityGroups).join(", "),
					assignPublicIp: net?.assignPublicIp,
					taskDefinition: s.taskDefinition,
				});
				member(arr(net?.securityGroups), sid);
				if ((s.desiredCount ?? 0) === 1) findings.push({ severity: "info", text: `ECS service ${s.serviceName} (${R}) runs a single task.` });
			}
		}
		for (const k of region.eksClusters) {
			const vpcCfg = k.resourcesVpcConfig ?? {};
			icon(k.arn ?? k.name, k.name, "aws:eks:cluster", "eks", place(undefined, vpcCfg.vpcId), {
				...common(R),
				type: "AWS::EKS::Cluster",
				arn: k.arn,
				id: k.name,
				version: k.version,
				status: k.status,
				endpointPublicAccess: String(!!vpcCfg.endpointPublicAccess),
				endpointPrivateAccess: String(!!vpcCfg.endpointPrivateAccess),
				publicAccessCidrs: arr(vpcCfg.publicAccessCidrs).join(", "),
				subnets: arr(vpcCfg.subnetIds).join(", "),
			});
			member([vpcCfg.clusterSecurityGroupId, ...arr(vpcCfg.securityGroupIds)].filter(Boolean), k.arn ?? k.name);
			if (vpcCfg.endpointPublicAccess && arr(vpcCfg.publicAccessCidrs).includes("0.0.0.0/0"))
				findings.push({ severity: "medium", text: `EKS ${k.name} (${R}) API endpoint is public to 0.0.0.0/0.` });
		}
		for (const url of region.queueUrls) {
			const arn = queueArn(url) ?? url;
			const name = url.split("/").pop()!;
			icon(arn, name, "aws:sqs:queue", "sqs", regionId, { ...common(R), type: "AWS::SQS::Queue", arn, id: name, url });
			queueIds.add(arn);
		}
		const subsByTopic = new Map<string, any[]>();
		for (const s of region.subscriptions) subsByTopic.set(s.TopicArn, [...(subsByTopic.get(s.TopicArn) ?? []), s]);
		for (const t of region.topicArns) {
			const subs = subsByTopic.get(t) ?? [];
			const other = new Map<string, number>();
			for (const s of subs) if (!["sqs", "lambda"].includes(s.Protocol)) other.set(s.Protocol, (other.get(s.Protocol) ?? 0) + 1);
			icon(t, t.split(":").pop()!, "aws:sns:topic", "sns", regionId, {
				...common(R),
				type: "AWS::SNS::Topic",
				arn: t,
				id: t.split(":").pop(),
				subscriptions: String(subs.length),
				otherSubscribers: [...other].map(([p, n]) => `${p}×${n}`).join(", "),
			});
		}
		for (const api of region.restApis) {
			const id = `arn:aws:apigateway:${R}::/restapis/${api.id}`;
			const types = arr(api.endpointConfiguration?.types).join(", ");
			icon(id, `${api.name}\nREST`, "aws:apigateway:rest-api", "apigateway", regionId, { ...common(R), type: "AWS::ApiGateway::RestApi", arn: id, id: api.id, name: api.name, endpointTypes: types });
			apiIds.set(api.id, id);
			if (!/PRIVATE/.test(types)) link(internet(), id, "traffic");
			for (const res of region.restResources[api.id] ?? []) {
				for (const [method, m] of Object.entries<any>(res?.resourceMethods ?? {})) {
					const fn = lambdaInUri(m?.methodIntegration?.uri);
					if (fn) link(id, fn, "traffic", `${method} ${res.path ?? ""}`.trim());
				}
			}
		}
		for (const api of region.httpApis) {
			const id = `arn:aws:apigateway:${R}::/apis/${api.ApiId}`;
			icon(id, `${api.Name}\n${api.ProtocolType ?? "HTTP"}`, "aws:apigateway:http-api", "apigateway", regionId, {
				...common(R),
				type: "AWS::ApiGatewayV2::Api",
				arn: id,
				id: api.ApiId,
				name: api.Name,
				protocol: api.ProtocolType,
				endpoint: api.ApiEndpoint,
			});
			apiIds.set(api.ApiId, id);
			if (!api.DisableExecuteApiEndpoint) link(internet(), id, "traffic");
			for (const integ of region.httpIntegrations[api.ApiId] ?? []) {
				const fn = lambdaInUri(integ?.IntegrationUri);
				if (fn) link(id, fn, "traffic");
				else if (/:listener\//.test(integ?.IntegrationUri ?? "")) {
					const lbArn = String(integ.IntegrationUri).replace(":listener/", ":loadbalancer/").split("/").slice(0, -1).join("/");
					link(id, lbArn, "traffic", "VPC link");
				}
			}
		}

		// Edges that need every node of the region.
		for (const [from, to, label] of targetEdges) link(from, to, "traffic", label);
		for (const m of region.eventSourceMappings) {
			const src = String(m.EventSourceArn ?? "");
			const fn = baseLambdaArn(String(m.FunctionArn ?? ""));
			let from: string | undefined;
			if (src.startsWith("arn:aws:sqs:")) from = src;
			else if (src.includes(":dynamodb:")) from = src.replace(/\/stream\/.*$/, "");
			else if (src) {
				const service = src.split(":")[2] ?? "source";
				const name = src.split(/[:/]/).pop() ?? src;
				from = src;
				if (!byId.has(src)) icon(src, name, `aws:${service}:event-source`, service === "kinesis" ? "kinesis" : service === "kafka" ? "msk" : service === "mq" ? "mq" : "general", regionId, { ...common(R), type: `${service} event source`, arn: src });
			}
			if (from && !byId.has(from) && from.startsWith("arn:aws:sqs:")) {
				icon(from, from.split(":").pop()!, "aws:sqs:queue", "sqs", regionId, { ...common(R), type: "AWS::SQS::Queue", arn: from });
			}
			link(from, fn, "event", m.State && m.State !== "Enabled" ? `event source (${m.State})` : "event source");
		}
		for (const s of region.subscriptions) {
			if (s.Protocol === "sqs") link(s.TopicArn, s.Endpoint, "event", "subscription");
			if (s.Protocol === "lambda") link(s.TopicArn, baseLambdaArn(String(s.Endpoint ?? "")), "event", "subscription");
		}

		// Security-group references: "A allows from B" draws B → A with the ports.
		for (const g of region.securityGroups) {
			const targets = sgMembers.get(g.GroupId);
			for (const p of arr(g.IpPermissions)) {
				for (const pair of arr(p.UserIdGroupPairs)) {
					const src = pair?.GroupId;
					if (!src || src === g.GroupId) continue;
					const sources = sgMembers.get(src);
					if (!targets?.size || !sources?.size) continue;
					const label = portLabel(p);
					if (sources.size * targets.size <= 9) {
						for (const a of sources) for (const b of targets) link(a, b, "sg", label);
					} else {
						const sgNode = (sg: string) => {
							const info = sgById.get(sg);
							const id = `sg:${sg}`;
							if (!byId.has(id)) icon(id, `SG ${info?.GroupName ?? sg}`, "aws:ec2:security-group", "securityGroup", place(undefined, info?.VpcId), { ...common(R), type: "AWS::EC2::SecurityGroup", id: sg, name: info?.GroupName, members: String(sgMembers.get(sg)?.size ?? 0) });
							return id;
						};
						link(sgNode(src), sgNode(g.GroupId), "sg", label);
					}
				}
			}
		}

		// NAT gateways: private subnets in several AZs behind one NAT.
		for (const v of region.vpcs) {
			const nats = region.natGateways.filter((n) => n.VpcId === v.VpcId && n.State === "available");
			const privAz = new Set(region.subnets.filter((s) => s.VpcId === v.VpcId && !isPublic.get(s.SubnetId)?.public && /^nat-/.test(isPublic.get(s.SubnetId)?.defaultRoute ?? "")).map((s) => s.AvailabilityZone));
			if (nats.length === 1 && privAz.size > 1) findings.push({ severity: "medium", text: `VPC ${tagName(v.Tags) ?? v.VpcId} (${R}) routes ${privAz.size} AZs through one NAT gateway: a single point of failure.` });
		}
		for (const s of region.subnets) {
			if (vpcInfo.has(s.VpcId) && s.MapPublicIpOnLaunch && !isPublic.get(s.SubnetId)?.public) {
				// Harmless but surprising: public IPs in a subnet without an internet route.
				findings.push({ severity: "info", text: `Subnet ${s.SubnetId} (${R}) assigns public IPs but has no internet gateway route.` });
			}
		}
	}

	// ----- global: S3 and CloudFront -----
	let s3Group: string | undefined;
	for (const b of inv.buckets) {
		const arn = `arn:aws:s3:::${b.name}`;
		let parent: string;
		if (b.region && mappedRegions.has(b.region)) parent = `region:${acct}:${b.region}`;
		else {
			if (!s3Group) {
				s3Group = `s3:${acct}`;
				add({ id: s3Group, label: "S3 buckets in other regions", kind: "aws:s3:group", container: true, parent: accountId, style: AWS_GROUPS.generic, data: { ...common(), type: "aws:s3:buckets" } });
			}
			parent = s3Group;
		}
		icon(arn, b.name, "aws:s3:bucket", "s3", parent, { ...common(b.region), type: "AWS::S3::Bucket", arn, id: b.name });
		bucketNode.set(b.name, arn);
	}
	for (const d of inv.distributions) {
		const id = d.ARN ?? `cloudfront:${d.Id}`;
		const aliases = arr(d.Aliases?.Items);
		icon(id, `${aliases[0] ?? d.DomainName ?? d.Id}\nCloudFront`, "aws:cloudfront:distribution", "cloudfront", accountId, {
			...common(),
			type: "AWS::CloudFront::Distribution",
			arn: d.ARN,
			id: d.Id,
			domain: d.DomainName,
			aliases: aliases.join(", "),
			enabled: String(d.Enabled !== false),
			webAcl: d.WebACLId || "none",
			priceClass: d.PriceClass,
		});
		link(internet(), id, "traffic");
		if (!d.WebACLId) findings.push({ severity: "info", text: `CloudFront ${aliases[0] ?? d.Id} has no WAF web ACL.` });
		for (const o of arr(d.Origins?.Items)) {
			const domain = String(o.DomainName ?? "").toLowerCase();
			const bucket = /^(.+?)\.s3(?:[.-]website)?[.-]/.exec(domain)?.[1];
			const api = /^([a-z0-9]+)\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.exec(domain)?.[1];
			let target = (bucket && bucketNode.get(bucket)) || lbByDns.get(domain) || (api && apiIds.get(api)) || undefined;
			if (!target) {
				target = `origin:${domain}`;
				add({ id: target, label: domain, kind: "external:origin", style: EXTERNAL_STYLE, width: Math.min(260, Math.max(150, domain.length * 7 + 20)), height: 40, data: { type: "origin", domain } });
			}
			link(id, target, "traffic", o.Id && o.Id !== domain ? `origin ${o.Id}`.slice(0, 50) : "origin");
		}
	}

	// ----- tidy up: hide empty default VPCs and regions with nothing in them -----
	const descendants = (id: string): Set<string> => {
		const out = new Set<string>([id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const n of nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) (out.add(n.id), (grew = true));
		}
		return out;
	};
	const drop = new Set<string>();
	let hiddenVpcs = 0;
	for (const n of nodes.filter((x) => x.kind === "aws:ec2:vpc" && x.data?.default === "true")) {
		const inside = descendants(n.id);
		const hasResources = [...inside].some((id) => {
			const k = byId.get(id)!.kind;
			return !/^aws:(az|ec2:subnet|ec2:internet-gateway|ec2:vpc)/.test(k);
		});
		const linked = edges.some((e) => e.kind !== "traffic" && (inside.has(e.from) || inside.has(e.to)));
		if (!hasResources && !linked) {
			for (const id of inside) drop.add(id);
			hiddenVpcs++;
		}
	}
	const hiddenRegions: string[] = [];
	for (const n of nodes.filter((x) => x.kind === "aws:region")) {
		const inside = [...descendants(n.id)].filter((id) => id !== n.id && !drop.has(id));
		if (inside.length === 0) {
			drop.add(n.id);
			hiddenRegions.push(String(n.data?.region));
		}
	}
	if (drop.size) {
		for (const id of drop) counts[byId.get(id)!.kind] = Math.max(0, (counts[byId.get(id)!.kind] ?? 1) - 1);
	}
	let finalNodes = nodes.filter((n) => !drop.has(n.id));
	let finalEdges = edges.filter((e) => !drop.has(e.from) && !drop.has(e.to));
	// An Internet node with nothing left to point at goes too.
	if (internetId && !finalEdges.some((e) => e.from === internetId || e.to === internetId)) finalNodes = finalNodes.filter((n) => n.id !== internetId);
	if (hiddenVpcs) legendExtra.push(`${hiddenVpcs} default VPC(s) without resources are not drawn.`);
	if (hiddenRegions.length) legendExtra.push(`No resources found in ${hiddenRegions.length > 6 ? `${hiddenRegions.length} regions` : hiddenRegions.join(", ")}.`);

	const graph: MapGraph = {
		title: `AWS ${acct}`,
		nodes: finalNodes,
		edges: finalEdges,
		direction: "down",
		legend: [],
	};
	const collapsed = collapseCrowds(graph);
	if (collapsed) legendExtra.push(`${collapsed} resources folded into "+N more" shapes (their ids are in the shape data).`);
	const resources = graph.nodes.filter((n) => !n.container && !n.kind.startsWith("external") && !n.kind.endsWith(":empty")).length;
	graph.legend = [
		`AWS account ${acct}${inv.profile ? ` (profile ${inv.profile})` : ""}, ${inv.regions.length > 5 ? `${inv.regions.length} regions` : inv.regions.map((r) => r.region).join(", ") || "no regions"}: mapped read-only.`,
		`Green subnets are public (route to an internet gateway), blue ones private. Dark arrows: traffic (internet, load balancer targets, origins, API integrations); pink dashed: events and subscriptions; red dashed: security-group rules (B → A: A allows B); purple: peering / transit gateway.`,
		...legendExtra,
	];
	const nonZero = Object.fromEntries(Object.entries(counts).filter(([, v]) => v > 0));
	const summary = `${resources} resources in ${inv.regions.length - hiddenRegions.length} region(s) of account ${acct}${findings.filter((f) => f.severity !== "info").length ? `, ${findings.filter((f) => f.severity !== "info").length} review finding(s)` : ""}`;
	return { graph, facts: factsOf(inv, graph, findings), summary, findings, counts: nonZero };
}

/** A compact inventory the agent can dig into: one line per resource with its ids. */
function factsOf(inv: AwsInventory, graph: MapGraph, findings: Finding[]): string {
	const lines: string[] = [`# AWS inventory (collected read-only)`, `Account ${inv.account}${inv.profile ? `, profile ${inv.profile}` : ""}; regions: ${inv.regions.map((r) => r.region).join(", ")}; services: ${inv.services.join(", ")}.`, ""];
	const byParent = new Map<string | undefined, MapNode[]>();
	for (const n of graph.nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
	const skip = new Set(["account", "awsProfile", "region"]);
	const walk = (parent: string | undefined, depth: number) => {
		for (const n of byParent.get(parent) ?? []) {
			const d = Object.entries(n.data ?? {})
				.filter(([k]) => !skip.has(k))
				.map(([k, v]) => `${k}=${v}`)
				.join("; ");
			lines.push(`${"  ".repeat(depth)}- ${n.label.replace(/\n/g, " · ")} [${n.kind}]${d ? ` ${d}` : ""}`);
			walk(n.id, depth + 1);
		}
	};
	walk(undefined, 0);
	const ids = new Map(graph.nodes.map((n) => [n.id, n.label.replace(/\n/g, " ")]));
	if (graph.edges.length) {
		lines.push("", "## Connections");
		for (const e of graph.edges) lines.push(`- ${ids.get(e.from) ?? e.from} → ${ids.get(e.to) ?? e.to}${e.kind ? ` (${e.kind}${e.label ? `: ${e.label}` : ""})` : ""}`);
	}
	if (findings.length) {
		lines.push("", "## Review findings (heuristic)");
		for (const f of findings) lines.push(`- [${f.severity}] ${f.text}`);
	}
	return lines.join("\n");
}
