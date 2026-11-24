import { agentRequest, digDeeperRequest, FOLDER_FIELD, folderInput } from "../common";
import type { CollectResult, FieldDef, MapInput, Recipe } from "../../types";
import { systemFindings } from "./health";
import { matchesFocus, scanFacts, systemGraph } from "./systemGraph";
import { isOn } from "./shared";
import { scanSystem, type SystemScan } from "./systemScan";

const TESTS_FIELD: FieldDef = { id: "includeTests", label: "Include tests, examples and docs folders", type: "checkbox", default: "" };

function summaryOf(scan: SystemScan): string {
	const kinds = new Map<string, number>();
	for (const r of scan.resources) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
	const parts = [...kinds].map(([k, n]) => `${n} ${k === "external" ? "external API" : k}${n === 1 ? "" : k === "cache" ? "s" : k.endsWith("s") ? "es" : "s"}`);
	return `${scan.services.length} service(s)${parts.length ? `, ${parts.join(", ")}` : ""}, ${scan.links.length} connection(s) (${scan.stats.files} files read in ${scan.stats.ms} ms)`;
}

/**
 * What a scan that found nothing to draw did see, for its message: how much it read, and the
 * packages it found that are not services (nothing deploys them, they connect to nothing, and
 * no entry point was recognised in them).
 */
function whatWasThere(scan: SystemScan): string {
	const read = ` ${scan.stats.codeFiles} code file(s) were read.`;
	if (!scan.libraries.length) return read;
	const names = scan.libraries.slice(0, 4).map((l) => l || ".").join(", ");
	return `${read} ${scan.libraries.length} package(s) are there (${names}${scan.libraries.length > 4 ? ", …" : ""}), but none is deployed (Dockerfile, compose, Kubernetes), connects to a data store or an API, or has an entry point the Mapper recognises (an HTTP route, a job, a command).`;
}

export const connectivityRecipe: Recipe = {
	id: "software.connectivity",
	category: "software",
	title: "Connectivity: services, databases, queues, external APIs",
	description:
		"How the apps in a repository talk to each other and to databases, caches, queues and third-party APIs, read from docker-compose, Kubernetes manifests, .env / config files and the code's client libraries. Only hosts and ports are kept, never credentials.",
	mode: "inventory",
	fields: [FOLDER_FIELD, TESTS_FIELD],
	async collect(input, ctx): Promise<CollectResult> {
		const root = folderInput(input, ctx.cwd);
		const scan = scanSystem(root, { includeTests: isOn(input.includeTests), progress: (t) => ctx.progress(t) });
		if (!scan.services.length && !scan.resources.length) {
			return { summary: `No services, data stores or connections found in ${root}.${whatWasThere(scan)}`, warnings: scan.warnings, facts: scanFacts(scan) };
		}
		const graph = systemGraph(scan, { title: `Connectivity · ${scan.name}` });
		graph.legend = [
			`Connectivity of ${scan.name}: ${summaryOf(scan)}.`,
			"Boxes with a header: services (code packages, compose services, Kubernetes workloads). Cylinders: data stores (blue), caches (red), search (yellow), storage (green). Purple: queues and topics. Clouds: external APIs.",
			"Solid arrows: calls (protocol :port). Dashed purple: publish / consume. Dashed grey: start-up order only (depends_on).",
			"Read-only from config and code: hosts and ports only, credentials are never read into the map.",
		];
		const { findings, checked } = systemFindings(scan, graph);
		return { graph, summary: summaryOf(scan), warnings: scan.warnings, facts: scanFacts(scan), findings, checked };
	},
	agentPrompt: (_input, result) =>
		agentRequest(
			"Complete the connectivity map on this page. For each service, read its code (start from the files listed in the facts) and check the connections: confirm or correct them, add the ones the scan missed (HTTP / gRPC calls between services, third-party APIs, files, other stores), and label each arrow with the protocol and what it is for (e.g. \"reads orders\", \"caches sessions\", \"publishes OrderCreated\"). Mark anything unencrypted or using shared credentials with a short note. Replace generic shapes with proper icons (PostgreSQL, Redis, Kafka, cloud services) where it helps.",
			result?.facts
		),
	digDeeper: (shapes, question) =>
		digDeeperRequest("services and systems (trace their calls in the code: clients, URLs, queries, topics)", shapes, question || "Trace what this calls and what calls it, with the protocol and the data that moves."),
};

const FOCUS_FIELD: FieldDef = {
	id: "focus",
	label: "Focus (optional)",
	type: "text",
	placeholder: "e.g. orders, user signup, payments",
	help: "The flow to trace; entry points mentioning it are marked ★ and listed first for the agent.",
};

