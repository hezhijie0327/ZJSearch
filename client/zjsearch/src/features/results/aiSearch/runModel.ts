// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiSearchGallery } from "@/features/aiAnswer/aiOverview.ts";
import type { LedgerFact, LedgerGap, LedgerPlanRow } from "@/features/results/aiSearch/ledger.ts";

export type AiSearchMode = "speed" | "balanced" | "overview" | "deep" | "report" | "deck";
/** "report" is a UI-level depth: it POSTs `mode: "deep"` + `report: true`
    (the server's output-shape flag) -- the wire itself only knows the
    three research depths plus the report flag. */

/** The run's macro stages (the wire's ``phase`` events -- Qwen Deep
    Research's spine): one value active at a time, the history kept for
    the run_summary record. */
export type AiSearchStage = "ideate" | "plan" | "research" | "write";
/** "awaiting": the clarify gate asked for the user's direction -- the run
    lives on until they answer (or skip) via submitClarify. */
export type AiSearchPhase = "idle" | "streaming" | "awaiting" | "done" | "error";

/** One user-attached image on a run (the composer's paperclip): METADATA
    only in the event log / fold -- the bytes live in the browser's
    attachment table and are filled in by the resume path (`data`). */
import type { AiSearchAttachment } from "@/lib/aicontracts.ts";

export type { AiSearchAttachment };

export interface AiAskQuestion {
  q: string;
  type: "single" | "multi";
  options: string[];
}

/** One tool the search_tools discovery matched (the settlement's
    structured ``tools`` payload): the row's expanded body renders these
    as cards -- name + source, the description line, the parameter names
    and the tool's own doctrine in a reading pane.  Absent for no-match
    and pre-tools replays (the raw feed text still rides `feed`). */
export interface AiToolMatch {
  name: string;
  /** "" = one of OUR tools; otherwise the MCP server's name */
  server: string;
  description: string;
  params: string[];
  required: string[];
  instructions: string;
}

/** list_engines's STRUCTURED listing (the settlement's inventory payload):
    the expanded body renders it as category chips + bang rows; absent on
    pre-inventory replays, whose preview text still rides `text`. */
export interface AiEngineInventory {
  total: number;
  categories: Array<{ name: string; count: number }>;
  disabled: Array<{ name: string; bang: string; cats: string[]; paid?: boolean }>;
}

/** calendar rows: the traditional almanac (the huangli fields) --
    display-ready Chinese terms (the proper nouns ARE the data); the
    row renders them as labeled chip rows inside the value card. */
export interface AiCalendarAlmanac {
  suited: string[];
  avoided: string[];
  gods: string[];
  avoid_gods: string[];
  officer: string;
  ecliptic: string;
  duty_god: string;
  mansions: string;
  east_star: string;
  nayin: string;
  pengzu: string;
  directions: string[];
  fetus_god: string;
  moon: string;
}

/** one auspicious-day scan hit (the find mode) */
export interface AiCalendarFinding {
  date: string;
  days_from_today: number;
  weekday: string;
  suited: string[];
  festivals: string[];
  term: string;
}

/** calendar rows: the lunar-calendar block (cnlunar + the statutory
    table) -- display-ready Chinese terms (the proper nouns ARE the
    data); the statutory workday verdict is omitted outside the
    announced coverage.  The almanac block rides for the MODEL's
    answers; the row renders the date line + term/festival/workday
    chips only. */
export interface AiCalendarLunar {
  year: string;
  year_cn: string;
  zodiac: string;
  month: string;
  day: string;
  leap: boolean;
  season: string;
  ganzhi: { year: string; month: string; day: string };
  term: string;
  next_term: { name: string; date: string };
  festivals: string[];
  solar_holidays: string[];
  folk: string[];
  /** the statutory verdict; `status: null` = the date sits outside the
      data's announced coverage (coverage_until names the boundary) */
  workday: {
    status: "off" | "workday" | "makeup" | null;
    name: string | null;
    coverage_until: string;
  } | null;
  almanac: AiCalendarAlmanac;
}

