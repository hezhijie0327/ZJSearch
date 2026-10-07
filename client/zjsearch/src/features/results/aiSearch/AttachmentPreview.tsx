// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { MarkdownAnswer } from "@/features/results/AiSummary.tsx";
import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";

/**
 * The document attachment's preview: one attached .md/.txt file, its TEXT
 * rendered (markdown -> the standard answer pipeline) inside a scrollable
 * dialog.  Same contract as the image lightbox: portal, aria-modal,
 * Escape/backdrop close, focus in and out.
 */

export function AttachmentPreview({ attachment, onClose }: { attachment: AiSearchAttachment; onClose: () => void }) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-black/70" onClick={onClose} />
      <div
        aria-modal="true"
        className="relative z-10 flex max-h-full w-full max-w-3xl animate-fade-up flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-5 py-3">
          <p className="min-w-0 truncate text-sm font-semibold text-ink" dir="auto">
            {attachment.name || t("attach_files")}
          </p>
          <button
            aria-label={t("close")}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2/80 text-ink-2 transition-colors hover:text-ink"
            data-dialog-close
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="zjs-answer-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 text-sm leading-relaxed text-ink">
          <MarkdownAnswer galleries={[]} markdown={attachment.data ?? ""} meta={[]} onCite={() => {}} settled />
        </div>
      </div>
    </div>,
    document.body,
  );
}
