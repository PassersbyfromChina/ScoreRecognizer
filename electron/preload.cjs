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

  /** 局域网手机拍摄协作 */
  lan: {
    info: () => ipcRenderer.invoke("lan:info"),
    start: () => ipcRenderer.invoke("lan:start"),
    stop: () => ipcRenderer.invoke("lan:stop"),
    /** 订阅手机传回的照片；返回取消订阅函数 */
    onPhoto: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("lan:photo", handler);
      return () => ipcRenderer.removeListener("lan:photo", handler);
    },
  },
});
