import { app } from "electron";
import { settings, updateSettings, type Settings } from "../settings";
import { ApiAccess, type ApiAccessEnv, type ModelSettings } from "./access";
import { apiKeys } from "./keys";
import { API_PROVIDERS } from "./providers";
import { standInAccess } from "./standIn";

let access: ApiAccess | undefined;

/**
 * The app's access to the providers' APIs (see access.ts): keys from the app's key store, and
 * the models each key can use kept where the agents' models are (settings.json, `modelCatalog`
 * and `models`, under "api:<provider>").
 */
export function apiAccess(): ApiAccess {
	if (access) return access;
	const env: Pick<ApiAccessEnv, "providers" | "settings" | "update"> = {
		providers: API_PROVIDERS,
		settings: () => settings() as unknown as ModelSettings,
		update: (patch) => updateSettings(patch as Partial<Settings>),
	};
	// (the end-to-end run of the chat: a provider that is none, and no keychain; see standIn.ts)
	if (process.env.DRAWAI_E2E && process.env.DRAWAI_E2E_API) return (access = standInAccess(env, app.getPath("userData")));
	return (access = new ApiAccess({ ...env, keys: apiKeys() }));
}
