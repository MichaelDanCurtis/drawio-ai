import * as vscode from "vscode";
import type { DrawioEditor } from "../../DrawioEditorService";
import { getAiSettings } from "./aiSettings";
import {
	badgeKind,
	checkLink,
	CodeLink,
	fingerprintData,
	LinkCheck,
	LINK_PREFIX,
	parseLink,
	PROBLEM_STATUSES,
	splitLines,
} from "./codeLinks";

export interface LinkedCell {
	cellId: string;
	label: string;
	link: CodeLink;
	uri?: vscode.Uri;
	check: LinkCheck;
}

const BADGE_GROUP = "codeLinks";
const MAX_SNIPPET_LINES = 80;

export type AskAi = (editor: DrawioEditor, prompt: string, attachments: { name: string; text: string }[]) => Promise<void>;

/**
 * Keeps code-linked shapes honest: checks each link against the current code,
 * shows badges on stale shapes and re-checks when linked files are saved.
 */
export class CodeLinkService {
	private readonly results = new Map<DrawioEditor, LinkedCell[]>();
	private readonly timers = new Map<DrawioEditor, ReturnType<typeof setTimeout>>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly editors: () => Iterable<DrawioEditor>, private readonly askAi: AskAi) {
		const recheckAll = () => {
			for (const e of this.editors()) this.schedule(e);
		};
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				for (const e of this.editors()) {
					if (doc.uri.toString() === e.uri.toString()) continue;
					const linked = this.results.get(e);
					if (!linked || linked.some((l) => l.uri?.toString() === doc.uri.toString())) this.schedule(e);
				}
			}),
			vscode.workspace.onDidCreateFiles(recheckAll),
			vscode.workspace.onDidDeleteFiles(recheckAll),
			vscode.workspace.onDidRenameFiles(recheckAll),
			vscode.workspace.onDidChangeTextDocument((e) => {
				for (const editor of this.editors()) {
					if (editor.document.kind === "text" && e.document === editor.document.document) this.schedule(editor, 1500);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("drawio-ai.checkCodeLinks")) recheckAll();
			})
		);
	}

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.timers.forEach((t) => clearTimeout(t));
	}

	public hook(editor: DrawioEditor): vscode.Disposable {
		const subs = [
			editor.drawioClient.onCustomPluginLoaded.sub(({ pluginId }) => pluginId === "ai" && this.schedule(editor, 300)),
			editor.drawioClient.onAiBadgeClick.sub(({ group, cellId }) => {
				const item = group === BADGE_GROUP ? this.results.get(editor)?.find((l) => l.cellId === cellId) : undefined;
				if (item) void this.fixMenu(editor, item);
			}),
		];
		if (editor.drawioClient.isAiPluginLoaded) this.schedule(editor, 300);
		return {
			dispose: () => {
				subs.forEach((s) => s.dispose());
				clearTimeout(this.timers.get(editor)!);
				this.timers.delete(editor);
				this.results.delete(editor);
			},
		};
	}

	public schedule(editor: DrawioEditor, delayMs = 800): void {
		clearTimeout(this.timers.get(editor)!);
		this.timers.set(
			editor,
			setTimeout(() => {
				this.timers.delete(editor);
				this.check(editor).catch(() => undefined);
			}, delayMs)
		);
	}

	public async check(editor: DrawioEditor): Promise<LinkedCell[]> {
		const model = await editor.drawioClient.aiGetModel({ scope: "page", includeStyles: false, maxCells: 20000 });
		const texts = new Map<string, Promise<string | undefined>>();
		const read = (uri: vscode.Uri) => {
			const key = uri.toString();
			if (!texts.has(key)) texts.set(key, readText(uri));
			return texts.get(key)!;
		};
		const out: LinkedCell[] = [];
		for (const c of model.cells) {
			const link = parseLink(c.data);
			if (!link) continue;
			const uri = link.path ? resolveLinkPath(editor.uri, link.path) : undefined;
			let check: LinkCheck;
			if (uri) {
				const text = await read(uri);
				check = checkLink(link, text);
				if (check.status === "unverified" && link.symbol && text !== undefined) check = await checkSymbol(uri, link.symbol);
			} else {
				check = { status: "unverified", message: `Linked to workspace symbol ${link.symbol}.` };
			}
			out.push({ cellId: c.id, label: c.label, link, uri, check });
		}
		this.results.set(editor, out);
		const enabled = getAiSettings().checkCodeLinks;
		editor.drawioClient.aiSetBadges(
			BADGE_GROUP,
			enabled
				? out
						.filter((l) => badgeKind(l.check.status))
						.map((l) => ({ cellId: l.cellId, kind: badgeKind(l.check.status)!, tooltip: `Code link: ${l.check.message}\nClick for options.` }))
				: []
		);
		return out;
	}

	/** JSON report for the `drawio_code_links` tool, with the current code of changed links. */
	public async report(editor: DrawioEditor, ids?: string[]): Promise<{ text: string; summary: string }> {
		const all = await this.check(editor);
		const shown = ids?.length ? all.filter((l) => ids.includes(l.cellId)) : all;
		const items = await Promise.all(
			shown.map(async (l) => ({
				id: l.cellId,
				label: l.label,
				target: l.link.path ? `${l.link.path}${l.link.start ? `:${l.link.start.line + 1}-${(l.link.end?.line ?? l.link.start.line) + 1}` : ""}` : `symbol ${l.link.symbol}`,
				status: l.check.status,
				message: l.check.message,
				currentCode: l.check.status === "changed" || l.check.status === "moved" ? await this.snippet(l) : undefined,
			}))
		);
		const problems = items.filter((i) => PROBLEM_STATUSES.has(i.status));
		return {
			text: JSON.stringify({
				linked: items.length,
				problems: problems.length,
				links: items,
				hint: problems.length
					? "After updating shapes to match changed code, call drawio_code_links with refresh=[ids] so the links point at the current code again. For missing code, ask the user before deleting shapes."
					: undefined,
			}),
			summary: problems.length ? `${problems.length} stale code link${problems.length === 1 ? "" : "s"}` : `${items.length} code link${items.length === 1 ? "" : "s"} up to date`,
		};
	}

	/** Points the given cells' links at where their code is now and re-fingerprints it. */
	public async refresh(editor: DrawioEditor, ids: string[]): Promise<{ updated: string[]; skipped: string[] }> {
		const all = this.results.get(editor) ?? (await this.check(editor));
		const updated: string[] = [];
		const skipped: string[] = [];
		const ops: AiOp[] = [];
		for (const id of ids) {
			const l = all.find((x) => x.cellId === id);
			const range = l?.check.newRange ?? (l?.check.status === "ok" ? l.link.start && l.link.end && { start: l.link.start, end: l.link.end } : undefined);
			const text = l?.uri && range ? await readText(l.uri) : undefined;
			if (!l || !range || text === undefined) {
				skipped.push(id);
				continue;
			}
			const lines = splitLines(text);
			ops.push({
				op: "update",
				id,
				data: {
					[`${LINK_PREFIX}start_line_x-num`]: String(range.start.line),
					[`${LINK_PREFIX}start_col_x-num`]: "0",
					[`${LINK_PREFIX}end_line_x-num`]: String(range.end.line),
					[`${LINK_PREFIX}end_col_x-num`]: String(lines[range.end.line]?.length ?? 0),
					...fingerprintData(lines, range.start.line, range.end.line),
				},
			});
			updated.push(id);
		}
		if (ops.length) {
			// Link metadata is not something the user needs to review.
			await editor.drawioClient.aiApplyOps(ops, { atomic: false, selectResult: false, flash: false, review: false });
			await this.check(editor);
		}
		return { updated, skipped };
	}

	private async removeLink(editor: DrawioEditor, item: LinkedCell): Promise<void> {
		const model = await editor.drawioClient.aiGetModel({ scope: "page", includeStyles: false, maxCells: 20000 });
		const data = model.cells.find((c) => c.id === item.cellId)?.data ?? {};
		const cleared = Object.fromEntries(Object.keys(data).filter((k) => k.startsWith(LINK_PREFIX)).map((k) => [k, null]));
		await editor.drawioClient.aiApplyOps([{ op: "update", id: item.cellId, data: cleared }], { atomic: true, selectResult: false, flash: false, review: false });
		await this.check(editor);
	}

	private async snippet(l: LinkedCell): Promise<string | undefined> {
		const range = l.check.newRange;
		const text = l.uri && range ? await readText(l.uri) : undefined;
		if (!range || text === undefined) return undefined;
		const lines = splitLines(text).slice(range.start.line, Math.min(range.end.line, range.start.line + MAX_SNIPPET_LINES - 1) + 1);
		return lines.join("\n") + (range.end.line - range.start.line >= MAX_SNIPPET_LINES ? "\n…" : "");
	}

	private async open(l: LinkedCell): Promise<void> {
		if (!l.uri) return;
		const range = l.check.newRange ?? (l.link.start && l.link.end ? { start: l.link.start, end: l.link.end } : undefined);
		const doc = await vscode.workspace.openTextDocument(l.uri);
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			preserveFocus: false,
			selection: range ? new vscode.Range(range.start.line, 0, range.end.line, range.end.col) : undefined,
		});
	}

	private async askAiToUpdate(editor: DrawioEditor, items: LinkedCell[]): Promise<void> {
		const attachments: { name: string; text: string }[] = [];
		for (const l of items) {
			const code = await this.snippet(l);
			attachments.push({
				name: `current code for shape ${l.cellId}${l.label ? ` "${l.label.slice(0, 40)}"` : ""}`,
				text: `${l.check.message}\n${code ?? "(code not found)"}`,
			});
		}
		await this.askAi(
			editor,
			`The code behind ${items.length === 1 ? "this shape" : `these ${items.length} shapes`} (ids: ${items.map((l) => l.cellId).join(", ")}) changed. Update each shape (label, members/columns/details and connections) to match the current code that is attached. Keep its position and style. Then call drawio_code_links with refresh set to the ids you updated so their links point at the current code. For code that no longer exists, tell me instead of deleting shapes.`,
			attachments
		);
	}

	private async fixMenu(editor: DrawioEditor, item: LinkedCell): Promise<void> {
		type Action = vscode.QuickPickItem & { run: () => Promise<unknown> };
		const actions: Action[] = [];
		const s = item.check.status;
		if (item.check.newRange && (s === "moved" || s === "changed")) {
			actions.push({
				label: s === "moved" ? `$(arrow-right) Update the link to line ${item.check.newRange.start.line + 1}` : "$(check) Keep the shape as is and accept the code change",
				run: () => this.refresh(editor, [item.cellId]),
			});
		}
		if (s === "changed" || s === "missing-code") {
			actions.push({ label: "$(sparkle) Ask AI to update the shape from the code", run: () => this.askAiToUpdate(editor, [item]) });
		}
		if (item.uri && s !== "missing-file") actions.push({ label: "$(go-to-file) Open the linked code", run: () => this.open(item) });
		actions.push({ label: "$(trash) Remove the code link", run: () => this.removeLink(editor, item) });
		const pick = await vscode.window.showQuickPick(actions, {
			title: `${item.label ? `"${item.label.slice(0, 50)}"` : `Shape ${item.cellId}`}: ${item.check.message}`,
		});
		await pick?.run();
	}

	/** `Draw.AI: Check Code Links` */
	public async checkCommand(editor: DrawioEditor | undefined): Promise<LinkedCell[] | undefined> {
		if (!editor) {
			void vscode.window.showInformationMessage("Open a draw.io diagram to check its code links.");
			return undefined;
		}
		const all = await this.check(editor);
		const problems = all.filter((l) => PROBLEM_STATUSES.has(l.check.status));
		if (all.length === 0) {
			void vscode.window.showInformationMessage("This page has no code-linked shapes. Use Diagram from Code… or the Link Code commands to create some.");
			return all;
		}
		if (problems.length === 0) {
			void vscode.window.showInformationMessage(`All ${all.length} code link${all.length === 1 ? " is" : "s are"} up to date.`);
			return all;
		}
		type Item = vscode.QuickPickItem & { run: () => Promise<unknown> };
		const icon = (l: LinkedCell) => (badgeKind(l.check.status) === "error" ? "$(error)" : badgeKind(l.check.status) === "warning" ? "$(warning)" : "$(info)");
		const moved = problems.filter((l) => l.check.status === "moved");
		const changed = problems.filter((l) => l.check.status === "changed");
		const items: Item[] = [
			...(moved.length > 1 ? [{ label: `$(arrow-right) Update all ${moved.length} moved links`, run: () => this.refresh(editor, moved.map((l) => l.cellId)) }] : []),
			...(changed.length > 1 ? [{ label: `$(sparkle) Ask AI to update all ${changed.length} changed shapes`, run: () => this.askAiToUpdate(editor, changed) }] : []),
			...problems.map((l) => ({
				label: `${icon(l)} ${l.label || l.cellId}`,
				description: l.link.path,
				detail: l.check.message,
				cellId: l.cellId,
				run: () => this.fixMenu(editor, l),
			})),
		];
		const qp = vscode.window.createQuickPick<Item & { cellId?: string }>();
		qp.title = `${problems.length} of ${all.length} code links need attention`;
		qp.items = items;
		qp.onDidChangeActive((a) => a[0]?.cellId && void editor.drawioClient.aiSetSelection([a[0].cellId], true).catch(() => undefined));
		const pick = await new Promise<Item | undefined>((resolve) => {
			qp.onDidAccept(() => {
				resolve(qp.selectedItems[0]);
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		});
		qp.dispose();
		await pick?.run();
		return all;
	}
}

/** Same resolution as the Code Link feature: relative to the diagram file itself. */
export function resolveLinkPath(diagram: vscode.Uri, linkPath: string): vscode.Uri {
	const parts = `${diagram.path}/${linkPath}`.split("/");
	const out: string[] = [];
	for (const p of parts) {
		if (p === "..") out.pop();
		else if (p && p !== ".") out.push(p);
	}
	return diagram.with({ path: "/" + out.join("/") });
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) return open.getText();
	try {
		return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
	} catch {
		return undefined;
	}
}

async function checkSymbol(uri: vscode.Uri, symbolPath: string): Promise<LinkCheck> {
	const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri).then(
		(s) => s,
		() => undefined
	)) as vscode.DocumentSymbol[] | undefined;
	if (!symbols?.length) return { status: "unverified", message: `Linked to symbol ${symbolPath} (no symbol information available yet).` };
	const find = (list: vscode.DocumentSymbol[], parts: string[]): vscode.DocumentSymbol | undefined => {
		const s = list.find((x) => x.name === parts[0]);
		return s && (parts.length === 1 ? s : find(s.children ?? [], parts.slice(1)));
	};
	return find(symbols, symbolPath.split("."))
		? { status: "ok", message: `Linked to symbol ${symbolPath}.` }
		: { status: "missing-code", message: `Symbol ${symbolPath} no longer exists in ${uri.path.split("/").pop()}.` };
}
