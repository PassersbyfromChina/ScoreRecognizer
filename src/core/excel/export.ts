import ExcelJS from "exceljs";
import type { AppSettings, ExportSnapshot } from "../types";

export interface ExportOptions {
  projectName: string;
  snapshot: ExportSnapshot;
  settings: AppSettings;
}

export function missingCellValue(settings: AppSettings): string | null {
  switch (settings.missingMarkMode) {
    case "blank":
      return null;
    case "zero":
      return "0";
    case "custom":
      return settings.missingMarkCustom || "?";
    case "question":
    default:
      return "？";
  }
}

export function timestampName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function buildFileName(projectName: string, d = new Date()): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "成绩";
  return `${safe}_成绩_${timestampName(d)}.xlsx`;
}

/** 生成最终 Excel。姓名为行、题号为列，最后一列总分；未确认的格子按设置标出。 */
export async function buildExportWorkbook(opts: ExportOptions): Promise<ArrayBuffer> {
  const { projectName, snapshot, settings } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ScoreRecognizer";
  wb.created = new Date();
  const ws = wb.addWorksheet(safeSheetName(projectName), {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
  });

  const questions = [...snapshot.questions].sort((a, b) => a - b);
  const headers: Array<string | number> = ["姓名/题号", ...questions, "总分"];
  const headerRow = ws.addRow(headers);
  headerRow.height = 22;

  const colCount = headers.length;
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFD9DEE7" } },
    left: { style: "thin", color: { argb: "FFD9DEE7" } },
    bottom: { style: "thin", color: { argb: "FFD9DEE7" } },
    right: { style: "thin", color: { argb: "FFD9DEE7" } },
  };

  headerRow.eachCell((cell, col) => {
    cell.font = { name: "微软雅黑", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: col === 1 ? "left" : "center", vertical: "middle" };
    cell.border = border;
  });

  const mark = missingCellValue(settings);

  for (const row of snapshot.rows) {
    const values: Array<string | number | null> = [row.studentName];
    let total: number | null = null;
    for (const q of questions) {
      const score = row.scores[q];
      if (typeof score === "number" && Number.isFinite(score)) {
        values.push(score);
        total = (total ?? 0) + score;
      } else {
        values.push(mark);
      }
    }
    values.push(total ?? (mark === null ? null : mark));
    const r = ws.addRow(values);

    r.eachCell((cell, col) => {
      cell.border = border;
      cell.font = { name: "微软雅黑", size: 11, color: { argb: "FF1F2937" } };
      cell.alignment = { horizontal: col === 1 ? "left" : "center", vertical: "middle" };
      if (col === 1 || col === colCount) {
        cell.font = { name: "微软雅黑", size: 11, bold: col === 1, color: { argb: "FF111827" } };
      }
      // 未确认/缺失的标记用红色显示
      if (mark !== null && cell.value === mark && col > 1 && col < colCount) {
        cell.font = { name: "微软雅黑", size: 11, bold: true, color: { argb: "FFDC2626" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
      }
      if (typeof cell.value === "number" && cell.value < 0) {
        cell.font = { ...(cell.font as ExcelJS.Font), color: { argb: "FFB91C1C" } };
      }
    });
  }

  ws.getColumn(1).width = Math.max(12, ...snapshot.rows.map((r) => r.studentName.length * 1.8 + 4));
  for (let c = 2; c <= colCount; c++) ws.getColumn(c).width = c === colCount ? 10 : 9;

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/:*?[\]'"]/g, " ").trim() || "成绩";
  return cleaned.slice(0, 31);
}

/** 把快照转成可读的 CSV 文本（备份/预览用）。 */
export function snapshotToCsv(snapshot: ExportSnapshot): string {
  const questions = [...snapshot.questions].sort((a, b) => a - b);
  const head = ["姓名/题号", ...questions.map(String), "总分"].join(",");
  const lines = snapshot.rows.map((row) => {
    let total: number | null = null;
    const cells = questions.map((q) => {
      const v = row.scores[q];
      if (typeof v === "number" && Number.isFinite(v)) {
        total = (total ?? 0) + v;
        return String(v);
      }
      return "";
    });
    return [row.studentName, ...cells, total ?? ""].join(",");
  });
  return [head, ...lines].join("\n");
}
