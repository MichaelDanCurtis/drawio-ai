/**
 * A live Kubernetes cluster, read with `kubectl get … -o json` (read-only):
 * namespaces › workloads (with ready / pod counts), Services, Ingress routes,
 * and connections between workloads found in their environment (hosts only).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execJson } from "../../context";
import { agentRequest, digDeeperRequest, slug } from "../common";
import { pool, profileRegion } from "../cloud/aws/collect";
import { listSubscriptions } from "../cloud/azure/collect";
import { listProjects } from "../cloud/gcp/collect";
import type { CollectContext, CollectResult, FieldOption, MapEdge, MapGraph, MapNode, Recipe } from "../../types";
import { MapperError } from "../../types";
import { isOn, isSecretKey, parseAddress, STYLE, techOf, techOfImage } from "./shared";
import { compact } from "./systemGraph";

const SYSTEM_NAMESPACES = /^(kube-system|kube-public|kube-node-lease|local-path-storage|gatekeeper-system|kube-flannel)$/;
const KINDS = "deployments,statefulsets,daemonsets,cronjobs,jobs,replicasets,pods,services,ingresses,configmaps";
const WORKLOAD_STYLE: Record<string, string> = {
	Deployment: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;",
	StatefulSet: STYLE.database,
	DaemonSet: "rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=11;",
	CronJob: "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;",
	Job: "rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;dashed=1;",
	Pod: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=11;",
};
const SERVICE_STYLE = "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=10;";
const INGRESS_STYLE = STYLE.gateway;
const UNHEALTHY = "strokeColor=#dc2626;strokeWidth=2;";

function contextArgs(context?: string): string[] {
	return context ? ["--context", context] : [];
}

// ----- a cluster that is not in this computer's kubeconfig: found in Azure (AKS), AWS (EKS) or Google Cloud (GKE) -----
//
// kubectl needs a kubeconfig to reach a cluster. For a cluster found in the cloud one is made for
// this one read, in a folder of its own that only this user can read, and removed when the read is
// over: this computer's own kubeconfig (~/.kube/config) is never written to.
// - Azure: `az aks get-credentials --file -` prints the kubeconfig of the signed-in user (never the
//   cluster admin's). It can hold that user's certificate or token for the cluster.
// - AWS and Google Cloud: it is written here from what the cloud says about the cluster (the
//   address, the cluster's public certificate) and names the cloud's own CLI as how to sign in
//   (`aws eks get-token`, `gke-gcloud-auth-plugin`). It holds no secret.

const AZ_NAME = /^[A-Za-z0-9][A-Za-z0-9_.()-]{0,89}$/;
const EKS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const AWS_REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;
const AWS_PROFILE = /^[\w.@+=,-]{1,128}$/;
const SUBSCRIPTION = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const GKE_NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const GCP_LOCATION = /^[a-z]+-[a-z]+\d+(-[a-z])?$/;
const GCP_PROJECT = /^[a-z0-9][-a-z0-9.:]{3,62}$/;
const CERTIFICATE = /^[A-Za-z0-9+/=\s]+$/;
/** How many subscriptions or regions "all of them" looks through. */
const MAX_PLACES = 60;

const failed = (e: any) => String(e?.message ?? e).split("\n").slice(-1)[0].slice(0, 200);
/** A line at the end of a list for the places a search could not look in: a cluster there is not "not found". */
const notSearched = (what: string, places: string[]): FieldOption[] =>
	places.length ? [{ value: "", label: `(${places.length} ${what}${places.length === 1 ? "" : "s"} could not be searched: ${places.slice(0, 4).join(", ")}${places.length > 4 ? "…" : ""}. ↻ to try again)` }] : [];

