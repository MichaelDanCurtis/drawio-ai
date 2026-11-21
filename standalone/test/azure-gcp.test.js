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

const SEVERITIES = new Set(["high", "medium", "low", "info"]);
/** The findings contract: unique stable ids `${kind}:…`, known severities, evidence and a fix, nodes that are drawn; coverage with counts. */
function assertFindingsContract(graph, findings, checked) {
	const ids = new Set(graph.nodes.map((n) => n.id));
	const seen = new Set();
	for (const f of findings) {
		assert.ok(f.id.startsWith(`${f.kind}:`), f.id);
		assert.ok(!seen.has(f.id), `duplicate finding id ${f.id}`);
		seen.add(f.id);
		assert.ok(SEVERITIES.has(f.severity), f.severity);
		assert.ok(f.title && f.detail && f.fix, f.id);
		assert.ok(f.nodeIds.length > 0, `${f.id} has nodes`);
		for (const n of f.nodeIds) assert.ok(ids.has(n), `${f.id}: node ${n} is not in the graph`);
	}
	assert.ok(Array.isArray(checked) && checked.length > 0, "checked is filled");
	for (const c of checked) assert.ok(c.check && Number.isInteger(c.scanned) && c.scanned >= 0, JSON.stringify(c));
}
/** The finding of a kind on the shape with this label. */
const findingOn = (g, findings, kind, label) => {
	const node = g.nodes.find((n) => n.label === label);
	assert.ok(node, `no node ${label}`);
	return findings.find((f) => f.kind === kind && f.nodeIds.includes(node.id));
};

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
	assert.match(r.summary, /27 resource\(s\) in 5 resource group\(s\), 2 VNet\(s\), 7 subnet\(s\), \d+ connection\(s\), 7 finding\(s\) \(1 high\) · Resource Graph$/);

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

