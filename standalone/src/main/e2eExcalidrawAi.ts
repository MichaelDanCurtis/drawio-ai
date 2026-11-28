// End-to-end check of the AI tools for an Excalidraw drawing (part of `yarn e2e --excalidraw`):
// the window's endpoint as an agent reaches it, each tool against the real editor, the review
// of what was changed (outlines, Reject, Accept, undo, the user's own edits), and the chat
// answered by a stand-in: a provider's API that is none (api/standIn.ts), and, when the run is
// from source, an agent program that is none (test/helpers/fake-acp-agent.js) over ACP.
// No real agent is started, no key is used and nothing is sent anywhere.
import { dialog, Menu, type WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { E2eConfig } from "./e2e";
import { addElement, closed, elementIds, expect, inEditor, menuItem, pause, shot, until } from "./e2eExcalidraw";
import { readScene } from "./excalidrawFile";
import { ExcalidrawWindow } from "./excalidrawWindow";
import { paths } from "./paths";
import { agentDef, launchSpec } from "./agents";
import { updateSettings } from "./settings";
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

	// ----- a Mermaid flowchart becomes shapes -----
	const mermaid = await call("excalidraw_from_mermaid", { definition: "flowchart LR\n  A[Start] --> B{Ready?}\n  B -- yes --> C[Go]\n  B -- no --> A" });
	log("aiMermaid", mermaid.data ?? mermaid.text);
	expect(!mermaid.isError && mermaid.data.added >= 5 && mermaid.data.pendingReview.added >= 5, "a Mermaid flowchart is added as shapes and arrows, pending like any other change");
	expect((await call("excalidraw_from_mermaid", { definition: "this is not mermaid at all {" })).isError, "Mermaid that cannot be read is an error for the model, and changes nothing");
	menuItem("Agent", "Keep AI Changes").click();
	await settled();

	// ----- export: a file beside the drawing, never over one that is there unasked -----
	const exported = await call("excalidraw_export", { format: "png" });
	log("aiExport", exported.data ?? exported.text);
	expect(!exported.isError && exported.data.path === path.join(config.out, "ai.png") && readScene("png", fs.readFileSync(exported.data.path)).elements.length > 0, "the drawing is exported beside its file, with the drawing inside");
	const again = await call("excalidraw_export", { format: "png" });
	const itself = await call("excalidraw_export", { format: "excalidraw", path: "ai.excalidraw" });
	expect(again.isError && /exists/.test(again.text) && itself.isError && /replace the drawing itself/.test(itself.text), "an export does not replace a file unasked, nor the drawing itself");
	const askedToReplace: string[] = [];
	const realBox = dialog.showMessageBox;
	(dialog as any).showMessageBox = async (_win: unknown, options: Electron.MessageBoxOptions) => {
		askedToReplace.push(String(options.message));
		return { response: 1, checkboxChecked: false };
	};
	try {
		const declined = await call("excalidraw_export", { format: "png", overwrite: true });
		expect(declined.isError && askedToReplace.length === 1 && /chose not to replace/.test(declined.text), "with overwrite the user is asked, and No is an answer");
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
		updateSettings({ agents: { claude: { command: process.execPath, args: [fake], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
		expect(launchSpec(agentDef("claude")) && (launchSpec(agentDef("claude")) as any).args?.[0] === fake, "the stand-in agent is the one that will be started");
		await w.chat.onMessage({ type: "pickProvider", providerId: "claude" });
		w.chat.autoApprove = true;
		const steps = [{ tools: true }, { call: { name: "excalidraw_apply_operations", arguments: { operations: [{ op: "add", type: "text", id: "from-agent", x: 80, y: 520, text: "Drawn by an agent" }] } } }, { call: { name: "excalidraw_get_scene", arguments: { query: "agent" } } }];
		const done = await turn(`Do this. STEPS:${JSON.stringify(steps)}`);
		const reply = [...w.chat.items].reverse().find((i) => i.kind === "assistant")?.text ?? "";
		log("aiAgent", { ...done, reply: reply.slice(0, 400) });
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
