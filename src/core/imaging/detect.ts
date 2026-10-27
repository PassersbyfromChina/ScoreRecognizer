import type { DetectionResult, Point } from "../types";
import { orderCorners, polygonArea } from "./geometry";

export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 每个像素的「白纸程度」0~255（min/max 通道比），可选；用于阴影下仍能区分纸张 */
  whiteness?: Uint8ClampedArray;
}

export interface QuadEstimate {
  corners: [Point, Point, Point, Point];
  confidence: number;
  fillRatio: number;
  brightRatio: number;
}

function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/** 用积分图计算局部平均亮度（半径 r 的方窗），用来抵消光照不均/阴影。 */
function localMean(gray: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const stride = width + 1;
  const prefix = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      prefix[(y + 1) * stride + (x + 1)] = prefix[y * stride + (x + 1)] + rowSum;
    }
  }
  const mean = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        prefix[(y1 + 1) * stride + (x1 + 1)] -
        prefix[y0 * stride + (x1 + 1)] -
        prefix[(y1 + 1) * stride + x0] +
        prefix[y0 * stride + x0];
      mean[y * width + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return mean;
}

/** 找最大连通域（4 邻域 + 对角也连，纸张边缘可能被细线隔开）。 */
function largestComponent(mask: Uint8Array, width: number, height: number): { pixels: Int32Array; area: number } | null {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const minArea = width * height * 0.05;
  let best: number[] = [];
  let bestArea = 0;

  for (let start = 0; start < mask.length; start++) {
    if (visited[start] || !mask[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let area = 0;
    const pixels: number[] = [];
    while (sp > 0) {
      const idx = stack[--sp];
      pixels.push(idx);
      area++;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x > 0) check(idx - 1);
      if (x < width - 1) check(idx + 1);
      if (y > 0) check(idx - width);
      if (y < height - 1) check(idx + width);
      if (x > 0 && y > 0) check(idx - width - 1);
      if (x < width - 1 && y > 0) check(idx - width + 1);
      if (x > 0 && y < height - 1) check(idx + width - 1);
      if (x < width - 1 && y < height - 1) check(idx + width + 1);
    }
    if (area > bestArea) {
      bestArea = area;
      best = pixels;
    }
    if (bestArea > width * height * 0.85) break;

    function check(n: number) {
      if (!visited[n] && mask[n]) {
        visited[n] = 1;
        stack[sp++] = n;
      }
    }
  }

  if (bestArea < minArea) return null;
  return { pixels: Int32Array.from(best), area: bestArea };
}

/** 用四条对角线方向的极值点估计纸张四角（对透视形变更稳）。 */
function diagonalCorners(pixels: Int32Array, width: number): [Point, Point, Point, Point] {
  let tl = Infinity;
  let tr = -Infinity;
  let br = Infinity;
  let bl = -Infinity;
  let tlPt: Point = { x: 0, y: 0 };
  let trPt: Point = { x: 0, y: 0 };
  let brPt: Point = { x: 0, y: 0 };
  let blPt: Point = { x: 0, y: 0 };
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i];
    const x = idx % width;
    const y = (idx / width) | 0;
    const s1 = x + y;
    const s2 = x - y;
    const s3 = -x - y;
    const s4 = -x + y;
    if (s1 < tl) {
      tl = s1;
      tlPt = { x, y };
    }
    if (s2 > tr) {
      tr = s2;
      trPt = { x, y };
    }
    if (s3 < br) {
      br = s3;
      brPt = { x, y };
    }
    if (s4 > bl) {
      bl = s4;
      blPt = { x, y };
    }
  }
  return orderCorners([tlPt, trPt, brPt, blPt]);
}

function validQuad(corners: [Point, Point, Point, Point], width: number, height: number, area: number): boolean {
  const minSide = Math.min(width, height) * 0.15;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    if (Math.hypot(a.x - b.x, a.y - b.y) < minSide) return false;
  }
  if (area < width * height * 0.04) return false;
  // 四个角都要接近直角（60°~120°），排除细条/奇怪形状
  for (let i = 0; i < 4; i++) {
    const p = corners[(i + 3) % 4];
    const c = corners[i];
    const n = corners[(i + 1) % 4];
    const v1x = p.x - c.x;
    const v1y = p.y - c.y;
    const v2x = n.x - c.x;
    const v2y = n.y - c.y;
    const len = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (len === 0) return false;
    const cos = (v1x * v2x + v1y * v2y) / len;
    if (cos > 0.5 || cos < -0.5) return false;
  }
  // 长宽比大致像试卷（A4 竖版 0.71），允许一定透视误差
  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const wSide = (side(corners[0], corners[1]) + side(corners[2], corners[3])) / 2;
  const hSide = (side(corners[1], corners[2]) + side(corners[3], corners[0])) / 2;
  const ratio = wSide / Math.max(1, hSide);
  if (ratio < 0.38 || ratio > 1.6) return false;
  return true;
}

