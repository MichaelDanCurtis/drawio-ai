import { agentDef, agentStatuses, launchSpec, type AgentId } from "./agents";
import { apiAccess } from "./api/catalog";
import { apiCreatorAgents, openApiCreator } from "./api/creator";
import { openCreatorSession } from "./creatorSession";
import { paths } from "./paths";
import { settings } from "./settings";
import { PREVIEW_TOOL, SUBMIT_TOOL, type CreatorAgent, type CreatorPorts } from "./workshop/creator";

/**
 * Who can draw for the Shape Creator in the desktop app: the agent programs the chat knows
 * (installed and signed in on this computer), each started on its own for drawing
 * (creatorSession.ts), and the models of the providers the user has given an API key for
 * (api/creator.ts), which need no program at all. `openSettings` shows where both are set up.
 */
export function desktopCreator(openSettings?: (agent: string) => void): CreatorPorts {
	return {
		...(openSettings ? { settings: openSettings } : {}),
		agents: (): CreatorAgent[] => [
			...agentStatuses().map((s) => {
				const hidden = settings().models[s.id]?.hidden ?? [];
				const preferred = settings().models[s.id]?.preferred;
				// (a "mode" is not a model: it can be a permission mode, which the Creator never switches)
				const models = (settings().modelCatalog[s.id] ?? []).filter((m) => !m.value.startsWith("mode:") && !hidden.includes(m.value)).map((m) => ({ value: m.value, name: m.name }));
				// (what is wrong, in one line: an install command on a line of its own follows its sentence)
				return { id: s.id, label: s.label, ready: !s.problem, ...(s.problem ? { problem: s.problem.replace(/\s*\n\s*/g, " ").trim() } : {}), models, ...(preferred && models.some((m) => m.value === preferred) ? { model: preferred } : {}) };
			}),
			...apiCreatorAgents(apiAccess()),
		],
		open: async ({ agent, model, tools, onText, onExit }) => {
			const drawn = await openApiCreator(apiAccess(), { agent, model, tools, onText });
			if (drawn) return drawn;
			const status = agentStatuses().find((a) => a.id === agent);
			if (!status) throw new Error("That agent is not known here.");
			if (!status.installed) throw new Error(status.problem?.split("\n")[0] ?? `${status.label} is not installed.`);
			const def = agentDef(agent as AgentId);
			const spec = launchSpec(def);
			if ("error" in spec) throw new Error(spec.error);
			return openCreatorSession({ def, spec, model, tools, onText, onExit, stdioProxy: paths.stdioProxy });
		},
	};
}

const STAND_IN_ICON = (n: number) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="10" width="36" height="28" rx="4" fill="none" stroke="var(--stroke, #141414)" stroke-width="3"/><circle cx="${16 + n * 6}" cy="24" r="5" fill="var(--fill, #141414)"/></svg>`;

/**
 * A stand-in for the end-to-end run (DRAWAI_E2E_CREATOR): no agent is started and nothing is
 * sent anywhere. It answers a request the way an agent would, through the same two tools: it
 * looks at an icon, hands one in per variation asked for, and says a sentence.
 */
export function standInCreator(): CreatorPorts {
	return {
		agents: () => [
			{ id: "stand-in", label: "Stand-in agent", ready: true, models: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }], model: "small" },
			{ id: "absent", label: "Absent agent", ready: false, problem: "Absent agent is not installed.", models: [] },
		],
		open: async ({ agent, tools, onText }) => {
			if (agent !== "stand-in") throw new Error("Absent agent is not installed.");
			let cancelled = false;
			let turns = 0;
			return {
				label: "Stand-in agent",
				images: true,
				prompt: async (text) => {
					cancelled = false;
					turns++;
					onText("Drawing… ");
					const count = /three variations/.test(text) ? 3 : 1;
					const looked = await tools.call(PREVIEW_TOOL, { svg: STAND_IN_ICON(0) });
					onText(looked.image ? "looked at it, " : "could not look at it, ");
					for (let i = 0; i < count && !cancelled; i++) {
						const said = await tools.call(SUBMIT_TOOL, { svg: STAND_IN_ICON(i + (turns - 1) * 3), name: turns > 1 ? `Revised ${i + 1}` : `Stand-in ${i + 1}`, tags: ["stand-in", "test"] });
						if (said.isError) onText(`refused: ${said.text} `);
					}
					onText("done.");
					return cancelled ? "cancelled" : "end_turn";
				},
				cancel: () => (cancelled = true),
				dispose: () => undefined,
			};
		},
	};
}
