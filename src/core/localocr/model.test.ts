/**
 * 校验导出的模型 JSON 与推理链路：读取 public/models/digits-model.json，
 * 在留出 fixtures 上跑一遍 TS 推理，准确率应与训练报告一致（>= 90%）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModel, predictGlyph } from "./model";

const ROOT = resolve(process.cwd());
const MODEL_PATH = resolve(ROOT, "public/models/digits-model.json");
const FIXTURES_PATH = resolve(ROOT, "public/models/digits-model.fixtures.json");

const hasModel = existsSync(MODEL_PATH);

function decodeBase64Utf8(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

describe.skipIf(!hasModel)("导出的模型", () => {
  it("可以解析并满足结构约束", () => {
    const json = JSON.parse(readFileSync(MODEL_PATH, "utf8")) as unknown;
    const model = parseModel(json);
    expect(model.inputSize).toBe(28);
    expect(model.classes.length).toBe(12);
    expect(model.classes.slice(0, 10)).toEqual([..."0123456789"]);
    expect(model.classes[10]).toBe("-");
    expect(model.classes[11]).toBe("junk");
    expect(model.W1.length).toBe(784 * model.b1.length);
    expect(model.W2.length).toBe(model.b1.length * model.b2.length);
    expect(model.W3.length).toBe(model.b2.length * 12);
    expect(model.metrics.testAccInt8).toBeGreaterThan(0.9);
  });

  it("导出的权重不是全零（防止 int8 量化/写回回归）", () => {
    const model = parseModel(JSON.parse(readFileSync(MODEL_PATH, "utf8")) as unknown);
    for (const [name, W] of [["W1", model.W1], ["W2", model.W2], ["W3", model.W3]] as const) {
      let nonZero = 0;
      let maxAbs = 0;
      for (let i = 0; i < W.length; i++) {
        const v = W[i];
        if (v !== 0) nonZero++;
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
      }
      expect(nonZero, `${name} 非零权重过少`).toBeGreaterThan(W.length * 0.5);
      expect(maxAbs, `${name} 权重幅度为 0`).toBeGreaterThan(1e-5);
    }
    for (const b of [model.b1, model.b2, model.b3]) {
      expect(b.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("模型能区分不同输入（不是退化成常数输出）", () => {
    expect(existsSync(FIXTURES_PATH)).toBe(true);
    const model = parseModel(JSON.parse(readFileSync(MODEL_PATH, "utf8")) as unknown);
    const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as { labels: string[]; data: string[] };
    const preds = new Set<string>();
    for (const b64 of fixtures.data.slice(0, 12)) {
      const bytes = Buffer.from(b64, "base64");
      const input = new Float32Array(784);
      for (let k = 0; k < 784; k++) input[k] = bytes[k] / 255;
      const p = predictGlyph(model, input);
      let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
      preds.add(model.classes[best]);
    }
    expect(preds.size).toBeGreaterThan(2);
  });

  it("对留出样本的准确率 >= 90%，且概率归一化", () => {
    expect(existsSync(FIXTURES_PATH)).toBe(true);
    const model = parseModel(JSON.parse(readFileSync(MODEL_PATH, "utf8")) as unknown);
    const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as {
      labels: string[];
      data: string[];
      size: number;
    };
    expect(fixtures.labels.length).toBeGreaterThan(10);
    let correct = 0;
    for (let i = 0; i < fixtures.data.length; i++) {
      const bytes = Buffer.from(fixtures.data[i], "base64");
      expect(bytes.length).toBe(784);
      const input = new Float32Array(784);
      for (let k = 0; k < 784; k++) input[k] = bytes[k] / 255;
      const p = predictGlyph(model, input);
      let best = 0;
      let sum = 0;
      for (let k = 0; k < p.length; k++) {
        sum += p[k];
        if (p[k] > p[best]) best = k;
      }
      expect(sum).toBeCloseTo(1, 3);
      if (model.classes[best] === fixtures.labels[i]) correct++;
    }
    const acc = correct / fixtures.data.length;
    expect(acc).toBeGreaterThanOrEqual(0.9);
  });
});

describe.skipIf(hasModel)("模型文件缺失", () => {
  it("提示先运行 _build/train_digits.py", () => {
    expect(decodeBase64Utf8("")).toBe("");
    throw new Error("缺少 public/models/digits-model.json，请先运行 _build/train_digits.py");
  });
});
