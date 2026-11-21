// The parts of the `vscode` API that the shared Draw.AI modules (../src/features/ai/*)
// touch at runtime in the standalone app. Everything VS Code-specific they could
// reach is wired around (confirm dialogs are injected, no workspace tools), so
// this only has to answer settings lookups and empty tab queries.
import { settings } from "./settings";

export const workspace = {
	getConfiguration(section?: string) {
		return {
			get<T>(key: string, defaultValue?: T): T {
				const full = section ? `${section}.${key}` : key;
				const v = (settings().editor as Record<string, unknown>)[full];
				return (v === undefined ? defaultValue : v) as T;
			},
		};
	},
	workspaceFolders: undefined,
};

export const window = {
	tabGroups: { all: [] as { tabs: unknown[] }[] },
	async showWarningMessage(): Promise<undefined> {
		return undefined;
	},
	async showInformationMessage(): Promise<undefined> {
		return undefined;
	},
	async showErrorMessage(): Promise<undefined> {
		return undefined;
	},
};

export class Uri {
	private constructor(public readonly scheme: string, public readonly path: string) {}
	static file(p: string): Uri {
		return new Uri("file", p);
	}
	static parse(s: string): Uri {
		const u = new URL(s);
		return new Uri(u.protocol.replace(/:$/, ""), decodeURIComponent(u.pathname));
	}
	get fsPath(): string {
		return this.path;
	}
	toString(): string {
		return `${this.scheme}://${encodeURI(this.path)}`;
	}
}

export const extensions = { all: [], getExtension: () => undefined };
export const commands = { executeCommand: async () => undefined };

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3,
}