/** The AKS clusters of a subscription, or ("all") of every subscription the signed-in user can see. Value: `subscription/resource group/name`. */
export async function aksClusters(ctx: CollectContext, subscription: string): Promise<FieldOption[]> {
	let subscriptions: string[];
	const names = new Map<string, string>();
	if (subscription === "all") {
		const all = await listSubscriptions(ctx);
		for (const s of all) names.set(s.value, s.label.replace(/ \([0-9a-f-]{36}\).*$/i, ""));
		subscriptions = all.map((s) => s.value).filter((id) => SUBSCRIPTION.test(id));
	} else if (SUBSCRIPTION.test(subscription)) subscriptions = [subscription];
	// (no subscription chosen yet: the list is asked for again once one is)
	else return [];
	const skipped = subscriptions.length - MAX_PLACES;
	const errors: string[] = [];
	const unread: string[] = [];
	const lists = await pool(subscriptions.slice(0, MAX_PLACES), 4, ctx.signal, async (sub) => {
		try {
			return ((await execJson<any[]>(ctx, "az", ["aks", "list", ...(sub ? ["--subscription", sub] : []), "-o", "json", "--only-show-errors"], { timeoutMs: 60_000 })) ?? []).map((c) => ({ c, sub }));
		} catch (e) {
			// (one subscription that cannot be read does not hide the others)
			if (subscriptions.length === 1 || ctx.signal.aborted) throw e;
			errors.push(failed(e));
			unread.push(names.get(sub) ?? sub);
			return [];
		}
	});
	const options: FieldOption[] = lists
		.flat()
		.filter(({ c }) => AZ_NAME.test(String(c?.name)) && AZ_NAME.test(String(c?.resourceGroup)))
		.sort((a, b) => String(a.c.name).localeCompare(String(b.c.name)))
		.map(({ c, sub }) => {
			const id = /\/subscriptions\/([0-9a-f-]{36})\//i.exec(String(c.id ?? ""))?.[1] ?? sub;
			const more = [c.resourceGroup, subscription === "all" ? names.get(id) : "", c.location, c.kubernetesVersion ? `Kubernetes ${c.kubernetesVersion}` : "", c.powerState?.code && c.powerState.code !== "Running" ? c.powerState.code : ""];
			return { value: `${id}/${c.resourceGroup}/${c.name}`, label: [c.name, ...more].filter(Boolean).join(" · ") };
		});
	if (!options.length && errors.length === Math.min(subscriptions.length, MAX_PLACES)) throw new MapperError(`No AKS cluster could be listed: ${errors[0]}`, "Sign in with `az login`, then ↻.");
	options.push(...notSearched("subscription", unread));
	if (skipped > 0) options.push({ value: "", label: `(${skipped} more subscription(s) not searched: choose one above)` });
	return options;
}

/** The regions an account has enabled. */
async function awsRegions(ctx: CollectContext, profile: string, home: string | undefined): Promise<string[]> {
	const r = await ctx.exec("aws", ["ec2", "describe-regions", "--output", "json", "--region", home ?? "us-east-1", ...(profile ? ["--profile", profile] : [])], { timeoutMs: 30_000 }).catch(() => undefined);
	try {
		return r && r.code === 0 ? ((JSON.parse(r.stdout).Regions ?? []) as any[]).map((x) => String(x.RegionName)).filter((n) => AWS_REGION.test(n)).sort() : [];
	} catch {
		return [];
	}
}

/** The EKS clusters of an account in a region, or ("all") in every region it has enabled. Value: `region/name`. */
export async function eksClusters(ctx: CollectContext, profile: string, region: string): Promise<FieldOption[]> {
	if (profile && !AWS_PROFILE.test(profile)) return [];
	const home = await profileRegion(ctx, profile);
	const regions = region === "all" ? await awsRegions(ctx, profile, home) : [region || home || "us-east-1"];
	if (region === "all" && !regions.length) throw new MapperError("Could not list the account's regions.", "Sign in (`aws sso login`, or `aws configure`), then ↻. Or choose one region.");
	if (!regions.every((r) => AWS_REGION.test(r))) return [];
	const errors: string[] = [];
	const unread: string[] = [];
	const lists = await pool(regions.slice(0, MAX_PLACES), 6, ctx.signal, async (r) => {
		try {
			// (a connection that stalls gives up soon: one region must not hold up the list, and is named if it does)
			const out = await execJson<any>(ctx, "aws", ["eks", "list-clusters", "--region", r, ...(profile ? ["--profile", profile] : []), "--output", "json", "--cli-connect-timeout", "5", "--cli-read-timeout", "10"], { timeoutMs: 25_000 });
			return ((out?.clusters ?? []) as unknown[]).map(String).filter((n) => EKS_NAME.test(n)).map((n) => ({ value: `${r}/${n}`, label: `${n} · ${r}` }));
		} catch (e) {
			// (a region the account may not use does not hide the others)
			if (regions.length === 1 || ctx.signal.aborted) throw e;
			errors.push(failed(e));
			unread.push(r);
			return [];
		}
	});
	const options: FieldOption[] = lists.flat().sort((a, b) => a.label.localeCompare(b.label));
	if (!options.length && errors.length === regions.length) throw new MapperError(`No EKS cluster could be listed: ${errors[0]}`, "Sign in (`aws sso login`, or `aws configure`), then ↻.");
	return [...options, ...notSearched("region", unread)];
}

/** A project's GKE clusters as gcloud lists them (the address and public certificate come with the list). */
async function gkeList(ctx: CollectContext, project: string): Promise<any[]> {
	if (!GCP_PROJECT.test(project)) return [];
	return ((await execJson<any[]>(ctx, "gcloud", ["container", "clusters", "list", "--project", project, "--format=json", "--quiet"], { timeoutMs: 60_000 })) ?? []).filter((c) => GKE_NAME.test(String(c?.name)) && GCP_LOCATION.test(String(c?.location ?? c?.zone)));
}

