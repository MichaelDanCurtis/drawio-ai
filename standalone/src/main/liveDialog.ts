import { BrowserWindow, clipboard, ipcMain, nativeTheme, shell } from "electron";
import * as path from "path";
import { DiagramWindow } from "./diagramWindow";
import { personColor } from "./live/liveShare";
import { parseBoardLink, serverOrigin } from "./live/protocol";
import { paths } from "./paths";
import { settings, updateSettings } from "./settings";
import type { StaticServer } from "./staticServer";

/**
 * The Go live window: start sharing the diagram in front (the server, your name, then the link
 * and who is here), or join one someone shared. One window for the app; it follows the diagram
 * it was opened for. The page is renderer/live.html.
 */
export class LiveDialog {
	private static win: BrowserWindow | undefined;
	private static target: DiagramWindow | undefined;
	private static mode: "share" | "join" = "share";
	private static busy: string | undefined;
	private static error: string | undefined;
	private static installed = false;
	private static server: StaticServer;

	public static open(server: StaticServer, target: DiagramWindow | undefined, mode: "share" | "join"): void {
		LiveDialog.install();
		LiveDialog.server = server;
		LiveDialog.target = target;
		LiveDialog.mode = target ? mode : "join";
		LiveDialog.error = undefined;
		if (LiveDialog.win && !LiveDialog.win.isDestroyed()) {
			LiveDialog.win.focus();
			LiveDialog.post();
			return;
		}
		const win = new BrowserWindow({
			parent: target?.win,
			width: 520,
			height: 560,
			minWidth: 420,
			minHeight: 420,
			title: "Go Live",
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#f3f2ef",
			show: false,
			webPreferences: { preload: path.join(paths.out, "preload-live.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		LiveDialog.win = win;
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/.test(url)) void shell.openExternal(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => (LiveDialog.win = undefined));
		void win.loadURL(`${server.base}/live.html`);
	}

	/** The window while it is open (tests look at it). */
	public static get window(): BrowserWindow | undefined {
		return LiveDialog.win && !LiveDialog.win.isDestroyed() ? LiveDialog.win : undefined;
	}

	/** A diagram's sharing changed (someone came, it ended): the window shows it if it is that diagram's. */
	public static refresh(w?: DiagramWindow): void {
		if (!w || w === LiveDialog.target) LiveDialog.post();
	}

	private static install(): void {
		if (LiveDialog.installed) return;
		LiveDialog.installed = true;
		ipcMain.on("live:toHost", (e, msg) => {
			if (e.sender.id === LiveDialog.win?.webContents.id) void LiveDialog.onMessage(msg);
		});
	}

	private static state() {
		const t = LiveDialog.target && !LiveDialog.target.win.isDestroyed() ? LiveDialog.target : undefined;
		const live = t?.live?.status === "live" ? t.live : undefined;
		const s = settings();
		return {
			type: "state",
			// (asked to join another: that form, also when the diagram in front is itself shared)
			mode: LiveDialog.mode === "join" ? "join" : live ? "live" : "share",
			diagram: t ? t.fileName() ?? "Untitled" : undefined,
			server: s.sharing.server,
			name: s.sharing.name,
			live: live ? { role: live.role, url: live.url, me: live.me, people: live.people().map((p) => ({ name: p.name, color: personColor(p.hue) })) } : undefined,
			busy: LiveDialog.busy,
			error: LiveDialog.error,
			matrix: s.appearance.matrix,
		};
	}

	private static post(extra: Record<string, unknown> = {}): void {
		if (LiveDialog.win && !LiveDialog.win.isDestroyed()) LiveDialog.win.webContents.send("live:toWebview", { ...LiveDialog.state(), ...extra });
	}

	private static async working(what: string, work: () => Promise<void>): Promise<void> {
		if (LiveDialog.busy) return;
		LiveDialog.busy = what;
		LiveDialog.error = undefined;
		LiveDialog.post();
		try {
			await work();
		} catch (e: any) {
			LiveDialog.error = String(e?.message ?? e).slice(0, 400);
		} finally {
			LiveDialog.busy = undefined;
			LiveDialog.post();
		}
	}

	private static async onMessage(msg: any): Promise<void> {
		const name = typeof msg?.name === "string" ? msg.name.trim().slice(0, 60) : settings().sharing.name;
		switch (msg?.type) {
			case "ready":
				LiveDialog.post();
				break;
			case "goLive": {
				const typed = String(msg.server ?? "").trim();
				const server = serverOrigin(typed);
				await LiveDialog.working("Putting the diagram on the server…", async () => {
					if (!LiveDialog.target || LiveDialog.target.win.isDestroyed()) throw new Error("The diagram's window is closed.");
					if (!server) throw new Error(typed ? "That is not an address a diagram can be shared through: it must be https (or a server on this computer)." : "Give the OmniPad server's address.");
					updateSettings({ sharing: { server, name } });
					await LiveDialog.target.goLive(server, name);
				});
				break;
			}
			case "join": {
				const link = String(msg.link ?? "").trim();
				await LiveDialog.working("Joining…", async () => {
					if (!parseBoardLink(link)) throw new Error("That is not a link to a shared diagram. It looks like https://…/b/… and comes from whoever pressed Go live.");
					updateSettings({ sharing: { ...settings().sharing, name } });
					const w = await DiagramWindow.join(LiveDialog.server, link, name);
					LiveDialog.target = w;
					LiveDialog.mode = "share";
				});
				break;
			}
			case "stop":
				await LiveDialog.working("Stopping…", async () => {
					await LiveDialog.target?.stopLive();
				});
				break;
			case "copy": {
				const url = LiveDialog.target?.live?.url;
				// (the link is the permission: it goes to the clipboard because the user asked, and nowhere else)
				if (url) clipboard.writeText(url);
				LiveDialog.post({ copied: !!url });
				break;
			}
			case "mode":
				if (msg.mode === "share" || msg.mode === "join") LiveDialog.mode = LiveDialog.target ? msg.mode : "join";
				LiveDialog.error = undefined;
				LiveDialog.post();
				break;
			case "close":
				LiveDialog.win?.close();
				break;
		}
	}
}
