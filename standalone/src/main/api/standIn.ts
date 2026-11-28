import * as path from "path";
import { ApiAccess, type ApiAccessEnv } from "./access";
import { ApiError, type ApiChat, type ApiChatOptions, type ApiProvider, type ApiProviderId } from "./chat";
import { KeyStore } from "./keyStore";

/**
 * A stand-in for the end-to-end run of the chat (DRAWAI_E2E_API): a provider that is none.
 * Nothing is sent anywhere, and the system keychain is not asked. Its "model" is a script that
 * answers a request the way a model would, through the tools it is offered: it reads the
 * diagram, adds a shape with the label the request names, and says what it did. When a tool's
 * answer carries something the user added meanwhile (`<user_update>`), it adds that shape too.
 * Beside an Excalidraw drawing it is offered that drawing's tools, and does the same with those.
 */
export const STAND_IN_ID = "stand-in" as ApiProviderId;
/** (made up: nothing a provider issued) */
export const STAND_IN_KEY = "stand-in-key-0000-not-a-real-one";

function chat(o: ApiChatOptions): ApiChat {
	let held = 0;
	return {
		blank: () => held === 0,
		send: async (text, _images, signal) => {
			// (Settings → Test: it calls the tool it is asked to and says OK, as a model that works does)
			if (/connection check/i.test(text)) {
				await o.callTool(/Call the tool (\w+)/.exec(text)?.[1] ?? "drawio_lint", {});
				if (signal.aborted) return "cancelled";
				o.onText("OK");
				return "end_turn";
			}
			if (o.tools.some((t) => t.name === "excalidraw_get_scene")) {
				o.onText("Reading the drawing. ");
				const scene = await o.callTool("excalidraw_get_scene", {});
				if (signal.aborted) return "cancelled";
				const words = /labelled '([^']+)'/.exec(text)?.[1] ?? "Hello from the API";
				const drawn = await o.callTool("excalidraw_apply_operations", { operations: [{ op: "add", type: "rectangle", id: `stand-in-${held + 1}`, x: 60, y: 360 + held * 110, width: 220, height: 70, label: words }] });
				if (signal.aborted) return "cancelled";
				held++;
				o.onText(scene.isError ? `I could not read it: ${scene.text}` : drawn.isError ? `I left the shape out: ${drawn.text}` : `Added a shape labelled '${words}' with ${o.model} (request ${held} of this conversation).`);
				return "end_turn";
			}
			o.onText("Reading the diagram. ");
			const read = await o.callTool("drawio_get_diagram", {});
			if (signal.aborted) return "cancelled";
			// (asked what it sees, it says what it was told: the diagram's name, and what reading it said of the page)
			if (/which diagram/i.test(text)) {
				let notes: unknown;
				try {
					notes = JSON.parse(read.text).notes;
				} catch {
					// not what a read answers
				}
				held++;
				o.onText(`I was told: ${/^Open diagram: .*$|^No draw\.io diagram is open.*$/m.exec(text)?.[0] ?? "nothing"} Reading it said: ${Array.isArray(notes) ? notes.join(" ") : read.text}`);
				return "end_turn";
			}
			const label = /labelled '([^']+)'/.exec(text)?.[1] ?? "Hello from the API";
			const made = await o.callTool("drawio_apply_operations", { ops: [{ op: "addShape", label, x: 40, y: 40 + held * 80, width: 180, height: 60 }] });
			if (signal.aborted) return "cancelled";
			const added = /<user_update>[\s\S]*?labelled '([^']+)'[\s\S]*?<\/user_update>/.exec(`${read.text}\n${made.text}`)?.[1];
			const more = added ? await o.callTool("drawio_apply_operations", { ops: [{ op: "addShape", label: added, x: 260, y: 40 + held * 80, width: 180, height: 60 }] }) : undefined;
			if (signal.aborted) return "cancelled";
			held++;
			o.onText(read.isError ? `I could not read it: ${read.text}` : made.isError ? `I left the shape out: ${made.text}` : `Added a shape labelled '${label}' with ${o.model} (request ${held} of this conversation).`);
			if (added) o.onText(more?.isError ? ` I left out what you added: ${more.text}` : ` Then, as you added, one labelled '${added}'.`);
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
