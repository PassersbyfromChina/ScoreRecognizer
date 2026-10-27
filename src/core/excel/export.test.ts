import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import type { ExportSnapshot } from "../types";
import { buildExportWorkbook, buildFileName, missingCellValue } from "./export";

const snapshot: ExportSnapshot = {
  projectName: "高二(3)班",
  questions: [1, 2, 3],
  rows: [
    { studentName: "张三", scores: { 1: 5, 2: -2, 3: null }, total: 3, confirmed: false },
    { studentName: "李四", scores: { 1: 4, 2: 0, 3: 3 }, total: 7, confirmed: true },
  ],
};

async function load(buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb.worksheets[0];
}

describe("导出 Excel", () => {
  it("姓名为行、题号为列、最后一列总分", async () => {
    const buf = await buildExportWorkbook({
      projectName: "高二(3)班",
      snapshot,
      settings: { ...DEFAULT_SETTINGS, missingMarkMode: "question" },
    });
    const ws = await load(buf);
    expect(ws.getCell("A1").value).toBe("姓名/题号");
    expect(ws.getCell("B1").value).toBe(1);
    expect(ws.getCell("E1").value).toBe("总分");
    expect(ws.getCell("A2").value).toBe("张三");
    expect(ws.getCell("B2").value).toBe(5);
    expect(ws.getCell("C2").value).toBe(-2);
    expect(ws.getCell("D2").value).toBe("？");
    expect(ws.getCell("E2").value).toBe(3);
    expect(ws.getCell("E3").value).toBe(7);
  });

  it("未确认的格子是红色（问号模式）", async () => {
    const buf = await buildExportWorkbook({
      projectName: "p",
      snapshot,
      settings: { ...DEFAULT_SETTINGS, missingMarkMode: "question" },
    });
    const ws = await load(buf);
    const cell = ws.getCell("D2");
    expect(cell.value).toBe("？");
    expect(String(cell.font?.color?.argb ?? "")).toBe("FFDC2626");
  });

  it("负数分数标红", async () => {
    const buf = await buildExportWorkbook({
      projectName: "p",
      snapshot,
      settings: { ...DEFAULT_SETTINGS },
    });
    const ws = await load(buf);
    const cell = ws.getCell("C2");
    expect(cell.value).toBe(-2);
    expect(String(cell.font?.color?.argb ?? "")).toBe("FFB91C1C");
  });

  it("留空模式下未确认格子为空", async () => {
    const buf = await buildExportWorkbook({
      projectName: "p",
      snapshot,
      settings: { ...DEFAULT_SETTINGS, missingMarkMode: "blank" },
    });
    const ws = await load(buf);
    expect(ws.getCell("D2").value).toBeNull();
  });

  it("自定义标记生效", async () => {
    const buf = await buildExportWorkbook({
      projectName: "p",
      snapshot,
      settings: { ...DEFAULT_SETTINGS, missingMarkMode: "custom", missingMarkCustom: "待核" },
    });
    const ws = await load(buf);
    expect(ws.getCell("D2").value).toBe("待核");
  });
});

describe("文件名与标记", () => {
  it("文件名去掉非法字符并带时间", () => {
    const name = buildFileName("高二/3班:测验", new Date(2026, 9, 27, 9, 5));
    expect(name).toBe("高二_3班_测验_成绩_20261027_0905.xlsx");
  });

  it("默认标记是中文问号", () => {
    expect(missingCellValue(DEFAULT_SETTINGS)).toBe("？");
  });
});
