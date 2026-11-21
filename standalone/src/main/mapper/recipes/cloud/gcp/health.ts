/**
 * Health checks on a Google Cloud inventory: only what the collected resource
 * JSON and IAM bindings show, with the setting as evidence and never a secret.
 * Node ids are the full resource names the map uses.
 */
import { FindingSet, portNames, riskyPorts } from "../findings";
import type { GcpInventory, GcpResource } from "./model";

const last = (s: string | undefined) => (s ?? "").split("/").pop() ?? "";
const WORLD = /^(0\.0\.0\.0\/0|::\/0)$/;
/** Roles that only let callers invoke a public endpoint: a public website or API, not a finding. */
const INVOKER = /^roles\/(run\.invoker|cloudfunctions\.invoker|iap\.httpsResourceAccessor)$/;

/** Risky ports an ingress firewall rule opens to the internet ("22 (SSH)", "all ports"). */
export function firewallRisk(d: any): { risky: string[]; allowed: string } {
	const risky = new Set<string>();
	const allowed: string[] = [];
	for (const a of d?.allowed ?? []) {
		const proto = String(a?.IPProtocol ?? "").toLowerCase();
		const ports: string[] = Array.isArray(a?.ports) ? a.ports.map(String) : [];
		allowed.push(`${proto}${ports.length ? `:${ports.join(",")}` : ""}`);
		if (proto === "all") {
			risky.add("all ports");
			continue;
		}
		if (!/^(tcp|udp|sctp|6|17)$/.test(proto)) continue;
		if (!ports.length) risky.add("all ports");
		for (const p of ports) {
			const m = /^(\d+)(?:-(\d+))?$/.exec(p.trim());
			if (m) for (const x of riskyPorts(Number(m[1]), Number(m[2] ?? m[1]))) risky.add(x);
		}
	}
	return { risky: [...risky], allowed: allowed.join(" ") };
}

