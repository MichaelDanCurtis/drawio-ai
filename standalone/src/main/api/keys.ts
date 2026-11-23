import { app, safeStorage } from "electron";
import * as path from "path";
import { KeyStore } from "./keyStore";

let store: KeyStore | undefined;

/**
 * The app's API keys (see keyStore.ts): encrypted with Electron's safeStorage, whose secret is
 * in the macOS Keychain (DPAPI on Windows), and kept in `api-keys.json` in the app's data folder.
 * (The asynchronous calls: a Keychain prompt does not hold the whole app up.)
 */
export function apiKeys(): KeyStore {
	return (store ??= new KeyStore(path.join(app.getPath("userData"), "api-keys.json"), {
		// (on Linux without a password manager safeStorage falls back to a fixed password: that is not keeping a key safely)
		available: async () => (await safeStorage.isAsyncEncryptionAvailable()) && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
		encrypt: (text) => safeStorage.encryptStringAsync(text),
		decrypt: async (bytes) => {
			const r = await safeStorage.decryptStringAsync(bytes);
			return { text: r.result, stale: r.shouldReEncrypt };
		},
	}));
}
