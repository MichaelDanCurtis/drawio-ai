// Tests for the AWS inventory mapper and the infrastructure-as-code mappers.
// Run from standalone/: node --test test/aws-iac.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("./helpers/ts");

const { checkReadOnly } = require("../src/main/mapper/readOnly");
const { renderGraph } = require("../src/main/mapper/render");
const { layoutGraph } = require("../src/main/mapper/layout");
const { checkModelXml } = require("./helpers/xml");
const aws = require("../src/main/mapper/recipes/cloud/aws");
const { awsShapeNames } = require("../src/main/mapper/recipes/cloud/aws/icons");
const { catalog } = require("../src/main/mapper/registry");

const WEBAPP = path.resolve(__dirname, "../../drawio/src/main/webapp");
const FIX = path.join(__dirname, "fixtures");

// ----- a fake `aws` CLI that answers from recorded JSON -----

const ID_ARGS = ["--target-group-arn", "--cluster", "--name", "--rest-api-id", "--api-id", "--bucket"];
function fakeAws(responses, calls = []) {
	return async (command, args) => {
		const refused = checkReadOnly(command, args);
		if (refused) throw new Error(`refused: ${refused}`);
		calls.push([command, ...args]);
		const [service, op] = args;
		const opt = (name) => {
			const i = args.indexOf(name);
			return i >= 0 ? args[i + 1] : undefined;
		};
		const region = opt("--region");
		const idArg = ID_ARGS.map(opt).find(Boolean);
		const keys = [
			region && idArg && `${region}|${service} ${op}|${idArg}`,
			idArg && `${service} ${op}|${idArg}`,
			region && `${region}|${service} ${op}`,
			`${service} ${op}`,
		].filter(Boolean);
		const hit = keys.find((k) => k in responses);
		if (!hit) return { stdout: region === "us-east-1" || !region ? "{}" : "{}", stderr: "", code: 0 };
		const r = responses[hit];
		if (r && r.$error) return { stdout: "", stderr: r.$error, code: 254 };
		if (r && r.$text !== undefined) return { stdout: r.$text, stderr: "", code: 0 };
		return { stdout: JSON.stringify(r), stderr: "", code: 0 };
	};
}
const ctxWith = (exec, progress = []) => ({ cwd: os.tmpdir(), progress: (t) => progress.push(t), signal: new AbortController().signal, exec });

const SEVERITIES = new Set(["high", "medium", "low", "info"]);
/** The findings contract: unique stable ids `${kind}:…`, known severities, plain titles, nodes that are drawn; coverage with counts. */
function assertFindingsContract(result) {
	const ids = new Set(result.graph.nodes.map((n) => n.id));
	const seen = new Set();
	for (const f of result.findings) {
		assert.ok(f.id.startsWith(`${f.kind}:`), f.id);
		assert.ok(!seen.has(f.id), `duplicate finding id ${f.id}`);
		seen.add(f.id);
		assert.ok(SEVERITIES.has(f.severity), f.severity);
		assert.ok(f.title && !f.title.includes("\n"), f.title);
		assert.ok(f.detail && f.fix, `${f.id} has evidence and a fix`);
		assert.ok(f.nodeIds.length > 0, `${f.id} has nodes`);
		for (const n of f.nodeIds) assert.ok(ids.has(n), `${f.id}: node ${n} is not in the graph`);
	}
	assert.ok(Array.isArray(result.checked) && result.checked.length > 0, "checked is filled");
	for (const c of result.checked) assert.ok(c.check && Number.isInteger(c.scanned) && c.scanned >= 0, JSON.stringify(c));
}
const findingOf = (result, kind, nodeId) => result.findings.find((f) => f.kind === kind && f.nodeIds.includes(nodeId));
const checkOf = (result, re) => result.checked.find((c) => re.test(c.check));
const loadResponses = () => JSON.parse(fs.readFileSync(path.join(FIX, "aws/responses.json"), "utf8"));

// ----- draw.io shape names -----

