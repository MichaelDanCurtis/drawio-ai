"use strict";

// src/preload/editor.ts
var import_electron = require("electron");
var state;
var api = {
  postMessage: (msg) => import_electron.ipcRenderer.send("drawio:toHost", typeof msg === "string" ? msg : JSON.stringify(msg)),
  getState: () => state,
  setState: (s) => {
    state = s;
    return s;
  }
};
import_electron.contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);
import_electron.ipcRenderer.on("drawio:toWebview", (_e, msg) => {
  window.postMessage(msg, "*");
});
