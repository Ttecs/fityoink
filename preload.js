const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings:    ()       => ipcRenderer.invoke("get-settings"),
  saveSettings:   (s)      => ipcRenderer.invoke("save-settings", s),
  chooseFolder:   ()       => ipcRenderer.invoke("choose-folder"),
  openFolder:     (p)      => ipcRenderer.invoke("open-folder", p),
  fetchLinks:     (url, mode) => ipcRenderer.invoke("fetch-links", url, mode),
  startDownloads: (u, dir) => ipcRenderer.invoke("start-downloads", { urls: u, downloadDir: dir }),
  pauseDownload:  (id)     => ipcRenderer.invoke("pause-download", id),
  resumeDownload: (id)     => ipcRenderer.invoke("resume-download", id),
  cancelDownload: (id)     => ipcRenderer.invoke("cancel-download", id),
  onProgress:     (cb)     => ipcRenderer.on("dl-progress", (_, d) => cb(d)),
  offProgress:    ()       => ipcRenderer.removeAllListeners("dl-progress"),
});