/** Files whose code mentions the focus terms, best first. */
function focusFiles(hits: Map<string, number>): string[] {
	return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([f, n]) => `${f} (${n})`);
}

export const dataflowRecipe: Recipe = {
	id: "software.dataflow",
	category: "software",
	title: "Data flow",
	description:
		"A skeleton of how data moves: entry points (HTTP routes, message consumers, scheduled jobs) inside each service, the stores and queues they use; then your agent traces the flows through the code and draws them, optionally focused on one flow (\"orders\", \"user signup\").",
	mode: "inventory",
	fields: [FOLDER_FIELD, FOCUS_FIELD, TESTS_FIELD],
	async collect(input, ctx): Promise<CollectResult> {
		const root = folderInput(input, ctx.cwd);
		const focus = (input.focus ?? "").trim();
		const terms = focus
			.toLowerCase()
			.split(/[\s,;/]+/)
			.filter((t) => t.length >= 3)
			.flatMap((t) => (t.endsWith("s") ? [t, t.slice(0, -1)] : [t]));
		const hits = new Map<string, number>();
		const scan = scanSystem(root, {
			includeTests: isOn(input.includeTests),
			progress: (t) => ctx.progress(t),
			visit: terms.length
				? (f) => {
						let n = 0;
						const lower = f.text.toLowerCase();
						for (const t of terms) for (let i = lower.indexOf(t); i >= 0 && n < 500; i = lower.indexOf(t, i + t.length)) n++;
						if (n) hits.set(f.rel, n);
				  }
				: undefined,
		});
		const entryCount = scan.services.reduce((a, s) => a + s.entries.length, 0);
		if (!scan.services.length) return { summary: `No services or entry points found in ${root}.${whatWasThere(scan)}`, warnings: scan.warnings, facts: scanFacts(scan, { entries: true }) };
		const graph = systemGraph(scan, { title: `Data flow${focus ? ` (${focus})` : ""} · ${scan.name}`, entries: true, focus, direction: "right" });
		const focused = terms.length ? scan.services.flatMap((s) => s.entries).filter((e) => matchesFocus(`${e.label} ${e.file}`, terms)).length : 0;
		graph.legend = [
			`Data-flow skeleton of ${scan.name}${focus ? `, focus “${focus}”` : ""}: ${entryCount} entry point(s) in ${scan.services.length} service(s).`,
			"Tables inside the services: HTTP routes, consumed topics / queues and scheduled jobs" + (focus ? " (★ = mentions the focus)." : "."),
			"Arrows so far come from config and client libraries; ask the agent to trace the actual flows.",
		];
		const facts = [
			scanFacts(scan, { entries: true, maxEntries: 120 }),
			terms.length ? `\n## Code mentioning “${focus}” (matches)\n${focusFiles(hits).map((f) => `- ${f}`).join("\n") || "- none found"}` : "",
		].join("\n");
		const { findings, checked } = systemFindings(scan, graph, { entries: true });
		return {
			graph,
			findings,
			checked,
			summary: `${scan.services.length} service(s), ${entryCount} entry point(s)${terms.length ? ` (${focused} matching “${focus}”, ${hits.size} file(s) mention it)` : ""}, ${scan.resources.length} store(s)/queue(s)/API(s)`,
			warnings: scan.warnings,
			facts,
		};
	},
	agentPrompt: (input: MapInput, result) => {
		const focus = (input.focus ?? "").trim();
		return agentRequest(
			[
				`Trace how data flows through this system${focus ? `, focusing on “${focus}”` : ""}, and draw it on the data-flow skeleton on this page.`,
				focus
					? `Start from the entry points marked ★ and the files that mention “${focus}” (listed in the facts); follow each request or message through handlers, services and repositories to the stores, queues and external APIs it reaches.`
					: "Pick the most important flows (the main user-facing routes and the messages between services) and follow each through handlers, services and repositories to the stores, queues and external APIs it reaches.",
				"Add arrows for each hop labelled with what moves and what happens to it (e.g. \"POST /orders → validates cart\", \"writes order\", \"publishes OrderCreated\", \"reads stock\", \"charges card\"), numbered in order (1, 2, 3…) when it is one flow. Add a shape for any important step, store or external system the skeleton lacks, next to the service it belongs to. Note where data is transformed, validated, cached or leaves the system, and any personal or payment data.",
				"Keep the existing shapes; read the code rather than guessing, and say in your summary which flows you traced and what you could not confirm.",
			].join("\n\n"),
			result?.facts
		);
	},
	digDeeper: (shapes, question) =>
		digDeeperRequest("parts of the data flow (follow the data through the code from these entry points / services / stores)", shapes, question || "Where does this data come from and where does it go next?"),
};
