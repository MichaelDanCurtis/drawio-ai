// Preload for the draw.io editor view. webview-content.html was written for a
// VS Code webview: it talks to its host through acquireVsCodeApi().postMessage
// and receives host messages as window "message" events. This recreates both
// over Electron IPC, so the page and the Draw.AI draw.io plugin run unchanged.
import { contextBridge, ipcRenderer } from "electron";

let state: unknown;
const api = {
	postMessage: (msg: unknown) => ipcRenderer.send("drawio:toHost", typeof msg === "string" ? msg : JSON.stringify(msg)),
	getState: () => state,
	setState: (s: unknown) => {
		state = s;
		return s;
	},
};
contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);

ipcRenderer.on("drawio:toWebview", (_e, msg: string) => {
	window.postMessage(msg, "*");
});
