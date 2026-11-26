// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The AI debug stage's scenario CATALOG.  Each scenario is a wire-event
 * SCRIPT replayed through the REAL fold (`applyEvent`) and rendered by the
 * REAL run section, and each owns ONE surface -- together they cover the
 * whole UI.  The first entry is the stage's default.  Everything is set
 * in one fictional place (a school paper-plane club: see `shared.ts`), so
 * the stage shows every surface without carrying anyone's real research.
 *
 * COVERAGE MAP -- where each surface lives (keep it in sync):
 *
 * | surface | scenario |
 * |---|---|
 * | attachments · depth probe · outline gate · the write boundary's outline announce · a single-write streamed answer | `report` |
 * | search_web ok / error / duplicate · list_engines inventory · search_tools · recall_history · update_plan · findings (superseded / conflict) · gap · plan sources · a task left pending at the settle | `search` |
 * | calculate · clock · calendar ×4 · evaluate · build_table ok + error + artifact · inspect_image · ask_user recorded · memory ×4 · mcp · decision card (5 purposes) | `tools` |
 * | background tabs · multi-index read (sections + a failed tab) · viewport · open error | `batch-read` |
 * | annotated frame · tab strip · scroll-to-text · fetch · multi click-through · multi ending on a screenshot (steps + img + shot) with a barcode-decode step · browser-minted sources | `browser-ops` |
 * | wait_user window · aimed screenshots · hover / select / drag / type · press · history · wheel scroll · re-snapshot | `browser` |
 * | deck born as deck (slide markdown) | `deck` |
 * | the reader's deck pick (steer notice + deck outline on a report-born run) | `shape-flip` |
 * | set_deliverable flip (balanced → single-write report) | `model-flip` |
 * | gallery placeholder · stalled halt · title · memory row · tags · gates usage | `panorama` |
 * | steer: boundary guide · preempt · undelivered | `steer` |
 * | subagents: delegation row · folded child timeline · browser frame · compaction · follow-up | `sub` |
 * | subagents: pending child rows at an error settle | `sub-pending` |
 * | paid-engine hold → ask_user → approved re-run | `paid` |
 * | clarify gate (awaiting) | `awaiting` |
 * | pasted long brief (clamped run title) | `longtext` |
 * | single-write done | `done` |
 * | stopped by the user | `stopped` |
 * | failed settle (receipt + continue) | `failed` |
 */

import { AWAITING_STAGE } from "@/features/results/aiSearch/debug/awaiting.ts";
import { BATCH_READ_STAGE } from "@/features/results/aiSearch/debug/batchRead.ts";
import { BROWSER_STAGE } from "@/features/results/aiSearch/debug/browser.ts";
import { BROWSER_OPS_STAGE } from "@/features/results/aiSearch/debug/browserOps.ts";
import { DECK_STAGE } from "@/features/results/aiSearch/debug/deck.ts";
import { DONE_STAGE } from "@/features/results/aiSearch/debug/done.ts";
import { FAILED_STAGE } from "@/features/results/aiSearch/debug/failed.ts";
import { LONGTEXT_STAGE } from "@/features/results/aiSearch/debug/longtext.ts";
import { MODEL_FLIP_STAGE } from "@/features/results/aiSearch/debug/modelFlip.ts";
import { PAID_STAGE } from "@/features/results/aiSearch/debug/paid.ts";
import { PANORAMA_STAGE } from "@/features/results/aiSearch/debug/panorama.ts";
import { REPORT_STAGE } from "@/features/results/aiSearch/debug/report.ts";
import { SEARCH_STAGE } from "@/features/results/aiSearch/debug/search.ts";
import { SHAPE_FLIP_STAGE } from "@/features/results/aiSearch/debug/shapeFlip.ts";
import { STEER_STAGE } from "@/features/results/aiSearch/debug/steer.ts";
import { STOPPED_STAGE } from "@/features/results/aiSearch/debug/stopped.ts";
import { SUB_STAGE } from "@/features/results/aiSearch/debug/sub.ts";
import { SUB_PENDING_STAGE } from "@/features/results/aiSearch/debug/subPending.ts";
import { TOOLS_STAGE } from "@/features/results/aiSearch/debug/tools.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

export const DEBUG_SCENARIOS: DebugScenario[] = [
  REPORT_STAGE,
  SEARCH_STAGE,
  TOOLS_STAGE,
  BATCH_READ_STAGE,
  BROWSER_OPS_STAGE,
  BROWSER_STAGE,
  DECK_STAGE,
  SHAPE_FLIP_STAGE,
  MODEL_FLIP_STAGE,
  PANORAMA_STAGE,
  STEER_STAGE,
  SUB_STAGE,
  SUB_PENDING_STAGE,
  PAID_STAGE,
  AWAITING_STAGE,
  LONGTEXT_STAGE,
  DONE_STAGE,
  STOPPED_STAGE,
  FAILED_STAGE,
];