function aws4Names() {
	const t = fs.readFileSync(path.join(WEBAPP, "js/diagramly/sidebar/Sidebar-AWS4.js"), "utf8");
	return {
		res: new Set([...t.matchAll(/resIcon=' \+ gn \+ '\.([a-z0-9_]+);/g)].map((m) => m[1])),
		shape: new Set([...t.matchAll(/\(n[0-9]? \+ '([a-z0-9_]+);/g)].map((m) => m[1])),
		group: new Set([...t.matchAll(/grIcon=' \+ gn \+ '\.([a-z0-9_]+);/g)].map((m) => m[1])),
		groupShapes: new Set([...t.matchAll(/n4 \+ '(group[A-Za-z]*);/g)].map((m) => m[1])),
	};
}

/** Every mxgraph.aws4 name in a style string exists in draw.io. */
function assertAws4StylesExist(xml, names = aws4Names()) {
	const used = [...xml.matchAll(/(resIcon|grIcon|shape)=mxgraph\.aws4\.([a-zA-Z0-9_]+)/g)];
	assert.ok(used.length > 0, "no aws4 shapes used");
	for (const [, attr, name] of used) {
		if (attr === "resIcon") assert.ok(names.res.has(name), `resIcon ${name} is not a draw.io aws4 icon`);
		else if (attr === "grIcon") assert.ok(names.group.has(name), `grIcon ${name} is not a draw.io aws4 group icon`);
		else assert.ok(name === "resourceIcon" || names.shape.has(name) || names.groupShapes.has(name), `shape mxgraph.aws4.${name} is not in draw.io`);
	}
	return used.length;
}

test("aws4 icon table: every resIcon, glyph and group name exists in draw.io's Sidebar-AWS4.js", { skip: !fs.existsSync(WEBAPP) }, () => {
	const names = aws4Names();
	const { resIcons, glyphs, groups } = awsShapeNames();
	for (const r of resIcons) assert.ok(names.res.has(r), `resIcon ${r}`);
	for (const g of glyphs) assert.ok(names.shape.has(g), `glyph ${g}`);
	for (const g of groups) assert.ok(names.group.has(g), `group ${g}`);
	assert.ok(names.groupShapes.has("group") && names.groupShapes.has("groupCenter"));
});

test("aws: inputs are parsed", () => {
	assert.deepEqual(aws.parseRegions("us-east-1, eu-west-1 us-east-1"), ["us-east-1", "eu-west-1"]);
	assert.equal(aws.parseRegions("all enabled"), "all");
	assert.deepEqual(aws.parseRegions(""), []);
	assert.deepEqual(aws.parseServices("ec2, ALB redis bogus").sort(), ["ec2", "elasticache", "elb"]);
	assert.equal(aws.parseServices("").length, 13);
	assert.equal(aws.awsErrorCode("\nAn error occurred (AccessDenied) when calling the X operation: no"), "AccessDenied");
	assert.equal(aws.awsErrorCode("aws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'."), "ExpiredToken");
});

test("aws: subnets are public when their route table (explicit, else the main one) routes to an internet gateway", () => {
	const r = loadResponses();
	const region = {
		subnets: r["us-east-1|ec2 describe-subnets"].Subnets,
		routeTables: r["us-east-1|ec2 describe-route-tables"].RouteTables,
	};
	const p = aws.publicSubnets(region);
	assert.equal(p.get("subnet-pub-a").public, true);
	assert.equal(p.get("subnet-pub-a").routeTable, "rtb-pub");
	assert.equal(p.get("subnet-priv-a").public, false, "main table routes to a NAT gateway");
	assert.equal(p.get("subnet-priv-a").routeTable, "rtb-main");
	assert.equal(p.get("subnet-priv-a").defaultRoute, "nat-1");
	assert.equal(p.get("subnet-data-b").public, false);
	assert.equal(p.get("subnet-data-b").defaultRoute, undefined);
	assert.equal(p.get("subnet-def-a").public, true, "default VPC main table has an IGW route");
});

async function collectFixture(input = { profile: "example", regions: "us-east-1, eu-west-3" }) {
	const calls = [];
	const progress = [];
	const result = await aws.awsRecipes[0].collect(input, ctxWith(fakeAws(loadResponses(), calls), progress));
	return { result, calls, progress };
}

test("aws: collects a recorded account read-only, with profile, region and JSON output on every call", async () => {
	const { result, calls, progress } = await collectFixture();
	assert.ok(calls.length > 30, `${calls.length} calls`);
	for (const c of calls) {
		assert.equal(c[0], "aws");
		assert.equal(checkReadOnly(c[0], c.slice(1)), undefined, c.join(" "));
		if (!(c[1] === "configure")) {
			assert.ok(c.includes("--profile") && c[c.indexOf("--profile") + 1] === "example", c.join(" "));
			assert.ok(c.includes("--output") && c[c.indexOf("--output") + 1] === "json", c.join(" "));
		}
	}
	// Only describe-vpcs was tried in the region that is not enabled.
	assert.equal(calls.filter((c) => c.includes("eu-west-3")).length, 1);
	assert.ok(result.warnings.some((w) => /eu-west-3: skipped \(OptInRequired/.test(w)), result.warnings.join("\n"));
	assert.ok(result.warnings.some((w) => /us-east-1: `aws elb describe-load-balancers` AccessDenied/.test(w)), result.warnings.join("\n"));
	assert.ok(progress.some((p) => /us-east-1/.test(p)));
	// The bucket without a region in list-buckets was located.
	assert.ok(calls.some((c) => c[2] === "get-bucket-location" && c.includes("example-logs-eu")));
	assert.ok(!calls.some((c) => c[2] === "get-bucket-location" && c.includes("example-assets")));
	// Lambda environment variables are cut away by the query.
	const lambdaCall = calls.find((c) => c[2] === "list-functions");
	assert.match(lambdaCall[lambdaCall.indexOf("--query") + 1], /^Functions\[\]\.\{FunctionName/);
	assert.doesNotMatch(lambdaCall.join(" "), /Environment/);
	assert.match(result.summary, /resources in 1 region\(s\) of account 111122223333/);
});

test("aws: containment account › region › VPC › AZ › subnet › resource; regional and global services placed", async () => {
	const { result } = await collectFixture();
	const g = result.graph;
	const node = (id) => g.nodes.find((n) => n.id === id);
	const chain = (id) => {
		const out = [];
		for (let n = node(id); n; n = n.parent ? node(n.parent) : undefined) out.push(n.id);
		return out;
	};
	assert.deepEqual(chain("i-web1"), ["i-web1", "subnet-priv-a", "vpc-0a1", "region:111122223333:us-east-1", "account:111122223333"]);
	assert.match(node("subnet-priv-a").label, /^Private subnet · app-a · 10\.0\.10\.0\/24 · us-east-1a$/);
	assert.equal(node("subnet-pub-a").kind, "aws:ec2:subnet:public");
	assert.equal(node("subnet-priv-b").kind, "aws:ec2:subnet:private");
	assert.match(node("subnet-pub-a").style, /strokeColor=#7AA116/);
	assert.match(node("subnet-data-a").style, /strokeColor=#00A4A6/);
	assert.equal(node("nat-1").parent, "subnet-pub-a");
	assert.equal(node("igw-1").parent, "vpc-0a1");
	assert.equal(node("arn:aws:rds:us-east-1:111122223333:db:orders-db-2").parent, "subnet-data-b", "RDS by subnet group and AZ");
	assert.equal(node("arn:aws:rds:us-east-1:111122223333:cluster:orders").parent, "vpc-0a1");
	assert.equal(node("arn:aws:elasticache:us-east-1:111122223333:cluster:sessions-cache-001").parent, "subnet-data-b");
	assert.equal(node("arn:aws:lambda:us-east-1:111122223333:function:orders-worker").parent, "vpc-0a1");
	assert.equal(node("arn:aws:lambda:us-east-1:111122223333:function:thumbnailer").parent, "region:111122223333:us-east-1");
	assert.equal(node("arn:aws:ecs:us-east-1:111122223333:service/apps/api").parent, "arn:aws:ecs:us-east-1:111122223333:cluster/apps");
	assert.equal(node("arn:aws:eks:us-east-1:111122223333:cluster/platform").parent, "vpc-0a1");
	assert.equal(node("arn:aws:s3:::example-assets").parent, "region:111122223333:us-east-1", "a bucket in a mapped region sits in it");
	assert.equal(node("arn:aws:s3:::example-logs-eu").parent, "s3:111122223333", "other buckets sit in the account");
	assert.equal(node("arn:aws:s3:::example-logs-eu").data.region, "eu-west-1");
	assert.equal(node("arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE").parent, "account:111122223333");
	assert.ok(!node("i-gone"), "terminated instances are left out");
	assert.ok(!node("vpc-def") && !node("subnet-def-a") && !node("igw-def"), "the empty default VPC is hidden");
	assert.ok(g.legend.some((l) => /1 default VPC/.test(l)));
	assert.ok(!g.nodes.some((n) => /eu-west-3/.test(n.id)));
	const i = node("i-bastion").data;
	assert.equal(i.publicIp, "yes");
	assert.equal(i.openToInternet, "tcp/22");
	assert.equal(i.region, "us-east-1");
	assert.equal(i.account, "111122223333");
	assert.equal(i.awsProfile, "example");
	assert.equal(i.arn, "arn:aws:ec2:us-east-1:111122223333:instance/i-bastion");
});

test("aws: availability-zone boxes on request", async () => {
	const inv = await aws.collectAws({ profile: "example", regions: "us-east-1" }, ctxWith(fakeAws(loadResponses())), []);
	const g = aws.awsInventoryToGraph(inv, { azGroups: true }).graph;
	const node = (id) => g.nodes.find((n) => n.id === id);
	assert.equal(node("subnet-priv-a").parent, "az:vpc-0a1:us-east-1a");
	assert.equal(node("az:vpc-0a1:us-east-1a").parent, "vpc-0a1");
	assert.match(node("az:vpc-0a1:us-east-1a").style, /dashed=1/);
	checkModelXml(renderGraph(g, { recipe: "aws.environment" }).xml);
});

test("aws: edges for targets, origins, integrations, event sources, subscriptions, security groups, peering and TGW", async () => {
	const { result } = await collectFixture();
	const g = result.graph;
	const ALB = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web-alb/50dc6c495c0c9188";
	const L = (n) => `arn:aws:lambda:us-east-1:111122223333:function:${n}`;
	const edge = (from, to, kind) => g.edges.find((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
	assert.match(edge(ALB, "i-web1", "traffic").label, /web-tg :80 \(2\/2 healthy\)/);
	assert.ok(edge(ALB, "i-web2", "traffic"));
	assert.ok(edge(ALB, "arn:aws:ecs:us-east-1:111122223333:service/apps/api", "traffic"), "ip target group drawn to the ECS service");
	assert.ok(edge(ALB, L("thumbnailer"), "traffic"), "lambda target");
	assert.ok(edge("igw-1", ALB, "traffic"), "internet-facing load balancer behind the IGW");
	assert.ok(edge("internet", "igw-1"));
	assert.equal(edge("igw-1", "i-bastion", "sg").label, "tcp/22");
	assert.ok(edge("nat-1", "igw-1", "network"));
	const CF = "arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE";
	assert.ok(edge(CF, "arn:aws:s3:::example-assets"), "S3 origin");
	assert.ok(edge(CF, ALB), "load balancer origin");
	assert.ok(edge(CF, "origin:api.partner.example"), "external origin");
	assert.equal(edge("arn:aws:apigateway:us-east-1::/restapis/a1b2c3", L("orders-worker")).label, "POST /orders");
	assert.ok(edge("arn:aws:apigateway:us-east-1::/apis/h7t7p", L("thumbnailer")));
	assert.equal(edge("arn:aws:apigateway:us-east-1::/apis/h7t7p", ALB).label, "VPC link");
	assert.ok(edge("arn:aws:sqs:us-east-1:111122223333:orders-queue", L("orders-worker"), "event"));
	assert.ok(edge("arn:aws:dynamodb:us-east-1:111122223333:table/orders", L("thumbnailer"), "event"), "DynamoDB stream → table node");
	assert.match(edge("arn:aws:kinesis:us-east-1:111122223333:stream/clicks", L("thumbnailer"), "event").label, /Disabled/);
	assert.ok(edge("arn:aws:sns:us-east-1:111122223333:order-events", "arn:aws:sqs:us-east-1:111122223333:orders-queue", "event"));
	assert.ok(edge("arn:aws:sns:us-east-1:111122223333:order-events", L("thumbnailer"), "event"), "alias stripped");
	// sg-db allows 5432 from sg-web: web servers and the ECS service → databases.
	assert.equal(edge("i-web1", "arn:aws:rds:us-east-1:111122223333:db:legacy-db", "sg")?.label, "tcp/5432");
	assert.ok(edge(L("orders-worker"), "arn:aws:rds:us-east-1:111122223333:cluster:orders", "sg"));
	assert.ok(edge(ALB, "i-web1", "sg"), "sg-web allows 80 from sg-alb");
	assert.ok(!g.edges.some((e) => e.kind === "sg" && e.from === e.to));
	assert.match(edge("vpc-0a1", "peer:vpc-shared", "link").label, /peering pcx-1/);
	assert.ok(g.nodes.find((n) => n.id === "peer:vpc-shared").label.includes("444455556666"));
	assert.ok(edge("vpc-0a1", "tgw-1", "link"));
	assert.ok(edge("tgw-1", "tgw-attach:tgw-attach-vpn", "link"));
	assert.ok(edge("arn:aws:rds:us-east-1:111122223333:cluster:orders", "arn:aws:rds:us-east-1:111122223333:db:orders-db-1", "member"));
	// Every edge joins drawn nodes.
	const ids = new Set(g.nodes.map((n) => n.id));
	for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} → ${e.to}`);
});

test("aws: review findings, facts without secrets, a valid draw.io fragment with real aws4 icons", { skip: !fs.existsSync(WEBAPP) }, async () => {
	const { result } = await collectFixture();
	const f = result.facts;
	assert.match(f, /## Health findings/);
	assert.match(f, /\[high\] bastion accepts SSH from the internet — security group sg-bastion \(bastion\) allows tcp\/22 from 0\.0\.0\.0\/0/);
	assert.match(f, /\[medium\] RDS legacy-db stores data unencrypted/);
	assert.match(f, /\[low\] RDS legacy-db runs in a single availability zone/);
	assert.doesNotMatch(f, /RDS orders-db-1 runs in a single/, "cluster members are not single-AZ findings");
	assert.match(f, /i-web1/);
	const { xml } = renderGraph(result.graph, { recipe: "aws.environment" });
	checkModelXml(xml);
	for (const secret of ["SUPER_SECRET_VALUE", "DB_PASSWORD", "ops-oncall@example.com", "admin_should_not_matter", "LS0tLS1CRUdJTi", "203.0.113.10", "198.51.100.7", "10.0.10.11"]) {
		assert.ok(!xml.includes(secret), `${secret} in the XML`);
		assert.ok(!f.includes(secret), `${secret} in the facts`);
	}
	const n = assertAws4StylesExist(xml);
	assert.ok(n > 30);
	assert.match(xml, /grIcon=mxgraph\.aws4\.group_vpc2/);
	assert.match(xml, /resIcon=mxgraph\.aws4\.ec2;/);
	assert.match(xml, /shape=mxgraph\.aws4\.application_load_balancer;/);
	// Nested containers fit their children.
	const { boxes } = layoutGraph(result.graph);
	for (const node of result.graph.nodes.filter((x) => x.parent)) {
		const b = boxes.get(node.id);
		const p = boxes.get(node.parent);
		assert.ok(b.x + b.width <= p.width && b.y + b.height <= p.height, `${node.id} outside ${node.parent}`);
	}
	const prompt = aws.awsRecipes[0].agentPrompt({ profile: "example" }, result);
	assert.match(prompt, /public exposure/);
	const dig = aws.awsRecipes[0].digDeeper([{ label: "web-1", data: { id: "i-web1", region: "us-east-1", awsProfile: "example" } }], "what can reach it?");
	assert.match(dig, /describe-\*/);
	assert.match(dig, /what can reach it\?[\s\S]*"id":"i-web1"/);
});

test("aws: structured findings on the right shapes, with severities, evidence and coverage", async () => {
	const { result, calls } = await collectFixture();
	assertFindingsContract(result);
	const R = (id) => `arn:aws:rds:us-east-1:111122223333:db:${id}`;
	const CACHE = "arn:aws:elasticache:us-east-1:111122223333:cluster:sessions-cache-001";
	const CF = "arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE";
	const ALB = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/web-alb/50dc6c495c0c9188";
	const expect = [
		["open-ingress", "i-bastion", "high"],
		["public-database", R("legacy-db"), "high"],
		["public-bucket", "arn:aws:s3:::example-assets", "high"],
		["open-ingress", CACHE, "low"],
		["unencrypted-storage", R("legacy-db"), "medium"],
		["unencrypted-storage", CACHE, "medium"],
		["unencrypted-transit", CACHE, "medium"],
		["public-access-block-off", "arn:aws:s3:::example-logs-eu", "medium"],
		["public-control-plane", "arn:aws:eks:us-east-1:111122223333:cluster/platform", "medium"],
		["https-not-enforced", CF, "medium"],
		["old-tls", CF, "medium"],
		["no-healthy-targets", ALB, "medium"],
		["single-az-database", R("legacy-db"), "low"],
		["single-nat-gateway", "nat-1", "low"],
		["no-waf", CF, "info"],
	];
	for (const [kind, node, severity] of expect) {
		const f = findingOf(result, kind, node);
		assert.ok(f, `${kind} on ${node}: ${result.findings.map((x) => x.id).join(", ")}`);
		assert.equal(f.severity, severity, f.id);
	}
	assert.equal(result.findings.length, expect.length, result.findings.map((x) => x.id).join("\n"));
	assert.equal(findingOf(result, "open-ingress", "i-bastion").id, "open-ingress:i-bastion");
	assert.match(findingOf(result, "open-ingress", "i-bastion").title, /^bastion accepts SSH from the internet$/);
	assert.match(findingOf(result, "open-ingress", "i-bastion").detail, /sg-bastion \(bastion\) allows tcp\/22 from 0\.0\.0\.0\/0; bastion has a public IP address in us-east-1/);
	assert.match(findingOf(result, "open-ingress", CACHE).detail, /no public address today/);
	assert.match(findingOf(result, "public-database", R("legacy-db")).detail, /PubliclyAccessible = true/);
	assert.match(findingOf(result, "public-database", R("legacy-db")).fix, /--no-publicly-accessible/);
	assert.match(findingOf(result, "public-bucket", "arn:aws:s3:::example-assets").detail, /IsPublic = true/);
	assert.match(findingOf(result, "public-access-block-off", "arn:aws:s3:::example-logs-eu").detail, /No bucket-level Block Public Access configuration and no account-level configuration/);
	assert.match(findingOf(result, "https-not-enforced", CF).detail, /allow-all for cache behavior \/legacy\/\*/);
	assert.ok(findingOf(result, "single-nat-gateway", "vpc-0a1"), "the NAT finding marks its VPC too");
	// Precision: the ALB's 443 from the world and the Aurora cluster members are not findings.
	assert.ok(!result.findings.some((x) => x.nodeIds.includes(ALB) && x.kind === "open-ingress"));
	assert.ok(!result.findings.some((x) => x.nodeIds.some((n) => /orders-db-[12]$/.test(n))));
	// The public-access calls are read-only gets; expected "none configured" answers are not warnings.
	assert.ok(calls.some((c) => c[1] === "s3control" && c[2] === "get-public-access-block" && c.includes("111122223333")));
	assert.ok(calls.some((c) => c[2] === "get-bucket-policy-status" && c.includes("example-assets") && c.includes("us-east-1")));
	assert.ok(!result.warnings.some((w) => /NoSuch/.test(w)), result.warnings.join("\n"));
	// Coverage.
	assert.equal(checkOf(result, /^Security group rules/).scanned, 7, "ingress rules of the region's security groups");
	assert.equal(checkOf(result, /^Publicly accessible databases/).scanned, 3);
	assert.equal(checkOf(result, /^S3 public access/).scanned, 2);
	assert.equal(checkOf(result, /^CloudFront/).scanned, 1);
	// Stable across runs; no secrets.
	const again = (await collectFixture()).result;
	assert.deepEqual(again.findings, result.findings);
	assert.deepEqual(again.checked, result.checked);
	const text = JSON.stringify(result.findings);
	for (const secret of ["SUPER_SECRET_VALUE", "DB_PASSWORD", "ops-oncall@example.com", "admin_should_not_matter", "LS0tLS1CRUdJTi", "abc123"]) assert.ok(!text.includes(secret), `${secret} in the findings`);
	assert.match(result.summary, /, 15 finding\(s\) \(3 high\)$/);
});

test("aws: a well-configured account has no findings, and only the services read are in the coverage", () => {
	const inv = {
		account: "111122223333",
		profile: "example",
		services: ["ec2", "rds", "s3"],
		accountPublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
		buckets: [{ name: "private-data", region: "us-east-1", publicAccessBlock: null, policyIsPublic: false, publicAclGrants: [] }],
		distributions: [],
		regions: [
			{
				region: "us-east-1",
				vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }],
				subnets: [{ SubnetId: "subnet-a", VpcId: "vpc-1", CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a" }],
				routeTables: [],
				internetGateways: [],
				natGateways: [],
				vpcEndpoints: [],
				peerings: [],
				transitGateways: [],
				tgwAttachments: [],
				securityGroups: [
					{ GroupId: "sg-app", GroupName: "app", VpcId: "vpc-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] },
					{ GroupId: "sg-db", GroupName: "db", VpcId: "vpc-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: "sg-app" }] }] },
				],
				instances: [{ InstanceId: "i-app", SubnetId: "subnet-a", VpcId: "vpc-1", State: { Name: "running" }, SecurityGroups: [{ GroupId: "sg-app" }] }],
				loadBalancers: [],
				targetGroups: [],
				targetHealth: {},
				classicLoadBalancers: [],
				dbInstances: [{ DBInstanceIdentifier: "db", DBInstanceArn: "arn:aws:rds:us-east-1:111122223333:db:db", Engine: "postgres", PubliclyAccessible: false, StorageEncrypted: true, MultiAZ: true, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-db" }], DBSubnetGroup: { VpcId: "vpc-1", Subnets: [] } }],
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
			},
		],
	};
	const map = aws.awsInventoryToGraph(inv);
	assert.deepEqual(map.findings, []);
	assert.doesNotMatch(map.facts, /Health findings/);
	assert.doesNotMatch(map.summary, /finding/);
	const names = map.checked.map((c) => c.check);
	assert.ok(names.includes("Security group rules open to the internet") && names.includes("Publicly accessible databases (RDS)") && names.some((n) => /^S3/.test(n)));
	assert.ok(!names.some((n) => /EKS|CloudFront|in transit|ECS/.test(n)), `services not read are not checks: ${names.join(", ")}`);
	assert.equal(map.checked.find((c) => /^Security group/.test(c.check)).scanned, 2);
});

test("aws: expired credentials stop with a sign-in hint; 'all' regions come from describe-regions", async () => {
	const expired = async () => ({ stdout: "", stderr: "\naws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'.\n", code: 255 });
	await assert.rejects(aws.awsRecipes[0].collect({ profile: "dev" }, ctxWith(expired)), (e) => /missing or expired/.test(e.message) && /aws sso login --profile dev/.test(e.hint));
	const calls = [];
	const r = await aws.awsRecipes[0].collect({ profile: "", regions: "all", services: "ec2" }, ctxWith(fakeAws(loadResponses(), calls)));
	assert.ok(calls.some((c) => c[1] === "ec2" && c[2] === "describe-regions" && c.includes("us-east-1")), "describe-regions in the profile's region");
	assert.ok(calls.some((c) => c.includes("eu-west-3")));
	assert.ok(!calls.some((c) => c.includes("--profile")), "no --profile for the default credentials");
	assert.ok(!calls.some((c) => c[1] === "rds" || c[1] === "s3api"), "only the chosen services (and networks)");
	assert.ok(r.graph.nodes.some((n) => n.id === "i-web1"));
	const opts = await aws.awsRecipes[0].loadOptions("profile", {}, ctxWith(fakeAws(loadResponses())));
	assert.deepEqual(opts.map((o) => o.value), ["", "default", "example"]);
});

test("aws: crowds of one kind in one container fold into a counted shape", () => {
	const g = {
		title: "t",
		nodes: [{ id: "sub", label: "s", kind: "aws:ec2:subnet:private", container: true }, ...Array.from({ length: 40 }, (_, i) => ({ id: `i-${i}`, label: `i-${i}`, kind: "aws:ec2:instance", parent: "sub", shape: "icon", data: { id: `i-${i}` } })), { id: "lb", label: "lb", kind: "aws:elbv2:application" }],
		edges: Array.from({ length: 40 }, (_, i) => ({ from: "lb", to: `i-${i}`, kind: "traffic" })),
	};
	const n = aws.collapseCrowds(g, 24);
	assert.equal(n, 17);
	assert.equal(g.nodes.filter((x) => x.kind === "aws:ec2:instance").length, 23);
	const crowd = g.nodes.find((x) => x.kind === "aws:ec2:instance:group");
	assert.equal(crowd.data.count, "17");
	assert.match(crowd.data.ids, /i-39/);
	assert.equal(g.edges.length, 24, "edges to folded nodes merge into one");
	checkModelXml(renderGraph(g, { recipe: "t" }).xml);
});

test("catalog: the AWS and IaC recipes are registered", () => {
	const ids = catalog().recipes.map((r) => r.id);
	for (const id of ["aws.environment", "aws.iac", "azure.iac", "gcp.iac"]) assert.ok(ids.includes(id), id);
});

// ----- infrastructure as code -----

const iac = require("../src/main/mapper/recipes/cloud/iac");
const { iacIconInventory, awsIconKey, azureIconFile, gcpIconName } = require("../src/main/mapper/recipes/cloud/iac/icons");
const { AWS_ICONS } = require("../src/main/mapper/recipes/cloud/aws/icons");
const { recipeById } = require("../src/main/mapper/registry");
const REPO = path.join(FIX, "iac/repo");

const gcpIcons = () =>
	new Set(
		[...fs.readFileSync(path.join(WEBAPP, "shapes/mxGCP2.js"), "utf8").matchAll(/\{val: '([a-z0-9_]+)', dispName/g)].map((m) => m[1])
	);

test("iac icons: every Azure file, GCP product icon and AWS key exists", { skip: !fs.existsSync(WEBAPP) }, () => {
	const { azureFiles, gcpIcons: gcp, awsKeys } = iacIconInventory();
	for (const f of azureFiles) assert.ok(fs.existsSync(path.join(WEBAPP, "img/lib/azure2", f)), `img/lib/azure2/${f}`);
	const known = gcpIcons();
	assert.ok(known.size > 50);
	for (const n of gcp) assert.ok(known.has(n), `gcp2 prIcon ${n}`);
	for (const k of awsKeys) assert.ok(AWS_ICONS[k], `aws icon key ${k}`);
	assert.equal(awsIconKey("aws_lambda_function"), "lambda");
	assert.equal(awsIconKey("aws_route53_record"), "route53");
	assert.equal(awsIconKey("aws_route_table_association"), "routeTable");
	assert.equal(awsIconKey("AWS::RDS::DBCluster"), "aurora");
	assert.equal(awsIconKey("AWS::Serverless::Function"), "lambda");
	assert.equal(awsIconKey("AWS::Weird::Thing"), "general");
	assert.equal(azureIconFile("azurerm_linux_function_app"), "compute/Function_Apps.svg");
	assert.equal(azureIconFile("Microsoft.Web/sites", "functionapp,linux"), "compute/Function_Apps.svg");
	assert.equal(azureIconFile("Microsoft.Network/virtualNetworks/subnets"), "networking/Subnet.svg");
	assert.equal(azureIconFile("Microsoft.Storage/storageAccounts/tableServices"), "storage/Storage_Accounts.svg", "falls back to the parent type");
	assert.equal(gcpIconName("google_compute_instance"), "compute_engine");
	assert.equal(gcpIconName("google_cloud_run_v2_service"), "cloud_run");
	assert.equal(gcpIconName("compute.v1.firewall"), "cloud_firewall_rules");
});

test("terraform scanner: comments, strings with braces and heredocs do not confuse block matching", () => {
	const text = fs.readFileSync(path.join(REPO, "infra/terraform/main.tf"), "utf8");
	const masked = iac.maskHcl(text);
	assert.equal(masked.length, text.length);
	assert.equal(masked.split("\n").length, text.split("\n").length);
	const blocks = iac.terraformBlocks(text);
	assert.deepEqual(
		blocks.map((b) => `${b.kind} ${b.type} ${b.name}`),
		[
			"data aws_ami ubuntu",
			"resource aws_vpc main",
			"resource aws_subnet public",
			"resource aws_security_group web",
			"resource aws_instance web",
			"resource aws_s3_bucket assets",
			"resource aws_security_group egress_only",
			"resource aws_s3_bucket_public_access_block assets",
			"resource random_password db",
			"module module db",
			"module module remote_vpc",
		]
	);
	const lines = text.split("\n");
	for (const b of blocks) assert.match(lines[text.slice(0, b.start).split("\n").length - 1], new RegExp(`^(resource|data|module) "${b.kind === "module" ? b.name : b.type}"`));
	// The heredoc's interpolation is kept as code, its text is not.
	assert.match(masked, /aws_s3_bucket\.assets\.bucket/);
	assert.doesNotMatch(masked, /etc\/app\.json/);
	assert.doesNotMatch(masked, /ghost/);
});

test("terraform: references, data sources, local and remote modules, one group per folder", () => {
	const files = ["infra/terraform/main.tf", "infra/terraform/modules/db/main.tf"].map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), "utf8") }));
	const { groups, resources } = iac.parseTerraform(files);
	assert.deepEqual(groups.map((g) => g.id), ["tf:infra/terraform", "tf:infra/terraform/modules/db"]);
	const r = (a) => resources.find((x) => x.address === a);
	assert.deepEqual(r("aws_instance.web").refs.sort(), ["aws_s3_bucket.assets", "aws_security_group.web", "aws_subnet.public", "data.aws_ami.ubuntu", "module.db"]);
	assert.equal(r("aws_instance.web").attrs.count, "2");
	assert.equal(r("aws_instance.web").line, 43);
	assert.equal(r("data.aws_ami.ubuntu").kind, "data");
	assert.equal(r("module.db").moduleTarget, "tf:infra/terraform/modules/db");
	assert.equal(r("module.remote_vpc").moduleSource, "terraform-aws-modules/vpc/aws");
	assert.equal(r("random_password.db").cloud, "other");
	assert.equal(r("aws_db_instance.this").group, "tf:infra/terraform/modules/db");
	assert.deepEqual(r("aws_db_instance.this").refs, ["aws_db_subnet_group.this"], "var.* is not a resource reference");
	assert.equal(r("aws_db_instance.this").attrs.publicly_accessible, "true");
	assert.equal(r("aws_db_instance.this").attrs.password, undefined, "secret-looking settings are never kept");
	assert.equal(r("aws_security_group.web").attrs.openToWorld, "true");
	assert.equal(r("aws_security_group.web").attrs.openPorts, "tcp/22");
	assert.equal(r("aws_security_group.web").attrs.openSources, "0.0.0.0/0");
	assert.equal(r("aws_security_group.egress_only").attrs.openPorts, "tcp/443", "egress to 0.0.0.0/0 is not an inbound rule");
	assert.equal(r("aws_s3_bucket_public_access_block.assets").attrs.block_public_acls, "false");
});

test("iac: inbound rules are read from Terraform, CloudFormation, ARM, Bicep and Deployment Manager", () => {
	const tf = (text) => iac.parseTerraform([{ rel: "x/main.tf", text }]).resources[0].attrs;
	assert.equal(tf('resource "aws_security_group_rule" "r" {\n  type = "ingress"\n  from_port = 0\n  to_port = 65535\n  protocol = "tcp"\n  cidr_blocks = [\n    "10.0.0.0/8",\n    "0.0.0.0/0",\n  ]\n}\n').openPorts, "tcp/*");
	assert.equal(tf('resource "aws_security_group_rule" "r" {\n  type = "egress"\n  from_port = 0\n  to_port = 0\n  protocol = "-1"\n  cidr_blocks = ["0.0.0.0/0"]\n}\n').openToWorld, undefined);
	assert.equal(tf('resource "aws_security_group" "r" {\n  ingress {\n    from_port = var.port\n    to_port = var.port\n    protocol = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n').openPorts, "tcp/?");
	assert.equal(tf('resource "google_compute_firewall" "f" {\n  source_ranges = ["0.0.0.0/0"]\n  allow {\n    protocol = "tcp"\n    ports = ["22", "8000-8100"]\n  }\n  allow {\n    protocol = "icmp"\n  }\n}\n').openPorts, "tcp/22, tcp/8000-8100, icmp/*");
	assert.equal(tf('resource "google_compute_firewall" "f" {\n  direction = "EGRESS"\n  source_ranges = ["0.0.0.0/0"]\n  allow {\n    protocol = "all"\n  }\n}\n').openToWorld, undefined);
	assert.equal(tf('resource "azurerm_network_security_rule" "r" {\n  direction = "Inbound"\n  access = "Allow"\n  protocol = "Tcp"\n  source_address_prefix = "Internet"\n  destination_port_ranges = ["22", "3389"]\n}\n').openPorts, "tcp/22, tcp/3389");
	assert.equal(tf('resource "azurerm_network_security_rule" "r" {\n  direction = "Inbound"\n  access = "Deny"\n  protocol = "*"\n  source_address_prefix = "*"\n  destination_port_range = "*"\n}\n').openToWorld, undefined);
	assert.equal(tf('resource "google_storage_bucket_iam_binding" "b" {\n  role = "roles/storage.objectViewer"\n  members = ["allAuthenticatedUsers", "user:a@example.com"]\n}\n').publicMembers, "allAuthenticatedUsers");
	const cfn = iac.parseCloudFormation("t.yaml", "", { Resources: { Sg: { Type: "AWS::EC2::SecurityGroup", Properties: { SecurityGroupIngress: [{ IpProtocol: "-1", CidrIpv6: "::/0" }, { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "10.0.0.0/8" }] } } } }).resources[0].attrs;
	assert.equal(cfn.openPorts, "all");
	const arm = iac.parseArm("a.json", '{"type": "Microsoft.Network/networkSecurityGroups/securityRules"}', { resources: [{ type: "Microsoft.Network/networkSecurityGroups/securityRules", name: "x/ssh", properties: { direction: "Inbound", access: "Allow", protocol: "Tcp", sourceAddressPrefix: "*", destinationPortRange: "[parameters('port')]" } }] }).resources[0].attrs;
	assert.equal(arm.openPorts, "tcp/?");
	const bicep = iac.parseBicep("n.bicep", "resource nsg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {\n  name: 'n'\n  properties: {\n    securityRules: [\n      {\n        name: 'a'\n        properties: {\n          direction: 'Inbound'\n          access: 'Allow'\n          protocol: '*'\n          sourceAddressPrefixes: [ '0.0.0.0/0' ]\n          destinationPortRanges: [ '443', '5432' ]\n        }\n      }\n      {\n        name: 'b'\n        properties: { direction: 'Outbound', access: 'Allow', protocol: '*', sourceAddressPrefix: '*', destinationPortRange: '*' }\n      }\n    ]\n  }\n}\n").resources[0].attrs;
	assert.equal(bicep.openPorts, "*/443, */5432");
	const risk = iac.openPortRisk("tcp/443, */5432, icmp/*, udp/?");
	assert.deepEqual(risk, { risky: ["5432 (PostgreSQL)"], unknown: true });
});

test("cloudformation: short-form tags, GetAtt/Sub/DependsOn references, SAM, CDK paths, nested stacks", () => {
	const text = fs.readFileSync(path.join(REPO, "cloudformation/app.yaml"), "utf8");
	const doc = iac.loadTemplate(text, "cloudformation/app.yaml");
	assert.deepEqual(doc.Resources.OrdersFunction.Properties.Environment.Variables.BUCKET_ARN, { "Fn::GetAtt": ["ReportsBucket", "Arn"] });
	const { group, resources } = iac.parseCloudFormation("cloudformation/app.yaml", text, doc);
	assert.equal(group.tool, "sam");
	const r = (a) => resources.find((x) => x.address === a);
	assert.deepEqual(r("OrdersFunction").refs.sort(), ["OrdersQueue", "OrdersTable", "ReportsBucket"]);
	assert.deepEqual(r("ReportsBucket").refs, ["OrdersTable"], "DependsOn; ${AWS::StackName} is not a resource");
	assert.deepEqual(r("Alarm").refs, ["OrdersFunction"], "Fn::Sub with a variable map");
	assert.equal(r("Network").moduleTarget, "cfn:cloudformation/network.yaml");
	assert.equal(r("OrdersFunction").line, 15);
	assert.ok(!JSON.stringify(resources).includes("not-a-real-secret"), "environment values are not kept");
	const cdkText = fs.readFileSync(path.join(REPO, "cdk.out/ApiStack.template.json"), "utf8");
	const cdk = iac.parseCloudFormation("cdk.out/ApiStack.template.json", cdkText, iac.loadTemplate(cdkText, "cdk.out/ApiStack.template.json"));
	assert.equal(cdk.group.tool, "cdk");
	assert.equal(cdk.resources.find((x) => x.address === "Handler886CB40B").name, "Handler");
	assert.deepEqual(cdk.resources.find((x) => x.address === "RestApiMethod").refs.sort(), ["Handler886CB40B", "RestApi0C43BF4B"], "${X.Arn} inside Fn::Join/Fn::Sub");
	assert.ok(!cdk.resources.some((x) => x.type === "AWS::CDK::Metadata"));
});

test("bicep: symbols, nested child resources, parent, existing, loops and modules", () => {
	const text = fs.readFileSync(path.join(REPO, "bicep/main.bicep"), "utf8");
	const { resources } = iac.parseBicep("bicep/main.bicep", text);
	const r = (a) => resources.find((x) => x.address === a);
	assert.equal(r("appSubnet").type, "Microsoft.Network/virtualNetworks/subnets");
	assert.deepEqual(r("appSubnet").refs.sort(), ["nsg", "vnet"]);
	assert.deepEqual(r("site").refs.sort(), ["appSubnet", "plan", "stg", "vnet"], "string interpolation and vnet::appSubnet");
	assert.equal(r("site").attrs.httpsOnly, "false");
	assert.equal(r("vnet").attrs.addressPrefix, undefined, "the nested subnet's settings stay with the subnet");
	assert.equal(r("kv").attrs.existing, "true");
	assert.equal(r("workers").attrs.for_each, "for loop");
	assert.equal(r("workers").attrs.kind, "functionapp");
	assert.equal(r("db").kind, "module");
	assert.equal(r("db").moduleTarget, "bicep:bicep/modules/db.bicep");
	assert.equal(r("shared").moduleSource, "br/public:avm/res/network/private-dns-zone:0.2.0");
	assert.equal(r("stg").line, 8);
	const db = iac.parseBicep("bicep/modules/db.bicep", fs.readFileSync(path.join(REPO, "bicep/modules/db.bicep"), "utf8"));
	assert.deepEqual(db.resources.find((x) => x.address === "sqlDb").refs, ["sql"]);
	assert.ok(!JSON.stringify(db.resources).includes("sqladmin"), "administrator login not kept");
});

test("arm: dependsOn with resourceId, nested child resources, nested deployments", () => {
	const text = fs.readFileSync(path.join(REPO, "arm/azuredeploy.json"), "utf8");
	const { resources } = iac.parseArm("arm/azuredeploy.json", text, JSON.parse(text));
	const byType = (t) => resources.find((x) => x.type === t);
	const vnet = byType("Microsoft.Network/virtualNetworks");
	const subnet = byType("Microsoft.Network/virtualNetworks/subnets");
	const nic = byType("Microsoft.Network/networkInterfaces");
	const pip = byType("Microsoft.Network/publicIPAddresses");
	const vm = byType("Microsoft.Compute/virtualMachines");
	assert.equal(vnet.name, "vnetName");
	assert.deepEqual(subnet.refs, [vnet.address]);
	assert.deepEqual(nic.refs.sort(), [subnet.address, pip.address].sort());
	assert.deepEqual(vm.refs, [nic.address]);
	assert.equal(byType("Microsoft.Resources/deployments").moduleTarget, "arm:arm/nested/monitoring.json");
	assert.equal(vm.line, 35);
});

async function runIac(cloud, folder = REPO) {
	const recipe = recipeById(`${cloud}.iac`);
	assert.ok(recipe, `${cloud}.iac registered`);
	return recipe.collect({ folder }, ctxWith(async () => assert.fail("the IaC map runs no commands")));
}

test("aws.iac: Terraform, SAM, CloudFormation and CDK in one map; other clouds only in warnings", { skip: !fs.existsSync(WEBAPP) }, async () => {
	const r = await runIac("aws");
	const g = r.graph;
	assert.match(r.summary, /^25 AWS resource\(s\) in 5 module\(s\)\/stack\(s\)\/template\(s\) \(terraform, cdk, sam, cloudformation\), 9 finding\(s\) \(5 high\)$/);
	assert.ok(r.warnings.some((w) => /Not drawn \(not AWS\).*random_password.*Azure: 26.*Google Cloud: 14/.test(w)), r.warnings.join("\n"));
	assert.ok(r.warnings.some((w) => /broken\.yaml/.test(w)));
	assert.ok(!r.warnings.some((w) => /k8s|package\.json/.test(w)), "unrelated YAML/JSON is ignored quietly");
	assert.ok(!g.nodes.some((n) => /azurerm|google_|bicep|arm:/.test(n.id)));
	const node = (id) => g.nodes.find((n) => n.id === id);
	const web = node("tf:infra/terraform::aws_instance.web");
	assert.equal(web.parent, "tf:infra/terraform");
	assert.equal(web.data.file, "infra/terraform/main.tf");
	assert.equal(web.data.line, "43");
	assert.equal(web.data.address, "aws_instance.web");
	assert.equal(web.label, "web [count]\ninstance");
	assert.deepEqual(web.files, ["infra/terraform/main.tf"], "the file the resource is declared in, relative to the folder");
	assert.deepEqual(node("tf:infra/terraform").files, ["infra/terraform/main.tf"]);
	assert.deepEqual(node("cfn:cloudformation/app.yaml::OrdersFunction").files, ["cloudformation/app.yaml"]);
	assert.deepEqual(node("tf:infra/terraform::module.db").files, ["infra/terraform/main.tf"]);
	for (const n of g.nodes) if (!n.container && n.kind !== "external") for (const f of n.files ?? []) assert.ok(fs.existsSync(path.join(REPO, f)), f);
	assert.match(web.style, /resIcon=mxgraph\.aws4\.ec2;/);
	assert.match(node("tf:infra/terraform::data.aws_ami.ubuntu").style, /opacity=55/);
	const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
	assert.ok(has("tf:infra/terraform::aws_instance.web", "tf:infra/terraform::aws_subnet.public", "ref"));
	assert.ok(has("tf:infra/terraform::aws_instance.web", "tf:infra/terraform::module.db", "ref"));
	assert.ok(has("tf:infra/terraform::module.db", "tf:infra/terraform/modules/db", "module"), "module call → the module's folder");
	assert.ok(has("cfn:cloudformation/app.yaml::Network", "cfn:cloudformation/network.yaml", "module"), "nested stack");
	assert.ok(has("cfn:cloudformation/app.yaml::OrdersFunction", "cfn:cloudformation/app.yaml::OrdersQueue"));
	assert.ok(node("tf:infra/terraform::module.remote_vpc").label.includes("terraform-aws-modules/vpc/aws"));
	assert.match(r.facts, /\[high\] aws_db_instance\.this is publicly accessible — infra\/terraform\/modules\/db\/main\.tf:11 aws_db_instance\.this: publicly_accessible = true\./);
	assert.match(r.facts, /\[high\] aws_s3_bucket\.assets makes its objects readable by anyone — .*acl = "public-read"/);
	const { xml } = renderGraph(g, { recipe: "aws.iac" });
	checkModelXml(xml);
	assertAws4StylesExist(xml);
	assert.ok(!xml.includes("not-a-real-secret") && !r.facts.includes("not-a-real-secret"));
	assert.match(recipeById("aws.iac").digDeeper([{ label: "web", data: web.data }], "why public?"), /file and line[\s\S]*why public\?[\s\S]*"file":"infra\/terraform\/main\.tf"/);
	assert.match(recipeById("aws.iac").agentPrompt({ folder: REPO }, r), /Do not change any files/);
});

test("azure.iac: Terraform azurerm, Bicep (with modules) and ARM (with nested deployments) with azure2 images", { skip: !fs.existsSync(WEBAPP) }, async () => {
	const r = await runIac("azure");
	const g = r.graph;
	assert.match(r.summary, /^26 Azure resource\(s\) in 5 .*\(terraform, arm, bicep\), 8 finding\(s\) \(2 high\)$/);
	assert.ok(!r.warnings.some((w) => /broken\.yaml/.test(w)), "AWS template problems are not Azure warnings");
	const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
	assert.ok(has("bicep:bicep/main.bicep::db", "bicep:bicep/modules/db.bicep", "module"));
	assert.ok(has("bicep:bicep/main.bicep::site", "bicep:bicep/main.bicep::plan", "ref"));
	assert.ok(has("arm:arm/azuredeploy.json::r4", "arm:arm/nested/monitoring.json", "module"));
	assert.ok(has("tf:infra/terraform-azure::azurerm_linux_function_app.fn", "tf:infra/terraform-azure::azurerm_subnet.app"));
	const fn = g.nodes.find((n) => n.id === "tf:infra/terraform-azure::azurerm_linux_function_app.fn");
	assert.match(fn.style, /image=img\/lib\/azure2\/compute\/Function_Apps\.svg;/);
	assert.match(g.nodes.find((n) => n.id === "bicep:bicep/main.bicep::kv").style, /opacity=55/, "existing resources are faded");
	assert.match(r.facts, /stg allows containers to be made public — bicep\/main\.bicep:8 stg: allowBlobPublicAccess = true/);
	assert.match(r.facts, /site accepts plain HTTP — bicep\/main\.bicep:\d+ site: httpsOnly = false/);
	assert.match(r.facts, /sql \(sql-app\) is reachable over its public endpoint .*publicNetworkAccess = "Enabled"/);
	const { xml } = renderGraph(g, { recipe: "azure.iac" });
	checkModelXml(xml);
	for (const m of xml.matchAll(/image=img\/lib\/azure2\/([^;"]+)/g)) assert.ok(fs.existsSync(path.join(WEBAPP, "img/lib/azure2", m[1])), m[1]);
});

test("gcp.iac: Terraform google_* and Deployment Manager with gcp2 product icons", { skip: !fs.existsSync(WEBAPP) }, async () => {
	const r = await runIac("gcp");
	const g = r.graph;
	assert.match(r.summary, /^14 Google Cloud resource\(s\) in 2 .*\(terraform, deployment-manager\), 5 finding\(s\) \(3 high\)$/);
	const has = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
	assert.ok(has("tf:infra/terraform-gcp::google_compute_instance.app", "tf:infra/terraform-gcp::google_compute_subnetwork.app"));
	assert.ok(has("dm:dm/config.yaml::dm-vm", "dm:dm/config.yaml::dm-subnet"));
	assert.equal(g.nodes.find((n) => n.id === "dm:dm/config.yaml::dm-vm").data.attr_machine_type, "e2-small");
	assert.equal(g.nodes.find((n) => n.id === "dm:dm/config.yaml::more-vms").kind, "iac:module");
	const { xml } = renderGraph(g, { recipe: "gcp.iac" });
	checkModelXml(xml);
	const known = gcpIcons();
	const used = [...xml.matchAll(/prIcon=([a-z0-9_]+)/g)].map((m) => m[1]);
	assert.ok(used.length >= 12);
	for (const n of used) assert.ok(known.has(n), n);
	assert.ok(used.includes("cloud_run") && used.includes("cloud_sql") && used.includes("cloud_firewall_rules"));
});

test("iac: findings from the declared settings, on the declaring shapes, with file:line evidence and coverage", async () => {
	const runs = {};
	for (const cloud of ["aws", "azure", "gcp"]) {
		const r = await runIac(cloud);
		assertFindingsContract(r);
		const again = await runIac(cloud);
		assert.deepEqual(again.findings, r.findings, `${cloud}: stable across runs`);
		assert.deepEqual(again.checked, r.checked);
		for (const f of r.findings) {
			assert.match(f.detail, /^[\w./-]+\.(tf|ya?ml|json|bicep):\d+ /, `${f.id}: file:line evidence`);
			assert.equal(f.id, `${f.kind}:${f.nodeIds[0]}`);
		}
		const text = JSON.stringify(r.findings);
		for (const secret of ["not-a-real-secret", "sqladmin", "adminPassword", "random_password"]) assert.ok(!text.includes(secret), `${cloud}: ${secret} in the findings`);
		runs[cloud] = r;
	}
	const has = (cloud, kind, node, severity) => {
		const f = findingOf(runs[cloud], kind, node);
		assert.ok(f, `${cloud}: ${kind} on ${node}: ${runs[cloud].findings.map((x) => x.id).join(", ")}`);
		assert.equal(f.severity, severity, f.id);
		return f;
	};
	// AWS
	has("aws", "open-ingress", "tf:infra/terraform::aws_security_group.web", "high");
	has("aws", "open-ingress", "cfn:cloudformation/network.yaml::WebSg", "high");
	has("aws", "public-database", "tf:infra/terraform/modules/db::aws_db_instance.this", "high");
	has("aws", "public-database", "cfn:cloudformation/network.yaml::Db", "high");
	has("aws", "public-bucket", "tf:infra/terraform::aws_s3_bucket.assets", "high");
	has("aws", "unencrypted-storage", "tf:infra/terraform/modules/db::aws_db_instance.this", "medium");
	has("aws", "single-az-database", "tf:infra/terraform/modules/db::aws_db_instance.this", "low");
	const bpa = has("aws", "public-access-block-off", "tf:infra/terraform::aws_s3_bucket_public_access_block.assets", "medium");
	assert.ok(bpa.nodeIds.includes("tf:infra/terraform::aws_s3_bucket.assets"), "the bucket it belongs to is marked too");
	assert.match(bpa.detail, /block_public_acls = false, ignore_public_acls = false/);
	assert.ok(!findingOf(runs.aws, "open-ingress", "tf:infra/terraform::aws_security_group.egress_only"), "443 in, all out: not a finding");
	assert.match(has("aws", "open-ingress", "tf:infra/terraform::aws_security_group.web", "high").title, /opens SSH to the internet/);
	// Azure
	has("azure", "open-ingress", "bicep:bicep/main.bicep::nsg", "high");
	has("azure", "public-database", "tf:infra/terraform-azure::azurerm_mssql_firewall_rule.everyone", "high");
	has("azure", "https-not-enforced", "bicep:bicep/main.bicep::site", "medium");
	has("azure", "old-tls", "tf:infra/terraform-azure::azurerm_storage_account.sa", "medium");
	has("azure", "public-blob-access", "bicep:bicep/main.bicep::stg", "medium");
	has("azure", "no-purge-protection", "tf:infra/terraform-azure::azurerm_key_vault.kv", "low");
	has("azure", "public-network-access", "bicep:bicep/modules/db.bicep::sql", "low");
	assert.ok(!findingOf(runs.azure, "open-ingress", "tf:infra/terraform-azure::azurerm_network_security_group.web"), "HTTPS from the internet: not a finding");
	assert.ok(!runs.azure.findings.some((f) => f.nodeIds.includes("bicep:bicep/main.bicep::kv")), "existing resources are not judged");
	// Google Cloud
	has("gcp", "open-ingress", "tf:infra/terraform-gcp::google_compute_firewall.ssh", "high");
	has("gcp", "public-database", "tf:infra/terraform-gcp::google_sql_database_instance.db", "high");
	const iam = has("gcp", "public-bucket", "tf:infra/terraform-gcp::google_storage_bucket_iam_member.public_read", "high");
	assert.ok(iam.nodeIds.includes("tf:infra/terraform-gcp::google_storage_bucket.data"));
	has("gcp", "public-control-plane", "tf:infra/terraform-gcp::google_container_cluster.gke", "medium");
	has("gcp", "deletion-protection-off", "tf:infra/terraform-gcp::google_sql_database_instance.db", "low");
	assert.ok(!findingOf(runs.gcp, "open-ingress", "dm:dm/config.yaml::dm-fw"), "port 80 from the internet: not a finding");
	// Coverage.
	assert.equal(checkOf(runs.aws, /^Inbound rules/).scanned, 3);
	assert.equal(checkOf(runs.azure, /^Inbound rules/).scanned, 2);
	assert.equal(checkOf(runs.gcp, /^Inbound rules/).scanned, 2);
	assert.equal(checkOf(runs.azure, /^Key Vault/).scanned, 1, "the existing vault is not counted");
	// The findings badge the shapes in the rendered map.
	checkModelXml(renderGraph(runs.aws.graph, { recipe: "aws.iac" }).xml);
});

test("iac: a well-configured repository has no findings, but says what it checked", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iac-clean-"));
	fs.mkdirSync(path.join(dir, "infra"));
	fs.writeFileSync(
		path.join(dir, "infra/main.tf"),
		[
			'resource "aws_security_group" "web" {',
			"  ingress {",
			"    from_port   = 443",
			"    to_port     = 443",
			'    protocol    = "tcp"',
			'    cidr_blocks = ["0.0.0.0/0"]',
			"  }",
			"  ingress {",
			"    from_port   = 22",
			"    to_port     = 22",
			'    protocol    = "tcp"',
			'    cidr_blocks = ["10.0.0.0/8"]',
			"  }",
			"  egress {",
			"    from_port   = 0",
			"    to_port     = 0",
			'    protocol    = "-1"',
			'    cidr_blocks = ["0.0.0.0/0"]',
			"  }",
			"}",
			'resource "aws_db_instance" "db" {',
			'  engine              = "postgres"',
			"  publicly_accessible = false",
			"  storage_encrypted   = true",
			"  multi_az            = true",
			"  deletion_protection = true",
			"}",
			'resource "aws_s3_bucket" "logs" {',
			'  bucket = "logs"',
			"}",
			'resource "aws_s3_bucket_public_access_block" "logs" {',
			"  bucket                  = aws_s3_bucket.logs.id",
			"  block_public_acls       = true",
			"  block_public_policy     = true",
			"  ignore_public_acls      = true",
			"  restrict_public_buckets = true",
			"}",
			'resource "aws_eks_cluster" "k8s" {',
			'  name = "k8s"',
			"  vpc_config {",
			"    endpoint_public_access = false",
			"  }",
			"}",
		].join("\n")
	);
	const r = await runIac("aws", dir);
	assert.deepEqual(r.findings, []);
	assert.doesNotMatch(r.facts, /Health findings/);
	assert.match(r.summary, /^5 AWS resource\(s\) in 1 module/);
	assert.doesNotMatch(r.summary, /finding/);
	assert.deepEqual(
		r.checked.map((c) => [c.check, c.scanned]),
		[
			["Inbound rules open to the internet", 1],
			["Publicly accessible databases", 1],
			["Public buckets and storage", 2],
			["Encryption at rest", 1],
			["Kubernetes API exposure", 1],
			["Database deletion protection and availability", 1],
		]
	);
});

test("iac: a folder without IaC gives a summary and no map", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iac-"));
	fs.writeFileSync(path.join(dir, "README.md"), "# nothing here");
	const r = await runIac("aws", dir);
	assert.equal(r.graph, undefined);
	assert.equal(r.summary, "No AWS resources found in the IaC files.");
});

test("iac on a real repository (terraform-like files in the draw.io checkout, if any) does not throw", async () => {
	const repo = path.resolve(__dirname, "../..");
	for (const cloud of ["aws", "azure", "gcp"]) {
		const r = await runIac(cloud, path.join(repo, "standalone/src"));
		assert.ok(r.summary);
	}
});
