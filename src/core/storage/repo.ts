import type {
  AppSettings,
  Capture,
  CardTemplate,
  ExportRecord,
  Project,
  Student,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";
import {
  STORES,
  idbAllByIndex,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openDb,
} from "./db";

export function newId(prefix = ""): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  const id = Date.now().toString(36) + rand[0].toString(36) + rand[1].toString(36);
  return prefix ? `${prefix}_${id}` : id;
}

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = "app-settings";

export async function loadSettings(): Promise<AppSettings> {
  const saved = await idbGet<Partial<AppSettings>>(STORES.kv, SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await idbPut(STORES.kv, settings, SETTINGS_KEY);
}

// ---------------------------------------------------------------- projects

export async function listProjects(): Promise<Project[]> {
  const all = await idbGetAll<Project>(STORES.projects);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return idbGet<Project>(STORES.projects, id);
}

export async function saveProject(project: Project): Promise<void> {
  project.updatedAt = Date.now();
  await idbPut(STORES.projects, project);
}

export async function createProject(name: string): Promise<Project> {
  const now = Date.now();
  const project: Project = {
    id: newId("proj"),
    name: name.trim() || "未命名班级",
    createdAt: now,
    updatedAt: now,
    students: [],
  };
  await saveProject(project);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  const captures = await idbAllByIndex<Capture>(STORES.captures, "projectId", id);
  for (const c of captures) {
    if (c.imageKey) await deleteImage(c.imageKey);
    if (c.correctedKey) await deleteImage(c.correctedKey);
    for (const a of c.answers) if (a.cropKey) await deleteImage(a.cropKey);
  }
  await Promise.all(captures.map((c) => idbDelete(STORES.captures, c.id)));
  await idbDelete(STORES.projects, id);
}

export function normalizeStudents(names: string[]): Student[] {
  return names
    .map((n) => n.replace(/\s+/g, "").trim())
    .filter((n) => n.length > 0)
    .map((name, i) => ({ id: newId("stu"), order: i, name }));
}

// ---------------------------------------------------------------- templates

export async function saveTemplate(template: CardTemplate): Promise<void> {
  template.updatedAt = Date.now();
  await idbPut(STORES.templates, template);
}

export async function getTemplate(id: string): Promise<CardTemplate | undefined> {
  return idbGet<CardTemplate>(STORES.templates, id);
}

export async function deleteTemplate(id: string): Promise<void> {
  const tpl = await getTemplate(id);
  if (tpl?.imageKey) await deleteImage(tpl.imageKey);
  await idbDelete(STORES.templates, id);
}

// ---------------------------------------------------------------- images

export async function putImage(blob: Blob): Promise<string> {
  const key = newId("img");
  await idbPut(STORES.images, blob, key);
  return key;
}

export async function getImageBlob(key: string): Promise<Blob | undefined> {
  return idbGet<Blob>(STORES.images, key);
}

const urlCache = new Map<string, string>();

export async function getImageUrl(key: string): Promise<string | undefined> {
  const cached = urlCache.get(key);
  if (cached) return cached;
  const blob = await getImageBlob(key);
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

export async function deleteImage(key: string): Promise<void> {
  const url = urlCache.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
  await idbDelete(STORES.images, key);
}

// ---------------------------------------------------------------- captures

export async function listCaptures(projectId: string): Promise<Capture[]> {
  const all = await idbAllByIndex<Capture>(STORES.captures, "projectId", projectId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveCapture(capture: Capture): Promise<void> {
  capture.updatedAt = Date.now();
  await idbPut(STORES.captures, capture);
}

export async function deleteCapture(capture: Capture): Promise<void> {
  if (capture.imageKey) await deleteImage(capture.imageKey);
  if (capture.correctedKey) await deleteImage(capture.correctedKey);
  for (const a of capture.answers) if (a.cropKey) await deleteImage(a.cropKey);
  await idbDelete(STORES.captures, capture.id);
}

export async function countCaptures(projectId: string): Promise<Record<string, number>> {
  const all = await listCaptures(projectId);
  const counts: Record<string, number> = {
    pending_capture: 0,
    pending_process: 0,
    pending_review: 0,
    done: 0,
  };
  for (const c of all) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- exports

export async function saveExport(record: ExportRecord): Promise<void> {
  await idbPut(STORES.exports, record);
}

export async function listExports(projectId: string): Promise<ExportRecord[]> {
  const all = await idbAllByIndex<ExportRecord>(STORES.exports, "projectId", projectId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------- 调试/维护

export async function wipeAll(): Promise<void> {
  const db = await openDb();
  const names = Array.from(db.objectStoreNames);
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(name, "readwrite");
          const req = t.objectStore(name).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        }),
    ),
  );
}
