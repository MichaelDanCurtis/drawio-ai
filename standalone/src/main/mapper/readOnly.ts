/**
 * The Mapper only reads. Collectors call fixed commands, and this guard is the
 * safety net under them: cloud CLI calls must be listing / describing / querying
 * ones, and other programs must be on a short list of inspection tools.
 * Databases are read through drivers in read-only sessions, not through CLIs.
 */

/** The last word before the first option is the verb: `az network vnet list --query ...` → "list". */
function verbOf(args: string[]): { head: string[]; verb: string } {
	const first = args.findIndex((a) => a.startsWith("-"));
	const head = (first < 0 ? args : args.slice(0, first)).filter(Boolean);
	return { head, verb: head[head.length - 1] ?? "" };
}

const AZ_VERBS = new Set(["list", "show", "query", "list-locations", "version"]);
/** Words that change something: a command containing one is refused even if it also lists. */
const WRITE_WORDS = new Set([
	"create", "delete", "update", "set", "add", "remove", "deploy", "start", "stop", "restart", "run", "invoke",
	"import", "upload", "reset", "enable", "disable", "attach", "detach", "assign", "move", "resize", "scale",
	"apply", "patch", "replace", "purge", "rotate", "ssh", "login", "logout", "install", "uninstall", "upgrade",
	"cancel", "approve", "deny", "grant", "revoke", "tag", "untag", "lock", "unlock", "regenerate", "renew",
	"restore", "failover", "swap", "sync", "execute", "exec", "connect", "copy", "rename", "wait", "create-or-update",
]);

/**
 * az and gcloud: `<group>... <verb> [positional args] [--options]`. Positional
 * arguments (gcloud projects describe my-project) follow the verb, so any read
 * verb among the words counts, as long as no word changes anything. The first
 * word is the command group, which may look like a verb (gcloud run, az lock, az tag).
 */
function writes(head: string[]): boolean {
	return head.slice(1).some((w) => WRITE_WORDS.has(w));
}

function readVerbAmong(head: string[], verbs: Set<string>): boolean {
	return head.some((w) => verbs.has(w)) && !writes(head);
}
const GCLOUD_VERBS = new Set(["list", "describe", "search-all-resources", "search-all-iam-policies", "get-iam-policy", "get-value", "version"]);
const KUBECTL_VERBS = new Set(["get", "describe", "version", "api-resources", "cluster-info"]);
const KUBECTL_CONFIG = new Set(["view", "current-context", "get-contexts"]);
const GIT_COMMANDS = new Set(["rev-parse", "remote", "log", "ls-files", "show", "branch", "diff", "status"]);

/** Returns why the command is refused, or undefined when it may run. */
export function checkReadOnly(command: string, args: string[]): string | undefined {
	const name = command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, "").toLowerCase();
	const { head, verb } = verbOf(args);
	switch (name) {
		case "az":
			// One command that is not a list or a show: the signed-in user's own way into an AKS cluster,
			// printed (`--file -`) so that nothing is written, least of all ~/.kube/config. Never the
			// cluster admin's, and never merged into a file.
			if (head.join(" ") === "aks get-credentials") {
				const file = args.findIndex((a) => a === "--file" || a === "-f");
				const printed = file >= 0 && args[file + 1] === "-" && args.filter((a) => a === "--file" || a === "-f" || a.startsWith("--file=") || a.startsWith("-f=")).length === 1;
				const admin = args.some((a) => a === "--admin" || a === "-a" || a.startsWith("--admin=") || a.startsWith("--overwrite") || a.startsWith("--context"));
				return printed && !admin ? undefined : "`az aks get-credentials` may only print the signed-in user's access (`--file -`): it is never the admin's and never written to a kubeconfig";
			}
			return (AZ_VERBS.has(verb) && !writes(head)) || readVerbAmong(head, AZ_VERBS) ? undefined : `\`az ${head.join(" ")}\` is not a read-only command`;
		case "aws": {
			const [service, op = ""] = head;
			if (service === "sts" && op === "get-caller-identity") return undefined;
			if (service === "configure" && (op === "list-profiles" || op === "list")) return undefined;
			return /^(describe|list|get|search|lookup|select)-/.test(op) ? undefined : `\`aws ${head.slice(0, 2).join(" ")}\` is not a read-only command`;
		}
		case "gcloud":
			return (GCLOUD_VERBS.has(verb) && !writes(head)) || readVerbAmong(head, GCLOUD_VERBS) || (head[0] === "auth" && verb === "list") || (head[0] === "config" && (verb === "list" || verb === "get-value"))
				? undefined
				: `\`gcloud ${head.join(" ")}\` is not a read-only command`;
		case "kubectl":
			return KUBECTL_VERBS.has(head[0] ?? "") || (head[0] === "config" && KUBECTL_CONFIG.has(head[1] ?? ""))
				? undefined
				: `\`kubectl ${head.slice(0, 2).join(" ")}\` is not a read-only command`;
		case "git":
			return GIT_COMMANDS.has(head[0] ?? "") ? undefined : `\`git ${head[0] ?? ""}\` is not a read-only command`;
		case "gh": {
			const method = args.findIndex((a) => a === "-X" || a === "--method");
			if (head[0] === "api") return method < 0 || /^get$/i.test(args[method + 1] ?? "") ? undefined : "`gh api` may only GET";
			return head[0] === "auth" && head[1] === "status" ? undefined : `\`gh ${head.slice(0, 2).join(" ")}\` is not a read-only command`;
		}
		case "which":
		case "where":
			return undefined;
		default:
			return `${name} is not one of the Mapper's read-only tools`;
	}
}
