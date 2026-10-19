import * as vscode from "vscode";
import type { ImageData } from "../providers/types";
import {
	describeTemplate,
	diagramPages,
	draftRules,
	extractDocumentText,
	extractProfile,
	LoadedTemplate,
	SourceKind,
	TemplateEnforce,
	TemplateManifest,
} from "./profile";

export const TEMPLATES_DIR = ".drawio-ai/templates";
const MANIFEST = "template.json";
const RULES = "rules.md";
/** Raw size whose base64 stays under the providers' 5 MB per-image limit. */
const MAX_IMAGE_BYTES = 3_600_000;

export interface CreateTemplateArgs {
	name?: string;
	/** File system paths of the sources. */
	sources?: string[];
	enforce?: Partial<TemplateEnforce>;
	/** "ai" drafts the rules with the selected model; "extracted" uses the profile only. */
	rules?: "ai" | "extracted";
	/** Where to create `.drawio-ai/templates` (defaults to the diagram's workspace folder). */
	root?: string;
	/** Skip opening rules.md (tests). */
	silent?: boolean;
}

export type RuleDrafter = (prompt: string, images: ImageData[]) => Promise<string>;

/** Repo-scoped design templates in `.drawio-ai/templates/<id>/`. */
export class TemplateService {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.onDidChangeEmitter.event;
	private readonly fs = vscode.workspace.fs;

	public dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	/** Nearest `.drawio-ai/templates` above the diagram, within its workspace folder. */
	public async templatesDir(diagram: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
		const candidates: vscode.Uri[] = [];
		if (diagram) {
			const stop = vscode.workspace.getWorkspaceFolder(diagram)?.uri;
			let dir = vscode.Uri.joinPath(diagram, "..");
			for (let i = 0; i < 30; i++) {
				candidates.push(vscode.Uri.joinPath(dir, TEMPLATES_DIR));
				if (stop && dir.toString() === stop.toString()) break;
				const parent = vscode.Uri.joinPath(dir, "..");
				if (parent.toString() === dir.toString()) break;
				dir = parent;
			}
		}
		for (const f of vscode.workspace.workspaceFolders ?? []) candidates.push(vscode.Uri.joinPath(f.uri, TEMPLATES_DIR));
		for (const c of candidates) {
			if (await this.exists(c)) return c;
		}
		return undefined;
	}

	public async list(diagram: vscode.Uri | undefined): Promise<LoadedTemplate[]> {
		const dir = await this.templatesDir(diagram);
		if (!dir) return [];
		const entries = await this.fs.readDirectory(dir).then(
			(e) => e,
			() => [] as [string, vscode.FileType][]
		);
		const out: LoadedTemplate[] = [];
		for (const [id, type] of entries) {
			if (type !== vscode.FileType.Directory) continue;
			const t = await this.load(vscode.Uri.joinPath(dir, id));
			if (t) out.push(t);
		}
		return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
	}

	public async load(folder: vscode.Uri): Promise<LoadedTemplate | undefined> {
		try {
			const manifest = JSON.parse(await this.readText(vscode.Uri.joinPath(folder, MANIFEST))) as TemplateManifest;
			const rules = await this.readText(vscode.Uri.joinPath(folder, RULES)).catch(() => "");
			return { id: folder.path.split("/").pop()!, location: folder.toString(), manifest, rules };
		} catch {
			return undefined;
		}
	}

	/** Setting `drawio-ai.template` (id, or "none"); when unset, the repo's only template. */
	public async active(diagram: vscode.Uri | undefined): Promise<LoadedTemplate | undefined> {
		const setting = vscode.workspace.getConfiguration("drawio-ai", diagram).get<string>("template", "").trim();
		if (setting.toLowerCase() === "none") return undefined;
		const all = await this.list(diagram);
		if (setting) return all.find((t) => t.id === setting || t.manifest.name === setting);
		return all.length === 1 ? all[0] : undefined;
	}

	public async promptSection(diagram: vscode.Uri | undefined): Promise<string | undefined> {
		const t = await this.active(diagram);
		return t ? describeTemplate(t) : undefined;
	}

	public async select(diagram: vscode.Uri | undefined): Promise<void> {
		const all = await this.list(diagram);
		const current = await this.active(diagram);
		type Item = vscode.QuickPickItem & { id?: string; create?: boolean };
		const items: Item[] = [
			...all.map((t) => ({
				label: t.manifest.name,
				description: t.id === current?.id ? "active" : undefined,
				detail: t.manifest.description,
				id: t.id,
			})),
			{ label: "None", description: "Don't apply a template", id: "none" },
			{ label: "$(add) Create Template…", create: true },
		];
		const pick = await vscode.window.showQuickPick(items, { title: "Draw.AI design template" });
		if (!pick) return;
		if (pick.create) {
			await vscode.commands.executeCommand("drawio-ai.createTemplate");
			return;
		}
		await this.setActive(diagram, pick.id!);
	}

