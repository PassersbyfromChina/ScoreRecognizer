import type { AppSettings } from "../types";
import { callVision, type VisionAnswer, type VisionImage } from "../ai/deepseek";

export interface CropImage {
  questionNo?: number;
  label: string;
  dataUrl: string;
}

export interface AIRecognizeResult {
  answers: Map<number, VisionAnswer>;
  name: string | null;
  nameConfidence: number;
  errors: string[];
}

const BATCH_SIZE = 8;

function buildPrompt(items: Array<{ questionNo?: number; label: string }>, includeName: boolean): string {
  const lines: string[] = [];
  lines.push("你是严谨的答题卡阅卷助手。下面每张图片都是答题卡上的局部裁剪（已放大）。");
  if (includeName) lines.push("其中第一张是【手写姓名】区域，其余是【各道题】区域。");
  lines.push("请逐张识别，并按下面顺序对应：");
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.questionNo ? `第 ${it.questionNo} 题` : "姓名"}`));
  lines.push("规则：");
  lines.push("1. 只读取红色笔迹写的分数数字；黑色印刷内容不算（姓名除外）。");
  lines.push("2. 分数可能是正数（得分）或负数（扣分，例如 -2）；也可能带单位或多余符号，只取数字。");
  lines.push('3. 同一张图里出现两个不同的红色分数时：score 填 null，issue 填 "multiple"。');
  lines.push('4. 图中没有红色分数（例如只有一个红勾）：score 填 null，issue 填 "missing"。');
  lines.push('5. 看不清、无法确定数字时：score 填 null，issue 填 "unclear"，confidence 低。');
  lines.push("6. 绝不猜测。");
  if (includeName) lines.push("7. 姓名是手写黑色字迹，看不清就返回 null。");
  lines.push(
    '只返回 JSON：{"name": string|null, "nameConfidence": number, "answers":[{"questionNo": number, "score": number|null, "confidence": number, "issue": "multiple"|"missing"|"unclear"|null}]}',
  );
  return lines.join("\n");
}

/** 分批调用 AI 识别若干题目的局部截图（每批 ≤8 张，控制单次请求大小）。 */
export async function recognizeCrops(
  settings: AppSettings,
  images: CropImage[],
  nameImage: CropImage | null,
): Promise<AIRecognizeResult> {
  const answers = new Map<number, VisionAnswer>();
  const errors: string[] = [];
  let name: string | null = null;
  let nameConfidence = 0;
  let nameDone = false;

  const questionImages = images.filter((i) => i.questionNo != null);
  const batches: CropImage[][] = [];
  for (let i = 0; i < questionImages.length; i += BATCH_SIZE) {
    batches.push(questionImages.slice(i, i + BATCH_SIZE));
  }
  if (batches.length === 0) batches.push([]);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const includeName = !nameDone && nameImage != null;
    const items: CropImage[] = includeName ? [nameImage!, ...batch] : batch;
    if (items.length === 0) continue;
    try {
      const visionImages: VisionImage[] = items.map((it) => ({
        dataUrl: it.dataUrl,
        label: it.label,
      }));
      const prompt = buildPrompt(
        items.map((it) => ({ questionNo: it.questionNo, label: it.label })),
        includeName,
      );
      const result = await callVision({ settings }, visionImages, prompt);
      for (const a of result.answers) {
        // 防止同一题重复写入
        if (!answers.has(a.questionNo)) answers.set(a.questionNo, a);
      }
      if (includeName) {
        name = result.name;
        nameConfidence = result.nameConfidence;
        nameDone = true;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "AI 识别失败");
    }
  }

  return { answers, name, nameConfidence, errors };
}
