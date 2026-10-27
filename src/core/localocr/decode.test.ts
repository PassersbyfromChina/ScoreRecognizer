import { describe, expect, it } from "vitest";
import { decodeGlyphPredictions, JUNK_INDEX, MINUS_INDEX, type GlyphPrediction } from "./decode";

const CLASS_COUNT = 12;

/** 构造 softmax 概率：top 类给 confidence，其余平均分。 */
function probs(top: number, confidence = 0.95): Float32Array {
  const p = new Float32Array(CLASS_COUNT);
  const rest = (1 - confidence) / (CLASS_COUNT - 1);
  for (let i = 0; i < CLASS_COUNT; i++) p[i] = rest;
  p[top] = confidence;
  return p;
}

function digitRect(x: number, w = 12, h = 32, y = 4): { x: number; y: number; w: number; h: number } {
  return { x, y, w, h };
}

function pred(
  rect: { x: number; y: number; w: number; h: number },
  top: number,
  confidence = 0.95,
): GlyphPrediction {
  return { rect, probs: probs(top, confidence), area: rect.w * rect.h * 0.4 };
}

function minusPred(x: number, w = 16, h = 5, y = 18): GlyphPrediction {
  return { rect: { x, y, w, h }, probs: probs(MINUS_INDEX, 0.92), area: w * h };
}

function junkPred(x: number, w = 14, h = 26, y = 6): GlyphPrediction {
  return { rect: { x, y, w, h }, probs: probs(JUNK_INDEX, 0.85), area: w * h * 0.5 };
}

describe("decodeGlyphPredictions - 多位数", () => {
  it("两个数字从左到右拼接成 10", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 1, 0.97), pred(digitRect(16), 0, 0.96)]);
    expect(r.text).toBe("10");
    expect(r.value).toBe(10);
    expect(r.reason).toBe("ok");
    expect(r.digits.map((d) => d.label)).toEqual(["1", "0"]);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("3 位数 100 有效", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 1), pred(digitRect(16), 0), pred(digitRect(32), 0)]);
    expect(r.text).toBe("100");
    expect(r.value).toBe(100);
  });

  it("超过 3 位视为非法（value=null）", () => {
    const r = decodeGlyphPredictions([
      pred(digitRect(0), 1),
      pred(digitRect(16), 2),
      pred(digitRect(32), 3),
      pred(digitRect(48), 4),
    ]);
    expect(r.value).toBeNull();
    expect(r.text).toBe("1234");
  });
});

describe("decodeGlyphPredictions - 负号", () => {
  it("模型识别出的负号拼成 -3", () => {
    const r = decodeGlyphPredictions([minusPred(0), pred(digitRect(22), 3, 0.96)]);
    expect(r.text).toBe("-3");
    expect(r.value).toBe(-3);
    expect(r.reason).toBe("ok");
  });

  it("宽扁横笔画即使被模型看成数字也强制当负号", () => {
    // 模型把横线看成 '1'（0.8），但几何上宽扁且在数字中带
    const dash: GlyphPrediction = {
      rect: { x: 0, y: 18, w: 18, h: 5 },
      probs: probs(1, 0.8),
      area: 90,
    };
    const r = decodeGlyphPredictions([dash, pred(digitRect(24), 5, 0.96)]);
    expect(r.text).toBe("-5");
    expect(r.value).toBe(-5);
  });

  it("负号出现在数字右侧 → 非法", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 2, 0.95), minusPred(16)]);
    expect(r.value).toBeNull();
    expect(r.reason).not.toBe("ok");
  });

  it("只有负号没有数字 → null", () => {
    const r = decodeGlyphPredictions([minusPred(0)]);
    expect(r.value).toBeNull();
    expect(r.text).toBe("-");
  });

  it("-0 视为非法", () => {
    const r = decodeGlyphPredictions([minusPred(0), pred(digitRect(22), 0)]);
    expect(r.value).toBeNull();
  });

  it("分开写的负号（与数字有明显间隙）也能拼回去", () => {
    // 数字宽 12，负号到数字间隙 30px，仍在中位数高度 32 的 2.5 倍以内
    const r = decodeGlyphPredictions([minusPred(0, 14, 5, 18), pred(digitRect(44), 2, 0.95)]);
    expect(r.text).toBe("-2");
    expect(r.value).toBe(-2);
  });
});

describe("decodeGlyphPredictions - 噪迹 / junk", () => {
  it("数字之间的 junk 字迹被丢弃", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 1), junkPred(14), pred(digitRect(34), 0)]);
    expect(r.text).toBe("10");
    expect(r.value).toBe(10);
    expect(r.stats?.junkCount).toBe(1);
    // 有噪迹时置信度打折
    expect(r.confidence).toBeLessThan(0.97);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("只有 junk 时返回 null 且 reason=no-valid-number", () => {
    const r = decodeGlyphPredictions([junkPred(4)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe("no-valid-number");
    expect(r.digits.length).toBe(0);
  });

  it("很小的点按噪迹丢弃，不影响数字", () => {
    const dot: GlyphPrediction = { rect: { x: 20, y: 0, w: 4, h: 4 }, probs: probs(0, 0.99), area: 16 };
    const r = decodeGlyphPredictions([pred(digitRect(0), 8, 0.96), dot]);
    expect(r.text).toBe("8");
    expect(r.value).toBe(8);
  });
});

describe("decodeGlyphPredictions - 置信度门槛", () => {
  it("单字置信度太低 → value=null（保留 text 供界面提示）", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 1, 0.55), pred(digitRect(16), 0, 0.55)]);
    expect(r.value).toBeNull();
    expect(r.text).toBe("10");
    expect(r.reason).toBe("low-confidence");
  });

  it("可以自定义门槛：低门槛放行", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 1, 0.55), pred(digitRect(16), 0, 0.55)], {
      minConfidence: 0.5,
      minDigitConfidence: 0.5,
    });
    expect(r.value).toBe(10);
  });

  it("空输入 → empty", () => {
    const r = decodeGlyphPredictions([]);
    expect(r.reason).toBe("empty");
    expect(r.value).toBeNull();
  });

  it("字形太小（低于可靠像素尺寸）→ value=null，避免低分辨率猜错", () => {
    const tiny1 = pred(digitRect(0, 4, 7, 4), 1, 0.99);
    const tiny0 = pred(digitRect(6, 5, 7, 4), 0, 0.99);
    const r = decodeGlyphPredictions([tiny1, tiny0]);
    expect(r.text).toBe("10");
    expect(r.value).toBeNull();
    expect(r.reason).toBe("low-confidence");
  });
});

describe("decodeGlyphPredictions - 歧义 / 格式", () => {
  it("两个相距很远的数字聚类 → ambiguous，不猜", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 8), pred(digitRect(400), 6)]);
    expect(r.value).toBeNull();
    expect(r.reason).toBe("ambiguous");
  });

  it("前导零 05 视为非法", () => {
    const r = decodeGlyphPredictions([pred(digitRect(0), 0), pred(digitRect(16), 5)]);
    expect(r.value).toBeNull();
    expect(r.text).toBe("05");
  });

  it("数字高度差异过大（疑似粘连/噪迹）→ 非法", () => {
    const tall = pred(digitRect(0, 12, 32), 1, 0.95);
    const flat = pred(digitRect(16, 13, 13, 12), 0, 0.95);
    const r = decodeGlyphPredictions([tall, flat]);
    expect(r.value).toBeNull();
  });
});
