import type { AppSettings, Region } from "../types";

export interface VisionAnswer {
  questionNo: number;
  score: number | null;
  confidence: number;
  issue: "multiple" | "missing" | "unclear" | null;
  /** 分数大致位置（长边坐标），可选 */
  inkBox?: { x: number; y: number; w: number; h: number };
}

export interface VisionResult {
  name: string | null;
  nameConfidence: number;
  answers: VisionAnswer[];
  raw: string;
}

export interface VisionImage {
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  /** 给模型的文字说明（例如「第 3 题区域」） */
  label: string;
}

function coordinateLine(region: Region): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(region.x)},${r(region.y)},${r(region.w)},${r(region.h)}`;
}

export function buildRecognitionPrompt(regions: Region[], questions: number[]): string {
  const nameRegion = regions.find((r) => r.kind === "name");
  const questionRegions = regions.filter((r) => r.kind === "question");
  const lines: string[] = [];
  lines.push("你是严谨的答题卡阅卷助手。图中是已经用红笔批改过的答题卡照片。");
  lines.push("坐标约定：以答题卡长边为 1，原点在左上角，x 向右，y 向下。下面给出区域的大致范围（红笔分数可能写在区域外附近）：");
  if (nameRegion) lines.push(`姓名区域：x=${coordinateLine(nameRegion)}`);
  for (const r of questionRegions) {
    if (r.questionNo != null) lines.push(`第 ${r.questionNo} 题区域：x=${coordinateLine(r)}`);
  }
  lines.push(`需要识别的题号：${questions.join("、")}`);
  lines.push("规则：");
  lines.push("1. 只读取红色笔迹写的分数数字，不要读印刷内容，不要读黑色笔迹。");
  lines.push("2. 分数可能是正数（得分），也可能是负数（扣分，例如 -2）。");
  lines.push('3. 同一道题附近若出现两个不同的红色分数，issue 填 "multiple"，score 填 null。');
  lines.push('4. 题目区域内外附近都没有红色分数时，score 填 null，issue 填 "missing"。');
  lines.push('5. 字迹看不清、无法确定数字时，score 填 null，issue 填 "unclear"，confidence 低。');
  lines.push("6. 绝不猜测；宁可返回 null 让人工确认。");
  lines.push("7. 姓名是手写黑色字迹，看不清返回 null。");
  lines.push('只返回一个 JSON 对象，不要 markdown，不要解释：{"name": string|null, "nameConfidence": number, "answers": [{"questionNo": number, "score": number|null, "confidence": number, "issue": "multiple"|"missing"|"unclear"|null}]}');
  return lines.join("\n");
}

export function buildCropPrompt(items: Array<{ questionNo: number; label: string }>, includeName: boolean): string {
  const lines: string[] = [];
  lines.push("你是严谨的答题卡阅卷助手。下面每张图片都是答题卡上对应题目附近的局部裁剪，已放大。");
  if (includeName) lines.push("第 1 张图片是手写姓名区域。");
  lines.push("规则：");
  lines.push("1. 只读取红色笔迹写的分数数字；黑色/印刷内容不算，除非是姓名。");
  lines.push("2. 分数可能是正数（得分）或负数（扣分，例如 -2）。");
  lines.push('3. 同一题若出现两个不同红色分数，issue 填 "multiple"，score 填 null。');
  lines.push('4. 没有找到红色分数，score 填 null，issue 填 "missing"。');
  lines.push('5. 看不清、无法确定数字时，score 填 null，issue 填 "unclear"。');
  lines.push("6. 绝不猜测。");
  if (includeName) lines.push("7. 姓名是手写黑色字迹，看不清返回 null。");
  lines.push("题目顺序与图片顺序：" + items.map((it, i) => `${i + 1}.${it.label}`).join("；"));
  lines.push('只返回 JSON：{"name": string|null, "nameConfidence": number, "answers":[{"questionNo": number, "score": number|null, "confidence": number, "issue": "multiple"|"missing"|"unclear"|null}]}');
  return lines.join("\n");
}

export interface DeepSeekOptions {
  settings: AppSettings;
  timeoutMs?: number;
}

/** 调用 DeepSeek 视觉模型，返回解析后的 JSON。 */
export async function callVision(
  opts: DeepSeekOptions,
  images: VisionImage[],
  prompt: string,
): Promise<VisionResult> {
  const { settings } = opts;
  if (!settings.apiKey) throw new Error("还没有配置 API Key");
  const base = settings.aiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (img.label) content.push({ type: "text", text: `图片：${img.label}` });
    content.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }

  const body = JSON.stringify({
    model: settings.aiModel,
    messages: [
      { role: "system", content: "你是严谨的答题卡阅卷助手，只输出 JSON。" },
      { role: "user", content },
    ],
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  });

  const sendOnce = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // 网络抖动/服务端 5xx/限流时自动重试一次；参数错误（4xx）不重试，超时也不重试（避免翻倍等待）
  let res: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const isLast = attempt === 1;
    try {
      const response = await sendOnce();
      if (response.ok) {
        res = response;
        break;
      }
      const text = await response.text().catch(() => "");
      const error = new Error(`AI 请求失败（${response.status}）：${text.slice(0, 300)}`);
      if (isLast || !(response.status >= 500 || response.status === 429)) throw error;
      lastError = error;
      await sleep(1200);
    } catch (e) {
      if (isLast || (e instanceof Error && e.name === "AbortError")) throw e;
      lastError = e;
      await sleep(800);
    }
  }
  if (!res) throw lastError instanceof Error ? lastError : new Error("AI 请求失败，请稍后重试");

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  return parseVisionResult(raw);
}

export function parseVisionResult(raw: string): VisionResult {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
    else throw new Error("AI 返回的内容不是 JSON");
  }
  const obj = parsed as {
    name?: unknown;
    nameConfidence?: unknown;
    answers?: Array<Record<string, unknown>>;
  };
  const answers: VisionAnswer[] = Array.isArray(obj.answers)
    ? obj.answers
        .map((a) => {
          const questionNo = Number(a.questionNo);
          if (!Number.isFinite(questionNo)) return null;
          const scoreRaw = a.score;
          let score: number | null = null;
          if (typeof scoreRaw === "number" && Number.isFinite(scoreRaw)) score = scoreRaw;
          else if (typeof scoreRaw === "string" && scoreRaw.trim() !== "") {
            const n = Number(scoreRaw.replace(/[^0-9.\-]/g, ""));
            if (Number.isFinite(n)) score = n;
          }
          const confidence = typeof a.confidence === "number" ? Math.max(0, Math.min(1, a.confidence)) : 0.5;
          const issueRaw = typeof a.issue === "string" ? a.issue : null;
          const issue =
            issueRaw === "multiple" || issueRaw === "missing" || issueRaw === "unclear" ? issueRaw : null;
          return { questionNo, score, confidence, issue } as VisionAnswer;
        })
        .filter((x): x is VisionAnswer => x !== null)
    : [];

  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
  const nameConfidence =
    typeof obj.nameConfidence === "number" ? Math.max(0, Math.min(1, obj.nameConfidence)) : name ? 0.6 : 0;

  return { name, nameConfidence, answers, raw };
}

/** 测试连接：发一条最小请求，确认 key / 模型 / 网络可用。 */
export async function testConnection(settings: AppSettings): Promise<string> {
  const base = settings.aiBaseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return `接口返回 ${res.status}，请检查 key 与地址`;
    return "连接正常";
  } finally {
    clearTimeout(timer);
  }
}

export interface SegmentRegionRaw {
  kind: "name" | "question";
  questionNo?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SegmentResult {
  regions: SegmentRegionRaw[];
  raw: string;
}

/** 让 AI 初步划分题目与姓名区域（坐标以答题卡长边为 1）。 */
export async function segmentCard(
  settings: AppSettings,
  imageDataUrl: string,
  questionCount: number,
): Promise<SegmentResult> {
  const prompt = [
    "你是答题卡版面分析助手。图中是一张已经摆正、矫正过的答题卡。",
    `这张答题卡一共 ${questionCount} 道题。`,
    "请找出：1) 写学生姓名的区域；2) 每道题的作答区域。",
    "题目作答区域指这道题学生作答、老师批改的大致范围，通常包含题号和答题位置；尽量覆盖题目整块区域，不要把整页当成一道题。",
    "坐标约定：以答题卡长边为 1，原点在图片左上角，x 向右，y 向下。宽 w、高 h 也用长边为单位。",
    `必须返回恰好 ${questionCount} 个题目区域，questionNo 从 1 到 ${questionCount}。`,
    '只返回 JSON：{"regions":[{"kind":"name","x":0.06,"y":0.03,"w":0.4,"h":0.05},{"kind":"question","questionNo":1,"x":0.06,"y":0.1,"w":0.88,"h":0.08}]}',
  ].join("\n");

  const res = await callVision(
    { settings, timeoutMs: 90_000 },
    [{ dataUrl: imageDataUrl, label: "整张答题卡（已矫正）" }],
    prompt,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(res.raw));
  } catch {
    throw new Error("AI 没有返回有效的区域 JSON");
  }
  const obj = parsed as { regions?: Array<Record<string, unknown>> };
  const regions: SegmentRegionRaw[] = [];
  for (const r of obj.regions ?? []) {
    const kind = r.kind === "name" ? "name" : r.kind === "question" ? "question" : null;
    if (!kind) continue;
    const nums = ["x", "y", "w", "h"].map((k) => Number(r[k]));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [x, y, w, h] = nums.map((n) => Math.max(0, Math.min(1, n)));
    if (w <= 0.005 || h <= 0.005) continue;
    const questionNo = kind === "question" ? Number(r.questionNo) : undefined;
    if (kind === "question" && (!Number.isFinite(questionNo) || (questionNo as number) < 1)) continue;
    regions.push({ kind, questionNo: questionNo as number | undefined, x, y, w, h });
  }
  if (regions.length === 0) throw new Error("AI 没有给出可用的区域");
  regions.sort((a, b) => (a.questionNo ?? 0) - (b.questionNo ?? 0));
  return { regions, raw: res.raw };
}

function extractJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
