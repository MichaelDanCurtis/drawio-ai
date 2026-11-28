// The folder an agent's program is started in, when that program is one that fetches a package
// and runs it (npx and its kind). Nothing of Electron here: the tests load this file as it is.
//
// A chat's agent works in the document's folder: that is the folder its session is told about.
// The program itself need not be started there, and a package runner must not be. npm reads
// the settings of the folder it is started in (an .npmrc there may name another registry) and
// looks in that folder's node_modules for the package before it fetches it. The document's
// folder is whatever the document came in (a checked-out repository, an unpacked archive): so
// opening a drawing there would let that folder decide what is run as the agent. A package
// runner is started in a folder of the app's own instead, which holds nothing at all.
import * as fs from "fs";
import * as path from "path";

/** Programs that find a package (in the folder they are started in, or a registry it names) and run it. */
const RUNNERS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "yarnpkg", "bunx", "bun", "uvx", "uv", "pipx", "deno"]);

/** Whether a command is a package runner (whatever folder it is in, and with Windows' endings). */
export function fetchesPackages(command: string): boolean {
	// (a Windows path is told apart by its backslashes, whatever system this runs on)
	const name = (command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
	return RUNNERS.has(name);
}

/** The folder could not be made, or is not the app's own any more; the message is for the user as it is. */
export class LaunchPlaceError extends Error {}

/**
 * The app's own folder for starting package runners in, under `root` (the app's data folder):
 * made if it is not there, and emptied of anything that has got into it. Throws
 * LaunchPlaceError when there is no such folder to be had (the name is a link, or a file).
 */
export function ownLaunchFolder(root: string): string {
	const folder = path.join(root, "agent-start");
	try {
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		// (a link under this name would lead elsewhere: it is not followed, and nothing is emptied through it)
		if (!fs.lstatSync(folder).isDirectory()) throw new LaunchPlaceError(`${folder} is not a folder.`);
		for (const name of fs.readdirSync(folder)) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
		return fs.realpathSync(folder);
	} catch (e: any) {
		if (e instanceof LaunchPlaceError) throw e;
		throw new LaunchPlaceError(`The folder ${folder} could not be made ready: ${e?.message ?? e}`);
	}
}

/** The folder a program is started in: the app's own for a package runner, the given one for any other. */
export function startFolder(launch: { startIn?: string }, sessionFolder: string): string {
	return launch.startIn ?? sessionFolder;
}
