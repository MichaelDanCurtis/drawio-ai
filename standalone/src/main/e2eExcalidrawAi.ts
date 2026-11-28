// End-to-end check of the AI tools for an Excalidraw drawing (part of `yarn e2e --excalidraw`):
// the window's endpoint as an agent reaches it, each tool against the real editor, the review
// of what was changed (outlines, Reject, Accept, undo, the user's own edits), and the chat
// answered by a stand-in: a provider's API that is none (api/standIn.ts), and, when the run is
// from source, an agent program that is none (test/helpers/fake-acp-agent.js) over ACP.
// No real agent is started, no key is used and nothing is sent anywhere.
import { dialog, Menu, type WebContents } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { E2eConfig } from "./e2e";
import { addElement, closed, elementIds, expect, inEditor, menuItem, pause, shot, until } from "./e2eExcalidraw";
import { readScene } from "./excalidrawFile";
import { ExcalidrawWindow } from "./excalidrawWindow";
import { paths } from "./paths";
import { agentDef, launchSpec, type LaunchSpec } from "./agents";
import { settingsPath, updateSettings } from "./settings";
import type { StaticServer } from "./staticServer";

/** `sample`: the drawing the run was started with, as it was before anything changed it. */
export async function runDrawingAi(server: StaticServer, config: E2eConfig, log: (k: string, v: unknown) => void, watch: (wc: WebContents) => void, sample: Buffer): Promise<void> {
	const file = path.join(config.out, "ai.excalidraw");
	fs.writeFileSync(file, sample);
	const w = await ExcalidrawWindow.open(server, file);
	expect(w, "the drawing for the AI checks opens");
	watch(w.editorView.webContents);
	await w.whenLoaded();
	const chat = w.chatView.webContents;

	// ----- the endpoint, exactly as an agent reaches it -----
	const mcp = (w as any).mcp as { url: string; token: string };
	const rpc = async (method: string, params: unknown) => {
		const r = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
		return (await r.json()) as any;
	};
	/** A tool call: what it answered (parsed when it is JSON), whether it failed, and its picture if it has one. */
	const call = async (name: string, args: unknown) => {
		const result = (await rpc("tools/call", { name, arguments: args })).result;
		const text: string = result.content.find((c: any) => c.type === "text")?.text ?? "";
		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			data = undefined;
		}
		return { text, data, isError: !!result.isError, image: result.content.find((c: any) => c.type === "image") };
	};
	const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })).result;
	const tools: string[] = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
	log("aiTools", tools);
	expect(JSON.stringify(tools) === JSON.stringify(["excalidraw_get_scene", "excalidraw_apply_operations", "excalidraw_select", "excalidraw_render_image", "excalidraw_from_mermaid", "excalidraw_export"]), "the endpoint offers the drawing's tools, and none of draw.io's");
	expect(/Excalidraw drawing "ai\.excalidraw"/.test(init.instructions) && /excalidraw_apply_operations/.test(init.instructions), "the endpoint's instructions are about this drawing");
	expect((await fetch(mcp.url, { method: "POST", body: "{}" })).status === 401, "the endpoint refuses a call without its token");

	// ----- reading -----
	const scene = (await call("excalidraw_get_scene", {})).data;
	log("aiScene", { total: scene.total, elements: scene.elements.map((e: any) => `${e.type} ${e.id}${e.label ? ` "${e.label}"` : ""}${e.start ? ` ${e.start}→${e.end}` : ""}`) });
	expect(scene.total === 3 && scene.elements.find((e: any) => e.id === "box-plan")?.label === "Sketch" && scene.elements.find((e: any) => e.id === "arrow-1")?.end === "ellipse-ship", "the drawing is read as shapes with their labels and arrows with what they are attached to");
	expect((await call("excalidraw_get_scene", { query: "ship" })).data.returned === 1, "a query narrows what is read");

	// ----- what the page and the chat show of the review -----
	const review = () =>
		inEditor<{ pending: string | null; outlines: string[]; working: boolean }>(w, `return { pending: bar.getElementById("pending")?.textContent ?? null, outlines: Array.from(document.querySelectorAll("#review-outlines rect")).map((r) => r.dataset.change + " " + r.dataset.element), working: !!bar.getElementById("working") };`);
	const chatReview = (): Promise<string | null> => chat.executeJavaScript(`document.getElementById("review").classList.contains("hidden") ? null : document.getElementById("reviewCounts").textContent`);
	const settled = async () => {
		await until("the review to end", async () => (await review()).pending === null && (await chatReview()) === null);
	};

	// ----- changing: one step, pending until kept or reverted -----
	const added = await call("excalidraw_apply_operations", {
		operations: [
			{ op: "add", type: "rectangle", id: "api", x: 80, y: 300, width: 180, height: 80, label: "API", backgroundColor: "#a5d8ff" },
			{ op: "add", type: "diamond", id: "check", x: 400, y: 280, width: 170, height: 120, label: "ok?" },
			{ op: "add", type: "arrow", id: "api-check", start: "api", end: "check", label: "asks" },
			{ op: "update", id: "box-plan", label: "Plan", backgroundColor: "#b2f2bb" },
		],
	});
	log("aiApply", added.data ?? added.text);
	expect(!added.isError && added.data.applied === 4 && added.data.pendingReview.added === 3 && added.data.pendingReview.changed === 1, "four operations are applied as one step, and are pending");
	await until("the pending changes to be outlined", async () => (await review()).outlines.length === 4);
	const outlined = await review();
	log("aiReview", { ...outlined, chat: await chatReview() });
	expect(outlined.pending === "3 added, 1 changed" && outlined.outlines.includes("added api") && outlined.outlines.includes("added api-check") && outlined.outlines.includes("changed box-plan"), "the bar counts the pending changes and the canvas outlines them");
	await until("the chat to show the pending changes", async () => (await chatReview()) === "3 added1 changed");
	expect(w.isDirty, "an agent's change is an unsaved change");
	const afterAdd = (await call("excalidraw_get_scene", { includeStyles: true })).data;
	const arrow = afterAdd.elements.find((e: any) => e.id === "api-check");
	expect(arrow?.start === "api" && arrow?.end === "check" && arrow?.label === "asks" && afterAdd.elements.find((e: any) => e.id === "box-plan")?.label === "Plan" && afterAdd.pendingReview.added === 3, "the arrow is attached at both ends and labelled, and the shape has its new label");
	await shot(config, "window-review", w);

	// a shape that is moved takes its label and its arrows with it
	const before = await inEditor<any>(w, `const e = (id) => x.api.getSceneElements().find((el) => el.id === id); const a = e("api-check"); return { ax: a.x, ay: a.y };`);
	expect(!(await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "check", x: 520, y: 420 }] })).isError, "a shape is moved");
	const moved = await inEditor<any>(w, `const e = (id) => x.api.getSceneElements().find((el) => el.id === id); const a = e("api-check"), c = e("check"), label = x.api.getSceneElements().find((el) => el.containerId === "check");
		const end = [a.x + a.points[a.points.length - 1][0], a.y + a.points[a.points.length - 1][1]];
		return { check: [c.x, c.y], labelInside: label.x > c.x && label.x + label.width < c.x + c.width && label.y > c.y && label.y + label.height < c.y + c.height, endNearCheck: end[0] > c.x - 20 && end[0] < c.x + c.width + 20 && end[1] > c.y - 20 && end[1] < c.y + c.height + 20, stillBound: a.endBinding.elementId === "check" && a.startBinding.elementId === "api" };`);
	log("aiMove", { before, moved });
	expect(moved.check[0] === 520 && moved.check[1] === 420 && moved.labelInside && moved.endNearCheck && moved.stillBound, "the moved shape's label is inside it and its arrow ends at it");

	// a shape that is turned takes its label round with it, and its arrow leaves from where its outline is now
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "turn", x: 0, y: 700, width: 160, height: 80, label: "Turn" }, { op: "add", type: "rectangle", id: "beside", x: 400, y: 700, width: 160, height: 80 }, { op: "add", type: "arrow", id: "turn-beside", start: "turn", end: "beside" }] });
	const startOf = () => inEditor<number[]>(w, `const a = x.api.getSceneElements().find((e) => e.id === "turn-beside"); return [Math.round(a.x + a.points[0][0]), Math.round(a.y + a.points[0][1])];`);
	const flat = await startOf();
	expect(!(await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "turn", angle: 90 }] })).isError, "a shape is turned");
	const upright = await inEditor<any>(w, `const all = x.api.getSceneElements(); const s = all.find((e) => e.id === "turn"), l = all.find((e) => e.containerId === "turn"), a = all.find((e) => e.id === "turn-beside"); return { shape: s.angle, label: l.angle, bound: a.startBinding.elementId };`);
	const stood = await startOf();
	log("aiTurned", { flat, stood, upright });
	// (160 wide lying down, its right edge is at x=160; stood up about its centre it is 80 wide, and that edge is at x=120)
	expect(Math.abs(flat[0] - 166) <= 2 && Math.abs(stood[0] - 126) <= 2 && Math.abs(stood[1] - 740) <= 2, `the arrow leaves from the turned shape's outline (${flat} → ${stood})`);
	expect(Math.abs(upright.shape - Math.PI / 2) < 1e-9 && upright.label === upright.shape && upright.bound === "turn", "the label is turned with its shape, and the arrow is still attached");

	// an arrow is restyled and relabelled where it is, and attached elsewhere
	const rewired = await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "api-check", strokeColor: "#e03131", strokeStyle: "dashed", label: "asks again" }, { op: "update", id: "api-check", end: "box-plan" }] });
	const wired = await inEditor<any>(w, `const all = x.api.getSceneElements(); const e = (id) => all.find((el) => el.id === id); const a = e("api-check"), label = all.find((el) => el.containerId === "api-check");
		const lists = (id) => (e(id).boundElements || []).some((b) => b.id === "api-check");
		return { stroke: a.strokeColor, style: a.strokeStyle, label: label.text, labelStroke: label.strokeColor, labels: all.filter((el) => el.containerId === "api-check").length, start: a.startBinding.elementId, end: a.endBinding.elementId, onPlan: lists("box-plan"), onCheck: lists("check"), onApi: lists("api") };`);
	log("aiArrow", wired);
	expect(!rewired.isError && wired.stroke === "#e03131" && wired.style === "dashed" && wired.label === "asks again" && wired.labelStroke === "#e03131" && wired.labels === 1, "the arrow has its new look and its new words, in one label");
	expect(wired.start === "api" && wired.end === "box-plan" && wired.onPlan && wired.onApi && !wired.onCheck, "the arrow ends at the other shape, which knows of it; the shape it left does not");

	// a label on an arrow that runs straight down: the arrow stays the line it is
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "arrow", id: "down", points: [[700, 300], [700, 460]] }, { op: "update", id: "down", label: "then" }] });
	const down = await inEditor<any>(w, `const all = x.api.getSceneElements(); const a = all.find((el) => el.id === "down"), label = all.find((el) => el.containerId === "down"); return { width: a.width, height: a.height, points: a.points, label: label && label.text, labelNearMiddle: !!label && Math.abs(label.y + label.height / 2 - 380) < 30 && Math.abs(label.x + label.width / 2 - 700) < 30 };`);
	log("aiVerticalArrow", down);
	expect(down.width === 0 && down.height === 160 && down.label === "then" && down.labelNearMiddle, "a labelled vertical arrow keeps its shape, with the label at its middle");

	// what is wrong is refused whole, with what to fix
	const invalid = await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "hexagon", x: 0, y: 0 }, { op: "update", id: "api" }, { op: "paint" }] });
	const failing = await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "extra", x: 0, y: 600 }, { op: "delete", id: "nobody" }] });
	log("aiRefused", { invalid: invalid.text, failing: failing.text });
	expect(invalid.isError && /operations\[0\]: type must be one of/.test(invalid.text) && /operations\[1\]: nothing to change/.test(invalid.text) && /operations\[2\]: op must be/.test(invalid.text), "what a model got wrong is named, operation by operation");
	expect(failing.isError && /Nothing was changed/.test(failing.text) && !(await elementIds(w)).includes("extra"), "when one operation cannot be done, none is");

	// ----- a picture for the model, and the selection for the chat -----
	const picture = await call("excalidraw_render_image", {});
	expect(!picture.isError && picture.image?.mimeType === "image/png" && Buffer.from(picture.image.data, "base64").subarray(1, 4).toString("latin1") === "PNG", "the drawing is rendered to a PNG");
	const selected = await call("excalidraw_select", { ids: ["api", "check", "nobody"] });
	expect(selected.data.selected.length === 2 && selected.data.notFound[0] === "nobody", "elements are selected for the user");
	await until("the chat to show the selection", () => chat.executeJavaScript(`!document.getElementById("selection").classList.contains("hidden") && document.getElementById("selection").textContent === "2 selected"`));
	expect((await call("excalidraw_get_scene", { scope: "selection" })).data.returned === 2, "the selection can be read by itself");
	await call("excalidraw_select", { ids: [] });
	log("aiPictureAndSelection", { pngBytes: Buffer.from(picture.image.data, "base64").length });

	// ----- Reject, from the chat: everything is as it was -----
	await chat.executeJavaScript(`document.getElementById("reviewReject").click()`);
	await settled();
	const reverted = (await call("excalidraw_get_scene", {})).data;
	log("aiRejected", reverted.elements.map((e: any) => `${e.id}${e.label ? ` "${e.label}"` : ""}`));
	expect(reverted.total === 3 && reverted.elements.find((e: any) => e.id === "box-plan")?.label === "Sketch" && !reverted.pendingReview, "Reject puts the drawing back as it was before the agent touched it");

	// ----- Accept, from the bar: the changes stay, and nothing is pending -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "ellipse", id: "kept", x: 80, y: 320, width: 160, height: 90, label: "Kept" }] });
	await until("the pending change", async () => (await review()).pending === "1 added");
	await inEditor(w, `bar.getElementById("accept").click();`);
	await settled();
	expect((await elementIds(w)).includes("kept"), "Accept keeps what the agent drew");

	// ----- a change that is undone is no longer pending; the user's own edits are no part of the review -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "undone", x: 320, y: 320, label: "Undo me" }] });
	await until("the pending change", async () => (await review()).pending === "1 added");
	w.editorView.webContents.focus();
	menuItem("Edit", "Undo").click();
	await settled();
	expect(!(await elementIds(w)).includes("undone"), "Edit → Undo takes the agent's change away, and the review with it");
	// (redone, it is the agent's change again: pending, and still to be reverted)
	menuItem("Edit", "Redo").click();
	await until("the redone change to be pending again", async () => (await review()).pending === "1 added" && (await chatReview()) === "1 added");
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	expect(!(await elementIds(w)).includes("undone"), "a change that was undone and redone is reverted like any other");

	// an arrow the agent attaches to the user's shapes: what the user does to those shapes meanwhile stays theirs
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "arrow", id: "link", start: "box-plan", end: "kept" }] });
	await until("the pending arrow", async () => (await review()).pending === "1 added");
	await inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => (e.id === "kept" ? { ...e, x: e.x + 300, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)), captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	await pause(300);
	expect((await review()).pending === "1 added", "a shape the agent only attached an arrow to is not a pending change, moved by the user or not");
	const keptAt = await inEditor<number>(w, `return x.api.getSceneElements().find((e) => e.id === "kept").x;`);
	await inEditor(w, `bar.getElementById("reject").click();`);
	await settled();
	const unlinked = await inEditor<any>(w, `const all = x.api.getSceneElements(); const e = (id) => all.find((el) => el.id === id); const lists = (id) => (e(id).boundElements || []).map((b) => b.id); return { link: !!e("link"), keptX: e("kept").x, onKept: lists("kept"), onPlan: lists("box-plan") };`);
	log("aiAttachedArrowReverted", { ...unlinked, keptAt });
	expect(!unlinked.link && unlinked.keptX === keptAt, "Reject takes the arrow away and leaves the shape where the user moved it");
	expect(!unlinked.onKept.includes("link") && !unlinked.onPlan.includes("link") && unlinked.onPlan.includes("text-plan") && unlinked.onPlan.includes("arrow-1"), "the shapes no longer list the arrow, and still list what else is attached to them");
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "kept", backgroundColor: "#ffc9c9" }] });
	await until("the pending change", async () => (await review()).pending === "1 changed");
	await addElement(w, "by-hand", "rectangle", { x: 600, y: 600 });
	await pause(300);
	expect((await review()).pending === "1 changed", "what the user draws meanwhile is not a pending change");
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	const afterRevert = await inEditor<any>(w, `const e = (id) => x.api.getSceneElements().find((el) => el.id === id); return { byHand: !!e("by-hand"), kept: e("kept").backgroundColor };`);
	log("aiUndoAndOwnEdits", afterRevert);
	expect(afterRevert.byHand && afterRevert.kept === "transparent", "Agent → Revert AI Changes reverts the agent's change and leaves what the user drew");

	// ----- the agent changes a shape's words, the user moves the shape, Reject: the old words are back, in the shape where it is now -----
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "kept", label: "Renamed" }] });
	await until("the pending relabel", async () => (await review()).pending === "1 changed");
	// (as when the shape is dragged: it and its label move together)
	await inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => (e.id === "kept" || e.containerId === "kept" ? { ...e, x: e.x + 40, y: e.y + 260, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)), captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	await pause(300);
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	const relabelled = await inEditor<any>(w, `const all = x.api.getSceneElements(); const c = all.find((e) => e.id === "kept"), labels = all.filter((e) => e.containerId === "kept"), l = labels[0];
		return { labels: labels.length, text: l && l.text, shapeY: c.y, inside: !!l && l.x >= c.x && l.x + l.width <= c.x + c.width && l.y >= c.y && l.y + l.height <= c.y + c.height };`);
	log("aiRelabelReverted", relabelled);
	expect(relabelled.labels === 1 && relabelled.text === "Kept" && relabelled.inside, "the old words are back, inside the shape where the user moved it");

	// ----- a call whose request is stopped while it waits (for Mermaid, for fonts) changes nothing afterwards -----
	const countBeforeStop = (await elementIds(w)).length;
	const stopMermaid = new AbortController();
	const stoppedMermaid = (w as any).mcp.call("excalidraw_from_mermaid", { definition: "flowchart LR\n  S1[Stopped one] --> S2[Stopped two]" }, { signal: stopMermaid.signal });
	stopMermaid.abort();
	const stopApply = new AbortController();
	const stoppedApply = (w as any).mcp.call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "too-late", x: 0, y: 900, label: "Too late" }] }, { signal: stopApply.signal });
	stopApply.abort();
	const stoppedResults = [await stoppedMermaid, await stoppedApply];
	await pause(1500);
	log("aiStopped", { answers: stoppedResults.map((r: any) => r.text), elements: [countBeforeStop, (await elementIds(w)).length], pending: (await review()).pending });
	expect(stoppedResults.every((r: any) => r.isError && /Stopped/.test(r.text)), "a stopped call says so");
	expect((await elementIds(w)).length === countBeforeStop && !(await elementIds(w)).includes("too-late") && (await review()).pending === null, "and changes nothing after it was stopped");

	// ----- a freehand stroke is moved and restyled, not resized (it is its points) -----
	await inEditor(w, `const base = x.api.getSceneElements().find((e) => e.id === "by-hand");
		const stroke = { ...base, id: "scribble", type: "freedraw", x: 900, y: 600, width: 100, height: 50, points: [[0, 0], [60, 40], [100, 50]], pressures: [], simulatePressure: true, lastCommittedPoint: null, boundElements: null, index: null, version: 1, versionNonce: 77 };
		x.api.updateScene({ elements: [...x.api.getSceneElementsIncludingDeleted(), stroke], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	const stretched = await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "scribble", width: 200, height: 100 }] });
	const carried = await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "scribble", x: 950, strokeColor: "#1971c2" }] });
	const scribble = (await call("excalidraw_get_scene", { ids: ["scribble"], includeStyles: true })).data.elements[0];
	log("aiFreehand", { stretched: stretched.text, scribble });
	expect(stretched.isError && /freehand stroke cannot be resized/.test(stretched.text), "resizing a freehand stroke is refused, not half done");
	expect(!carried.isError && scribble.x === 950 && scribble.width === 100 && scribble.height === 50 && scribble.strokeColor === "#1971c2", "it is moved and restyled, the size its points give it");
	menuItem("Agent", "Keep AI Changes").click();
	await settled();

	// ----- a text that gets longer: the arrow attached to it leaves from where the text ends now -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "text", id: "short", x: 1000, y: 1500, text: "T" }, { op: "add", type: "rectangle", id: "target", x: 1600, y: 1470, width: 160, height: 80 }, { op: "add", type: "arrow", id: "from-text", start: "short", end: "target" }] });
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "short", text: "A much longer line of text" }] });
	const longer = await inEditor<any>(w, `const all = x.api.getSceneElements(); const t = all.find((e) => e.id === "short"), a = all.find((e) => e.id === "from-text"); return { textEnds: Math.round(t.x + t.width), arrowStarts: Math.round(a.x + a.points[0][0]), bound: a.startBinding.elementId };`);
	log("aiLongerText", longer);
	expect(longer.textEnds > 1150 && longer.arrowStarts >= longer.textEnds && longer.arrowStarts <= longer.textEnds + 12 && longer.bound === "short", "the arrow starts where the longer text ends, not inside it");

	// ----- a frame is moved with what is in it; an arrow from inside it to outside follows; deleted, it leaves its contents -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "framed", x: 1000, y: 1700, width: 160, height: 80, label: "Inside" }, { op: "add", type: "rectangle", id: "unframed", x: 1600, y: 1700, width: 160, height: 80 }, { op: "add", type: "arrow", id: "crossing", start: "framed", end: "unframed" }] });
	// (the frame itself is drawn by hand, around the first shape: the tools do not make frames)
	await inEditor(w, `const all = x.api.getSceneElementsIncludingDeleted(); const base = all.find((e) => e.id === "framed");
		const frame = { ...base, id: "frame-1", type: "frame", name: null, x: 960, y: 1660, width: 260, height: 170, backgroundColor: "transparent", boundElements: null, roundness: null, index: null, version: 1, versionNonce: 91 };
		x.api.updateScene({ elements: [...all.map((e) => (e.id === "framed" || e.containerId === "framed" ? { ...e, frameId: "frame-1", version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)), frame], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY });`);
	expect(!(await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "frame-1", y: 1960 }] })).isError, "a frame is moved");
	const framed = await inEditor<any>(w, `const all = x.api.getSceneElements(); const e = (id) => all.find((el) => el.id === id); const s = e("framed"), l = all.find((el) => el.containerId === "framed"), a = e("crossing"), f = e("frame-1");
		const start = [a.x + a.points[0][0], a.y + a.points[0][1]], end = [a.x + a.points[a.points.length - 1][0], a.y + a.points[a.points.length - 1][1]];
		return { frameY: f.y, shapeY: s.y, labelInside: l.y > s.y && l.y + l.height < s.y + s.height, inFrame: s.y > f.y && s.y + s.height < f.y + f.height, start: start.map(Math.round), end: end.map(Math.round), startAtShape: start[0] > s.x + s.width - 2 && start[0] < s.x + s.width + 14 && start[1] > s.y - 10 && start[1] < s.y + s.height + 10, endAtOther: Math.abs(end[0] - 1600) < 14 && end[1] > 1700 - 10 && end[1] < 1780 + 10, bound: [a.startBinding.elementId, a.endBinding.elementId] };`);
	log("aiFrameMoved", framed);
	expect(framed.frameY === 1960 && framed.shapeY === 2000 && framed.labelInside && framed.inFrame, "what is in the frame moved with it, label and all");
	expect(framed.startAtShape && framed.endAtOther && framed.bound[0] === "framed" && framed.bound[1] === "unframed", "the arrow from inside the frame to outside it runs between the two again");
	expect(!(await call("excalidraw_apply_operations", { operations: [{ op: "delete", id: "frame-1" }] })).isError, "a frame is deleted");
	const unframedNow = await inEditor<any>(w, `const all = x.api.getSceneElements(); return { frame: all.some((e) => e.id === "frame-1"), shape: all.some((e) => e.id === "framed"), stillInAFrame: all.filter((e) => e.frameId === "frame-1").length };`);
	expect(!unframedNow.frame && unframedNow.shape && unframedNow.stillInAFrame === 0, "its contents stay, in no frame");
	menuItem("Agent", "Keep AI Changes").click();
	await settled();

	// ----- a Mermaid flowchart becomes shapes -----
	const mermaid = await call("excalidraw_from_mermaid", { definition: "flowchart LR\n  A[Start] --> B{Ready?}\n  B -- yes --> C[Go]\n  B -- no --> A" });
	log("aiMermaid", mermaid.data ?? mermaid.text);
	expect(!mermaid.isError && mermaid.data.added >= 5 && mermaid.data.pendingReview.added >= 5, "a Mermaid flowchart is added as shapes and arrows, pending like any other change");
	expect((await call("excalidraw_from_mermaid", { definition: "this is not mermaid at all {" })).isError, "Mermaid that cannot be read is an error for the model, and changes nothing");
	menuItem("Agent", "Keep AI Changes").click();
	await settled();

	// ----- a call the editor does not answer in time is given up there too: it changes nothing afterwards -----
	const countBeforeTimeout = (await elementIds(w)).length;
	const usualTimeout = ExcalidrawWindow.toolTimeout;
	ExcalidrawWindow.toolTimeout = 1;
	const timedOut = await call("excalidraw_from_mermaid", { definition: "flowchart LR\n  L1[Too late one] --> L2[Too late two]" }).finally(() => (ExcalidrawWindow.toolTimeout = usualTimeout));
	await pause(1500);
	log("aiTimedOut", { answer: timedOut.text, elements: [countBeforeTimeout, (await elementIds(w)).length] });
	expect(timedOut.isError && /did not answer in time/.test(timedOut.text) && (await elementIds(w)).length === countBeforeTimeout, "a call that timed out does not change the drawing later");

	// ----- an arrow laid out again (its shape moved) keeps what its label was given of its own -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "styled-a", x: 1000, y: 1950, width: 160, height: 80 }, { op: "add", type: "rectangle", id: "styled-b", x: 1600, y: 1950, width: 160, height: 80 }, { op: "add", type: "arrow", id: "styled-link", start: "styled-a", end: "styled-b", label: "kept look", strokeColor: "#1971c2" }] });
	// (as when the user selects the label alone and gives it a colour, an alignment and an opacity)
	await inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => (e.containerId === "styled-link" ? { ...e, strokeColor: "#e03131", textAlign: "left", opacity: 60, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)) });`);
	await pause(300);
	const labelLook = `const all = x.api.getSceneElements(); const a = all.find((e) => e.id === "styled-link"), l = all.find((e) => e.containerId === "styled-link"); const last = a.points[a.points.length - 1];
		return { strokeColor: l.strokeColor, textAlign: l.textAlign, opacity: l.opacity, text: l.text, arrowColor: a.strokeColor, offMiddle: [Math.round(l.x + l.width / 2 - (a.x + last[0] / 2)), Math.round(l.y + l.height / 2 - (a.y + last[1] / 2))], endY: Math.round(a.y + last[1]) };`;
	const lookBefore = await inEditor<any>(w, labelLook);
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "styled-b", y: 2150 }] });
	const lookMoved = await inEditor<any>(w, labelLook);
	// (a colour given to the arrow itself is still its label's too, as in the editor)
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "styled-link", strokeColor: "#2f9e44" }] });
	const lookRecoloured = await inEditor<any>(w, labelLook);
	log("aiLabelLook", { lookBefore, lookMoved, lookRecoloured });
	expect(lookMoved.endY > lookBefore.endY + 100 && Math.abs(lookMoved.offMiddle[0]) <= 2 && Math.abs(lookMoved.offMiddle[1]) <= 2, "the arrow follows the shape, and its label is in its middle");
	expect(lookMoved.strokeColor === "#e03131" && lookMoved.textAlign === "left" && lookMoved.opacity === 60 && lookMoved.text === "kept look" && lookMoved.arrowColor === "#1971c2", "the label keeps the colour, alignment and opacity it was given of its own");
	expect(lookRecoloured.strokeColor === "#2f9e44" && lookRecoloured.arrowColor === "#2f9e44" && lookRecoloured.textAlign === "left", "a colour given to the arrow is its label's too");
	// the same for a shape's label: resizing the shape or changing its words lays the label out again, and leaves its look
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "styled-box", x: 1000, y: 2200, width: 200, height: 80, label: "Own look" }] });
	await inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => (e.containerId === "styled-box" ? { ...e, strokeColor: "#e03131", opacity: 60, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)) });`);
	await pause(300);
	const boxLook = `const all = x.api.getSceneElements(); const c = all.find((e) => e.id === "styled-box"), l = all.find((e) => e.containerId === "styled-box");
		return { strokeColor: l.strokeColor, opacity: l.opacity, text: l.text, fontSize: l.fontSize, boxOpacity: c.opacity, width: c.width, offMiddle: Math.round(l.x + l.width / 2 - (c.x + c.width / 2)) };`;
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "styled-box", width: 320 }] });
	const boxResized = await inEditor<any>(w, boxLook);
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "styled-box", label: "Other words", fontSize: 28 }] });
	const boxReworded = await inEditor<any>(w, boxLook);
	log("aiShapeLabelLook", { boxResized, boxReworded });
	expect(boxResized.width === 320 && boxResized.offMiddle === 0 && boxResized.strokeColor === "#e03131" && boxResized.opacity === 60 && boxResized.boxOpacity === 100, "a resized shape's label is in its middle again, with the colour and opacity it was given of its own");
	expect(boxReworded.text === "Other words" && boxReworded.fontSize === 28 && boxReworded.strokeColor === "#e03131" && boxReworded.opacity === 60, "new words and a new font size leave them too");
	menuItem("Agent", "Keep AI Changes").click();
	await settled();

	// ----- Reject puts an arrow and its shape back each on its own, and they still meet -----
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "rj-a", x: 1000, y: 2400, width: 160, height: 80 }, { op: "add", type: "rectangle", id: "rj-b", x: 1500, y: 2400, width: 160, height: 80 }, { op: "add", type: "arrow", id: "rj-link", start: "rj-a", end: "rj-b" }] });
	menuItem("Agent", "Keep AI Changes").click();
	await settled();
	const ends = `const all = x.api.getSceneElements(); const e = (id) => all.find((el) => el.id === id); const l = e("rj-link"), a = e("rj-a"), b = e("rj-b"); const last = l.points[l.points.length - 1];
		const off = (s, p) => Math.round(Math.hypot(Math.max(Math.abs(p[0] - (s.x + s.width / 2)) - s.width / 2, 0), Math.max(Math.abs(p[1] - (s.y + s.height / 2)) - s.height / 2, 0)));
		return { a: [a.x, a.y], b: [b.x, b.y], fill: a.backgroundColor, stroke: l.strokeColor, startOff: off(a, [l.x, l.y]), endOff: off(b, [l.x + last[0], l.y + last[1]]), bound: [l.startBinding && l.startBinding.elementId, l.endBinding && l.endBinding.elementId] };`;
	const drag = (shape: string, end: 0 | 1) =>
		inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => {
			if (e.id === ${JSON.stringify(shape)}) return { ...e, y: e.y + 300, version: e.version + 1, versionNonce: e.versionNonce + 1 };
			if (e.id !== "rj-link") return e;
			// (as the editor does when a shape is dragged: the arrow's end at it goes along, the other stays)
			const last = e.points[e.points.length - 1];
			return ${end === 0} ? { ...e, y: e.y + 300, points: [[0, 0], [last[0], last[1] - 300]], version: e.version + 1, versionNonce: e.versionNonce + 1 } : { ...e, points: [[0, 0], [last[0], last[1] + 300]], version: e.version + 1, versionNonce: e.versionNonce + 1 };
		}) });`);
	const meetsAtFirst = await inEditor<any>(w, ends);
	// the AI only restyles a shape; the user then drags it, and its arrow with it: the arrow is not the review's
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "rj-a", backgroundColor: "#ffec99" }] });
	await drag("rj-a", 0);
	await pause(300);
	const dragged = await inEditor<any>(w, ends);
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	const shapeBack = await inEditor<any>(w, ends);
	// the AI only restyles the arrow; the user then drags the shape it ends at: the shape is not the review's
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "rj-link", strokeColor: "#e03131" }] });
	await drag("rj-b", 1);
	await pause(300);
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	const arrowBack = await inEditor<any>(w, ends);
	// the same for a label: the AI only restyles its shape, the user drags the shape (the label goes along), Reject puts the shape back
	await call("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: "rj-c", x: 1000, y: 3200, width: 200, height: 80, label: "Stay inside" }] });
	menuItem("Agent", "Keep AI Changes").click();
	await settled();
	await call("excalidraw_apply_operations", { operations: [{ op: "update", id: "rj-c", backgroundColor: "#ffec99" }] });
	await inEditor(w, `x.api.updateScene({ elements: x.api.getSceneElementsIncludingDeleted().map((e) => (e.id === "rj-c" || e.containerId === "rj-c" ? { ...e, y: e.y + 300, ...(e.containerId ? { opacity: 60 } : {}), version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)) });`);
	await pause(300);
	menuItem("Agent", "Revert AI Changes").click();
	await settled();
	const labelBack = await inEditor<any>(w, `const all = x.api.getSceneElements(); const c = all.find((e) => e.id === "rj-c"), labels = all.filter((e) => e.containerId === "rj-c"), l = labels[0];
		return { labels: labels.length, text: l && l.text, opacity: l && l.opacity, shapeY: c.y, fill: c.backgroundColor, inside: !!l && l.x >= c.x && l.x + l.width <= c.x + c.width && l.y >= c.y && l.y + l.height <= c.y + c.height };`);
	log("aiRejectMeets", { meetsAtFirst, dragged, shapeBack, arrowBack, labelBack });
	expect(dragged.a[1] === 2700 && dragged.startOff <= 10, "the drag is as the editor leaves it: the shape lower, the arrow's start at it");
	expect(shapeBack.a[1] === 2400 && shapeBack.fill === meetsAtFirst.fill && shapeBack.startOff <= 10 && shapeBack.endOff <= 10 && shapeBack.bound.join() === "rj-a,rj-b", "a shape that is put back where it was has its arrow at it again");
	expect(arrowBack.b[1] === 2700 && arrowBack.stroke === meetsAtFirst.stroke && arrowBack.startOff <= 10 && arrowBack.endOff <= 10 && arrowBack.bound.join() === "rj-a,rj-b", "an arrow that is put back is at the shape the user moved since");
	expect(labelBack.shapeY === 3200 && labelBack.fill === "transparent" && labelBack.labels === 1 && labelBack.inside && labelBack.text === "Stay inside" && labelBack.opacity === 60, "a shape that is put back where it was has its label in it again, as the label is now");

	// ----- export: a file beside the drawing, never over one that is there unasked -----
	const exported = await call("excalidraw_export", { format: "png" });
	log("aiExport", exported.data ?? exported.text);
	expect(!exported.isError && exported.data.path === path.join(config.out, "ai.png") && readScene("png", fs.readFileSync(exported.data.path)).elements.length > 0, "the drawing is exported beside its file, with the drawing inside");
	const again = await call("excalidraw_export", { format: "png" });
	const itself = await call("excalidraw_export", { format: "excalidraw", path: "ai.excalidraw" });
	expect(again.isError && /exists/.test(again.text) && itself.isError && /replace the drawing itself/.test(itself.text), "an export does not replace a file unasked, nor the drawing itself");
	// a link under the export's name (as a folder someone else made could hold) is not written through
	const notes = path.join(config.out, "notes.txt");
	fs.writeFileSync(notes, "the user's own file");
	fs.symlinkSync(notes, path.join(config.out, "ai.svg"));
	const throughLink = await call("excalidraw_export", { format: "svg" });
	const throughLinkAsked = await call("excalidraw_export", { format: "svg", overwrite: true });
	log("aiExportThroughLink", { answer: throughLink.text, notes: fs.readFileSync(notes, "utf8") });
	expect(throughLink.isError && throughLinkAsked.isError && /is a link to another file/.test(throughLink.text) && /is a link to another file/.test(throughLinkAsked.text) && fs.readFileSync(notes, "utf8") === "the user's own file", "an export is not written through a link, asked to replace or not");
	const askedToReplace: string[] = [];
	const realBox = dialog.showMessageBox;
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		askedToReplace.push(`${options.message} (${options.detail})`);
		return { response: 1, checkboxChecked: false };
	};
	try {
		const declined = await call("excalidraw_export", { format: "png", overwrite: true });
		expect(declined.isError && askedToReplace.length === 1 && /chose not to replace/.test(declined.text), "with overwrite the user is asked, and No is an answer");
		// (asked about the file by name, and shown where it really is)
		expect(askedToReplace[0] === `Replace ai.png with a new export? (${path.join(fs.realpathSync(config.out), "ai.png")})`, `the question names the file and its real place: ${askedToReplace[0]}`);

		// A request that is stopped writes nothing afterwards: not a new file (stopped while the
		// editor hands the drawing over), and not over a file whose replacing was agreed to
		// (stopped while the question is open, and after it was answered Replace).
		const stoppedNew = new AbortController();
		const newFile = (w as any).mcp.call("excalidraw_export", { format: "png", path: "stopped.png" }, { signal: stoppedNew.signal });
		stoppedNew.abort();
		const before = fs.readFileSync(path.join(config.out, "ai.png"));
		const stoppedAsked = new AbortController();
		(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
			askedToReplace.push(`signal: ${!!options.signal}`);
			stoppedAsked.abort();
			return { response: 0, checkboxChecked: false };
		};
		const replaced = (w as any).mcp.call("excalidraw_export", { format: "png", overwrite: true }, { signal: stoppedAsked.signal });
		const stoppedExports = [await newFile, await replaced];
		await pause(800);
		log("aiExportStopped", { answers: stoppedExports.map((r: any) => r.text), asked: askedToReplace.slice(1), made: fs.existsSync(path.join(config.out, "stopped.png")) });
		expect(stoppedExports.every((r: any) => r.isError && /Stopped/.test(r.text)) && !fs.existsSync(path.join(config.out, "stopped.png")), "a stopped request does not make an export file");
		expect(askedToReplace[1] === "signal: true" && fs.readFileSync(path.join(config.out, "ai.png")).equals(before), "a request stopped after Replace was chosen leaves the file as it was, and the question goes away with the request");
	} finally {
		(dialog as any).showMessageBox = realBox;
	}

	// ----- the chat, answered through an API key (a stand-in for a provider): its tool calls ask first -----
	const { apiAccess } = await import("./api/catalog");
	const { STAND_IN_ID, STAND_IN_KEY } = await import("./api/standIn");
	expect((await apiAccess().saveKey(STAND_IN_ID, STAND_IN_KEY)) === undefined, "the stand-in's key is kept");
	const turn = (text: string) => {
		const done = new Promise<{ stop?: string; error?: string }>((resolve) => (w.chat.onTurnEnd = (stop, error) => resolve({ stop, error })));
		void w.chat.send(text);
		return done;
	};
	const asking = turn("Add a shape labelled 'From the chat'.");
	// (reading asks nothing; the change does, by the name the chat gives the tool)
	await until("the chat to ask before the drawing is changed", () => chat.executeJavaScript(`!!document.querySelector(".permission:not(.resolved):not(.auto) .options button")`));
	const card: string = await chat.executeJavaScript(`document.querySelector(".permission:not(.resolved):not(.auto)").textContent`);
	expect(/excalidraw_apply_operations/.test(card) && !(await elementIds(w)).includes("stand-in-1"), "the chat asks before a model changes the drawing");
	await until("the editor to say an agent is at work", async () => (await review()).working);
	await chat.executeJavaScript(`(() => { const b = Array.from(document.querySelectorAll(".permission:not(.resolved):not(.auto) .options button")).find((b) => /allow/i.test(b.textContent)); b.click(); })()`);
	const answered = await asking;
	const items = w.chat.items;
	log("aiChat", { ...answered, tools: items.filter((i) => i.kind === "tool").map((i: any) => `${i.status}: ${i.summary}`), reply: [...items].reverse().find((i) => i.kind === "assistant")?.text });
	expect(answered.stop === "end_turn" && (await elementIds(w)).includes("stand-in-1"), "the request is carried out through the drawing's tools");
	expect(items.some((i: any) => i.kind === "tool" && /Read 1\d? element|Read \d+ element/.test(i.summary)) && items.some((i: any) => i.kind === "tool" && i.summary === "Added 1"), "the chat shows what the tools did");
	await until("the chat's own change to be pending", async () => (await review()).pending === "1 added" && !(await review()).working);
	await shot(config, "window-chat", w);
	await chat.executeJavaScript(`document.getElementById("reviewAccept").click()`);
	await settled();

	// ----- an agent program over ACP (a stand-in for one), when the run is from source -----
	const fake = path.join(paths.appDir, "test/helpers/fake-acp-agent.js");
	if (fs.existsSync(fake)) {
		// (in the run's own settings file: "Claude Code" is the stand-in here, and no real agent is started)
		// It is started as the adapters are when they are not installed: through a program called
		// npx (here one that fetches nothing, and runs the stand-in). The drawing's folder is the
		// session's; the program itself is started in the app's own folder, where nothing that came
		// with the drawing (an .npmrc, a node_modules) is read by it.
		const viaNpx = process.platform !== "win32";
		const npxDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidraw-e2e-npx-"));
		const npx = path.join(npxDir, "npx");
		if (viaNpx) fs.writeFileSync(npx, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
		updateSettings({ agents: { claude: viaNpx ? { command: npx, args: [] } : { command: process.execPath, args: [fake], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
		const spec = launchSpec(agentDef("claude")) as LaunchSpec;
		expect(viaNpx ? spec.command === npx : spec.args?.[0] === fake, "the stand-in agent is the one that will be started");
		const own = path.join(fs.realpathSync(path.dirname(settingsPath())), "agent-start");
		const drawingFolder = fs.realpathSync(path.dirname(file));
		expect(!viaNpx || (spec.startIn === own && own !== drawingFolder && fs.readdirSync(own).length === 0), "a launch through npx is to start in the app's own folder, which is empty");
		await w.chat.onMessage({ type: "pickProvider", providerId: "claude" });
		w.chat.autoApprove = true;
		const steps = [{ tools: true }, { where: true }, { call: { name: "excalidraw_apply_operations", arguments: { operations: [{ op: "add", type: "text", id: "from-agent", x: 80, y: 520, text: "Drawn by an agent" }] } } }, { call: { name: "excalidraw_get_scene", arguments: { query: "agent" } } }];
		const done = await turn(`Do this. STEPS:${JSON.stringify(steps)}`);
		const reply = [...w.chat.items].reverse().find((i) => i.kind === "assistant")?.text ?? "";
		log("aiAgent", { ...done, reply: reply.slice(0, 400) });
		log("aiAgentPlace", { own, drawingFolder, said: /\[started in [^\]]*\] \[session in [^\]]*\]/.exec(reply)?.[0] });
		expect(reply.includes(`[session in ${w.cwd()}]`) && fs.realpathSync(w.cwd()) === drawingFolder, "the agent's session is in the drawing's folder");
		expect(!viaNpx || reply.includes(`[started in ${own}]`), "the program started through npx was not started in the drawing's folder");
		fs.rmSync(npxDir, { recursive: true, force: true });
		expect(done.stop === "end_turn" && /\[tools excalidraw_get_scene,excalidraw_apply_operations,/.test(reply) && /\[call ok:/.test(reply) && (await elementIds(w)).includes("from-agent"), "an agent over ACP is given the drawing's tools, and its call changes the drawing");
		// (what the agent was told with its first request: where it is, what is open and which tools to use)
		await until("the agent's change to be pending", async () => (await review()).pending === "1 added");
		menuItem("Agent", "Keep AI Changes").click();
		await settled();
	} else {
		log("aiAgent", "skipped: the stand-in agent is not in a packaged app");
	}

	// ----- saved, the drawing has what was kept and nothing of the review's bookkeeping -----
	expect(await w.save(), "the drawing is saved");
	const saved = JSON.parse(fs.readFileSync(file, "utf8"));
	log("aiSaved", { elements: saved.elements.length, ids: saved.elements.filter((e: any) => !e.containerId).map((e: any) => e.id).slice(0, 12) });
	expect(saved.elements.some((e: any) => e.id === "kept") && saved.elements.some((e: any) => e.id === "stand-in-1") && saved.elements.every((e: any) => !e.isDeleted) && !/"index":null/.test(JSON.stringify(saved)), "what was kept is in the file, as Excalidraw writes it");
	expect(Menu.getApplicationMenu()!.items.some((i) => i.label === "Agent"), "the Agent menu is the drawing's chat's");
	w.win.close();
	await closed(w);
}
