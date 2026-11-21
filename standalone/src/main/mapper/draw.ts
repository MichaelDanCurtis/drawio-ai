import type { CustomizedDrawioClient } from "../../../../src/DrawioClient/CustomizedDrawioClient";
import { renderGraph } from "./render";
import type { MapGraph } from "./types";

export interface DrawResult {
	/** Name of the page the map is on. */
	page: string;
	/** Whether a page was added for it. */
	newPage: boolean;
	cells: number;
}

/**
 * Draws a map into the open diagram as one pending AI change the user keeps or
 * reverts: on the current page when it is empty, otherwise on a new page.
 */
export async function drawMap(client: CustomizedDrawioClient, graph: MapGraph, recipe: string): Promise<DrawResult> {
	const current = await client.aiGetModel({ scope: "page", includeStyles: false, maxCells: 1 });
	let page = current.page.name;
	let newPage = false;
	if (current.totalCells > 0) {
		const names = new Set((await client.aiPages({ op: "list" })).pages.map((p) => p.name));
		let name = graph.title.slice(0, 80);
		for (let i = 2; names.has(name); i++) name = `${graph.title.slice(0, 74)} (${i})`;
		const added = await client.aiPages({ op: "add", name, select: true, review: true });
		if (added.error) throw new Error(`Could not add a page for the map: ${added.error}`);
		page = name;
		newPage = true;
	}
	const { xml, cells } = renderGraph(graph, { recipe });
	const r = await client.aiApplyOps([{ op: "insertXml", xml }], { selectResult: false, flash: true, atomic: true, review: true });
	const failed = r.results.find((x) => !x.ok);
	if (failed || r.rolledBack) throw new Error(`Drawing the map failed: ${failed?.error ?? "the change was rolled back"}`);
	return { page, newPage, cells };
}

/** The mapped shapes among the selection (shapes the Mapper drew carry `mapper`). */
export async function mappedSelection(client: CustomizedDrawioClient): Promise<{ recipe: string; label: string; data: Record<string, string> }[]> {
	if (client.currentSelection.length === 0) return [];
	const model = await client.aiGetModel({ scope: "selection", includeStyles: false, maxCells: 300 });
	return model.cells
		.filter((c) => c.selected !== false && !c.context && c.data?.mapper && c.data.mapperKind !== "legend")
		.map((c) => ({ recipe: c.data!.mapper, label: c.label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), data: c.data! }));
}
