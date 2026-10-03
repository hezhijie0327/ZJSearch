// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Local-instance debugging handle for the knowledge store: the store's
    write path is fire-and-forget by design, so a stuck boot or a failed
    INSERT reads as "the feature is broken" -- this console probe answers
    back (ask the page, not the eye).  Runtime hostname check: public
    deployments never carry it, and vite cannot fold the check away.
    A side-effect module: it installs `window.__zjsKnowledge` at import
    time (main.tsx pulls it in at boot, exactly where the old store's
    module body did). */

import { loadRunEvents, loadThreadEvents } from "@/lib/kb/events.ts";
import { settleRun } from "@/lib/kb/projections.ts";
import { graphSnapshot, listThreads, recallCorpus } from "@/lib/kb/recall.ts";
import { knowledgeStats } from "@/lib/kb/stats.ts";
import { pgQuery } from "@/lib/pg.ts";

if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
  (window as unknown as Record<string, unknown>).__zjsKnowledge = {
    pgQuery,
    loadThreadEvents,
    loadRunEvents,
    knowledgeStats,
    listThreads,
    graphSnapshot,
    settleRun,
    recallCorpus,
  };
}
