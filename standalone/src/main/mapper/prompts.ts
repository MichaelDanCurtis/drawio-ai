import { agentRequest } from "./recipes/common";
import type { MapRecord } from "./store";
import type { MapFinding } from "./types";

/**
 * Requests the app sends to the agent for map work. The agent works through the
 * mapper_* MCP tools; the app validates what it submits (floorplan's approach:
 * the model writes JSON, the app checks it and writes the diagram).
 */

export function describePrompt(r: MapRecord, audience: "everyone" | "developer"): string {
	return agentRequest(
		[
			`Write a plain-English description for every shape of the map "${r.title}" (map id ${r.id}), for ${audience === "everyone" ? "everyone, including people who don't write code: no jargon" : "developers"}.`,
			"1. Call mapper_worksheet with this mapId (it lists shapes without a description, 40 at a time; use offset from `next`).",
			"2. For each shape, one or two sentences, verb first, saying what it does today, grounded in the evidence: who uses it and what it uses, its files (read them when listed), its data. Don't describe it from its name alone; call out stubs, placeholders and unused things plainly.",
			"3. Save them with mapper_set_descriptions in batches (same mapId and audience). Fix every problem it reports and resubmit those.",
			"4. Repeat until `remaining` is 0. Don't add, remove or move shapes. Finish with one line saying how many shapes you described.",
		].join("\n")
	);
}

/** How the user plays a tour in the desktop app; the VS Code extension has its own way (F5 starts a debugger there). */
export const PLAY_TOUR_DESKTOP = "press F5 (presentation mode) and pick the tour";

export function tourPrompt(r: MapRecord, focus: string, play: string = PLAY_TOUR_DESKTOP): string {
	return agentRequest(
		[
			`Build a guided tour through the map "${r.title}" (map id ${r.id})${focus.trim() ? ` focused on: ${focus.trim()}` : " that explains how it fits together"}.`,
			"Look the map up with mapper_maps, mapper_find, mapper_show and mapper_path (and the files when shapes list them).",
			"Then save it with mapper_set_tour: 4–10 steps in a sensible order (follow how requests or data actually flow), each with a short title, a caption of one or two plain sentences, and the node ids to show; consecutive steps should be connected on the map. Fix any problems it reports.",
			`Finish by telling the user to ${play}.`,
		].join("\n")
	);
}

export function askPrompt(question: string): string {
	return agentRequest(
		[
			`Answer this question about the maps of the open diagram: ${question.trim()}`,
			"Use mapper_maps, mapper_find, mapper_show and mapper_path to find the answer in the maps first (read files the shapes list when you need details).",
			"Then call mapper_answer with the question, a short answer, and the steps: the node ids your answer walks through, in reading order, each with a short note. It draws them as a new page. Finish with the answer in a sentence or two.",
		].join("\n")
	);
}

/** Asks the agent to fix one health finding where it is defined; it never changes live systems itself. */
export function fixFindingPrompt(r: MapRecord, finding: MapFinding): string {
	const shapes = finding.nodeIds.map((id) => r.graph.nodes.find((n) => n.id === id)).filter(Boolean);
	return agentRequest(
		`Fix this finding from the map "${r.title}" (map ${r.id}): ${finding.title}.${finding.detail ? `\nEvidence: ${finding.detail}` : ""}${finding.fix ? `\nSuggested fix: ${finding.fix}` : ""}\nThe shapes concerned: ${JSON.stringify(shapes.map((n) => ({ id: n!.id, label: n!.label, data: n!.data, files: n!.files })))}.\nFind where it is defined (code, IaC, config) and propose the change; make file changes only with the user's approval, and never change live cloud resources or databases yourself — give the commands for the user to run instead.`
	);
}
