/**
 * The providers' SDKs take defaults from the environment: another address for the API
 * (ANTHROPIC_BASE_URL, OPENAI_BASE_URL), extra headers that can replace the key
 * (ANTHROPIC_CUSTOM_HEADERS, OPENAI_CUSTOM_HEADERS), an organisation, a log level. Nothing
 * about the app's API access comes from there: the key is the one the user saved, and it goes
 * to the provider's own address. So a client is made with those variables out of sight (they
 * are back before anything else runs), and with every such option given in code as well.
 */
export function withoutProviderEnv<T>(make: () => T): T {
	const hidden: [string, string][] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || !/^(ANTHROPIC|OPENAI)_/i.test(name)) continue;
		hidden.push([name, value]);
		delete process.env[name];
	}
	try {
		return make();
	} finally {
		for (const [name, value] of hidden) process.env[name] = value;
	}
}
