/**
 * 红笔笔迹 → 字形（glyph）预处理。
 *
 * 流程：红像素二值化 → 8 邻域连通域 → 合并同一数字的多个笔画/断点 → 每个字形按
 * 紧包围盒等比缩放到 28x28（长边 20、居中），该结果直接喂给 MLP。
 *
 * 注意：归一化必须与 _build/train_digits.py 的 normalize_mask 一致。
 */
import { isRedPixel } from "../imaging/red";
import { resizeGray } from "./resize";

export interface RawComponent {
  /** 包围盒（画布像素坐标） */
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

export interface Glyph extends RawComponent {
  /** 组成这个字形的连通域下标 */
  components: number[];
}

export interface MaskBundle {
  mask: Uint8Array;
  width: number;
  height: number;
  /** 每个像素所属连通域下标，-1 = 背景 */
  labels: Int32Array;
  components: RawComponent[];
}

export interface SegmentOptions {
  /** 单个连通域最小面积（像素），更小的视为噪点 */
  minComponentArea?: number;
  /** 合并断裂笔画时允许的最大间隙（像素），会再和字高中位数比较 */
  maxMergeGap?: number;
}

export const INNER_BOX = 20;
export const INPUT_SIZE = 28;

/** 红像素二值化。data 为 RGBA 顺序的字节数组。 */
export function binarizeRed(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    if (isRedPixel(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
  }
  return mask;
}

/** 8 邻域连通域标记。 */
export function labelComponents(mask: Uint8Array, width: number, height: number, minArea = 3): MaskBundle {
  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const visited = new Int32Array(width * height);
  const components: RawComponent[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const label = components.length;
    let sp = 0;
    let visitedCount = 0;
    stack[sp++] = start;
    labels[start] = label;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      visited[visitedCount++] = idx;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] && labels[n] < 0) {
            labels[n] = label;
            stack[sp++] = n;
          }
        }
      }
    }
    const area = visitedCount;
    if (area < minArea) {
      // 还原成背景，避免小噪点混进合并逻辑
      for (let k = 0; k < visitedCount; k++) labels[visited[k]] = -1;
      continue;
    }
    components.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return { mask, width, height, labels, components };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 把连通域合并成「字形」：数字/负号经常被二值化切成几段，而相邻两个数字在空间上
 * 有明确间隔。合并条件都要求间隙很小且投影有足够重叠，尽量避免把两个数字粘在一起。
 */
export function mergeStrokesIntoGlyphs(
  bundle: MaskBundle,
  options?: SegmentOptions,
): Glyph[] {
  const minGap = options?.maxMergeGap ?? 2;
  const comps = bundle.components;
  const n = comps.length;
  if (n === 0) return [];
  const medH = median(comps.map((c) => c.h));
  const gapTol = Math.max(1.25, Math.min(minGap, 0.05 * Math.max(medH, 1)));

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    const a = comps[i];
    for (let j = i + 1; j < n; j++) {
      const b = comps[j];
      const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
      const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
      if (gapX > gapTol + 2 && gapY > gapTol + 2) continue;
      const ovX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const ovY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const minW = Math.min(a.w, b.w);
      const minH = Math.min(a.h, b.h);
      const touchTol = 1.25;
      if (gapX <= touchTol && gapY <= touchTol) {
        union(i, j);
        continue;
      }
      // 同一笔画的断裂：水平方向间隙很小，且纵向有较大重叠
      if (gapX <= gapTol && ovY >= 0.6 * minH) {
        union(i, j);
        continue;
      }
      // 纵向断裂（例如 '1' 的上下两段）
      if (gapY <= gapTol && ovX >= 0.6 * minW) {
        union(i, j);
        continue;
      }
      // 很小的碎片紧贴大笔画（笔尖点、收笔的飞白）
      const small = Math.min(a.area, b.area);
      const big = Math.max(a.area, b.area);
      if (small <= 0.12 * big && gapX <= 2 && gapY <= 2) union(i, j);
    }
  }

  const groups = new Map<number, Glyph>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const c = comps[i];
    const g = groups.get(root);
    if (!g) {
      groups.set(root, {
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        area: c.area,
        components: [i],
      });
    } else {
      const x1 = Math.min(g.x, c.x);
      const y1 = Math.min(g.y, c.y);
      const x2 = Math.max(g.x + g.w, c.x + c.w);
      const y2 = Math.max(g.y + g.h, c.y + c.h);
      g.x = x1;
      g.y = y1;
      g.w = x2 - x1;
      g.h = y2 - y1;
      g.area += c.area;
      g.components.push(i);
    }
  }
  return [...groups.values()].sort((a, b) => a.x - b.x);
}

/** 取出字形包围盒内的二值 mask（0/1）。 */
export function extractGlyphMask(bundle: MaskBundle, glyph: Glyph): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const { labels, width: W } = bundle;
  const inGroup = new Uint8Array(bundle.components.length);
  for (const c of glyph.components) inGroup[c] = 1;
  const data = new Uint8Array(glyph.w * glyph.h);
  for (let y = 0; y < glyph.h; y++) {
    const srcBase = (glyph.y + y) * W + glyph.x;
    for (let x = 0; x < glyph.w; x++) {
      const label = labels[srcBase + x];
      if (label >= 0 && inGroup[label]) data[y * glyph.w + x] = 1;
    }
  }
  return { data, width: glyph.w, height: glyph.h };
}

/**
 * 字形 mask → 28x28 浮点输入。长边等比缩放到 20px、居中放置。
 * 与训练脚本 normalize_mask 完全一致（不传 rng 时不做随机平移）。
 */
export function normalizeGlyph(
  data: Uint8Array,
  width: number,
  height: number,
  outSize = INPUT_SIZE,
  innerBox = INNER_BOX,
): Float32Array {
  const out = new Float32Array(outSize * outSize);
  if (width <= 0 || height <= 0) return out;
  const scale = innerBox / Math.max(width, height);
  const rw = Math.max(1, Math.round(width * scale));
  const rh = Math.max(1, Math.round(height * scale));
  const src = new Float32Array(width * height);
  for (let i = 0; i < src.length; i++) src[i] = data[i];
  const resized = resizeGray(src, width, height, rw, rh);
  const ox = Math.floor((outSize - rw) / 2);
  const oy = Math.floor((outSize - rh) / 2);
  for (let y = 0; y < rh; y++) {
    const dstBase = (oy + y) * outSize + ox;
    const srcBase = y * rw;
    for (let x = 0; x < rw; x++) out[dstBase + x] = resized[srcBase + x];
  }
  return out;
}

export interface SegmentedGlyph {
  glyph: Glyph;
  /** 28x28 归一化输入 */
  input: Float32Array;
}

/** 从 RGBA 图像数据一次性完成 二值化 → 连通域 → 合并 → 归一化。 */
export function segmentRedGlyphs(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options?: SegmentOptions,
): { mask: Uint8Array; glyphs: SegmentedGlyph[]; bundle: MaskBundle } {
  const mask = binarizeRed(data, width, height);
  const bundle = labelComponents(mask, width, height, options?.minComponentArea ?? 3);
  const glyphs = mergeStrokesIntoGlyphs(bundle, options);
  const out: SegmentedGlyph[] = [];
  for (const glyph of glyphs) {
    const extracted = extractGlyphMask(bundle, glyph);
    out.push({ glyph, input: normalizeGlyph(extracted.data, extracted.width, extracted.height) });
  }
  return { mask, glyphs: out, bundle };
}
