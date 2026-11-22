// Preload for the Shape Workshop: a tiny message bridge over IPC.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("omnidrawWorkshop", {
	post: (msg: unknown) => ipcRenderer.send("workshop:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("workshop:toWebview", (_e, msg: unknown) => handler(msg));
	},
});
