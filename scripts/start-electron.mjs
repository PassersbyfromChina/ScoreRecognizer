// 启动 Electron（开发用）。注意：环境里可能设置了 ELECTRON_RUN_AS_NODE=1，必须去掉，
// 否则 electron.exe 会被当成 node 运行。
import { spawn } from "node:child_process";
import electronPath from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const startUrl = process.env.ELECTRON_START_URL || "http://localhost:5173";
env.ELECTRON_START_URL = startUrl;

const child = spawn(electronPath, [".", ...args], {
  stdio: "inherit",
  env,
  windowsHide: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
