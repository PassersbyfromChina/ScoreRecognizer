/**
 * 字形分类结果 → 分数文本的解码逻辑（纯函数，便于单元测试）。
 *
 * 规则要点：
 *  - 模型 12 类：0-9、负号、junk（打勾/划线/涂鸦等噪迹）；
 *  - 宽扁的横笔画（左侧、位于数字垂直中带内）强制判为负号，避免模型漏掉 '-'；
 *  - 过小的点/斑（远小于同组数字高度）按噪迹丢弃；
 *  - 按横向间隙聚成「一个数」，出现多个都像分数的聚类时视为有歧义 → value=null；
 *  - 置信度取各字符最小值，有噪迹时打折；低于门槛 → value=null（绝不猜）。
 */
import type { LocalOcrDigit, LocalOcrOptions, LocalOcrReason, LocalOcrResult, LocalOcrStats } from "./types";

export const CLASS_NAMES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-", "junk"] as const;
export const MINUS_INDEX = 10;
export const JUNK_INDEX = 11;

export interface GlyphPrediction {
  /** 字形包围盒（输入画布像素坐标） */
  rect: { x: number; y: number; w: number; h: number };
  /** 12 类概率（softmax 输出） */
  probs: Float32Array;
  /** 该字形的墨迹像素数，缺省用 w*h 粗略代替 */
  area?: number;
}

export interface DecodeOptions extends LocalOcrOptions {
  /** 横向聚类的间隙阈值（相对字高中位数），默认 0.75 */
  clusterGapRatio?: number;
  /** 有噪迹混入时置信度的折扣，默认 0.9 */
  junkPenalty?: number;
}

const DEFAULTS = {
  minConfidence: 0.72,
  minDigitConfidence: 0.5,
  maxDigits: 3,
  maxValue: 999,
  minGlyphHeight: 10,
  clusterGapRatio: 0.75,
  junkPenalty: 0.9,
};

type GlyphKind = "digit" | "minus" | "junk";

interface ClassifiedGlyph {
  rect: { x: number; y: number; w: number; h: number };
  label: string;
  kind: GlyphKind;
  confidence: number;
  probs: Float32Array;
  area: number;
}

interface ClusterEval {
  glyphs: ClassifiedGlyph[];
  text: string;
  formatValid: boolean;
  digitsValid: boolean;
  confidence: number;
  value: number | null;
  digits: LocalOcrDigit[];
}

function argmax(probs: Float32Array): number {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function toDigit(g: ClassifiedGlyph): LocalOcrDigit {
  return { rect: { ...g.rect }, label: g.label, confidence: g.confidence };
}

/** 把横向相邻的字形聚类；相邻间隙超过阈值就断开。 */
function clusterGlyphs(glyphs: ClassifiedGlyph[], gap: number): ClassifiedGlyph[][] {
  if (glyphs.length === 0) return [];
  const clusters: ClassifiedGlyph[][] = [[glyphs[0]]];
  for (let i = 1; i < glyphs.length; i++) {
    const prev = glyphs[i - 1];
    const cur = glyphs[i];
    const prevRight = prev.rect.x + prev.rect.w;
    if (cur.rect.x - prevRight > gap) clusters.push([cur]);
    else clusters[clusters.length - 1].push(cur);
  }
  return clusters;
}

function evaluateCluster(glyphs: ClassifiedGlyph[], opts: typeof DEFAULTS): ClusterEval {
  const ordered = [...glyphs].sort((a, b) => a.rect.x - b.rect.x);
  const text = ordered.map((g) => g.label).join("");
  const digitHeights = ordered.filter((g) => g.kind === "digit").map((g) => g.rect.h);
  const heightOk = digitHeights.length === 0
    ? true
    : Math.max(...digitHeights) / Math.max(1, Math.min(...digitHeights)) <= 1.9;
  const pattern = new RegExp(`^-?(0|[1-9]\\d{0,${Math.max(0, opts.maxDigits - 1)}})$`);
  let formatValid = pattern.test(text) && text !== "-0";
  // 负号必须出现在最前面
  if (ordered.some((g, i) => g.kind === "minus" && i !== 0)) formatValid = false;
  if (!heightOk) formatValid = false;
  const confidence = ordered.length === 0 ? 0 : Math.min(...ordered.map((g) => g.confidence));
  let value: number | null = null;
  if (formatValid) {
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v) <= opts.maxValue) value = v;
    else formatValid = false;
  }
  return {
    glyphs: ordered,
    text,
    formatValid,
    digitsValid: ordered.every((g) => g.kind === "minus" || g.confidence >= opts.minDigitConfidence),
    confidence,
    value,
    digits: ordered.filter((g) => g.kind !== "junk").map(toDigit),
  };
}

