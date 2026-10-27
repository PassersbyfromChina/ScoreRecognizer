// 打包脚本：先构建前端，再调用 electron-builder 生成 Windows 安装包。
// 用法：node scripts/package.mjs --x64 | --arm64
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arch = process.argv.includes("--arm64") ? "arm64" : "x64";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_INSTALL_SKIP_BINARY_DOWNLOAD;
env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || "https://registry.npmmirror.com/-/binary/electron/";
env.ELECTRON_BUILDER_BINARIES_MIRROR =
  env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
env.npm_config_audit = "false";
env.npm_config_fund = "false";

const node = process.execPath;

function run(args, label) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

run([path.join(root, "node_modules/vite/bin/vite.js"), "build"], "构建前端 (vite build)");

const builderArgs = [
  path.join(root, "node_modules/electron-builder/cli.js"),
  "--win",
  arch === "arm64" ? "--arm64" : "--x64",
  "--publish",
  "never",
];
const result = spawnSync(node, builderArgs, { cwd: root, stdio: "inherit", env });

if (result.status !== 0) {
  // 本机启用了「智能应用控制」时，electron-builder 生成安装器要临时运行安装程序，
  // 偶尔会被系统拦截（spawn UNKNOWN）。用已经打好的 win-*-unpacked 目录重试 NSIS 通常能通过。
  console.warn(`\n✗ 打包 Windows ${arch} 首次失败（exit ${result.status}），尝试用已生成的程序目录重试安装包…`);
  const prepackaged = path.join(root, "release", arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked");
  const releaseDir = path.join(root, "release");
  const fs = await import("node:fs");
  const setupRe = new RegExp(`^ScoreRecognizer-Setup-.*-${arch}\\.exe$`);
  const hasGoodInstaller = () => {
    try {
      return fs.readdirSync(releaseDir).some((name) => setupRe.test(name) && fs.statSync(path.join(releaseDir, name)).size > 100 * 1024 * 1024);
    } catch {
      return false;
    }
  };
  let ok = hasGoodInstaller();
  for (let attempt = 1; attempt <= 5 && !ok; attempt += 1) {
    console.log(`\n▶ 重试安装包（第 ${attempt} 次）`);
    spawnSync(
      node,
      [path.join(root, "node_modules/electron-builder/cli.js"), "--win", "nsis", arch === "arm64" ? "--arm64" : "--x64", "--prepackaged", prepackaged, "--publish", "never"],
      { cwd: root, stdio: "inherit", env },
    );
    ok = hasGoodInstaller();
    if (!ok) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  if (!ok) {
    console.error(`✗ 打包 Windows ${arch} 失败（安装包重试后仍失败）`);
    process.exit(result.status ?? 1);
  }
  console.log("✓ 安装包重试成功");
}

console.log(`\n✓ 打包完成，产物在 ${path.join(root, "release")}`);
