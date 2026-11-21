// Unit tests for the Azure and Google Cloud mappers, with recorded-shape CLI JSON
// (test/fixtures/azure, test/fixtures/gcp: fake ids, documented output formats).
// Run from standalone/: node --test test/azure-gcp.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
require("./helpers/ts");

const { checkReadOnly } = require("../src/main/mapper/readOnly");
const { renderGraph } = require("../src/main/mapper/render");
const { checkModelXml } = require("./helpers/xml");
const { azureEnvironmentRecipe: azure } = require("../src/main/mapper/recipes/cloud/azure");
const { allAzureIconFiles, mappedAzureTypes, CONTAINER_STYLES } = require("../src/main/mapper/recipes/cloud/azure/icons");
const { buildAzureGraph, normalizeResource } = require("../src/main/mapper/recipes/cloud/azure/model");
const { gcpEnvironmentRecipe: gcp } = require("../src/main/mapper/recipes/cloud/gcp");
const { allGcpStencils, mappedGcpTypes } = require("../src/main/mapper/recipes/cloud/gcp/icons");
const { catalog } = require("../src/main/mapper/registry");

const WEBAPP = path.resolve(__dirname, "../../drawio/src/main/webapp");
const HAVE_DRAWIO = fs.existsSync(path.join(WEBAPP, "img/lib/azure2"));
const fixture = (cloud, name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", cloud, name), "utf8"));
const SECRETS = ["Sup3rS3cret", "c2VjcmV0LXdvcmtzcGFjZS1rZXk", "InstrumentationKey=", "AccountKey=", "tok_live", "redis-auth-secret", "secretkeymaterial", "LS0tLS1CRUdJTiBQUklWQVRF", "startup-script", "DB_PASSWORD"];

/** A CollectContext whose commands are answered from fixtures; every command must pass the read-only guard. */
function fakeContext(answer) {
	const commands = [];
	const progress = [];
	const ctx = {
		cwd: os.tmpdir(),
		signal: new AbortController().signal,
		progress: (t) => progress.push(t),
		async exec(command, args) {
			assert.equal(checkReadOnly(command, args), undefined, `not read-only: ${command} ${args.join(" ")}`);
			commands.push([command, ...args].join(" "));
			const r = answer(command, args, args.join(" "));
			if (r instanceof Error) return { stdout: "", stderr: r.message, code: 1 };
			return { stdout: typeof r === "string" ? r : JSON.stringify(r ?? []), stderr: "", code: 0 };
		},
	};
	return { ctx, commands, progress };
}

const noSecrets = (label, ...texts) => {
	for (const t of texts) for (const s of SECRETS) assert.ok(!t.includes(s), `${label} leaks "${s}"`);
};
const iconFilesIn = (xml) => [...xml.matchAll(/image=img\/lib\/azure2\/([^;&"]+)/g)].map((m) => m[1]);

// ---------------------------------------------------------------- Azure

const SUB = "00000000-1111-2222-3333-444444444444";
function azureAnswers({ graph = true, failNsg = false } = {}) {
	return (cmd, args, line) => {
		assert.equal(cmd, "az");
		if (line.startsWith("account list")) return fixture("azure", "account-list.json");
		if (line.startsWith("extension list")) return graph ? [{ name: "resource-graph", version: "2.1.1", extensionType: "whl" }] : [];
		if (line.startsWith("graph query")) {
			assert.ok(args.includes("--subscriptions") && args.includes(SUB), "scoped to the subscription");
			const q = args[args.indexOf("-q") + 1];
			if (/ResourceContainers/.test(q)) return fixture("azure", "graph-groups.json");
			return args.includes("--skip-token") ? fixture("azure", "graph-resources-page2.json") : fixture("azure", "graph-resources-page1.json");
		}
		if (line.startsWith("group list")) return fixture("azure", "cli-group-list.json");
		if (line.startsWith("resource list")) return fixture("azure", "cli-resource-list.json");
		if (line.startsWith("network vnet list")) return fixture("azure", "cli-network-vnet-list.json");
		if (line.startsWith("network nic list")) return fixture("azure", "cli-network-nic-list.json");
		if (line.startsWith("network private-endpoint list")) return fixture("azure", "cli-network-private-endpoint-list.json");
		if (line.startsWith("vm list")) return fixture("azure", "cli-vm-list.json");
		if (line.startsWith("webapp list")) return fixture("azure", "cli-webapp-list.json");
		if (failNsg && line.startsWith("network nsg list"))
			return new Error("ERROR: (AuthorizationFailed) The client 'someone@contoso.example' does not have authorization to perform action 'Microsoft.Network/networkSecurityGroups/read'");
		return [];
	};
}

const byLabel = (g, label) => g.nodes.find((n) => n.label === label);
const parentLabel = (g, label) => {
	const n = byLabel(g, label);
	assert.ok(n, `no node ${label}`);
	return g.nodes.find((p) => p.id === n.parent)?.label;
};
const hasEdge = (g, from, to, label) => g.edges.some((e) => byLabel(g, from)?.id === e.from && byLabel(g, to)?.id === e.to && (label === undefined || e.label === label));

test("Azure icons: 50+ resource types mapped, every icon file exists in the bundled draw.io", { skip: !HAVE_DRAWIO }, () => {
	assert.ok(mappedAzureTypes().length >= 50, `only ${mappedAzureTypes().length} types`);
	for (const f of allAzureIconFiles()) assert.ok(fs.existsSync(path.join(WEBAPP, "img/lib/azure2", f)), `missing icon ${f}`);
	for (const [k, style] of Object.entries(CONTAINER_STYLES)) for (const f of iconFilesIn(style)) assert.ok(fs.existsSync(path.join(WEBAPP, "img/lib/azure2", f)), `${k}: missing ${f}`);
});

test("Azure: subscription options (default first), resource group options, guard-approved commands", async () => {
	const { ctx } = fakeContext(azureAnswers());
	const subs = await azure.loadOptions("subscription", {}, ctx);
	assert.equal(subs[0].value, SUB);
	assert.match(subs[0].label, /Contoso Production .* default/);
	const rgs = await azure.loadOptions("resourceGroups", { subscription: SUB }, ctx);
	assert.deepEqual(rgs[0], { value: "", label: "All resource groups" });
	assert.ok(rgs.some((o) => o.value === "rg-network"));
});

test("Azure via Resource Graph: containment by subnet, reference edges, folded NICs and disks, no secrets", async () => {
	const { ctx, commands, progress } = fakeContext(azureAnswers());
	const r = await azure.collect({ subscription: SUB, resourceGroups: "", includeNetwork: "true" }, ctx);
	assert.ok(commands.some((c) => c.includes("--skip-token")), "follows Resource Graph pages");
	assert.ok(!commands.some((c) => /^az (vm|network|resource) /.test(c)), "no per-service lists when Resource Graph works");
	assert.ok(progress.length > 0);
	assert.deepEqual(r.warnings, []);
	const g = r.graph;
	assert.match(r.summary, /27 resource\(s\) in 5 resource group\(s\), 2 VNet\(s\), 7 subnet\(s\), \d+ connection\(s\) · Resource Graph/);

	// Containment: subscription › RG › VNet › subnet › resources (across resource groups).
	assert.equal(parentLabel(g, "rg-network  (westeurope)"), "Subscription: Contoso Production");
	assert.equal(parentLabel(g, "vnet-spoke  10.1.0.0/16"), "rg-network  (westeurope)");
	assert.equal(parentLabel(g, "snet-web  10.1.1.0/24  · NSG nsg-web"), "vnet-spoke  10.1.0.0/16");
	assert.equal(parentLabel(g, "vm-web-01"), "snet-web  10.1.1.0/24  · NSG nsg-web", "VM placed by its NIC");
	assert.equal(parentLabel(g, "pe-sql"), "snet-pe  10.1.4.0/24");
	assert.equal(parentLabel(g, "app-api"), "snet-appint  10.1.5.0/24", "App Service VNet integration");
	assert.equal(parentLabel(g, "aks-prod"), "snet-aks  10.1.2.0/23", "AKS node pool subnet");
	assert.equal(parentLabel(g, "aks-system-12345678-vmss"), "snet-aks  10.1.2.0/23", "node scale set (MC_ group) via subnet ipConfigurations");
	assert.equal(parentLabel(g, "agw-prod"), "snet-appgw  10.1.6.0/24");
	assert.equal(parentLabel(g, "bas-hub"), "AzureBastionSubnet  10.0.0.0/26");
	assert.equal(parentLabel(g, "plan-web"), "rg-app  (westeurope)");
	assert.equal(parentLabel(g, "sql-prod"), "rg-data  (westeurope)");
	assert.equal(parentLabel(g, "orders"), "rg-data  (westeurope)", "child resource next to its parent");
	assert.ok(byLabel(g, "rg-empty  (westeurope)"), "empty resource groups are shown");
	// Folded and hidden.
	assert.ok(!g.nodes.some((n) => /^nic-web|\.nic\.|^osdisk|AzureMonitorLinuxAgent|link-spoke/.test(n.label)), "NICs, disks, extensions and DNS links are folded");
	assert.ok(!byLabel(g, "master"), "the SQL master database is hidden");
	const vmData = byLabel(g, "vm-web-01").data;
	assert.equal(vmData.privateIPs, "10.1.1.4");
	assert.equal(vmData.disks, "osdisk-web-01");
	assert.equal(vmData.vmSize, "Standard_B2s");
	assert.match(vmData.resourceId, /^\/subscriptions\/0{8}-.*\/virtualMachines\/vm-web-01$/);
	assert.equal(vmData.type, "Microsoft.Compute/virtualMachines");
	assert.equal(vmData.location, "westeurope");
	assert.equal(vmData.resourceGroup, "rg-app");
	assert.equal(vmData.subscriptionId, SUB);
	// Unknown types: generic icon with the type in the label.
	const widget = byLabel(g, "widget-1 (widgets)");
	assert.match(widget.style, /general\/All_Resources\.svg/);
	assert.match(byLabel(g, "func-jobs").style, /Function_Apps\.svg/, "function apps by kind");

	// Edges.
	assert.ok(hasEdge(g, "vnet-hub  10.0.0.0/16", "vnet-spoke  10.1.0.0/16", "peering") || hasEdge(g, "vnet-spoke  10.1.0.0/16", "vnet-hub  10.0.0.0/16", "peering"));
	assert.equal(g.edges.filter((e) => e.kind === "peering").length, 1, "a peering is one edge, not two");
	assert.ok(hasEdge(g, "pip-agw", "agw-prod", "public IP"));
	assert.ok(hasEdge(g, "pip-bastion", "bas-hub", "public IP"));
	assert.ok(hasEdge(g, "pe-sql", "sql-prod", "sqlServer"), "private endpoint → service");
	assert.ok(hasEdge(g, "pe-stblob", "stproddata", "blob"));
	assert.ok(hasEdge(g, "agw-prod", "vm-web-01", "backend"), "gateway → backend VMs");
	assert.ok(hasEdge(g, "app-api", "plan-web", "plan"));
	assert.ok(hasEdge(g, "app-api", "id-app", "identity"), "user-assigned identity (id in an object key)");
	assert.ok(hasEdge(g, "aks-prod", "aks-system-12345678-vmss", "node pool"));
	assert.ok(hasEdge(g, "aks-prod", "law-prod", "logs"));
	assert.ok(hasEdge(g, "snet-appint  10.1.5.0/24", "kv-app-prod", "VNet rule"), "service endpoint rule, not containment");
	assert.ok(hasEdge(g, "privatelink.database.windows.net", "vnet-spoke  10.1.0.0/16", "DNS link"));
	assert.ok(hasEdge(g, "sql-prod", "orders"), "parent → child");
	assert.ok(!g.edges.some((e) => g.nodes.find((n) => n.id === e.to)?.kind === "azure:subnet" && e.kind !== "vnetRule"), "no edges into subnets for attachments (containment shows them)");
	const pairs = g.edges.map((e) => `${e.from}|${e.to}`);
	assert.equal(new Set(pairs).size, pairs.length, "no duplicate edges");

	// Facts, rendering, secrets.
	assert.match(r.facts, /Microsoft\.Network\/networkSecurityGroups \*\*nsg-web\*\*.*Allow inb Tcp 22 from \*/);
	assert.match(r.facts, /allowBlobPublicAccess=true/);
	assert.match(r.facts, /agw-prod.*waf=none/);
	const { xml } = renderGraph(g, { recipe: azure.id });
	checkModelXml(xml);
	if (HAVE_DRAWIO) for (const f of iconFilesIn(xml)) assert.ok(fs.existsSync(path.join(WEBAPP, "img/lib/azure2", f)), `rendered icon missing: ${f}`);
	noSecrets("Azure", r.facts, xml, JSON.stringify(g));
	assert.match(azure.agentPrompt({}, r), /single points of failure[\s\S]*<facts collected read-only/);
	const dig = azure.digDeeper([{ label: "vm-web-01", data: vmData }], "is SSH open?");
	assert.match(dig, /read-only az commands[\s\S]*is SSH open\?[\s\S]*virtualMachines\/vm-web-01/);
});

test("Azure without the resource-graph extension: CLI lists (flattened JSON) give the same picture; permission errors are warnings", async () => {
	const { ctx, commands } = fakeContext(azureAnswers({ graph: false, failNsg: true }));
	const r = await azure.collect({ subscription: SUB, includeNetwork: "true" }, ctx);
	assert.ok(!commands.some((c) => c.startsWith("az graph")), "never calls Resource Graph without the extension");
	assert.ok(commands.some((c) => c.startsWith("az resource list --subscription")));
	assert.ok(commands.some((c) => c.startsWith("az network vnet list")) && commands.some((c) => c.startsWith("az vm list")));
	assert.ok(!commands.some((c) => c.startsWith("az sql server list") && false));
	assert.match(r.summary, /az CLI$/);
	assert.ok(r.warnings.some((w) => /resource-graph/.test(w)));
	assert.ok(r.warnings.some((w) => /No permission to list network security groups/.test(w)), r.warnings.join("\n"));
	const g = r.graph;
	assert.equal(parentLabel(g, "vm-web-01"), "snet-web  10.1.1.0/24  · NSG nsg-web");
	assert.equal(parentLabel(g, "pe-stblob"), "snet-pe  10.1.4.0/24");
	assert.equal(parentLabel(g, "app-api"), "snet-appint  10.1.5.0/24");
	assert.ok(hasEdge(g, "pe-sql", "sql-prod", "sqlServer"));
	assert.ok(hasEdge(g, "vnet-hub  10.0.0.0/16", "vnet-spoke  10.1.0.0/16") || hasEdge(g, "vnet-spoke  10.1.0.0/16", "vnet-hub  10.0.0.0/16"));
	assert.equal(byLabel(g, "vm-web-01").data.privateIPs, "10.1.1.4");
	checkModelXml(renderGraph(g, { recipe: azure.id }).xml);
	noSecrets("Azure CLI path", r.facts, JSON.stringify(g));
});

test("Azure: networking detail off, and a resource group filter that keeps the VNets it attaches to", () => {
	const rows = [...fixture("azure", "graph-resources-page1.json").data, ...fixture("azure", "graph-resources-page2.json").data].map(normalizeResource);
	const base = { subscription: { id: SUB, name: "Contoso Production" }, resourceGroups: fixture("azure", "graph-groups.json").data, resources: rows, source: "resource-graph" };
	const off = buildAzureGraph({ ...base, includeNetwork: false }).graph;
	assert.ok(!off.nodes.some((n) => ["azure:vnet", "azure:subnet", "azure:networkinterfaces", "azure:publicipaddresses", "azure:privateendpoints", "azure:networksecuritygroups"].includes(n.kind)));
	assert.equal(parentLabel(off, "vm-web-01"), "rg-app  (westeurope)");
	checkModelXml(renderGraph(off, { recipe: azure.id }).xml);

	const only = buildAzureGraph({ ...base, includeNetwork: true, resourceGroupFilter: ["rg-app"] }).graph;
	assert.ok(byLabel(only, "vm-web-01") && byLabel(only, "aks-prod"));
	assert.ok(!byLabel(only, "sql-prod") && !byLabel(only, "rg-data  (westeurope)"), "other groups are left out");
	assert.ok(byLabel(only, "vnet-spoke  10.1.0.0/16"), "the VNet the selected group's resources attach to");
	assert.ok(!byLabel(only, "vnet-hub  10.0.0.0/16"), "unrelated VNets are left out");
	assert.equal(parentLabel(only, "vm-web-01"), "snet-web  10.1.1.0/24  · NSG nsg-web");
	checkModelXml(renderGraph(only, { recipe: azure.id }).xml);
});

test("Azure: not signed in and cancelled runs are clear errors", async () => {
	const { ctx } = fakeContext(() => new Error("ERROR: Please run 'az login' to setup account."));
	await assert.rejects(azure.collect({ subscription: SUB }, ctx), (e) => /not signed in/.test(e.message) && /az login/.test(e.hint));
	const stopped = fakeContext(azureAnswers());
	const ac = new AbortController();
	ac.abort();
	stopped.ctx.signal = ac.signal;
	await assert.rejects(azure.collect({ subscription: SUB }, stopped.ctx), /Cancelled/);
	const bad = fakeContext(azureAnswers());
	await assert.rejects(azure.collect({ subscription: SUB, resourceGroups: "rg'; drop" }, bad.ctx), /not a valid resource group/);
});

// ---------------------------------------------------------------- Google Cloud

const PROJECT = "acme-shop-prod";

/** The gcp2 stencil names draw.io ships (decoded from its compiled stencil bundle). */
function drawioGcp2Stencils() {
	const src = fs.readFileSync(path.join(WEBAPP, "js/stencils.min.js"), "utf8");
	const registry = { loadStencil() {} };
	const zlib = require("zlib");
	const sandbox = {
		mxStencilRegistry: registry,
		STENCIL_PATH: "stencils",
		window: { setTimeout },
		atob,
		TextDecoder,
		Uint8Array,
		Map,
		pako: { inflateRaw: (a) => new Uint8Array(zlib.inflateRawSync(Buffer.from(a))) },
	};
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox);
	const doc = registry.loadStencil("stencils/gcp2.xml");
	const names = new Set();
	const walk = (n) => {
		for (let c = n.firstChild; c; c = c.nextSibling) {
			if (c.nodeName === "shape") names.add(String(c.attrs.name).toLowerCase().replace(/ /g, "_"));
			else walk(c);
		}
	};
	walk(doc.documentElement);
	return names;
}

test("GCP icons: 40+ asset types mapped to mxgraph.gcp2 stencils that exist in the bundled draw.io", { skip: !fs.existsSync(path.join(WEBAPP, "js/stencils.min.js")) }, () => {
	assert.ok(mappedGcpTypes().length >= 40, `only ${mappedGcpTypes().length} types`);
	const names = drawioGcp2Stencils();
	assert.ok(names.size > 200, `decoded only ${names.size} stencils`);
	for (const s of allGcpStencils()) assert.ok(names.has(s), `mxgraph.gcp2.${s} is not a draw.io stencil`);
	// The renderer references only those.
	const sidebar = fs.readFileSync(path.join(WEBAPP, "js/diagramly/sidebar/Sidebar-GCP2.js"), "utf8");
	assert.match(sidebar, /shape=mxgraph\.gcp2\./, "the GCP2 library uses mxgraph.gcp2.* shapes");
});

function gcpAnswers({ asset = true, failGke = false } = {}) {
	return (cmd, args, line) => {
		assert.equal(cmd, "gcloud");
		assert.ok(args.includes("--format=json"));
		const project = args.find((a) => a.startsWith("--project="));
		if (project) assert.equal(project, `--project=${PROJECT}`);
		if (line.startsWith("projects list")) {
			const all = fixture("gcp", "projects-list.json");
			const f = args.find((a) => a.startsWith("--filter=projectId:"));
			return f ? all.filter((p) => p.projectId === f.split(":")[1]) : all;
		}
		if (line.startsWith("asset search-all-resources")) {
			assert.ok(args.includes(`--scope=projects/${PROJECT}`));
			return asset
				? fixture("gcp", "asset-search.json")
				: new Error(
						"ERROR: (gcloud.asset.search-all-resources) PERMISSION_DENIED: Cloud Asset API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudasset.googleapis.com/overview?project=123456789012 then retry. reason: SERVICE_DISABLED"
				  );
		}
		const lists = {
			"compute networks subnets list": "compute-networks-subnets-list",
			"compute networks list": "compute-networks-list",
			"compute firewall-rules list": "compute-firewall-rules-list",
			"compute instances list": "compute-instances-list",
			"compute forwarding-rules list": "compute-forwarding-rules-list",
			"compute addresses list": "compute-addresses-list",
			"compute routers list": "compute-routers-list",
			"container clusters list": "container-clusters-list",
			"run services list": "run-services-list",
			"functions list": "functions-list",
			"sql instances list": "sql-instances-list",
			"storage buckets list": "storage-buckets-list",
			"pubsub topics list": "pubsub-topics-list",
			"pubsub subscriptions list": "pubsub-subscriptions-list",
		};
		if (failGke && line.startsWith("container clusters list"))
			return new Error("ERROR: (gcloud.container.clusters.list) ResponseError: code=403, message=Kubernetes Engine API has not been used in project 123456789012 before or it is disabled.");
		for (const [prefix, file] of Object.entries(lists)) if (line.startsWith(prefix)) return fixture("gcp", `${file}.json`);
		assert.fail(`unexpected command: gcloud ${line}`);
	};
}

test("GCP: project options skip deleted projects", async () => {
	const { ctx } = fakeContext(gcpAnswers());
	const opts = await gcp.loadOptions("project", {}, ctx);
	assert.deepEqual(
		opts.map((o) => o.value),
		["acme-sandbox", PROJECT]
	);
	assert.equal(opts[1].label, "Acme Shop (prod) (acme-shop-prod)");
});

test("GCP via Cloud Asset Inventory: project › VPC › region › subnetwork, serverless by region, flows and firewall exposure", async () => {
	const { ctx, commands } = fakeContext(gcpAnswers());
	const r = await gcp.collect({ project: PROJECT }, ctx);
	assert.ok(commands.some((c) => /asset search-all-resources --scope=projects\/acme-shop-prod --read-mask=\*/.test(c)));
	assert.ok(!commands.some((c) => /compute instances list/.test(c)), "no per-service lists when the asset JSON is complete");
	assert.deepEqual(r.warnings, []);
	assert.match(r.summary, /28 resource\(s\), 2 VPC network\(s\), 4 subnetwork\(s\), \d+ connection\(s\) · Cloud Asset Inventory/);
	const g = r.graph;
	assert.equal(parentLabel(g, "VPC network vpc-prod"), "Project: Acme Shop (prod) (acme-shop-prod)");
	assert.equal(parentLabel(g, "subnet-web  10.10.0.0/24"), "us-central1");
	assert.equal(parentLabel(g, "web-1"), "subnet-web  10.10.0.0/24");
	assert.equal(parentLabel(g, "batch-eu-1"), "subnet-eu  10.30.0.0/24");
	assert.equal(parentLabel(g, "shop-cluster"), "subnet-gke  10.20.0.0/20");
	assert.equal(parentLabel(g, "web-ig"), "subnet-web  10.10.0.0/24");
	assert.equal(parentLabel(g, "allow-ssh-anywhere"), "VPC network vpc-prod", "firewall rules belong to the network");
	assert.equal(parentLabel(g, "orders-db"), "us-central1", "Cloud SQL with private IP inside the VPC's region");
	assert.equal(g.nodes.find((n) => n.id === byLabel(g, "orders-db").parent).parent, byLabel(g, "VPC network vpc-prod").id);
	assert.equal(parentLabel(g, "orders-api"), "Region us-central1", "serverless by region");
	assert.equal(parentLabel(g, "process-orders"), "Region us-central1");
	assert.equal(parentLabel(g, "acme-shop-assets"), "Project: Acme Shop (prod) (acme-shop-prod)", "multi-regional bucket in the project");
	assert.match(byLabel(g, "router-nat").style, /mxgraph\.gcp2\.cloud_nat/);
	assert.match(byLabel(g, "w1 (Widget)").style, /mxgraph\.gcp2\.blue_hexagon/, "unknown types get a generic icon");
	// Folded / hidden.
	assert.ok(!g.nodes.some((n) => /^gke-shop-cluster|default-pool$|default-route|compute\.googleapis\.com$|0123456789abcdef/.test(n.label)), "GKE nodes, node pools, routes, APIs, keys not drawn");
	assert.match(byLabel(g, "shop-cluster").data.includes, /1 Instance/);
	assert.match(byLabel(g, "web-1").data.includes, /1 Disk/);
	assert.equal(g.nodes.filter((n) => n.label === "process-orders").length, 1, "the Cloud Run service behind a 2nd-gen function is folded into it");
	assert.equal(byLabel(g, "process-orders").kind, "gcp:cloudfunctions:Function");
	assert.ok(!byLabel(g, "orders") || byLabel(g, "orders").kind === "gcp:pubsub:Topic", "BigQuery tables fold into their dataset");
	const web1 = byLabel(g, "web-1").data;
	assert.equal(web1.name, "//compute.googleapis.com/projects/acme-shop-prod/zones/us-central1-a/instances/web-1");
	assert.equal(web1.assetType, "compute.googleapis.com/Instance");
	assert.equal(web1.location, "us-central1-a");
	assert.equal(web1.project, PROJECT);
	assert.equal(web1.externalIPs, "34.123.0.10");
	// Edges.
	assert.ok(hasEdge(g, "VPC network vpc-prod", "VPC network vpc-shared", "peering") || hasEdge(g, "VPC network vpc-shared", "VPC network vpc-prod", "peering"));
	assert.equal(g.edges.filter((e) => e.kind === "peering").length, 1);
	assert.ok(hasEdge(g, "orders", "process-orders", "trigger"), "Pub/Sub topic → function");
	assert.ok(hasEdge(g, "orders", "orders-push", "messages"));
	assert.ok(hasEdge(g, "orders-push", "orders-api", "push"), "push subscription → the Cloud Run service behind the endpoint");
	assert.ok(hasEdge(g, "orders-api", "orders-db", "Cloud SQL"));
	assert.ok(hasEdge(g, "orders-api", "run-conn", "VPC connector"));
	assert.ok(hasEdge(g, "allow-ssh-anywhere", "web-1", "internet tcp:22"), "firewall → tagged instance");
	assert.ok(!hasEdge(g, "allow-ssh-anywhere", "web-2"), "web-2 has no ssh tag");
	assert.ok(hasEdge(g, "web-lb-fr", "web-lb-https") && hasEdge(g, "web-lb", "web-backend") && hasEdge(g, "web-backend", "web-ig"), "load balancer chain");
	assert.ok(!g.edges.some((e) => g.nodes.find((n) => n.id === e.to)?.kind === "gcp:subnetwork"), "no edges into subnetworks (containment shows them)");
	// Facts, rendering, secrets.
	assert.match(r.facts, /allow-ssh-anywhere.*allow=tcp:22; sourceRanges=0\.0\.0\.0\/0/);
	assert.match(r.facts, /orders-db.*publicIp=true; authorizedNetworks=0\.0\.0\.0\/0/);
	assert.match(r.facts, /Not drawn: .*serviceusage\.googleapis\.com\/Service 2/);
	const { xml } = renderGraph(g, { recipe: gcp.id });
	checkModelXml(xml);
	noSecrets("GCP", r.facts, xml, JSON.stringify(g));
	assert.match(gcp.agentPrompt({}, r), /firewall rules open to 0\.0\.0\.0\/0[\s\S]*<facts collected read-only/);
	assert.match(gcp.digDeeper([{ label: "web-1", data: web1 }], ""), /read-only gcloud commands[\s\S]*instances\/web-1/);
});

test("GCP with the Cloud Asset API disabled: per-service lists, a clear warning, and the same core picture", async () => {
	const { ctx, commands } = fakeContext(gcpAnswers({ asset: false, failGke: true }));
	const r = await gcp.collect({ project: PROJECT }, ctx);
	assert.ok(commands.some((c) => c.startsWith("gcloud compute instances list --project=acme-shop-prod")));
	assert.ok(r.warnings.some((w) => /Cloud Asset API is not enabled/.test(w)), r.warnings.join("\n"));
	assert.ok(r.warnings.some((w) => /APIs not enabled .*GKE clusters/.test(w)), r.warnings.join("\n"));
	assert.match(r.summary, /gcloud lists$/);
	const g = r.graph;
	assert.equal(parentLabel(g, "web-1"), "subnet-web  10.10.0.0/24");
	assert.equal(parentLabel(g, "orders-db"), "us-central1");
	assert.equal(parentLabel(g, "orders-api"), "Region us-central1");
	assert.ok(!byLabel(g, "shop-cluster"), "GKE could not be listed");
	assert.ok(byLabel(g, "gke-shop-cluster-default-pool-1a2b3c4d-x7k2"), "without its cluster, a GKE node is an ordinary VM");
	assert.equal(byLabel(g, "acme-shop-assets").data.publicAccessPrevention, "inherited", "gcloud storage's snake_case fields");
	assert.ok(hasEdge(g, "orders", "process-orders", "trigger"));
	assert.ok(hasEdge(g, "orders-push", "orders-api", "push"));
	assert.ok(hasEdge(g, "allow-web", "web-2"));
	checkModelXml(renderGraph(g, { recipe: gcp.id }).xml);
	noSecrets("GCP lists", r.facts, JSON.stringify(g));
});

test("GCP: invalid project ids and missing sign-in are clear errors", async () => {
	const { ctx } = fakeContext(gcpAnswers());
	await assert.rejects(gcp.collect({ project: "bad project; rm" }, ctx), /not a valid project id/);
	const out = fakeContext(() => new Error("ERROR: (gcloud.projects.list) You do not currently have an active account selected."));
	await assert.rejects(gcp.collect({ project: PROJECT }, out.ctx), (e) => /not signed in/.test(e.message) && /gcloud auth login/.test(e.hint));
});

test("catalog lists the Azure and Google Cloud environment maps", () => {
	const ids = catalog().recipes.map((r) => r.id);
	assert.ok(ids.includes("azure.environment") && ids.includes("gcp.environment"));
});
