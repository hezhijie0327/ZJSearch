// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import { pgQuery } from "@/lib/pg.ts";

/**
 * The attachment table's read/write paths: the browser-local BYTES of the
 * images a user attaches to AI Search questions (compressed data URLs).
 * The server forwards them to the vision model and stores NOTHING -- this
 * table is the only storage, so a thread's replay can re-show what the
 * user asked about.  Shaped for future file kinds: `kind` is "image"
 * today; "file" rows would carry extracted text instead of a data URL.
 */

const meta = (row: { kind: string; mime: string; name: string; bytes: number; data: string }) => ({
  kind: "image" as const,
  mime: row.mime,
  name: row.name || undefined,
  bytes: Number(row.bytes) || 0,
  data: row.data,
});

/** Persist one run's attachments at run start (idempotent -- a re-start
    from the same composer action must not duplicate rows). */
export function saveAttachments(
  threadId: string,
  runId: string,
  items: Array<{ kind: "image" | "file"; mime: string; name?: string; bytes?: number; data: string }>,
): void {
  if (!items.length) {
    return;
  }
  void (async () => {
    for (const [i, item] of items.entries()) {
      await pgQuery(
        `INSERT INTO attachment (id, run_id, thread_id, kind, mime, name, bytes, data, created)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          `${runId}:a${i + 1}`,
          runId,
          threadId,
          item.kind,
          item.mime,
          item.name ?? "",
          item.bytes ?? 0,
          item.data,
          Date.now(),
        ],
      );
    }
  })();
}

/** Every attachment of a thread, grouped by run id -- the resume path
    fills the folded runs' metadata with the actual bytes. */
export async function loadThreadAttachments(threadId: string): Promise<Map<string, AiSearchAttachment[]>> {
  const rows = await pgQuery<{
    run_id: string;
    kind: string;
    mime: string;
    name: string;
    bytes: number;
    data: string;
  }>("SELECT run_id, kind, mime, name, bytes, data FROM attachment WHERE thread_id = $1 ORDER BY created", [threadId]);
  const grouped = new Map<string, AiSearchAttachment[]>();
  for (const row of rows ?? []) {
    const list = grouped.get(row.run_id) ?? [];
    list.push(meta(row));
    grouped.set(row.run_id, list);
  }
  return grouped;
}
