import { describe, expect, it } from "vitest";
import { estimateCardQuad, type GrayImage } from "./detect";
import type { Point } from "../types";

type Quad = [Point, Point, Point, Point];

function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 生成灰度图：背景灰度 bg（可带水平/垂直渐变），四边形区域灰度 paper。 */
function makeImage(
  width: number,
  height: number,
  quad: Quad,
  opts: { bg?: number; paper?: number; gradient?: number } = {},
): GrayImage {
  const bg = opts.bg ?? 120;
  const paper = opts.paper ?? 235;
  const gradient = opts.gradient ?? 0;
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inCard = pointInPolygon(x + 0.5, y + 0.5, quad);
      const light = gradient * (x / width - 0.5) * 2;
      const v = (inCard ? paper : bg) + light;
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { data, width, height };
}

function maxCornerError(found: Quad, expected: Quad): number {
  let worst = 0;
  for (const e of expected) {
    let best = Infinity;
    for (const f of found) {
      const d = Math.hypot(f.x - e.x, f.y - e.y);
      if (d < best) best = d;
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const W = 600;
const H = 800;

function axisQuad(): Quad {
  return [
    { x: 90, y: 70 },
    { x: 510, y: 70 },
    { x: 510, y: 730 },
    { x: 90, y: 730 },
  ];
}

describe("答题卡边缘检测", () => {
  it("正放的答题卡：四角误差很小", () => {
    const img = makeImage(W, H, axisQuad());
    const est = estimateCardQuad(img);
    expect(est).not.toBeNull();
    expect(maxCornerError(est!.corners, axisQuad())).toBeLessThan(4);
    expect(est!.confidence).toBeGreaterThan(0.5);
  });

  it("倾斜的答题卡：仍然找得到四角", () => {
    const quad: Quad = [
      { x: 130, y: 120 },
      { x: 500, y: 60 },
      { x: 520, y: 700 },
      { x: 90, y: 740 },
    ];
    const img = makeImage(W, H, quad);
    const est = estimateCardQuad(img);
    expect(est).not.toBeNull();
    expect(maxCornerError(est!.corners, quad)).toBeLessThan(10);
  });

  it("透视形变（梯形）：不再只按外接矩形估计", () => {
    const quad: Quad = [
      { x: 160, y: 110 },
      { x: 470, y: 70 },
      { x: 530, y: 690 },
      { x: 80, y: 720 },
    ];
    const img = makeImage(W, H, quad);
    const est = estimateCardQuad(img);
    expect(est).not.toBeNull();
    const err = maxCornerError(est!.corners, quad);
    expect(err).toBeLessThan(12);
    // 旧实现用 PCA 外接矩形，梯形四角误差会明显更大；这里确保不会再退化成矩形框
    expect(err).toBeLessThan(20);
  });

  it("光照不均（左右渐变）也能找到答题卡", () => {
    const img = makeImage(W, H, axisQuad(), { gradient: 55 });
    const est = estimateCardQuad(img);
    expect(est).not.toBeNull();
    expect(maxCornerError(est!.corners, axisQuad())).toBeLessThan(8);
  });

  it("整张画面都是纸（扫描件）：不做边缘猜测", () => {
    const full: Quad = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ];
    expect(estimateCardQuad(makeImage(W, H, full))).toBeNull();
  });

  it("几乎没有亮区域（黑屏）：返回 null，交给人工", () => {
    expect(estimateCardQuad(makeImage(W, H, axisQuad(), { paper: 40, bg: 40 }))).toBeNull();
  });

  it("细长亮条不算答题卡", () => {
    const stripe: Quad = [
      { x: 40, y: 300 },
      { x: 560, y: 300 },
      { x: 560, y: 380 },
      { x: 40, y: 380 },
    ];
    expect(estimateCardQuad(makeImage(W, H, stripe))).toBeNull();
  });
});
