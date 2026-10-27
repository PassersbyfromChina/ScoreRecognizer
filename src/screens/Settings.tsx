import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  Check,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  ListChecks,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useAppStore } from "../core/store";
import type { MissingMarkMode } from "../core/types";
import { toast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { estimateStorage } from "../core/storage/db";
import { wipeAll } from "../core/storage/repo";
import { buildBackup, restoreBackup } from "../core/backup";
import { saveFile } from "../core/platform";

const HELP_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: "第一次使用怎么开始？",
    a: "① 学生名单：导入 Excel（自动识别姓名列，识别错了可以手动改）；\n② 区域划分：拍一张答题卡样张，自动摆正后画出「题目区域」和「姓名区域」，保存模板；\n③ 拍摄/上传：批量拍照或选图，应用会自动矫正、识别，处理好的进入「待确认」；\n④ 核对：逐张检查分数和姓名；\n⑤ 导出：一键导出 Excel，成绩会同时备份在应用里。",
  },
  {
    q: "答题卡模板怎么画？",
    a: "先上传一张答题卡样张，等它自动摆正后：点「画题目区域」，在每道题的作答位置上拖一个框；再点「画姓名区域」框住手写姓名；最后保存。同一个模板这套卷子一直能用。框不用画得很精确，稍微大一点没关系（分数常写在框外，识别时会往周围找）。",
  },
  {
    q: "拍照有什么要求？",
    a: "答题卡放平、光线均匀、四个角都拍进画面即可；自动矫正支持一定程度的歪斜、透视、阴影和轻微模糊。如果提示「没能自动找到边缘」，建议重拍一张。",
  },
  {
    q: "核对页怎么最快？",
    a: "键盘：Tab / ↑↓ 切题，Enter 通过继续，Backspace 修改，Esc 取消。\n鼠标/触屏：点分数修改，点「继续」通过。\n一张卡里大部分题都正常时，可以点「通过正常题（N）」一次性通过；看不清、一题多分、没找到分数的题不会被自动通过，仍需人工确认。",
  },
  {
    q: "没有 AI Key / 断网还能用吗？",
    a: "可以。没配 Key、关闭 AI 或断网时，分数会用内置的本地模型识别；姓名可以从名单里点选，也可以开启「按名单顺序自动填姓名」（仍需逐张确认）。离线识别是实验特性，看不清/不确定时会标「待确认」，不会硬猜。想要更高的自动识别率，建议配置 AI Key 联网识别。",
  },
  {
    q: "成绩导出和换电脑怎么办？",
    a: "导出页可以导出 Excel（姓名为行、题号为列、含总分列，未确认格显示红色问号），即使没核对完也能导出，导出的文件会自动备份在应用里。\n换电脑或重装：设置 →「完整备份」导出备份文件，在新设备上「恢复备份」即可。",
  },
  {
    q: "手机怎么和电脑一起用？",
    a: "电脑和手机连同一个 Wi-Fi。电脑打开「拍摄 / 上传」→「手机拍摄」，用手机扫码打开网页拍照，照片实时传回电脑，电脑负责识别和导出。手机不用安装 App。",
  },
  {
    q: "Android 手机可以单独用吗？",
    a: "可以。Android 版支持完整流程：导入名单、拍摄/上传、自动处理、核对、导出（保存到手机 Documents 并调起分享）。第一次安装需要在系统里允许「安装未知来源应用」。",
  },
];

