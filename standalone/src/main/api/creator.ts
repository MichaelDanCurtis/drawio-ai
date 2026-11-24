import { CREATOR_TOOLS, type CreatorAgent, type CreatorSession, type CreatorTools } from "../workshop/creator";
import { apiAgentId, type ApiAccess } from "./access";
import { ApiError, type ApiProvider } from "./chat";

/**
 * The Shape Creator drawing through a provider's API instead of an agent program: a chat with
 * the model that has the Creator's two tools and nothing else. There is no process, folder or
 * endpoint here: the tools are called in the app, and the only thing sent to the provider is
 * the request, the images attached to it, and what the tools answer.
 */
const SYSTEM = "You draw icons as SVG for a diagramming app. You have two tools: one shows you a picture of an SVG, one hands a finished icon in. Follow the request's rules for the SVG exactly.";

export function openApiCreatorSession(o: {
	provider: ApiProvider;
	apiKey: string;
	model: string;
	modelName?: string;
	/** false: the model takes no pictures (it gets the description only, and is not shown its drawing). */
	images?: boolean;
	tools: CreatorTools;
	onText(text: string): void;
	/** The provider did not accept the key. */
	onBadKey?(): void;
	baseURL?: string;
}): CreatorSession {
	let stop: AbortController | undefined;
	let closed = false;
	const chat = o.provider.chat({
		apiKey: o.apiKey,
		model: o.model,
		baseURL: o.baseURL,
		images: o.images !== false,
		system: SYSTEM,
		tools: CREATOR_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })),
		callTool: (name, args) => o.tools.call(name, args),
		onText: (text) => {
			if (!closed) o.onText(text);
		},
	});
	return {
		label: `${o.provider.label} · ${o.modelName ?? o.model}`,
		images: o.images !== false,
		// (a request that was stopped or failed is forgotten whole: after one, the next has to say everything again)
		fresh: () => chat.blank(),
		prompt: async (text, images) => {
			if (closed) return "cancelled";
			const mine = (stop = new AbortController());
			try {
				return await chat.send(text, images, mine.signal);
			} catch (e) {
				if (e instanceof ApiError && e.badKey) o.onBadKey?.();
				throw e;
			} finally {
				if (stop === mine) stop = undefined;
			}
		},
		cancel: () => stop?.abort(),
		dispose: () => {
			closed = true;
			stop?.abort();
		},
	};
}

/** The providers as the Creator lists them beside the agents: ready when a key is kept. (The keychain is not asked.) */
export function apiCreatorAgents(access: ApiAccess): CreatorAgent[] {
	return access.providers.map((p): CreatorAgent => {
		const has = access.hasKey(p.id);
		const models = has ? access.models(p.id).map((m) => ({ value: m.value, name: m.name })) : [];
		return {
			id: apiAgentId(p.id),
			kind: "api",
			label: p.label,
			ready: has,
			...(has ? {} : { problem: `Add your ${p.company} API key in Settings → Agents & models → API keys to use it.` }),
			models,
			...(models.length ? { model: access.preferred(p.id) ?? models[0].value } : {}),
		};
	});
}

/**
 * Opens a provider's model for drawing, when `agent` stands for a provider ("api:openai");
 * undefined when it does not. The model is the one asked for, else the one picked last, else
 * the first the provider listed.
 */
export async function openApiCreator(access: ApiAccess, o: { agent: string; model?: string; tools: CreatorTools; onText(text: string): void }): Promise<CreatorSession | undefined> {
	const provider = access.providerOfAgent(o.agent);
	if (!provider) return undefined;
	if (!access.hasKey(provider.id)) throw new Error(`There is no ${provider.company} API key. Add one in Settings → Agents & models → API keys.`);
	// (a key that was kept before its models could be listed: ask now; and once more when the key
	// was replaced while the provider was asked, which drops that answer)
	let failed: Awaited<ReturnType<ApiAccess["load"]>>;
	for (let tries = 0; tries < 2 && !failed && !access.listed(provider.id); tries++) failed = await access.load(provider.id);
	const known = access.models(provider.id);
	if (!known.length && access.listed(provider.id)) throw new Error(`Every ${provider.company} model is switched off in Settings → Agents & models → API keys. Switch one on to use it.`);
	const preferred = access.preferred(provider.id);
	const chosen = (o.model && known.find((m) => m.value === o.model)) || known.find((m) => m.value === preferred) || known[0];
	if (!chosen) throw new Error(failed?.problem ?? `${provider.company} listed no models for this key.`);
	// (the key is read last: it is the one kept now, also when it was replaced while the provider was asked)
	const kept = await access.keyFor(provider);
	if ("problem" in kept) throw new Error(kept.problem);
	if (o.model && chosen.value === o.model) access.prefer(provider.id, chosen.value);
	return openApiCreatorSession({
		provider,
		apiKey: kept.key,
		model: chosen.value,
		modelName: chosen.name,
		images: chosen.images !== false,
		tools: o.tools,
		onText: o.onText,
		onBadKey: () => access.noteRejected(provider.id),
		baseURL: access.baseURL(provider.id),
	});
}
