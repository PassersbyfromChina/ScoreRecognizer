import type { AnswerRecord, AppSettings, CardTemplate, Capture, Region, Student } from "../types";
import { DEFAULT_LONG_SIDE, cropExpanded, cropNameRegion, normalizeCard, regionToPixels } from "../imaging/pipeline";
import { cropCanvas, canvasToBlob } from "../imaging/canvas";
import { extractRedInk, type RedComponent } from "../imaging/red";
import { recognizeCrops, type CropImage } from "./aiRecognize";
import { matchStudent } from "./nameMatch";

export interface ProcessContext {
  settings: AppSettings;
  template: CardTemplate;
  students: Student[];
  onProgress?: (stage: string) => void;
}

export interface ProcessedCapture {
  correctedBlob: Blob;
  correctedWidth: number;
  correctedHeight: number;
  answers: AnswerRecord[];
  nameText?: string;
  nameConfidence?: number;
  nameState?: Capture["nameState"];
  studentId?: string;
  error?: string;
  warnings: string[];
}

function scaleCanvas(canvas: HTMLCanvasElement, minSize = 220, maxSize = 480): HTMLCanvasElement {
  const long = Math.max(canvas.width, canvas.height);
  if (long < minSize) {
    const k = minSize / long;
    const out = document.createElement("canvas");
    out.width = Math.round(canvas.width * k);
    out.height = Math.round(canvas.height * k);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }
  if (long > maxSize) {
    const k = maxSize / long;
    const out = document.createElement("canvas");
    out.width = Math.round(canvas.width * k);
    out.height = Math.round(canvas.height * k);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }
  return canvas;
}

