// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Browser-stored AI conversation threads (localStorage, LobeHub's
    conversation shape minus the backend): one key per thread plus a small
    index for the history list.  The server owns nothing -- an AI session is
    identified by the uuid in its url (`/ai/thread/<id>`) and survives a
    reload; storage is browser-local by design (never syncs across devices).
    Deliberately storage-plumbing only: the shape of a thread's payload is
    the caller's business (the store speaks `unknown`), so lib stays free of
    feature types. */

export interface AiThreadMeta {
  id: string;
  /** first question of the thread -- the history list's label */
  title: string;
  updated: number;
}

const INDEX_KEY = "zjs-ai-threads";
const keyOf = (id: string): string => `zjs-ai-thread-${id}`;
const MAX_THREADS = 20;

function readIndex(): AiThreadMeta[] {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AiThreadMeta => Boolean(item && (item as AiThreadMeta).id))
      : [];
  } catch {
    return [];
  }
}

function writeIndex(list: AiThreadMeta[]): void {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, MAX_THREADS)));
  } catch {
    /* storage unavailable -- the thread simply stays in memory */
  }
}

/** A fresh conversation identity (the url's uuid). */
export function newThreadId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 11)}`;
}

/** The thread's shareable address (browser-local: another device or browser
    gets the empty state, never someone else's conversation). */
export function threadUrl(id: string): string {
  return `/ai/thread/${id}`;
}

export function listThreads(): AiThreadMeta[] {
  return readIndex();
}

export function loadThread(id: string): unknown | null {
  try {
    const raw = window.localStorage.getItem(keyOf(id));
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Persist one thread and bump it to the front of the index; the oldest
    threads beyond the cap are evicted with their payloads. */
export function saveThread(id: string, title: string, data: unknown): void {
  const meta: AiThreadMeta = { id, title: title.slice(0, 200), updated: Date.now() };
  try {
    window.localStorage.setItem(keyOf(id), JSON.stringify(data));
  } catch {
    // quota: evict the oldest half of the index, then retry once -- a
    // thread with huge sources grids can push past the ~5MB budget
    const surviving = readIndex().slice(0, Math.floor(MAX_THREADS / 2));
    for (const item of readIndex()) {
      if (!surviving.some((kept) => kept.id === item.id)) {
        try {
          window.localStorage.removeItem(keyOf(item.id));
        } catch {
          /* ignore */
        }
      }
    }
    writeIndex(surviving);
    if (!surviving.some((kept) => kept.id === id)) {
      try {
        window.localStorage.setItem(keyOf(id), JSON.stringify(data));
      } catch {
        return; // still over quota: the thread stays in memory only
      }
    }
  }
  writeIndex([meta, ...readIndex().filter((item) => item.id !== id)]);
}

export function deleteThread(id: string): void {
  try {
    window.localStorage.removeItem(keyOf(id));
  } catch {
    /* ignore */
  }
  writeIndex(readIndex().filter((item) => item.id !== id));
}
