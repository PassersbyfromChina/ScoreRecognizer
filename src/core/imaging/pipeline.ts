import type { DetectionResult, Point, Rect, Region } from "../types";
import { canvasToBlob, cropCanvas, drawToCanvas, loadImageBitmap, warpCanvasToRect } from "./canvas";
import { detectCardCorners } from "./detect";
import { extractRedInk, type RedComponent } from "./red";

/** A4 竖版：宽/高 */
export const DEFAULT_ASPECT = 210 / 297;
export const DEFAULT_LONG_SIDE = 1600;
const MAX_SOURCE_LONG_SIDE = 2600;

export interface LoadedCard {
  canvas: HTMLCanvasElement;
  corners: [Point, Point, Point, Point];
  detection: DetectionResult | null;
  width: number;
  height: number;
}

export interface CorrectedCard {
  canvas: HTMLCanvasElement;
  /** 标准卡长边像素 */
  longSide: number;
  /** 宽/高 */
  aspect: number;
  corners: [Point, Point, Point, Point];
  confidence: number;
  method: string;
}

/** 读入图片并在原图上检测答题卡四角（不矫正）。 */
export async function loadCard(blob: Blob): Promise<LoadedCard> {
  const bitmap = await loadImageBitmap(blob);
  const src = drawToCanvas(bitmap, bitmap.width, bitmap.height, MAX_SOURCE_LONG_SIDE);
  const detection = detectCardCorners(src, { width: src.width, height: src.height });
  return {
    canvas: src,
    corners: detection.corners,
    detection,
    width: src.width,
    height: src.height,
  };
}

/** 用四角把图片矫正成标准答题卡。 */
export function correctCard(
  source: HTMLCanvasElement,
  corners: [Point, Point, Point, Point],
  aspect = DEFAULT_ASPECT,
  longSide = DEFAULT_LONG_SIDE,
): HTMLCanvasElement {
  const target = targetSize(aspect, longSide);
  return warpCanvasToRect(source, corners, target.width, target.height);
}

export function targetSize(aspect: number, longSide: number): { width: number; height: number } {
  if (aspect <= 1) {
    return { width: Math.round(longSide * aspect), height: Math.round(longSide) };
  }
  return { width: Math.round(longSide), height: Math.round(longSide / aspect) };
}

export async function normalizeCard(
  blob: Blob,
  opts?: { corners?: [Point, Point, Point, Point]; aspect?: number; longSide?: number },
): Promise<CorrectedCard> {
  const loaded = await loadCard(blob);
  const corners = opts?.corners ?? loaded.corners;
  const aspect = opts?.aspect ?? DEFAULT_ASPECT;
  const longSide = opts?.longSide ?? DEFAULT_LONG_SIDE;
  const canvas = correctCard(loaded.canvas, corners, aspect, longSide);
  return {
    canvas,
    longSide,
    aspect,
    corners: loaded.corners,
    confidence: loaded.detection?.confidence ?? 0,
    method: loaded.detection?.method ?? "manual",
  };
}

/** 把「长边=1」坐标的区域换算成矫正图像素。 */
export function regionToPixels(region: Rect, longSidePx: number): { x: number; y: number; w: number; h: number } {
  return {
    x: region.x * longSidePx,
    y: region.y * longSidePx,
    w: region.w * longSidePx,
    h: region.h * longSidePx,
  };
}

/** 裁剪区域并向外扩一圈（红笔分数常写在题目区域外）。 */
export function cropExpanded(
  canvas: HTMLCanvasElement,
  rect: Rect,
  longSidePx: number,
  marginX = 0.6,
  marginY = 1.0,
): HTMLCanvasElement {
  const px = regionToPixels(rect, longSidePx);
  const mx = px.w * marginX;
  const my = px.h * marginY;
  return cropCanvas(canvas, {
    x: px.x - mx,
    y: px.y - my,
    w: px.w + mx * 2,
    h: px.h + my * 2,
  });
}

export interface CardInkAnalysis {
  components: RedComponent[];
  /** 每个题目区域内（含一点外边距）的红笔组件数量 */
  perQuestion: Map<number, RedComponent[]>;
  /** 姓名区域附近是否有黑色笔迹（简单用暗像素比例判断，后续可细化） */
  nameInk: boolean;
}

/** 本地分析：找出红笔组件，并按题目区域分组。 */
export function analyzeInk(canvas: HTMLCanvasElement, regions: Region[], longSidePx: number): CardInkAnalysis {
  const extraction = extractRedInk(canvas);
  const perQuestion = new Map<number, RedComponent[]>();
  for (const region of regions) {
    if (region.kind !== "question" || region.questionNo == null) continue;
    const px = regionToPixels(region, longSidePx);
    const expanded = {
      x: px.x - px.w * 0.7,
      y: px.y - px.h * 1.1,
      w: px.w * 2.4,
      h: px.h * 3.2,
    };
    const list = extraction.components.filter((c) => {
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      return cx >= expanded.x && cx <= expanded.x + expanded.w && cy >= expanded.y && cy <= expanded.y + expanded.h;
    });
    perQuestion.set(region.questionNo, list);
  }

  let nameInk = false;
  const nameRegion = regions.find((r) => r.kind === "name");
  if (nameRegion) {
    const px = regionToPixels(nameRegion, longSidePx);
    nameInk = hasDarkPixels(canvas, px);
  }

  return { components: extraction.components, perQuestion, nameInk };
}

/** 判断一个像素区域内是否有足够多的深色像素（手写黑色姓名）。 */
export function hasDarkPixels(canvas: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }): boolean {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(canvas.width - x, Math.round(rect.w));
  const h = Math.min(canvas.height - y, Math.round(rect.h));
  if (w <= 0 || h <= 0) return false;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data } = ctx.getImageData(x, y, w, h);
  let dark = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    total++;
    if (l < 110) dark++;
  }
  return total > 0 && dark / total > 0.004;
}

/** 裁剪姓名区域（放大一点，宽高各留 20% 边距）。 */
export async function cropNameRegion(canvas: HTMLCanvasElement, region: Region, longSidePx: number): Promise<Blob> {
  const cropped = cropExpanded(canvas, region, longSidePx, 0.25, 0.35);
  return canvasToBlob(cropped, "image/jpeg", 0.9);
}
