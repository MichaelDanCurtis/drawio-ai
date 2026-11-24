import { apiAgentId, type ApiAccess } from "./access";
import type { ApiProviderId, ApiTool } from "./chat";
import { testKey } from "./keyTest";

/** What the Settings page shows of one provider: whether a key is kept, never the key. */
export interface ApiKeyRow {
	id: ApiProviderId;
	/** The name its models go by in the settings ("api:openai"). */
	agent: string;
	label: string;
	company: string;
	keyHint: string;
	hasKey: boolean;
	/** The provider is being asked (a key is being checked, or its models listed again). */
	loadingModels: boolean;
	/** The provider did not accept the kept key when it was last used. */
	rejected: boolean;
	error?: string;
	/** A test request is under way; what the last one found (gone when the key changes). */
	testing: boolean;
	tested?: string;
}

/**
 * The Settings page's other half for API keys: what it shows of each provider, and what it
 * may ask for (keep a key, remove it, list its models again). `changed` is called when what
 * the page shows has changed. (No Electron here: settingsWindow.ts owns the window.)
 */
export class ApiKeysPanel {
	private busy = new Set<ApiProviderId>();
	private errors = new Map<ApiProviderId, string>();
	private testing = new Set<ApiProviderId>();
	private tested = new Map<ApiProviderId, string>();

	/** `tools`: what the chat offers a model, for a test request to be shaped as the chat's are. */
	constructor(private readonly access: () => ApiAccess, private readonly changed: () => void, private readonly tools: () => ApiTool[] = () => []) {}

	public rows(): ApiKeyRow[] {
		const access = this.access();
		return access.providers.map((p) => ({
			id: p.id,
			agent: apiAgentId(p.id),
			label: p.label,
			company: p.company,
			keyHint: p.keyHint,
			hasKey: access.hasKey(p.id),
			loadingModels: this.busy.has(p.id),
			rejected: access.wasRejected(p.id),
			...(this.errors.has(p.id) ? { error: this.errors.get(p.id) } : {}),
			testing: this.testing.has(p.id),
			...(this.tested.has(p.id) && access.hasKey(p.id) ? { tested: this.tested.get(p.id) } : {}),
		}));
	}

	/** Something that asks a provider: the page shows that it is under way, and what went wrong. */
	private async asking(id: ApiProviderId, work: () => Promise<string | undefined>): Promise<void> {
		// (one at a time for a provider: a second request while the first is under way is dropped)
		if (this.busy.has(id)) return;
		this.busy.add(id);
		this.errors.delete(id);
		this.tested.delete(id);
		this.changed();
		let problem: string | undefined;
		try {
			problem = await work();
		} catch (e: any) {
			problem = String(e?.message ?? e).split("\n")[0];
		}
		this.busy.delete(id);
		if (problem) this.errors.set(id, problem);
		this.changed();
	}

	/**
	 * Handles a message of the page if it is about API keys: undefined when it is not, else a
	 * promise that ends when the work has.
	 */
	public onMessage(msg: any): Promise<void> | undefined {
		if (!["setApiKey", "removeApiKey", "refreshApiModels", "testApiKey"].includes(msg?.type)) return undefined;
		const access = this.access();
		const provider = access.provider(msg.provider);
		if (!provider) return Promise.resolve();
		switch (msg.type) {
			case "setApiKey":
				return this.asking(provider.id, () => access.saveKey(provider.id, msg.key));
			case "refreshApiModels":
				return access.hasKey(provider.id) ? this.asking(provider.id, async () => (await access.load(provider.id))?.problem) : Promise.resolve();
			case "testApiKey":
				// (only ever on the user's click: it spends a little of their credit)
				if (!access.hasKey(provider.id)) return Promise.resolve();
				return this.asking(provider.id, async () => {
					this.testing.add(provider.id);
					this.changed();
					try {
						const r = await testKey(access, provider.id, this.tools());
						if (r.ok) this.tested.set(provider.id, r.said);
						return r.ok ? undefined : r.problem;
					} finally {
						this.testing.delete(provider.id);
					}
				});
			default:
				// (a key that is being checked is not kept yet: there is nothing to remove until it is)
				if (this.busy.has(provider.id)) return Promise.resolve();
				access.removeKey(provider.id);
				this.errors.delete(provider.id);
				this.tested.delete(provider.id);
				this.changed();
				return Promise.resolve();
		}
	}
}
