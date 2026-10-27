// Electron 主进程（CommonJS）。打包后加载 dist/index.html；开发时加载 Vite dev server。
const { app, BrowserWindow, dialog, session, shell, Menu, ipcMain } = require("electron");
const path = require("node:path");
const { createLanServer } = require("./lan-server.cjs");

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_START_URL || "http://localhost:5173";

let mainWindow = null;
let lanServer = null;

/** 局域网手机拍摄服务（仅按需启动）。 */
function setupLan() {
  lanServer = createLanServer({
    userDataDir: app.getPath("userData"),
    onPhoto: ({ id, filename, data }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lan:photo", { id, filename, data });
      }
    },
  });
  ipcMain.handle("lan:info", () => lanServer.info());
  ipcMain.handle("lan:start", async () => {
    try {
      const info = await lanServer.start();
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("lan:stop", async () => ({ ok: true, ...(await lanServer.stop()) }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f4f5f8",
    title: "ScoreRecognizer · 红分识别",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (isDev) {
    mainWindow.loadURL(DEV_URL).catch(() => {
      mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    });
    if (process.env.ELECTRON_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // 外链走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupDownloadHandler() {
  session.defaultSession.on("will-download", async (event, item) => {
    const defaultPath = path.join(app.getPath("downloads"), item.getFilename() || "score.xlsx");
    item.setSaveDialogOptions({
      title: "保存文件",
      defaultPath,
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.passersby.scorerecognizer");
    Menu.setApplicationMenu(null);
    setupDownloadHandler();
    ipcMain.handle("app:version", () => app.getVersion());
    setupLan();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

// 统一错误弹窗，避免打包后静默失败
process.on("uncaughtException", (err) => {
  try {
    dialog.showErrorBox("ScoreRecognizer 出错了", String(err && err.stack ? err.stack : err));
  } catch {
    /* ignore */
  }
});