/** The GKE clusters of a project. Value: `location/name`. */
export async function gkeClusters(ctx: CollectContext, project: string): Promise<FieldOption[]> {
	return (await gkeList(ctx, project))
		.sort((a, b) => String(a.name).localeCompare(String(b.name)))
		.map((c) => ({ value: `${c.location ?? c.zone}/${c.name}`, label: [c.name, c.location ?? c.zone, c.currentMasterVersion ? `Kubernetes ${c.currentMasterVersion}` : "", c.status && c.status !== "RUNNING" ? c.status : ""].filter(Boolean).join(" · ") }));
}

/**
 * A kubeconfig that holds no secret: the cluster's address and public certificate, and the program
 * kubectl runs to sign in (the cloud's own CLI, with the sign-in it already has).
 */
export function execKubeconfig(cluster: { name: string; server: string; certificate: string }, exec: { command: string; args?: string[]; provideClusterInfo?: boolean; installHint?: string }): string {
	if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(cluster.server) || !cluster.certificate || !CERTIFICATE.test(cluster.certificate)) throw new MapperError(`The cloud did not give an address and certificate for ${cluster.name}: is it still being created?`);
	return JSON.stringify({
		apiVersion: "v1",
		kind: "Config",
		clusters: [{ name: "cluster", cluster: { server: cluster.server, "certificate-authority-data": cluster.certificate.replace(/\s+/g, "") } }],
		users: [{ name: "me", user: { exec: { apiVersion: "client.authentication.k8s.io/v1beta1", interactiveMode: "Never", ...exec } } }],
		contexts: [{ name: "cluster", context: { cluster: "cluster", user: "me" } }],
		"current-context": "cluster",
	});
}

/**
 * The kubeconfig Azure prints signs in through `kubelogin` by showing a code to type into a web
 * page, which nobody would see here: kubectl would wait and then fail. The Azure CLI is signed in
 * already (it has just answered), so kubelogin is told to use that sign-in instead. This is what
 * `kubelogin convert-kubeconfig -l azurecli` does.
 */
