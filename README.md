# ScoreRecognizer · 红分识别

拍照识别答题卡上的**红色笔迹分数**与**手写姓名**，自动整理成表格，核对确认后一键导出 Excel。

适用于老师日常批改后的登分场景：答题卡拍歪、分数写在题目区域外、一道题出现两个分数、字迹看不清——这些情况不会被"猜"，而是交给人在三种视图里确认。

## 功能

- **名单导入**：读取 Excel 中的姓名列，自动识别表头与起始行，也可手动指定。
- **区域划分**：拍一张答题卡样张，自动识别边缘、矫正倾斜与透视（支持阴影、透视、轻微模糊等不够理想的拍摄条件）；AI 可先给出题目与姓名区域，再人工拖动修改。坐标以试卷长边为 1 归一化保存，同一套卷子复用模板。
- **批量拍摄 / 上传**：电脑或手机拍摄、批量导入，图片实时保存；顶部实时统计「待拍摄 / 待自动处理 / 待确认 / 已完成」。
- **手机拍摄协作**：电脑与手机同一局域网，电脑显示二维码，手机扫码打开网页拍照，照片实时传回电脑，其余交给电脑。
- **识别**：本地红色笔迹提取；分数支持本地离线数字识别（内置轻量模型，实验特性）或 DeepSeek 视觉 AI；姓名由 AI 识别或用名单点选确认。
- **人工确认**：三种核对视图（整张试卷 / 红笔局部放大 / 表格）。红笔旁显示等大识别结果，支持键盘与触屏操作。
- **离线姓名加速（可选）**：可开启「按名单顺序自动填姓名」；答题卡按名单顺序收上来时，核对页逐张点一下候选姓名即可确认。不会自动认领，每张仍需人工确认。
- **导出**：Excel，姓名为行、题号为列，可含总分列；未确认的格子以可配置的标记（默认红色问号）导出。应用内保留备份；Android 上保存到 Documents 并调起系统分享。
- **离线优先**：不联网也能拍摄、矫正、本地数字识别、人工确认与导出；名单、图片与结果只保存在本机。
- **完整备份 / 恢复**：一键把班级、名单、模板、答题卡图片与识别结果导出为备份文件；换电脑或重装后导入即可恢复。

## 平台

- Windows x64 / Windows ARM64（Windows 10 及以上）
- Android 10 及以上（提供开发版 APK；手机可独立使用，也可仅作拍摄端配合电脑）

## 下载

最新版本：<https://github.com/PassersbyfromChina/ScoreRecognizer/releases/latest>

- Windows x64 / ARM64 安装包（NSIS）
- Windows x64 / ARM64 便携版 ZIP（解压即用；系统启用「智能应用控制」时请用这个）
- Android APK（侧载安装）

产品页与下载入口：<https://passersbyfromchina.github.io/ScoreRecognizer/>

## 开发

技术栈：Electron + React + TypeScript + Vite + Capacitor；数据保存在本机 IndexedDB。

```bash
pnpm install
pnpm dev               # 启动前端开发服务器（http://127.0.0.1:5173）
pnpm electron          # 另开一个终端，启动桌面端（连到开发服务器）
pnpm build             # 类型检查 + 构建 dist/
pnpm build:web         # 构建免安装网页版到 docs/app（随 GitHub Pages 发布）
pnpm test              # 单元测试（vitest）
pnpm package:win       # 打包 Windows x64 安装包
pnpm package:win-arm64 # 打包 Windows ARM64 安装包
node scripts/build-android.mjs   # 构建 Android APK（需要本地 JDK/Android SDK，见脚本内说明）
```

目录结构：

```
src/core/        与界面无关的核心逻辑（Excel、图像处理、本地数字识别、AI 调用、本地存储）
src/screens/     界面页面
src/components/  通用组件（区域编辑、弹窗、提示）
electron/        桌面端主进程（含局域网手机拍摄服务）
android/         Android 工程（Capacitor）
scripts/         构建/打包脚本
docs/            GitHub Pages 产品页
```

> 本仓库不包含需求问卷、示例名单或内部提示词等私有资料。

## 数据与隐私

学生名单、答题卡图片与识别结果默认只保存在本机，不上传服务器。
只有在你开启 AI 识别时，相关图片才会发送到你配置的 AI 服务商；API Key 由你自行填写并保存在本机。

## 许可

本项目采用 [MIT 许可证](LICENSE) 开源。

你可以自由使用、修改、分发本项目（包括商业用途），只需在副本中保留版权声明和许可证声明。软件按「原样」提供，不附带任何明示或暗示的担保。