	public async setActive(diagram: vscode.Uri | undefined, id: string): Promise<void> {
		const config = vscode.workspace.getConfiguration("drawio-ai", diagram);
		const folder = diagram && vscode.workspace.getWorkspaceFolder(diagram);
		const target = folder
			? vscode.ConfigurationTarget.WorkspaceFolder
			: vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await config.update("template", id, target);
		this.onDidChangeEmitter.fire();
	}

	public async create(diagram: vscode.Uri | undefined, args: CreateTemplateArgs, draft?: RuleDrafter): Promise<LoadedTemplate | undefined> {
		const name =
			args.name ??
			(await vscode.window.showInputBox({
				title: "New design template (1/4): name",
				prompt: "e.g. the team, product or style this template stands for",
				value: "Team Standard",
				ignoreFocusOut: true,
			}));
		if (!name?.trim()) return undefined;

		let sources = args.sources?.map((p) => vscode.Uri.file(p));
		if (!sources) {
			sources =
				(await vscode.window.showOpenDialog({
					title: "New design template (2/4): sources — example diagrams, shape libraries, style guides, images (optional)",
					canSelectMany: true,
					openLabel: "Use as template sources",
					defaultUri: diagram ? vscode.Uri.joinPath(diagram, "..") : undefined,
					filters: {
						"Template sources": ["drawio", "dio", "svg", "xml", "md", "markdown", "txt", "pdf", "docx", "png", "jpg", "jpeg", "webp", "gif"],
					},
				})) ?? [];
		}

		let enforce: TemplateEnforce = { palette: true, fonts: true, edges: true, title: false, legend: false, ...args.enforce };
		if (!args.enforce) {
			const options: { key: keyof TemplateEnforce; label: string; detail: string }[] = [
				{ key: "palette", label: "Colour palette", detail: "Flag fill/stroke/font colours that are not in the template" },
				{ key: "fonts", label: "Fonts", detail: "Flag font families the template doesn't use" },
				{ key: "edges", label: "Connector style", detail: "Flag connectors that don't match the template's routing/arrows" },
				{ key: "title", label: "Title required", detail: "Every diagram needs a title" },
				{ key: "legend", label: "Legend required", detail: "Every diagram needs a legend" },
			];
			const picked = await vscode.window.showQuickPick(
				options.map((o) => ({ ...o, picked: enforce[o.key] })),
				{ title: "New design template (3/4): what should be enforced?", canPickMany: true, ignoreFocusOut: true }
			);
			if (!picked) return undefined;
			enforce = { palette: false, fonts: false, edges: false, title: false, legend: false };
			for (const p of picked) enforce[p.key] = true;
		}

		const existing = await this.templatesDir(diagram);
		const root = args.root ? vscode.Uri.file(args.root) : this.defaultRoot(diagram);
		const dir = args.root || !existing ? root && vscode.Uri.joinPath(root, TEMPLATES_DIR) : existing;
		if (!dir) throw new Error("Open a folder or a diagram first: templates are stored in the repository.");

		// Everything is read and every question asked before anything is written, so cancelling leaves no trace.
		const copies: { file: string; data: Uint8Array }[] = [];
		const diagrams: string[] = [];
		const libraries: string[] = [];
		const guides: { file: string; text: string }[] = [];
		const images: { file: string; image: ImageData }[] = [];
		const manifestSources: TemplateManifest["sources"] = [];
		const warnings: string[] = [];

		for (const src of sources) {
			const base = src.path.split("/").pop()!;
			let file = base;
			for (let i = 2; copies.some((c) => c.file === file); i++) file = base.replace(/(\.[^.]*)?$/, `-${i}$1`);
			const data = await this.fs.readFile(src);
			copies.push({ file, data });
			const kind = classify(file, data);
			if (!kind) {
				warnings.push(`${file}: unsupported source, ignored.`);
				continue;
			}
			let note: string | undefined;
			if (kind === "diagram") diagrams.push(Buffer.from(data).toString("utf8"));
			else if (kind === "library") libraries.push(Buffer.from(data).toString("utf8"));
			else if (kind === "guide") {
				const { text, warning } = extractDocumentText(file, data);
				if (warning) warnings.push(warning);
				if (text) guides.push({ file, text });
				else note = "no text extracted";
			} else if (data.byteLength <= MAX_IMAGE_BYTES) {
				images.push({ file, image: { mimeType: imageMime(file), base64: Buffer.from(data).toString("base64") } });
			} else {
				warnings.push(`${file}: image larger than 3.5 MB, not analysed.`);
			}
			manifestSources.push({ file: `sources/${file}`, kind, note });
		}

		const profile = extractProfile({ diagrams, libraries });
		let ruleMode = args.rules;
		if (!ruleMode && draft && (guides.length > 0 || images.length > 0)) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: "Draft rules with AI", description: "recommended", detail: "Reads your style guides and images with the selected model", mode: "ai" as const },
					{ label: "Use extracted rules only", detail: "Palette, fonts, shapes and connectors from your diagrams/libraries; style guide text is appended for you to edit", mode: "extracted" as const },
				],
				{ title: "New design template (4/4): rules", ignoreFocusOut: true }
			);
			if (!pick) return undefined;
			ruleMode = pick.mode;
		}

		let extra: string[] = [];
		if (ruleMode === "ai" && draft) {
			try {
				const drafted = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Drafting rules for "${name}"…` },
					() => draft(draftPrompt(name, profile, guides), images.slice(0, 4).map((i) => i.image))
				);
				extra = ["", "## Drafted from your sources", "", drafted.trim()];
			} catch (e: any) {
				warnings.push(`AI drafting failed (${e?.message ?? e}); style guide text was appended instead.`);
				ruleMode = "extracted";
			}
		}
		if (ruleMode !== "ai") {
			for (const g of guides) {
				extra.push("", `## From ${g.file}`, "", g.text.length > 6000 ? g.text.slice(0, 6000) + "\n…" : g.text);
			}
			for (const i of images) {
				extra.push("", `<!-- Reference image: sources/${i.file}. Describe what to take from it (colours, layout, icons). -->`);
			}
		}

		const manifest: TemplateManifest = {
			version: 1,
			name: name.trim(),
			sources: manifestSources,
			enforce,
			profile,
			createdAt: new Date().toISOString(),
		};
		let id = slug(name);
		for (let i = 2; await this.exists(vscode.Uri.joinPath(dir, id)); i++) id = `${slug(name)}-${i}`;
		const folder = vscode.Uri.joinPath(dir, id);
		try {
			await this.fs.createDirectory(vscode.Uri.joinPath(folder, "sources"));
			for (const c of copies) await this.fs.writeFile(vscode.Uri.joinPath(folder, "sources", c.file), c.data);
			await this.writeText(vscode.Uri.joinPath(folder, RULES), draftRules(manifest.name, profile, enforce, extra));
			await this.writeText(vscode.Uri.joinPath(folder, MANIFEST), JSON.stringify(manifest, null, "\t") + "\n");
		} catch (e) {
			await this.fs.delete(folder, { recursive: true, useTrash: false }).then(undefined, () => undefined);
			throw e;
		}
		await this.setActive(diagram, id);

		if (!args.silent) {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, RULES));
			await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
			void vscode.window.showInformationMessage(
				`Template "${manifest.name}" created and active. Review rules.md — the AI follows these rules and flags violations.` +
					(warnings.length ? ` Notes: ${warnings.join(" ")}` : "")
			);
		}
		const loaded = await this.load(folder);
		this.onDidChangeEmitter.fire();
		return loaded;
	}

	private defaultRoot(diagram: vscode.Uri | undefined): vscode.Uri | undefined {
		const folder = (diagram && vscode.workspace.getWorkspaceFolder(diagram)) ?? vscode.workspace.workspaceFolders?.[0];
		return folder?.uri ?? (diagram ? vscode.Uri.joinPath(diagram, "..") : undefined);
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		return this.fs.stat(uri).then(
			() => true,
			() => false
		);
	}

	private async readText(uri: vscode.Uri): Promise<string> {
		return Buffer.from(await this.fs.readFile(uri)).toString("utf8");
	}

	private async writeText(uri: vscode.Uri, text: string): Promise<void> {
		await this.fs.writeFile(uri, Buffer.from(text, "utf8"));
	}
}

