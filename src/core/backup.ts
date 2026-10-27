/** 完整数据备份 / 恢复：把本机的班级、模板、答题卡图片、识别结果、导出记录打成一个 JSON 文件。 */
import type { AppSettings, Capture, CardTemplate, ExportRecord, Project } from "./types";
import { STORES, idbGetAll, idbPut, openDb } from "./storage/db";
import { loadSettings, newId, saveSettings } from "./storage/repo";

export const BACKUP_APP_ID = "ScoreRecognizer";
export const BACKUP_VERSION = 1;

interface BackupImage {
  key: string;
  type: string;
  /** base64（不含 data: 前缀） */
  data: string;
}

export interface BackupFile {
  app: typeof BACKUP_APP_ID;
  version: number;
  createdAt: string;
  settings: AppSettings;
  projects: Project[];
  templates: CardTemplate[];
  captures: Capture[];
  exports: ExportRecord[];
  images: BackupImage[];
}

export interface BackupSummary {
  projects: number;
  students: number;
  templates: number;
  captures: number;
  images: number;
  bytes: number;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

/** 读取 IndexedDB 里所有 blob（图片）的键和值。 */
async function readAllImages(): Promise<Array<{ key: string; blob: Blob }>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.images, "readonly");
    const store = t.objectStore(STORES.images);
    const out: Array<{ key: string; blob: Blob }> = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(out);
      out.push({ key: String(cursor.key), blob: cursor.value as Blob });
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function buildBackup(): Promise<{ filename: string; blob: Blob; summary: BackupSummary }> {
  const [settings, projects, templates, captures, exports, images] = await Promise.all([
    loadSettings(),
    idbGetAll<Project>(STORES.projects),
    idbGetAll<CardTemplate>(STORES.templates),
    idbGetAll<Capture>(STORES.captures),
    idbGetAll<ExportRecord>(STORES.exports),
    readAllImages(),
  ]);

  const packedImages: BackupImage[] = [];
  for (const img of images) {
    try {
      packedImages.push({
        key: img.key,
        type: img.blob.type || "image/jpeg",
        data: await blobToBase64(img.blob),
      });
    } catch (e) {
      console.warn("备份图片失败", img.key, e);
    }
  }

  const backup: BackupFile = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    settings,
    projects,
    templates,
    captures,
    exports,
    images: packedImages,
  };

  const json = JSON.stringify(backup);
  const blob = new Blob([json], { type: "application/json" });
  const summary: BackupSummary = {
    projects: projects.length,
    students: projects.reduce((n, p) => n + (p.students?.length ?? 0), 0),
    templates: templates.length,
    captures: captures.length,
    images: packedImages.length,
    bytes: blob.size,
  };
  return { filename: `ScoreRecognizer-backup-${timestamp()}.json`, blob, summary };
}

export interface RestoreResult extends BackupSummary {
  warnings: string[];
}

function validate(raw: unknown): BackupFile {
  const obj = raw as Partial<BackupFile>;
  if (!obj || obj.app !== BACKUP_APP_ID) throw new Error("不是 ScoreRecognizer 的备份文件");
  if (typeof obj.version !== "number") throw new Error("备份文件缺少版本号");
  if (obj.version > BACKUP_VERSION) throw new Error(`备份来自更新的版本（v${obj.version}），请升级应用后再恢复`);
  if (!Array.isArray(obj.projects) || !Array.isArray(obj.captures)) throw new Error("备份文件内容不完整");
  return obj as BackupFile;
}

async function clearStore(name: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(name, "readwrite");
    const req = t.objectStore(name).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** 从备份文件恢复（覆盖当前全部数据）。 */
export async function restoreBackup(file: File): Promise<RestoreResult> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  const backup = validate(parsed);
  const warnings: string[] = [];

  // 清空后写入，保证与备份完全一致
  await Promise.all([
    clearStore(STORES.projects),
    clearStore(STORES.templates),
    clearStore(STORES.captures),
    clearStore(STORES.exports),
    clearStore(STORES.images),
  ]);

  if (backup.settings && typeof backup.settings === "object") {
    await saveSettings({ ...backup.settings, onboarded: backup.settings.onboarded ?? true });
  }

  for (const p of backup.projects ?? []) {
    await idbPut(STORES.projects, p);
  }
  for (const t of backup.templates ?? []) {
    await idbPut(STORES.templates, t);
  }
  for (const c of backup.captures ?? []) {
    await idbPut(STORES.captures, c);
  }
  for (const e of backup.exports ?? []) {
    await idbPut(STORES.exports, e);
  }

  let restoredImages = 0;
  for (const img of backup.images ?? []) {
    try {
      const blob = base64ToBlob(img.data, img.type);
      await idbPut(STORES.images, blob, img.key);
      restoredImages++;
    } catch (e) {
      warnings.push(`一张图片恢复失败：${img.key}`);
      console.warn(e);
    }
  }

  // 把当前班级指针指到第一个项目
  const firstProject = (backup.projects ?? [])[0];
  if (firstProject) {
    const { idbPut: putKv, STORES: S } = await import("./storage/db");
    await putKv(S.kv, firstProject.id, "current-project");
  }

  return {
    projects: backup.projects?.length ?? 0,
    students: (backup.projects ?? []).reduce((n, p) => n + (p.students?.length ?? 0), 0),
    templates: backup.templates?.length ?? 0,
    captures: backup.captures?.length ?? 0,
    images: restoredImages,
    bytes: file.size,
    warnings,
  };
}

/** 给新项目用的空 id（备份文件里若缺少 id 时兜底）。 */
export function fallbackId(prefix: string): string {
  return newId(prefix);
}
