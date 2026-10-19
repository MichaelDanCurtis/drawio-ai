import * as vscode from "vscode";
import type { ImageData } from "./providers/types";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 4;
/** Providers cap images at 5 MB of base64 (Anthropic); stay a little below. */
export const MAX_IMAGE_BASE64 = 5_000_000;
/** Files picked for the chat panel may be larger: the panel downscales them before sending. */
export const MAX_PICKED_IMAGE_BASE64 = 40 * 1024 * 1024;

export function sanitizeImages(raw: unknown): ImageData[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(i): i is ImageData =>
				!!i &&
				IMAGE_TYPES.includes(i.mimeType) &&
				typeof i.base64 === "string" &&
				i.base64.length <= MAX_IMAGE_BASE64 &&
				/^[A-Za-z0-9+/=]+$/.test(i.base64)
		)
		.slice(0, MAX_IMAGES)
		.map((i) => ({ mimeType: i.mimeType, base64: i.base64 }));
}

/** Returns undefined for unsupported types; throws when the file exceeds `maxBase64`. */
export async function readImage(uri: vscode.Uri, maxBase64 = MAX_IMAGE_BASE64): Promise<ImageData | undefined> {
	const ext = uri.path.toLowerCase().split(".").pop();
	const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const)[
		ext as "png"
	];
	if (!mimeType) return undefined;
	const data = await vscode.workspace.fs.readFile(uri);
	const base64 = Buffer.from(data).toString("base64");
	if (base64.length > maxBase64) {
		throw new Error(
			`${uri.path.split("/").pop()} is too large (${(data.byteLength / 1048576).toFixed(1)} MB). Paste or attach it in the Draw.AI chat panel, which shrinks large images automatically.`
		);
	}
	return { mimeType, base64 };
}