export function SettingsScreen() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.aiModel);
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [storage, setStorage] = useState<{ usage: number; quota: number }>({ usage: 0, quota: 0 });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setApiKey(settings.apiKey);
    setModel(settings.aiModel);
    setBaseUrl(settings.aiBaseUrl);
  }, [settings.apiKey, settings.aiModel, settings.aiBaseUrl]);

  useEffect(() => {
    estimateStorage().then(setStorage).catch(() => undefined);
  }, []);

  async function saveAI() {
    await updateSettings({
      apiKey: apiKey.trim(),
      aiModel: model.trim() || "deepseek-v4-flash-vision-exp",
      aiBaseUrl: baseUrl.trim() || "https://api.deepseek.com",
      aiEnabled: settings.aiEnabled,
    });
    setSaved(true);
    toast("AI 设置已保存", "ok");
    window.setTimeout(() => setSaved(false), 1800);
  }

  async function setMissingMode(mode: MissingMarkMode) {
    await updateSettings({ missingMarkMode: mode });
  }

  async function handleBackup() {
    setBackupBusy(true);
    try {
      const { filename, blob, summary } = await buildBackup();
      const result = await saveFile(blob, filename);
      if (!result.ok) throw new Error(result.message ?? "保存失败");
      setLastBackup(
        `${new Date().toLocaleString("zh-CN")} · ${formatBytes(summary.bytes)} · ${summary.projects} 个班级 / ${summary.captures} 张答题卡`,
      );
      toast("完整备份已导出", "ok");
    } catch (e) {
      console.error(e);
      toast(`备份失败：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBackupBusy(false);
    }
  }

  async function doRestore(file: File) {
    setRestoreFile(null);
    setRestoreBusy(true);
    try {
      const result = await restoreBackup(file);
      toast(
        `已恢复 ${result.projects} 个班级、${result.captures} 张答题卡${result.warnings.length ? `（${result.warnings.length} 张图片恢复失败）` : ""}`,
        "ok",
      );
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      console.error(e);
      toast(`恢复失败：${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setRestoreBusy(false);
    }
  }

  const keyPreview = settings.apiKey ? `${settings.apiKey.slice(0, 5)}…${settings.apiKey.slice(-4)}` : "未填写";

  return (
    <div className="page-inner" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div className="titles">
          <h1>设置</h1>
          <div className="desc">AI 识别、导出标记与本地数据</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <Bot size={17} color="var(--red)" />
          <h2>识图 AI</h2>
          <span className="spacer" />
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => updateSettings({ aiEnabled: e.target.checked })}
            />
            <span className="track" />
            <span className="small muted">启用</span>
          </label>
        </div>
        <div className="card-body">
          <div className="notice notice-info" style={{ marginBottom: 18 }}>
            <ShieldCheck size={15} />
            <div>
              当前使用 DeepSeek 视觉模型（可看图）。key 只保存在本机；只有在你启用 AI 并执行识别时，答题卡图片才会发送给你的 AI 服务商。
              <br />
              没有填 Key、关闭 AI 或断网时，分数会自动改用内置的本地数字识别（离线运行，姓名可手动确认）。
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="setApiKey">
              API Key
            </label>
            <div className="row">
              <div className="grow" style={{ position: "relative" }}>
                <input
                  id="setApiKey"
                  className="input"
                  style={{ paddingRight: 40 }}
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  placeholder="sk-..."
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="btn btn-icon btn-ghost"
                  style={{ position: "absolute", right: 4, top: 4 }}
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏" : "显示"}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button className="btn btn-secondary" onClick={saveAI}>
                {saved ? <Check size={16} /> : null}
                保存
              </button>
            </div>
            <div className="hint">当前：{keyPreview} · 在 DeepSeek 开放平台创建，格式类似 sk-xxxxxxxx</div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label className="label" htmlFor="setModel">
                模型
              </label>
              <input id="setModel" className="input" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
              <div className="hint">默认 deepseek-v4-flash-vision-exp（视觉理解模型）</div>
            </div>
            <div className="field">
              <label className="label" htmlFor="setBaseUrl">
                接口地址
              </label>
              <input id="setBaseUrl" className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
              <div className="hint">默认 https://api.deepseek.com，一般不用改</div>
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label className="label">AI 识别方式</label>
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className={`btn btn-sm ${settings.aiRecognizeMode === "whole" ? "btn-secondary" : "btn-primary"}`}
                onClick={() => void updateSettings({ aiRecognizeMode: "crops" })}
              >
                逐题裁剪（推荐）
              </button>
              <button
                type="button"
                className={`btn btn-sm ${settings.aiRecognizeMode === "whole" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => void updateSettings({ aiRecognizeMode: "whole" })}
              >
                整张识别
              </button>
            </div>
            <div className="hint">
              逐题裁剪更稳、适合各种排版；整张识别一次请求识别整张卡，适合标准答题卡，AI 调用次数更少。
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>导出与未确认标记</h2>
        </div>
        <div className="card-body">
          <div className="field">
            <label className="label">还没核对完的格子，导出时怎么显示？</label>
            <div className="row wrap" style={{ gap: 8 }}>
              {(
                [
                  { v: "question", t: "红色问号（默认）" },
                  { v: "blank", t: "留空" },
                  { v: "zero", t: "填 0" },
                  { v: "custom", t: "自定义" },
                ] as Array<{ v: MissingMarkMode; t: string }>
              ).map((opt) => (
                <button
                  key={opt.v}
                  className={`btn ${settings.missingMarkMode === opt.v ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setMissingMode(opt.v)}
                >
                  {opt.t}
                </button>
              ))}
            </div>
            {settings.missingMarkMode === "custom" && (
              <input
                className="input"
                style={{ marginTop: 10, maxWidth: 220 }}
                value={settings.missingMarkCustom}
                onChange={(e) => updateSettings({ missingMarkCustom: e.target.value })}
                placeholder="例如：待核"
              />
            )}
            <div className="hint">
              不管选哪种，应用里都会保留每张答题卡的原始记录，导出的只是当前快照。
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <ListChecks size={17} color="var(--red)" />
          <h2>离线姓名建议</h2>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
            <div style={{ maxWidth: 540 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>按名单顺序自动填姓名（仍需逐张确认）</div>
              <div className="faint small" style={{ lineHeight: 1.7 }}>
                没有 AI Key 或 AI 识别不了姓名时，按拍照顺序从班级名单里依次填入姓名。
                每张答题卡仍会在核对页标为「待确认」，需要你点一下确认；确认前不会算作某个学生的成绩。
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoNameByOrder}
                onChange={(e) => void updateSettings({ autoNameByOrder: e.target.checked })}
              />
              <span className="track" />
              <span className="small muted">{settings.autoNameByOrder ? "已开启" : "关闭"}</span>
            </label>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <HardDrive size={17} color="var(--red)" />
          <h2>完整备份</h2>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
            <div style={{ maxWidth: 500 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>换电脑或重装前，先导出一份完整备份</div>
              <div className="faint small" style={{ lineHeight: 1.7 }}>
                备份文件包含：班级与名单、答题卡模板、全部答题卡图片、识别结果、导出记录。
                <br />
                恢复时会在本机覆盖当前数据；建议先把当前数据也导出一份。
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => void handleBackup()} disabled={backupBusy || restoreBusy}>
                {backupBusy ? <span className="spinner" /> : <Download size={15} />}
                导出备份
              </button>
              <button className="btn btn-secondary" onClick={() => restoreRef.current?.click()} disabled={backupBusy || restoreBusy}>
                {restoreBusy ? <span className="spinner" /> : <Upload size={15} />}
                恢复备份
              </button>
              <input
                ref={restoreRef}
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setRestoreFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          {lastBackup && (
            <div className="notice notice-success" style={{ marginTop: 12 }}>
              <Check size={15} />
              <div>上次导出：{lastBackup}</div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <Database size={17} color="var(--red)" />
          <h2>本地数据</h2>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>数据只保存在这台设备</div>
              <div className="faint small">
                已用 {formatBytes(storage.usage)} · 可用约 {formatBytes(storage.quota)}
              </div>
            </div>
            <button className="btn btn-danger" onClick={() => setConfirmWipe(true)}>
              <Trash2 size={15} />
              清空全部数据
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <BookOpen size={17} color="var(--red)" />
          <h2>使用说明</h2>
        </div>
        <div className="card-body">
          {HELP_ITEMS.map((item) => (
            <details key={item.q} style={{ borderTop: "1px solid var(--line)", padding: "4px 0" }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontWeight: 600,
                  padding: "10px 0",
                  listStylePosition: "inside",
                }}
              >
                {item.q}
              </summary>
              <div className="faint small" style={{ lineHeight: 1.9, paddingBottom: 10, whiteSpace: "pre-line" }}>
                {item.a}
              </div>
            </details>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Info size={17} color="var(--red)" />
          <h2>关于</h2>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ gap: 24, justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 700 }}>ScoreRecognizer · 红分识别</div>
              <div className="faint small" style={{ marginTop: 4 }}>
                版本 {__APP_VERSION__} · 数据保存在本机 · 仅供个人使用
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <a
                className="btn btn-secondary btn-sm"
                href="https://github.com/PassersbyfromChina/ScoreRecognizer"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} />
                GitHub
              </a>
              <a
                className="btn btn-secondary btn-sm"
                href="https://passersbyfromchina.github.io/ScoreRecognizer/"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} />
                产品页
              </a>
            </div>
          </div>
        </div>
      </div>

      {restoreFile && (
        <ConfirmDialog
          title="恢复完整备份"
          message={
            <>
              将用备份文件 <b>{restoreFile.name}</b>（{formatBytes(restoreFile.size)}）覆盖这台设备上现有的全部数据：
              班级、名单、模板、答题卡图片和识别结果都会被替换，确定继续吗？
            </>
          }
          confirmText="覆盖并恢复"
          danger
          onCancel={() => setRestoreFile(null)}
          onConfirm={() => void doRestore(restoreFile)}
        />
      )}

      {confirmWipe && (
        <ConfirmDialog
          title="清空全部数据"
          message="将删除这台设备上的班级、名单、答题卡图片和识别结果，且无法恢复。确定继续吗？"
          confirmText="确认清空"
          danger
          onCancel={() => setConfirmWipe(false)}
          onConfirm={async () => {
            await wipeAll();
            setConfirmWipe(false);
            toast("数据已清空", "ok");
            window.setTimeout(() => window.location.reload(), 400);
          }}
        />
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
