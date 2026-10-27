/** 全局数据模型。所有坐标（区域/角点）统一使用「答题卡长边 = 1」的单位。 */

export type ID = string;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MissingMarkMode = "question" | "blank" | "zero" | "custom";

export interface AppSettings {
  /** 是否已完成首次设置（AI key 或不使用 AI） */
  onboarded: boolean;
  aiEnabled: boolean;
  aiProvider: "deepseek";
  aiModel: string;
  aiBaseUrl: string;
  /** 仅保存在本机；桌面版后续可用系统安全存储加密 */
  apiKey: string;
  /** 未确认格子的导出标记 */
  missingMarkMode: MissingMarkMode;
  missingMarkCustom: string;
  /** 自动识别失败时是否自动尝试本地识别 */
  localFirst: boolean;
  /** 离线时按班级名单顺序自动填姓名（仍需人工确认，避免每张都手动选） */
  autoNameByOrder: boolean;
  theme: "light";
}

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  aiEnabled: true,
  aiProvider: "deepseek",
  aiModel: "deepseek-v4-flash-vision-exp",
  aiBaseUrl: "https://api.deepseek.com",
  apiKey: "",
  missingMarkMode: "question",
  missingMarkCustom: "?",
  localFirst: true,
  autoNameByOrder: false,
  theme: "light",
};

export interface Student {
  id: ID;
  order: number;
  name: string;
}

export type RegionKind = "name" | "question";

export interface Region extends Rect {
  id: ID;
  kind: RegionKind;
  /** 题目编号；姓名区域为空 */
  questionNo?: number;
  label?: string;
}

export interface CardTemplate {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 样张原始图片的宽度/高度（原图像素） */
  imageWidth: number;
  imageHeight: number;
  /** 样张原图存储键（保留以便重新调整四角） */
  imageKey: string;
  /** 矫正后的标准卡图片存储键 */
  correctedKey?: string;
  /** 样张中答题卡的四个角（原图像素坐标），顺序 TL TR BR BL */
  corners: [Point, Point, Point, Point];
  regions: Region[];
  /** 纠偏后的标准卡尺寸比例（宽/高），默认 A4 0.707 */
  aspect: number;
}

export type CaptureStatus =
  | "pending_capture"
  | "pending_process"
  | "pending_review"
  | "done";

export type AnswerState =
  | "ok"
  | "low_confidence"
  | "missing"
  | "multiple"
  | "edited"
  | "unreviewed";

export interface AnswerRecord {
  questionNo: number;
  /** 模型给出的原始分数（可为负数；null 表示没识别到） */
  rawScore: number | null;
  confidence: number;
  state: AnswerState;
  /** 人工确认后的分数（最终导出用） */
  finalScore: number | null;
  /** 识别时使用的截图键（确认界面局部放大用） */
  cropKey?: string;
  /** 红笔笔迹的包围盒（长边=1 坐标） */
  inkBox?: Rect;
  /** 备注/问题说明 */
  note?: string;
}

export interface Capture {
  id: ID;
  projectId: ID;
  createdAt: number;
  updatedAt: number;
  status: CaptureStatus;
  /** 原图存储键 */
  imageKey?: string;
  /** 矫正后图片存储键 */
  correctedKey?: string;
  studentId?: ID;
  /** 识别出的姓名文本 */
  nameText?: string;
  nameConfidence?: number;
  nameState?: "ok" | "low_confidence" | "unreviewed" | "edited";
  answers: AnswerRecord[];
  /** 人工确认完成时间 */
  confirmedAt?: number;
  error?: string;
}

export interface Project {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  templateId?: ID;
  students: Student[];
  /** 姓名 Excel 的原始文件名 */
  sourceFile?: string;
  /** 姓名列检测结果，便于重新导入时复用 */
  importMeta?: {
    sheetName: string;
    headerRow: number;
    nameColumn: number;
    startRow: number;
  };
}

export interface ExportRecord {
  id: ID;
  projectId: ID;
  createdAt: number;
  filename: string;
  /** 导出的快照数据（JSON），用于应用内备份 */
  snapshot: ExportSnapshot;
}

export interface ExportSnapshot {
  projectName: string;
  questions: number[];
  rows: Array<{
    studentName: string;
    studentId?: ID;
    scores: Record<number, number | null>;
    total: number | null;
    confirmed: boolean;
  }>;
}

export interface NameImportResult {
  sheetName: string;
  headerRow: number;
  nameColumn: number;
  startRow: number;
  names: Array<{ row: number; name: string }>;
  /** 表头候选列 */
  columns: Array<{ index: number; header: string; sample: string[] }>;
  warnings: string[];
}

export interface DetectionResult {
  corners: [Point, Point, Point, Point];
  confidence: number;
  /** frame = 整张画面都是纸（无需找边）；fallback = 没找到边，按画面范围处理 */
  method: "markers" | "paper-edge" | "manual" | "fallback" | "frame";
}
