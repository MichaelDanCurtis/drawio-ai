"use strict";

// src/preload/workshop.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("omnidrawWorkshop", {
  post: (msg) => import_electron.ipcRenderer.send("workshop:toHost", msg),
  onMessage: (handler) => {
    import_electron.ipcRenderer.on("workshop:toWebview", (_e, msg) => handler(msg));
  }
});
