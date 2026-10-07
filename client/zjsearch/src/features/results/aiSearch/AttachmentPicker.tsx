// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Paperclip, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

/**
 * The AI composer's paperclip: pick (or paste) images, compress them
 * client-side (canvas downscale to the vision sweet spot, JPEG), preview
 * with per-item remove -- and that is the WHOLE story.  The bytes never
 * leave the browser except inside the question's own request body (the
 * server forwards them to the vision model and stores nothing); the local
 * copy lands in the knowledge base's attachment table at run start.
 * Shaped for future file kinds: the picker filters image/* today.
 */

const MAX_ATTACHMENTS = 4;
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

/** Downscale + re-encode through a canvas: a 4000px phone photo becomes a
    ~200-400KB data URL the vision model can actually use. */
async function compress(file: File): Promise<AiSearchAttachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return {
      kind: "image",
      mime: "image/jpeg",
      name: file.name,
      bytes: Math.round((data.length - data.indexOf(",") - 1) * 0.75),
      data,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AttachmentPicker({
  items,
  onChange,
  disabled,
}: {
  items: AiSearchAttachment[];
  onChange: (next: AiSearchAttachment[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const room = MAX_ATTACHMENTS - items.length;
      if (room <= 0 || disabled) {
        return;
      }
      setBusy(true);
      try {
        const next = [...items];
        for (const file of files) {
          if (!file.type.startsWith("image/") || next.length >= MAX_ATTACHMENTS) {
            continue;
          }
          next.push(await compress(file));
        }
        if (next.length !== items.length) {
          onChange(next);
        }
      } finally {
        setBusy(false);
      }
    },
    [items, onChange, disabled],
  );

  return (
    <div className="flex items-center gap-1.5">
      {items.map((item, index) => (
        <span className="relative shrink-0" key={index}>
          <img
            alt={item.name ?? t("attach_images")}
            className="size-9 rounded-lg border border-line object-cover"
            src={item.data}
          />
          <button
            aria-label={t("remove")}
            className="absolute -end-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-line bg-bg text-ink-3 transition-colors hover:text-danger"
            onClick={() => {
              onChange(items.filter((_, i) => i !== index));
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-2.5" />
          </button>
        </span>
      ))}
      {items.length < MAX_ATTACHMENTS ? (
        <label
          aria-label={t("attach_images")}
          className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2/70 hover:text-ink ${disabled ? "pointer-events-none opacity-40" : ""}`}
          title={t("attach_images")}
        >
          <Paperclip aria-hidden="true" className="size-4" />
          <input
            accept="image/*"
            aria-label={t("attach_images")}
            className="hidden"
            disabled={disabled || busy}
            multiple
            onChange={(event) => {
              void addFiles(event.target.files ?? []);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
      ) : null}
    </div>
  );
}

/** The compressed drafts currently staged in a composer (the picker's
    items) -- what `start`/`followup` accept as their attachments. */
export type StagedAttachment = AiSearchAttachment;
