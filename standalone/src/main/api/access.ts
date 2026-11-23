import { ApiError, type ApiModel, type ApiProvider, type ApiProviderId } from "./chat";
import { cleanKey, type KeyStore } from "./keyStore";

/**
 * The part of the app's settings that API models are kept in, beside the agents' models: the
 * models a provider listed when it was last asked (`modelCatalog`), and which of them are
 * hidden or were picked last (`models`), under "api:<provider>". Names of models only: a key
 * is never written there.
 */
export interface ModelSettings {
	models: Record<string, { hidden?: string[]; preferred?: string } | undefined>;
	modelCatalog: Record<string, { value: string; name: string; description?: string; images?: false }[] | undefined>;
}

export interface ApiAccessEnv {
	providers: ApiProvider[];
	keys: KeyStore;
	settings(): ModelSettings;
	update(patch: Partial<ModelSettings>): void;
	/** Another address for a provider's API (tests). */
	baseURL?(id: ApiProviderId): string | undefined;
	/** How long a provider may take to list its models (tests shorten it). */
	listMs?: number;
}

/** The name an API provider goes by where agents are listed ("api:anthropic"). */
export const apiAgentId = (id: ApiProviderId) => `api:${id}`;

/**
 * The user's access to the providers' APIs: which keys are kept, which models each key can
 * use, and the steps that touch a key (keeping one, removing one, asking a provider with one).
 * (No Electron here: catalog.ts gives it the app's key store and settings.)
 */
export class ApiAccess {
	/** Providers that did not accept the kept key when it was last used (until it is replaced, removed, or accepted again). */
	private rejected = new Set<ApiProviderId>();
	private watchers = new Set<() => void>();

	constructor(private readonly env: ApiAccessEnv) {}

	public get providers(): ApiProvider[] {
		return this.env.providers;
	}

	public provider(id: unknown): ApiProvider | undefined {
		return this.env.providers.find((p) => p.id === id);
	}

	/** The provider an entry of an agent list stands for ("api:openai"), if it is one. */
	public providerOfAgent(agent: unknown): ApiProvider | undefined {
		return typeof agent === "string" && agent.startsWith("api:") ? this.provider(agent.slice(4)) : undefined;
	}

	public baseURL(id: ApiProviderId): string | undefined {
		return this.env.baseURL?.(id);
	}

	/** Whether a key is kept for a provider (the keychain is not asked). */
	public hasKey(id: ApiProviderId): boolean {
		return this.env.keys.has(id);
	}

	/** The provider did not accept the kept key when it was last used. */
	public wasRejected(id: ApiProviderId): boolean {
		return this.rejected.has(id) && this.env.keys.has(id);
	}

	/** A request with the kept key came back as "not accepted" (or, with `false`, was accepted). */
	public noteRejected(id: ApiProviderId, rejected = true): void {
		if (this.rejected.has(id) === rejected) return;
		if (rejected) this.rejected.add(id);
		else this.rejected.delete(id);
		for (const w of this.watchers) w();
	}

	/** `listener` is called when a kept key is found to be no longer accepted, or accepted again. */
	public onRejected(listener: () => void): () => void {
		this.watchers.add(listener);
		return () => this.watchers.delete(listener);
	}

	/** `listener` is told which provider's key was kept, replaced or removed. */
	public onKeyChange(listener: (id: string) => void): () => void {
		return this.env.keys.onChange(listener);
	}

	/** The kept key of a provider, or what to tell the user when there is none to use. (This asks the keychain.) */
	public async keyFor(provider: ApiProvider): Promise<{ key: string } | { problem: string }> {
		const key = await this.env.keys.get(provider.id);
		if (key) return { key };
		return {
			problem: this.env.keys.has(provider.id)
				? `The saved ${provider.company} API key could not be read back from the system keychain. Remove it in Settings → Agents & models → API keys and add it again.`
				: `There is no ${provider.company} API key. Add one in Settings → Agents & models → API keys.`,
		};
	}

	/** How many models a provider listed for the kept key, the hidden ones included. */
	public listed(id: ApiProviderId): number {
		return (this.env.settings().modelCatalog[apiAgentId(id)] ?? []).length;
	}

