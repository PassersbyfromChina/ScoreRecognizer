import type { DetectionResult, Point, Rect, Region } from "../types";
import { canvasToBlob, cropCanvas, drawToCanvas, loadImageBitmap, warpCanvasToRect } from "./canvas";
import { detectCardCorners } from "./detect";
import { extractRedInk, type RedComponent } from "./red";
import { isNativeMobile } from "../platform";

/** A4 绔栫増锛氬/楂?*/
export const DEFAULT_ASPECT = 210 / 297;
export const DEFAULT_LONG_SIDE = 1600;
const MAX_SOURCE_LONG_SIDE = 2600;
const MOBILE_LONG_SIDE = 1400;
const MOBILE_MAX_SOURCE_LONG_SIDE = 2200;
const MOBILE_DETECT_SIDE = 600;

/** 鎵嬫満绔敤鐣ヤ綆鐨勫垎杈ㄧ巼澶勭悊锛岄€熷害鏇村揩锛涘潗鏍囨槸褰掍竴鍖栫殑锛屾ā鏉垮湪涓ょ閫氱敤銆?*/
export function processingLongSide(): number {
  return isNativeMobile() ? MOBILE_LONG_SIDE : DEFAULT_LONG_SIDE;
}

function maxSourceLongSide(): number {
  return isNativeMobile() ? MOBILE_MAX_SOURCE_LONG_SIDE : MAX_SOURCE_LONG_SIDE;
}

function detectLongSide(): number {
  return isNativeMobile() ? MOBILE_DETECT_SIDE : 720;
}

export interface LoadedCard {
  canvas: HTMLCanvasElement;
  corners: [Point, Point, Point, Point];
  detection: DetectionResult | null;
  width: number;
  height: number;
}

export interface CorrectedCard {
  canvas: HTMLCanvasElement;
  /** 鏍囧噯鍗￠暱杈瑰儚绱?*/
  longSide: number;
  /** 瀹?楂?*/
  aspect: number;
  corners: [Point, Point, Point, Point];
  confidence: number;
  method: string;
}

/** 璇诲叆鍥剧墖骞跺湪鍘熷浘涓婃娴嬬瓟棰樺崱鍥涜锛堜笉鐭锛夈€?*/
export async function loadCard(blob: Blob): Promise<LoadedCard> {
  const bitmap = await loadImageBitmap(blob);
  const src = drawToCanvas(bitmap, bitmap.width, bitmap.height, maxSourceLongSide());
  const detection = detectCardCorners(src, { width: src.width, height: src.height }, detectLongSide());
  return {
    canvas: src,
    corners: detection.corners,
    detection,
    width: src.width,
    height: src.height,
  };
}

/** 鐢ㄥ洓瑙掓妸鍥剧墖鐭鎴愭爣鍑嗙瓟棰樺崱銆?*/
export function correctCard(
  source: HTMLCanvasElement,
  corners: [Point, Point, Point, Point],
  aspect = DEFAULT_ASPECT,
  longSide = processingLongSide(),
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
  const longSide = opts?.longSide ?? processingLongSide();
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

/** 鎶娿€岄暱杈?1銆嶅潗鏍囩殑鍖哄煙鎹㈢畻鎴愮煫姝ｅ浘鍍忕礌銆?*/
export function regionToPixels(region: Rect, longSidePx: number): { x: number; y: number; w: number; h: number } {
  return {
    x: region.x * longSidePx,
    y: region.y * longSidePx,
    w: region.w * longSidePx,
    h: region.h * longSidePx,
  };
}

/** 瑁佸壀鍖哄煙骞跺悜澶栨墿涓€鍦堬紙绾㈢瑪鍒嗘暟甯稿啓鍦ㄩ鐩尯鍩熷锛夈€?*/
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
  /** 姣忎釜棰樼洰鍖哄煙鍐咃紙鍚竴鐐瑰杈硅窛锛夌殑绾㈢瑪缁勪欢鏁伴噺 */
  perQuestion: Map<number, RedComponent[]>;
  /** 濮撳悕鍖哄煙闄勮繎鏄惁鏈夐粦鑹茬瑪杩癸紙绠€鍗曠敤鏆楀儚绱犳瘮渚嬪垽鏂紝鍚庣画鍙粏鍖栵級 */
  nameInk: boolean;
}

/** 鏈湴鍒嗘瀽锛氭壘鍑虹孩绗旂粍浠讹紝骞舵寜棰樼洰鍖哄煙鍒嗙粍銆?*/
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

/** 鍒ゆ柇涓€涓儚绱犲尯鍩熷唴鏄惁鏈夎冻澶熷鐨勬繁鑹插儚绱狅紙鎵嬪啓榛戣壊濮撳悕锛夈€?*/
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

/** 瑁佸壀濮撳悕鍖哄煙锛堟斁澶т竴鐐癸紝瀹介珮鍚勭暀 20% 杈硅窛锛夈€?*/
export async function cropNameRegion(canvas: HTMLCanvasElement, region: Region, longSidePx: number): Promise<Blob> {
  const cropped = cropExpanded(canvas, region, longSidePx, 0.25, 0.35);
  return canvasToBlob(cropped, "image/jpeg", 0.9);
}

