import { describe, expect, it } from "vitest";
import { isRedPixel } from "./red";

describe("红色笔迹判断", () => {
  it("典型红笔颜色被识别", () => {
    expect(isRedPixel(220, 30, 30)).toBe(true);
    expect(isRedPixel(200, 60, 70)).toBe(true);
    expect(isRedPixel(150, 20, 40)).toBe(true);
  });

  it("黑色、蓝色、印刷灰都不算红笔", () => {
    expect(isRedPixel(20, 20, 20)).toBe(false);
    expect(isRedPixel(230, 230, 230)).toBe(false);
    expect(isRedPixel(40, 60, 200)).toBe(false);
    expect(isRedPixel(120, 120, 130)).toBe(false);
  });

  it("很浅的粉色荧光笔不至于误判（饱和度不足）", () => {
    expect(isRedPixel(255, 235, 235)).toBe(false);
  });
});
