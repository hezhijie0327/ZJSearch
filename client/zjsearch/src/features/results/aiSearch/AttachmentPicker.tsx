// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { FileText, Paperclip, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { AiSearchAttachment } from "@/features/results/aiSearch/timeline.ts";
import { useT } from "@/lib/i18n.ts";

/**
 * The AI composer's paperclip: pick (or paste) images AND markdown/text
 * files.  Images compress client-side (canvas downscale to the vision
 * sweet spot, JPEG) and travel as data URLs; documents are read as TEXT
 * and travel as their content (the researcher reads them directly -- no
 * server-side parsing).  Either way the local copy lands in the
 * knowledge base's attachment table at run start; the server stores
 * nothing.  Shaped for more file kinds later: add a branch in
 * `readFile` + extend the server's mime list.
 */

const MAX_ATTACHMENTS = 4;
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;
const MAX_FILE_CHARS = 200_000;
const IS_MD = /\.(md|markdown|mdx|txt)$/i;

const isImage = (file: File) => file.type.startsWith("image/");
const isDoc = (file: File) => IS_MD.test(file.name) || file.type === "text/markdown" || file.type === "text/plain";

/** Downscale + re-encode through a canvas: a 4000px phone photo becomes a
    ~200-400KB data URL the vision model can actually use. */
async function compressImage(file: File): Promise<AiSearchAttachment> {
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

/** Documents read as TEXT: the content IS the attachment (`data` carries
    it), capped so a mega-markdown cannot flood the request body. */
async function readDocument(file: File): Promise<AiSearchAttachment> {
  let text = await file.text();
  if (text.length > MAX_FILE_CHARS) {
    text = `${text.slice(0, MAX_FILE_CHARS)}\n\n[... truncated by the client ...]`;
  }
  const mime = IS_MD.test(file.name) ? "text/markdown" : "text/plain";
  return { kind: "file", mime, name: file.name, bytes: file.size, data: text };
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
          if (next.length >= MAX_ATTACHMENTS) {
            break;
          }
          if (isImage(file)) {
            next.push(await compressImage(file));
          } else if (isDoc(file)) {
            next.push(await readDocument(file));
          }
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
          {item.kind === "image" ? (
            <img
              alt={item.name ?? t("attach_files")}
              className="size-9 rounded-lg border border-line object-cover"
              src={item.data}
            />
          ) : (
            <span
              className="grid size-9 place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2"
              title={item.name}
            >
              <FileText aria-hidden="true" className="size-4" />
            </span>
          )}
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
          aria-label={t("attach_files")}
          className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2/70 hover:text-ink ${disabled ? "pointer-events-none opacity-40" : ""}`}
          title={t("attach_files")}
        >
          <Paperclip aria-hidden="true" className="size-4" />
          <input
            accept="image/*,.md,.markdown,.mdx,.txt"
            aria-label={t("attach_files")}
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