/** calendar rows: the composite time/date payload (the settlement's
    structured answer) -- `mode` discriminates the two shapes: `now`
    carries the instant fields, `date` the calendar lookup's.  `weekday`
    is the zone ground (TODAY's fixed English name) in every mode; the
    date mode's TARGET weekday rides `target_weekday`.  The row renders
    weekdays localized off the ISO date, so both are fallbacks only. */
export interface AiCalendarPayload {
  mode: "now" | "date" | "find" | "terms";
  timezone: string | null;
  today: string;
  weekday: string;
  utc_offset: string | null;
  /** now mode */
  time?: string;
  utc?: string | null;
  unix?: number | null;
  /** date mode */
  target?: string;
  /** the target's fixed English weekday (date mode only) */
  target_weekday?: string;
  iso_week?: number;
  days_from_today?: number;
  relation?: "past" | "today" | "future";
  /** the lunar block; null/absent outside the engine's coverage */
  lunar?: AiCalendarLunar | null;
  /** find mode: the auspicious-day scan */
  activity?: string;
  scanned_days?: number;
  findings?: AiCalendarFinding[];
  /** terms mode: the almanac's full activity vocabulary */
  terms?: string[];
}

export interface AiSearchCall {
  /** 1-based position of the call within its round */
  id: number;
  /** which tool produced the row */
  tool:
    | "search_web"
    | "calculate"
    | "clock"
    | "calendar"
    | "mcp"
    | "memory"
    | "recall_history"
    | "list_engines"
    | "update_plan"
    | "record_findings"
    | "evaluate"
    | "ask_user"
    | "build_table"
    | "inspect_image"
    | "browse"
    | "delegate_research"
    | "message_subtask"
    | "set_deliverable";
  /** mcp rows: the server-scoped tool label (without the namespace);
      memory rows: "save" | "search" | "update" | "forget" | "reinforce" */
  name?: string;
  label?: string;
  /** search_web: the keyword query; browse rows leave it empty */
  q: string;
  /** browse read: the page url (the row's label) */
  url?: string;
  category: string;
  status: "pending" | "ok" | "error" | "interrupted" | "duplicate" | "approval";
  /** search_web: result count */
  n?: number;
  /** browse read: characters of readable content returned */
  chars?: number;
  /** browse rows: the page state the action left the session on --
      the row's expansion renders it as the location line */
  page?: { url: string; title: string };
  /** browse rows: the frame jpeg (data URL) the action captured --
      the screenshot's deliberate shot, the others' mirror frame.  The
      shot PERSISTS (wire mark shot:true, kept by the stream consumer);
      mirror frames are stripped before the event log -- a replay keeps
      the shot, the trail shows the honest placeholder */
  img?: string;
  /** wire mark: this settlement's img is a deliberate SCREENSHOT (the
      bytes persist in the event log) -- mirror frames ride img too but
      never carry the mark, so multi rows can render the shot without
      flashing a volatile frame */
  shot?: boolean;
  /** browse rows: the fresh element outline (open / snapshot / a
      click-through navigation) -- the expansion renders the session's
      interactive-element list */
  snapshot?: string;
  /** browse tab rows: the session's tab strip (index / url / title /
      active) -- the expansion renders the mirror tab strip's chips */
  tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
  /** browse multi rows: the batch's per-step summaries (action / status /
      label / url / chars) -- the expansion renders each step's DETAIL,
      not the feed's bare first lines.  A read step carries `text` (the
      clean title+body document): its step row opens the same reading
      pane a standalone read does.  A MULTI-INDEX read instead carries
      `sections` -- one {url,title,chars,text} document PER TAB (the
      joined feed stays the model's; the timeline renders one pane per
      tab instead of filing every tab's body under the last tab's
      identity).  The tabs that FAILED beside the read ones ride `errors`
      -- one {index, url, error} PER FAILED TAB: the step shows them as
      alert rows, a failed tab never silently vanishes from the batch. */
  steps?: Array<{
    action: string;
    status: string;
    label: string;
    url?: string;
    title?: string;
    chars?: number;
    text?: string;
    sections?: Array<{ url: string; title: string; chars?: number; text: string }>;
    errors?: Array<{ index: string; url: string; error: string }>;
  }>;
  /** calendar: the composite time/date payload -- the row's expansion
      renders the instant (time / weekday / zone / UTC / unix) or the
      calendar lookup (target / weekday / ISO week / relation) */
  calendar?: AiCalendarPayload;
  /** calculate: the exact evaluated result (the row shows expr = result) */
  result?: string;
  /** evaluate: the STRUCTURED verdict (question name -> choice/score/noul
      answer with its probability distribution) -- the row's expansion
      renders the same probability bars as the rail's decision card */
  answers?: Record<string, unknown>;
  /** list_engines: the structured deployment listing -- the row's
      expansion renders category chips + cap-expandable bang rows */
  inventory?: AiEngineInventory;
  /** search_tools rows: the matched tools (structured); absent on
      no-match and legacy replays */
  tools?: AiToolMatch[];
  /** the tool's FULL raw response text (exactly what the executor fed
      back to the model, uncapped) -- the debug pane's RAW-RESPONSE pane; absent
      on legacy replays that predate the raw channel (their 800-char
      feed head still renders) */
  raw?: string;
  /** browse read: the extracted page content -- the row's expansion is a
      READING PANE of what the model actually read, not a link card */
  text?: string;
  /** the model's RAW tool-call arguments (q / category / ...) -- the
      timeline row's debug expansion shows exactly what was passed */
  args?: Record<string, unknown>;
  /** the model's RECEIPT: the head (800 chars) of the exact tool-result
      text the executor put in the round's feeds -- the debug expansion's
      second pane (empty dropped) */
  feed?: string;
  /** the call's wall time in milliseconds (the executor's settlement:
      pooled calls time submit -> settlement, inline branches time
      themselves) */
  ms?: number;
  /** search_web: a RE-search whose hits were all already-numbered
      produced no new sources -- these are the KNOWN [n]s the row's
      result strip resolves against the run's registry, so the row still
      expands to what it found */
  dupes?: number[];
}

