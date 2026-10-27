import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Keyboard,
  Loader2,
  Pencil,
  ScanLine,
  Table2,
  UserRound,
  X,
  ZoomIn,
} from "lucide-react";
import type { NavProps } from "../navigation";
import { useAppStore } from "../core/store";
import type { AnswerRecord, AnswerState, Capture, CaptureStatus, CardTemplate, Rect, Region } from "../core/types";
import { getImageUrl, saveCapture } from "../core/storage/repo";
import { matchStudent, rankNameCandidates } from "../core/recognition/nameMatch";
import { toast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import "./review.css";

type ViewMode = "page" | "zoom" | "table";
type Tone = "ok" | "warn" | "miss" | "done";

const STATE_META: Record<AnswerState, { label: string; badge: string }> = {
  ok: { label: "识别正常", badge: "badge-red" },
  low_confidence: { label: "待人工确认", badge: "badge-amber" },
  missing: { label: "未识别到分数", badge: "badge-gray" },
  multiple: { label: "一题多分", badge: "badge-amber" },
  unreviewed: { label: "未核对", badge: "badge-amber" },
  edited: { label: "已人工确认", badge: "badge-green" },
};

const CAPTURE_META: Record<CaptureStatus, { label: string; badge: string }> = {
  pending_capture: { label: "待拍摄", badge: "badge-gray" },
  pending_process: { label: "自动处理中", badge: "badge-amber" },
  pending_review: { label: "待确认", badge: "badge-amber" },
  done: { label: "已完成", badge: "badge-green" },
};

const VIEW_META: Array<{ key: ViewMode; label: string; icon: typeof ScanLine }> = [
  { key: "page", label: "整张试卷", icon: ScanLine },
  { key: "zoom", label: "红笔放大", icon: ZoomIn },
  { key: "table", label: "表格", icon: Table2 },
];

const ZOOM_LEVELS = [1, 2, 3];

// ---------------------------------------------------------------- helpers

function sortAnswers(list: AnswerRecord[]): AnswerRecord[] {
  return [...list].sort((a, b) => a.questionNo - b.questionNo);
}

function reviewOrder(captures: Capture[]): Capture[] {
  return captures
    .filter((c) => c.status === "pending_review" || c.status === "done")
    .sort((a, b) => a.createdAt - b.createdAt);
}

function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

function answerValue(answer: AnswerRecord): string {
  const value = answer.finalScore ?? answer.rawScore;
  return value == null ? "?" : formatScore(value);
}

function answerTone(answer: AnswerRecord): Tone {
  if (answer.finalScore != null) return "done";
  if (answer.state === "missing") return "miss";
  if (answer.state === "ok" && answer.rawScore != null) return "ok";
  return "warn";
}

function stateMeta(answer: AnswerRecord): { label: string; badge: string } {
  if (answer.finalScore != null) return { label: "已确认", badge: "badge-green" };
  return STATE_META[answer.state] ?? STATE_META.unreviewed;
}

/** 姓名区域存在或识别出了姓名时，必须人工认领学生才算确认。 */
function nameNeeded(capture: Capture, template: CardTemplate | null): boolean {
  if (capture.studentId) return false;
  const hasNameRegion = !!template?.regions.some((r) => r.kind === "name");
  return hasNameRegion || !!capture.nameText;
}

function clampUnitRect(rect: Rect): Rect | null {
  if (![rect.x, rect.y, rect.w, rect.h].every((v) => Number.isFinite(v))) return null;
  const w = Math.max(0.004, Math.min(1, rect.w));
  const h = Math.max(0.004, Math.min(1, rect.h));
  return {
    x: Math.max(0, Math.min(1 - w, rect.x)),
    y: Math.max(0, Math.min(1 - h, rect.y)),
    w,
    h,
  };
}

function unionUnitRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

function nextPendingAfter(afterId: string, captures: Capture[]): Capture | undefined {
  const list = reviewOrder(captures);
  if (list.length === 0) return undefined;
  const pos = list.findIndex((c) => c.id === afterId);
  const start = pos >= 0 ? pos : -1;
  for (let i = 1; i <= list.length; i++) {
    const item = list[(start + i + list.length) % list.length];
    if (item.id !== afterId && item.status === "pending_review") return item;
  }
  return undefined;
}

/**
 * 整张试卷上每题标记的位置：优先用真实红笔笔迹包围盒（inkBox），没有再用模板区域。
 * 识别出的 inkBox 偶尔会把相邻题的红笔并进来（变成横跨两列的大框），
 * 尺寸/位置明显异常时回退到模板区域，保证整张试卷上的标记稳定可读。
 */
function pickMarkerRect(answer: AnswerRecord, region: Region | undefined): Rect | null {
  const ink = answer.inkBox ? clampUnitRect(answer.inkBox) : null;
  const reg = region ? clampUnitRect(region) : null;
  if (!ink) return reg;
  if (!reg) return ink;
  const centerX = ink.x + ink.w / 2;
  const centerY = ink.y + ink.h / 2;
  const plausible =
    ink.w <= reg.w * 1.15 &&
    ink.h <= reg.h * 1.6 &&
    ink.x >= reg.x - reg.w * 0.45 &&
    ink.x + ink.w <= reg.x + reg.w * 1.55 &&
    ink.y >= reg.y - reg.h * 0.8 &&
    ink.y + ink.h <= reg.y + reg.h * 1.8 &&
    centerX >= reg.x - reg.w * 1.2 &&
    centerY >= reg.y - reg.h * 1.2;
  return plausible ? ink : reg;
}

function patchAnswer(capture: Capture, questionNo: number, patch: Partial<AnswerRecord>): Capture {
  return {
    ...capture,
    answers: capture.answers.map((a) => (a.questionNo === questionNo ? { ...a, ...patch } : a)),
  };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function useImageUrl(key: string | undefined): { url?: string; loading: boolean } {
  const [state, setState] = useState<{ url?: string; loading: boolean }>({ loading: !!key });
  useEffect(() => {
    let alive = true;
    if (!key) {
      setState({ loading: false });
      return () => {
        alive = false;
      };
    }
    setState({ loading: true });
    getImageUrl(key)
      .then((url) => {
        if (alive) setState({ url, loading: false });
      })
      .catch(() => {
        if (alive) setState({ loading: false });
      });
    return () => {
      alive = false;
    };
  }, [key]);
  return state;
}

/** 从矫正图里裁出当前题区域并放大，画到 canvas 上。 */
function drawZoomCrop(canvas: HTMLCanvasElement, img: HTMLImageElement, unitRect: Rect | null, zoom: number) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const long = Math.max(iw, ih);
  const base = unitRect
    ? {
        x: unitRect.x * long,
        y: unitRect.y * long,
        w: Math.max(6, unitRect.w * long),
        h: Math.max(6, unitRect.h * long),
      }
    : { x: long * 0.1, y: long * 0.14, w: long * 0.8, h: long * 0.55 };

  // 留出上下文（分数常写在框线上方/右侧），zoom 越大裁得越紧
  const scale = zoom <= 1 ? 1 : zoom === 2 ? 0.65 : 0.42;
  const padX = base.w * 0.14;
  const padY = base.h * 0.4;
  let cw = Math.min(iw, Math.max(16, (base.w + padX * 2) * scale));
  let ch = Math.min(ih, Math.max(16, (base.h + padY * 2) * scale));
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  const sx = Math.max(0, Math.min(iw - cw, cx - cw / 2));
  const sy = Math.max(0, Math.min(ih - ch, cy - ch / 2));
  cw = Math.max(2, cw);
  ch = Math.max(2, ch);

  const targetLong = 1400;
  const k = targetLong / Math.max(cw, ch);
  const outW = Math.max(2, Math.round(cw * k));
  const outH = Math.max(2, Math.round(ch * k));
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, outW, outH);
}

