import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CheckSquare,
  FileDown,
  Home,
  ScanLine,
  Settings,
  Users,
} from "lucide-react";
import { useAppStore, batchCounts } from "./core/store";
import { isNativeMobile, isWebApp } from "./core/platform";
import type { Screen } from "./navigation";
import { Onboarding } from "./screens/Onboarding";
import { HomeScreen } from "./screens/Home";
import { StudentsScreen } from "./screens/Students";
import { SettingsScreen } from "./screens/Settings";
import { ExportScreen } from "./screens/ExportScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { TemplateScreen } from "./screens/TemplateScreen";
import { CaptureScreen } from "./screens/CaptureScreen";
import { Toaster } from "./components/Toast";

const ALL_SCREENS: Screen[] = ["home", "students", "template", "capture", "review", "export", "settings"];

const NAV: Array<{ key: Screen; label: string; icon: typeof Home }> = [
  { key: "home", label: "首页", icon: Home },
  { key: "students", label: "学生名单", icon: Users },
  { key: "template", label: "区域划分", icon: ScanLine },
  { key: "capture", label: "拍摄 / 上传", icon: Camera },
  { key: "review", label: "核对", icon: CheckSquare },
  { key: "export", label: "导出", icon: FileDown },
];

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const init = useAppStore((s) => s.init);
  const settings = useAppStore((s) => s.settings);
  const project = useAppStore((s) => s.project);
  const captures = useAppStore((s) => s.captures);
  const [screen, setScreen] = useState<Screen>("home");
  const [inited, setInited] = useState(false);
  const screenRef = useRef<Screen>(screen);
  screenRef.current = screen;

  // 切页面时把内容区滚回顶部（手机上避免停在上一页的滚动位置）
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".page");
    if (el) el.scrollTop = 0;
  }, [screen]);

  // Android 返回键：优先关弹窗，其次回首页，再次最小化应用
  useEffect(() => {
    if (!isNativeMobile()) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    void (async () => {
      try {
        const { App: CapApp } = await import("@capacitor/app");
        const handle = await CapApp.addListener("backButton", () => {
          const mask = document.querySelector<HTMLElement>(".modal-mask");
          if (mask) {
            mask.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            return;
          }
          // 内联面板（如名单导入）优先关闭，避免返回键直接跳回首页
          const closeable = document.querySelector<HTMLElement>("[data-back-close]");
          if (closeable) {
            closeable.click();
            return;
          }
          if (screenRef.current !== "home") {
            setScreen("home");
            return;
          }
          void CapApp.minimizeApp();
        });
        if (disposed) void handle.remove();
        else remove = () => void handle.remove();
      } catch (e) {
        console.warn("返回键监听失败", e);
      }
    })();
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  // 网页版：数据存在浏览器里，关闭标签页/刷新前提醒（实时保存也提醒，避免误关丢数据）
  useEffect(() => {
    if (!isWebApp()) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!useAppStore.getState().project) return;
      e.preventDefault();
      e.returnValue = "网页版数据保存在当前浏览器里，关闭前建议先在「导出」或「设置」里备份。";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (inited) return;
    setInited(true);
    void (async () => {
      if (import.meta.env.DEV) {
        // 开发期演示数据：?seed=demo&screen=xxx（生产构建会被移除）
        const dev = await import("./core/dev");
        const devScreen = dev.devScreenParam();
        if (devScreen && ALL_SCREENS.includes(devScreen as Screen)) setScreen(devScreen as Screen);
        await dev.maybeSeedForDev();
      }
      await init();
      // 请求持久化存储，降低浏览器/系统清理本地数据的概率
      try {
        await navigator.storage?.persist?.();
      } catch {
        /* ignore */
      }
    })();
  }, [init, inited]);

  if (!ready) {
    return (
      <div className="center">
        <div className="loading-screen">
          <div className="spinner" />
          <div>正在打开你的本机数据…</div>
        </div>
      </div>
    );
  }

  if (!settings.onboarded) {
    return (
      <>
        <Onboarding />
        <Toaster />
      </>
    );
  }

  const counts = batchCounts(project, captures);
  const badges: Partial<Record<Screen, number>> = {
    capture: counts.pending_capture + counts.pending_process,
    review: counts.pending_review,
  };

  const navigate = (s: Screen) => setScreen(s);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-mark">S</span>
          <div>
            <div className="name">ScoreRecognizer</div>
            <div className="sub">红分识别</div>
          </div>
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => {
            const Icon = item.icon;
            const badge = badges[item.key];
            return (
              <button
                key={item.key}
                className={`nav-item ${screen === item.key ? "active" : ""}`}
                onClick={() => navigate(item.key)}
              >
                <Icon />
                <span>{item.label}</span>
                {badge ? <span className="nav-count">{badge}</span> : null}
              </button>
            );
          })}
          <div className="nav-sep">其他</div>
          <button className={`nav-item ${screen === "settings" ? "active" : ""}`} onClick={() => navigate("settings")}>
            <Settings />
            <span>设置</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="ver">v{__APP_VERSION__} · {isWebApp() ? "网页版 · 数据存浏览器" : "本地保存"}</div>
          <a href="https://github.com/PassersbyfromChina/ScoreRecognizer" target="_blank" rel="noreferrer">
            GitHub 项目页
          </a>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="project-pill">
            <span className="dot" />
            {project ? project.name : "还没有班级"}
          </div>
          <span className="spacer" />
          <div className="status-chips">
            <button className="chip c-capture" onClick={() => navigate("capture")}>
              <span className="dot" />
              待拍摄 <b>{counts.pending_capture}</b>
            </button>
            <button className="chip c-process" onClick={() => navigate("capture")}>
              <span className="dot" />
              待自动处理 <b>{counts.pending_process}</b>
            </button>
            <button className={`chip c-review ${counts.pending_review > 0 ? "hot" : ""}`} onClick={() => navigate("review")}>
              <span className="dot" />
              待确认 <b>{counts.pending_review}</b>
            </button>
            <button className="chip c-done" onClick={() => navigate("export")}>
              <span className="dot" />
              已完成 <b>{counts.done}</b>
            </button>
          </div>
          <button className="btn btn-icon btn-ghost" title="设置" onClick={() => navigate("settings")}>
            <Settings size={17} />
          </button>
        </header>

        <main className="page">
          {screen === "home" && <HomeScreen onNavigate={navigate} />}
          {screen === "students" && <StudentsScreen />}
          {screen === "template" && <TemplateScreen onNavigate={navigate} />}
          {screen === "capture" && <CaptureScreen onNavigate={navigate} />}
          {screen === "review" && <ReviewScreen onNavigate={navigate} />}
          {screen === "export" && <ExportScreen onNavigate={navigate} />}
          {screen === "settings" && <SettingsScreen />}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
