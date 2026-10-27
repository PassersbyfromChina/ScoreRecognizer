/**
 * 离线本地数字识别（local OCR）入口。
 *
 * 用法：
 *   import { recognizeDigitsFromCanvas } from "../localocr";
 *   const r = await recognizeDigitsFromCanvas(cropCanvas);
 *   if (r.value != null) use(r.value); else 转人工确认;
 *
 * 纯前端、无网络请求（模型 JSON 从 public/models 懒加载，仅一次）。
 */
import { decodeGlyphPredictions, type GlyphPrediction } from "./decode";
import { loadDigitModel, predictGlyph, type DigitModel } from "./model";
import { segmentRedGlyphs } from "./preprocess";
import type { LocalOcrOptions, LocalOcrResult } from "./types";

function emptyResult(): LocalOcrResult {
  return {
    text: "",
    value: null,
    confidence: 0,
    digits: [],
    reason: "empty",
    stats: { glyphCount: 0, junkCount: 0, clusterCount: 0, clusterTexts: [] },
  };
}

/**
 * 从 RGBA 像素数据识别红笔数字。
 * @param data RGBA 顺序（4 字节/像素），长度 = width*height*4
 */
export async function recognizeDigitsFromImageData(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options?: LocalOcrOptions,
): Promise<LocalOcrResult> {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return emptyResult();
  const model = options?.model ?? (await loadDigitModel());
  const { glyphs } = segmentRedGlyphs(data, width, height);
  const predictions: GlyphPrediction[] = glyphs.map((entry) => ({
    rect: { x: entry.glyph.x, y: entry.glyph.y, w: entry.glyph.w, h: entry.glyph.h },
    probs: predictGlyph(model, entry.input),
    area: entry.glyph.area,
  }));
  return decodeGlyphPredictions(predictions, options);
}

/** 从裁剪后的画布识别红笔数字（主要入口）。 */
export async function recognizeDigitsFromCanvas(
  canvas: HTMLCanvasElement,
  options?: LocalOcrOptions,
): Promise<LocalOcrResult> {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return emptyResult();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return emptyResult();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return recognizeDigitsFromImageData(image.data, image.width, image.height, options);
}

/** 预热：提前加载模型（可选，在设置页/进流程前调用可避免第一次识别卡顿）。 */
export async function preloadLocalOcr(): Promise<boolean> {
  try {
    await loadDigitModel();
    return true;
  } catch (e) {
    console.warn("[localocr] 模型预加载失败", e);
    return false;
  }
}

/** 用指定模型同步识别（模型已加载时使用；给需要同步的调用方留口子）。 */
export function recognizeDigitsFromImageDataSync(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  model: DigitModel,
  options?: LocalOcrOptions,
): LocalOcrResult {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return emptyResult();
  const { glyphs } = segmentRedGlyphs(data, width, height);
  const predictions: GlyphPrediction[] = glyphs.map((entry) => ({
    rect: { x: entry.glyph.x, y: entry.glyph.y, w: entry.glyph.w, h: entry.glyph.h },
    probs: predictGlyph(model, entry.input),
    area: entry.glyph.area,
  }));
  return decodeGlyphPredictions(predictions, options);
}

export type { LocalOcrDigit, LocalOcrOptions, LocalOcrReason, LocalOcrResult } from "./types";
export type { DigitModel } from "./model";
export { parseModel, predictGlyph, loadDigitModel, getDefaultModelUrl } from "./model";
export { decodeGlyphPredictions, CLASS_NAMES, MINUS_INDEX, JUNK_INDEX } from "./decode";
export { segmentRedGlyphs, normalizeGlyph, binarizeRed, labelComponents, mergeStrokesIntoGlyphs } from "./preprocess";
