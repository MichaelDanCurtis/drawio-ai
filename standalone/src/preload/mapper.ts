// Preload for the Mapper dialog: a tiny message bridge over IPC.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("drawaiMapper", {
	post: (msg: unknown) => ipcRenderer.send("mapper:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("mapper:toWebview", (_e, msg: unknown) => handler(msg));
	},
});
