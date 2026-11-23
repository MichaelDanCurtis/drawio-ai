import * as path from "path";
import { ApiAccess, type ApiAccessEnv } from "./access";
import { ApiError, type ApiChat, type ApiChatOptions, type ApiProvider, type ApiProviderId } from "./chat";
import { KeyStore } from "./keyStore";

/**
 * A stand-in for the end-to-end run of the chat (DRAWAI_E2E_API): a provider that is none.
 * Nothing is sent anywhere, and the system keychain is not asked. Its "model" is a script that
 * answers a request the way a model would, through the tools it is offered: it reads the
 * diagram, adds a shape with the label the request names, and says what it did.
 */
export const STAND_IN_ID = "stand-in" as ApiProviderId;
/** (made up: nothing a provider issued) */
export const STAND_IN_KEY = "stand-in-key-0000-not-a-real-one";

function chat(o: ApiChatOptions): ApiChat {
	let held = 0;
	return {
		blank: () => held === 0,
		send: async (text, _images, signal) => {
			o.onText("Reading the diagram. ");
			const read = await o.callTool("drawio_get_diagram", {});
			if (signal.aborted) return "cancelled";
			const label = /labelled '([^']+)'/.exec(text)?.[1] ?? "Hello from the API";
			const made = await o.callTool("drawio_apply_operations", { ops: [{ op: "addShape", label, x: 40, y: 40 + held * 80, width: 180, height: 60 }] });
			if (signal.aborted) return "cancelled";
			held++;
			o.onText(read.isError ? `I could not read it: ${read.text}` : made.isError ? `I left the shape out: ${made.text}` : `Added a shape labelled '${label}' with ${o.model} (request ${held} of this conversation).`);
			return "end_turn";
		},
	};
}

export const standInProvider: ApiProvider = {
	id: STAND_IN_ID,
	label: "Stand-in API",
	company: "Stand-in",
	keyHint: "stand-in-…",
	models: async (apiKey) => {
		if (apiKey !== STAND_IN_KEY) throw new ApiError("Stand-in did not accept the API key.", true);
		return [
			{ value: "stand-in-large", name: "Stand-in Large" },
			{ value: "stand-in-small", name: "Stand-in Small" },
		];
	},
	chat,
};

/**
 * The app's API access for that run: the stand-in listed after the real providers (which have
 * no key in it), and keys kept in `dir` behind a cipher of its own instead of the keychain's.
 */
export function standInAccess(env: Pick<ApiAccessEnv, "providers" | "settings" | "update">, dir: string): ApiAccess {
	const flip = (bytes: Buffer) => Buffer.from(bytes.map((b) => b ^ 0x5a));
	const keys = new KeyStore(path.join(dir, "api-keys.json"), {
		available: async () => true,
		encrypt: async (text) => flip(Buffer.from(text, "utf8")),
		decrypt: async (bytes) => ({ text: flip(bytes).toString("utf8") }),
	});
	return new ApiAccess({ ...env, providers: [...env.providers, standInProvider], keys });
}