test("Azure: health findings with evidence on the right shapes, stable ids, coverage, no secrets", async () => {
	const { ctx } = fakeContext(azureAnswers());
	const r = await azure.collect({ subscription: SUB, includeNetwork: "true" }, ctx);
	const g = r.graph;
	assertFindingsContract(g, r.findings, r.checked);
	const has = (kind, label, severity) => {
		const f = findingOn(g, r.findings, kind, label);
		assert.ok(f, `${kind} on ${label}: ${r.findings.map((x) => x.id).join(", ")}`);
		assert.equal(f.severity, severity, f.id);
		return f;
	};
	const nsg = has("open-ingress", "nsg-web", "high");
	assert.equal(nsg.title, "NSG nsg-web opens SSH to the internet");
	assert.match(nsg.detail, /allow-ssh-any \(priority 110\): allow Tcp 22 from \*/);
	assert.doesNotMatch(nsg.detail, /443/, "the HTTPS rule is not part of it");
	for (const label of ["vm-web-01", "snet-web  10.1.1.0/24  · NSG nsg-web"]) assert.ok(findingOn(g, r.findings, "open-ingress", label), `NSG finding also on ${label}`);
	assert.equal(nsg.id, `open-ingress:${byLabel(g, "nsg-web").id}`);
	has("public-blob-access", "stproddata", "medium");
	has("https-not-enforced", "func-jobs", "medium");
	assert.ok(!findingOn(g, r.findings, "https-not-enforced", "app-api"), "httpsOnly = true is fine");
	has("public-control-plane", "aks-prod", "medium");
	has("no-purge-protection", "kv-app-prod", "low");
	assert.ok(!findingOn(g, r.findings, "public-network-access", "kv-app-prod"), "the vault denies by default");
	has("no-waf", "agw-prod", "info");
	has("single-instance", "plan-web", "info");
	assert.ok(!findingOn(g, r.findings, "public-network-access", "sql-prod"), "SQL with public access disabled");
	assert.equal(r.findings.length, 7, r.findings.map((x) => x.id).join("\n"));
	const check = (re) => r.checked.find((c) => re.test(c.check));
	assert.equal(check(/^NSG rules/).scanned, 2, "inbound rules of nsg-web");
	assert.equal(check(/^Storage accounts/).scanned, 1);
	assert.equal(check(/^Web apps/).scanned, 2);
	assert.ok(!check(/^Redis/), "nothing to check: left out");
	assert.match(r.facts, /## Health findings[\s\S]*\[high\] NSG nsg-web opens SSH to the internet/);
	noSecrets("Azure findings", JSON.stringify(r.findings), JSON.stringify(r.checked));
	const again = await azure.collect({ subscription: SUB, includeNetwork: "true" }, fakeContext(azureAnswers()).ctx);
	assert.deepEqual(again.findings, r.findings, "stable across runs");
	// Without networking detail the NSG finding stays on the VMs behind it, with the same id and evidence.
	const rows = [...fixture("azure", "graph-resources-page1.json").data, ...fixture("azure", "graph-resources-page2.json").data].map(normalizeResource);
	const off = buildAzureGraph({ subscription: { id: SUB, name: "Contoso Production" }, resourceGroups: fixture("azure", "graph-groups.json").data, resources: rows, source: "resource-graph", includeNetwork: false });
	assertFindingsContract(off.graph, off.findings, off.checked);
	const offNsg = off.findings.find((f) => f.id === nsg.id);
	assert.ok(offNsg && offNsg.detail === nsg.detail, "same finding without networking detail");
	assert.deepEqual(offNsg.nodeIds.map((id) => off.graph.nodes.find((n) => n.id === id).label).sort(), ["vm-web-01", "vm-web-02"]);
	// The CLI path without NSG permissions: no NSG finding (no rules were read), and the coverage says 0.
	const cli = await azure.collect({ subscription: SUB, includeNetwork: "true" }, fakeContext(azureAnswers({ graph: false, failNsg: true })).ctx);
	assert.ok(!cli.findings.some((f) => f.kind === "open-ingress"));
	assert.equal(cli.checked.find((c) => /^NSG rules/.test(c.check)).scanned, 0);
});

test("Azure: a well-configured subscription has no findings", () => {
	const id = (t, n) => `/subscriptions/${SUB}/resourceGroups/rg/providers/${t}/${n}`;
	const resources = [
		{ id: id("Microsoft.Network/networkSecurityGroups", "nsg"), type: "Microsoft.Network/networkSecurityGroups", name: "nsg", properties: { securityRules: [{ name: "https", properties: { direction: "Inbound", access: "Allow", protocol: "Tcp", sourceAddressPrefix: "Internet", destinationPortRange: "443", priority: 100 } }, { name: "ssh-office", properties: { direction: "Inbound", access: "Allow", protocol: "Tcp", sourceAddressPrefix: "203.0.113.0/24", destinationPortRange: "22", priority: 110 } }, { name: "deny-rdp", properties: { direction: "Inbound", access: "Deny", protocol: "*", sourceAddressPrefix: "*", destinationPortRange: "3389", priority: 120 } }] } },
		{ id: id("Microsoft.Storage/storageAccounts", "st"), type: "Microsoft.Storage/storageAccounts", name: "st", properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: "TLS1_2" } },
		{ id: id("Microsoft.KeyVault/vaults", "kv"), type: "Microsoft.KeyVault/vaults", name: "kv", properties: { tenantId: "t", enablePurgeProtection: true, publicNetworkAccess: "Disabled" } },
		{ id: id("Microsoft.Web/sites", "app"), type: "Microsoft.Web/sites", name: "app", properties: { httpsOnly: true, siteConfig: { minTlsVersion: "1.2", ftpsState: "Disabled" } } },
		{ id: id("Microsoft.Sql/servers", "sql"), type: "Microsoft.Sql/servers", name: "sql", properties: { publicNetworkAccess: "Disabled", minimalTlsVersion: "1.2" } },
		{ id: id("Microsoft.ContainerService/managedClusters", "aks"), type: "Microsoft.ContainerService/managedClusters", name: "aks", properties: { kubernetesVersion: "1.30", apiServerAccessProfile: { enablePrivateCluster: true } } },
	].map((r) => normalizeResource({ ...r, resourceGroup: "rg", location: "westeurope" }));
	const built = buildAzureGraph({ subscription: { id: SUB, name: "Clean" }, resourceGroups: [{ name: "rg", location: "westeurope" }], resources, source: "resource-graph", includeNetwork: true });
	assert.deepEqual(built.findings, []);
	assert.doesNotMatch(built.facts, /Health findings/);
	assert.equal(built.checked.find((c) => /^NSG rules/.test(c.check)).scanned, 3);
	assert.ok(built.checked.length >= 6, built.checked.map((c) => c.check).join(", "));
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
		if (line.startsWith("asset search-all-iam-policies")) {
			assert.ok(args.includes(`--scope=projects/${PROJECT}`));
			return args.includes("--query=policy:allUsers") ? fixture("gcp", "asset-iam-policies.json") : [];
		}
		if (line.startsWith("storage buckets get-iam-policy gs://acme-shop-assets"))
			return { bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }, { role: "roles/storage.legacyBucketOwner", members: ["projectOwner:acme-shop-prod"] }], etag: "CAE=" };
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
	assert.match(r.summary, /28 resource\(s\), 2 VPC network\(s\), 4 subnetwork\(s\), \d+ connection\(s\), 6 finding\(s\) \(3 high\) · Cloud Asset Inventory$/);
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

