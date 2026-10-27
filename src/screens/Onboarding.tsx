import { useState } from "react";
import {
  ArrowRight,
  Bot,
  Camera,
  Check,
  FileSpreadsheet,
  Keyboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "../core/store";

const FEATURES = [
  { icon: <Camera size={15} />, text: "拍照识别答题卡上的红笔分数与手写姓名" },
  { icon: <Keyboard size={15} />, text: "键盘或触屏核对，模糊笔迹必须人工确认" },
  { icon: <FileSpreadsheet size={15} />, text: "导入姓名 Excel，一键导出成绩表" },
  { icon: <ShieldCheck size={15} />, text: "名单、图片、结果只保存在本机" },
];

export function Onboarding() {
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  async function finish(withAI: boolean) {
    setBusy(true);
    try {
      await completeOnboarding({
        apiKey: withAI ? apiKey.trim() : "",
        aiEnabled: withAI,
        onboarded: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <aside className="onboard-aside">
          <div className="brand">
            <span className="logo-mark">S</span>
            <div>
              <div className="name">ScoreRecognizer</div>
              <div className="sub">红分识别</div>
            </div>
          </div>
          {FEATURES.map((f) => (
            <div className="feature" key={f.text}>
              {f.icon}
              <span>{f.text}</span>
            </div>
          ))}
          <div style={{ marginTop: "auto", color: "#475569", fontSize: 11.5, lineHeight: 1.7 }}>
            首次使用只需一分钟设置。
            <br />
            之后所有数据都在本机处理。
          </div>
        </aside>

        <div className="onboard-main">
          {step === 0 && (
            <>
              <div className="step-label">第 1 步 / 共 2 步</div>
              <h2>欢迎，先把"眼睛"准备好</h2>
              <p className="lede">
                这个应用不做两件事：不猜、不上传。看不清的分数会停下来等你确认；名单和答题卡图片默认只留在你的电脑或手机里。
              </p>
              <div className="notice notice-info" style={{ marginBottom: 18 }}>
                <Sparkles size={15} />
                <div>
                  下一步可以填写 AI 服务的 key（一串访问密钥），让应用能自动看图。
                  <br />
                  不想用 AI 也可以跳过：分数会改用本地离线识别（姓名手动确认），其他功能照常使用。
                </div>
              </div>
              <div className="spacer" />
              <div className="onboard-actions">
                <button className="btn btn-primary btn-lg" onClick={() => setStep(1)}>
                  开始设置 <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="step-label">第 2 步 / 共 2 步</div>
              <h2>配置识图 AI（可选）</h2>
              <p className="lede">
                目前支持 DeepSeek 的视觉模型。key 只保存在本机，识别时才会随图片一起发给你选择的服务商。
              </p>

              <div className="field">
                <label className="label" htmlFor="apiKey">
                  DeepSeek API Key
                </label>
                <input
                  id="apiKey"
                  className="input"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="hint">
                  在 DeepSeek 开放平台创建 API Key 后粘贴到这里。没有也可以先跳过，之后在「设置」里补填。
                </div>
              </div>

              <div className="row" style={{ marginTop: 4 }}>
                <label className="switch">
                  <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
                  <span className="track" />
                  <span style={{ fontSize: 13 }}>启用 AI 自动识别</span>
                </label>
              </div>

              <div className="spacer" />
              <div className="onboard-actions">
                <button className="btn btn-ghost" onClick={() => finish(false)} disabled={busy}>
                  先跳过，稍后设置
                </button>
                <button className="btn btn-secondary" onClick={() => setStep(0)} disabled={busy}>
                  上一步
                </button>
                <button
                  className="btn btn-primary btn-lg"
                  disabled={busy || (aiEnabled && !apiKey.trim())}
                  onClick={() => finish(aiEnabled)}
                >
                  {busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <Check size={16} />}
                  完成设置
                </button>
              </div>
              <div className="hint" style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center" }}>
                <Bot size={13} />
                以后随时可以在右上角「设置」里修改。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
