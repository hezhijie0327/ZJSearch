// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The knowledge page's sections: the thread rows (Vane's library list),
    the grouped search results, the memory surface (LobeHub's timeline +
    cards), the inspector reading pane (morphic), the admin drawer (the
    old preferences PgliteTab's duties) and the shared confirm dialog.
    Page-private to KnowledgePage -- nothing here exports beyond it
    EXCEPT the glyph identity map, which the drawer's views wear too. */

import {
  Database,
  FileText,
  Globe,
  LayoutTemplate,
  MemoryStick,
  MessageCircleQuestion,
  Network,
  Pencil,
  Trash2,
} from "lucide-react";
import { useT } from "@/lib/i18n.ts";

/** The ONE glyph identity per knowledge surface: the segment tab, the kind
    directory's empty note and each view's own empty state wear the same
    icon -- one map, so they cannot drift apart again (the Layers-era
    empties once disagreed with every tab they lived under). */

export const KNOWLEDGE_KIND_ICONS = {
  reading: Globe,
  run: MessageCircleQuestion,
  source: Globe,
  document: FileText,
  memory: MemoryStick,
  graph: Network,
  templates: LayoutTemplate,
  admin: Database,
} as const;

/** The knowledge META chip: a 12px bordered chip for row meta and hero
    stats (the lib CHIP_OUTLINE is the 13px CLICKABLE control tier -- a
    same-name divergent token here once invited drift; this reads as its
    own tier now). */

export const META_CHIP =
  "inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-xs text-ink-3";

/** The in-panel views' back row: focus lands here on view swap (the
    imperative focus-on-mount pattern -- no autoFocus attribute). */

export function RowActions({
  onRemove,
  onRename,
  reveal = true,
}: {
  onRemove: () => void;
  onRename?: () => void;
  reveal?: boolean;
}) {
  const t = useT();

  return (
    <div
      className={`flex shrink-0 items-center gap-0.5 ${reveal ? "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" : ""}`}
    >
      {onRename ? (
        <button
          aria-label={t("knowledge_rename")}
          className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={onRename}
          title={t("knowledge_rename")}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      <button
        aria-label={t("knowledge_menu_delete")}
        className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        type="button"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

// --------------------------------------------------------- search results

/** The cross-kind search hits, grouped by kind (the knowledge table's
    headline capability).  A source hit opens the inspector; a document
    hit reads its archived full text; anything else navigates. */