export function classify(file: string, data: Uint8Array): SourceKind | undefined {
	const lower = file.toLowerCase();
	if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
	if (/\.(md|markdown|txt|pdf|docx)$/.test(lower)) return "guide";
	if (/\.(drawio|dio|svg|xml)$/.test(lower)) {
		const head = Buffer.from(data.subarray(0, 4096)).toString("utf8");
		if (/<mxlibrary>/.test(head)) return "library";
		const text = Buffer.from(data).toString("utf8");
		if (diagramPages(text).length > 0) return "diagram";
	}
	return undefined;
}

function imageMime(file: string): ImageData["mimeType"] {
	const ext = file.toLowerCase().split(".").pop();
	return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
}

export function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "template"
	);
}

function draftPrompt(name: string, profile: ReturnType<typeof extractProfile>, guides: { file: string; text: string }[]): string {
	return [
		`Write the diagram standards for a design template called "${name}" as a concise Markdown bullet list (no headings, no preamble).`,
		"Cover only what the sources support: colour meanings (with hex codes), fonts and sizes, which shape to use for which kind of thing, connector style, layout direction and spacing, titles/legends, naming and labelling conventions.",
		"Each bullet must be a concrete, checkable rule a diagram designer can follow.",
		"",
		"Style profile extracted from the template's example diagrams/libraries:",
		JSON.stringify({ ...profile, library: profile.library.slice(0, 30) }),
		...guides.map((g) => `\n<style-guide file="${g.file}">\n${g.text.slice(0, 20000)}\n</style-guide>`),
		"Any attached images are reference examples of the desired look.",
	].join("\n");
}
