// Preload for the Go live window: a tiny message bridge over IPC.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("drawaiLive", {
	post: (msg: unknown) => ipcRenderer.send("live:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("live:toWebview", (_e, msg: unknown) => handler(msg));
	},
});