/** One chronological segment of a run's research timeline, mirroring one
    server-side ENTRY (framework/loop.py): a research entry renders as its
    think segment, its intent narration and its call rows; the clarify
    round-trip seeds a "clarify" step.  (The stored-legacy "plan" step kind
    of the pre-wire-v2 threads was dropped with the threads' own era --
    those rows simply no longer render.) */
export type AiSearchStep =
  | { kind: "think"; text: string; entry?: number }
  | { kind: "intent"; text: string; entry?: number }
  | { kind: "clarify"; pairs: Array<{ q: string; a: string }> }
  | {
      kind: "steer";
      /** the user's steered course correction (the quoted-steer line) */
      text: string;
      /** guide = injected at the round boundary; preempt = interrupted
          the in-flight turn and injected immediately */
      delivery: "guide" | "preempt";
      /** discarded = the write phase had already closed the guide lane
          (the composer's pending chip flips to not-sent) */
      status: "drained" | "discarded";
    }
  | {
      /** the research conversation was compacted at the round boundary
          (micro = old page-read bodies cleared locally; auto/reactive =
          an LLM summary + the authoritative state block re-injected as
          a <compacted_context> user message) */
      kind: "compact";
      trigger: "micro" | "auto" | "reactive";
      /** token estimates before/after */
      pre: number;
      post: number;
      /** rounds summarized / preserved verbatim (micro: 0) */
      summarized: number;
      kept: number;
    }
  | {
      kind: "sub";
      /** the subagent's OWN entry-id space (base 10000, disjoint from
          the lead's counter) -- think/call events route into `inner`
          by it */
      entry: number;
      /** the delegation's stable key (S1, S2, ...) -- the result-strip
          join's agent key: a sub row resolves ONLY its own agent's
          registry slice (round/callId pairs collide across agents) */
      agent?: string;
      title: string;
      objective: string;
      status: "active" | "done";
      inner: AiSearchStep[];
    }
  | { kind: "calls"; entry?: number; round: number; calls: AiSearchCall[] };

