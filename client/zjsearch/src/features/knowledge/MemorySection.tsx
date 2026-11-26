// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it
    EXCEPT the glyph identity map, which the drawer's views wear too. */

import { Check, MemoryStick, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BootRowsCard } from "@/components/BootGhosts.tsx";
import { PaperEmpty } from "@/components/PaperEmpty.tsx";
import { Card } from "@/components/SettingParts.tsx";
import { META_CHIP } from "@/features/knowledge/rowParts.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import type { MemoryRow } from "@/lib/kb/memory.ts";
import { CHIP_BTN } from "@/lib/styles.ts";

/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */

export function MemorySection({
  memories,
  loading = false,
  onAdd,
  onForget,
  onSave,
  onConfirm,
  onDismiss,
}: {
  memories: MemoryRow[];
  loading?: boolean;
  onAdd: (content: string) => void;
  onForget: (id: string) => void;
  onSave: (id: string, content: string) => void;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  if (loading) {
    return <BootRowsCard rows={3} />;
  }
  const submit = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onAdd(text);
    setDraft("");
  };
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5 sm:px-6">
        <Plus aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
        <input
          className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          dir="auto"
          maxLength={300}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              submit();
            }
          }}
          placeholder={t("knowledge_memory_placeholder")}
          value={draft}
        />
        {draft.trim() ? (
          <button
            className="shrink-0 rounded-full bg-accent-strong px-3 py-1 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
            onClick={submit}
            type="button"
          >
            {t("knowledge_memory_save")}
          </button>
        ) : null}
      </div>
      {memories.length === 0 ? (
        <PaperEmpty
          className="py-6"
          icon={MemoryStick}
          line={t("knowledge_memory_empty_line")}
          title={t("knowledge_kind_empty")}
        />
      ) : (
        <div className="space-y-0.5">
          {memories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              onConfirm={onConfirm}
              onDismiss={onDismiss}
              onForget={onForget}
              onSave={onSave}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function MemoryCard({
  memory,
  onForget,
  onSave,
  onConfirm,
  onDismiss,
}: {
  memory: MemoryRow;
  onForget: (id: string) => void;
  onSave: (id: string, content: string) => void;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      draftRef.current?.focus();
      draftRef.current?.select();
    }
  }, [editing]);
  if (editing) {
    return (
      <div className="flex w-full items-center gap-1.5">
        <input
          className="h-7 min-w-0 flex-1 rounded-lg border border-accent bg-transparent px-2 text-[13px] text-ink outline-none"
          dir="auto"
          maxLength={300}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // the row is the editor: Enter saves, Escape cancels (and the
            // drawer must not read either)
            event.stopPropagation();
            if (event.key === "Escape") {
              setEditing(false);
            }
            if (event.key === "Enter" && draft.trim()) {
              onSave(memory.id, draft);
              setEditing(false);
            }
          }}
          ref={draftRef}
          value={draft}
        />
        <button
          aria-label={t("knowledge_memory_save")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-accent transition-colors hover:bg-surface-2 disabled:opacity-40"
          disabled={!draft.trim()}
          onClick={() => {
            onSave(memory.id, draft);
            setEditing(false);
          }}
          title={t("knowledge_memory_save")}
          type="button"
        >
          <Check aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={t("ai_delete_cancel")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2"
          onClick={() => setEditing(false)}
          title={t("ai_delete_cancel")}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="group flex items-start rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-ink" dir="auto">
          {memory.content}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <span className={META_CHIP}>
            {t(
              memory.kind === "procedure"
                ? "knowledge_mem_procedure"
                : memory.kind === "lesson"
                  ? "knowledge_mem_lesson"
                  : memory.kind === "gap"
                    ? "knowledge_mem_gap"
                    : "knowledge_mem_fact",
            )}
          </span>
          {memory.host ? <span className={META_CHIP}>{memory.host}</span> : null}
          {memory.state === "provisional" ? <span className={META_CHIP}>{t("knowledge_mem_pending")}</span> : null}
          <span>{formatDate(new Date(memory.updated).toISOString())}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {memory.state === "provisional" ? (
          <>
            <button
              aria-label={t("knowledge_mem_confirm")}
              className={`${CHIP_BTN} text-accent`}
              onClick={() => onConfirm(memory.id)}
              title={t("knowledge_mem_confirm")}
              type="button"
            >
              <Check aria-hidden="true" className="size-3.5" />
            </button>
            <button
              aria-label={t("knowledge_mem_dismiss")}
              className={CHIP_BTN}
              onClick={() => onDismiss(memory.id)}
              title={t("knowledge_mem_dismiss")}
              type="button"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </>
        ) : null}
        <button
          aria-label={t("knowledge_memory_edit")}
          className={CHIP_BTN}
          onClick={() => {
            setDraft(memory.content);
            setEditing(true);
          }}
          title={t("knowledge_memory_edit")}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={t("knowledge_memory_forget")}
          className={`${CHIP_BTN} hover:text-danger`}
          onClick={() => onForget(memory.id)}
          title={t("knowledge_memory_forget")}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- inspector

/** The morphic inspector as an IN-PANEL view: the knowledge panel
    navigates to the reading pane and back -- it never stacks a second
    drawer.  The thread action is a button (an anchor to the thread page
    would be captured by the panel's click-capture into a fallback). */
