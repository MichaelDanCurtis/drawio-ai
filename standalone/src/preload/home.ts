// Preload for the home screen: a tiny message bridge over IPC.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("omnidrawHome", {
	post: (msg: unknown) => ipcRenderer.send("home:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("home:toWebview", (_e, msg: unknown) => handler(msg));
	},
});