function unionBox(components: RedComponent[]): { x: number; y: number; w: number; h: number } | null {
  if (components.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function componentsNear(
  components: RedComponent[],
  region: Region,
  longSidePx: number,
): RedComponent[] {
  const px = regionToPixels(region, longSidePx);
  const rx = px.x - px.w * 0.75;
  const ry = px.y - px.h * 1.2;
  const rw = px.w * 2.5;
  const rh = px.h * 3.4;
  return components.filter((c) => {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
  });
}

function cropForQuestion(
  canvas: HTMLCanvasElement,
  region: Region,
  longSidePx: number,
  components: RedComponent[],
): HTMLCanvasElement {
  const px = regionToPixels(region, longSidePx);
  const expanded = cropExpanded(canvas, region, longSidePx, 0.55, 0.9);
  const ink = componentsNear(components, region, longSidePx);
  const box = unionBox(ink);
  if (!box) return scaleCanvas(expanded);
  // 红笔框 + 区域本身取并集，再留一点边距
  const pad = Math.max(px.w, px.h) * 0.18;
  const x = Math.min(px.x, box.x) - pad;
  const y = Math.min(px.y, box.y) - pad;
  const w = Math.max(px.x + px.w, box.x + box.w) + pad - x;
  const h = Math.max(px.y + px.h, box.y + box.h) + pad - y;
  return scaleCanvas(cropCanvas(canvas, { x, y, w, h }));
}

interface AiAnswer {
  score: number | null;
  confidence: number;
  issue: string | null;
}

interface LocalAnswer {
  value: number | null;
  confidence: number;
  text: string;
  reason: string;
}

/** 在题目区域附近挑出最可能是「这道题分数」的一组红笔连通域（避免把隔壁分数/红勾一起读进来）。 */
function pickScoreCluster(
  components: RedComponent[],
  region: Region,
  longSidePx: number,
): RedComponent[] | null {
  const px = regionToPixels(region, longSidePx);
  const marginX = px.w * 0.5;
  const marginY = px.h * 0.65;
  const box = {
    x: px.x - marginX,
    y: px.y - marginY,
    w: px.w + marginX * 2,
    h: px.h + marginY * 2,
  };
  const candidates = components.filter((c) => {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const hRatio = c.h / longSidePx;
    if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) return false;
    if (hRatio < 0.008 || hRatio > 0.11) return false;
    if (c.w / Math.max(1, c.h) > 3.5) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  // 按水平位置排序后把相邻、高度相近的连通域聚成一组（多位数）
  const sorted = [...candidates].sort((a, b) => a.x - b.x);
  const clusters: RedComponent[][] = [];
  for (const comp of sorted) {
    let placed = false;
    for (const cluster of clusters) {
      const last = cluster[cluster.length - 1];
      const gap = comp.x - (last.x + last.w);
      const overlap = Math.min(last.y + last.h, comp.y + comp.h) - Math.max(last.y, comp.y);
      const heightRatio = Math.max(last.h, comp.h) / Math.max(1, Math.min(last.h, comp.h));
      if (gap <= Math.max(10, last.h * 1.4) && overlap > Math.min(last.h, comp.h) * 0.35 && heightRatio < 1.9) {
        cluster.push(comp);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([comp]);
  }

  const regionCx = px.x + px.w / 2;
  const regionCy = px.y + px.h / 2;
  let best: RedComponent[] | null = null;
  let bestScore = Infinity;
  for (const cluster of clusters) {
    if (cluster.length > 3) continue;
    const u = unionBox(cluster);
    if (!u) continue;
    const cx = u.x + u.w / 2;
    const cy = u.y + u.h / 2;
    const dist = Math.hypot(cx - regionCx, cy - regionCy);
    // 太小的噪点组不参与
    if (u.h < longSidePx * 0.01) continue;
    const score = dist;
    if (score < bestScore) {
      bestScore = score;
      best = cluster;
    }
  }
  return best;
}

/** 本地离线数字识别（懒加载模型；只在题目区域附近裁剪一小块，失败返回 null）。 */
async function recognizeLocal(
  canvas: HTMLCanvasElement,
  region: Region,
  longSidePx: number,
  components: RedComponent[],
): Promise<LocalAnswer | null> {
  const cluster = pickScoreCluster(components, region, longSidePx);
  if (!cluster || cluster.length === 0) return null;
  const box = unionBox(cluster);
  if (!box) return null;
  const pad = Math.max(box.w, box.h) * 0.35;
  const crop = cropCanvas(canvas, {
    x: box.x - pad,
    y: box.y - pad,
    w: box.w + pad * 2,
    h: box.h + pad * 2,
  });
  try {
    const { recognizeDigitsFromCanvas } = await import("../localocr/index");
    const result = await recognizeDigitsFromCanvas(crop, { maxValue: 100, minConfidence: 0.85 });
    return {
      value: result.value,
      confidence: result.confidence,
      text: result.text,
      reason: result.reason,
    };
  } catch (e) {
    console.warn("[localocr] 本地识别失败", e);
    return null;
  }
}

function evaluateAnswer(
  questionNo: number,
  ai: AiAnswer | undefined,
  local: LocalAnswer | null | undefined,
  longSidePx: number,
  components: RedComponent[],
  region: Region,
): AnswerRecord {
  const ink = componentsNear(components, region, longSidePx);
  const box = unionBox(ink);
  const inkBox = box
    ? { x: box.x / longSidePx, y: box.y / longSidePx, w: box.w / longSidePx, h: box.h / longSidePx }
    : undefined;
  const inkCount = ink.length;
  const localValue =
    local && local.value != null && local.confidence >= 0.9 && local.reason === "ok" && Math.abs(local.value) <= 100
      ? local.value
      : null;
  const localConf = local ? local.confidence : 0;

  // 没有 AI 结果：完全依赖本地识别或人工
  if (!ai) {
    if (inkCount === 0) {
      return { questionNo, rawScore: null, confidence: 0, state: "missing", finalScore: null, inkBox, note: "没有找到红色笔迹" };
    }
    if (localValue != null) {
      const strong = localConf >= 0.9;
      return {
        questionNo,
        rawScore: localValue,
        confidence: localConf,
        state: strong ? "ok" : "low_confidence",
        finalScore: null,
        inkBox,
        note: strong ? "本地识别" : "本地识别（置信度较低），请确认",
      };
    }
    return {
      questionNo,
      rawScore: null,
      confidence: localConf,
      state: "low_confidence",
      finalScore: null,
      inkBox,
      note: "本地识别无法确定，请人工输入",
    };
  }

  if (ai.issue === "multiple") {
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "multiple", finalScore: null, inkBox, note: "同一题出现两个分数" };
  }

  if (ai.issue === "missing" || ai.score == null) {
    if (localValue != null) {
      return {
        questionNo,
        rawScore: localValue,
        confidence: Math.max(0.4, Math.min(ai.confidence, localConf)),
        state: "low_confidence",
        finalScore: null,
        inkBox,
        note: `AI 没找到，本地识别为 ${localValue}，请确认`,
      };
    }
    if (ai.issue === "unclear") {
      return { questionNo, rawScore: null, confidence: ai.confidence, state: "low_confidence", finalScore: null, inkBox, note: "字迹看不清" };
    }
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "missing", finalScore: null, inkBox, note: "没有找到红色分数" };
  }

  if (ai.issue === "unclear") {
    if (localValue != null && localConf >= 0.85) {
      return {
        questionNo,
        rawScore: localValue,
        confidence: localConf,
        state: "low_confidence",
        finalScore: null,
        inkBox,
        note: "AI 看不清，本地识别结果如下，请确认",
      };
    }
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "low_confidence", finalScore: null, inkBox, note: "字迹看不清" };
  }

  // AI 有分数：与本地结果交叉校验
  if (localValue != null && localValue !== ai.score) {
    return {
      questionNo,
      rawScore: ai.score,
      confidence: Math.min(ai.confidence, localConf),
      state: "low_confidence",
      finalScore: null,
      inkBox,
      note: `AI 识别为 ${ai.score}，本地为 ${localValue}，不一致，请确认`,
    };
  }

  if (inkCount === 0) {
    return {
      questionNo,
      rawScore: ai.score,
      confidence: Math.min(ai.confidence, 0.4),
      state: "low_confidence",
      finalScore: null,
      inkBox,
      note: "本地没有找到红色笔迹，请确认",
    };
  }

  if (localValue == null && ai.confidence < 0.85) {
    return { questionNo, rawScore: ai.score, confidence: ai.confidence, state: "low_confidence", finalScore: null, inkBox, note: "请确认识别结果" };
  }

  if (ai.confidence < 0.7) {
    return { questionNo, rawScore: ai.score, confidence: ai.confidence, state: "low_confidence", finalScore: null, inkBox };
  }

  return { questionNo, rawScore: ai.score, confidence: ai.confidence, state: "ok", finalScore: null, inkBox };
}

/** 处理一张答题卡：矫正 → 本地红笔分析 → 裁剪 → AI 识别 → 生成待确认记录。 */
export async function processCapture(blob: Blob, ctx: ProcessContext): Promise<ProcessedCapture> {
  const { settings, template, students, onProgress } = ctx;
  const warnings: string[] = [];

  onProgress?.("正在识别答题卡边缘…");
  const normalized = await normalizeCard(blob, { aspect: template.aspect, longSide: DEFAULT_LONG_SIDE });
  const canvas = normalized.canvas;
  const longSidePx = Math.max(canvas.width, canvas.height);

  onProgress?.("正在提取红色笔迹…");
  const extraction = extractRedInk(canvas);
  const questionRegions = template.regions
    .filter((r) => r.kind === "question" && r.questionNo != null)
    .sort((a, b) => (a.questionNo ?? 0) - (b.questionNo ?? 0));

  const nameRegion = template.regions.find((r) => r.kind === "name");
  const nameComponents = nameRegion ? componentsNear(extraction.components, nameRegion, longSidePx) : [];

  const answerByQuestion = new Map<number, AiAnswer>();
  let aiName: string | null = null;
  let aiNameConfidence = 0;

  const aiConfigured = Boolean(settings.aiEnabled && settings.apiKey);
  if (aiConfigured && questionRegions.length > 0) {
    onProgress?.("AI 正在识别分数…");
    const crops: CropImage[] = questionRegions.map((region) => {
      const crop = cropForQuestion(canvas, region, longSidePx, extraction.components);
      return {
        questionNo: region.questionNo,
        label: `第 ${region.questionNo} 题局部`,
        dataUrl: crop.toDataURL("image/jpeg", 0.9),
      };
    });
    let nameCrop: CropImage | null = null;
    if (nameRegion) {
      const blobCrop = await cropNameRegion(canvas, nameRegion, longSidePx);
      const dataUrl = await blobToDataUrl(blobCrop);
      nameCrop = { label: "手写姓名局部", dataUrl };
    }
    const result = await recognizeCrops(settings, crops, nameCrop);
    for (const [q, a] of result.answers) answerByQuestion.set(q, a);
    aiName = result.name;
    aiNameConfidence = result.nameConfidence;
    if (result.errors.length > 0) {
      warnings.push(...result.errors.slice(0, 2));
    }
  } else if (!settings.apiKey) {
    warnings.push("没有配置 AI Key：分数用本地识别，姓名请手动确认");
  } else if (!settings.aiEnabled) {
    warnings.push("已关闭 AI 识别：分数用本地识别，姓名请手动确认");
  }

  // 本地离线数字识别：作为独立识别通道，也用于和 AI 交叉校验
  const localByQuestion = new Map<number, LocalAnswer | null>();
  let localModelFailed = false;
  if (questionRegions.length > 0) {
    onProgress?.("本地数字识别…");
    for (const region of questionRegions) {
      const ink = componentsNear(extraction.components, region, longSidePx);
      if (ink.length === 0) {
        localByQuestion.set(region.questionNo!, null);
        continue;
      }
      const local = await recognizeLocal(canvas, region, longSidePx, extraction.components);
      if (local === null) localModelFailed = true;
      localByQuestion.set(region.questionNo!, local);
    }
    if (localModelFailed) warnings.push("本地数字识别模型加载失败，相关题目请人工确认");
  }

  const answers: AnswerRecord[] = questionRegions.map((region) =>
    evaluateAnswer(
      region.questionNo!,
      answerByQuestion.get(region.questionNo!),
      localByQuestion.get(region.questionNo!),
      longSidePx,
      extraction.components,
      region,
    ),
  );

  let nameText: string | undefined;
  let nameState: Capture["nameState"] = "unreviewed";
  let studentId: string | undefined;
  if (aiName) {
    const match = matchStudent(aiName, students);
    nameText = aiName;
    if (match.studentId) {
      studentId = match.studentId;
      nameState = "ok";
    } else {
      nameState = "low_confidence";
      if (match.candidates.length > 0) nameText = `${aiName}（可能是 ${match.candidates[0].name}）`;
    }
  } else if (nameRegion) {
    nameState = nameComponents.length > 0 ? "unreviewed" : "unreviewed";
  }

  onProgress?.("保存图片…");
  const correctedBlob = await canvasToBlob(canvas, "image/jpeg", 0.9);

  return {
    correctedBlob,
    correctedWidth: canvas.width,
    correctedHeight: canvas.height,
    answers,
    nameText,
    nameConfidence: aiNameConfidence,
    nameState,
    studentId,
    warnings,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
