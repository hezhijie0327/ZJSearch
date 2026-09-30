// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { History, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { type AiThreadMeta, deleteThread, listThreads, threadUrl } from "@/lib/threadStore.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

/** The AI conversation history: the browser-stored threads as a slide-in
    sheet.  Entries navigate to their /ai/thread/<uuid> address; deletion
    is local and permanent (the store is the ONLY thread storage -- the
    server keeps nothing).  Purely client data, so this is a plain dialog,
    not an overlay panel (those carry server page payloads). */
export function AiHistoryDrawer({
  currentId,
  onNavigate,
  open,
  onClose,
}: {
  /** the thread currently on screen (its row renders highlighted) */
  currentId?: string;
  onNavigate: (url: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { render, closing } = useExitPresence(open);
  const ref = useDialogFocus<HTMLDivElement>(open && !closing);
  const [threads, setThreads] = useState<AiThreadMeta[]>(() => listThreads());
  if (!render) {
    return null;
  }
  const refresh = (): void => setThreads(listThreads());
  const remove = (id: string): void => {
    deleteThread(id);
    refresh();
  };
  const navigate = (id: string): void => {
    if (id !== currentId) {
      onNavigate(threadUrl(id));
    }
    onClose();
  };
  return (
    <div aria-hidden={closing || undefined}>
      <button
        aria-label={t("close")}
        className={`fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px] transition-opacity ${closing ? "opacity-0" : "animate-fade-in"}`}
        onClick={onClose}
        tabIndex={closing ? -1 : 0}
        type="button"
      />
      <div
        aria-hidden={closing || undefined}
        aria-label={t("ai_history")}
        className={`fixed inset-y-0 end-0 z-40 flex w-80 max-w-[85vw] flex-col border-s border-line bg-surface shadow-card ${closing ? "animate-fade-in" : "animate-fade-in"}`}
        inert={closing}
        ref={ref}
        role="dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <History aria-hidden="true" className="size-4.5 text-ink-3" />
          <h2 className="text-base font-semibold text-ink">{t("ai_history")}</h2>
          <button
            aria-label={t("close")}
            className="ms-auto grid size-9 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            data-dialog-close=""
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {threads.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">{t("ai_history_empty")}</p>
          ) : (
            threads.map((thread) => (
              <div
                className={`group flex items-center gap-1 rounded-xl px-2 ${thread.id === currentId ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                key={thread.id}
              >
                <button
                  className="min-w-0 flex-1 py-2.5 text-start"
                  onClick={() => {
                    navigate(thread.id);
                  }}
                  type="button"
                >
                  <span
                    className={`block truncate text-[13px] ${thread.id === currentId ? "font-medium text-accent" : "text-ink"}`}
                    dir="auto"
                  >
                    {thread.title || t("ai_search")}
                  </span>
                  <span className="block text-xs text-ink-3">{formatDate(new Date(thread.updated).toISOString())}</span>
                </button>
                <button
                  aria-label={t("delete")}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-hover:hover:text-danger"
                  onClick={() => {
                    remove(thread.id);
                  }}
                  title={t("delete")}
                  type="button"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
