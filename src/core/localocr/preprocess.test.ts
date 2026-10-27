import { describe, expect, it } from "vitest";
import {
  binarizeRed,
  labelComponents,
  mergeStrokesIntoGlyphs,
  normalizeGlyph,
  segmentRedGlyphs,
} from "./preprocess";

function makeImageData(
  width: number,
  height: number,
  rects: Array<{ x: number; y: number; w: number; h: number; color?: [number, number, number] }>,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (const r of rects) {
    const color = r.color ?? [210, 30, 45];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = 255;
      }
    }
  }
  return data;
}

function bboxOf(input: Float32Array, size = 28): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = size;
  let x1 = -1;
  let y0 = size;
  let y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (input[y * size + x] > 0.001) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, x1, y0, y1 };
}

describe("binarizeRed", () => {
  it("只把红色笔迹标记为 1", () => {
    const data = makeImageData(6, 2, [
      { x: 0, y: 0, w: 2, h: 2 }, // 红
      { x: 2, y: 0, w: 2, h: 2, color: [20, 20, 20] }, // 黑
      { x: 4, y: 0, w: 2, h: 2, color: [255, 255, 255] }, // 白
    ]);
    const mask = binarizeRed(data, 6, 2);
    expect(mask.length).toBe(12);
    expect(mask[0]).toBe(1);
    expect(mask[1]).toBe(1);
    expect(mask[6]).toBe(1);
    // 黑色 / 白色都不算红笔
    expect(mask[2]).toBe(0);
    expect(mask[4]).toBe(0);
  });
});

describe("labelComponents + mergeStrokesIntoGlyphs", () => {
  it("距离近的断裂笔画合并成一个字形", () => {
    // 一个 '1' 被二值化成上下两段（间隔 1px）
    const data = makeImageData(40, 40, [
      { x: 10, y: 5, w: 6, h: 14 },
      { x: 10, y: 20, w: 6, h: 14 },
    ]);
    const mask = binarizeRed(data, 40, 40);
    const bundle = labelComponents(mask, 40, 40);
    expect(bundle.components.length).toBe(2);
    const glyphs = mergeStrokesIntoGlyphs(bundle);
    expect(glyphs.length).toBe(1);
    expect(glyphs[0].w).toBe(6);
    expect(glyphs[0].h).toBe(29);
  });

  it("两个数字之间的空隙不会被误合并", () => {
    // '1' 与 '0'，间隔 6px
    const data = makeImageData(80, 40, [
      { x: 5, y: 5, w: 8, h: 30 },
      { x: 19, y: 5, w: 14, h: 30 },
    ]);
    const mask = binarizeRed(data, 80, 40);
    const bundle = labelComponents(mask, 80, 40);
    const glyphs = mergeStrokesIntoGlyphs(bundle);
    expect(glyphs.length).toBe(2);
    expect(glyphs[0].x).toBeLessThan(glyphs[1].x);
  });

  it("负号（宽扁横笔画）独立成字形", () => {
    const data = makeImageData(80, 40, [
      { x: 3, y: 17, w: 16, h: 5 },
      { x: 24, y: 5, w: 14, h: 30 },
    ]);
    const mask = binarizeRed(data, 80, 40);
    const bundle = labelComponents(mask, 80, 40);
    const glyphs = mergeStrokesIntoGlyphs(bundle);
    expect(glyphs.length).toBe(2);
    expect(glyphs[0].w / glyphs[0].h).toBeGreaterThan(2);
  });

  it("忽略 3 像素以下的小噪点", () => {
    const data = makeImageData(40, 40, [
      { x: 10, y: 10, w: 10, h: 20 },
      { x: 30, y: 30, w: 1, h: 1 },
    ]);
    const mask = binarizeRed(data, 40, 40);
    const bundle = labelComponents(mask, 40, 40);
    expect(bundle.components.length).toBe(1);
  });
});

describe("normalizeGlyph", () => {
  it("长边缩放到 20 并居中", () => {
    // 高瘦形（h=40, w=10）→ 缩放后 h=20, w=5
    const w = 10;
    const h = 40;
    const data = new Uint8Array(w * h).fill(1);
    const out = normalizeGlyph(data, w, h);
    const bbox = bboxOf(out);
    expect(bbox.y1 - bbox.y0 + 1).toBe(20);
    expect(bbox.x1 - bbox.x0 + 1).toBe(5);
    // 居中：左右留白基本对称
    expect(Math.abs(bbox.x0 - (27 - bbox.x1))).toBeLessThanOrEqual(1);
    expect(bbox.y0).toBe(4);
  });

  it("宽扁负号保持扁平比例", () => {
    const w = 30;
    const h = 6;
    const data = new Uint8Array(w * h).fill(1);
    const out = normalizeGlyph(data, w, h);
    const bbox = bboxOf(out);
    expect(bbox.x1 - bbox.x0 + 1).toBe(20);
    expect(bbox.y1 - bbox.y0 + 1).toBe(4);
    expect(bbox.x0).toBe(4);
  });

  it("空输入返回全零", () => {
    const out = normalizeGlyph(new Uint8Array(0), 0, 0);
    expect(out.length).toBe(784);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe("segmentRedGlyphs", () => {
  it("把画布上的红笔数字切成字形并归一化", () => {
    const data = makeImageData(100, 50, [
      { x: 5, y: 10, w: 12, h: 30 },
      { x: 25, y: 10, w: 20, h: 30 },
      { x: 60, y: 10, w: 12, h: 30, color: [30, 30, 30] }, // 黑色不参与
    ]);
    const { glyphs } = segmentRedGlyphs(data, 100, 50);
    expect(glyphs.length).toBe(2);
    for (const g of glyphs) {
      expect(g.input.length).toBe(784);
      expect(Math.max(...g.input)).toBeCloseTo(1, 5);
    }
    expect(glyphs[0].glyph.h).toBe(30);
  });
});
