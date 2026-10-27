/**
 * 数字分类模型：加载 public/models/digits-model.json（懒加载 + 缓存）、int8 反量化、前向推理。
 *
 * 模型结构（由 _build/train_digits.py 训练导出）：
 *   784 -> 128 ReLU -> 64 ReLU -> 12 softmax
 *   12 类 = 0..9 + '-' + junk（噪迹）
 *   权重 int8 对称量化（每张量一个 scale），bias 为 float。
 */
export const DIGIT_MODEL_VERSION = 1;

interface LayerJson {
  name: string;
  shape: number[];
  scale?: number;
  data: string | number[];
}

export interface DigitModelJson {
  name?: string;
  version?: number;
  createdAt?: string;
  input?: { size?: number; innerBox?: number; mean?: number; std?: number };
  classes?: string[];
  quant?: { scheme?: string };
  layers: LayerJson[];
  metrics?: Record<string, unknown>;
}

export interface DigitModel {
  version: number;
  createdAt: string;
  inputSize: number;
  innerBox: number;
  mean: number;
  std: number;
  classes: string[];
  W1: Float32Array;
  b1: Float32Array;
  W2: Float32Array;
  b2: Float32Array;
  W3: Float32Array;
  b3: Float32Array;
  metrics: Record<string, unknown>;
}

export const EXPECTED_CLASSES: readonly string[] = [..."0123456789", "-", "junk"];

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } };
  if (g.Buffer) return Uint8Array.from(g.Buffer.from(b64, "base64"));
  throw new Error("当前环境缺少 base64 解码能力");
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function dequantizeInt8(layer: LayerJson, expectedLength: number): Float32Array {
  if (typeof layer.data !== "string") throw new Error(`模型层 ${layer.name} 缺少 int8 数据`);
  const bytes = decodeBase64(layer.data);
  if (bytes.length !== expectedLength) {
    throw new Error(`模型层 ${layer.name} 长度不符：期望 ${expectedLength}，实际 ${bytes.length}`);
  }
  const scale = typeof layer.scale === "number" ? layer.scale : 1;
  const out = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const v = bytes[i] < 128 ? bytes[i] : bytes[i] - 256;
    out[i] = v * scale;
  }
  return out;
}

function readFloats(layer: LayerJson): Float32Array {
  if (!Array.isArray(layer.data)) throw new Error(`模型层 ${layer.name} 缺少 float 数据`);
  return Float32Array.from(layer.data);
}

function findLayer(json: DigitModelJson, name: string): LayerJson {
  const layer = (json.layers || []).find((l) => l.name === name);
  if (!layer) throw new Error(`模型缺少层 ${name}`);
  return layer;
}

/** 解析并校验模型 JSON，反量化成推理用的 Float32Array。 */
export function parseModel(raw: unknown): DigitModel {
  const json = raw as DigitModelJson;
  if (!json || typeof json !== "object" || !Array.isArray(json.layers)) {
    throw new Error("模型 JSON 格式不正确");
  }
  const size = json.input?.size ?? 28;
  if (size !== 28) throw new Error(`不支持的输入尺寸 ${size}`);
  const classes = Array.isArray(json.classes) && json.classes.length > 0 ? json.classes : [...EXPECTED_CLASSES];
  if (classes.length !== 12) throw new Error(`不支持的类别数 ${classes.length}`);
  const W1json = findLayer(json, "W1");
  const b1json = findLayer(json, "b1");
  const W2json = findLayer(json, "W2");
  const b2json = findLayer(json, "b2");
  const W3json = findLayer(json, "W3");
  const b3json = findLayer(json, "b3");
  const b1 = readFloats(b1json);
  const b2 = readFloats(b2json);
  const b3 = readFloats(b3json);
  const d = size * size;
  const h1 = b1.length;
  const h2 = b2.length;
  const out = b3.length;
  const W1 = dequantizeInt8(W1json, d * h1);
  const W2 = dequantizeInt8(W2json, h1 * h2);
  const W3 = dequantizeInt8(W3json, h2 * out);
  return {
    version: json.version ?? DIGIT_MODEL_VERSION,
    createdAt: typeof json.createdAt === "string" ? json.createdAt : "",
    inputSize: size,
    innerBox: json.input?.innerBox ?? 20,
    mean: json.input?.mean ?? 0,
    std: json.input?.std ?? 1,
    classes,
    W1,
    b1,
    W2,
    b2,
    W3,
    b3,
    metrics: (json.metrics || {}) as Record<string, unknown>,
  };
}

