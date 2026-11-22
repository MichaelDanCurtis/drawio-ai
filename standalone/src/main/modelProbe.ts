import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AcpAgentSession } from "./acpSession";
import { agentDef, agentStatuses, launchSpec, type AgentId } from "./agents";
import { modelsFromSession } from "./modelNames";
import { settings, updateSettings, type KnownModel } from "./settings";

let remembering = false;

/** Remembers what an agent offers, so Settings can list it while the agent is not running. */
export function rememberModels(agent: AgentId, models: KnownModel[]): void {
	if (!models.length || remembering) return;
	const known = settings().modelCatalog[agent] ?? [];
	const slim = models.map((m) => ({ value: m.value, name: m.name, ...(m.description ? { description: m.description } : {}) }));
	if (JSON.stringify(known) === JSON.stringify(slim)) return;
	remembering = true;
	try {
		updateSettings({ modelCatalog: { ...settings().modelCatalog, [agent]: slim } });
	} finally {
		remembering = false;
	}
}

const running = new Map<AgentId, Promise<string | undefined>>();

/**
 * Asks an agent which models it offers, without a chat: it is started in an empty folder
 * with no tools, a session is opened (nothing is sent to a model), its list is remembered and
 * it is stopped again. Returns what went wrong, if anything.
 */
export function probeModels(agent: AgentId, timeoutMs?: number): Promise<string | undefined> {
	const already = running.get(agent);
	if (already) return already;
	const p = (async (): Promise<string | undefined> => {
		const status = agentStatuses().find((a) => a.id === agent);
		if (!status?.installed) return status?.problem ?? "Not installed.";
		const def = agentDef(agent);
		const spec = launchSpec(def);
		if ("error" in spec) return spec.error;
		// (a first start through npx downloads the adapter: stopping that halfway could leave a broken copy)
		const wait = timeoutMs ?? (path.basename(spec.command) === "npx" ? 180_000 : 45_000);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-models-"));
		let exit: string | undefined;
		const session = new AcpAgentSession(def, spec, cwd, undefined, {
			onUpdate: () => undefined,
			requestPermission: async () => ({ outcome: "cancelled" }),
			onExit: (m) => (exit = m),
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			const info = await Promise.race([
				session.start(),
				new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error(`${def.label} did not answer in time.`)), wait))),
			]);
			const { models } = modelsFromSession(info);
			if (!models.length) return `${def.label} did not list any models.`;
			rememberModels(agent, models);
			return undefined;
		} catch (e: any) {
			return String(e?.message ?? exit ?? e).split("\n")[0];
		} finally {
			clearTimeout(timer);
			session.dispose();
			fs.rm(cwd, { recursive: true, force: true }, () => undefined);
		}
	})().finally(() => running.delete(agent));
	running.set(agent, p);
	return p;
}

/** Agents whose models are being asked for right now. */
export function probing(): AgentId[] {
	return [...running.keys()];
}
