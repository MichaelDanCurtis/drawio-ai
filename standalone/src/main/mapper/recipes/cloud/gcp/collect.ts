/**
 * Read-only collection of a Google Cloud project with gcloud. Prefers Cloud Asset
 * Inventory (`gcloud asset search-all-resources`, one call for everything, with
 * the resources' own JSON via --read-mask=*); when the Cloud Asset API is disabled
 * or not permitted, lists the main services one by one. Every command goes through
 * ctx.exec and its read-only guard (list / describe / search-all-resources).
 */
import { execJson } from "../../../context";
import type { CollectContext, FieldOption } from "../../../types";
import { MapperError } from "../../../types";
import { fromAsset, FROM_LIST, GcpInventory, GcpResource } from "./model";

const PROJECT_ID = /^[a-z][-a-z0-9.:]{3,90}[a-z0-9]$/;
const NOT_SIGNED_IN = /gcloud auth login|You do not currently have an active account|Reauthentication|reauth|could not be refreshed|invalid_grant/i;
const API_DISABLED = /SERVICE_DISABLED|has not been used in project|it is disabled|API not enabled|is not enabled/i;
const DENIED = /PERMISSION_DENIED|does not have permission|403|forbidden/i;

function checkCancelled(ctx: CollectContext): void {
	if (ctx.signal.aborted) throw new MapperError("Cancelled");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}

const brief = (e: any) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);

async function gcloud<T = any>(ctx: CollectContext, args: string[], timeoutMs?: number): Promise<T> {
	checkCancelled(ctx);
	try {
		return await execJson<T>(ctx, "gcloud", [...args, "--format=json", "--quiet"], { timeoutMs });
	} catch (e: any) {
		if (NOT_SIGNED_IN.test(String(e?.message))) throw new MapperError("gcloud is not signed in.", "Run `gcloud auth login` in a terminal, then try again.");
		throw e;
	}
}

const fatal = (e: any) => e instanceof MapperError && /Cancelled|not signed in|not installed/.test(e.message);

export async function listProjects(ctx: CollectContext): Promise<FieldOption[]> {
	const projects = (await gcloud<any[]>(ctx, ["projects", "list"])) ?? [];
	if (!projects.length) throw new MapperError("No Google Cloud projects found.", "Run `gcloud auth login` (or check `gcloud projects list`).");
	return projects
		.filter((p) => !p.lifecycleState || p.lifecycleState === "ACTIVE")
		.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)))
		.map((p) => ({ value: p.projectId, label: p.name && p.name !== p.projectId ? `${p.name} (${p.projectId})` : p.projectId }));
}

/** Per-service fallbacks: what to list and how to read it. */
const SERVICES: { label: string; args: string[]; kind: keyof typeof FROM_LIST; api: string }[] = [
	{ label: "VPC networks", args: ["compute", "networks", "list"], kind: "networks", api: "compute" },
	{ label: "subnetworks", args: ["compute", "networks", "subnets", "list"], kind: "subnetworks", api: "compute" },
	{ label: "firewall rules", args: ["compute", "firewall-rules", "list"], kind: "firewalls", api: "compute" },
	{ label: "VM instances", args: ["compute", "instances", "list"], kind: "instances", api: "compute" },
	{ label: "forwarding rules", args: ["compute", "forwarding-rules", "list"], kind: "forwardingRules", api: "compute" },
	{ label: "IP addresses", args: ["compute", "addresses", "list"], kind: "addresses", api: "compute" },
	{ label: "Cloud Routers", args: ["compute", "routers", "list"], kind: "routers", api: "compute" },
	{ label: "GKE clusters", args: ["container", "clusters", "list"], kind: "clusters", api: "container" },
	{ label: "Cloud Run services", args: ["run", "services", "list"], kind: "runServices", api: "run" },
	{ label: "Cloud Functions", args: ["functions", "list"], kind: "functions", api: "cloudfunctions" },
	{ label: "Cloud SQL instances", args: ["sql", "instances", "list"], kind: "sqlInstances", api: "sqladmin" },
	{ label: "Cloud Storage buckets", args: ["storage", "buckets", "list"], kind: "buckets", api: "storage" },
	{ label: "Pub/Sub topics", args: ["pubsub", "topics", "list"], kind: "topics", api: "pubsub" },
	{ label: "Pub/Sub subscriptions", args: ["pubsub", "subscriptions", "list"], kind: "subscriptions", api: "pubsub" },
];

/** Asset types whose detail the per-service lists can fill in when Cloud Asset returned none. */
const SUPPLEMENT: Record<string, keyof typeof FROM_LIST> = {
	"compute.googleapis.com/Network": "networks",
	"compute.googleapis.com/Subnetwork": "subnetworks",
	"compute.googleapis.com/Firewall": "firewalls",
	"compute.googleapis.com/Instance": "instances",
	"container.googleapis.com/Cluster": "clusters",
	"sqladmin.googleapis.com/Instance": "sqlInstances",
	"run.googleapis.com/Service": "runServices",
};

