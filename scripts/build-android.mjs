#!/usr/bin/env node
/**
 * ScoreRecognizer Android APK 构建脚本（Capacitor 8 + Vite 前端）。
 *
 * 用法：
 *   node scripts/build-android.mjs            # 构建 debug APK
 *   node scripts/build-android.mjs --clean    # 先 clean 再构建
 *   node scripts/build-android.mjs --version 0.2.0 --version-code 2
 *   node scripts/build-android.mjs --setup    # 只准备工具链（解压/下载 + 安装 SDK 组件）
 *   node scripts/build-android.mjs --skip-verify
 *
 * 流程：工具链检查 → vite build → capacitor sync android → Gradle assembleDebug
 *       → 复制到 release/ScoreRecognizer-<version>-android-debug.apk → 校验 APK 内容与签名。
 *
 * 环境变量全部只在本进程内设置（JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT /
 * GRADLE_USER_HOME），不写系统环境变量。
 *
 * 说明：为了避开 Windows 下 .bat 的引号/空格问题（工作区路径含空格），脚本统一用
 * `java -classpath ... <MainClass>` 直接调用 Gradle / sdkmanager / apksigner 的 Java 入口，
 * 不再经过 gradlew.bat / sdkmanager.bat / apksigner.bat。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TC = path.join(ROOT, "_private", "toolchain");
const TOOLCHAIN = {
  jdk: path.join(TC, "jdk21"),
  sdk: path.join(TC, "android-sdk"),
  gradleDist: path.join(TC, "gradle-dist"),
  gradleHome: path.join(TC, "gradle-home"),
  gradleVersion: "8.14.3", // Capacitor 8.5 模板（AGP 8.13.0）要求 Gradle >= 8.13
  agpVersion: "8.13.0",
  // AGP 8.13.0 默认使用 Build-Tools 35.0.0；36.0.0 用于脚本自身的 apksigner 校验。
  sdkPackages: ["platform-tools", "platforms;android-36", "build-tools;35.0.0", "build-tools;36.0.0"],
  buildTools: "36.0.0",
};
const PROJECT = {
  androidDir: path.join(ROOT, "android"),
  distDir: path.join(ROOT, "dist"),
  releaseDir: path.join(ROOT, "release"),
  viteBin: path.join(ROOT, "node_modules", "vite", "bin", "vite.js"),
  capacitorBin: path.join(ROOT, "node_modules", "@capacitor", "cli", "bin", "capacitor"),
  appGradle: path.join(ROOT, "android", "app", "build.gradle"),
  rootGradle: path.join(ROOT, "android", "build.gradle"),
  manifest: path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml"),
  stringsXml: path.join(ROOT, "android", "app", "src", "main", "res", "values", "strings.xml"),
  localProperties: path.join(ROOT, "android", "local.properties"),
};
const APP_ID = "com.passersby.scorerecognizer";
const APP_NAME = "ScoreRecognizer";

// --------------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const args = { clean: false, setupOnly: false, verify: true, version: "0.2.0", versionCode: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--clean") args.clean = true;
    else if (a === "--setup") args.setupOnly = true;
    else if (a === "--skip-verify") args.verify = false;
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--version-code") args.versionCode = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else fail(`未知参数：${a}（--help 查看用法）`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version ?? "")) fail(`--version 不合法：${args.version}`);
  if (!Number.isInteger(args.versionCode) || args.versionCode < 1) fail(`--version-code 不合法：${args.versionCode}`);
  return args;
}

// ---------------------------------------------------------------------- 日志/执行
let stepNo = 0;
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
function step(title) {
  stepNo += 1;
  console.log(`\n=== [${stepNo}] ${title} ===`);
}
function info(msg) {
  console.log(`    ${msg}`);
}
function fail(msg) {
  console.error(`\n[build-android] 失败：${msg}`);
  process.exit(1);
}
function rel(p) {
  return p.startsWith(ROOT) ? `.${path.sep}${path.relative(ROOT, p)}` : p;
}

/** 启动子进程（不使用 shell，路径含空格也安全）。 */
function spawn(cmd, args, opts = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    capture = false,
    input,
    label = [path.basename(cmd), ...args.slice(0, 3)].join(" "),
  } = opts;
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.error) fail(`无法执行 ${label}：${res.error.message}`);
  if (res.status !== 0) {
    if (capture) {
      if (res.stdout) console.error(res.stdout.trim());
      if (res.stderr) console.error(res.stderr.trim());
    }
    fail(`${label} 退出码 ${res.status}`);
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}
function run(cmd, args, opts = {}) {
  return spawn(cmd, args, opts);
}
function runCapture(cmd, args, opts = {}) {
  return spawn(cmd, args, { ...opts, capture: true });
}
function runNode(args, opts = {}) {
  return run(process.execPath, args, opts);
}
function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString("en-US")} bytes)`;
}
function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

// ------------------------------------------------------------ 工具链（Java 入口）
let JAVA_HOME = null;
function javaBin() {
  return path.join(JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
}
function javaRun(classpath, mainClass, args, opts = {}) {
  return run(javaBin(), ["-classpath", classpath, mainClass, ...args], {
    ...opts,
    label: `java ${mainClass}`,
  });
}
function javaCapture(classpath, mainClass, args, opts = {}) {
  return runCapture(javaBin(), ["-classpath", classpath, mainClass, ...args], {
    ...opts,
    label: `java ${mainClass}`,
  });
}

function find7za() {
  const pnpmDir = path.join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const entry = readdirSync(pnpmDir).find((n) => /^7zip-bin@/.test(n));
  if (!entry) return null;
  const exe = path.join(pnpmDir, entry, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  return existsSync(exe) ? exe : null;
}
function extractZip(zipPath, outDir, label) {
  if (!existsSync(zipPath)) fail(`缺少 ${rel(zipPath)}（应事先下载好，勿重新下载）`);
  const sevenZa = find7za();
  if (!sevenZa) fail(`找不到 7za（node_modules/.pnpm/7zip-bin@*/.../7za.exe），无法解压 ${label}`);
  mkdirSync(outDir, { recursive: true });
  info(`解压 ${rel(zipPath)} → ${rel(outDir)} ...`);
  run(sevenZa, ["x", zipPath, `-o${outDir}`, "-y"]);
}
function findFile(dir, predicate, depth = 3) {
  if (!existsSync(dir) || depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && predicate(full, entry.name)) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, predicate, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
function findJdkHome() {
  if (process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, "bin", "java.exe"))) {
    return process.env.JAVA_HOME;
  }
  if (existsSync(TOOLCHAIN.jdk)) {
    const exe = findFile(TOOLCHAIN.jdk, (_f, name) => name.toLowerCase() === "java.exe", 3);
    if (exe) return path.dirname(path.dirname(exe));
  }
  return null;
}
function ensureJdk() {
  const found = findJdkHome();
  if (found) return found;
  info("未发现 JDK，从 _private/toolchain/jdk21.zip 解压 ...");
  extractZip(path.join(TC, "jdk21.zip"), TOOLCHAIN.jdk, "JDK 21");
  const home = findJdkHome();
  if (!home) fail("JDK 解压后仍找不到 java.exe");
  return home;
}

function sdkmanagerClasspath() {
  return path.join(TOOLCHAIN.sdk, "cmdline-tools", "latest", "lib", "sdkmanager-classpath.jar");
}
function ensureCmdlineTools() {
  if (existsSync(sdkmanagerClasspath())) return;
  info("未发现 Android cmdline-tools，从 _private/toolchain/cmdline-tools.zip 解压 ...");
  const tmp = path.join(TC, "android-sdk-tmp");
  rmSync(tmp, { recursive: true, force: true });
  extractZip(path.join(TC, "cmdline-tools.zip"), tmp, "Android cmdline-tools");
  // 压缩包内层目录名是 cmdline-tools/，需要放到 <sdk>/cmdline-tools/latest/
  const inner = path.join(tmp, "cmdline-tools");
  const latestDir = path.join(TOOLCHAIN.sdk, "cmdline-tools", "latest");
  if (!existsSync(inner)) fail(`cmdline-tools 压缩包结构异常：缺少 ${rel(inner)}`);
  mkdirSync(path.dirname(latestDir), { recursive: true });
  rmSync(latestDir, { recursive: true, force: true });
  renameSync(inner, latestDir);
  rmSync(tmp, { recursive: true, force: true });
}

function sdkPackagesInstalled() {
  return (
    existsSync(path.join(TOOLCHAIN.sdk, "platform-tools", "adb.exe")) &&
    existsSync(path.join(TOOLCHAIN.sdk, "platforms", "android-36", "android.jar")) &&
    existsSync(path.join(TOOLCHAIN.sdk, "build-tools", "35.0.0", "aapt2.exe")) &&
    existsSync(path.join(TOOLCHAIN.sdk, "build-tools", TOOLCHAIN.buildTools, "aapt2.exe"))
  );
}
function ensureSdkPackages() {
  if (sdkPackagesInstalled()) return;
  const cp = sdkmanagerClasspath();
  if (!existsSync(cp)) fail("缺少 sdkmanager-classpath.jar，无法安装 Android SDK 组件");
  info("接受 Android SDK licenses ...");
  run(javaBin(), ["-classpath", cp, "com.android.sdklib.tool.sdkmanager.SdkManagerCli", `--sdk_root=${TOOLCHAIN.sdk}`, "--licenses"], {
    input: "y\n".repeat(60),
    label: "sdkmanager --licenses",
  });
  info(`安装 SDK 组件：${TOOLCHAIN.sdkPackages.join(", ")}（首次下载，视网络 1-5 分钟）...`);
  run(
    javaBin(),
    ["-classpath", cp, "com.android.sdklib.tool.sdkmanager.SdkManagerCli", `--sdk_root=${TOOLCHAIN.sdk}`, "--install", ...TOOLCHAIN.sdkPackages],
    { input: "y\n".repeat(60), label: "sdkmanager --install" },
  );
  if (!sdkPackagesInstalled()) fail("SDK 组件安装后校验仍缺失（platform-tools / platforms;android-36 / build-tools;36.0.0）");
}
function listInstalledSdkPackages() {
  const { stdout } = javaCapture(sdkmanagerClasspath(), "com.android.sdklib.tool.sdkmanager.SdkManagerCli", [
    `--sdk_root=${TOOLCHAIN.sdk}`,
    "--list_installed",
  ]);
  return stdout
    .split(/\r?\n/)
    .filter((l) => /^\s{2}(platform-tools|platforms;|build-tools;)/.test(l))
    .map((l) => l.trim());
}

function findGradle() {
  if (!existsSync(TC)) return null;
  const candidates = readdirSync(TC)
    .filter((n) => /^gradle-\d+\.\d+(\.\d+)?$/.test(n))
    .map((n) => path.join(TC, n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const dir of candidates) {
    const libDir = path.join(dir, "lib");
    if (!existsSync(libDir)) continue;
    try {
      const { stdout } = javaCapture(path.join(libDir, "*"), "org.gradle.launcher.GradleMain", ["--version"]);
      const m = stdout.match(/^Gradle (\d+)\.(\d+)(?:\.(\d+))?/m);
      if (!m) continue;
      const fullVersion = [m[1], m[2], m[3]].filter(Boolean).join(".");
      const major = Number(m[1]);
      const minor = Number(m[2]);
      if (major > 8 || (major === 8 && minor >= 13)) return { dir, classpath: path.join(libDir, "*"), version: fullVersion };
      info(`跳过 ${path.basename(dir)}（Gradle ${fullVersion} < 8.13，不兼容 AGP ${TOOLCHAIN.agpVersion}）`);
    } catch {
      /* 该 gradle 不可用，换下一个 */
    }
  }
  return null;
}
function ensureGradle() {
  const found = findGradle();
  if (found) return found;
  const version = TOOLCHAIN.gradleVersion;
  const zip = path.join(TOOLCHAIN.gradleDist, `gradle-${version}-bin.zip`);
  if (!existsSync(zip)) {
    info(`未发现 Gradle ${version}，从 services.gradle.org 下载到 ${rel(zip)} ...`);
    mkdirSync(TOOLCHAIN.gradleDist, { recursive: true });
    run("curl.exe", ["-L", "--fail", "--retry", "3", "-o", zip, `https://services.gradle.org/distributions/gradle-${version}-bin.zip`], {
      label: "curl gradle",
    });
  }
  extractZip(zip, TC, `Gradle ${version}`);
  const dir = path.join(TC, `gradle-${version}`);
  const classpath = path.join(dir, "lib", "*");
  if (!existsSync(path.join(dir, "lib"))) fail(`Gradle ${version} 解压后找不到 lib/`);
  const { stdout } = javaCapture(classpath, "org.gradle.launcher.GradleMain", ["--version"]);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("Gradle "));
  return { dir, classpath, version: line ? line.replace("Gradle ", "").replace(/\s.*$/, "") : version };
}

