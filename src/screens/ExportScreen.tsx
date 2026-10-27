import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FileClock,
  FileSpreadsheet,
  FileX2,
  Info,
  RefreshCw,
} from "lucide-react";
import { useAppStore } from "../core/store";
import type {
  AppSettings,
  Capture,
  CardTemplate,
  ExportRecord,
  ExportSnapshot,
  Project,
} from "../core/types";
import {
  buildExportWorkbook,
  buildFileName,
  missingCellValue,
  snapshotToCsv,
} from "../core/excel/export";
import { listExports, newId, saveExport } from "../core/storage/repo";
import { toast } from "../components/Toast";
import type { NavProps } from "../navigation";
import "./export.css";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------------------------------------------------------------- 快照生成

interface ExportStats {
  /** 名单里的学生数（= 导出表行数） */
  students: number;
  /** 已完成的答题卡数量 */
  done: number;
  /** 待确认的答题卡数量 */
  pending: number;
  /** 还在拍摄 / 处理中的答题卡数量 */
  processing: number;
  /** 没有认领学生的答题卡数量 */
  unclaimed: number;
  /** 认领了学生、但该学生不在名单里的答题卡数量 */
  orphan: number;
  /** 有多张答题卡（只取最新一张）的学生数量 */
  multiCardStudents: number;
  /** 名单里还没有答题卡的学生数量 */
  noCardStudents: number;
  confirmedCells: number;
  totalCells: number;
  missingCells: number;
  confirmedRows: number;
}

interface ExportViewData {
  snapshot: ExportSnapshot;
  /** 与 snapshot.rows 一一对应的最新答题卡（用于行内状态标记） */
  rowCapture: Array<Capture | undefined>;
  stats: ExportStats;
  hasNegative: boolean;
}

/** 按 createdAt（相同时按 updatedAt）取最新的一张答题卡。 */
function latestCapture(list: Capture[] | undefined): Capture | undefined {
  if (!list || list.length === 0) return undefined;
  let latest = list[0];
  for (const capture of list) {
    if (
      capture.createdAt > latest.createdAt ||
      (capture.createdAt === latest.createdAt && capture.updatedAt > latest.updatedAt)
    ) {
      latest = capture;
    }
  }
  return latest;
}

