"use strict";
// 화면(renderer)에 노출하는 최소한의 API. Node 기능은 직접 노출하지 않는다.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  send: (text) => ipcRenderer.invoke("chat:send", text),
  stop: () => ipcRenderer.invoke("chat:stop"),
  reset: () => ipcRenderer.invoke("chat:reset"),
  respondApproval: (r) => ipcRenderer.invoke("approval:respond", r),
  attach: (paths) => ipcRenderer.invoke("files:attach", paths),
  openFile: (rel) => ipcRenderer.invoke("file:open", rel),
  openFolder: () => ipcRenderer.invoke("folder:open"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent: (cb) => ipcRenderer.on("agent:event", (_e, evt) => cb(evt)),
  onApproval: (cb) => ipcRenderer.on("agent:approval", (_e, req) => cb(req)),
  onApprovalCancel: (cb) => ipcRenderer.on("agent:approval-cancel", () => cb()),
});
