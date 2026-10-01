// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** A minimal promise wrapper over IndexedDB for the AI threads store --
    no dependencies.  One database ("zjs-ai"), one object store
    ("threads") keyed by the thread id; put/get/delete/getAll cover
    everything the thread store needs.  Every call rejects when IndexedDB
    is unavailable (Safari private mode, disabled storage) -- the thread
    store catches and falls back to its localStorage engine. */

const DB_NAME = "zjs-ai";
const STORE = "threads";

/** One stored thread: the index meta plus the caller's payload. */
export interface ThreadRecord {
  id: string;
  title: string;
  updated: number;
  data: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) {
        open.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error ?? new Error("indexedDB open failed"));
    };
    open.onblocked = () => {
      dbPromise = null;
      reject(new Error("indexedDB open blocked"));
    };
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB request failed"));
    };
  });
}

export function idbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function idbPut(record: ThreadRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await request(tx.objectStore(STORE).put(record));
}

export async function idbGet(id: string): Promise<ThreadRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return request(tx.objectStore(STORE).get(id) as IDBRequest<ThreadRecord | undefined>);
}

export async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  await request(tx.objectStore(STORE).delete(id));
}

export async function idbGetAll(): Promise<ThreadRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  return request(tx.objectStore(STORE).getAll() as IDBRequest<ThreadRecord[]>);
}