// ---------------------------------------------------------------- screen

export function ReviewScreen({ onNavigate }: NavProps) {
  const project = useAppStore((s) => s.project);
  const template = useAppStore((s) => s.template);
  const captures = useAppStore((s) => s.captures);
  const refreshCaptures = useAppStore((s) => s.refreshCaptures);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [view, setView] = useState<ViewMode>("page");
  const [qIndex, setQIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [zoom, setZoom] = useState(1);
  const [lastSaved, setLastSaved] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "warn" | "danger"; text: string } | null>(null);
  const [confirmPassAll, setConfirmPassAll] = useState(false);
  const [nameAttention, setNameAttention] = useState(false);
  const [paperSize, setPaperSize] = useState({ w: 0, h: 0 });
  const [imageVersion, setImageVersion] = useState(0);

  const captureRef = useRef<Capture | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const paperRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const editRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const zoomImg = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reviewList = useMemo(() => reviewOrder(captures), [captures]);
  const students = useMemo(() => [...(project?.students ?? [])].sort((a, b) => a.order - b.order), [project]);
  const questions = useMemo(() => (capture ? sortAnswers(capture.answers) : []), [capture]);
  const safeIndex = Math.min(qIndex, Math.max(0, questions.length - 1));
  const current: AnswerRecord | null = questions[safeIndex] ?? null;
  const confirmedCount = useMemo(() => questions.filter((a) => a.finalScore != null).length, [questions]);
  const passableCount = useMemo(
    () => questions.filter((a) => a.finalScore == null && a.state === "ok" && a.rawScore != null).length,
    [questions],
  );
  const cardPos = reviewList.findIndex((c) => c.id === currentId);
  const cardIndex = cardPos >= 0 ? cardPos + 1 : reviewList.length > 0 ? 1 : 0;
  const student = useMemo(
    () => project?.students.find((s) => s.id === capture?.studentId) ?? null,
    [project, capture?.studentId],
  );

  const regionByNo = useMemo(() => {
    const map = new Map<number, Region>();
    for (const region of template?.regions ?? []) {
      if (region.kind === "question" && region.questionNo != null) map.set(region.questionNo, region);
    }
    return map;
  }, [template]);

  const nameRegion = useMemo(() => template?.regions.find((r) => r.kind === "name") ?? null, [template]);
  const nameCandidates = useMemo(() => {
    if (!capture || !project) return [];
    const usedByOthers = captures
      .filter((c) => c.id !== capture.id && c.studentId)
      .map((c) => c.studentId as string);
    return rankNameCandidates(project.students, capture.nameText, usedByOthers);
  }, [capture, project, captures]);

  const { url: imageUrl, loading: imageLoading } = useImageUrl(capture?.correctedKey ?? capture?.imageKey);

  const focusUnitRect = useMemo(() => {
    if (!current) return null;
    const region = regionByNo.get(current.questionNo);
    const regionRect = region ? clampUnitRect(region) : null;
    const inkRect = current.inkBox ? clampUnitRect(current.inkBox) : null;
    // 红笔常写在答题框外（右侧/上方），把笔迹包围盒并进裁剪范围，放大时能直接看到红字
    if (regionRect && inkRect) {
      const union = unionUnitRects(regionRect, inkRect);
      const w = Math.min(union.w, regionRect.w * 2.6);
      const h = Math.min(union.h, regionRect.h * 3.2);
      return {
        x: union.x + union.w / 2 - w / 2,
        y: union.y + union.h / 2 - h / 2,
        w,
        h,
      };
    }
    return regionRect ?? inkRect;
  }, [current, regionByNo]);

  // 切题/切卡时把本地工作副本同步过来（只跟着 currentId 变，避免被刷新覆盖）
  useEffect(() => {
    if (!currentId) {
      setCapture(null);
      return;
    }
    const found = useAppStore.getState().captures.find((c) => c.id === currentId);
    if (!found) return;
    captureRef.current = found;
    setCapture(found);
    setEditing(false);
    setEditValue("");
    setNotice(null);
    const sorted = sortAnswers(found.answers);
    const firstOpen = sorted.findIndex((a) => a.finalScore == null);
    setQIndex(firstOpen >= 0 ? firstOpen : 0);
  }, [currentId]);

  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  // 首次进入：优先选第一张待确认
  useEffect(() => {
    if (reviewList.length === 0) {
      setCurrentId(null);
      return;
    }
    if (currentId && reviewList.some((c) => c.id === currentId)) return;
    const first = reviewList.find((c) => c.status === "pending_review") ?? reviewList[0];
    setCurrentId(first.id);
  }, [reviewList, currentId]);

  // 整张试卷容器尺寸（标记按像素定位，字号随框大小变化）
  useEffect(() => {
    if (view !== "page") return;
    const el = paperRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      setPaperSize((prev) =>
        Math.abs(prev.w - rect.width) > 0.5 || Math.abs(prev.h - rect.height) > 0.5
          ? { w: rect.width, h: rect.height }
          : prev,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view, imageUrl]);

  // 局部放大用的原图
  useEffect(() => {
    let alive = true;
    zoomImg.current = null;
    if (!imageUrl) {
      setImageVersion((v) => v + 1);
      return () => {
        alive = false;
      };
    }
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      zoomImg.current = img;
      setImageVersion((v) => v + 1);
    };
    img.onerror = () => {
      if (!alive) return;
      zoomImg.current = null;
      setImageVersion((v) => v + 1);
    };
    img.src = imageUrl;
    return () => {
      alive = false;
    };
  }, [imageUrl]);

  // 绘制当前题的局部放大图
  useEffect(() => {
    if (view !== "zoom") return;
    const img = zoomImg.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    drawZoomCrop(canvas, img, focusUnitRect, zoom);
  }, [view, imageVersion, zoom, focusUnitRect]);

  // 编辑输入框出现时自动聚焦并全选
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing, safeIndex, current?.questionNo]);

  // 表格视图：当前行滚到可视区
  useEffect(() => {
    if (view !== "table" || !current) return;
    rowRefs.current.get(current.questionNo)?.scrollIntoView({ block: "nearest" });
  }, [view, safeIndex, current, questions.length]);

  // 姓名高亮自动熄灭
  useEffect(() => {
    if (!nameAttention) return;
    const timer = window.setTimeout(() => setNameAttention(false), 2600);
    return () => window.clearTimeout(timer);
  }, [nameAttention]);

  // ---------------------------------------------------------------- 持久化

  function enqueueSave(next: Capture): Promise<void> {
    const run = saveChain.current
      .catch(() => undefined)
      .then(async () => {
        await saveCapture(next);
        await refreshCaptures();
      })
      .catch((err) => {
        console.error("[review] 保存失败", err);
        toast("保存失败，请重试", "err");
      });
    saveChain.current = run;
    return run;
  }

  async function flushSaves(): Promise<void> {
    try {
      await saveChain.current;
    } catch {
      /* 已在 enqueueSave 里提示 */
    }
  }

  async function commit(mutate: (prev: Capture) => Capture): Promise<Capture | null> {
    const base = captureRef.current;
    if (!base) return null;
    const next = mutate(structuredClone(base));
    next.updatedAt = Date.now();
    captureRef.current = next;
    setCapture(next);
    setLastSaved(Date.now());
    await enqueueSave(next);
    return next;
  }

  // ---------------------------------------------------------------- 操作

  function focusName() {
    setNameAttention(true);
    nameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function assignStudent(studentId: string) {
    const base = captureRef.current;
    if (!base || !studentId || base.studentId === studentId) return;
    await commit((prev) => ({ ...prev, studentId, nameState: "edited" }));
    setNotice(null);
    const picked = project?.students.find((s) => s.id === studentId);
    if (picked) toast(`姓名已确认：${picked.name}`, "ok");
  }

  function goCard(delta: number) {
    void (async () => {
      await flushSaves();
      setEditing(false);
      setEditValue("");
      const list = reviewOrder(useAppStore.getState().captures);
      const pos = list.findIndex((c) => c.id === currentId);
      if (pos < 0) return;
      const target = list[pos + delta];
      if (target) setCurrentId(target.id);
    })();
  }

  function selectQuestion(questionNo: number) {
    const idx = questions.findIndex((q) => q.questionNo === questionNo);
    if (idx < 0) return;
    setQIndex(idx);
    setEditing(false);
    setEditValue("");
  }

  function moveQuestion(delta: number) {
    if (questions.length === 0) return;
    setEditing(false);
    setEditValue("");
    setQIndex((prev) => Math.max(0, Math.min(questions.length - 1, Math.min(prev, questions.length - 1) + delta)));
  }

  function beginEdit(answer: AnswerRecord | null | undefined) {
    if (!answer) return;
    const idx = questions.findIndex((q) => q.questionNo === answer.questionNo);
    if (idx >= 0) setQIndex(idx);
    setEditing(true);
    setEditValue(
      answer.finalScore != null
        ? formatScore(answer.finalScore)
        : answer.rawScore != null
          ? formatScore(answer.rawScore)
          : "",
    );
    setNotice(null);
  }

  function startEdit() {
    beginEdit(current);
  }

  function cancelEdit() {
    setEditing(false);
    setEditValue("");
  }

  function advanceAfterResolved(questionNo: number) {
    const idx = questions.findIndex((q) => q.questionNo === questionNo);
    if (idx >= 0 && idx < questions.length - 1) {
      setQIndex(idx + 1);
      return;
    }
    void finishCard();
  }

  async function passAt(questionNo: number) {
    const base = captureRef.current;
    if (!base) return;
    const sorted = sortAnswers(base.answers);
    const idx = sorted.findIndex((q) => q.questionNo === questionNo);
    if (idx < 0) return;
    const answer = sorted[idx];
    if (answer.finalScore == null) {
      const autoPass = answer.state === "ok" && answer.rawScore != null;
      if (!autoPass) {
        beginEdit(answer);
        toast("这题需要人工确认，请输入分数", "info");
        return;
      }
      await commit((prev) => patchAnswer(prev, questionNo, { finalScore: answer.rawScore, state: "edited" }));
    }
    setEditing(false);
    setEditValue("");
    setNotice(null);
    if (idx < sorted.length - 1) setQIndex(idx + 1);
    else void finishCard();
  }

  async function passCurrent() {
    if (current) {
      await passAt(current.questionNo);
      return;
    }
    if (questions.length === 0) toast("这张答题卡还没有识别结果", "err");
  }

  /** 把本张卡里所有「识别正常」的题按识别值一次通过；缺分/看不清/一题多分保持不动。 */
  async function passAllNormal() {
    const base = captureRef.current;
    if (!base) return;
    const count = base.answers.filter(
      (a) => a.finalScore == null && a.state === "ok" && a.rawScore != null,
    ).length;
    setConfirmPassAll(false);
    if (count === 0) {
      toast("这张卡没有可以自动通过的题", "info");
      return;
    }
    await commit((prev) => ({
      ...prev,
      answers: prev.answers.map((a) =>
        a.finalScore == null && a.state === "ok" && a.rawScore != null
          ? { ...a, finalScore: a.rawScore, state: "edited" as const }
          : a,
      ),
    }));
    setNotice(null);
    toast(`已按识别值通过 ${count} 道正常题，其余仍需人工确认`, "ok");
  }

  async function confirmEdit() {
    const answer = current;
    if (!answer) return;
    const normalized = editValue.trim().replace(/[−–—]/g, "-").replace(/，/g, ".");
    if (!normalized) {
      toast("请输入分数", "err");
      return;
    }
    if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
      toast("只支持数字，可带负号（例：8、-2、7.5）", "err");
      return;
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) {
      toast("分数格式不正确", "err");
      return;
    }
    await commit((prev) => patchAnswer(prev, answer.questionNo, { finalScore: value, state: "edited" }));
    setEditing(false);
    setEditValue("");
    setNotice(null);
    advanceAfterResolved(answer.questionNo);
  }

  async function finishCard() {
    const base = captureRef.current;
    if (!base) return;
    if (base.status === "done") {
      toast("这张答题卡已经核对完成", "info");
      return;
    }
    const sorted = sortAnswers(base.answers);
    if (sorted.length === 0) {
      toast("这张答题卡还没有识别结果，无法完成", "err");
      setNotice({
        kind: "danger",
        text: "这张答题卡没有识别结果（answers 为空），请回到「拍摄 / 上传」重新处理。",
      });
      return;
    }
    const missing = sorted.filter((a) => a.finalScore == null);
    const needName = students.length > 0 && nameNeeded(base, template);
    if (missing.length > 0 || needName) {
      const total = missing.length + (needName ? 1 : 0);
      const detail = [
        ...(needName ? ["姓名未确认"] : []),
        ...missing.slice(0, 3).map((a) => `第 ${a.questionNo} 题未确认`),
        ...(missing.length > 3 ? [`等共 ${missing.length} 道题`] : []),
      ].join("、");
      setNotice({ kind: "warn", text: `还有 ${total} 处未确认：${detail}。全部确认后才能完成整张。` });
      toast(`还有 ${total} 处未确认`, "err");
      if (needName) {
        focusName();
      } else {
        const first = missing[0];
        const idx = sorted.findIndex((a) => a.questionNo === first.questionNo);
        setQIndex(idx);
        setEditing(false);
        stageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return;
    }
    const done = await commit((prev) => ({ ...prev, status: "done", confirmedAt: Date.now() }));
    if (!done) return;
    setEditing(false);
    setNotice(null);
    toast("这张答题卡已核对完成", "ok");
    const next = nextPendingAfter(done.id, useAppStore.getState().captures);
    if (next) setCurrentId(next.id);
    else setNotice({ kind: "info", text: "所有答题卡都核对完成了，可以到左侧「导出」生成成绩表。" });
  }

  function onEditKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void confirmEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  }

  // 全局键盘：Tab / ↑↓ 切题，Enter 通过/继续，Backspace·Delete 修改，Esc 取消
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case "Tab":
          event.preventDefault();
          moveQuestion(event.shiftKey ? -1 : 1);
          break;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          moveQuestion(1);
          break;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveQuestion(-1);
          break;
        case "Enter":
          event.preventDefault();
          void passCurrent();
          break;
        case "Backspace":
        case "Delete":
          event.preventDefault();
          startEdit();
          break;
        case "Escape":
          if (editing) {
            event.preventDefault();
            cancelEdit();
          } else {
            setNotice(null);
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---------------------------------------------------------------- 派生展示数据

  const markers = useMemo(() => {
    if (paperSize.w < 2 || paperSize.h < 2) return [];
    const long = Math.max(paperSize.w, paperSize.h);
    const list: Array<{
      answer: AnswerRecord;
      x: number;
      y: number;
      w: number;
      h: number;
      fontSize: number;
      showNo: boolean;
      tone: Tone;
    }> = [];
    for (const answer of questions) {
      const unit = pickMarkerRect(answer, regionByNo.get(answer.questionNo));
      if (!unit) continue;
      let w = Math.max(18, unit.w * long);
      let h = Math.max(16, unit.h * long);
      w = Math.min(w, paperSize.w);
      h = Math.min(h, paperSize.h);
      const rawX = unit.x * long + (unit.w * long - w) / 2;
      const rawY = unit.y * long + (unit.h * long - h) / 2;
      list.push({
        answer,
        x: Math.max(0, Math.min(paperSize.w - w, rawX)),
        y: Math.max(0, Math.min(paperSize.h - h, rawY)),
        w,
        h,
        fontSize: Math.max(9, Math.min(26, Math.min(w, h) * 0.44)),
        showNo: w >= 44 && h >= 28,
        tone: answerTone(answer),
      });
    }
    list.sort((a, b) => b.w * b.h - a.w * a.h);
    return list;
  }, [questions, regionByNo, paperSize]);

  const nameMark = useMemo(() => {
    if (!nameRegion || paperSize.w < 2) return null;
    const unit = clampUnitRect(nameRegion);
    if (!unit) return null;
    const long = Math.max(paperSize.w, paperSize.h);
    const w = Math.max(34, Math.min(paperSize.w, unit.w * long));
    const h = Math.max(18, Math.min(paperSize.h, unit.h * long));
    return {
      x: Math.max(0, Math.min(paperSize.w - w, unit.x * long)),
      y: Math.max(0, Math.min(paperSize.h - h, unit.y * long)),
      w,
      h,
      fontSize: Math.max(9, Math.min(18, Math.min(w, h) * 0.4)),
    };
  }, [nameRegion, paperSize]);

  const pendingProcessCount = captures.filter((c) => c.status === "pending_process").length;

  // ---------------------------------------------------------------- 空状态

  if (!project) {
    return (
      <div className="page-inner">
        <div className="empty">
          <div className="icon">
            <CheckCircle2 size={22} />
          </div>
          <div className="title">还没有班级</div>
          <div className="desc">先在首页创建班级、导入名单，再来核对答题卡。</div>
        </div>
      </div>
    );
  }

  if (reviewList.length === 0) {
    return (
      <div className="page-inner">
        <div className="page-head">
          <div className="titles">
            <h1>核对答题卡</h1>
            <div className="desc">确认每道题的分数与姓名，所有修改立即保存在本机。</div>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="empty">
              <div className="icon">
                <CheckCircle2 size={22} />
              </div>
              <div className="title">暂时没有需要核对的答题卡</div>
              <div className="desc">
                先在「拍摄 / 上传」里添加答题卡并自动识别；处理完成的会出现在这里。
                {pendingProcessCount > 0 ? ` 现有 ${pendingProcessCount} 张正在自动处理，稍等片刻。` : ""}
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={() => onNavigate("capture")}>
                  去拍摄 / 上传
                </button>
                <button className="btn btn-secondary" onClick={() => onNavigate("export")}>
                  去导出
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!capture) {
    return (
      <div className="page-inner">
        <div className="loading-screen">
          <div className="spinner" />
          <div>正在载入答题卡…</div>
        </div>
      </div>
    );
  }

  const captureMeta = CAPTURE_META[capture.status];
  const currentMeta = current ? stateMeta(current) : STATE_META.unreviewed;
  const currentTone = current ? answerTone(current) : "warn";
  const bigValue = current ? answerValue(current) : "?";
  const canAutoPass = current ? current.finalScore != null || (current.state === "ok" && current.rawScore != null) : false;
  const progressPct = questions.length > 0 ? Math.round((confirmedCount / questions.length) * 100) : 0;
  const nameLabel = student?.name ?? (capture.studentId ? "名单中找不到该学生" : capture.nameText ? `识别为「${capture.nameText}」` : "未识别到姓名");

  return (
    <div className="page-inner rv-page">
      <div className="page-head">
        <div className="titles">
          <h1>核对答题卡</h1>
          <div className="desc">
            确认每道题的分数与姓名，修改会立即保存。
            <span className="rv-kbd-hint">
              用 <span className="kbd">Tab</span> / <span className="kbd">↑↓</span> 切题，
              <span className="kbd">Enter</span> 通过，<span className="kbd">Backspace</span> 修改。
            </span>
            <span className="rv-touch-hint" style={{ display: "none" }}>
              点数字即可修改；改完按「继续」通过。
            </span>
          </div>
        </div>
        <div className="actions" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {passableCount > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setConfirmPassAll(true)}
              title="把这张卡里「识别正常」的题按识别值全部通过，没识别到/看不清的题不会动"
            >
              <CheckCheck size={15} />
              通过正常题（{passableCount}）
            </button>
          ) : null}
          <div className="rv-tabs" role="tablist" aria-label="核对视图">
            {VIEW_META.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={view === item.key}
                  className={`rv-tab ${view === item.key ? "active" : ""}`}
                  onClick={() => setView(item.key)}
                >
                  <Icon />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={`card rv-bar ${nameAttention ? "is-attn" : ""}`}>
        <div className="rv-cardtop">
          <div className="rv-cardnav">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => goCard(-1)}
              disabled={cardIndex <= 1}
              title="上一张答题卡"
            >
              <ChevronLeft size={14} />
              上一张
            </button>
            <div className="rv-cardcount" title="待确认 + 已完成（可浏览）的答题卡">
              第 <b>{cardIndex}</b> / {reviewList.length} 张
              <span className="rv-countsep" />
              <span className={`badge ${captureMeta.badge}`}>{captureMeta.label}</span>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => goCard(1)}
              disabled={cardIndex >= reviewList.length}
              title="下一张答题卡"
            >
              下一张
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="rv-progress">
            <span>
              已确认 <b>{confirmedCount}</b> / {questions.length} 题
            </span>
            <div className="rv-progress-bar" aria-hidden="true">
              <span style={{ width: `${progressPct}%` }} />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary rv-finish"
            onClick={() => void finishCard()}
            disabled={capture.status === "done"}
          >
            {capture.status === "done" ? (
              <>
                <CheckCircle2 size={16} />
                已完成
              </>
            ) : (
              <>
                <Check size={16} />
                完成整张
              </>
            )}
          </button>
        </div>

        <div className={`rv-namerow ${nameAttention ? "is-attn" : ""}`} ref={nameRef}>
          <span className="rv-field-label">
            <UserRound size={15} />
            姓名
          </span>
          <div className="rv-name-main">
            {student ? (
              <>
                <b>{student.name}</b>
                <span className="badge badge-green">
                  <CheckCircle2 size={11} />
                  已确认
                </span>
              </>
            ) : (
              <>
                <span className={`rv-recog-name ${capture.nameText || capture.studentId ? "" : "is-empty"}`}>{nameLabel}</span>
                <span
                  className={`badge ${
                    students.length === 0 ? "badge-gray" : nameRegion || capture.nameText ? "badge-amber" : "badge-gray"
                  }`}
                >
                  {students.length === 0 ? "名单为空" : nameRegion || capture.nameText ? "待确认" : "无需确认"}
                </span>
              </>
            )}
          </div>
          {!student && nameCandidates.length > 0 ? (
            <div className="rv-cands">
              <span className="faint small">可能是</span>
              {nameCandidates.map((cand) => (
                <button
                  key={cand.studentId}
                  type="button"
                  className="rv-cand"
                  onClick={() => void assignStudent(cand.studentId)}
                  title={`姓名匹配度 ${Math.round(cand.score * 100)}%`}
                >
                  {cand.name}
                  <small>{Math.round(cand.score * 100)}%</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="rv-name-pick">
            {students.length === 0 ? (
              <span className="faint small">还没有学生名单，先到「学生名单」导入后再核对姓名</span>
            ) : (
              <select
                className="select rv-select"
                value={capture.studentId ?? ""}
                onChange={(event) => {
                  if (event.target.value) void assignStudent(event.target.value);
                }}
                aria-label="从班级名单选择姓名"
              >
                <option value="" disabled>
                  从名单选择…
                </option>
                {students.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {notice ? (
        <div className={`notice notice-${notice.kind} rv-notice`}>
          <AlertTriangle size={15} />
          <div>{notice.text}</div>
        </div>
      ) : null}

      {capture.error ? (
        <div className="notice notice-warn rv-notice">
          <AlertTriangle size={15} />
          <div>自动处理的提示：{capture.error}</div>
        </div>
      ) : null}

      <div className={`rv-grid ${questions.length === 0 ? "is-single" : ""}`}>
        <section className="card rv-stage" ref={stageRef}>
          <div className="card-head rv-stage-head">
            <h2>
              {view === "page" ? <ScanLine size={16} color="var(--red)" /> : null}
              {view === "zoom" ? <ZoomIn size={16} color="var(--red)" /> : null}
              {view === "table" ? <Table2 size={16} color="var(--red)" /> : null}
              {view === "page" ? "整张试卷" : view === "zoom" ? "红笔局部放大" : "表格核对"}
            </h2>
            <span className="sub rv-stage-sub">
              {view === "page"
                ? "点击题号定位，再点一次进入修改"
                : view === "zoom"
                  ? `第 ${current?.questionNo ?? "—"} 题区域放大`
                  : "点击数字可直接修改分数"}
            </span>
            <span className="spacer" />
            {view === "zoom" ? (
              <div className="rv-zoombar" role="group" aria-label="放大倍数">
                {ZOOM_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={zoom === level ? "active" : ""}
                    onClick={() => setZoom(level)}
                  >
                    {level}×
                  </button>
                ))}
              </div>
            ) : null}
            <div className="rv-qmove">
              <button
                type="button"
                className="btn btn-sm btn-secondary rv-qmove-btn"
                onClick={() => moveQuestion(-1)}
                disabled={safeIndex <= 0}
                title="上一题（Tab / ↑）"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="rv-qpos">
                {questions.length > 0 ? `${safeIndex + 1} / ${questions.length}` : "0 / 0"}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-secondary rv-qmove-btn"
                onClick={() => moveQuestion(1)}
                disabled={safeIndex >= questions.length - 1}
                title="下一题（Tab / ↓）"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          <div className={`rv-stage-body rv-stage-body-${view}`}>
            {questions.length === 0 ? (
              <div className="rv-blank">
                <div className="empty">
                  <div className="icon">
                    <ImageOff size={22} />
                  </div>
                  <div className="title">这张答题卡还没有识别结果</div>
                  <div className="desc">
                    {capture.error
                      ? `自动处理失败：${capture.error}`
                      : "识别结果为空（answers 为空），可能是自动处理失败，或模板没有划分题目区域。"}
                    <br />
                    可以回到「拍摄 / 上传」重新处理这张卡，或先核对其他答题卡。
                  </div>
                  <div className="row" style={{ marginTop: 16 }}>
                    <button className="btn btn-primary" onClick={() => onNavigate("capture")}>
                      去重新处理
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => goCard(1)}
                      disabled={cardIndex >= reviewList.length}
                    >
                      看下一张
                    </button>
                  </div>
                </div>
              </div>
            ) : view === "page" ? (
              <div className="rv-paper-wrap">
                {imageUrl ? (
                  <div className="rv-paper" ref={paperRef}>
                    <img src={imageUrl} alt={`第 ${cardIndex} 张答题卡`} draggable={false} />
                    <div className="rv-overlay">
                      {nameMark ? (
                        <button
                          type="button"
                          className="rv-name-mark"
                          style={{
                            left: nameMark.x,
                            top: nameMark.y,
                            width: nameMark.w,
                            height: nameMark.h,
                            fontSize: nameMark.fontSize,
                          }}
                          onClick={focusName}
                          title="姓名区域：点击去确认姓名"
                        >
                          {student?.name ?? capture.nameText ?? "姓名?"}
                        </button>
                      ) : null}
                      {markers.map((mark) => {
                        const selected = current?.questionNo === mark.answer.questionNo;
                        const meta = stateMeta(mark.answer);
                        return (
                          <button
                            key={mark.answer.questionNo}
                            type="button"
                            className={`rv-mark rv-mark-${mark.tone} ${selected ? "is-selected" : ""} ${mark.showNo ? "" : "is-tiny"}`}
                            style={{
                              left: mark.x,
                              top: mark.y,
                              width: mark.w,
                              height: mark.h,
                              fontSize: mark.fontSize,
                            }}
                            onClick={() => {
                              if (selected) beginEdit(mark.answer);
                              else selectQuestion(mark.answer.questionNo);
                            }}
                            title={`第 ${mark.answer.questionNo} 题 · 识别值 ${formatScore(mark.answer.rawScore)} · ${meta.label}`}
                            aria-label={`第 ${mark.answer.questionNo} 题，识别值 ${answerValue(mark.answer)}，${meta.label}`}
                          >
                            {mark.showNo ? <span className="rv-mark-no">{mark.answer.questionNo}</span> : null}
                            <span className="rv-mark-val">{answerValue(mark.answer)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : imageLoading ? (
                  <div className="rv-imgnone">
                    <Loader2 size={20} className="spin" />
                    正在加载答题卡图片…
                  </div>
                ) : (
                  <div className="rv-imgnone">
                    <ImageOff size={20} />
                    这张答题卡没有可显示的原图，无法浏览整张试卷；可以用表格视图核对。
                  </div>
                )}
              </div>
            ) : view === "zoom" ? (
              <div className="rv-zoom-wrap">
                {imageUrl ? (
                  <>
                    <canvas ref={canvasRef} className="rv-zoom-canvas" aria-label="当前题的局部放大" />
                    <div className="rv-zoom-caption">
                      <span>
                        第 <b>{current?.questionNo ?? "—"}</b> 题
                      </span>
                      <span className="muted">
                        识别值 {current ? (current.rawScore == null ? "—" : formatScore(current.rawScore)) : "—"}
                      </span>
                      <span className={`badge ${currentMeta.badge}`}>{currentMeta.label}</span>
                      <span className="faint small">从矫正图裁出题目区域并放大，可切换 1× / 2× / 3×</span>
                    </div>
                  </>
                ) : imageLoading ? (
                  <div className="rv-imgnone">
                    <Loader2 size={20} className="spin" />
                    正在加载答题卡图片…
                  </div>
                ) : (
                  <div className="rv-imgnone">
                    <ImageOff size={20} />
                    没有可用的矫正图，无法做局部放大。
                  </div>
                )}
              </div>
            ) : (
              <div className="rv-table-wrap">
                <table className="tbl rv-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>题号</th>
                      <th style={{ width: 110 }}>识别值</th>
                      <th style={{ width: 110 }}>最终值</th>
                      <th>状态</th>
                      <th style={{ width: 160, textAlign: "right" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((answer) => {
                      const meta = stateMeta(answer);
                      const isCurrent = current?.questionNo === answer.questionNo;
                      return (
                        <tr
                          key={answer.questionNo}
                          ref={(element) => {
                            if (element) rowRefs.current.set(answer.questionNo, element);
                            else rowRefs.current.delete(answer.questionNo);
                          }}
                          className={`${isCurrent ? "is-current" : ""} rv-row-${answerTone(answer)}`}
                          onClick={() => selectQuestion(answer.questionNo)}
                        >
                          <td>
                            <span className="rv-qno">{answer.questionNo}</span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="rv-numbtn"
                              title="点击修改分数"
                              onClick={(event) => {
                                event.stopPropagation();
                                beginEdit(answer);
                              }}
                            >
                              {answer.rawScore == null ? <span className="faint">—</span> : formatScore(answer.rawScore)}
                            </button>
                          </td>
                          <td>
                            <button
                              type="button"
                              className={`rv-numbtn ${answer.finalScore == null ? "is-unset" : ""}`}
                              title="点击修改分数"
                              onClick={(event) => {
                                event.stopPropagation();
                                beginEdit(answer);
                              }}
                            >
                              {answer.finalScore == null ? "待确认" : formatScore(answer.finalScore)}
                            </button>
                          </td>
                          <td>
                            <span className={`badge ${meta.badge}`}>{meta.label}</span>
                            <div className="rv-cell-sub">
                              置信度 {Math.round(answer.confidence * 100)}%
                              {answer.note ? ` · ${answer.note}` : ""}
                            </div>
                          </td>
                          <td className="actions" onClick={(event) => event.stopPropagation()}>
                            <button type="button" className="btn btn-sm btn-secondary" onClick={() => beginEdit(answer)}>
                              <Pencil size={13} />
                              修改
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void passAt(answer.questionNo)}
                              disabled={answer.finalScore == null && !(answer.state === "ok" && answer.rawScore != null)}
                              title={
                                answer.finalScore == null && !(answer.state === "ok" && answer.rawScore != null)
                                  ? "这题需要人工输入分数"
                                  : "通过并切到下一题"
                              }
                            >
                              通过
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rv-stage-foot">
            {view === "page" ? (
              <div className="rv-legend">
                <span>
                  <i className="rv-dot tone-ok" />
                  识别正常
                </span>
                <span>
                  <i className="rv-dot tone-warn" />
                  待人工确认
                </span>
                <span>
                  <i className="rv-dot tone-miss" />
                  缺失
                </span>
                <span>
                  <i className="rv-dot tone-done" />
                  已确认
                </span>
              </div>
            ) : (
              <div className="faint small">
                <Keyboard size={13} style={{ display: "inline-block", verticalAlign: "-2px", marginRight: 4 }} />
                {view === "zoom" ? "Esc 退出修改 · Enter 通过当前题" : "点击任意数字可直接修改该题分数"}
              </div>
            )}
            <span className="grow" />
            <div className="rv-saved">
              <CheckCircle2 size={13} />
              {lastSaved ? `已自动保存 · ${formatTime(lastSaved)}` : "修改会自动保存"}
            </div>
          </div>
        </section>

        {questions.length > 0 ? (
          <aside className="rv-side">
            <div className="card rv-side-card">
              <div className="card-head">
                <h2>第 {current?.questionNo ?? "—"} 题</h2>
                <span className="spacer" />
                <span className={`badge ${currentMeta.badge}`}>{currentMeta.label}</span>
              </div>
              <div className="card-body">
                {current ? (
                  <>
                    <button
                      type="button"
                      className="rv-score-box"
                      onClick={startEdit}
                      disabled={editing}
                      title="点击修改分数"
                    >
                      <span className={`rv-score-big ${current.finalScore == null && current.rawScore == null ? "is-unset" : ""}`}>
                        {bigValue}
                        {current.finalScore != null && currentTone === "done" ? " 分" : ""}
                      </span>
                      <span className="rv-score-cap">
                        {current.finalScore != null ? "最终得分（点击修改）" : current.rawScore != null ? "识别值（点击修改）" : "未识别到分数"}
                      </span>
                    </button>

                    {editing ? (
                      <div className="rv-edit">
                        <label className="label" htmlFor="rv-score-input">
                          输入最终分数（可负，支持小数）
                        </label>
                        <input
                          id="rv-score-input"
                          ref={editRef}
                          className="input rv-edit-input"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          spellCheck={false}
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          onKeyDown={onEditKeyDown}
                          placeholder="例如 8 或 -2"
                        />
                        <div className="rv-edit-actions">
                          <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
                            <X size={15} />
                            取消
                            <span className="kbd">Esc</span>
                          </button>
                          <button type="button" className="btn btn-primary" onClick={() => void confirmEdit()}>
                            <Check size={15} />
                            确认
                            <span className="kbd">Enter</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="rv-meta-rows">
                          <div className="rv-meta-row">
                            <span>识别原始值</span>
                            <b>{current.rawScore == null ? "未识别" : `${formatScore(current.rawScore)} 分`}</b>
                          </div>
                          <div className="rv-meta-row">
                            <span>识别置信度</span>
                            <b>{Math.round(current.confidence * 100)}%</b>
                          </div>
                          <div className="rv-meta-row">
                            <span>最终值</span>
                            <b className={current.finalScore == null ? "rv-unset" : ""}>
                              {current.finalScore == null ? "未确认" : `${formatScore(current.finalScore)} 分`}
                            </b>
                          </div>
                        </div>
                        {current.note ? (
                          <div className="notice notice-warn rv-note-box">
                            <AlertTriangle size={14} />
                            <div>{current.note}</div>
                          </div>
                        ) : null}
                        <div className="rv-actions">
                          <button type="button" className="btn btn-secondary" onClick={startEdit}>
                            <Pencil size={15} />
                            修改
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => void passCurrent()}
                            title={canAutoPass ? "通过当前题并继续（Enter）" : "这题需要人工输入分数（Enter）"}
                          >
                            <Check size={15} />
                            继续
                          </button>
                        </div>
                      </>
                    )}

                    <div className="rv-kb-hints">
                      <span>
                        <span className="kbd">Enter</span>通过并继续
                      </span>
                      <span>
                        <span className="kbd">⌫</span>修改
                      </span>
                      <span>
                        <span className="kbd">Tab</span>切题
                      </span>
                      <span>
                        <span className="kbd">Esc</span>取消
                      </span>
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div className="card rv-side-card">
              <div className="card-head">
                <h3>题目导航</h3>
                <span className="spacer" />
                <span className="sub">
                  {confirmedCount} / {questions.length} 已确认
                </span>
              </div>
              <div className="card-body">
                <div className="rv-qgrid">
                  {questions.map((answer) => {
                    const isCurrent = current?.questionNo === answer.questionNo;
                    return (
                      <button
                        key={answer.questionNo}
                        type="button"
                        className={`rv-qbtn tone-${answerTone(answer)} ${isCurrent ? "is-current" : ""}`}
                        onClick={() => selectQuestion(answer.questionNo)}
                        title={`第 ${answer.questionNo} 题 · ${stateMeta(answer).label}`}
                      >
                        {answer.questionNo}
                      </button>
                    );
                  })}
                </div>
                <div className="rv-legend rv-legend-grid">
                  <span>
                    <i className="rv-dot tone-ok" />
                    正常
                  </span>
                  <span>
                    <i className="rv-dot tone-warn" />
                    待确认
                  </span>
                  <span>
                    <i className="rv-dot tone-miss" />
                    缺失
                  </span>
                  <span>
                    <i className="rv-dot tone-done" />
                    已确认
                  </span>
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {confirmPassAll ? (
        <ConfirmDialog
          title="通过所有识别正常的题"
          message={
            <>
              将把这张答题卡里 <b>{passableCount}</b> 道「识别正常」的题按当前识别值通过。
              没识别到、看不清、一题多分的题不会被改动，仍需你逐题确认。确定继续吗？
            </>
          }
          confirmText="全部通过"
          onCancel={() => setConfirmPassAll(false)}
          onConfirm={() => void passAllNormal()}
        />
      ) : null}
    </div>
  );
}
