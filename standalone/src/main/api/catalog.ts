import { settings, updateSettings, type Settings } from "../settings";
import { ApiAccess, type ModelSettings } from "./access";
import { apiKeys } from "./keys";
import { API_PROVIDERS } from "./providers";

let access: ApiAccess | undefined;

/**
 * The app's access to the providers' APIs (see access.ts): keys from the app's key store, and
 * the models each key can use kept where the agents' models are (settings.json, `modelCatalog`
 * and `models`, under "api:<provider>").
 */
export function apiAccess(): ApiAccess {
	return (access ??= new ApiAccess({
		providers: API_PROVIDERS,
		keys: apiKeys(),
		settings: () => settings() as unknown as ModelSettings,
		update: (patch) => updateSettings(patch as Partial<Settings>),
	}));
}
