import * as fs from "fs";
import * as path from "path";

/**
 * Where API keys are kept: encrypted by the system, in a file of the app's own.
 *
 * A key is never written as it is. `Cipher` encrypts it with a secret the operating system
 * holds for this app (Electron's safeStorage: the macOS Keychain, Windows' DPAPI), and only
 * the encrypted bytes go into the file. Nothing here reads a key from the environment, logs
 * one, or puts one in settings.json.
 *
 * (No Electron in this file: keys.ts gives it the cipher and the folder.)
 */
export interface Cipher {
	/** Whether the system can encrypt for this app right now (a Keychain is there and unlocked). */
	available(): Promise<boolean>;
	encrypt(text: string): Promise<Buffer>;
	/** `stale`: the system's secret has changed since this was encrypted; encrypting it again keeps it readable. */
	decrypt(bytes: Buffer): Promise<{ text: string; stale?: boolean }>;
}

/** A key as a provider issues one: one line, no spaces, of a plausible length. */
export function cleanKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	return key.length >= 16 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
}

export class KeyStore {
	private listeners = new Set<(id: string) => void>();

	constructor(private readonly file: string, private readonly cipher: Cipher) {}

	/**
	 * The encrypted keys in the file. `state`: there is no file yet ("none"), it is one this
	 * store wrote ("ours"), it is something else ("foreign"), or it cannot be read ("unreadable").
	 */
	private read(): { keys: Record<string, string>; state: "none" | "ours" | "foreign" | "unreadable" } {
		let text: string;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch (e: any) {
			return { keys: {}, state: e?.code === "ENOENT" ? "none" : "unreadable" };
		}
		try {
			const data = JSON.parse(text);
			if (!data || typeof data !== "object" || !data.keys || typeof data.keys !== "object" || Array.isArray(data.keys)) return { keys: {}, state: "foreign" };
			return { keys: Object.fromEntries(Object.entries(data.keys).filter(([, v]) => typeof v === "string")) as Record<string, string>, state: "ours" };
		} catch {
			return { keys: {}, state: "foreign" };
		}
	}

	private write(keys: Record<string, string>, state: "none" | "ours" | "foreign" | "unreadable", changed?: string): void {
		// (a file that cannot be read may hold keys: it is not written over)
		if (state === "unreadable") throw new Error("The file the keys are kept in cannot be read, so nothing was changed. Check who may read api-keys.json in the app's data folder.");
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		// (one that is not this store's is set aside first, for the same reason)
		if (state === "foreign") {
			fs.copyFileSync(this.file, `${this.file}.unreadable`);
			fs.chmodSync(`${this.file}.unreadable`, 0o600);
		}
		// written whole and flushed, then moved into place; readable by this user only
		const tmp = `${this.file}.${process.pid}.tmp`;
		const fd = fs.openSync(tmp, "w", 0o600);
		try {
			fs.writeSync(fd, JSON.stringify({ version: 1, keys }, null, "\t"));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, this.file);
		if (changed === undefined) return;
		for (const l of this.listeners) {
			try {
				l(changed);
			} catch {
				// (the key is kept whatever a listener makes of it)
			}
		}
	}

	/** Whether keys can be kept safely on this computer. (This asks the system's keychain.) */
	public async available(): Promise<boolean> {
		try {
			return await this.cipher.available();
		} catch {
			return false;
		}
	}

	/** Whether a key is kept for `id` (without decrypting it, or asking the keychain). */
	public has(id: string): boolean {
		return typeof this.read().keys[id] === "string";
	}

	/** The key for `id`, or undefined when there is none or it can no longer be decrypted. */
	public async get(id: string): Promise<string | undefined> {
		// (the keychain can take its time, a prompt for one: the key that counts is the one kept when it has answered)
		for (let tries = 0; tries < 3; tries++) {
			const stored = this.read().keys[id];
			if (!stored || !(await this.available())) return undefined;
			let opened: { text: string; stale?: boolean };
			try {
				opened = await this.cipher.decrypt(Buffer.from(stored, "base64"));
			} catch {
				return undefined;
			}
			const now = this.read();
			if (now.keys[id] !== stored) continue;
			const key = cleanKey(opened.text);
			if (key && opened.stale) {
				// (encrypted again with the system's new secret, in place: nothing changed for anyone. If that
				// cannot be done now, the key is still the key, and it is tried again the next time it is read.)
				let again: string | undefined;
				try {
					again = (await this.cipher.encrypt(key)).toString("base64");
				} catch {
					// not this time
				}
				// (that took time too: a key removed or replaced meanwhile is not the one to hand out)
				const then = this.read();
				if (then.keys[id] !== stored) continue;
				if (again) {
					try {
						this.write({ ...then.keys, [id]: again }, then.state);
					} catch {
						// not this time
					}
				}
			}
			return key;
		}
		return undefined;
	}

	/** Keeps `key` for `id`. Throws what to tell the user when it cannot. */
	public async set(id: string, key: unknown): Promise<void> {
		const clean = cleanKey(key);
		if (!clean) throw new Error("That does not look like an API key: paste the whole key, with nothing before or after it.");
		if (!(await this.available())) throw new Error("This computer cannot keep the key safely right now (the system keychain is not available), so it was not saved.");
		const encrypted = (await this.cipher.encrypt(clean)).toString("base64");
		// (read and written in one go: two keys saved at the same moment are both kept)
		const now = this.read();
		this.write({ ...now.keys, [id]: encrypted }, now.state, id);
	}

	public remove(id: string): void {
		const now = this.read();
		if (!(id in now.keys)) return;
		delete now.keys[id];
		this.write(now.keys, now.state, id);
	}

	/** `listener` is told which key was kept, replaced or removed. */
	public onChange(listener: (id: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