export interface AiSearchSource {
  /** global [n] citation number (contiguous from 1) */
  n: number;
  runNo: number;
  round: number;
  callId: number;
  /** the minting agent's key ("lead" or S1/S2/...) -- the row join's
      fallback discriminator (absent = old replay, reads as "lead") */
  agent?: string;
  /** the PRODUCING batch's address -- the turn entry id the executor's
      events are stamped with (the delegation pump offsets a child's by
      its pass base).  The row join's PRIMARY key: exact for every
      agent and every pass; the (agent, round, callId) triple below is
      the fallback for replays predating the stamp */
  turn?: number;
  title: string;
  url: string;
  netloc: string;
  favicon: string;
  /** result thumbnail (the classic presentations' img_src) -- the rail
      card pins it to the row end like the infobox-side cards do */
  img?: string;
  /** the result's search category -- the hook for type-aware cards
      (video duration, torrent filesize, ... the classic presentations) */
  category?: string;
  /** browse read this page in full (the card's read-in-full badge) */
  crawled?: boolean;
  /** the browser MINT -- this [n] was DRIVEN (open / read / a click
      navigation / a popup), not searched: the source card wears the
      agent mark instead of the favicon-glyph fallback */
  browser?: boolean;
  /** the result's snippet from the SearXNG result payload -- the source's
      knowledge-projection body (uncrawled sources stay searchable) */
  content?: string;
  /** recalled from the browser's research memory (the writer-phase
      injection) -- the card's history badge; NOT re-verified this run */
  history?: boolean;
  /** how many PAST runs referenced this url (the cross-session badge;
      0/undefined = new to the corpus) */
  pastRefs?: number;
  /** the engines that reported this result + the relevance score -- the
      card's engines row (the traditional result card's footer) */
  engines?: string[];
  score?: number;
  /** the type-aware meta (video duration / torrent filesize -- the
      classic presentations' tile badge) */
  meta?: string;
}

