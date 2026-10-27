export interface RedComponent {
  /** 原图像素坐标 */
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  /** 归一化长边坐标（以答题卡长边为 1） */
  inkBox?: { x: number; y: number; w: number; h: number };
}

export interface RedExtraction {
  mask: Uint8Array;
  width: number;
  height: number;
  components: RedComponent[];
  pixels: number;
}

/** 是否像红笔：色相接近红、饱和度足够、亮度不太暗。 */
export function isRedPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0 || max < 40) return false;
  const sat = delta / max;
  if (sat < 0.38) return false;
  let hue: number;
  if (max === r) hue = (60 * ((g - b) / delta) + 360) % 360;
  else if (max === g) hue = 60 * ((b - r) / delta) + 120;
  else hue = 60 * ((r - g) / delta) + 240;
  return hue <= 22 || hue >= 338;
}

/**
 * 提取红色笔迹。为避免在大图上做连通域，先在长边 ≤ 900 的降采样图上做，
 * 再把包围盒映射回原图坐标。
 */
export function extractRedInk(canvas: HTMLCanvasElement, options?: { downscaleTo?: number; minArea?: number }): RedExtraction {
  const downscaleTo = options?.downscaleTo ?? 900;
  const minArea = options?.minArea ?? 10;

  const scale = Math.min(1, downscaleTo / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, w, h);
  const data = sctx.getImageData(0, 0, w, h).data;

  const mask = new Uint8Array(w * h);
  let pixels = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (isRedPixel(data[i], data[i + 1], data[i + 2])) {
      mask[p] = 1;
      pixels++;
    }
  }

  // 连通域（8 邻域）
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const components: RedComponent[] = [];
  const invScale = 1 / scale;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      area++;
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
      }
    }
    if (area < minArea) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // 太细长/太扁平的噪点过滤掉
    if (bw < 2 && bh < 2) continue;
    components.push({
      x: minX * invScale,
      y: minY * invScale,
      w: bw * invScale,
      h: bh * invScale,
      area: area * invScale * invScale,
    });
  }

  components.sort((a, b) => b.area - a.area);
  return { mask, width: w, height: h, components, pixels };
}

/** 生成「只保留红色笔迹」的预览画布（白底红字），用于核对与调试。 */
export function renderRedOnly(canvas: HTMLCanvasElement, downscaleTo = 900): HTMLCanvasElement {
  const scale = Math.min(1, downscaleTo / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, w, h);
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (isRedPixel(d[i], d[i + 1], d[i + 2])) {
      // 保留原始红色，稍微增强对比
      const boost = 0.86;
      d[i] = Math.min(255, d[i] * (1 / boost));
      d[i + 1] = d[i + 1] * boost;
      d[i + 2] = d[i + 2] * boost;
    } else {
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.putImageData(img, 0, 0);
  return out;
}

/** 把红色笔迹连通域按区域归组（用于判断某题附近有没有红笔、是否有多个分数）。 */
export function componentsInRect(
  components: RedComponent[],
  rect: { x: number; y: number; w: number; h: number },
): RedComponent[] {
  return components.filter((c) => {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  });
}
