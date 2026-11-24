"use strict";

// src/preload/chat.ts
var import_electron = require("electron");
var api = {
  postMessage: (msg) => import_electron.ipcRenderer.send("chat:toHost", msg),
  getState: () => void 0,
  setState: (s) => s
};
import_electron.contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);
import_electron.ipcRenderer.on("chat:toWebview", (_e, msg) => {
  window.postMessage(msg, "*");
});