function quadAspect(corners: [Point, Point, Point, Point]): number {
  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const wSide = (side(corners[0], corners[1]) + side(corners[2], corners[3])) / 2;
  const hSide = (side(corners[1], corners[2]) + side(corners[3], corners[0])) / 2;
  return wSide / Math.max(1, hSide);
}

/** 沿四条边采样纸张内外的亮度差，用来判断这个四边形是不是真实的纸边。 */
function edgeSupport(img: GrayImage, corners: [Point, Point, Point, Point]): number {
  const { data, width, height } = img;
  const sample = (x: number, y: number): number => {
    const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
    return data[yi * width + xi];
  };
  const offset = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  let cx = 0;
  let cy = 0;
  for (const p of corners) {
    cx += p.x / 4;
    cy += p.y / 4;
  }
  let total = 0;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;
    // 法线指向纸外
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let t = 0.12; t <= 0.88; t += 0.125) {
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const inside = sample(px - nx * offset, py - ny * offset);
      const outside = sample(px + nx * offset, py + ny * offset);
      total += Math.abs(inside - outside);
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

/** 按指定亮度阈值分割，返回最大的纸张候选四边形。 */
function estimateAtThreshold(img: GrayImage, threshold: number): QuadEstimate | null {
  const { data, width, height } = img;
  const total = width * height;
  const mask = new Uint8Array(total);
  let bright = 0;
  for (let i = 0; i < total; i++) {
    if (data[i] > threshold) {
      mask[i] = 1;
      bright++;
    }
  }
  return quadFromMask(img, mask, bright);
}

/** 按「白纸程度」（颜色中性程度）分割：光照强弱会缩放 RGB，但通道比例基本不变。 */
function estimateAtWhiteness(img: GrayImage, minWhiteness: number): QuadEstimate | null {
  const { data, whiteness, width } = img;
  if (!whiteness) return null;
  const total = width * img.height;
  const mask = new Uint8Array(total);
  let bright = 0;
  for (let i = 0; i < total; i++) {
    if (data[i] > 95 && whiteness[i] >= minWhiteness) {
      mask[i] = 1;
      bright++;
    }
  }
  return quadFromMask(img, mask, bright);
}

function quadFromMask(img: GrayImage, mask: Uint8Array, bright: number): QuadEstimate | null {
  const { width, height } = img;
  const total = width * height;
  const brightRatio = bright / total;
  if (brightRatio < 0.12 || brightRatio > 0.985) return null;

  const component = largestComponent(mask, width, height);
  if (!component) return null;

  const quad = diagonalCorners(component.pixels, width);
  const area = polygonArea(quad);
  if (!validQuad(quad, width, height, area)) return null;
  const fill = component.area / Math.max(1, area);
  if (fill < 0.5) return null;

  const confidence = Math.max(0, Math.min(1, fill * 0.7 + Math.min(brightRatio, 1) * 0.1 + 0.2));
  return { corners: quad, confidence, fillRatio: fill, brightRatio };
}

/**
 * 从灰度图估计答题卡四角；找不到像样的纸张区域时返回 null。
 * 会尝试多个亮度阈值，并验证四条边确实存在明显亮度差，避免阴影/桌面纹理把边界带偏。
 * 纯函数，便于单元测试；不依赖 DOM/Canvas。
 */
export function estimateCardQuad(img: GrayImage): QuadEstimate | null {
  const otsu = otsuThreshold(img.data);
  const base = Math.max(otsu, 100);

  // 快速路径：干净背景/正常光照下，一两次分割就足够；避免手机上每次都跑十几遍
  const scored: Array<{ estimate: QuadEstimate; score: number }> = [];
  const evaluate = (estimate: QuadEstimate | null): number => {
    if (!estimate) return -1;
    const support = edgeSupport(img, estimate.corners);
    const aspect = quadAspect(estimate.corners);
    const aspectPenalty = Math.abs(Math.log(aspect / 0.71)) * 8;
    const score = support + estimate.confidence * 6 - aspectPenalty;
    scored.push({ estimate, score });
    return score;
  };

  const baseEstimate = estimateAtThreshold(img, base);
  const baseScore = evaluate(baseEstimate);
  const baseBrightRatio = baseEstimate?.brightRatio ?? 0;
  if (baseBrightRatio > 0.985) return null;
  if (baseEstimate && baseScore >= 18 && baseEstimate.confidence >= 0.7) {
    return finalizeEstimate(baseEstimate, baseScore);
  }
  const baseFullFrameGuess = baseEstimate ? polygonArea(baseEstimate.corners) >= img.width * img.height * 0.985 : false;
  if (baseFullFrameGuess) return null;

  const candidates = [Math.max(70, base - 15), Math.min(235, base + 15), 130, 160, 190, 215];
  const seen = new Set<number>([Math.round(base)]);
  for (const raw of candidates) {
    const threshold = Math.round(raw);
    if (seen.has(threshold)) continue;
    seen.add(threshold);
    evaluate(estimateAtThreshold(img, threshold));
  }
  if (img.whiteness) {
    // 阴影很重时，亮度阈值不可靠，用「颜色中性程度」再找一轮
    for (const minWhiteness of [228, 238, 245, 250]) {
      evaluate(estimateAtWhiteness(img, minWhiteness));
    }
  }

  let best = scored[0] ?? null;
  for (const item of scored) {
    if (!best || item.score > best.score) best = item;
  }
  // 边缘对比太弱（阴影太重/没拍到纸边）时宁可交给人工，也不硬猜
  if (!best || best.score < 6) return null;
  return finalizeEstimate(best.estimate, best.score);
}

function finalizeEstimate(estimate: QuadEstimate, score: number): QuadEstimate {
  const confidence = Math.min(1, estimate.confidence * 0.6 + Math.min(1, score / 40) * 0.4);
  return { ...estimate, confidence };
}

/** 用降采样画布上的局部亮度区域估计答题卡四角。maxSide 越小越快，手机端用较小值。 */
export function detectCardCorners(
  source: HTMLCanvasElement,
  originalSize: { width: number; height: number },
  maxSide = 720,
): DetectionResult {
  const scaleDown = Math.min(1, maxSide / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scaleDown));
  const h = Math.max(1, Math.round(source.height * scaleDown));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  small.getContext("2d")!.drawImage(source, 0, 0, w, h);

  const ctx = small.getContext("2d", { willReadFrequently: true })!;
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  const whiteness = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    gray[p] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    whiteness[p] = maxC > 0 ? Math.round((minC / maxC) * 255) : 0;
  }

  const fallback = (): DetectionResult => {
    const inset = 0.02;
    const origCorners: [Point, Point, Point, Point] = [
      { x: originalSize.width * inset, y: originalSize.height * inset },
      { x: originalSize.width * (1 - inset), y: originalSize.height * inset },
      { x: originalSize.width * (1 - inset), y: originalSize.height * (1 - inset) },
      { x: originalSize.width * inset, y: originalSize.height * (1 - inset) },
    ];
    return { corners: origCorners, confidence: 0, method: "fallback" };
  };

  // 图片四周边缘本身就是亮纸色（扫描件/已经裁好的图）：直接按画面范围处理，不算识别失败
  const otsu = otsuThreshold(gray);
  const baseThreshold = Math.max(otsu, 100);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  let borderCount = 0;
  let borderBright = 0;
  const checkBorderPixel = (x: number, y: number) => {
    borderCount++;
    if (gray[y * w + x] > baseThreshold) borderBright++;
  };
  for (let x = 0; x < w; x++) {
    for (let d = 0; d < band; d++) {
      checkBorderPixel(x, d);
      checkBorderPixel(x, h - 1 - d);
    }
  }
  for (let y = band; y < h - band; y++) {
    for (let d = 0; d < band; d++) {
      checkBorderPixel(d, y);
      checkBorderPixel(w - 1 - d, y);
    }
  }
  if (borderCount > 0 && borderBright / borderCount > 0.9) {
    return { corners: frameCorners(originalSize.width, originalSize.height), confidence: 0, method: "frame" };
  }

  const estimate = estimateCardQuad({ data: gray, width: w, height: h, whiteness });
  if (!estimate) return fallback();

  const sx = originalSize.width / w;
  const sy = originalSize.height / h;
  const corners: [Point, Point, Point, Point] = estimate.corners.map((p) => ({
    x: Math.min(originalSize.width, Math.max(0, p.x * sx)),
    y: Math.min(originalSize.height, Math.max(0, p.y * sy)),
  })) as [Point, Point, Point, Point];

  const area = polygonArea(corners);
  const marginOk = area < originalSize.width * originalSize.height * 0.995;
  return {
    corners,
    confidence: marginOk ? estimate.confidence : 0,
    method: marginOk ? "paper-edge" : "fallback",
  };
}

/** 默认四角：向内收 2% 的画面框。 */
export function frameCorners(width: number, height: number, inset = 0.02): [Point, Point, Point, Point] {
  return [
    { x: width * inset, y: height * inset },
    { x: width * (1 - inset), y: height * inset },
    { x: width * (1 - inset), y: height * (1 - inset) },
    { x: width * inset, y: height * (1 - inset) },
  ];
}
