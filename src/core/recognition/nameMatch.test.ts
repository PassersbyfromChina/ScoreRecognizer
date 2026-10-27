import { describe, expect, it } from "vitest";
import {
  cleanNameText,
  levenshtein,
  matchStudent,
  normalizeName,
  pickNextStudent,
  rankNameCandidates,
} from "./nameMatch";
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

describe("核对页姓名候选", () => {
  it("完全匹配时只返回它自己，不夹带 60% 的近似候选", () => {
    const candidates = rankNameCandidates(STUDENTS, "陈晓");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("陈晓");
    expect(candidates[0].score).toBe(1);
  });

  it("过滤掉已经分配给其他答题卡的学生", () => {
    const candidates = rankNameCandidates(STUDENTS, "李燃", ["s2"]);
    expect(candidates.every((c) => c.studentId !== "s2")).toBe(true);
  });

  it("低于 45% 的候选不展示，避免误导", () => {
    const candidates = rankNameCandidates(STUDENTS, "蒋雯");
    expect(candidates).toHaveLength(0);
  });

  it("没有姓名文本时没有候选", () => {
    expect(rankNameCandidates(STUDENTS, undefined)).toHaveLength(0);
  });
});

describe("离线按名单顺序建议姓名", () => {
  const ORDERED: Student[] = [
    { id: "a", name: "陈晓", order: 2 },
    { id: "b", name: "李然", order: 0 },
    { id: "c", name: "王雨", order: 1 },
  ];

  it("按名单 order 顺序给出第一个还没用过的学生", () => {
    expect(pickNextStudent(ORDERED, [])?.id).toBe("b");
    expect(pickNextStudent(ORDERED, [{ studentId: "b" }])?.id).toBe("c");
    expect(pickNextStudent(ORDERED, [{ studentId: "b" }, { studentId: "c" }])?.id).toBe("a");
    expect(pickNextStudent(ORDERED, [{ studentId: "b" }, { studentId: "c" }, { studentId: "a" }])).toBeNull();
  });

  it("已确认的姓名（即使还没 studentId）也会跳过", () => {
    const next = pickNextStudent(ORDERED, [{ nameText: "陈晓" }]);
    expect(next?.id).toBe("b");
  });

  it("姓名文本里的候选提示不影响判断", () => {
    expect(cleanNameText("李然（可能是 李燃）")).toBe("李然");
    const next = pickNextStudent(ORDERED, [{ nameText: "李然（可能是 李燃）" }]);
    expect(next?.id).toBe("c");
  });

  it("名单为空时返回 null", () => {
    expect(pickNextStudent([], [{ studentId: "a" }])).toBeNull();
  });
});
