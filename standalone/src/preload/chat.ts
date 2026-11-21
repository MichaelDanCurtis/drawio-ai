// Preload for the chat panel: the same acquireVsCodeApi()/"message" contract the
// panel had as a VS Code webview view, over Electron IPC.
import { contextBridge, ipcRenderer } from "electron";

const api = {
	postMessage: (msg: unknown) => ipcRenderer.send("chat:toHost", msg),
	getState: () => undefined,
	setState: (s: unknown) => s,
};
contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);

ipcRenderer.on("chat:toWebview", (_e, msg: unknown) => {
	window.postMessage(msg, "*");
});
