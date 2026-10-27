import { describe, expect, it } from "vitest";
import { applyHomography, invert3x3, orderCorners, polygonArea, solveHomography } from "./geometry";

describe("单应矩阵", () => {
  it("把单位矩形映射到任意四边形并正确回算", () => {
    const src = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const dst = [
      { x: 10, y: 20 },
      { x: 300, y: 5 },
      { x: 320, y: 210 },
      { x: 5, y: 190 },
    ];
    const H = solveHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(H, src[i]);
      expect(p.x).toBeCloseTo(dst[i].x, 6);
      expect(p.y).toBeCloseTo(dst[i].y, 6);
    }
  });

  it("逆矩阵能还原点", () => {
    const src = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const dst = [
      { x: 12, y: 8 },
      { x: 210, y: 16 },
      { x: 198, y: 120 },
      { x: 4, y: 108 },
    ];
    const H = solveHomography(src, dst);
    const inv = invert3x3(H);
    const p = { x: 37, y: 61 };
    const q = applyHomography(H, p);
    const back = applyHomography(inv, q);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });
});

describe("角点排序", () => {
  it("乱序输入也能排成 左上-右上-右下-左下", () => {
    const p = [
      { x: 100, y: 10 },
      { x: 10, y: 100 },
      { x: 10, y: 10 },
      { x: 100, y: 100 },
    ];
    const ordered = orderCorners(p);
    expect(ordered[0]).toEqual({ x: 10, y: 10 });
    expect(ordered[1]).toEqual({ x: 100, y: 10 });
    expect(ordered[2]).toEqual({ x: 100, y: 100 });
    expect(ordered[3]).toEqual({ x: 10, y: 100 });
    expect(polygonArea(ordered)).toBeCloseTo(8100, 0);
  });
});