	/** The models to offer for a provider: what it listed, without the ones hidden in Settings. */
	public models(id: ApiProviderId): ApiModel[] {
		const hidden = this.env.settings().models[apiAgentId(id)]?.hidden ?? [];
		return (this.env.settings().modelCatalog[apiAgentId(id)] ?? []).filter((m) => !hidden.includes(m.value)).map((m) => ({ value: m.value, name: m.name, ...(m.images === false ? { images: false as const } : {}) }));
	}

	/** The model picked last for a provider, while it is still offered. */
	public preferred(id: ApiProviderId): string | undefined {
		const value = this.env.settings().models[apiAgentId(id)]?.preferred;
		return value && this.models(id).some((m) => m.value === value) ? value : undefined;
	}

	/** Remembers the model picked last for a provider: the next request starts with it. */
	public prefer(id: ApiProviderId, value: string): void {
		const models = this.env.settings().models;
		if (models[apiAgentId(id)]?.preferred === value) return;
		this.env.update({ models: { ...models, [apiAgentId(id)]: { ...models[apiAgentId(id)], preferred: value } } });
	}

	private remember(id: ApiProviderId, models: ApiModel[]): void {
		const catalog = { ...this.env.settings().modelCatalog };
		if (models.length) catalog[apiAgentId(id)] = models.slice(0, 500).map((m) => ({ value: m.value, name: m.name, ...(m.images === false ? { images: false as const } : {}) }));
		else if (apiAgentId(id) in catalog) delete catalog[apiAgentId(id)];
		else return;
		this.env.update({ modelCatalog: catalog });
	}

	/**
	 * Asks a provider which models the kept key (or `key`, one that is being checked before it
	 * is kept) can use, and remembers them. Returns what went wrong, if anything; `badKey` says
	 * the provider did not accept the key itself.
	 */
	public async load(id: ApiProviderId, key?: string): Promise<{ problem: string; badKey: boolean } | undefined> {
		const provider = this.provider(id);
		if (!provider) return { problem: "That provider is not known here.", badKey: false };
		const kept = key ? { key } : await this.keyFor(provider);
		if ("problem" in kept) return { problem: kept.problem, badKey: false };
		const late = AbortSignal.timeout(this.env.listMs ?? 30_000);
		let models: ApiModel[] | undefined;
		let failed: { problem: string; badKey: boolean } | undefined;
		try {
			models = await provider.models(kept.key, { baseURL: this.baseURL(id), signal: late });
		} catch (e: any) {
			failed = late.aborted ? { problem: `${provider.company} did not answer in time. Try again.`, badKey: false } : { problem: String(e?.message ?? e).split("\n")[0].slice(0, 400), badKey: e instanceof ApiError && e.badKey };
		}
		// (the kept key was removed or replaced while the provider was asked: this answer is about a key that is gone)
		if (!key && (await this.env.keys.get(id)) !== kept.key) return undefined;
		if (failed) {
			if (!key && failed.badKey) this.noteRejected(id);
			return failed;
		}
		if (!key) this.noteRejected(id, false);
		if (!models?.length) return { problem: `${provider.company} listed no models for this key.`, badKey: false };
		this.remember(id, models);
		return undefined;
	}

	/**
	 * Keeps a key the user typed. The provider is asked for its models with it first: a key it
	 * does not accept is not kept. Anything else that goes wrong while asking (no connection, a
	 * limit) is said, and the key is kept: it can be tried again with Refresh. Returns what to
	 * tell the user, if anything.
	 */
	public async saveKey(id: ApiProviderId, typed: unknown): Promise<string | undefined> {
		const provider = this.provider(id);
		if (!provider) return "That provider is not known here.";
		const key = cleanKey(typed);
		if (!key) return "That does not look like an API key: paste the whole key, with nothing before or after it.";
		// (the keychain is asked here, when a key is to be kept, and not before)
		if (!(await this.env.keys.available())) return "This computer cannot keep the key safely right now (the system keychain is not available), so it was not saved.";
		const failed = await this.load(id, key);
		if (failed?.badKey) return failed.problem;
		try {
			await this.env.keys.set(id, key);
		} catch (e: any) {
			return String(e?.message ?? e).split("\n")[0];
		}
		this.noteRejected(id, false);
		return failed?.problem;
	}

	/** Forgets a provider's key, and the models it could use. */
	public removeKey(id: ApiProviderId): void {
		this.env.keys.remove(id);
		this.noteRejected(id, false);
		this.remember(id, []);
	}
}
