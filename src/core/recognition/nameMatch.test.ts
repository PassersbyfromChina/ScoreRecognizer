import { describe, expect, it } from "vitest";
import { levenshtein, matchStudent, normalizeName } from "./nameMatch";
import type { Student } from "../types";

const student = (id: string, name: string): Student => ({ id, name, order: 0 });

const STUDENTS: Student[] = [
  student("s1", "陈晓"),
  student("s2", "李然"),
  student("s3", "王雨"),
  student("s4", "欧阳娜娜"),
  student("s5", "张三丰"),
];

describe("nameMatch", () => {
  it("完全一致时直接命中", () => {
    const m = matchStudent("陈晓", STUDENTS);
    expect(m.studentId).toBe("s1");
    expect(m.confidence).toBe(1);
  });

  it("忽略空格和间隔点后再匹配", () => {
    expect(normalizeName("欧 阳 · 娜娜")).toBe("欧阳娜娜");
    const m = matchStudent("欧阳 娜娜", STUDENTS);
    expect(m.studentId).toBe("s4");
  });

  it("差一个字时只给候选、不自动对应学生（需人工确认）", () => {
    const m = matchStudent("李燃", STUDENTS);
    expect(m.studentId).toBeUndefined();
    expect(m.candidates[0].name).toBe("李然");
    expect(m.confidence).toBeGreaterThan(0.4);
    expect(m.confidence).toBeLessThan(0.7);
  });

  it("完全陌生的姓名不会硬凑成名单里的人（避免误导）", () => {
    const m = matchStudent("蒋雯", STUDENTS);
    expect(m.studentId).toBeUndefined();
    expect(m.candidates[0].score).toBeLessThan(0.5);
  });

  it("levenshtein 距离", () => {
    expect(levenshtein("张三", "张三")).toBe(0);
    expect(levenshtein("张三", "张山")).toBe(1);
  });
});
