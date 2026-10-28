// 构建免安装网页版：输出到 docs/app，随 GitHub Pages 一起发布。
// 访问地址：https://passersbyfromchina.github.io/ScoreRecognizer/app/
// 用法：node scripts/build-web.mjs
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "app");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log("\n▶ 构建网页版（base=/ScoreRecognizer/app/）");
const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--base=/ScoreRecognizer/app/", "--outDir=docs/app", "--emptyOutDir"],
  { cwd: root, stdio: "inherit", env },
);
if (result.status !== 0) {
  console.error(`✗ 网页版构建失败（exit ${result.status}）`);
  process.exit(result.status ?? 1);
}

// public 目录里的开发示例卡等不需要带到网页版（也避免进入公开仓库）
for (const name of ["samples"]) {
  const target = path.join(outDir, name);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

console.log(`\n✓ 网页版构建完成：${path.join("docs", "app")}`);
