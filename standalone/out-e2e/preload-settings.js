"use strict";

// src/preload/settings.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("drawaiSettings", {
  post: (msg) => import_electron.ipcRenderer.send("settings:toHost", msg),
  onMessage: (handler) => {
    import_electron.ipcRenderer.on("settings:toWebview", (_e, msg) => handler(msg));
  }
});
