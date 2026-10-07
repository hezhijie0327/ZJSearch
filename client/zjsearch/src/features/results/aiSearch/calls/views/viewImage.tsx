// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Eye } from "lucide-react";
import { useState } from "react";
import { Lightbox } from "@/features/results/aiSearch/AttachmentLightbox.tsx";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";
import { useT } from "@/lib/i18n.ts";

/** The view_image body: the fetched image on the machine-voice ground
    (padded, centered, never edge-to-edge); clicking opens the FAMILY
    lightbox for a closer read (zoom/pan). */
function ViewImageBody({ url }: { url: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 rounded-lg bg-surface-2/50 p-2">
      <button
        aria-label={t("ai_attach_preview")}
        className="block w-full cursor-zoom-in overflow-hidden rounded border border-line/60"
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        <img alt="" className="mx-auto max-h-72 object-contain" src={url} />
      </button>
      <p className="mt-1.5 text-center text-[11px] text-ink-3">{t("ai_attach_preview")}</p>
      {open ? <Lightbox images={[{ alt: url, src: url }]} initialIndex={0} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The view_image view (the researcher's eyes on a result's chart/diagram):
    the row expands to the fetched image itself. */
export const viewImageView: ToolView = {
  Icon: Eye,
  label: ({ call, t }) => call.q || (call.args?.url ? String(call.args.url).slice(0, 80) : t("attach_files")),
  metric: ({ call }) => (call.status === "pending" ? null : null),
  Content: ({ call }) => (call.args?.url ? <ViewImageBody url={String(call.args.url)} /> : null),
  expandable: ({ call }) => Boolean(call.args?.url),
};
