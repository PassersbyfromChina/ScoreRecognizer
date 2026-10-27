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
run(
  [
    path.join(root, "node_modules/electron-builder/cli.js"),
    "--win",
    arch === "arm64" ? "--arm64" : "--x64",
    "--publish",
    "never",
  ],
  `打包 Windows ${arch}`,
);

console.log(`\n✓ 打包完成，产物在 ${path.join(root, "release")}`);
