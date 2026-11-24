"use strict";

// src/preload/mapper.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("drawaiMapper", {
  post: (msg) => import_electron.ipcRenderer.send("mapper:toHost", msg),
  onMessage: (handler) => {
    import_electron.ipcRenderer.on("mapper:toWebview", (_e, msg) => handler(msg));
  }
});