export interface AiSearchRun {
  runNo: number;
  q: string;
  status: "streaming" | "awaiting" | "done" | "error";
  error: string | null;
  /** the run's research timeline in the model's own order */
  steps: AiSearchStep[];
  /** settled synthesis of this run */
  answer: string;
  /** the [n] sources THIS run found (numbering continues across runs) */
  sources: AiSearchSource[];
  /** inline image groups the writer embedded, in fence order -- the
      answer's `{{zjs-gallery:i}}` placeholders index into this array */
  galleries: AiSearchGallery[][];
  /** the zero-research run: the writer answered directly (the research
      box stays empty) */
  direct?: boolean;
  /** follow-up question suggestions generated for this answer */
  related: string[];
  /** the clarify gate's questions while the run waits for the user's
      direction (status "awaiting") */
  ask: { intro: string; questions: AiAskQuestion[] } | null;
  /** the user's answer text after submitClarify ("" = skipped) */
  clarify: string | undefined;
  /** the write phase opened (the write line covers its silence) */
  wrappingUp: boolean;
  /** client clock when the run's RESEARCH began (reset on clarify
      submit -- the question wait is not research time) */
  startedAt: number;
  /** client clock when the run settled (research duration display) */
  endedAt: number | null;
  /** the depth this run RAN with -- the pill displays it (the truthful
      last-run value), picking a new depth affects the next run */
  mode: AiSearchMode;
  /** the run's BIRTH format (the mode at creation / at the last
      clarify-restart): the direct-answer steer folds `mode` back to the
      birth PLAIN depth (report/deck are formats on the deep tier -- the
      fold strips the format, the tier stands; the model's settled
      set_deliverable row folds it forward, the reader's withdrawal
      folds it back -- both replay-stable) */
  mode0: AiSearchMode;
  /** the user pressed stop: a settled run without an answer is then
      intentional, not a failure (the failed box must not fire) */
  stopped?: boolean;
  /** the transports' finish reason of the run's LAST turn ("stop" |
      "length" | "content_filter" | ... -- the writer's, when a writer
      phase ran); null while unknown */
  finish?: string | null;
  /** the model id the API RESPONSE reported (what the endpoint actually
      ran, not what we asked for); null when the stream carries none */
  model?: string | null;
  /** token usage summed across the run's turns (null = the endpoint
      reported nothing); cached/cache_write are the prompt-cache hit and
      write counts (0 when the endpoint does not break them out);
      research/write/gates are the PER-PHASE split -- the whole flow,
      nothing dark matter */
  usage?: {
    input: number;
    output: number;
    thoughts: number | null;
    cached: number;
    cache_write: number;
    research?: { input: number; output: number } | null;
    write?: { input: number; output: number } | null;
    gates?: { input: number; output: number; calls: number } | null;
    rerank?: { calls: number; tokens: number };
    decision?: { calls: number; tokens: number };
    embedding?: { calls: number; tokens: number };
  } | null;
  /** the server's halt explanation carried on settle (stall verdict,
      truncation, transport cut) -- the meta row renders it */
  halt?: string | null;
  /** the machine key naming WHY a guard ended the research early
      (stalled | time_budget | round_budget | loop_detected) -- the
      meta row renders its i18n label; null when the run ended on its
      own */
  haltReason?: string | null;
  /** the WRITER's own thread title (the related fence's title field, or
      the settle-tail's generated fallback) -- the thread_head projection
      adopts it unless the user renamed manually */
  title?: string;
  /** the extractor's concept tags (the LATE `tags` wire event) -- the
      settle writes them into the knowledge projections */
  tags?: string[];
  /** the living task list (the update_plan tool maintains it; the task
      card renders it) -- empty for modes that do not decompose */
  plan: LedgerPlanRow[];
  /** the BELIEF LEDGER's facts (the findings tool's authoritative
      snapshots): what the researcher recorded as established, WITH the
      revision history (superseded/retracted stay visible on the card) --
      the writer received the active list as <findings> */
  findings?: LedgerFact[];
  /** the ledger's gaps partition: the open questions the research still
      owed -- the findings card renders them under the facts */
  gaps?: LedgerGap[];
  /** the macro stage the run is in right now (the wire's ``phase``
      events) -- the PhaseStrip renders it; undefined = no phase events
      (legacy threads) and the strip stays hidden */
  stage?: AiSearchStage;
  /** every stage the run walked, in order -- the run_summary record */
  stages: AiSearchStage[];
  /** the run's DECISION RESULTS (framework gates + model evaluate), one
      entry per decision call -- the rail's decisions card renders them
      with click-through raw answers */
  decisions: AiDecision[];
  /** the user's attached images for THIS question (metadata; `data`
      filled live / by the resume's attachment-table join) */
  attachments?: AiSearchAttachment[];
  /** the REPORT mode's document skeleton (the wire's ``outline``
      snapshot): absent = the single-write answer shape */
  outline?: AiSearchOutline;
  /** the outline-driven run's SLIDE shape (the ``outline`` snapshot's
      ``shape: "deck"``): the document renders as a slide deck instead of
      the report document */
  deck?: boolean;
  /** the report's per-section markdown buffers (the ``section`` deltas,
      keyed by section id -- the document renders them in outline order) */
  sections?: Record<string, string>;
  /** the per-section REASONING buffers (the think-marked ``section``
      deltas): the writer relays each section's working so its pane never
      sits silent, and the document keeps it as the section's retained
      thinking disclosure (folded once the section settles) */
  sectionThink?: Record<string, string>;
  /** the recorded data tables (the ``artifact`` events, keyed by id) */
  artifacts?: Record<number, AiSearchArtifact>;
  /** the interactive session's live mirror (the browse call's
      viewport frames -- img stripped before persisting; null = no
      session or the run replays).  THE LEAD session's frame.  px/py/pk
      = the MODEL POINTER: the viewport-space landing point of the last
      ref-targeted action and its kind (the drawn cursor + click
      ripple). */
  browser: {
    url: string;
    title: string;
    img: string;
    w: number;
    h: number;
    waitLeft?: number;
    px?: number;
    py?: number;
    pk?: string;
    /** the LAST action's visual mark: the touched element's viewport bbox
        [x, y, w, h], the drag endpoint, and the element's OWN name (the
        server ships the vocabulary; the client composes the i18n'd verb
        -- the mirror renders the box + gesture + label so the viewer
        sees WHAT the model did, not just where its cursor rests) */
    box?: number[];
    x2?: number;
    y2?: number;
    name?: string;
    /** the session's IN-SESSION tab strip (index/url/title/active) --
        the rail card renders it when the session holds more than one
        page, and a background tab's peek frame replaces the view
        locally until the model's next frame */
    tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
  } | null;
  /** ALL live browser sessions keyed by session id (v2.1 R3B: the lead
      plus one per delegating subagent -- the rail card's tab strip).
      The lead also rides ``browser`` (the takeover's auto-open watch
      and the old render path). */
  browserSessions?: Record<
    string,
    {
      url: string;
      title: string;
      img: string;
      w: number;
      h: number;
      waitLeft?: number;
      px?: number;
      py?: number;
      pk?: string;
      box?: number[];
      x2?: number;
      y2?: number;
      name?: string;
    }
  >;
}

