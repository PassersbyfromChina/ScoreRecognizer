// 预加载脚本：只暴露必要的能力给页面（contextIsolation 下安全通信）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** 主进程版本号（打包后用） */
  getAppVersion: () => ipcRenderer.invoke("app:version"),
});