/** 前向推理：输入 28x28（0..1）→ 12 类概率。 */
export function predictGlyph(model: DigitModel, input: Float32Array): Float32Array {
  const d = model.inputSize * model.inputSize;
  if (input.length !== d) throw new Error(`输入长度 ${input.length} != ${d}`);
  const h1n = model.b1.length;
  const h2n = model.b2.length;
  const outN = model.b3.length;
  const invStd = 1 / (model.std || 1);
  const x = new Float32Array(d);
  for (let i = 0; i < d; i++) x[i] = (input[i] - model.mean) * invStd;

  const h1 = new Float32Array(h1n);
  for (let i = 0; i < d; i++) {
    const v = x[i];
    if (v === 0) continue;
    const base = i * h1n;
    for (let j = 0; j < h1n; j++) h1[j] += v * model.W1[base + j];
  }
  for (let j = 0; j < h1n; j++) h1[j] = Math.max(0, h1[j] + model.b1[j]);

  const h2 = new Float32Array(h2n);
  for (let i = 0; i < h1n; i++) {
    const v = h1[i];
    if (v === 0) continue;
    const base = i * h2n;
    for (let j = 0; j < h2n; j++) h2[j] += v * model.W2[base + j];
  }
  for (let j = 0; j < h2n; j++) h2[j] = Math.max(0, h2[j] + model.b2[j]);

  const logits = new Float32Array(outN);
  for (let i = 0; i < h2n; i++) {
    const v = h2[i];
    if (v === 0) continue;
    const base = i * outN;
    for (let j = 0; j < outN; j++) logits[j] += v * model.W3[base + j];
  }
  let max = -Infinity;
  for (let j = 0; j < outN; j++) {
    logits[j] += model.b3[j];
    if (logits[j] > max) max = logits[j];
  }
  const probs = new Float32Array(outN);
  let sum = 0;
  for (let j = 0; j < outN; j++) {
    const e = Math.exp(logits[j] - max);
    probs[j] = e;
    sum += e;
  }
  const inv = sum > 0 ? 1 / sum : 0;
  for (let j = 0; j < outN; j++) probs[j] *= inv;
  return probs;
}

/** 默认模型地址（Vite：dev 为 /models/...，打包后为相对路径）。 */
export function getDefaultModelUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${base.endsWith("/") ? "" : "/"}models/digits-model.json`;
}

async function fetchModel(url: string): Promise<DigitModel> {
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`模型加载失败 HTTP ${resp.status}（${url}）`);
  const json = (await resp.json()) as unknown;
  return parseModel(json);
}

/**
 * 兜底模型：打包成 TS 模块（由训练脚本生成），用于 Electron 生产环境 file://
 * 无法 fetch 本地 JSON 的场景。动态 import，只有 fetch 失败时才会加载对应 chunk。
 */
async function loadEmbeddedModel(): Promise<DigitModel> {
  const mod = await import("./model-embedded");
  if (!mod.MODEL_EMBEDDED) throw new Error("没有内置模型");
  return parseModel(mod.MODEL_EMBEDDED);
}

let modelPromise: Promise<DigitModel> | null = null;

/** 懒加载并缓存模型。url 传入时直接按该地址加载（不写缓存）。 */
export function loadDigitModel(options?: { url?: string }): Promise<DigitModel> {
  if (options?.url) return fetchModel(options.url);
  if (!modelPromise) {
    modelPromise = fetchModel(getDefaultModelUrl()).catch(async (err) => {
      try {
        return await loadEmbeddedModel();
      } catch (fallbackErr) {
        modelPromise = null;
        throw err instanceof Error ? err : new Error(String(fallbackErr));
      }
    });
  }
  return modelPromise;
}

/** 清空缓存（测试或换模型时用）。 */
export function clearModelCache(): void {
  modelPromise = null;
}

/** 模型是否已经加载完成（同步检查）。 */
export function isModelLoaded(): boolean {
  return modelPromise !== null;
}
