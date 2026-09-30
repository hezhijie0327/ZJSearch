// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { History, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { ICON_BTN } from "@/lib/styles.ts";
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
  // Escape closes (the dialog contract keeps Escape with each dialog's own
  // handler); the closing window short-circuits a second press
  useEffect(() => {
    if (!open || closing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closing, onClose]);
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
      <div
        aria-label={t("ai_history")}
        className={`fixed inset-0 z-50 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
        inert={closing}
        ref={ref}
        role="dialog"
      >
        <button
          aria-label={t("close")}
          className="absolute inset-0 cursor-default bg-black/60"
          onClick={onClose}
          tabIndex={closing ? -1 : 0}
          type="button"
        />
        {/* the settings-panel shape: full-width sheet on mobile, a wide
            end-anchored panel from sm up -- not the old floating 80-strip
            that left the page half-visible and the list swimming */}
        <div
          className={`absolute inset-y-0 end-0 flex w-full max-w-3xl flex-col bg-bg shadow-pop ${
            closing ? "animate-slide-out-right" : "animate-slide-in-right"
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <History aria-hidden="true" className="size-4.5 text-ink-3" />
              <h2 className="text-lg font-semibold text-ink">{t("ai_history")}</h2>
            </div>
            <button aria-label={t("close")} className={ICON_BTN} data-dialog-close="" onClick={onClose} type="button">
              <X aria-hidden="true" className="size-4.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
                    <span className="block text-xs text-ink-3">
                      {formatDate(new Date(thread.updated).toISOString())}
                    </span>
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
    </div>
  );
}
