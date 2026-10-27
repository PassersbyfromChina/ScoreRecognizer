import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock3,
  ImagePlus,
  Loader2,
  RefreshCw,
  ScanLine,
  Smartphone,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import type { NavProps } from "../navigation";
import { useAppStore } from "../core/store";
import type { Capture } from "../core/types";
import { deleteCapture, getImageBlob, getImageUrl, listCaptures, putImage, saveCapture } from "../core/storage/repo";
import { processCapture } from "../core/recognition/engine";
import { pickNextStudent } from "../core/recognition/nameMatch";
import { toast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { PhoneLinkModal } from "../components/PhoneLinkModal";
import { isNativeMobile } from "../core/platform";

const STATUS_META: Record<
  Capture["status"],
  { label: string; cls: string; icon: ReactNode }
> = {
  pending_capture: { label: "待拍摄", cls: "badge-gray", icon: <Camera size={13} /> },
  pending_process: { label: "待自动处理", cls: "badge-gray", icon: <Clock3 size={13} /> },
  pending_review: { label: "待确认", cls: "badge-amber", icon: <AlertTriangle size={13} /> },
  done: { label: "已完成", cls: "badge-green", icon: <CheckCircle2 size={13} /> },
};

/** 只有真正的失败才记成错误展示；「没配 Key 用本地识别」等属于提示，不阻塞。 */
function fatalWarning(warnings: string[]): string | undefined {
  const fatal = warnings.filter((w) => /失败|无法|错误/.test(w));
  return fatal.length ? fatal.join("；") : undefined;
}

/** 把浏览器/解码器的英文异常翻成老师能看懂的中文提示。 */
function friendlyProcessError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (!raw) return "自动处理失败，请重试";
  if (/decode|image|bitmap|invalid|corrupt|source image|could not be decoded/i.test(raw)) {
    return "图片无法读取（可能文件已损坏或格式不支持），请删除后重新拍摄 / 上传";
  }
  if (/原始图片不见/.test(raw)) return raw;
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

export function CaptureScreen({ onNavigate }: NavProps) {
  const project = useAppStore((s) => s.project);
  const template = useAppStore((s) => s.template);
  const settings = useAppStore((s) => s.settings);
  const captures = useAppStore((s) => s.captures);
  const refreshCaptures = useAppStore((s) => s.refreshCaptures);

  const [processingId, setProcessingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Capture | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const sorted = useMemo(() => [...captures].sort((a, b) => b.createdAt - a.createdAt), [captures]);
  const queue = useMemo(() => captures.filter((c) => c.status === "pending_process"), [captures]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!project) return;
      if (files.length === 0) return;
      setUploading(true);
      try {
        for (const file of files) {
          const blob = file.slice(0, file.size, file.type || "image/jpeg");
          const imageKey = await putImage(blob);
          const now = Date.now();
          const capture: Capture = {
            id: `cap_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            projectId: project.id,
            createdAt: now,
            updatedAt: now,
            status: "pending_process",
            imageKey,
            answers: [],
          };
          await saveCapture(capture);
        }
        await refreshCaptures();
        toast(`已加入 ${files.length} 张答题卡，自动开始处理`, "ok");
      } catch (e) {
        console.error(e);
        toast("图片保存失败", "err");
      } finally {
        setUploading(false);
      }
    },
    [project, refreshCaptures],
  );

  // 手机端传回的照片：直接落库，进入自动处理队列
  useEffect(() => {
    const bridge = window.desktop;
    if (!bridge) return;
    const off = bridge.lan.onPhoto((payload) => {
      try {
        const raw = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
        let type = "image/jpeg";
        if (/\.png$/i.test(payload.filename)) type = "image/png";
        else if (/\.webp$/i.test(payload.filename)) type = "image/webp";
        const blob = new Blob([raw as unknown as BlobPart], { type });
        const file = new File([blob], payload.filename || "phone.jpg", { type });
        void addFiles([file]);
        toast("手机传来一张答题卡，已加入处理队列", "ok");
      } catch (e) {
        console.error(e);
        toast("手机照片接收失败", "err");
      }
    });
    return off;
  }, [addFiles]);

  // 后台自动处理队列（一次一张，拍完一张处理一张，和拍摄/确认并行）
  // 注意：不要把这个循环绑在 captures 依赖上，否则列表一更新就会打断正在处理的任务。
  const runQueue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      for (;;) {
        const state = useAppStore.getState();
        const project = state.project;
        const template = state.template;
        if (!project || !template) break;
        const list = await listCaptures(project.id);
        const next = list.find((c) => c.status === "pending_process");
        if (!next) break;
        setProcessingId(next.id);
        const startedAt = performance.now();
        // 离线按名单顺序给姓名建议（仅当用户开启；仍会标记为待确认）
        let nameHint: { studentId: string; name: string } | null = null;
        if (state.settings.autoNameByOrder) {
          const others = list.filter(
            (c) => c.id !== next.id && (c.status === "pending_review" || c.status === "done"),
          );
          const candidate = pickNextStudent(project.students, others);
          if (candidate) nameHint = { studentId: candidate.id, name: candidate.name };
        }
        try {
          const blob = next.imageKey ? await getImageBlob(next.imageKey) : undefined;
          if (!blob) throw new Error("原始图片不见了");
          const result = await processCapture(blob, {
            settings: state.settings,
            template,
            students: project.students,
            nameHint,
          });
          const correctedKey = await putImage(result.correctedBlob);
          const updated: Capture = {
            ...next,
            status: "pending_review",
            correctedKey,
            answers: result.answers,
            nameText: result.nameText,
            nameConfidence: result.nameConfidence,
            nameState: result.nameState,
            studentId: result.studentId,
            error: fatalWarning(result.warnings),
          };
          await saveCapture(updated);
        } catch (e) {
          console.error(e);
          await saveCapture({
            ...next,
            status: "pending_review",
            error: friendlyProcessError(e),
          });
        }
        console.warn(`[capture] processed ${next.id} in ${Math.round(performance.now() - startedAt)}ms`);
        await refreshCaptures();
      }
    } finally {
      busyRef.current = false;
      setProcessingId(null);
      await refreshCaptures();
    }
  }, [refreshCaptures]);

  useEffect(() => {
    if (captures.some((c) => c.status === "pending_process")) void runQueue();
  }, [captures, runQueue]);

  async function retry(capture: Capture) {
    const updated: Capture = { ...capture, status: "pending_process", error: undefined, answers: [] };
    await saveCapture(updated);
    await refreshCaptures();
  }

  if (!project) {
    return (
      <div className="page-inner">
        <div className="empty">
          <div className="icon">
            <Camera size={22} />
          </div>
          <div className="title">还没有班级</div>
          <div className="desc">先在首页创建班级、导入名单，再来拍摄答题卡。</div>
        </div>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <div className="card">
          <div className="card-body" style={{ padding: 32 }}>
            <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 13,
                  background: "var(--red-soft)",
                  color: "var(--red)",
                  display: "grid",
                  placeItems: "center",
                  flex: "none",
                }}
              >
                <ScanLine size={22} />
              </div>
              <div>
                <h2 style={{ fontSize: 18, marginBottom: 6 }}>先划分答题卡区域</h2>
                <p className="muted" style={{ lineHeight: 1.8, marginBottom: 16 }}>
                  拍摄前需要知道分数和名字在哪。拍一张答题卡样张，自动摆正后标记题目与姓名区域，之后整套卷子都能复用。
                </p>
                <button className="btn btn-primary" onClick={() => onNavigate("template")}>
                  <ScanLine size={16} />
                  去划分区域
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="titles">
          <h1>拍摄 / 上传答题卡</h1>
          <div className="desc">
            图片实时保存；上传后自动矫正、识别，处理好的会进入「待确认」。已加入 {captures.length} 张
            {processingId ? " · 正在处理 1 张…" : queue.length > 0 ? ` · 队列 ${queue.length} 张` : ""}
          </div>
        </div>
        <div className="actions">
          {window.desktop && (
            <button className="btn btn-secondary" onClick={() => setPhoneOpen(true)}>
              <Smartphone size={16} />
              手机拍摄
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setCameraOpen(true)}>
            <Video size={16} />
            摄像头拍摄
          </button>
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <Upload size={16} />}
            批量上传
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) addFiles(files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {captures.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div
              className="dropzone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
                if (files.length) addFiles(files);
              }}
            >
              <div className="dz-icon">{uploading ? <span className="spinner" /> : <ImagePlus size={22} />}</div>
              <div className="dz-title">{isNativeMobile() ? "点这里拍照或选择答题卡图片" : "把答题卡图片拖到这里，或点击选择"}</div>
              <div className="dz-desc">
                {isNativeMobile()
                  ? "支持一次选多张；也可以用摄像头逐张拍摄，图片会实时保存"
                  : "支持一次选多张；手机与电脑连同一 Wi-Fi 后，点右上「手机拍摄」扫码，手机拍了自动传回电脑"}
              </div>
            </div>
            <div className="notice notice-info" style={{ marginTop: 16 }}>
              <AlertTriangle size={15} />
              <div>
                建议按学生顺序拍摄。识别不清、一题多分、一题没分的会被明确标出来，确认时不会让你漏掉。
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>答题卡</h2>
            <span className="sub">
              待确认 {captures.filter((c) => c.status === "pending_review").length} · 已完成{" "}
              {captures.filter((c) => c.status === "done").length}
            </span>
            <span className="spacer" />
            {queue.length > 0 && (
              <span className="badge badge-amber">
                <Loader2 size={12} className="spin" />
                正在处理…
              </span>
            )}
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 64 }}>图片</th>
                    <th>姓名</th>
                    <th>状态</th>
                    <th className="cap-issue-col">识别情况</th>
                    <th style={{ width: 160, textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => (
                    <CaptureRow
                      key={c.id}
                      capture={c}
                      processing={processingId === c.id}
                      studentName={project.students.find((s) => s.id === c.studentId)?.name}
                      onConfirm={() => onNavigate("review")}
                      onRetry={() => retry(c)}
                      onDelete={() => setDeleteTarget(c)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {cameraOpen && <CameraModal onClose={() => setCameraOpen(false)} onCapture={(files) => addFiles(files)} />}
      {phoneOpen && <PhoneLinkModal onClose={() => setPhoneOpen(false)} />}

      {deleteTarget && (
        <ConfirmDialog
          title="删除这张答题卡"
          message="图片和识别结果会一起删除，无法恢复。确定吗？"
          confirmText="删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deleteCapture(deleteTarget);
            setDeleteTarget(null);
            await refreshCaptures();
            toast("已删除", "ok");
          }}
        />
      )}
    </div>
  );
}

function CaptureRow({
  capture,
  processing,
  studentName,
  onConfirm,
  onRetry,
  onDelete,
}: {
  capture: Capture;
  processing: boolean;
  studentName?: string;
  onConfirm: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    if (capture.imageKey) {
      getImageUrl(capture.imageKey).then((u) => alive && setUrl(u));
    }
    return () => {
      alive = false;
    };
  }, [capture.imageKey]);

  const meta = STATUS_META[capture.status];
  const issues = capture.answers.filter((a) => a.state !== "ok");

  return (
    <tr>
      <td>
        <div className="thumb" style={{ width: 44, height: 56, overflow: "hidden" }}>
          {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        </div>
      </td>
      <td>
        <div style={{ fontWeight: 600 }}>{studentName ?? capture.nameText ?? "未认领"}</div>
        <div className="faint small">{new Date(capture.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
      </td>
      <td>
        {processing ? (
          <span className="badge badge-amber">
            <Loader2 size={12} className="spin" />
            处理中
          </span>
        ) : (
          <span className={`badge ${meta.cls}`}>
            {meta.icon}
            {meta.label}
          </span>
        )}
      </td>
      <td className="cap-issue-col">
        {capture.status === "pending_review" ? (
          capture.error ? (
            <span className="small" style={{ color: "var(--amber)" }}>
              {capture.error}
            </span>
          ) : issues.length > 0 ? (
            <span className="small" style={{ color: "var(--amber)" }}>
              {issues.length} 处需要确认
            </span>
          ) : (
            <span className="small muted">全部识别完成</span>
          )
        ) : (
          <span className="small faint">—</span>
        )}
      </td>
      <td className="actions">
        {capture.status === "pending_review" && (
          <button className="btn btn-sm btn-secondary" onClick={onConfirm}>
            去确认
          </button>
        )}
        <button className="btn btn-icon btn-ghost" title="重新处理" onClick={onRetry}>
          <RefreshCw size={14} />
        </button>
        <button className="btn btn-icon btn-ghost" title="删除" style={{ color: "var(--red)" }} onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

function CameraModal({ onClose, onCapture }: { onClose: () => void; onCapture: (files: File[]) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "无法打开摄像头");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function shoot() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return;
    const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
    onCapture([file]);
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(760px, 100%)" }}>
        <div className="modal-head">
          <h3>拍摄答题卡</h3>
          <span className="spacer" />
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ background: "#0b1220", padding: 12 }}>
          {error ? (
            <div className="notice notice-danger">
              <AlertTriangle size={15} />
              <div>
                无法打开摄像头：{error}
                <br />
                可以先用「批量上传」，或检查系统相机权限。
              </div>
            </div>
          ) : (
            <div style={{ position: "relative", borderRadius: 10, overflow: "hidden" }}>
              <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
              <div
                style={{
                  position: "absolute",
                  left: "6%",
                  right: "6%",
                  top: "50%",
                  height: 2,
                  background: "rgba(244,63,94,.9)",
                  boxShadow: "0 0 10px rgba(244,63,94,.8)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: "6%",
                  right: "6%",
                  top: "50%",
                  transform: "translateY(-50%)",
                  height: 46,
                  borderTop: "1px dashed rgba(255,255,255,.35)",
                  borderBottom: "1px dashed rgba(255,255,255,.35)",
                  pointerEvents: "none",
                }}
              />
              {!ready && (
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#94a3b8" }}>
                  <div className="spinner" />
                </div>
              )}
            </div>
          )}
          <div className="hint" style={{ color: "#94a3b8", marginTop: 10 }}>
            把答题卡放在画面中央，让红色参考线大致落在答题卡中部，一次拍一张。
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={shoot} disabled={!ready}>
            <Camera size={16} />
            拍下这张
          </button>
        </div>
      </div>
    </div>
  );
}
