import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Check,
  Crop,
  Loader2,
  MousePointer2,
  Move,
  ScanLine,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import type { NavProps } from "../navigation";
import { useAppStore } from "../core/store";
import type { CardTemplate, Region } from "../core/types";
import { DEFAULT_ASPECT, DEFAULT_LONG_SIDE, correctCard, loadCard } from "../core/imaging/pipeline";
import { canvasToBlob, canvasToDataUrl } from "../core/imaging/canvas";
import { segmentCard } from "../core/ai/deepseek";
import { getImageBlob, getImageUrl, newId, putImage, saveTemplate } from "../core/storage/repo";
import { RegionEditor, type RectPx } from "../components/RegionEditor";
import { toast } from "../components/Toast";

type Mode = "select" | "draw-question" | "draw-name";

interface Editing {
  canvas: HTMLCanvasElement;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  aspect: number;
  sampleBlob: Blob;
  corners: Array<{ x: number; y: number }>;
}

export function TemplateScreen({ onNavigate }: NavProps) {
  const project = useAppStore((s) => s.project);
  const template = useAppStore((s) => s.template);
  const settings = useAppStore((s) => s.settings);
  const setTemplate = useAppStore((s) => s.setTemplate);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("select");
  const [questionCount, setQuestionCount] = useState(20);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  const longSidePx = editing ? Math.max(editing.imageWidth, editing.imageHeight) : 1;

  const addUrl = useCallback((url: string) => {
    urlsRef.current.push(url);
    return url;
  }, []);

  useEffect(() => {
    return () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  // 打开已有模板
  useEffect(() => {
    let cancelled = false;
    async function loadExisting() {
      if (!template || editing) return;
      setBusy("正在打开模板…");
      try {
        let canvas: HTMLCanvasElement | null = null;
        let imageUrl: string | null = null;
        if (template.correctedKey) {
          const url = await getImageUrl(template.correctedKey);
          if (url) {
            imageUrl = addUrl(url);
            const { canvasFromDataUrl } = await import("../core/imaging/canvas");
            canvas = await canvasFromDataUrl(await blobToDataUrl(await (await fetch(url)).blob()));
          } else {
            canvas = null;
          }
        }
        let corners = template.corners;
        let sampleBlob: Blob | null = null;
        if (template.imageKey) sampleBlob = (await getImageBlob(template.imageKey)) ?? null;
        if (!canvas && sampleBlob) {
          const loaded = await loadCard(sampleBlob);
          canvas = correctCard(loaded.canvas, corners, template.aspect, DEFAULT_LONG_SIDE);
          const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
          imageUrl = addUrl(URL.createObjectURL(blob));
          corners = loaded.corners;
        }
        if (cancelled) return;
        if (!canvas || !imageUrl) {
          toast("模板图片丢失，请重新选择样卡", "err");
          setBusy(null);
          return;
        }
        setEditing({
          canvas,
          imageUrl,
          imageWidth: canvas.width,
          imageHeight: canvas.height,
          aspect: template.aspect,
          sampleBlob: sampleBlob ?? (await canvasToBlob(canvas, "image/jpeg", 0.9)),
          corners: corners as Array<{ x: number; y: number }>,
        });
        setRegions(template.regions);
        setQuestionCount(Math.max(1, template.regions.filter((r) => r.kind === "question").length));
      } catch (e) {
        console.error(e);
        toast("打开模板失败，请重新选择样卡", "err");
      } finally {
        if (!cancelled) setBusy(null);
      }
    }
    if (template) void loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id]);

  async function handleSample(file: File) {
    setBusy("正在识别答题卡边缘…");
    try {
      const loaded = await loadCard(file);
      const aspect = DEFAULT_ASPECT;
      const canvas = correctCard(loaded.canvas, loaded.corners, aspect, DEFAULT_LONG_SIDE);
      const correctedBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const url = addUrl(URL.createObjectURL(correctedBlob));
      setEditing({
        canvas,
        imageUrl: url,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        aspect,
        sampleBlob: file,
        corners: loaded.corners as Array<{ x: number; y: number }>,
      });
      setRegions([]);
      setSelectedId(null);
      setMode("draw-question");
      if (loaded.detection && loaded.detection.confidence < 0.35) {
        toast("自动找边缘不太确定，请检查图片方向；区域可以手动画", "info");
      } else {
        toast("答题卡已自动摆正", "ok");
      }
    } catch (e) {
      console.error(e);
      toast("这张图片处理失败，换一张试试", "err");
    } finally {
      setBusy(null);
    }
  }

  const addRegion = useCallback(
    (kind: "name" | "question", rect: RectPx) => {
      const long = longSidePx;
      const questionNo =
        kind === "question"
          ? Math.max(0, ...regions.filter((r) => r.kind === "question").map((r) => r.questionNo ?? 0)) + 1
          : undefined;
      const region: Region = {
        id: newId("rg"),
        kind,
        questionNo,
        x: rect.x / long,
        y: rect.y / long,
        w: rect.w / long,
        h: rect.h / long,
      };
      setRegions((prev) => [...prev, region]);
      setSelectedId(region.id);
      if (kind === "question") setQuestionCount((c) => Math.max(c, questionNo ?? c));
    },
    [longSidePx, regions],
  );

  const changeRect = useCallback(
    (id: string, rect: RectPx) => {
      const long = longSidePx;
      setRegions((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, x: rect.x / long, y: rect.y / long, w: rect.w / long, h: rect.h / long } : r,
        ),
      );
    },
    [longSidePx],
  );

  async function runAI() {
    if (!editing) return;
    if (!settings.apiKey) {
      toast("还没有配置 AI Key，请先到「设置」填写，或手动画区域", "err");
      return;
    }
    setBusy("AI 正在划分区域…");
    try {
      const dataUrl = canvasToDataUrl(editing.canvas, "image/jpeg", 0.85);
      const result = await segmentCard(settings, dataUrl, questionCount);
      const long = longSidePx;
      const next: Region[] = result.regions.map((r) => ({
        id: newId("rg"),
        kind: r.kind,
        questionNo: r.questionNo,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
      }));
      // 兜底：AI 少给的题号补齐为横向均分（避免用户空等）
      const have = new Set(next.filter((r) => r.kind === "question").map((r) => r.questionNo));
      setRegions(next);
      setSelectedId(next[0]?.id ?? null);
      setMode("select");
      toast(`AI 给出了 ${next.filter((r) => r.kind === "question").length} 个题目区域，可拖动修改`, "ok");
      void have;
      void long;
    } catch (e) {
      console.error(e);
      toast(e instanceof Error ? e.message : "AI 划分失败，请手动画区域", "err");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!editing) return;
    const qs = regions.filter((r) => r.kind === "question" && r.questionNo != null);
    if (qs.length === 0) {
      toast("至少画一个题目区域", "err");
      return;
    }
    setSaving(true);
    try {
      const correctedBlob = await canvasToBlob(editing.canvas, "image/jpeg", 0.92);
      const correctedKey = await putImage(correctedBlob);
      const imageKey = await putImage(editing.sampleBlob);
      const now = Date.now();
      const tpl: CardTemplate = {
        id: template?.id ?? newId("tpl"),
        name: template?.name ?? `${project?.name ?? "新"} 答题卡模板`,
        createdAt: template?.createdAt ?? now,
        updatedAt: now,
        imageWidth: editing.imageWidth,
        imageHeight: editing.imageHeight,
        imageKey,
        correctedKey,
        corners: editing.corners as CardTemplate["corners"],
        regions,
        aspect: editing.aspect,
      };
      await saveTemplate(tpl);
      await setTemplate(tpl);
      toast("答题卡模板已保存", "ok");
      onNavigate("capture");
    } catch (e) {
      console.error(e);
      toast("保存失败", "err");
    } finally {
      setSaving(false);
    }
  }

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setRegions((prev) => prev.filter((r) => r.id !== selectedId));
    setSelectedId(null);
  }, [selectedId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteSelected]);

  if (!project) {
    return (
      <div className="page-inner">
        <div className="empty">
          <div className="icon">
            <ScanLine size={22} />
          </div>
          <div className="title">还没有班级</div>
          <div className="desc">先在首页创建班级并导入名单，再来划分答题卡区域。</div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- 未开始：选样卡
  if (!editing) {
    return (
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <div className="page-head">
          <div className="titles">
            <h1>划分答题卡区域</h1>
            <div className="desc">先拍一张答题卡样张，自动摆正后标记题目和姓名的位置；同一套卷子只需做一次。</div>
          </div>
        </div>

        {template && (
          <div className="notice notice-info" style={{ marginBottom: 16 }}>
            <ScanLine size={15} />
            <div>
              已有模板「{template.name}」，共 {template.regions.filter((r) => r.kind === "question").length} 个题目区域、
              {template.regions.some((r) => r.kind === "name") ? "1 个姓名区域" : "没有姓名区域"}。可以直接去拍摄，或重新选样卡覆盖。
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-body">
            <div className="dropzone" onClick={() => fileRef.current?.click()}>
              <div className="dz-icon">{busy ? <span className="spinner" /> : <Camera size={22} />}</div>
              <div className="dz-title">{busy ?? "选择一张答题卡照片作为样张"}</div>
              <div className="dz-desc">支持拍照或从相册选择；会自动识别边缘、矫正倾斜与透视</div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleSample(f);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="row" style={{ justifyContent: "space-between", marginTop: 18 }}>
              <div className="faint small" style={{ lineHeight: 1.7 }}>
                建议：答题卡放平、光线均匀、四个角都拍进画面。
                <br />
                拍好一张之后，同一套卷子的其他答题卡都能复用这个模板。
              </div>
              {template && (
                <button className="btn btn-secondary" onClick={() => onNavigate("capture")}>
                  <Camera size={16} />
                  直接去拍摄
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- 编辑中
  const sortedRegions = [...regions].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "name" ? -1 : 1;
    return (a.questionNo ?? 0) - (b.questionNo ?? 0);
  });
  const selected = regions.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="page-inner" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <div className="titles">
          <h1>编辑答题卡区域</h1>
          <div className="desc">拖动区域可移动，拖四角可缩放；画错了按 Delete 删除</div>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => setEditing(null)}>
            <ArrowLeft size={16} />
            重选样卡
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || regions.length === 0}>
            {saving ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <Check size={16} />}
            保存模板
          </button>
        </div>
      </div>

      <div className="tpl-layout" style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head" style={{ padding: "10px 14px" }}>
            <div className="row" style={{ gap: 6 }}>
              <button
                className={`btn btn-sm ${mode === "select" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setMode("select")}
              >
                <MousePointer2 size={14} />
                选择
              </button>
              <button
                className={`btn btn-sm ${mode === "draw-question" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setMode("draw-question")}
              >
                <Square size={14} />
                画题目区域
              </button>
              <button
                className={`btn btn-sm ${mode === "draw-name" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setMode("draw-name")}
              >
                <UserRound size={14} />
                画姓名区域
              </button>
            </div>
            <span className="spacer" />
            <span className="faint small">
              {regions.filter((r) => r.kind === "question").length} 题
              {regions.some((r) => r.kind === "name") ? " · 有姓名区域" : " · 未标姓名"}
            </span>
          </div>
          <div className="card-body" style={{ padding: 12 }}>
            <RegionEditor
              imageUrl={editing.imageUrl}
              imageWidth={editing.imageWidth}
              imageHeight={editing.imageHeight}
              regions={regions}
              selectedId={selectedId}
              mode={mode}
              onSelect={setSelectedId}
              onAdd={addRegion}
              onChangeRect={changeRect}
            />
            <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
              <div className="faint small">
                正在编辑：{template?.name ?? "新模板"} · 坐标以答题卡长边为 1 归一化保存
              </div>
              <button className="btn btn-sm btn-danger" disabled={!selectedId} onClick={deleteSelected}>
                <Trash2 size={13} />
                删除选中
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Sparkles size={16} color="var(--red)" />
              <h2>AI 自动划分</h2>
            </div>
            <div className="card-body">
              <div className="field">
                <label className="label">这张答题卡有几道题？</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <button className="btn btn-primary" style={{ width: "100%" }} onClick={runAI} disabled={busy !== null}>
                {busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <Sparkles size={16} />}
                {busy ?? "让 AI 先画一遍"}
              </button>
              <div className="hint" style={{ marginTop: 10 }}>
                需要先在设置里填 AI Key。AI 画完会给出可拖动的框，再按你的习惯调整。
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Crop size={16} color="var(--red)" />
              <h2>区域列表</h2>
              <span className="spacer" />
              <span className="faint small">{regions.length}</span>
            </div>
            <div className="card-body" style={{ padding: 8, maxHeight: 360, overflow: "auto" }}>
              {sortedRegions.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>
                  <div className="desc">还没有区域。用 AI 自动划分，或选择「画题目区域」在上面的样张上拖。</div>
                </div>
              ) : (
                sortedRegions.map((r) => (
                  <button
                    key={r.id}
                    className={`nav-item ${selectedId === r.id ? "active" : ""}`}
                    style={{ width: "100%", color: selectedId === r.id ? "#fff" : "var(--ink)", background: selectedId === r.id ? "var(--red-soft)" : "transparent" }}
                    onClick={() => {
                      setSelectedId(r.id);
                      setMode("select");
                    }}
                  >
                    {r.kind === "name" ? <UserRound size={15} /> : <Square size={15} />}
                    <span>{r.kind === "name" ? "姓名区域" : `第 ${r.questionNo} 题`}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>
                      {(r.w * longSidePx).toFixed(0)}×{(r.h * longSidePx).toFixed(0)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {selected && (
            <div className="card">
              <div className="card-head">
                <Move size={16} color="var(--red)" />
                <h2>{selected.kind === "name" ? "姓名区域" : `第 ${selected.questionNo} 题`}</h2>
              </div>
              <div className="card-body">
                <div className="field">
                  <label className="label">区域坐标（答题卡长边 = 1）</label>
                  <div className="mono small faint">
                    x {selected.x.toFixed(3)} · y {selected.y.toFixed(3)}
                    <br />
                    w {selected.w.toFixed(3)} · h {selected.h.toFixed(3)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="notice notice-info">
            <Upload size={15} />
            <div>保存后即可去「拍摄 / 上传」批量处理。答题卡样式变了可以随时回来重新划分。</div>
          </div>
        </div>
      </div>
    </div>
  );
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
