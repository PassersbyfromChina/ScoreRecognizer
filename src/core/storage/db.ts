/** 极简 IndexedDB 封装：跨桌面/手机 WebView 通用，图片以 Blob 保存。 */

const DB_NAME = "score-recognizer";
const DB_VERSION = 1;

export const STORES = {
  kv: "kv",
  projects: "projects",
  templates: "templates",
  captures: "captures",
  images: "images",
  exports: "exports",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv);
      if (!db.objectStoreNames.contains(STORES.projects)) db.createObjectStore(STORES.projects, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.templates)) db.createObjectStore(STORES.templates, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.captures)) {
        const s = db.createObjectStore(STORES.captures, { keyPath: "id" });
        s.createIndex("projectId", "projectId");
        s.createIndex("status", "status");
        s.createIndex("byProjectStatus", ["projectId", "status"]);
      }
      if (!db.objectStoreNames.contains(STORES.images)) db.createObjectStore(STORES.images);
      if (!db.objectStoreNames.contains(STORES.exports)) {
        const s = db.createObjectStore(STORES.exports, { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function idbPut<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  await tx<IDBValidKey>(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  await tx<undefined>(store, "readwrite", (s) => s.delete(key));
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbCount(store: StoreName): Promise<number> {
  return tx<number>(store, "readonly", (s) => s.count());
}

export async function idbAllByIndex<T>(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const req = t.objectStore(store).index(index).getAll(query);
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbCountByIndex(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const req = t.objectStore(store).index(index).count(query);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbClear(store: StoreName): Promise<void> {
  await tx<undefined>(store, "readwrite", (s) => s.clear());
}

/** 估算已用存储空间（字节），用于设置页展示。 */
export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}