/** 题号 = 模板题目区域 ∪ 所有答题卡出现过的题号，升序。 */
function collectQuestions(template: CardTemplate | null, captures: Capture[]): number[] {
  const set = new Set<number>();
  for (const region of template?.regions ?? []) {
    if (region.kind === "question" && typeof region.questionNo === "number" && Number.isFinite(region.questionNo)) {
      set.add(region.questionNo);
    }
  }
  for (const capture of captures) {
    for (const answer of capture.answers) {
      if (Number.isFinite(answer.questionNo)) set.add(answer.questionNo);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 生成导出快照。
 * - 行按 project.students 顺序，每个学生取 studentId 匹配且最新的一张答题卡；
 * - 分数只取 finalScore，未确认一律视为缺失（绝不使用 rawScore 兜底）；
 * - 总分 = 已确认分数之和（可为负）。
 */
function buildExportViewData(
  project: Project,
  captures: Capture[],
  template: CardTemplate | null,
): ExportViewData {
  const questions = collectQuestions(template, captures);
  const studentIds = new Set(project.students.map((s) => s.id));
  const byStudent = new Map<string, Capture[]>();
  let unclaimed = 0;
  let orphan = 0;

  for (const capture of captures) {
    if (!capture.studentId) {
      unclaimed += 1;
      continue;
    }
    if (!studentIds.has(capture.studentId)) {
      orphan += 1;
      continue;
    }
    const list = byStudent.get(capture.studentId);
    if (list) list.push(capture);
    else byStudent.set(capture.studentId, [capture]);
  }

  const rowCapture: Array<Capture | undefined> = [];
  let confirmedCells = 0;
  let hasNegative = false;

  const rows = project.students.map((student) => {
    const capture = latestCapture(byStudent.get(student.id));
    rowCapture.push(capture);
    const scores: Record<number, number | null> = {};
    let total: number | null = null;
    for (const questionNo of questions) {
      const answer = capture?.answers.find((a) => a.questionNo === questionNo);
      const raw = answer?.finalScore;
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      scores[questionNo] = value;
      if (value !== null) {
        total = (total ?? 0) + value;
        confirmedCells += 1;
        if (value < 0) hasNegative = true;
      }
    }
    return {
      studentName: student.name,
      studentId: student.id,
      scores,
      total,
      confirmed: capture?.status === "done",
    };
  });

  let done = 0;
  let pending = 0;
  let processing = 0;
  for (const capture of captures) {
    if (capture.status === "done") done += 1;
    else if (capture.status === "pending_review") pending += 1;
    else processing += 1;
  }

  const totalCells = questions.length * rows.length;
  const stats: ExportStats = {
    students: rows.length,
    done,
    pending,
    processing,
    unclaimed,
    orphan,
    multiCardStudents: [...byStudent.values()].filter((list) => list.length > 1).length,
    noCardStudents: project.students.filter((student) => !byStudent.has(student.id)).length,
    confirmedCells,
    totalCells,
    missingCells: Math.max(0, totalCells - confirmedCells),
    confirmedRows: rows.filter((row) => row.confirmed).length,
  };

  return {
    snapshot: { projectName: project.name, questions, rows },
    rowCapture,
    stats,
    hasNegative,
  };
}

// ---------------------------------------------------------------- 展示辅助

function formatScore(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day =
    date.getFullYear() === now.getFullYear()
      ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/** 预览表里缺失格显示的文本（留空模式用「—」占位）。 */
function markText(mark: string | null): string {
  return mark ?? "—";
}

/** 描述缺失格的导出标记，用于提示文案。 */
function markDescription(settings: AppSettings): string {
  switch (settings.missingMarkMode) {
    case "blank":
      return "留空";
    case "zero":
      return "数字 0";
    case "custom":
      return `「${settings.missingMarkCustom || "?"}」`;
    case "question":
    default:
      return "红色问号「？」";
  }
}

/** 历史记录里的缺失格数（按快照统计，和预览口径一致）。 */
function snapshotMissingCount(snapshot: ExportSnapshot): number {
  let missing = 0;
  for (const row of snapshot.rows) {
    for (const questionNo of snapshot.questions) {
      const value = row.scores[questionNo];
      if (typeof value !== "number" || !Number.isFinite(value)) missing += 1;
    }
  }
  return missing;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用 Blob + a[download] 触发浏览器下载。 */
function downloadWorkbook(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 剪贴板权限不可用时走兜底方案
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("剪贴板不可用");
}

// ---------------------------------------------------------------- 组件

/** 导出界面：成绩预览 + Excel 导出 + 应用内备份历史。 */
export function ExportScreen({ onNavigate }: NavProps) {
  const project = useAppStore((s) => s.project);
  const captures = useAppStore((s) => s.captures);
  const template = useAppStore((s) => s.template);
  const settings = useAppStore((s) => s.settings);
  const refreshCaptures = useAppStore((s) => s.refreshCaptures);

  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [redownloadId, setRedownloadId] = useState<string | null>(null);

  const projectId = project?.id ?? null;

  // 进入页面时刷新一次，确保拿到最新的核对结果
  useEffect(() => {
    void refreshCaptures();
  }, [refreshCaptures]);

  useEffect(() => {
    if (!projectId) {
      setExports([]);
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    listExports(projectId)
      .then((list) => {
        if (cancelled) return;
        setExports(list);
        setHistoryLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHistoryLoading(false);
        console.error(error);
        toast("读取导出备份失败", "err");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const data = useMemo(
    () => (project ? buildExportViewData(project, captures, template) : null),
    [project, captures, template],
  );

  if (!project || !data) {
    return (
      <div className="page-inner ex-page">
        <div className="page-head">
          <div className="titles">
            <h1>导出成绩</h1>
            <div className="desc">预览本班成绩，导出为 Excel；导出记录会备份在本机。</div>
          </div>
        </div>
        <div className="card">
          <div className="empty">
            <div className="icon">
              <FileX2 size={24} />
            </div>
            <div className="title">还没有可导出的班级</div>
            <div className="desc">先创建班级、导入学生名单，再拍摄答题卡并核对分数，这里就能生成成绩 Excel。</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => onNavigate("home")}>
              去首页创建班级
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { snapshot, rowCapture, stats, hasNegative } = data;
  const { questions, rows } = snapshot;
  const markValue = missingCellValue(settings);
  const mark = markText(markValue);
  const percent = formatPercent(stats.confirmedCells, stats.totalCells);
  const noStudents = stats.students === 0;

  const issues: string[] = [];
  if (stats.noCardStudents > 0) issues.push(`${stats.noCardStudents} 名学生还没有答题卡`);
  if (stats.unclaimed > 0) issues.push(`${stats.unclaimed} 张答题卡还没有认领学生`);
  if (stats.orphan > 0) issues.push(`${stats.orphan} 张答题卡在名单里找不到对应学生`);
  if (stats.multiCardStudents > 0) issues.push(`${stats.multiCardStudents} 名学生有多张答题卡（只取最新一张）`);
  if (stats.processing > 0) issues.push(`${stats.processing} 张答题卡还没有处理完`);
  if (stats.missingCells > 0) issues.push(`${stats.missingCells} 个格子还没有确认分数`);
  const partial = issues.length > 0;

  const statItems: Array<{ label: string; value: number; hint: string; tone: string }> = [
    { label: "学生", value: stats.students, hint: "名单人数", tone: "" },
    {
      label: "已完成答题卡",
      value: stats.done,
      hint: `共 ${captures.length} 张答题卡`,
      tone: stats.done > 0 ? "ok" : "muted",
    },
    {
      label: "待确认答题卡",
      value: stats.pending,
      hint: stats.pending > 0 ? "等待人工核对" : "没有待确认",
      tone: stats.pending > 0 ? "warn" : "muted",
    },
    {
      label: "未认领答题卡",
      value: stats.unclaimed,
      hint: stats.unclaimed > 0 ? "没有匹配到学生" : "全部已认领",
      tone: stats.unclaimed > 0 ? "danger" : "muted",
    },
    {
      label: "缺失格数",
      value: stats.missingCells,
      hint: `共 ${stats.totalCells} 格`,
      tone: stats.missingCells > 0 ? "danger" : "ok",
    },
  ];

  async function handleExport(): Promise<void> {
    if (!project || exporting) return;
    setExporting(true);
    try {
      const filename = buildFileName(project.name);
      const buffer = await buildExportWorkbook({
        projectName: project.name,
        snapshot,
        settings,
      });
      const record: ExportRecord = {
        id: newId("exp"),
        projectId: project.id,
        createdAt: Date.now(),
        filename,
        snapshot,
      };
      // 先落盘备份，再触发下载：保证「导出后应用内保留备份」
      await saveExport(record);
      downloadWorkbook(buffer, filename);
      setExports((prev) => [record, ...prev.filter((item) => item.id !== record.id)]);
      toast(`已导出 ${filename}`, "ok");
    } catch (error) {
      console.error(error);
      toast(`导出失败：${errorText(error)}`, "err");
    } finally {
      setExporting(false);
    }
  }

  async function handleRedownload(record: ExportRecord): Promise<void> {
    if (redownloadId) return;
    setRedownloadId(record.id);
    try {
      const buffer = await buildExportWorkbook({
        projectName: record.snapshot.projectName || project?.name || "成绩",
        snapshot: record.snapshot,
        settings,
      });
      downloadWorkbook(buffer, record.filename);
      toast(`已重新下载 ${record.filename}`, "ok");
    } catch (error) {
      console.error(error);
      toast(`重新下载失败：${errorText(error)}`, "err");
    } finally {
      setRedownloadId(null);
    }
  }

  async function handleCopyCsv(): Promise<void> {
    try {
      await copyTextToClipboard(snapshotToCsv(snapshot));
      toast(`已复制 CSV（${rows.length} 行）`, "ok");
    } catch (error) {
      console.error(error);
      toast(`复制失败：${errorText(error)}`, "err");
    }
  }

  return (
    <div className="page-inner ex-page">
      <div className="page-head">
        <div className="titles">
          <div className="ex-title-row">
            <h1>导出成绩</h1>
            {noStudents ? (
              <span className="badge badge-gray">暂无学生</span>
            ) : partial ? (
              <span className="badge badge-amber">部分完成</span>
            ) : (
              <span className="badge badge-green">数据齐全</span>
            )}
          </div>
          <div className="desc">
            {project.name} · {stats.students} 名学生 · {questions.length} 道题 · 已确认{" "}
            {stats.confirmedCells}/{stats.totalCells} 格
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => void handleCopyCsv()} disabled={noStudents}>
            <ClipboardCopy size={16} />
            复制 CSV
          </button>
          <button
            className="btn btn-primary ex-export-btn"
            onClick={() => void handleExport()}
            disabled={exporting || noStudents}
            title={noStudents ? "导入学生名单后才能导出" : undefined}
          >
            {exporting ? <RefreshCw size={16} className="spin" /> : <FileSpreadsheet size={16} />}
            {exporting ? "正在生成…" : "导出 Excel"}
          </button>
        </div>
      </div>

      {noStudents ? (
        <div className="notice notice-info ex-notice">
          <Info size={15} />
          <div>还没有导入学生名单。成绩表按名单逐行生成，先去「学生名单」导入名单后再导出。</div>
        </div>
      ) : partial ? (
        <div className="notice notice-warn ex-notice">
          <AlertTriangle size={15} />
          <div>
            <div>
              <b>当前是「部分完成」</b>：{issues.join("；")}。
            </div>
            <div className="ex-notice-sub">
              现在仍可导出 Excel，未确认的格子会显示为{markDescription(settings)}，不会用识别到的原始分数代替；核对完再导出即可得到完整成绩。
            </div>
          </div>
        </div>
      ) : (
        <div className="notice notice-success ex-notice">
          <CheckCircle2 size={15} />
          <div>名单上的学生都有答题卡，且所有分数都已确认，可以导出完整成绩。</div>
        </div>
      )}

      {questions.length === 0 && !noStudents && (
        <div className="notice notice-info ex-notice">
          <Info size={15} />
          <div>还没有划分题目区域，导出文件只会包含姓名与总分。可以先去「区域划分」为模板添加题目区域。</div>
        </div>
      )}

      <div className="card ex-summary">
        <div className="ex-progress-head">
          <span className="ex-progress-label">成绩完整度</span>
          <b className="ex-progress-pct">{percent}%</b>
          <span className="faint small">
            已确认 {stats.confirmedCells} / {stats.totalCells} 格
          </span>
          <span className="ex-progress-spacer" />
          {partial ? (
            <span className="badge badge-amber">还差 {stats.missingCells} 格</span>
          ) : stats.totalCells > 0 ? (
            <span className="badge badge-green">全部确认</span>
          ) : null}
        </div>
        <div className={`ex-bar${stats.totalCells > 0 && stats.missingCells === 0 ? " complete" : ""}`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="ex-stats">
          {statItems.map((item) => (
            <div className={`ex-stat ${item.tone}`} key={item.label}>
              <div className="ex-stat-num">{item.value}</div>
              <div className="ex-stat-label">{item.label}</div>
              <div className="ex-stat-hint">{item.hint}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card ex-preview">
        <div className="card-head">
          <FileSpreadsheet size={17} color="var(--red)" />
          <h2>成绩预览</h2>
          <span className="sub">
            {questions.length > 0 ? `${questions.length} 道题 · ${rows.length} 名学生` : `${rows.length} 名学生`}
          </span>
          <span className="spacer" />
          <span className="ex-legend">
            <i>{mark}</i>
            <span>未确认</span>
          </span>
          {hasNegative && (
            <span className="ex-legend ex-legend-neg">
              <i>-2</i>
              <span>负分标红</span>
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: "40px 20px" }}>
            <div className="icon">
              <ClipboardCopy size={22} />
            </div>
            <div className="title">还没有学生名单</div>
            <div className="desc">导入学生名单后，这里会按学生生成题号 × 分数的成绩预览。</div>
            <button
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 14 }}
              onClick={() => onNavigate("students")}
            >
              去导入名单
            </button>
          </div>
        ) : (
          <>
            <div className="ex-table-wrap">
              <table className="ex-table">
                <thead>
                  <tr>
                    <th className="ex-name">姓名 / 题号</th>
                    {questions.map((questionNo) => (
                      <th key={questionNo} className="ex-q">
                        {questionNo}
                      </th>
                    ))}
                    <th className="ex-total">总分</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, rowIndex) => {
                    const capture = rowCapture[rowIndex];
                    return (
                      <tr key={row.studentId ?? `row-${rowIndex}`}>
                        <td className="ex-name">
                          <div className="ex-name-inner">
                            {row.confirmed && <CheckCircle2 size={13} className="ex-name-ok" aria-label="已确认" />}
                            <span className="ex-stu-name" title={row.studentName}>
                              {row.studentName}
                            </span>
                            {!capture ? (
                              <span className="badge badge-gray ex-mini-badge">无答题卡</span>
                            ) : capture.status === "pending_review" ? (
                              <span className="badge badge-amber ex-mini-badge">待确认</span>
                            ) : capture.status === "pending_capture" || capture.status === "pending_process" ? (
                              <span className="badge badge-gray ex-mini-badge">待处理</span>
                            ) : null}
                          </div>
                        </td>
                        {questions.map((questionNo) => {
                          const value = row.scores[questionNo];
                          if (typeof value === "number" && Number.isFinite(value)) {
                            return (
                              <td
                                key={questionNo}
                                className={`ex-td ex-score${value < 0 ? " ex-neg" : ""}`}
                                title={`${row.studentName} · 第 ${questionNo} 题：${formatScore(value)} 分`}
                              >
                                {formatScore(value)}
                              </td>
                            );
                          }
                          return (
                            <td
                              key={questionNo}
                              className={`ex-td ${markValue === null ? "ex-cell-blank" : "ex-cell-mark"}`}
                              title={`${row.studentName} · 第 ${questionNo} 题：未确认（导出为${markDescription(settings)}）`}
                            >
                              {mark}
                            </td>
                          );
                        })}
                        <td
                          className={`ex-td ex-total${row.total !== null && row.total < 0 ? " ex-neg" : ""}${
                            row.total === null ? " ex-total-empty" : ""
                          }`}
                          title={row.total === null ? "还没有已确认的分数" : `已确认分数合计 ${formatScore(row.total)}`}
                        >
                          {row.total === null ? mark : formatScore(row.total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card-foot ex-preview-foot">
              <span className="faint small">
                {rows.length} 名学生 × {questions.length} 道题 · 缺失 {stats.missingCells} 格
              </span>
              <span className="faint small">表格可左右滚动 · 导出内容与预览一致，负分标红</span>
            </div>
          </>
        )}
      </div>

      <div className="card ex-history">
        <div className="card-head">
          <FileClock size={17} color="var(--red)" />
          <h2>导出备份</h2>
          <span className="sub">保存在本机，可随时重新下载</span>
          <span className="spacer" />
          {exports.length > 0 && <span className="badge badge-gray">{exports.length} 条</span>}
        </div>
        {historyLoading ? (
          <div className="ex-history-loading">
            <div className="spinner" />
            <span>正在读取备份…</span>
          </div>
        ) : exports.length === 0 ? (
          <div className="empty" style={{ padding: "34px 20px" }}>
            <div className="icon">
              <FileSpreadsheet size={22} />
            </div>
            <div className="title">还没有导出记录</div>
            <div className="desc">
              点击右上角「导出 Excel」后，这次导出的成绩快照会自动备份在这里，之后可以随时重新下载。
            </div>
          </div>
        ) : (
          <div className="ex-history-list">
            {exports.map((record) => {
              const missing = snapshotMissingCount(record.snapshot);
              const busy = redownloadId === record.id;
              return (
                <div className="ex-history-item" key={record.id}>
                  <div className="ex-file-icon">
                    <FileSpreadsheet size={19} />
                  </div>
                  <div className="ex-file-info">
                    <div className="ex-file-name" title={record.filename}>
                      {record.filename}
                    </div>
                    <div className="ex-file-meta">
                      <span>{formatDateTime(record.createdAt)}</span>
                      <span className="ex-dot-sep">·</span>
                      <span>
                        {record.snapshot.rows.length} 行 × {record.snapshot.questions.length} 题
                      </span>
                      <span className="ex-dot-sep">·</span>
                      <span className={missing > 0 ? "ex-file-missing" : ""}>缺失 {missing} 格</span>
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleRedownload(record)}
                    disabled={redownloadId !== null}
                  >
                    {busy ? <RefreshCw size={13} className="spin" /> : <Download size={13} />}
                    重新下载
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
