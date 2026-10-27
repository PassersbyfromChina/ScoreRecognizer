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

function evaluateAnswer(
  questionNo: number,
  ai: { score: number | null; confidence: number; issue: string | null } | undefined,
  localInkCount: number,
  longSidePx: number,
  components: RedComponent[],
  region: Region,
): AnswerRecord {
  const ink = componentsNear(components, region, longSidePx);
  const box = unionBox(ink);
  const inkBox = box
    ? { x: box.x / longSidePx, y: box.y / longSidePx, w: box.w / longSidePx, h: box.h / longSidePx }
    : undefined;

  if (!ai) {
    return {
      questionNo,
      rawScore: null,
      confidence: 0,
      state: "unreviewed",
      finalScore: null,
      inkBox,
      note: "还没有自动识别，请人工确认",
    };
  }

  if (ai.issue === "missing" || (ai.score == null && ai.issue !== "unclear" && ai.issue !== "multiple")) {
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "missing", finalScore: null, inkBox, note: "没有找到红色分数" };
  }
  if (ai.issue === "multiple") {
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "multiple", finalScore: null, inkBox, note: "同一题出现两个分数" };
  }
  if (ai.issue === "unclear") {
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "low_confidence", finalScore: null, inkBox, note: "字迹看不清" };
  }
  if (ai.score == null) {
    return { questionNo, rawScore: null, confidence: ai.confidence, state: "missing", finalScore: null, inkBox, note: "没有找到红色分数" };
  }
  if (localInkCount === 0) {
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

  const answerByQuestion = new Map<number, { score: number | null; confidence: number; issue: string | null }>();
  let aiName: string | null = null;
  let aiNameConfidence = 0;
  let aiErrors: string[] = [];

  if (settings.aiEnabled && settings.apiKey && questionRegions.length > 0) {
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
    aiErrors = result.errors;
    for (const [q, a] of result.answers) answerByQuestion.set(q, a);
    aiName = result.name;
    aiNameConfidence = result.nameConfidence;
    if (result.errors.length > 0) {
      warnings.push(...result.errors.slice(0, 2));
    }
  } else if (settings.aiEnabled && !settings.apiKey) {
    warnings.push("没有配置 AI Key，已跳过自动识别，请人工输入");
  }

  const answers: AnswerRecord[] = questionRegions.map((region) =>
    evaluateAnswer(
      region.questionNo!,
      answerByQuestion.get(region.questionNo!),
      componentsNear(extraction.components, region, longSidePx).length,
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
