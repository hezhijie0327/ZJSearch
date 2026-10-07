// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Eye } from "lucide-react";
import type { ToolView } from "@/features/results/aiSearch/calls/types.ts";

/** The view_image view (the researcher's eyes on a result's chart/diagram):
    the row shows the fetched image itself -- click opens the family
    lightbox for a closer read. */
export const viewImageView: ToolView = {
  Icon: Eye,
  label: ({ call, t }) => call.q || (call.args?.url ? String(call.args.url).slice(0, 80) : t("attach_files")),
  metric: ({ call }) =>
    call.status === "pending" ? null : call.status === "ok" ? (call.n ? `${call.n}` : null) : null,
  Content: ({ call }) =>
    call.args?.url ? (
      <div className="mt-1 overflow-hidden rounded-lg border border-line">
        <img alt="" className="max-h-72 w-full object-contain" src={String(call.args.url)} />
      </div>
    ) : null,
  expandable: ({ call }) => Boolean(call.args?.url),
};