export function withAzureCliLogin(kubeconfig: string): string {
	return kubeconfig.replace(/^(\s*-\s+)(--login|-l)(\s*\r?\n\s*-\s+)["']?(devicecode|interactive)["']?(\s*)$/gm, "$1$2$3azurecli$5").replace(/^(\s*-\s+)--login=(devicecode|interactive)(\s*)$/gm, "$1--login=azurecli$3");
}

interface CloudCluster {
	/** What the map calls it. */
	label: string;
	kubeconfig: string;
	/** What is usually behind it when kubectl cannot read a cluster of this kind. */
	hint: string;
}

/** The cluster to read, when it is one found in the cloud. */
async function cloudCluster(input: Record<string, string>, ctx: CollectContext): Promise<CloudCluster | undefined> {
	const where = (input.where ?? "").trim();
	if (where === "azure") {
		const parts = (input.aksCluster ?? "").trim().split("/");
		const [subscription, group, name] = parts.length === 3 ? parts : ["", "", ""];
		if (!name || !AZ_NAME.test(group) || !AZ_NAME.test(name) || (subscription && !SUBSCRIPTION.test(subscription))) throw new MapperError("Choose the AKS cluster to map.", "The list shows the clusters of the subscription above. If it is empty, sign in with `az login` and press ↻.");
		ctx.progress(`Asking Azure how to reach ${name}…`);
		// (the signed-in user's own access, printed and not merged into ~/.kube/config: see readOnly.ts)
		const r = await ctx.exec("az", ["aks", "get-credentials", "--resource-group", group, "--name", name, ...(subscription ? ["--subscription", subscription] : []), "--file", "-", "--only-show-errors"], { timeoutMs: 60_000 });
		if (r.code !== 0 || !/^\s*apiVersion\s*:/m.test(r.stdout)) {
			const said = (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
			throw new MapperError(`Azure did not give access to ${name}: ${said || `az ended with ${r.code}`}`, 'You need the "Azure Kubernetes Service Cluster User" role on it (or more).');
		}
		return {
			label: `AKS ${name} (${group})`,
			kubeconfig: withAzureCliLogin(r.stdout),
			hint: "A cluster with Microsoft Entra sign-in needs `kubelogin` on your PATH (`az aks install-cli`) and a role on the cluster itself; a private cluster's API can only be reached from inside its network (a VPN, or a machine in it).",
		};
	}
	if (where === "aws") {
		const profile = (input.profile ?? "").trim();
		if (profile && !AWS_PROFILE.test(profile)) throw new MapperError("That is not an AWS profile name.");
		const parts = (input.eksCluster ?? "").trim().split("/");
		const [region, name] = parts.length === 2 ? parts : ["", ""];
		if (!AWS_REGION.test(region) || !EKS_NAME.test(name)) throw new MapperError("Choose the EKS cluster to map.", "The list shows the clusters of that account and region. If it is empty, sign in (`aws sso login`, or `aws configure`), check the region and press ↻.");
		ctx.progress(`Asking AWS how to reach ${name}…`);
		const who = ["--region", region, ...(profile ? ["--profile", profile] : [])];
		const r = await execJson<any>(ctx, "aws", ["eks", "describe-cluster", "--name", name, ...who, "--output", "json"], { timeoutMs: 60_000 });
		return {
			label: `EKS ${name} (${region})`,
			kubeconfig: execKubeconfig({ name, server: String(r?.cluster?.endpoint ?? ""), certificate: String(r?.cluster?.certificateAuthority?.data ?? "") }, { command: "aws", args: ["eks", "get-token", "--cluster-name", name, ...who, "--output", "json"] }),
			hint: "Your AWS identity needs access to the cluster itself (an EKS access entry, or the aws-auth ConfigMap); a cluster with a private endpoint can only be reached from inside its VPC.",
		};
	}
	if (where === "gcp") {
		const project = (input.project ?? "").trim();
		const parts = (input.gkeCluster ?? "").trim().split("/");
		const [location, name] = parts.length === 2 ? parts : ["", ""];
		if (!GCP_PROJECT.test(project) || !GCP_LOCATION.test(location) || !GKE_NAME.test(name)) throw new MapperError("Choose the GKE cluster to map.", "The list shows the clusters of the project above. If it is empty, sign in with `gcloud auth login` and press ↻.");
		ctx.progress(`Asking Google Cloud how to reach ${name}…`);
		const c = (await gkeList(ctx, project)).find((x) => x.name === name && (x.location ?? x.zone) === location);
		if (!c) throw new MapperError(`${name} is no longer in ${project} (${location}).`);
		return {
			label: `GKE ${name} (${location})`,
			kubeconfig: execKubeconfig(
				{ name, server: `https://${c.endpoint ?? ""}`, certificate: String(c.masterAuth?.clusterCaCertificate ?? "") },
				{ command: "gke-gcloud-auth-plugin", provideClusterInfo: true, installHint: "gcloud components install gke-gcloud-auth-plugin" }
			),
			hint: "kubectl signs in to GKE through `gke-gcloud-auth-plugin` (`gcloud components install gke-gcloud-auth-plugin`); a cluster with only a private endpoint can only be reached from inside its network.",
		};
	}
	return undefined;
}

/** Runs `work` with the kubeconfig in a file only this user can read, which is gone when it ends, however it ends. */
export async function withKubeconfig<T>(text: string, work: (file: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-kube-"));
	try {
		fs.chmodSync(dir, 0o700);
		const file = path.join(dir, "config");
		fs.writeFileSync(file, text, { mode: 0o600 });
		return await work(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Runs `kubectl get … -o json`. A partial answer (one kind forbidden by RBAC) is used, with a warning. */
async function kubectl(ctx: CollectContext, args: string[]): Promise<{ list: any; warning?: string }> {
	let r;
	try {
		r = await ctx.exec("kubectl", args, { timeoutMs: 60_000 });
	} catch (e: any) {
		if (e instanceof MapperError && /not installed/.test(e.message)) throw new MapperError("kubectl is not installed or not on your PATH.", "Install kubectl and sign in to the cluster, then try again.");
		throw e;
	}
	const stderr = r.stderr.trim().split("\n").slice(-3).join(" ").trim();
	let list: any;
	try {
		list = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
	} catch {
		list = undefined;
	}
	if (r.code !== 0 && !(Array.isArray(list?.items) && list.items.length)) {
		throw new MapperError(`Could not read the cluster: ${stderr || `kubectl exited with ${r.code}`}`, "Check that the cluster is running and that `kubectl get pods` works with this context.");
	}
	if (!list) throw new MapperError("kubectl did not return JSON.");
	return { list, warning: r.code !== 0 && stderr ? `Partly read: ${stderr}` : undefined };
}

interface Workload {
	id: string;
	kind: string;
	name: string;
	ns: string;
	desired?: number;
	ready?: number;
	pods: number;
	phases: Map<string, number>;
	restarts: number;
	images: string[];
	labels: Record<string, string>;
	env: Map<string, string>;
	schedule?: string;
}

/** Builds the cluster map from `kubectl get … -o json` output (exported for tests). */
export function clusterToGraph(list: any, opts: { context?: string; includeSystem?: boolean }): { graph: MapGraph; workloads: number; services: number; namespaces: number; warnings: string[] } {
	const items: any[] = (Array.isArray(list?.items) ? list.items : []).filter((i: any) => i?.kind && i?.metadata?.name);
	const ns = (i: any) => i.metadata.namespace ?? "default";
	const visible = items.filter((i) => opts.includeSystem || !SYSTEM_NAMESPACES.test(ns(i)));
	const byKey = new Map(visible.map((i) => [`${ns(i)}/${i.kind}/${i.metadata.name}`, i]));
	const configMaps = new Map(visible.filter((i) => i.kind === "ConfigMap").map((i) => [`${ns(i)}/${i.metadata.name}`, i.data ?? {}]));
	const warnings: string[] = [];
	const workloads = new Map<string, Workload>();
	const top = (i: any): any => {
		// Pods → ReplicaSet → Deployment, Pods → Job → CronJob.
		let cur = i;
		for (let guard = 0; guard < 4; guard++) {
			const owner = (cur.metadata.ownerReferences ?? []).find((o: any) => o.controller) ?? cur.metadata.ownerReferences?.[0];
			const next = owner ? byKey.get(`${ns(cur)}/${owner.kind}/${owner.name}`) : undefined;
			if (!next) return owner && !next && cur === i && owner.kind !== "Node" ? { kind: owner.kind, metadata: { name: owner.name, namespace: ns(cur) }, synthetic: true } : cur;
			cur = next;
		}
		return cur;
	};
	const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob"]);
	const workloadOf = (i: any): Workload => {
		const key = `${ns(i)}/${i.kind}/${i.metadata.name}`;
		let w = workloads.get(key);
		if (!w) {
			const spec = i.spec?.template?.spec ?? i.spec?.jobTemplate?.spec?.template?.spec ?? (i.kind === "Pod" ? i.spec : undefined);
			const env = new Map<string, string>();
			for (const c of spec?.containers ?? []) {
				for (const ef of c.envFrom ?? []) if (ef.configMapRef?.name) for (const [k, v] of Object.entries<any>(configMaps.get(`${ns(i)}/${ef.configMapRef.name}`) ?? {})) env.set(k, String(v));
				for (const e of c.env ?? []) {
					if (typeof e.value === "string") env.set(e.name, e.value);
					else if (e.valueFrom?.configMapKeyRef) {
						const v = configMaps.get(`${ns(i)}/${e.valueFrom.configMapKeyRef.name}`)?.[e.valueFrom.configMapKeyRef.key];
						if (v !== undefined) env.set(e.name, String(v));
					}
				}
			}
			w = {
				id: `k8s:${slug(key)}`,
				kind: i.kind,
				name: i.metadata.name,
				ns: ns(i),
				desired: i.kind === "DaemonSet" ? i.status?.desiredNumberScheduled : i.spec?.replicas,
				ready: i.kind === "DaemonSet" ? i.status?.numberReady : i.status?.readyReplicas ?? (i.spec?.replicas != null ? 0 : undefined),
				pods: 0,
				phases: new Map(),
				restarts: 0,
				images: (spec?.containers ?? []).map((c: any) => String(c.image ?? "")).filter(Boolean),
				labels: i.spec?.template?.metadata?.labels ?? (i.kind === "Pod" ? i.metadata.labels ?? {} : {}),
				env,
				schedule: i.spec?.schedule,
			};
			workloads.set(key, w);
		}
		return w;
	};
	for (const i of visible) if (WORKLOAD_KINDS.has(i.kind)) workloadOf(i);
	for (const p of visible.filter((i) => i.kind === "Pod")) {
		const owner = top(p);
		if (owner.kind === "Job" && !owner.synthetic) continue; // finished job pods: counted on the job below
		const w = owner.synthetic ? workloadOf({ ...owner, spec: p.spec, metadata: { ...owner.metadata, labels: p.metadata.labels } }) : workloadOf(owner);
		w.pods++;
		const phase = p.status?.phase ?? "Unknown";
		w.phases.set(phase, (w.phases.get(phase) ?? 0) + 1);
		w.restarts += (p.status?.containerStatuses ?? []).reduce((a: number, c: any) => a + (c.restartCount ?? 0), 0);
		if (!w.labels || !Object.keys(w.labels).length) w.labels = p.metadata.labels ?? {};
	}
	// Jobs not owned by a CronJob are their own workloads.
	for (const j of visible.filter((i) => i.kind === "Job" && !(i.metadata.ownerReferences ?? []).length)) workloadOf(j);

	const nodes: MapNode[] = [];
	const edges: MapEdge[] = [];
	const namespaces = new Set<string>();
	const nsNode = (n: string) => {
		const id = `ns:${slug(n)}`;
		if (!namespaces.has(n)) {
			namespaces.add(n);
			nodes.push({ id, label: `namespace ${n}`, kind: "k8s:namespace", container: true, style: STYLE.group, data: { namespace: n } });
		}
		return id;
	};
	for (const w of workloads.values()) {
		const tech = w.images.map(techOfImage).find(Boolean);
		const readyText = w.desired != null ? `${w.ready ?? 0}/${w.desired} ready` : "";
		const podText = w.pods ? `${w.pods} pod${w.pods === 1 ? "" : "s"}${w.restarts ? `, ${w.restarts} restarts` : ""}` : "";
		const unhealthy = (w.desired != null && (w.ready ?? 0) < w.desired) || (w.phases.get("Failed") ?? 0) > 0 || (w.phases.get("Pending") ?? 0) > 0;
		if (unhealthy) warnings.push(`${w.ns}/${w.name}: ${readyText || [...w.phases].map(([p, n]) => `${n} ${p}`).join(", ")}`);
		const style = (tech && (tech.kind === "database" || tech.kind === "cache") ? (tech.kind === "cache" ? STYLE.cache : STYLE.database) : WORKLOAD_STYLE[w.kind] ?? WORKLOAD_STYLE.Pod) + (unhealthy ? UNHEALTHY : "");
		const lines = [w.name, `${w.kind}${tech ? ` · ${tech.label}` : ""}`, [readyText, podText].filter(Boolean).join(" · "), w.schedule ? `⏱ ${w.schedule}` : ""].filter(Boolean);
		nodes.push({
			id: w.id,
			label: lines.join("\n"),
			kind: `k8s:${w.kind.toLowerCase()}`,
			parent: nsNode(w.ns),
			style,
			width: 190,
			height: 30 + lines.length * 14,
			data: compact({ namespace: w.ns, kind: w.kind, name: w.name, images: w.images.slice(0, 4).join(", "), replicas: w.desired != null ? String(w.desired) : undefined, ready: w.ready != null ? String(w.ready) : undefined, pods: String(w.pods), context: opts.context }),
		});
	}
	// Services and what they select.
	const svcHosts = new Map<string, string>();
	let serviceCount = 0;
	for (const s of visible.filter((i) => i.kind === "Service")) {
		if (s.metadata.name === "kubernetes" && ns(s) === "default") continue;
		serviceCount++;
		const id = `k8s:svc:${slug(`${ns(s)}/${s.metadata.name}`)}`;
		const ports = (s.spec?.ports ?? []).map((p: any) => `${p.port}${p.targetPort && String(p.targetPort) !== String(p.port) ? `→${p.targetPort}` : ""}`);
		const type = s.spec?.type ?? "ClusterIP";
		nodes.push({
			id,
			label: `svc ${s.metadata.name}\n${type}${ports.length ? ` :${ports.slice(0, 3).join(",")}` : ""}`,
			kind: "k8s:service",
			parent: nsNode(ns(s)),
			style: SERVICE_STYLE,
			width: 170,
			height: 44,
			data: compact({ namespace: ns(s), name: s.metadata.name, type, ports: ports.join(", "), clusterIP: s.spec?.clusterIP, context: opts.context }),
		});
		svcHosts.set(`${ns(s)}/${s.metadata.name}`, id);
		const sel = s.spec?.selector;
		if (sel && Object.keys(sel).length) {
			for (const w of workloads.values()) if (w.ns === ns(s) && Object.entries<string>(sel).every(([k, v]) => w.labels?.[k] === v)) edges.push({ from: id, to: w.id, kind: "selects", style: STYLE.edge });
		}
		if (type === "LoadBalancer" || type === "NodePort") {
			if (!nodes.some((n) => n.id === "clients")) nodes.unshift({ id: "clients", label: "Users / clients", kind: "software:clients", shape: "icon", style: STYLE.actor, width: 36, height: 56 });
			edges.push({ from: "clients", to: id, label: type, style: STYLE.edge });
		}
	}
	for (const ing of visible.filter((i) => i.kind === "Ingress")) {
		const id = `k8s:ing:${slug(`${ns(ing)}/${ing.metadata.name}`)}`;
		const hosts = new Set<string>((ing.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean));
		nodes.push({ id, label: `ingress ${ing.metadata.name}${hosts.size ? `\n${[...hosts].slice(0, 2).join(", ")}` : ""}`, kind: "k8s:ingress", parent: nsNode(ns(ing)), style: INGRESS_STYLE, width: 190, height: 44, data: compact({ namespace: ns(ing), name: ing.metadata.name, hosts: [...hosts].join(", "), class: ing.spec?.ingressClassName }) });
		if (!nodes.some((n) => n.id === "clients")) nodes.unshift({ id: "clients", label: "Users / clients", kind: "software:clients", shape: "icon", style: STYLE.actor, width: 36, height: 56 });
		edges.push({ from: "clients", to: id, label: "HTTPS", style: STYLE.edge });
		const paths = new Map<string, string[]>();
		const add = (b: any, p: string) => {
			const svc = b?.service?.name ?? b?.serviceName;
			const target = svc ? svcHosts.get(`${ns(ing)}/${svc}`) : undefined;
			if (target) paths.set(target, [...(paths.get(target) ?? []), p]);
		};
		add(ing.spec?.defaultBackend, "/*");
		for (const r of ing.spec?.rules ?? []) for (const p of r.http?.paths ?? []) add(p.backend, `${hosts.size > 1 && r.host ? r.host : ""}${p.path ?? "/"}`);
		for (const [target, ps] of paths) edges.push({ from: id, to: target, label: ps.slice(0, 3).join(", ") + (ps.length > 3 ? " …" : ""), style: STYLE.edge });
	}
	// Connections from environment values that name another Service (hosts only, never secret values).
	for (const w of workloads.values()) {
		const seen = new Set<string>();
		for (const [k, v] of w.env) {
			if (isSecretKey(k)) continue;
			const addr = parseAddress(v, { bare: /HOST|ADDR|SERVER|BROKER|ENDPOINT|URL|URI/i.test(k) });
			for (const hp of addr?.hosts ?? []) {
				const parts = hp.host.split(".");
				const target = svcHosts.get(`${parts[1] && !/^(svc|com|net|org|io)$/.test(parts[1]) ? parts[1] : w.ns}/${parts[0]}`);
				if (!target || seen.has(target)) continue;
				seen.add(target);
				const tech = techOf(addr, k);
				edges.push({ from: w.id, to: target, label: `${tech && tech.id !== "http" ? tech.protocol : addr?.scheme ?? ""}${hp.port ? ` :${hp.port}` : ""}`.trim() || k, kind: "network", style: STYLE.edgeAsync.replace("strokeColor=#9673a6", "strokeColor=#6b7280") });
			}
		}
	}
	const graph: MapGraph = { title: `Kubernetes${opts.context ? ` · ${opts.context}` : ""}`, nodes, edges, direction: "down" };
	return { graph, workloads: workloads.size, services: serviceCount, namespaces: namespaces.size, warnings };
}

const CLOUDS: Record<string, string> = { azure: "Azure", aws: "AWS", gcp: "Google Cloud" };

export const kubernetesRecipe: Recipe = {
	id: "software.kubernetes",
	category: "software",
	title: "Kubernetes cluster (live)",
	description: "Namespaces, Deployments / StatefulSets / DaemonSets / CronJobs with ready and pod counts, Services and Ingress routes of a running cluster: one in your kubeconfig, or one found in Azure, AWS or Google Cloud. Read with `kubectl get` (read-only).",
	mode: "inventory",
	fields: [
		{
			id: "where",
			label: "Where the cluster is",
			type: "select",
			default: "",
			options: [
				{ value: "", label: "In this computer's kubeconfig (a kubectl context)" },
				{ value: "azure", label: "In Azure (AKS): find it in my subscriptions" },
				{ value: "aws", label: "In AWS (EKS): find it in my account" },
				{ value: "gcp", label: "In Google Cloud (GKE): find it in my projects" },
			],
			help: "A cluster in the cloud is found with the az, aws or gcloud CLI you are signed in to, and read through a sign-in made for this one read: your own kubeconfig is not changed.",
		},
		{ id: "context", label: "kubectl context", type: "select", dynamic: true, help: "From your kubeconfig; empty = the current context.", showIf: { field: "where", values: [""] } },
		{ id: "subscription", label: "Azure subscription", type: "select", dynamic: true, help: "From `az account list`. Sign in first (`az login`) if the list is empty.", showIf: { field: "where", values: ["azure"] } },
		{ id: "aksCluster", label: "AKS cluster", type: "select", dynamic: true, help: "Read with your own access to it, never the cluster admin's.", showIf: { field: "where", values: ["azure"] } },
		{ id: "profile", label: "AWS profile", type: "select", dynamic: true, help: "From `aws configure list-profiles`. Sign in first (aws sso login / aws login) if the session expired.", showIf: { field: "where", values: ["aws"] } },
		{ id: "region", label: "AWS region", type: "select", dynamic: true, showIf: { field: "where", values: ["aws"] } },
		{ id: "eksCluster", label: "EKS cluster", type: "select", dynamic: true, help: "Your AWS identity needs access to the cluster itself, not only to the account.", showIf: { field: "where", values: ["aws"] } },
		{ id: "project", label: "Google Cloud project", type: "select", dynamic: true, help: "From `gcloud projects list`. Sign in first (`gcloud auth login`) if the list is empty.", showIf: { field: "where", values: ["gcp"] } },
		{ id: "gkeCluster", label: "GKE cluster", type: "select", dynamic: true, showIf: { field: "where", values: ["gcp"] } },
		{ id: "namespace", label: "Namespace (optional)", type: "text", placeholder: "all namespaces" },
		{ id: "includeSystem", label: "Include system namespaces (kube-system…)", type: "checkbox", default: "" },
	],
	async loadOptions(fieldId, input, ctx) {
		const profile = (input.profile ?? "").trim();
		switch (fieldId) {
			case "subscription":
				return [...(await listSubscriptions(ctx)), { value: "all", label: "Every subscription I can see (slower)" }];
			case "aksCluster":
				return aksClusters(ctx, (input.subscription ?? "").trim());
			case "profile": {
				const r = await ctx.exec("aws", ["configure", "list-profiles"], { timeoutMs: 30_000 });
				const profiles = r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
				return [{ value: "", label: "Default credentials (environment / default profile)" }, ...profiles.map((p) => ({ value: p, label: p }))];
			}
			case "region": {
				if (profile && !AWS_PROFILE.test(profile)) return [];
				const home = await profileRegion(ctx, profile);
				const names = await awsRegions(ctx, profile, home);
				return [
					{ value: "", label: home ? `The profile's region (${home})` : "The profile's region (us-east-1 if it has none)" },
					{ value: "all", label: names.length ? "Every enabled region (slower)" : "(Could not list regions: sign in with aws sso login / aws login, then ↻)" },
					...names.map((n) => ({ value: n, label: n === home ? `${n} · the profile's region` : n })),
				];
			}
			case "eksCluster":
				return eksClusters(ctx, profile, (input.region ?? "").trim());
			case "project":
				return listProjects(ctx);
			case "gkeCluster":
				return gkeClusters(ctx, (input.project ?? "").trim());
		}
		if (fieldId !== "context") return [];
		try {
			const [all, current] = await Promise.all([ctx.exec("kubectl", ["config", "get-contexts", "-o", "name"], { timeoutMs: 15_000 }), ctx.exec("kubectl", ["config", "current-context"], { timeoutMs: 15_000 })]);
			const cur = current.stdout.trim();
			const names = all.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
			return names.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : a.localeCompare(b))).map((n) => ({ value: n, label: n === cur ? `${n} (current)` : n }));
		} catch {
			return [];
		}
	},
	async collect(input, ctx): Promise<CollectResult> {
		const namespace = (input.namespace ?? "").trim();
		if (namespace && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new MapperError(`"${namespace}" is not a namespace name.`);
		const cloud = await cloudCluster(input, ctx);
		// (what the map calls the cluster: a kubectl context of this computer, or the cluster found in the cloud)
		const context = cloud ? cloud.label : (input.context ?? "").trim() || undefined;
		ctx.progress(`Reading the cluster${context ? ` ${context}` : ""}…`);
		const scope = ["-o", "json", "--request-timeout=30s", ...(namespace ? ["-n", namespace] : ["-A"])];
		const { list, warning } = cloud
			? await withKubeconfig(cloud.kubeconfig, (file) =>
					kubectl(ctx, ["get", KINDS, ...scope, "--kubeconfig", file]).catch((e) => {
						// (the same failure, without the temporary file's path and with what is usually behind it for a cluster in the cloud)
						throw e instanceof MapperError && /^Could not read the cluster/.test(e.message) ? new MapperError(e.message.split(file).join("the temporary sign-in"), cloud.hint) : e;
					})
			  )
			: await kubectl(ctx, ["get", KINDS, ...scope, ...contextArgs(context)]);
		const r = clusterToGraph(list, { context, includeSystem: isOn(input.includeSystem) || !!namespace });
		if (warning) r.warnings.unshift(warning);
		if (!r.workloads && !r.services) return { summary: `No workloads or services found${namespace ? ` in namespace ${namespace}` : ""}.`, warnings: r.warnings };
		r.graph.legend = [
			`Kubernetes${context ? ` ${cloud ? "cluster" : "context"} ${context}` : ""}${namespace ? `, namespace ${namespace}` : ""}: ${r.workloads} workload(s), ${r.services} service(s) in ${r.namespaces} namespace(s).`,
			"Red outline: not all replicas ready, or pods pending / failed. Green pills: Services (arrows to the workloads they select). Orange: Ingress. Dashed: connections found in environment settings.",
			"Read with kubectl get (read-only); Secrets were not read.",
		];
		const facts = [
			`# Kubernetes cluster${context ? ` ${context}` : ""}`,
			...r.graph.nodes.filter((n) => n.kind.startsWith("k8s:") && n.kind !== "k8s:namespace").map((n) => `- ${n.kind.slice(4)} ${n.data?.namespace}/${n.data?.name}: ${n.label.replace(/\n/g, " · ")}${n.data?.images ? ` (images ${n.data.images})` : ""}`),
			r.warnings.length ? `\n## Not healthy\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "",
		].join("\n");
		return { graph: r.graph, summary: `${r.workloads} workload(s), ${r.services} service(s), ${r.namespaces} namespace(s)${r.warnings.length ? `, ${r.warnings.length} not healthy` : ""}`, warnings: r.warnings, facts };
	},
	agentPrompt: (input, result) =>
		agentRequest(
			`Review the Kubernetes map on this page${
				CLOUDS[input.where ?? ""]
					? ` (a cluster found in ${CLOUDS[input.where]}: this computer's kubeconfig may have no context for it, and the sign-in the map was read through is gone. If kubectl cannot reach it, work from the facts below and say so)`
					: input.context
					? ` (context ${input.context})`
					: ""
			} with read-only kubectl commands (get / describe / logs are fine; never apply, edit, delete, scale or exec). Explain what is unhealthy and why (describe the pods, recent events), point out risks (single replicas, no resource limits or probes, :latest images, privileged containers, Services without endpoints), and add connections between workloads the map is missing. Put short notes next to the shapes they concern.`,
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest("Kubernetes objects (inspect them with kubectl get / describe / logs, read-only)", shapes, question || "Is this healthy, what does it talk to, and how is it configured?"),
};
