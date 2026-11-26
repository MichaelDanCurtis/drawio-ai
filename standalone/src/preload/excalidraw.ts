// Preload for the Excalidraw editor view: the page's line to the app (messages both ways, the
// document it was opened for, and where a dropped file is on disk).
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("omnidrawHost", {
	post: (msg: unknown) => ipcRenderer.send("excalidraw:toHost", msg),
	onMessage: (handler: (msg: unknown) => void) => {
		ipcRenderer.on("excalidraw:toWebview", (_e, msg: unknown) => handler(msg));
	},
	document: () => ipcRenderer.invoke("excalidraw:document"),
	pathOf: (file: File) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
});
