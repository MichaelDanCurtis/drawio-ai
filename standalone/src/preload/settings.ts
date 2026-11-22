// Preload for the Settings window: a tiny message bridge over IPC.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("drawaiSettings", {
	post: (msg: unknown) => ipcRenderer.send("settings:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("settings:toWebview", (_e, msg: unknown) => handler(msg));
	},
});