/** The REPORT mode's outline snapshot (the wire's ``outline`` event): the
    document's TOC -- every section's status rides the same snapshot.
    ``failed`` marks a section whose stream died (the gap placeholder
    shipped).  New runs never carry one (the document is a single
    write); the shape survives for stored records' replays. */
interface AiSearchOutlineSection {
  id: string;
  title: string;
  brief?: string;
  status: "pending" | "writing" | "done" | "failed";
}

export interface AiSearchOutline {
  title: string;
  subtitle?: string;
  /** the template the structure was written to (the wire's ``template``
      name, stamped by the server's template gates) -- the output-structure
      card's
      identity face names it once the pick lane closes; undefined = the
      free auto-designed structure (the smart-report / smart-deck picks) */
  template?: string;
  sections: AiSearchOutlineSection[];
}

/** One recorded data table (the ``build_table`` tool's ``artifact``
    event, snapshot-replace per id): the researcher's structured
    evidence with per-row [n] refs resolved against the run's sources. */
export interface AiSearchArtifact {
  id: number;
  title: string;
  columns: string[];
  rows: Array<{ cells: string[]; refs: number[] }>;
  note?: string;
}

/** One decision-model call (loop gates or the model's evaluate tool): the
    question asked, the target it was about, and the RAW answer
    (verdicts + probabilities) for click-through. */
export interface AiDecision {
  purpose: string;
  question?: string;
  target?: string;
  answer?: unknown;
  ms?: number;
  /** the wire entry verbatim (structured renderers read purpose-specific
      fields off it -- verdicts/citations/counts) */
  record?: Record<string, unknown>;
  /** the name→question-text map the generic verdict renderer labels rows
      with
      (server judgments carry it beside `answers`) */
  record_questions?: Array<{ name?: unknown; instructions?: unknown }>;
}

/** The fold's state: the threaded runs plus the thread-wide surfaces
    (phase, flat [n] registry, conversation identity). */
export interface Core {
  phase: AiSearchPhase;
  runs: AiSearchRun[];
  /** the flat [n] registry across the thread (citation jumps, follow-up
      numbering base) */
  sources: AiSearchSource[];
  error: string | null;
  threadId: string;
}

/** Entries as step indices: think/say/calls events route by entry id. */
export type EntryIndex = { think?: number; intent?: number; calls?: number };

/** The wire's LATE_EVENTS: they trail the settle on purpose and must
    still fold on a settled phase -- the fallback suggestions render
    live, memory saves persist, tags/usage park on the run.  The
    SECTION REWRITE tail (outline + section) joins them: a settled
    report's failed section re-streams through the same events, and the
    fold must accept the replacement (the seq guard dedups it against
    any concurrent attach replay). */
