import type { DetectionResult, Point } from "../types";
import { orderCorners, polygonArea } from "./geometry";

interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
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

function toGray(canvas: HTMLCanvasElement): GrayImage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return { data: gray, width, height };
}

/** 取最大亮连通域，返回其像素坐标列表（降采样后）。 */
function largestBrightComponent(img: GrayImage, threshold: number) {
  const { data, width, height } = img;
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let best: number[] = [];
  let bestArea = 0;
  const minArea = width * height * 0.05;

  for (let start = 0; start < data.length; start++) {
    if (visited[start] || data[start] <= threshold) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const pixels: number[] = [];
    while (sp > 0) {
      const idx = stack[--sp];
      pixels.push(idx);
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
    if (pixels.length > bestArea) {
      bestArea = pixels.length;
      best = pixels;
    }
    if (bestArea > width * height * 0.85) break;

    function check(n: number) {
      if (!visited[n] && data[n] > threshold) {
        visited[n] = 1;
        stack[sp++] = n;
      }
    }
  }

  if (bestArea < minArea) return null;
  return { pixels: best, area: bestArea };
}

function pcaCorners(
  pixels: number[],
  width: number,
  height: number,
): { corners: [Point, Point, Point, Point]; area: number } {
  let cx = 0;
  let cy = 0;
  for (const idx of pixels) {
    cx += idx % width;
    cy += (idx / width) | 0;
  }
  cx /= pixels.length;
  cy /= pixels.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const idx of pixels) {
    const x = (idx % width) - cx;
    const y = ((idx / width) | 0) - cy;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  sxx /= pixels.length;
  syy /= pixels.length;
  sxy /= pixels.length;

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const vx = -uy;
  const vy = ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const idx of pixels) {
    const x = (idx % width) - cx;
    const y = ((idx / width) | 0) - cy;
    const u = x * ux + y * uy;
    const v = x * vx + y * vy;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const corner = (u: number, v: number): Point => ({
    x: cx + u * ux + v * vx,
    y: cy + u * uy + v * vy,
  });

  const corners: [Point, Point, Point, Point] = [
    corner(minU, minV),
    corner(maxU, minV),
    corner(maxU, maxV),
    corner(minU, maxV),
  ];
  const area = (maxU - minU) * (maxV - minV);
  return { corners, area };
}

/** 用降采样画布上的亮度区域估计答题卡四角。 */
export function detectCardCorners(source: HTMLCanvasElement, originalSize: { width: number; height: number }): DetectionResult {
  const scaleDown = Math.min(1, 720 / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scaleDown));
  const h = Math.max(1, Math.round(source.height * scaleDown));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  small.getContext("2d")!.drawImage(source, 0, 0, w, h);

  const gray = toGray(small);
  const threshold = otsuThreshold(gray.data);
  let brightCount = 0;
  for (let i = 0; i < gray.data.length; i++) if (gray.data[i] > threshold) brightCount++;
  const brightRatio = brightCount / gray.data.length;

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

  if (brightRatio < 0.12 || brightRatio > 0.985) return fallback();

  const component = largestBrightComponent(gray, threshold);
  if (!component) return fallback();

  const { corners: pca } = pcaCorners(component.pixels, w, h);
  const localCorners = orderCorners(pca);
  const area = polygonArea(localCorners);
  const fill = component.area / Math.max(1, area);
  if (fill < 0.45) return fallback();

  const sx = originalSize.width / w;
  const sy = originalSize.height / h;
  const corners: [Point, Point, Point, Point] = localCorners.map((p) => ({
    x: Math.min(originalSize.width, Math.max(0, p.x * sx)),
    y: Math.min(originalSize.height, Math.max(0, p.y * sy)),
  })) as [Point, Point, Point, Point];

  const rectArea = area * sx * sy;
  const frameArea = originalSize.width * originalSize.height;
  const marginOk = rectArea < frameArea * 0.995;

  const confidence = Math.max(0, Math.min(1, fill * 0.75 + (marginOk ? 0.2 : 0) + Math.min(brightRatio, 1) * 0.05));
  return { corners, confidence, method: marginOk ? "paper-edge" : "fallback" };
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
