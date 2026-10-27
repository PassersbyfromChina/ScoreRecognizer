import type { Point } from "../types";
import { applyHomography, solveHomography } from "./geometry";

export async function loadImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

export function bitmapSize(bitmap: ImageBitmap): { width: number; height: number } {
  return { width: bitmap.width, height: bitmap.height };
}

/** 把任意图像源画到 canvas（可限制最长边）。 */
export function drawToCanvas(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxLongSide?: number,
): HTMLCanvasElement {
  let w = srcW;
  let h = srcH;
  if (maxLongSide && Math.max(w, h) > maxLongSide) {
    const scale = maxLongSide / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

/** 透视矫正：把源图里的四边形映射到目标矩形。 */
export function warpPerspective(
  source: CanvasImageSource,
  srcCorners: [Point, Point, Point, Point],
  targetW: number,
  targetH: number,
): HTMLCanvasElement {
  const srcCanvas = drawToCanvas(
    source,
    (source as HTMLImageElement).naturalWidth || (source as HTMLCanvasElement).width || 0,
    (source as HTMLImageElement).naturalHeight || (source as HTMLCanvasElement).height || 0,
  );
  return warpCanvasToRect(srcCanvas, srcCorners, targetW, targetH);
}

export function warpCanvasToRect(
  srcCanvas: HTMLCanvasElement,
  srcCorners: [Point, Point, Point, Point],
  targetW: number,
  targetH: number,
): HTMLCanvasElement {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true })!;
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;

  const dstCorners: Point[] = [
    { x: 0, y: 0 },
    { x: targetW, y: 0 },
    { x: targetW, y: targetH },
    { x: 0, y: targetH },
  ];
  // 目标 -> 源 的映射（反向采样）
  const H = solveHomography(dstCorners, srcCorners);

  const out = document.createElement("canvas");
  out.width = targetW;
  out.height = targetH;
  const outCtx = out.getContext("2d")!;
  const outImage = outCtx.createImageData(targetW, targetH);
  const dst = outImage.data;

  // 反向采样（双线性），x 方向用增量计算减少乘法；这是处理一张卡里最耗时的像素循环
  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7], h8 = H[8];
  let di = 0;
  for (let y = 0; y < targetH; y++) {
    let nx = h1 * y + h2;
    let ny = h4 * y + h5;
    let den = h7 * y + h8;
    for (let x = 0; x < targetW; x++) {
      const sx = nx / den;
      const sy = ny / den;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        dst[di] = 244;
        dst[di + 1] = 245;
        dst[di + 2] = 248;
        dst[di + 3] = 255;
      } else {
        const x0 = sx | 0;
        const y0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + sw * 4;
        const i11 = i01 + 4;
        const r00 = srcData[i00], r10 = srcData[i10], r01 = srcData[i01], r11 = srcData[i11];
        const rt = r00 + (r10 - r00) * fx;
        const rb = r01 + (r11 - r01) * fx;
        dst[di] = rt + (rb - rt) * fy;

        const g00 = srcData[i00 + 1], g10 = srcData[i10 + 1], g01 = srcData[i01 + 1], g11 = srcData[i11 + 1];
        const gt = g00 + (g10 - g00) * fx;
        const gb = g01 + (g11 - g01) * fx;
        dst[di + 1] = gt + (gb - gt) * fy;

        const b00 = srcData[i00 + 2], b10 = srcData[i10 + 2], b01 = srcData[i01 + 2], b11 = srcData[i11 + 2];
        const bt = b00 + (b10 - b00) * fx;
        const bb = b01 + (b11 - b01) * fx;
        dst[di + 2] = bt + (bb - bt) * fy;

        dst[di + 3] = 255;
      }
      nx += h0;
      ny += h3;
      den += h6;
      di += 4;
    }
  }
  outCtx.putImageData(outImage, 0, 0);
  return out;
}

export function cropCanvas(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
): HTMLCanvasElement {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.min(canvas.width - x, Math.round(rect.w)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.round(rect.h)));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))), type, quality);
  });
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.82): string {
  return canvas.toDataURL(type, quality);
}

export function canvasFromDataUrl(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}