export function gcpHealth(inv: GcpInventory, resolve: (ref: string) => string | undefined): FindingSet {
	const found = new FindingSet();
	const of = (t: string) => inv.resources.filter((r) => r.assetType === t && r.data);

	// --- firewall rules open to the internet, on the rule and the instances it targets.
	const instances = of("compute.googleapis.com/Instance");
	const firewalls = of("compute.googleapis.com/Firewall");
	let ingress = 0;
	for (const fw of firewalls) {
		const d = fw.data;
		if (d.direction === "EGRESS" || d.disabled) continue;
		ingress++;
		const world = (d.sourceRanges ?? []).filter((s: string) => WORLD.test(s));
		if (!world.length) continue;
		const { risky, allowed } = firewallRisk(d);
		if (!risky.length) continue;
		const net = resolve(d.network ?? "");
		const tags: string[] = d.targetTags ?? [];
		const accounts: string[] = d.targetServiceAccounts ?? [];
		const targets = instances.filter((i) => {
			const nets = (i.data?.networkInterfaces ?? []).map((n: any) => resolve(n.network ?? ""));
			if (net && nets.length && !nets.includes(net)) return false;
			if (tags.length) return (i.networkTags ?? i.data?.tags?.items ?? []).some((t: string) => tags.includes(t));
			if (accounts.length) return (i.data?.serviceAccounts ?? []).some((s: any) => accounts.includes(s?.email));
			return true;
		});
		const exposed = targets.filter((i) => (i.data?.networkInterfaces ?? []).some((n: any) => (n.accessConfigs ?? []).length > 0));
		found.add({
			kind: "open-ingress",
			severity: "high",
			title: `Firewall rule ${fw.displayName} opens ${portNames(risky)} to the internet`,
			detail: `Ingress rule ${fw.displayName} (priority ${d.priority ?? 1000}, network ${last(d.network)}) allows ${allowed} from ${world.join(", ")} to ${
				tags.length ? `instances tagged ${tags.join(", ")}` : accounts.length ? `instances running as ${accounts.length} service account(s)` : "every instance in the network"
			}${targets.length ? ` (${targets.length} instance(s), ${exposed.length} with an external IP: ${targets.map((i) => i.displayName).sort().join(", ")})` : ""}.`,
			nodeIds: [fw.name, ...targets.map((i) => i.name)],
			key: fw.name,
			fix: `Restrict the source ranges of ${fw.displayName} to known addresses (or 35.235.240.0/20 for IAP TCP forwarding) instead of ${world.join(", ")}, or delete the rule.`,
		});
	}
	found.check("Firewall rules open to the internet", ingress, "Enabled ingress rules examined; only rules opening remote administration, database or all ports to 0.0.0.0/0 are reported.");

	// --- Cloud SQL
	const sql = of("sqladmin.googleapis.com/Instance");
	for (const r of sql) {
		const s = r.data.settings ?? {};
		const ip = s.ipConfiguration ?? {};
		const nets: string[] = (ip.authorizedNetworks ?? []).map((n: any) => String(n?.value ?? ""));
		const open = nets.filter((v) => WORLD.test(v));
		if (ip.ipv4Enabled === true && open.length)
			found.add({
				kind: "public-database",
				severity: "high",
				title: `Cloud SQL ${r.displayName} accepts connections from any address`,
				detail: `settings.ipConfiguration: ipv4Enabled = true, authorizedNetworks include ${open.join(", ")} on Cloud SQL instance ${r.displayName} (${r.data.databaseVersion ?? "database"}).`,
				nodeIds: [r.name],
				fix: `Remove ${open.join(", ")} from the authorized networks of ${r.displayName}; connect through private IP or the Cloud SQL Auth Proxy, or authorize only the client addresses that need it.`,
			});
		const plain = ip.sslMode === "ALLOW_UNENCRYPTED_AND_ENCRYPTED" || (ip.sslMode === undefined && ip.requireSsl === false);
		if (ip.ipv4Enabled === true && plain)
			found.add({
				kind: "unencrypted-transit",
				severity: "medium",
				title: `Cloud SQL ${r.displayName} accepts unencrypted connections on its public IP`,
				detail: `settings.ipConfiguration: ipv4Enabled = true, ${ip.sslMode ? `sslMode = ${ip.sslMode}` : "requireSsl = false"} on Cloud SQL instance ${r.displayName}.`,
				nodeIds: [r.name],
				fix: `Require TLS on ${r.displayName} (gcloud sql instances patch ${r.displayName} --ssl-mode=ENCRYPTED_ONLY).`,
			});
		if (s.backupConfiguration?.enabled === false)
			found.add({
				kind: "no-backups",
				severity: "medium",
				title: `Cloud SQL ${r.displayName} has automated backups turned off`,
				detail: `settings.backupConfiguration.enabled = false on Cloud SQL instance ${r.displayName}.`,
				nodeIds: [r.name],
				fix: `Turn on automated backups (and point-in-time recovery) for ${r.displayName} (gcloud sql instances patch ${r.displayName} --backup-start-time=…).`,
			});
		if (s.availabilityType === "ZONAL" && !r.data.masterInstanceName)
			found.add({
				kind: "single-zone-database",
				severity: "low",
				title: `Cloud SQL ${r.displayName} runs in a single zone`,
				detail: `settings.availabilityType = ZONAL on Cloud SQL instance ${r.displayName}${r.data.gceZone ? ` (${r.data.gceZone})` : ""}.`,
				nodeIds: [r.name],
				fix: `Make ${r.displayName} highly available (gcloud sql instances patch ${r.displayName} --availability-type=REGIONAL) if it must survive a zone outage.`,
			});
	}
	found.check("Cloud SQL: public access, TLS, backups and availability", sql.length);

	// --- GKE control plane
	const clusters = of("container.googleapis.com/Cluster");
	for (const r of clusters) {
		const d = r.data;
		const privateEndpoint = d.privateClusterConfig?.enablePrivateEndpoint === true;
		const authorized = d.masterAuthorizedNetworksConfig?.enabled === true;
		if (!privateEndpoint && !authorized)
			found.add({
				kind: "public-control-plane",
				severity: "medium",
				title: `The Kubernetes API of GKE cluster ${r.displayName} is reachable from the whole internet`,
				detail: `privateClusterConfig.enablePrivateEndpoint = ${d.privateClusterConfig?.enablePrivateEndpoint ?? "not set"}, masterAuthorizedNetworksConfig.enabled = ${d.masterAuthorizedNetworksConfig?.enabled ?? "not set"} on GKE cluster ${r.displayName}.`,
				nodeIds: [r.name],
				fix: `Turn on master authorized networks for ${r.displayName} with the ranges that need the API (gcloud container clusters update ${r.displayName} --enable-master-authorized-networks --master-authorized-networks=…), or use a private endpoint.`,
			});
	}
	found.check("GKE control plane exposure", clusters.length);

	// --- Memorystore
	const redis = of("redis.googleapis.com/Instance");
	for (const r of redis)
		if (r.data.transitEncryptionMode === "DISABLED")
			found.add({
				kind: "unencrypted-transit",
				severity: "medium",
				title: `Memorystore ${r.displayName} accepts unencrypted connections`,
				detail: `transitEncryptionMode = DISABLED on Memorystore for Redis instance ${r.displayName}.`,
				nodeIds: [r.name],
				fix: `Recreate ${r.displayName} with in-transit encryption (SERVER_AUTHENTICATION) and connect with TLS; it cannot be turned on in place.`,
			});
	found.check("Memorystore: in-transit encryption", redis.filter((r) => r.data.transitEncryptionMode !== undefined).length);

	// --- resources granted to everyone through IAM
	if (inv.publicBindings) {
		const byResource = new Map<string, { role: string; members: string[] }[]>();
		for (const b of inv.publicBindings) {
			if (INVOKER.test(b.role)) continue;
			if (!byResource.has(b.resource)) byResource.set(b.resource, []);
			byResource.get(b.resource)!.push({ role: b.role, members: b.members });
		}
		for (const [resource, bindings] of [...byResource].sort(([a], [b]) => a.localeCompare(b))) {
			const node = resolve(resource) ?? resource;
			const bucket = /^\/\/storage\.googleapis\.com\//.test(resource);
			const what = bucket ? `Bucket ${last(resource)}` : `${last(resource)}`;
			const grants = bindings
				.map((b) => `${[...new Set(b.members)].sort().join(", ")} → ${b.role}`)
				.sort()
				.join("; ");
			found.add({
				kind: bucket ? "public-bucket" : "public-iam",
				severity: "high",
				title: `${what} is open to ${bindings.some((b) => b.members.includes("allUsers")) ? "anyone on the internet" : "any Google account"}`,
				detail: `IAM policy of ${resource.replace(/^\/\//, "")} grants ${grants}.`,
				nodeIds: [node],
				key: resource,
				fix: `Remove the allUsers / allAuthenticatedUsers bindings from ${last(resource)}${bucket ? ` and enforce public access prevention (gcloud storage buckets update gs://${last(resource)} --public-access-prevention)` : ""}, unless it is meant to be public.`,
			});
		}
		const buckets = inv.resources.filter((r) => r.assetType === "storage.googleapis.com/Bucket").length;
		found.check(
			inv.iamScope === "project" ? "IAM grants to allUsers / allAuthenticatedUsers (buckets and other resources)" : "Cloud Storage buckets granted to allUsers / allAuthenticatedUsers",
			inv.iamScope === "project" ? inv.resources.length : Math.min(buckets, 50),
			"Public invoker roles on Cloud Run / Cloud Functions (public websites and APIs) are not reported."
		);
	}
	return found;
}
