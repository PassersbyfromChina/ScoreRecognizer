/**
 * 离线本地数字识别（local OCR）类型定义。
 *
 * 模块定位：给定「某道题附近的红笔区域」裁剪画布，把其中的红笔数字（0-9，可带负号）
 * 识别为分数。识别不可靠时 value = null，交由人工确认（绝不猜）。
 */
import type { DigitModel } from "./model";

export interface LocalOcrRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LocalOcrDigit {
  /** 位置（输入画布像素坐标） */
  rect: LocalOcrRect;
  /** 识别出的字符："0"~"9" 或 "-" */
  label: string;
  /** 置信度 0~1 */
  confidence: number;
}

export type LocalOcrReason =
  | "ok"
  | "empty"
  | "no-valid-number"
  | "invalid-format"
  | "ambiguous"
  | "low-confidence";

export interface LocalOcrStats {
  /** 二值化后合并得到的字形数量 */
  glyphCount: number;
  /** 被当作噪迹丢弃的字形数量（打勾/划线等） */
  junkCount: number;
  /** 横向聚类数量 */
  clusterCount: number;
  /** 每个聚类的原始文本（调试用） */
  clusterTexts: string[];
}

export interface LocalOcrResult {
  /** 从左到右拼接的文本（即使 value 为 null 也保留，便于界面提示） */
  text: string;
  /** 最终分数；不可靠时为 null */
  value: number | null;
  /** 整体置信度 0~1（多数字取最小值，噪迹过多会打折） */
  confidence: number;
  /** 参与结果的数字字形（从左到右） */
  digits: LocalOcrDigit[];
  /** 结论原因，便于上层区分「没有红字」/「看不清」/「有歧义」 */
  reason: LocalOcrReason;
  stats?: LocalOcrStats;
}

export interface LocalOcrOptions {
  /** 直接注入模型（测试或离线内置模型用）；不传则懒加载 public/models/digits-model.json */
  model?: DigitModel;
  /** 整体置信度门槛，低于它 value 返回 null（默认 0.72） */
  minConfidence?: number;
  /** 单个字符置信度门槛，低于它该字形视为不可靠（默认 0.5） */
  minDigitConfidence?: number;
  /** 允许的最大位数（默认 3，够 0~100 分） */
  maxDigits?: number;
  /** 允许的最大绝对值（默认 999） */
  maxValue?: number;
}
