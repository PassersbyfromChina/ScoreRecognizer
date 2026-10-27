import { describe, expect, it } from "vitest";
import { parseVisionResult } from "./deepseek";

describe("parseVisionResult", () => {
  it("解析标准 JSON", () => {
    const result = parseVisionResult(
      JSON.stringify({
        name: "陈晓",
        nameConfidence: 0.9,
        answers: [
          { questionNo: 1, score: 8, confidence: 0.95, issue: null },
          { questionNo: 2, score: -2, confidence: 0.9, issue: null },
        ],
      }),
    );
    expect(result.name).toBe("陈晓");
    expect(result.nameConfidence).toBeCloseTo(0.9);
    expect(result.answers).toHaveLength(2);
    expect(result.answers[1].score).toBe(-2);
  });

  it("容忍 markdown 代码块和前后解释文字", () => {
    const raw = '好的，结果如下：\n```json\n{"name":null,"answers":[{"questionNo":3,"score":"7分","confidence":1.2}]}\n```\n以上。';
    const result = parseVisionResult(raw);
    expect(result.name).toBeNull();
    expect(result.answers[0].score).toBe(7);
    expect(result.answers[0].confidence).toBe(1);
  });

  it("缺失/异常字段按「不确定」处理，不猜", () => {
    const result = parseVisionResult('{"answers":[{"questionNo":4},{"questionNo":"x","score":5}]}');
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].score).toBeNull();
    expect(result.answers[0].confidence).toBe(0.5);
    expect(result.answers[0].issue).toBeNull();
  });

  it("issue 只接受约定的三种值", () => {
    const result = parseVisionResult(
      JSON.stringify({
        answers: [
          { questionNo: 1, score: null, issue: "multiple" },
          { questionNo: 2, score: null, issue: "unclear" },
          { questionNo: 3, score: null, issue: "missing" },
          { questionNo: 4, score: null, issue: "猜测" },
        ],
      }),
    );
    expect(result.answers.map((a) => a.issue)).toEqual(["multiple", "unclear", "missing", null]);
  });

  it("非 JSON 会抛错（由上层转成待人工处理）", () => {
    expect(() => parseVisionResult("抱歉，我无法识别")).toThrow();
  });
});