test("GCP: health findings on firewall rules, instances, Cloud SQL, GKE and public buckets; the same ids from both collection paths", async () => {
	const { ctx, commands } = fakeContext(gcpAnswers());
	const r = await gcp.collect({ project: PROJECT }, ctx);
	const g = r.graph;
	assertFindingsContract(g, r.findings, r.checked);
	assert.ok(commands.some((c) => c.startsWith("gcloud asset search-all-iam-policies --scope=projects/acme-shop-prod --query=policy:allUsers")));
	assert.ok(commands.some((c) => c.includes("--query=policy:allAuthenticatedUsers")));
	const has = (kind, label, severity) => {
		const f = findingOn(g, r.findings, kind, label);
		assert.ok(f, `${kind} on ${label}: ${r.findings.map((x) => x.id).join(", ")}`);
		assert.equal(f.severity, severity, f.id);
		return f;
	};
	const fw = has("open-ingress", "allow-ssh-anywhere", "high");
	assert.ok(findingOn(g, r.findings, "open-ingress", "web-1"), "the instance the rule opens");
	assert.ok(!findingOn(g, r.findings, "open-ingress", "web-2"), "web-2 has no ssh tag");
	assert.match(fw.detail, /allows tcp:22 from 0\.0\.0\.0\/0 to instances tagged ssh \(1 instance\(s\), 1 with an external IP: web-1\)/);
	assert.ok(!findingOn(g, r.findings, "open-ingress", "allow-web"), "80/443 from the internet is not a finding");
	const bucket = has("public-bucket", "acme-shop-assets", "high");
	assert.match(bucket.detail, /allUsers → roles\/storage\.objectViewer/);
	assert.doesNotMatch(bucket.detail, /ops@acme\.example/, "only the public members are named");
	assert.ok(!r.findings.some((f) => f.nodeIds.includes(byLabel(g, "orders-api").id)), "a public Cloud Run invoker is a public API, not a finding");
	has("public-database", "orders-db", "high");
	has("unencrypted-transit", "orders-db", "medium");
	has("single-zone-database", "orders-db", "low");
	has("public-control-plane", "shop-cluster", "medium");
	assert.equal(r.findings.length, 6, r.findings.map((x) => x.id).join("\n"));
	const check = (re) => r.checked.find((c) => re.test(c.check));
	assert.equal(check(/^Firewall rules/).scanned, 3, "enabled ingress rules");
	assert.equal(check(/^Cloud SQL/).scanned, 1);
	assert.ok(check(/^IAM grants/));
	noSecrets("GCP findings", JSON.stringify(r.findings), JSON.stringify(r.checked));
	assert.match(r.facts, /## Health findings[\s\S]*\[high\] Firewall rule allow-ssh-anywhere opens SSH to the internet/);
	const again = await gcp.collect({ project: PROJECT }, fakeContext(gcpAnswers()).ctx);
	assert.deepEqual(again.findings, r.findings, "stable across runs");
	// The per-service lists (no Cloud Asset): bucket policies one by one, same finding ids where the facts are the same.
	const cli = fakeContext(gcpAnswers({ asset: false, failGke: true }));
	const lr = await gcp.collect({ project: PROJECT }, cli.ctx);
	assertFindingsContract(lr.graph, lr.findings, lr.checked);
	assert.ok(cli.commands.some((c) => c.startsWith("gcloud storage buckets get-iam-policy gs://acme-shop-assets")));
	for (const id of [fw.id, bucket.id, findingOn(g, r.findings, "public-database", "orders-db").id]) assert.ok(lr.findings.some((f) => f.id === id), `${id} from the lists too`);
	assert.ok(!lr.findings.some((f) => f.kind === "public-control-plane"), "GKE could not be listed: nothing claimed about it");
});

test("GCP: a well-configured project has no findings", () => {
	const { buildGcpGraph } = require("../src/main/mapper/recipes/cloud/gcp/model");
	const net = "https://www.googleapis.com/compute/v1/projects/p-clean/global/networks/vpc";
	const resources = [
		{ name: "//compute.googleapis.com/projects/p-clean/global/networks/vpc", assetType: "compute.googleapis.com/Network", displayName: "vpc", location: "global", data: { autoCreateSubnetworks: false } },
		{ name: "//compute.googleapis.com/projects/p-clean/global/firewalls/https", assetType: "compute.googleapis.com/Firewall", displayName: "https", location: "global", data: { network: net, direction: "INGRESS", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["443"] }] } },
		{ name: "//compute.googleapis.com/projects/p-clean/global/firewalls/iap-ssh", assetType: "compute.googleapis.com/Firewall", displayName: "iap-ssh", location: "global", data: { network: net, direction: "INGRESS", sourceRanges: ["35.235.240.0/20"], allowed: [{ IPProtocol: "tcp", ports: ["22"] }] } },
		{ name: "//compute.googleapis.com/projects/p-clean/global/firewalls/old", assetType: "compute.googleapis.com/Firewall", displayName: "old", location: "global", data: { network: net, direction: "INGRESS", disabled: true, sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "all" }] } },
		{ name: "//cloudsql.googleapis.com/projects/p-clean/instances/db", assetType: "sqladmin.googleapis.com/Instance", displayName: "db", location: "us-central1", data: { databaseVersion: "POSTGRES_16", settings: { availabilityType: "REGIONAL", backupConfiguration: { enabled: true }, ipConfiguration: { ipv4Enabled: false, privateNetwork: "projects/p-clean/global/networks/vpc" } } } },
		{ name: "//container.googleapis.com/projects/p-clean/locations/us-central1/clusters/k", assetType: "container.googleapis.com/Cluster", displayName: "k", location: "us-central1", data: { privateClusterConfig: { enablePrivateNodes: true }, masterAuthorizedNetworksConfig: { enabled: true } } },
		{ name: "//storage.googleapis.com/clean-bucket", assetType: "storage.googleapis.com/Bucket", displayName: "clean-bucket", location: "us", data: { iamConfiguration: { publicAccessPrevention: "enforced" } } },
	];
	const built = buildGcpGraph({ project: { id: "p-clean" }, resources, source: "asset-inventory", publicBindings: [{ resource: "//run.googleapis.com/projects/p-clean/locations/us-central1/services/site", role: "roles/run.invoker", members: ["allUsers"] }], iamScope: "project" });
	assert.deepEqual(built.findings, []);
	assert.doesNotMatch(built.facts, /Health findings/);
	assert.equal(built.checked.find((c) => /^Firewall rules/.test(c.check)).scanned, 2, "the disabled rule is not examined");
	assert.ok(built.checked.some((c) => /^Cloud SQL/.test(c.check)) && built.checked.some((c) => /^GKE/.test(c.check)) && built.checked.some((c) => /^IAM grants/.test(c.check)));
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