function emptyResult(reason: LocalOcrReason, stats: LocalOcrStats, confidence = 0, text = ""): LocalOcrResult {
  return { text, value: null, confidence: Math.round(confidence * 1000) / 1000, digits: [], reason, stats };
}

/**
 * 解码：输入每个字形的分类概率，输出文本/分数/置信度。
 * 纯函数，不依赖 DOM 与模型文件。
 */
export function decodeGlyphPredictions(
  predictions: GlyphPrediction[],
  options?: DecodeOptions,
): LocalOcrResult {
  const opts = { ...DEFAULTS, ...options };
  const stats: LocalOcrStats = {
    glyphCount: predictions.length,
    junkCount: 0,
    clusterCount: 0,
    clusterTexts: [],
  };
  if (predictions.length === 0) return emptyResult("empty", stats);

  const tops = predictions.map((p) => argmax(p.probs));
  const heights = predictions.map((p) => Math.max(1, p.rect.h));
  const prelimDigitHeights = predictions.filter((_, i) => tops[i] <= 9).map((p) => Math.max(1, p.rect.h));
  const medH = prelimDigitHeights.length > 0 ? median(prelimDigitHeights) : median(heights);
  const prelimCenters = predictions.filter((_, i) => tops[i] <= 9).map((p) => p.rect.y + p.rect.h / 2);
  const bandCenter = prelimCenters.length > 0 ? median(prelimCenters) : median(predictions.map((p) => p.rect.y + p.rect.h / 2));

  const classified: ClassifiedGlyph[] = [];
  const singleGlyph = predictions.length === 1;
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    const top = tops[i];
    const w = Math.max(1, p.rect.w);
    const h = Math.max(1, p.rect.h);
    const area = p.area ?? w * h;
    const aspect = w / h;
    const centerY = p.rect.y + h / 2;
    const midBand = Math.abs(centerY - bandCenter) <= Math.max(2, 0.32 * medH);
    const dashLike = aspect >= 2 && h <= 0.5 * medH && midBand;
    // 区域里只有一个字形且非常扁：几乎只可能是负号/下划线，判负号（最终分数仍会因格式非法而返回 null）
    const loneDash = singleGlyph && aspect >= 2.2;
    const base = { rect: { ...p.rect }, probs: p.probs, area };
    if (top === JUNK_INDEX) {
      // 模型把「很小的扁横笔画」当噪迹是常见情况，但老师写的负号也可能这样。
      // 若它明显是横线且位于数字垂直中带，保留成低置信度的负号候选，交给上层人工确认，
      // 避免把 -3 悄悄读成 3。
      if ((dashLike || loneDash) && w >= 4) {
        classified.push({ ...base, label: "-", kind: "minus", confidence: Math.min(0.9, Math.max(p.probs[MINUS_INDEX], 0.85)) });
      } else {
        classified.push({ ...base, label: "junk", kind: "junk", confidence: p.probs[JUNK_INDEX] });
      }
      continue;
    }
    if (top === MINUS_INDEX) {
      // 模型说是负号：还要求形状确实宽扁、且位于数字垂直中带，否则按噪迹处理，
      // 避免把红勾/划线误当成负号，拼出 -7 这类错误分数。
      if (aspect >= 1.6 && (singleGlyph || (h <= 0.55 * medH && midBand))) {
        classified.push({ ...base, label: "-", kind: "minus", confidence: p.probs[MINUS_INDEX] });
      } else {
        classified.push({ ...base, label: "junk", kind: "junk", confidence: p.probs[MINUS_INDEX] });
      }
      continue;
    }
    if ((dashLike || loneDash) && w >= 4) {
      // 宽扁横笔画且位于数字垂直中带：强制当作负号（老师手写的负号常被模型看成数字）
      classified.push({ ...base, label: "-", kind: "minus", confidence: Math.max(p.probs[MINUS_INDEX], 0.9) });
      continue;
    }
    const tiny = h < 0.35 * medH && w < 0.7 * medH;
    if (tiny) {
      // 远小于同组数字的小点/短划：按噪迹丢弃（用中位高度而不是最大高度，
      // 避免题目区域里的大红勾把真正数字“衬”成噪点）
      classified.push({ ...base, label: "junk", kind: "junk", confidence: p.probs[top] });
      continue;
    }
    classified.push({ ...base, label: CLASS_NAMES[top], kind: "digit", confidence: p.probs[top] });
  }

  const kept = classified.filter((g) => g.kind !== "junk").sort((a, b) => a.rect.x - b.rect.x);
  stats.junkCount = classified.length - kept.length;

  const rawText = classified
    .slice()
    .sort((a, b) => a.rect.x - b.rect.x)
    .map((g) => (g.kind === "junk" ? "" : g.label))
    .join("");

  if (kept.length === 0) return emptyResult("no-valid-number", stats);

  const gap = Math.max(1.5, opts.clusterGapRatio * medH);
  const rawClusters = clusterGlyphs(kept, gap);
  stats.clusterCount = rawClusters.length;
  const evals = rawClusters.map((c) => evaluateCluster(c, opts));
  stats.clusterTexts = evals.map((e) => e.text);

  // 把分开写的负号（"- 3"）拼回右侧数字
  const minusOnly = evals.filter((e) => e.text === "-");
  const digitCandidates = evals.filter((e) => e.value != null && e.text.length > 0 && !e.text.startsWith("-"));
  let mergedMinus = false;
  if (minusOnly.length === 1 && digitCandidates.length === 1) {
    const cand = digitCandidates[0];
    const minus = minusOnly[0];
    const minusRight = minus.glyphs[0].rect.x + minus.glyphs[0].rect.w;
    const candLeft = cand.glyphs[0].rect.x;
    const gapPx = candLeft - minusRight;
    const mc = minus.glyphs[0].rect.y + minus.glyphs[0].rect.h / 2;
    const cc = cand.glyphs[0].rect.y + cand.glyphs[0].rect.h / 2;
    if (gapPx >= -2 && gapPx <= 2.5 * medH && Math.abs(mc - cc) <= 0.6 * medH) {
      const mergedText = `-${cand.text}`;
      const pattern = new RegExp(`^-?(0|[1-9]\\d{0,${Math.max(0, opts.maxDigits - 1)}})$`);
      if (pattern.test(mergedText) && mergedText !== "-0") {
        const v = Number(mergedText);
        if (Number.isFinite(v) && Math.abs(v) <= opts.maxValue) {
          const merged: ClusterEval = {
            ...cand,
            text: mergedText,
            value: v,
            confidence: Math.min(cand.confidence, minus.confidence),
            digits: [...minus.digits, ...cand.digits],
            glyphs: [...minus.glyphs, ...cand.glyphs],
          };
          evals[evals.indexOf(cand)] = merged;
          mergedMinus = true;
        }
      }
    }
  }

  const validClusters = evals.filter((e) => e.formatValid && e.value != null);
  let chosen: ClusterEval | null = null;
  if (validClusters.length === 1 && !mergedMinus) {
    const cand = validClusters[0];
    // 左侧还有一个没拼上的负号：不能忽略它（否则 -7 会被读成 7），交人工确认
    const strayMinus = minusOnly.find((m) => {
      const mRect = m.glyphs[0].rect;
      const cRect = cand.glyphs[0].rect;
      const mc = mRect.y + mRect.h / 2;
      const cc = cRect.y + cRect.h / 2;
      return mRect.x + mRect.w <= cRect.x && Math.abs(mc - cc) <= 0.6 * medH;
    });
    if (strayMinus) {
      const confidence = Math.max(cand.confidence, strayMinus.confidence);
      return emptyResult("ambiguous", stats, confidence, rawText);
    }
  }
  if (validClusters.length === 1) {
    chosen = mergedMinus ? evals.filter((e) => e.formatValid && e.value != null)[0] : validClusters[0];
  } else if (validClusters.length > 1) {
    // 有多个都像分数的聚类：不猜，交人工
    const confidence = Math.max(...validClusters.map((c) => c.confidence));
    return emptyResult("ambiguous", stats, confidence, rawText);
  }

  if (!chosen) {
    const best = evals.reduce<ClusterEval | null>((acc, e) => (acc == null || e.confidence > acc.confidence ? e : acc), null);
    const reason: LocalOcrReason = best && best.glyphs.length > 0 ? "invalid-format" : "no-valid-number";
    return emptyResult(reason, stats, best?.confidence ?? 0, rawText);
  }

  let confidence = chosen.confidence;
  if (stats.junkCount > 0) confidence *= opts.junkPenalty;
  confidence = Math.max(0, Math.min(1, confidence));
  const digitHeights = chosen.glyphs.filter((g) => g.kind === "digit").map((g) => g.rect.h);
  const medianHeight = median(digitHeights);
  const tooSmall = digitHeights.length > 0 && medianHeight < opts.minGlyphHeight;
  if (!chosen.digitsValid || tooSmall || confidence < opts.minConfidence) {
    return {
      text: chosen.text,
      value: null,
      confidence: Math.round(confidence * 1000) / 1000,
      digits: chosen.digits,
      reason: "low-confidence",
      stats,
    };
  }
  return {
    text: chosen.text,
    value: chosen.value,
    confidence: Math.round(confidence * 1000) / 1000,
    digits: chosen.digits,
    reason: "ok",
    stats,
  };
}
