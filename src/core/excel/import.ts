import * as XLSX from "xlsx";
import type { NameImportResult } from "../types";

const HEADER_RE = /^(姓名|名字|学生姓名|学生名字|学生|name|student|fullname)([\s/／|｜、:：-].*)?$/i;
const NAME_LIKE_RE = /^[\u4e00-\u9fa5·•\s]{2,6}$/;

export interface ParsedSheet {
  name: string;
  /** 二维数组，行号从 0 开始 */
  rows: string[][];
}

export interface ParsedWorkbook {
  fileName: string;
  sheets: ParsedSheet[];
}

function cleanCell(v: unknown): string {
  if (v == null) return "";
  return String(v).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeHeader(v: string): string {
  return v.replace(/[\s*：:（）()]/g, "").trim();
}

export function isHeaderText(v: string): boolean {
  return HEADER_RE.test(normalizeHeader(v));
}

export function parseWorkbookFile(fileName: string, data: ArrayBuffer): ParsedWorkbook {
  const lower = fileName.toLowerCase();
  const isCsv = lower.endsWith(".csv") || lower.endsWith(".txt");
  const wb = isCsv
    ? XLSX.read(new TextDecoder("utf-8").decode(data), { type: "string" })
    : XLSX.read(data, { type: "array" });
  const sheets: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    });
    const cleaned = rows.map((row) => (row ?? []).map((cell) => cleanCell(cell)));
    sheets.push({ name, rows: cleaned });
  }
  return { fileName, sheets };
}

function looksLikeName(value: string): boolean {
  if (!value) return false;
  if (/\d/.test(value)) return false;
  return value.length >= 1 && value.length <= 8;
}

function scoreSheetForNames(sheet: ParsedSheet): number {
  let score = 0;
  const scan = sheet.rows.slice(0, 30);
  for (const row of scan) {
    for (const cell of row) {
      if (isHeaderText(cell)) score += 10;
      else if (NAME_LIKE_RE.test(cell)) score += 0.4;
    }
  }
  return score;
}

function findHeader(rows: string[][]): { row: number; col: number } | null {
  const limit = Math.min(rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (isHeaderText(row[c])) return { row: r, col: c };
    }
  }
  return null;
}

function columnSample(rows: string[][], col: number, from: number, count = 4): string[] {
  const out: string[] = [];
  for (let r = from; r < Math.min(rows.length, from + 80) && out.length < count; r++) {
    const v = rows[r]?.[col]?.trim();
    if (v) out.push(v);
  }
  return out;
}

function guessColumnByNameValues(rows: string[][], headerRow: number): number {
  let bestCol = 0;
  let bestScore = -1;
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (let c = 0; c < maxCols; c++) {
    let score = 0;
    let nonEmpty = 0;
    for (let r = headerRow + 1; r < Math.min(rows.length, headerRow + 200); r++) {
      const v = rows[r]?.[c]?.trim();
      if (!v) continue;
      nonEmpty++;
      if (looksLikeName(v)) score += 2;
      if (/^\d+(\.\d+)?$/.test(v)) score -= 2;
      if (/(班|级|号|分|日期|时间|考号|学号)/.test(v)) score -= 1;
      if (v.length > 8) score -= 1;
    }
    if (nonEmpty === 0) continue;
    score += Math.min(nonEmpty, 60) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestCol = c;
    }
  }
  return bestCol;
}

export function columnsInfo(rows: string[][], headerRow: number, sampleFrom: number) {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const out: Array<{ index: number; header: string; sample: string[] }> = [];
  for (let c = 0; c < maxCols; c++) {
    out.push({
      index: c,
      header: (rows[headerRow]?.[c] ?? "").trim(),
      sample: columnSample(rows, c, sampleFrom),
    });
  }
  return out;
}

const MAX_ROWS = 5000;
const MAX_EMPTY_GAP = 3;

