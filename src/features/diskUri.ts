/**
 * Small questions about a vscode.Uri that several features ask. Nothing here imports vscode:
 * the unit tests load it as it is.
 */

/**
 * Whether the extension can read and write this file with Node's fs: a local file, or one on a
 * remote machine (WSL, SSH, a container) when the extension runs there (its extension kind is
 * "workspace"). A remote file seen from an extension running on the user's own machine is not.
 */
export function isOnDisk(uri: { scheme: string }, runsOnWorkspaceHost: boolean): boolean {
	return uri.scheme === "file" || (uri.scheme === "vscode-remote" && runsOnWorkspaceHost);
}

/**
 * A file's name as it is on disk. A Uri's `path` is already decoded: decoding it again throws
 * on a name with a percent sign in it ("100%.drawio").
 */
export function fileNameOf(uri: { path: string }): string {
	return uri.path.split("/").pop() ?? "";
}
