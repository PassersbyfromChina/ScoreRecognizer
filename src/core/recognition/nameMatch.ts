import type { Capture, Student } from "../types";

export function normalizeName(value: string): string {
  return value.replace(/\s+/g, "").replace(/[·•・.]/g, "").trim();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

export interface NameMatch {
  studentId?: string;
  name: string;
  confidence: number;
  candidates: Array<{ studentId: string; name: string; distance: number; score: number }>;
}

/** 把识别出的姓名模糊匹配到班级名单（手写识别常见近字/漏字）。 */
export function matchStudent(rawName: string | null | undefined, students: Student[]): NameMatch {
  const name = normalizeName(rawName ?? "");
  if (!name) return { name: "", confidence: 0, candidates: [] };
  const scored = students.map((s) => {
    const target = normalizeName(s.name);
    if (target === name) return { studentId: s.id, name: s.name, distance: 0, score: 1 };
    const d = levenshtein(name, target);
    // 只有完全一致才自动对应学生；差一个字只作为候选提示，交给人工确认（避免认错人）
    let score = 0;
    if (d === 1) score = 0.6;
    else if (d === 2 && name.length >= 3) score = 0.45;
    else if (d === 2) score = 0.25;
    else if (d >= 3) score = 0.1;
    // 识别结果包含在名单里（多字/少字）也给一点分
    if (d > 0 && (target.includes(name) || name.includes(target)) && Math.abs(target.length - name.length) <= 1) {
      score = Math.max(score, 0.5);
    }
    return { studentId: s.id, name: s.name, distance: d, score };
  });
  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  const second = scored[1];
  const margin = best && second ? best.score - second.score : best?.score ?? 0;
  if (!best || best.score < 0.45) return { name, confidence: 0, candidates: scored.slice(0, 3) };
  // 两个候选分数很接近时降低置信度，交给人工确认
  const confidence = margin < 0.08 ? Math.min(best.score, 0.5) : best.score;
  return { name, confidence, studentId: confidence >= 0.7 ? best.studentId : undefined, candidates: scored.slice(0, 3) };
}

/** 去掉「（可能是 X）」这类候选提示，只留识别/建议的姓名。 */
export function cleanNameText(nameText: string | undefined | null): string {
  if (!nameText) return "";
  return normalizeName(nameText.split(/[（(]/)[0]);
}

/**
 * 离线按名单顺序建议下一个学生姓名（用于「按拍照顺序自动填姓名」）。
 * 已被占用的学生（已有 studentId 或已有确认姓名）会跳过；顺序按名单里的 order。
 */
export function pickNextStudent(
  students: Student[],
  captures: Array<Pick<Capture, "studentId" | "nameText">>,
): Student | null {
  if (students.length === 0) return null;
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  for (const c of captures) {
    if (c.studentId) usedIds.add(c.studentId);
    const name = cleanNameText(c.nameText);
    if (name) usedNames.add(name);
  }
  const ordered = [...students].sort((a, b) => a.order - b.order);
  for (const s of ordered) {
    if (usedIds.has(s.id)) continue;
    if (usedNames.has(normalizeName(s.name))) continue;
    return s;
  }
  return null;
}