export function extractNames(
  rows: string[][],
  nameColumn: number,
  startRow: number,
): { names: Array<{ row: number; name: string }>; warnings: string[] } {
  const names: Array<{ row: number; name: string }> = [];
  const warnings: string[] = [];
  let emptyGap = 0;
  let stoppedByGap = false;

  for (let r = Math.max(0, startRow); r < Math.min(rows.length, startRow + MAX_ROWS); r++) {
    const raw = rows[r]?.[nameColumn] ?? "";
    const name = raw.replace(/\s+/g, "").trim();
    if (!name) {
      emptyGap += 1;
      if (emptyGap >= MAX_EMPTY_GAP) {
        stoppedByGap = true;
        break;
      }
      continue;
    }
    emptyGap = 0;
    names.push({ row: r, name });
  }

  if (stoppedByGap && rows.length > startRow + names.length + MAX_EMPTY_GAP) {
    warnings.push(`连续 ${MAX_EMPTY_GAP} 行为空，后面的内容未导入；如果名单中间有空行，请手动调整起始行。`);
  }
  const longOnes = names.filter((n) => n.name.length > 8);
  if (longOnes.length) {
    warnings.push(`有 ${longOnes.length} 个名字超过 8 个字，可能选错了列或混入了备注：${longOnes.slice(0, 3).map((n) => n.name).join("、")}`);
  }
  const dup = new Map<string, number>();
  for (const n of names) dup.set(n.name, (dup.get(n.name) ?? 0) + 1);
  const dups = [...dup.entries()].filter(([, c]) => c > 1);
  if (dups.length) {
    warnings.push(`有重名：${dups.slice(0, 5).map(([n, c]) => `${n}×${c}`).join("、")}${dups.length > 5 ? " 等" : ""}（会分别保留，可手动删除）`);
  }
  return { names, warnings };
}

/** 自动分析工作簿，给出建议的姓名列与起始行。找不到可信结果时返回 null。 */
export function suggestNameImport(wb: ParsedWorkbook): NameImportResult | null {
  const scored = wb.sheets
    .map((sheet) => ({ sheet, score: scoreSheetForNames(sheet) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score <= 0) return null;

  const sheet = scored[0].sheet;
  const header = findHeader(sheet.rows);
  let headerRow: number;
  let nameColumn: number;
  let startRow: number;

  if (header) {
    headerRow = header.row;
    nameColumn = header.col;
    // 表头所在列下方样本是否像名字；不像则重新猜列
    const sample = columnSample(sheet.rows, nameColumn, headerRow + 1, 6);
    const plausible = sample.filter((v) => looksLikeName(v)).length;
    if (sample.length > 0 && plausible / sample.length < 0.5) {
      nameColumn = guessColumnByNameValues(sheet.rows, headerRow);
    }
    startRow = headerRow + 1;
  } else {
    // 没有表头：找第一列大部分像名字的列
    headerRow = 0;
    nameColumn = guessColumnByNameValues(sheet.rows, -1);
    const sample = columnSample(sheet.rows, nameColumn, 0, 6);
    const plausible = sample.filter((v) => looksLikeName(v)).length;
    if (sample.length === 0 || plausible / sample.length < 0.5) return null;
    startRow = 0;
  }

  // 跳过起始行前的空行
  while (startRow < sheet.rows.length && !(sheet.rows[startRow]?.[nameColumn] ?? "").trim()) {
    startRow += 1;
    if (startRow - headerRow > 10) break;
  }

  const { names, warnings } = extractNames(sheet.rows, nameColumn, startRow);
  if (names.length === 0) return null;

  return {
    sheetName: sheet.name,
    headerRow,
    nameColumn,
    startRow,
    names,
    columns: columnsInfo(sheet.rows, headerRow, startRow),
    warnings,
  };
}

/** 用户手动调整后，生成新的导入结果。 */
export function buildImportResult(
  wb: ParsedWorkbook,
  sheetName: string,
  headerRow: number,
  nameColumn: number,
  startRow: number,
): NameImportResult | null {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  if (!sheet) return null;
  const { names, warnings } = extractNames(sheet.rows, nameColumn, startRow);
  return {
    sheetName,
    headerRow,
    nameColumn,
    startRow,
    names,
    columns: columnsInfo(sheet.rows, headerRow, startRow),
    warnings,
  };
}
