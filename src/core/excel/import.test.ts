import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import type { ParsedWorkbook } from "../excel/import";
import { buildImportResult, extractNames, suggestNameImport } from "../excel/import";

function wb(rows: string[][], name = "Sheet1"): ParsedWorkbook {
  return { fileName: "名单.xlsx", sheets: [{ name, rows }] };
}

describe("姓名列自动识别", () => {
  it("识别「姓名」表头，并从下一行开始取名字（表头不算学生）", () => {
    const rows = [
      ["序号", "姓名", "学号"],
      ["1", "张三", "1001"],
      ["2", "李四", "1002"],
      ["3", "王五", "1003"],
    ];
    const result = suggestNameImport(wb(rows));
    expect(result).not.toBeNull();
    expect(result!.headerRow).toBe(0);
    expect(result!.nameColumn).toBe(1);
    expect(result!.startRow).toBe(1);
    expect(result!.names.map((n) => n.name)).toEqual(["张三", "李四", "王五"]);
  });

  it("表头不在第一行时也能找到", () => {
    const rows = [
      ["高二(3)班 单元测验"],
      [],
      ["姓名", "分数"],
      ["陈晓", "88"],
      ["李然", "92"],
    ];
    const result = suggestNameImport(wb(rows));
    expect(result!.headerRow).toBe(2);
    expect(result!.startRow).toBe(3);
    expect(result!.names.map((n) => n.name)).toEqual(["陈晓", "李然"]);
  });

  it("没有表头时，按内容猜出姓名列", () => {
    const rows = [["张三"], ["李四"], ["王五"], ["赵六"]];
    const result = suggestNameImport(wb(rows));
    expect(result).not.toBeNull();
    expect(result!.names.map((n) => n.name)).toEqual(["张三", "李四", "王五", "赵六"]);
  });

  it("手动指定开始行时，跳过表头和其它内容", () => {
    const rows = [
      ["名单"],
      ["姓名"],
      ["张三"],
      ["李四"],
    ];
    const parsed = wb(rows);
    const result = buildImportResult(parsed, "Sheet1", 0, 0, 2);
    expect(result!.names.map((n) => n.name)).toEqual(["张三", "李四"]);
  });

  it("空行超过 3 行后停止，并给出提示", () => {
    const rows = [["姓名"], ["张三"], ["李四"], [], [], [], ["备注：请核对"]];
    const { names, warnings } = extractNames(rows, 0, 1);
    expect(names.map((n) => n.name)).toEqual(["张三", "李四"]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("重名会保留并提示", () => {
    const rows = [["姓名"], ["张三"], ["张三"], ["李四"]];
    const { names, warnings } = extractNames(rows, 0, 1);
    expect(names).toHaveLength(3);
    expect(warnings.join("")).toContain("重名");
  });

  it("数字列不会被当成姓名列", () => {
    const rows = [
      ["序号", "姓名"],
      ["1", "张三"],
      ["2", "李四"],
      ["3", "王五"],
    ];
    const result = suggestNameImport(wb(rows));
    expect(result!.nameColumn).toBe(1);
  });
});
