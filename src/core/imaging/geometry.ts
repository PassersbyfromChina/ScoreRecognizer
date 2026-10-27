import type { Point } from "../types";

/** 3x3 单应矩阵求解（DLT，8 个未知数 h33=1）。dst 通常为目标矩形四角。 */
export function solveHomography(src: Point[], dst: Point[]): number[] {
  if (src.length !== 4 || dst.length !== 4) throw new Error("需要 4 个点");
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  const h = gaussianSolve(A);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function gaussianSolve(A: number[][]): number[] {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) throw new Error("单应矩阵无解（四点共线？）");
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const div = A[col][col];
    for (let c = col; c <= n; c++) A[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row[n]);
}

export function invert3x3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("矩阵不可逆");
  const inv = [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
  return inv;
}

export function applyHomography(m: number[], p: Point): Point {
  const denom = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / denom,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / denom,
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 四点围成的面积（鞋带公式） */
export function polygonArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 按顺序排列四个角：左上、右上、右下、左下。 */
export function orderCorners(points: Point[]): [Point, Point, Point, Point] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // atan2 从 -π 开始，排序后按角度逆时针；找最左上的作为起点
  let startIdx = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    const score = p.x + p.y;
    if (score < best) {
      best = score;
      startIdx = i;
    }
  });
  const rotated = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  // 保证顺时针（图像坐标 y 向下）
  const cross =
    (rotated[1].x - rotated[0].x) * (rotated[2].y - rotated[0].y) -
    (rotated[1].y - rotated[0].y) * (rotated[2].x - rotated[0].x);
  if (cross < 0) {
    return [rotated[0], rotated[3], rotated[2], rotated[1]];
  }
  return rotated as [Point, Point, Point, Point];
}
