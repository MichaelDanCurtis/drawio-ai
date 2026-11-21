/**
 * A live Kubernetes cluster, read with `kubectl get … -o json` (read-only):
 * namespaces › workloads (with ready / pod counts), Services, Ingress routes,
 * and connections between workloads found in their environment (hosts only).
 */
import { agentRequest, digDeeperRequest, slug } from "../common";
import type { CollectContext, CollectResult, MapEdge, MapGraph, MapNode, Recipe } from "../../types";
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

export const kubernetesRecipe: Recipe = {
	id: "software.kubernetes",
	category: "software",
	title: "Kubernetes cluster (live)",
	description: "Namespaces, Deployments / StatefulSets / DaemonSets / CronJobs with ready and pod counts, Services and Ingress routes of a running cluster, read with `kubectl get` (read-only).",
	mode: "inventory",
	fields: [
		{ id: "context", label: "kubectl context", type: "select", dynamic: true, help: "From your kubeconfig; empty = the current context." },
		{ id: "namespace", label: "Namespace (optional)", type: "text", placeholder: "all namespaces" },
		{ id: "includeSystem", label: "Include system namespaces (kube-system…)", type: "checkbox", default: "" },
	],
	async loadOptions(fieldId, _input, ctx) {
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
		const context = (input.context ?? "").trim() || undefined;
		const namespace = (input.namespace ?? "").trim();
		if (namespace && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new MapperError(`"${namespace}" is not a namespace name.`);
		ctx.progress(`Reading the cluster${context ? ` ${context}` : ""}…`);
		const { list, warning } = await kubectl(ctx, ["get", KINDS, "-o", "json", "--request-timeout=30s", ...contextArgs(context), ...(namespace ? ["-n", namespace] : ["-A"])]);
		const r = clusterToGraph(list, { context, includeSystem: isOn(input.includeSystem) || !!namespace });
		if (warning) r.warnings.unshift(warning);
		if (!r.workloads && !r.services) return { summary: `No workloads or services found${namespace ? ` in namespace ${namespace}` : ""}.`, warnings: r.warnings };
		r.graph.legend = [
			`Kubernetes${context ? ` context ${context}` : ""}${namespace ? `, namespace ${namespace}` : ""}: ${r.workloads} workload(s), ${r.services} service(s) in ${r.namespaces} namespace(s).`,
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
			`Review the Kubernetes map on this page${input.context ? ` (context ${input.context})` : ""} with read-only kubectl commands (get / describe / logs are fine; never apply, edit, delete, scale or exec). Explain what is unhealthy and why (describe the pods, recent events), point out risks (single replicas, no resource limits or probes, :latest images, privileged containers, Services without endpoints), and add connections between workloads the map is missing. Put short notes next to the shapes they concern.`,
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest("Kubernetes objects (inspect them with kubectl get / describe / logs, read-only)", shapes, question || "Is this healthy, what does it talk to, and how is it configured?"),
};
