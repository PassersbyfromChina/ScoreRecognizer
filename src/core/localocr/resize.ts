/**
 * 浮点灰度图缩放：缩小用 box（面积均值）抗锯齿，放大用双线性。
 *
 * 这套算法必须和 _build/train_digits.py 的 resize_gray / _axis_box_weights 保持一致，
 * 否则训练与推理的 28x28 输入分布会对不上。
 */

const weightCache = new Map<number, Float32Array>();

/** 一维 box 滤波权重：把 src 长度整数映射到 dst，返回 dst*src 行优先矩阵。 */
export function axisBoxWeights(src: number, dst: number): Float32Array {
  const key = src * 1000 + dst;
  const cached = weightCache.get(key);
  if (cached) return cached;
  const scale = src / dst;
  const w = new Float32Array(dst * src);
  const rowSums = new Float32Array(dst);
  for (let j = 0; j < dst; j++) {
    const a = j * scale;
    const b = (j + 1) * scale;
    const lo = Math.floor(a);
    const hi = Math.ceil(b);
    for (let i = lo; i < Math.min(hi, src); i++) {
      const ov = Math.min(b, i + 1) - Math.max(a, i);
      if (ov > 0) w[j * src + i] = ov / scale;
    }
    let sum = 0;
    for (let i = 0; i < src; i++) sum += w[j * src + i];
    rowSums[j] = sum === 0 ? 1 : sum;
  }
  for (let j = 0; j < dst; j++) {
    const base = j * src;
    const s = rowSums[j];
    for (let i = 0; i < src; i++) w[base + i] /= s;
  }
  weightCache.set(key, w);
  return w;
}

export function boxResize(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const wx = axisBoxWeights(sw, dw); // dw*sw
  const wy = axisBoxWeights(sh, dh); // dh*sh
  const tmp = new Float32Array(dh * sw);
  for (let y = 0; y < dh; y++) {
    const wyBase = y * sh;
    for (let yy = 0; yy < sh; yy++) {
      const weight = wy[wyBase + yy];
      if (weight === 0) continue;
      const srcBase = yy * sw;
      const dstBase = y * sw;
      for (let x = 0; x < sw; x++) tmp[dstBase + x] += weight * src[srcBase + x];
    }
  }
  const out = new Float32Array(dh * dw);
  for (let y = 0; y < dh; y++) {
    const srcBase = y * sw;
    const dstBase = y * dw;
    for (let x = 0; x < dw; x++) {
      const wxBase = x * sw;
      let sum = 0;
      for (let xx = 0; xx < sw; xx++) {
        const weight = wx[wxBase + xx];
        if (weight !== 0) sum += weight * tmp[srcBase + xx];
      }
      out[dstBase + x] = sum;
    }
  }
  return out;
}

export function bilinearResize(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dh * dw);
  const yScale = sh / dh;
  const xScale = sw / dw;
  for (let y = 0; y < dh; y++) {
    const ys = (y + 0.5) * yScale - 0.5;
    let y0 = Math.floor(ys);
    const wy = Math.min(Math.max(ys - y0, 0), 1);
    let y1 = y0 + 1;
    if (y0 < 0) y0 = 0;
    if (y0 > sh - 1) y0 = sh - 1;
    if (y1 > sh - 1) y1 = sh - 1;
    const row0 = y0 * sw;
    const row1 = y1 * sw;
    for (let x = 0; x < dw; x++) {
      const xs = (x + 0.5) * xScale - 0.5;
      let x0 = Math.floor(xs);
      const wx = Math.min(Math.max(xs - x0, 0), 1);
      let x1 = x0 + 1;
      if (x0 < 0) x0 = 0;
      if (x0 > sw - 1) x0 = sw - 1;
      if (x1 > sw - 1) x1 = sw - 1;
      const top = src[row0 + x0] * (1 - wx) + src[row0 + x1] * wx;
      const bottom = src[row1 + x0] * (1 - wx) + src[row1 + x1] * wx;
      out[y * dw + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/** 与 Python resize_gray 对应：缩小（两轴都不放大）用 box，否则双线性。 */
export function resizeGray(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  if (dw === sw && dh === sh) return src.slice();
  if (dw <= sw && dh <= sh) return boxResize(src, sw, sh, dw, dh);
  return bilinearResize(src, sw, sh, dw, dh);
}