async function listService(ctx: CollectContext, projectId: string, svc: (typeof SERVICES)[number], warnings: string[], notEnabled: string[]): Promise<GcpResource[]> {
	try {
		const rows = (await gcloud<any[]>(ctx, [...svc.args, `--project=${projectId}`], 300_000)) ?? [];
		return rows.map((x) => FROM_LIST[svc.kind](x, projectId)).filter((r): r is GcpResource => !!r);
	} catch (e: any) {
		if (fatal(e)) throw e;
		const msg = String(e?.message);
		if (API_DISABLED.test(msg)) notEnabled.push(svc.label);
		else warnings.push(`${DENIED.test(msg) ? "No permission to list" : "Could not list"} ${svc.label}: ${brief(e)}`);
		return [];
	}
}

export async function collectGcp(projectId: string, ctx: CollectContext): Promise<{ inventory: GcpInventory; warnings: string[] }> {
	const warnings: string[] = [];
	const id = projectId.trim();
	if (!id) throw new MapperError("Pick a Google Cloud project.");
	if (!PROJECT_ID.test(id)) throw new MapperError(`"${id}" is not a valid project id.`);
	ctx.progress(`Reading project ${id}…`);
	let project: GcpInventory["project"] = { id };
	try {
		// `projects list --filter` rather than `projects describe <id>`: the guard reads the verb before the first option.
		const p: any = ((await gcloud<any[]>(ctx, ["projects", "list", `--filter=projectId:${id}`])) ?? []).find((x) => x?.projectId === id);
		if (p) project = { id, name: p.name, number: p.projectNumber ? String(p.projectNumber) : undefined };
	} catch (e: any) {
		if (fatal(e)) throw e;
		warnings.push(`Could not describe project ${id}: ${brief(e)}`);
	}

	let resources: GcpResource[] | undefined;
	let source: GcpInventory["source"] = "asset-inventory";
	ctx.progress("Searching Cloud Asset Inventory…");
	const assetArgs = ["asset", "search-all-resources", `--scope=projects/${id}`];
	try {
		let raw: any[];
		try {
			raw = (await gcloud<any[]>(ctx, [...assetArgs, "--read-mask=*"], 600_000)) ?? [];
		} catch (e: any) {
			if (!/read-mask|unrecognized arguments/i.test(String(e?.message))) throw e;
			raw = (await gcloud<any[]>(ctx, assetArgs, 600_000)) ?? [];
		}
		resources = raw.map((a) => fromAsset(a, id)).filter((r): r is GcpResource => !!r);
	} catch (e: any) {
		if (fatal(e)) throw e;
		const msg = String(e?.message);
		warnings.push(
			API_DISABLED.test(msg)
				? `The Cloud Asset API is not enabled in ${id}, so the main services were listed one by one (VMs, networks, firewalls, GKE, Cloud Run, Functions, Cloud SQL, buckets, Pub/Sub); other resource types are missing from the map. Enabling cloudasset.googleapis.com gives a complete inventory.`
				: `Cloud Asset Inventory could not be searched (${DENIED.test(msg) ? "no permission — roles/cloudasset.viewer is needed" : brief(e)}), so the main services were listed one by one; other resource types are missing from the map.`
		);
		source = "cli";
	}

	const notEnabled: string[] = [];
	if (!resources) {
		let done = 0;
		const lists = await mapLimit(SERVICES, 4, async (svc) => {
			const r = await listService(ctx, id, svc, warnings, notEnabled);
			ctx.progress(`Listing services… ${++done}/${SERVICES.length}`);
			return r;
		});
		resources = lists.flat();
	} else {
		// Cloud Asset may not carry the resource JSON for every type: fill in what the map needs.
		const missing = new Set(resources.filter((r) => !r.data && SUPPLEMENT[r.assetType]).map((r) => SUPPLEMENT[r.assetType]));
		if (missing.size) {
			ctx.progress("Reading network details…");
			const byName = new Map(resources.map((r) => [r.name, r]));
			const lists = await mapLimit(
				SERVICES.filter((s) => missing.has(s.kind)),
				4,
				(svc) => listService(ctx, id, svc, warnings, notEnabled)
			);
			for (const r of lists.flat()) {
				const known = byName.get(r.name);
				if (known && !known.data) known.data = r.data;
			}
		}
	}
	if (notEnabled.length) warnings.push(`APIs not enabled (nothing to list): ${notEnabled.join(", ")}.`);
	return { inventory: { project, resources, source, collectedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }, warnings };
}
