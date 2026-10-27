import { useMemo, useState } from "react";
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  FolderPlus,
  Images,
  Layers,
  ScanLine,
  Users,
} from "lucide-react";
import { useAppStore, captureCounts } from "../core/store";
import type { NavProps } from "../navigation";
import { toast } from "../components/Toast";

export function HomeScreen({ onNavigate }: NavProps) {
  const project = useAppStore((s) => s.project);
  const captures = useAppStore((s) => s.captures);
  const template = useAppStore((s) => s.template);
  const createProject = useAppStore((s) => s.createProject);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => captureCounts(captures), [captures]);
  const studentCount = project?.students.length ?? 0;
  const recent = useMemo(() => [...captures].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6), [captures]);

  const steps = [
    {
      title: "导入学生名单",
      desc: project?.importMeta ? `已导入 ${studentCount} 人` : "从 Excel 读取姓名列",
      done: studentCount > 0,
      go: "students" as const,
    },
    {
      title: "划分答题卡区域",
      desc: template ? `模板：${template.name}` : "拍一张样卡，标记题目与姓名位置",
      done: !!template,
      go: "template" as const,
    },
    {
      title: "拍摄或上传答题卡",
      desc: counts.pending_capture + counts.pending_process > 0 ? "有图片等待处理" : "批量拍摄、批量导入",
      done: captures.length > 0,
      go: "capture" as const,
    },
    {
      title: "核对并导出",
      desc: counts.done > 0 ? `已完成 ${counts.done} 份` : "确认每一分，导出 Excel",
      done: counts.done > 0,
      go: "review" as const,
    },
  ];

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createProject(name.trim());
      toast("班级已创建，下一步导入名单", "ok");
      onNavigate("students");
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <div className="page-inner" style={{ maxWidth: 720, margin: "40px auto" }}>
        <div className="card">
          <div className="card-body" style={{ padding: 36, textAlign: "center" }}>
            <div
              style={{
                width: 62,
                height: 62,
                borderRadius: 18,
                background: "var(--red-soft)",
                color: "var(--red)",
                display: "grid",
                placeItems: "center",
                margin: "0 auto 18px",
              }}
            >
              <FolderPlus size={28} />
            </div>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>先建一个班级</h1>
            <p className="muted" style={{ maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.8 }}>
              一个班级对应一份姓名名单和一套答题卡区域。之后拍的每张答题卡都会归到这个班级里。
            </p>
            <div className="row" style={{ justifyContent: "center", maxWidth: 420, margin: "0 auto" }}>
              <input
                className="input grow"
                placeholder="例如：高二(3)班 · 单元测验"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
              <button className="btn btn-primary" onClick={handleCreate} disabled={!name.trim() || busy}>
                创建
              </button>
            </div>
          </div>
        </div>
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <FileSpreadsheet size={18} color="var(--red)" />
              <div>
                <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 3 }}>名单从 Excel 来</div>
                <div className="faint small" style={{ lineHeight: 1.7 }}>
                  支持「姓名 / 名字」表头，也能手动指定姓名列和开始行。
                </div>
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: 18 }}>
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <Layers size={18} color="var(--red)" />
              <div>
                <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 3 }}>一套答题卡一个模板</div>
                <div className="faint small" style={{ lineHeight: 1.7 }}>
                  答题卡样式不一样也没关系，换一套卷子重新划分一次区域即可。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="hero-card">
        <div className="hc-main">
          <h2>{project.name}</h2>
          <p>
            {studentCount > 0 ? `${studentCount} 名学生` : "还没有学生名单"} ·{" "}
            {template ? "已划分答题卡区域" : "还没有答题卡模板"} · 共 {captures.length} 张答题卡
          </p>
        </div>
        <div className="hc-actions">
          <button className="btn btn-secondary" onClick={() => onNavigate("students")}>
            <Users size={16} />
            学生名单
          </button>
          <button className="btn btn-primary" onClick={() => onNavigate("capture")}>
            <Camera size={16} />
            拍摄 / 上传
          </button>
        </div>
      </div>

      <div className="status-grid">
        <div className="status-card" onClick={() => onNavigate("capture")}>
          <div className="num">{counts.pending_capture}</div>
          <div className="lab">
            <span className="dot" style={{ background: "var(--faint)" }} />
            待拍摄
          </div>
          <div className="ext">已导入但还没有图片</div>
        </div>
        <div className="status-card info" onClick={() => onNavigate("capture")}>
          <div className="num">{counts.pending_process}</div>
          <div className="lab">
            <span className="dot" style={{ background: "var(--blue)" }} />
            待自动处理
          </div>
          <div className="ext">已拍照，等待矫正与识别</div>
        </div>
        <div className={`status-card ${counts.pending_review > 0 ? "warn" : ""}`} onClick={() => onNavigate("review")}>
          <div className="num">{counts.pending_review}</div>
          <div className="lab">
            <span className="dot" style={{ background: "var(--amber)" }} />
            待确认
          </div>
          <div className="ext">识别完成，等你核对</div>
        </div>
        <div className="status-card ok" onClick={() => onNavigate("export")}>
          <div className="num">{counts.done}</div>
          <div className="lab">
            <span className="dot" style={{ background: "var(--green)" }} />
            已完成
          </div>
          <div className="ext">可以随时导出</div>
        </div>
      </div>

      <div className="home-cols">
        <div className="card">
          <div className="card-head">
            <h2>开始使用</h2>
            <span className="sub">按顺序完成即可</span>
          </div>
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
            <div className="steps">
              {steps.map((s, i) => (
                <div
                  key={s.title}
                  className={`step-row ${s.done ? "step-done" : ""}`}
                  onClick={() => onNavigate(s.go)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && onNavigate(s.go)}
                >
                  <div className="step-idx">{s.done ? <CheckCircle2 size={15} /> : i + 1}</div>
                  <div className="grow">
                    <div className="step-title">{s.title}</div>
                    <div className="step-desc">{s.desc}</div>
                  </div>
                  <ArrowRight size={15} className="arrow" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>最近记录</h2>
            <span className="spacer" />
            {captures.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => onNavigate("review")}>
                查看全部 <ArrowRight size={13} />
              </button>
            )}
          </div>
          <div className="card-body" style={{ padding: 12 }}>
            {recent.length === 0 ? (
              <div className="empty" style={{ padding: "34px 16px" }}>
                <div className="icon">
                  <Images size={22} />
                </div>
                <div className="title">还没有答题卡</div>
                <div className="desc">拍摄或上传后，这里会按时间显示每张卡的处理状态。</div>
              </div>
            ) : (
              <div className="recent-list">
                {recent.map((c) => {
                  const student = project.students.find((s) => s.id === c.studentId);
                  return (
                    <div key={c.id} className="recent-item" onClick={() => onNavigate(c.status === "done" ? "review" : "capture")}>
                      <div className="thumb" />
                      <div className="info">
                        <div className="name">{student?.name ?? c.nameText ?? "未认领"}</div>
                        <div className="meta">
                          {statusText(c.status)} · {new Date(c.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                      {c.status === "done" ? (
                        <span className="badge badge-green">已完成</span>
                      ) : c.status === "pending_review" ? (
                        <span className="badge badge-amber">待确认</span>
                      ) : (
                        <span className="badge badge-gray">{statusText(c.status)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusText(status: string) {
  switch (status) {
    case "pending_capture":
      return "待拍摄";
    case "pending_process":
      return "待自动处理";
    case "pending_review":
      return "待确认";
    case "done":
      return "已完成";
    default:
      return status;
  }
}