// ------------------------------------------------------------ android 工程适配
function ensureAndroidProject() {
  if (existsSync(path.join(PROJECT.androidDir, "settings.gradle"))) return;
  info("android/ 不存在，运行 capacitor add android ...");
  runNode([PROJECT.capacitorBin, "add", "android"], { cwd: ROOT, env: process.env });
}
function readText(file) {
  return readFileSync(file, "utf8");
}
function applyAndroidPatches() {
  for (const file of [PROJECT.manifest, PROJECT.appGradle, PROJECT.stringsXml]) {
    if (!existsSync(file)) fail(`android 工程缺少 ${rel(file)}`);
  }

  // 1) 应用名
  const strings = readText(PROJECT.stringsXml);
  const patchedStrings = strings
    .replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${APP_NAME}</string>`)
    .replace(/<string name="title_activity_main">[^<]*<\/string>/, `<string name="title_activity_main">${APP_NAME}</string>`);
  if (patchedStrings !== strings) {
    writeFileSync(PROJECT.stringsXml, patchedStrings);
    info(`已更新应用名：${APP_NAME}`);
  }

  // 2) CAMERA 权限（拍摄页 getUserMedia 实时取景需要；缺失时 Android 会直接拒绝取景）
  let manifest = readText(PROJECT.manifest);
  if (!/android:name="android\.permission\.CAMERA"/.test(manifest)) {
    if (!/android:name="android\.permission\.INTERNET"/.test(manifest)) fail("AndroidManifest.xml 缺少 INTERNET 权限，工程结构异常");
    manifest = manifest.replace(
      /(<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/,
      `$1
    <!-- 拍摄页使用 WebView getUserMedia 实时取景，需要 CAMERA 运行时权限（Capacitor 的
         BridgeWebChromeClient 在 WebView 请求 VIDEO_CAPTURE 时会申请该权限）。 -->
    <uses-permission android:name="android.permission.CAMERA" />

    <!-- 没有摄像头的设备也可安装（可退回批量上传）。 -->
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />`,
    );
    writeFileSync(PROJECT.manifest, manifest);
    info("已为 AndroidManifest.xml 增加 CAMERA 权限 / uses-feature");
  }

  // 3) 版本号（以脚本参数为准，保证 APK 文件名与清单版本一致）
  const gradle = readText(PROJECT.appGradle);
  const patchedGradle = gradle
    .replace(/versionCode \d+/, `versionCode ${buildArgs.versionCode}`)
    .replace(/versionName "[^"]*"/, `versionName "${buildArgs.version}"`);
  if (patchedGradle !== gradle) {
    writeFileSync(PROJECT.appGradle, patchedGradle);
    info(`已更新 android 版本号：versionCode=${buildArgs.versionCode} versionName=${buildArgs.version}`);
  }
  if (!patchedGradle.includes(`applicationId "${APP_ID}"`)) {
    fail(`android/app/build.gradle 的 applicationId 不是 ${APP_ID}（capacitor.config.ts 配置与工程不一致）`);
  }

  // 4) 构建脚本要求 Gradle >= 8.13（AGP 8.13.0），确认模板里的 AGP 版本与文档一致
  if (existsSync(PROJECT.rootGradle)) {
    const rootBuild = readText(PROJECT.rootGradle);
    const m = rootBuild.match(/com\.android\.tools\.build:gradle:([\d.]+)/);
    if (m && m[1] !== TOOLCHAIN.agpVersion) {
      info(`注意：android/build.gradle 里 AGP 版本为 ${m[1]}（文档记录 ${TOOLCHAIN.agpVersion}），Gradle 版本需与其匹配`);
    }
  }
}
function writeLocalProperties() {
  mkdirSync(PROJECT.androidDir, { recursive: true });
  const sdk = TOOLCHAIN.sdk.replaceAll("\\", "/");
  writeFileSync(PROJECT.localProperties, `# 由 scripts/build-android.mjs 生成，指向工作区内的 Android SDK\nsdk.dir=${sdk}\n`);
}

// ------------------------------------------------------------------- 校验
function verifyApk(apkPath) {
  const results = [];
  const jar = path.join(JAVA_HOME, "bin", process.platform === "win32" ? "jar.exe" : "jar");
  if (!existsSync(jar)) fail(`找不到 JDK jar 工具：${rel(jar)}`);
  const { stdout: entries } = runCapture(jar, ["tf", apkPath], { label: "jar tf" });
  const list = entries.split(/\r?\n/).filter(Boolean);
  for (const entry of ["AndroidManifest.xml", "classes.dex", "resources.arsc", "assets/public/index.html"]) {
    if (!list.includes(entry)) fail(`APK 内缺少 ${entry}（前端资源未打进 APK？）`);
    results.push(`✓ APK 含 ${entry}`);
  }
  if (!list.some((p) => p.startsWith("assets/public/assets/"))) fail("APK 内缺少 assets/public/assets/（前端 JS/CSS）");
  results.push(`✓ APK 含 assets/public/assets/*（${list.filter((p) => p.startsWith("assets/public/assets/")).length} 个前端静态资源）`);
  if (list.some((p) => p.startsWith("assets/public/models/"))) results.push("✓ APK 含 assets/public/models/*（本地识别模型）");

  const apkSignerJar = path.join(TOOLCHAIN.sdk, "build-tools", TOOLCHAIN.buildTools, "lib", "apksigner.jar");
  if (!existsSync(apkSignerJar)) fail(`找不到 apksigner.jar：${rel(apkSignerJar)}`);
  const { stdout: signOut } = javaCapture(apkSignerJar, "com.android.apksigner.ApkSignerTool", ["verify", "--verbose", "--print-certs", apkPath]);
  if (!/^Verifies$/m.test(signOut)) fail(`apksigner verify 未通过：\n${signOut}`);
  results.push("✓ apksigner verify: Verifies（签名有效）");
  for (const line of signOut.split(/\r?\n/)) {
    const t = line.trim();
    if (/^Verified using .*: true$/.test(t)) results.push(`  ${t}`);
  }
  const cert = signOut.split(/\r?\n/).find((l) => /Signer #1 certificate DN:/.test(l));
  if (cert) results.push(`  ${cert.trim()}`);
  return results;
}

// ---------------------------------------------------------------------- main
const buildArgs = parseArgs(process.argv.slice(2));
console.log(`ScoreRecognizer Android 构建 · ${new Date().toISOString()}`);
console.log(`项目目录：${ROOT}`);
console.log(`目标版本：${buildArgs.version} (versionCode=${buildArgs.versionCode})`);

// ---- 工具链
step("准备工具链（JDK 21 / Android SDK 36 / Gradle 8.14.3）");
JAVA_HOME = ensureJdk();
info(`JAVA_HOME = ${rel(JAVA_HOME)}`);
const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME: TOOLCHAIN.sdk,
  ANDROID_SDK_ROOT: TOOLCHAIN.sdk,
  GRADLE_USER_HOME: TOOLCHAIN.gradleHome,
  PATH: `${path.join(JAVA_HOME, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
};
ensureCmdlineTools();
ensureSdkPackages();
for (const pkg of listInstalledSdkPackages()) info(`SDK 已安装：${pkg}`);
const gradle = ensureGradle();
info(`Gradle ${gradle.version} = ${rel(gradle.dir)}`);
info(`ANDROID_HOME = ${rel(TOOLCHAIN.sdk)}`);
info(`GRADLE_USER_HOME = ${rel(TOOLCHAIN.gradleHome)}`);

if (buildArgs.setupOnly) {
  console.log("\n工具链已就绪（--setup 结束）。");
  process.exit(0);
}

// ---- 前端 + Capacitor 工程
step("生成前端 dist/（vite build）");
if (!existsSync(PROJECT.viteBin)) fail(`找不到 vite：${rel(PROJECT.viteBin)}`);
runNode([PROJECT.viteBin, "build"], { cwd: ROOT, env });
if (!existsSync(path.join(PROJECT.distDir, "index.html"))) fail("vite build 后 dist/index.html 不存在");

step("同步 Capacitor Android 工程");
ensureAndroidProject();
writeLocalProperties();
applyAndroidPatches();
if (!existsSync(PROJECT.capacitorBin)) fail(`找不到 Capacitor CLI：${rel(PROJECT.capacitorBin)}`);
runNode([PROJECT.capacitorBin, "sync", "android"], { cwd: ROOT, env });
// sync 会重写 capacitor.build.gradle / capacitor.settings.gradle，但不会覆盖 manifest 与 app/build.gradle；
// 再跑一次补丁保证幂等（例如 sync 触发 update 时）。
applyAndroidPatches();

step(`Gradle assembleDebug${buildArgs.clean ? "（含 clean）" : ""} ...`);
const gradleArgs = ["--no-daemon", "--console=plain"];
if (buildArgs.clean) gradleArgs.push("clean");
gradleArgs.push("assembleDebug");
run(javaBin(), ["-classpath", gradle.classpath, "org.gradle.launcher.GradleMain", ...gradleArgs], {
  cwd: PROJECT.androidDir,
  env,
  label: "gradle assembleDebug",
});

step("复制并校验 APK");
const builtApk = path.join(PROJECT.androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!existsSync(builtApk)) fail(`Gradle 构建成功但找不到 APK：${rel(builtApk)}`);
mkdirSync(PROJECT.releaseDir, { recursive: true });
const apkName = `${APP_NAME}-${buildArgs.version}-android-debug.apk`;
const outApk = path.join(PROJECT.releaseDir, apkName);
copyFileSync(builtApk, outApk);
const size = statSync(outApk).size;
const hash = sha256(outApk);

let checks = [];
if (buildArgs.verify) checks = verifyApk(outApk);
else info("已跳过 APK 内容/签名校验（--skip-verify）");

step("完成");
console.log(`
  产物：${outApk}
  大小：${humanSize(size)}
  SHA-256：${hash}
  包名：${APP_ID}
  版本：versionName=${buildArgs.version} versionCode=${buildArgs.versionCode}
  debug 签名：Android Debug 自签名（仅用于内部测试/侧载，不可上架）
${checks.map((c) => `  ${c}`).join("\n")}

  构建进程内环境变量（不写系统环境变量）：
    JAVA_HOME        = ${JAVA_HOME}
    ANDROID_HOME     = ${TOOLCHAIN.sdk}
    ANDROID_SDK_ROOT = ${TOOLCHAIN.sdk}
    GRADLE_USER_HOME = ${TOOLCHAIN.gradleHome}

  共用时 ${elapsed()}。
`);
