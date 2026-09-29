# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
# pylint: disable=too-many-lines
"""zjsearch theme: AI Search -- the model drives the keyword searches.

The tool-calling feature on the shared agent framework
(:py:mod:`searx.zjsearch.ai.agent`), in Vane's RESEARCHER/WRITER shape:
a research agent analyses the question, writes a one-line intent, then
issues ``web_search`` calls that run as REAL instance searches -- the
same ``SearchWithPlugins`` path the results page uses, plugins included
-- in parallel worker threads.  A second tool, ``web_crawler``, reads
one result's page in full through the self-hosted Browserless browser
(:py:mod:`searx.zjsearch.ai.browserless`) when a snippet promises
exactly the missing detail.  When the research ends, a FRESH WRITER
completion -- never the researcher -- writes the cited answer from the
accumulated source feed, so the answer's shape and voice are the same
no matter how the research went (the researcher's prose is structurally
unable to leak into the answer).  Each search's
results are serialized through the very ``_result_data`` macro the
page-data uses, so the client renders sub-results with its standard
components; both sides consume a compacted, globally numbered ``[n]``
feed of the same sources; the writer emits the cited answer (the AI
Overview renderer contract: ``[n]`` chips, GFM, think block).

Wire protocol (NDJSON, one JSON object per line; the stream never ends
silently):

- ``{"e": "think", "t"}`` / ``{"e": "delta", "t"}`` -- reasoning and prose
  deltas of the current phase (research turns' prose becomes the next
  event's intent; the writer's deltas are the answer);
- ``{"e": "calls", "round", "intent", "items": [{id, tool, q/url, ...}]}``
  -- a parallel batch announced (the model decides the batch size;
  ``tool`` discriminates ``web_search`` rows from ``web_crawler`` rows);
- ``{"e": "search", "round", "id", "status", "n", "ms"}`` -- one search
  finished (ok / error / duplicate);
- ``{"e": "page", "round", "id", "status", "url", "title", "chars",
  "ms", "text"}`` -- one ``web_crawler`` read finished (ok / error /
  duplicate); a successful read carries the extracted content, and the
  client's row expands into a reading pane of it;
- ``{"e": "results", "round", "id", "results"}`` -- page-data-shaped
  result list of that search;
- ``{"e": "sources", "items": [{n, round, id, idx, ...}]}`` -- the global
  ``[n]`` registry entries (citation chips jump to ``round``/``id``/``idx``);
- ``{"e": "direct"}`` -- the pre-flight gate judged the request a
  no-research task (greeting, writing task): the writer answers directly,
  no research follows;
- ``{"e": "gallery", "items": [{u, n}]}`` -- the writer embedded an inline
  image group (the ``zjs-images`` fence, URLs validated against the run's
  image registry); the answer text carries a ``{{zjs-gallery:i}}``
  placeholder at the position;
- ``{"e": "wrapup"}`` -- the research phase ended: the WRITER completion
  takes over (the client drops any streamed research prose and shows the
  synthesizing state; the writer's deltas are the answer);
- ``{"e": "ask", "intro", "questions": [{q, type, options}]}`` -- the
  clarify gate wants the user's direction BEFORE researching; the run
  settles as ``awaiting`` (``{"e": "end"}`` follows; the answers travel
  on the next request as ``clarifications``);
- ``{"e": "related", "items": [...]}`` -- follow-up suggestions.  The
  writer emits them IN-STREAM as a `` ```related `` fence at the end of
  the answer (Morphic's in-stream related: zero extra completions) -- the
  fence is intercepted server-side and never reaches the client's answer
  text; when the fence is missing, the post-``end`` small completion
  generates them as before;
- ``{"e": "error", "reason"}`` mid-stream, ``{"e": "end"}`` closes.

A stream that dies before its first line answers 502 with a truncated
upstream reason (same contract as the AI Overview).  Configuration: the
transport is the shared ``zjsearch.ai`` block; this feature ships
enabled and opts out via ``zjsearch.ai.search.enabled: false`` (the AI
Overview mirrors that under ``zjsearch.ai.overview.enabled``).
"""

import concurrent.futures
import importlib.util
import itertools
import json
import logging
import re
import time
import typing as t
from html import escape
from urllib.parse import urlsplit

import flask

from searx.extended_types import sxng_request
from searx.search import SearchWithPlugins
from searx.webadapter import get_search_query_from_webapp
from searx.webutils import highlight_content
from searx.zjsearch.ai import agent, browserless, llm, prompts

logger = logging.getLogger(__name__)

TOOL_NAME = "web_search"

PAGE_TOOL = "web_crawler"

SEARCH_CATEGORIES = ("general", "news", "images", "videos", "it", "science", "files", "music")
"""The verticals the model may pick; each has a dedicated client layout."""

MAX_PARALLEL = 3
"""Worker threads per parallel batch -- uncapped per-round call counts
(the model's call) queue behind these few slots so a chatty round cannot
stampede the instance.  Every queued search gets to run; each engine
request carries its own per-request timeout, which is what bounds a
batch -- no artificial wall clock."""

RESULTS_CAP = 30
"""Results per search sent to the client (the model only sees the feed)."""

FEED_DEEP = 5
FEED_SHALLOW = 5
FEED_SNIPPET_CHARS = 300
"""The model's compacted view of one search: 5 deep (title + snippet
head) + 5 shallow (title only), numbered with the global [n] registry."""


SEARCH_MODES = ("speed", "balanced", "quality", "goal")

_MODE_BUDGETS: dict[str, dict[str, int]] = {
    # speed: ONE focused round (Morphic's quick discipline); balanced: main
    # facets, optional gap-filler; quality: multi-round deep research with
    # cross-verification; goal: the question is a target -- iterate in
    # self-checked rounds until the goal is demonstrably met.
    # max_rounds is a SAFETY ceiling, not the plan; the plan is PROGRESS:
    # a round that adds no new information (only repeats or empty results)
    # is stalled, and stall_rounds consecutive stalled rounds end the
    # research.  Per-round call counts are the MODEL's call (uncapped);
    # every engine request carries its own per-request timeout.
    "speed": {"max_rounds": 1, "stall_rounds": 1},
    "balanced": {"max_rounds": 4, "stall_rounds": 2},
    "quality": {"max_rounds": 8, "stall_rounds": 2},
    "goal": {"max_rounds": 16, "stall_rounds": 3},
}

_BUDGET_NOTE = "The research budget ended the gathering early -- the sources above are everything that was found."

_STALL_NOTE = (
    "The research went STALE and ended early: the latest rounds only repeated"
    " earlier queries or returned nothing new.  Where the sources are silent,"
    " answer from common knowledge marked with [*] -- never present a gap as"
    " a sourced fact."
)

_WRITER_CONTEXT_MAX = 40_000
"""Hard cap on the source feed the writer receives (deep research with
page reads lands around 15-25k; the cap only guards abuse).  Over the cap
whole OLDEST feed blocks are evicted first -- a silently cut tail block
(the old hard slice) could drop a source the model was about to cite."""

_FEED_SOFT_LIMIT = 24_000
"""Accumulated feed size at which the executor tells the model to start
converging -- the context-pressure signal reaches the MODEL (with the
round's tool results) instead of only shaping the writer's input."""

_GALLERY_POOL_MAX = 40
"""Image URLs the writer may embed (the validated whitelist of the
``zjs-images`` fence): image-bearing results enter the pool as they are
fed, first come first kept."""

_URL_RE = re.compile(r"https?://[^\s<>\"']+")

_CLARIFY_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {
        "ask": {"type": "boolean"},
        "intro": {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "q": {"type": "string"},
                    "type": {"type": "string", "enum": ["single", "multi"]},
                    "options": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["q", "type", "options"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["ask", "intro", "questions"],
    "additionalProperties": False,
}

_RELATED_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["questions"],
    "additionalProperties": False,
}

_STANDALONE_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"question": {"type": "string"}},
    "required": ["question"],
    "additionalProperties": False,
}

_RESEARCH_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "properties": {"research": {"type": "boolean"}},
    "required": ["research"],
    "additionalProperties": False,
}

_CLARIFY_MODES = ("quality", "goal")

ASK_TOOL = "ask_user"

PLAN_TOOL = "plan"
_PLAN_MODES = ("quality", "goal")
"""The tiers whose structured \"##\"-section answers are worth a planning
turn: the plan tool is registered only here (speed's one dense paragraph
and balanced's short prose never need it)."""


def _plan_spec() -> dict[str, t.Any]:
    """The answer-planning tool (Vane's reasoning preamble, adapted): the
    model's deliberation about the SHAPE of its final answer goes HERE --
    the user sees it as a research step -- instead of leaking into the
    answer text (the wrapped-up model's "Excellent, [n] is useful..."
    monologue was exactly that leak)."""
    return {
        "name": PLAN_TOOL,
        "description": (
            "State how you will structure your final answer BEFORE writing"
            " it.  Call this ONCE, as the ONLY call of its turn, when you"
            " catch yourself deliberating about the answer -- triaging"
            " sources, weighing what belongs where, drafting section"
            " outlines: put THAT thinking here instead of your reply.  The"
            " plan is shown to the user as your research step; your NEXT"
            " message must be the finished answer itself, opening with the"
            " conclusion -- no meta commentary, no restating of the plan."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "plan": {
                    "type": "string",
                    "description": "1-4 sentences: the sections and shape of the answer you are about to write.",
                },
            },
            "required": ["plan"],
        },
    }


def _ask_user_spec() -> dict[str, t.Any]:
    """The mid-research human-in-the-loop tool: the model may stop and ask
    when it realizes -- only research can reveal this -- that the request
    is genuinely ambiguous (an acronym naming several unrelated products,
    a code that is also a model name, ...).  The run ends with the
    questions; the answers travel back as ``clarifications``."""
    return {
        "name": ASK_TOOL,
        "description": (
            "Stop researching and ask the user to disambiguate the request."
            "  Call this ONCE, as the ONLY call of its turn, when you realize"
            " the request is genuinely ambiguous: an acronym, code or short"
            " name that matches several unrelated products/domains, where"
            " guessing wrong wastes the whole run.  Do NOT use it for broad"
            " informational topics (cover their facets instead) and do not"
            " use it after the user already confirmed a direction."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intro": {"type": "string", "description": "One sentence on why you ask."},
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string", "description": "The question to the user."},
                            "type": {
                                "type": "string",
                                "enum": ["single", "multi"],
                                "description": "single = pick one option; multi = pick any.",
                            },
                            "options": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "2-4 short concrete answers to choose from.",
                            },
                        },
                        "required": ["q", "type", "options"],
                    },
                    "description": "At most 3 questions.",
                },
            },
            "required": ["questions"],
        },
    }


def _sanitize_questions(raw_items: t.Any) -> list[dict[str, t.Any]]:
    """The wire shape of clarify questions: q + single/multi + 2-4 short
    options, capped at 3 questions -- shared by the clarify gate and the
    mid-run ask_user tool (untrusted model output on both paths)."""
    questions: list[dict[str, t.Any]] = []
    for raw in (raw_items or [])[:3]:
        if not isinstance(raw, dict) or not str(raw.get("q") or "").strip():
            continue
        options = [str(o).strip()[:80] for o in (raw.get("options") or []) if str(o).strip()][:4]
        questions.append(
            {
                "q": str(raw.get("q")).strip()[:200],
                "type": "multi" if str(raw.get("type") or "").strip() == "multi" else "single",
                "options": options,
            }
        )
    return questions


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.search`` settings block."""
    cfg = llm.ai_cfg().get("search")
    return cfg if isinstance(cfg, dict) else {}


def _enabled() -> bool:
    """The search feature flag: ``zjsearch.ai.search.enabled`` -- ``True``
    unless explicitly switched off."""
    return bool(_cfg().get("enabled", True))


def _budget(key: str, mode: str, default: int) -> int:
    """Budget for one run: an explicit ``zjsearch.ai.search.<key>`` setting
    wins, otherwise the mode's default, otherwise ``default``."""
    value = _cfg().get(key)
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    return _MODE_BUDGETS.get(mode, {}).get(key, default)


def capability() -> dict[str, str] | None:
    """The page-data ``ai_search`` payload (the shared token + model label);
    ``None`` when AI search is off or the transport is unconfigured -- the
    client hides its ``[classic|AI]`` mode switch then."""
    cfg = llm.ai_cfg()
    if not (_enabled() and llm.configured(cfg)):
        return None
    return {"tk": llm.issue_token(), "model": str(cfg.get("model"))}


def _int(key: str, default: int) -> int:
    try:
        return int(_cfg().get(key))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _tool_spec(with_pages: bool) -> dict[str, t.Any]:
    """The ``web_search`` tool in the dialect-neutral llm shape; with the
    page reader configured, the description cross-references it (a model
    that never sees ``web_crawler`` must not be told about it).  The
    ``included_sites``/``excluded_sites`` parameters carry the user's
    source preference (Morphic's domain filters): they are appended to the
    query as ``site:``/``-site:`` operators, which the engine's
    advanced_search_syntax plugin enforces AUTHORITATIVELY on every result
    regardless of engine support."""
    return {
        "name": TOOL_NAME,
        "description": (
            "Run one web search on the metasearch engine with specific keywords."
            " Search like a skilled human: short keyword sets (never full"
            " sentences), distinct facets of the question, alternative phrasings"
            " or translations when the wording is uncertain. Prefer several"
            " parallel calls over one broad query. Precision operators are"
            " applied authoritatively by the engine and are welcome when they"
            " sharpen the results: site: / -site:, filetype:, \"exact phrase\","
            " before:YYYY-MM-DD / after:YYYY-MM-DD. Optional filters"
            " (time_range) are not supported by every engine: when a filtered"
            " search comes back EMPTY, retry the same intent once without the"
            " filter before concluding. Never use bangs unless the user"
            " explicitly names an engine (then prefix the query, e.g. \"!baidu"
            " keywords\") -- a category search already fans out across every"
            " engine in that vertical. Results arrive as globally numbered [n]"
            " sources to cite in the final answer."
            + (
                "  When a result's snippet promises the exact missing detail,"
                f" the {PAGE_TOOL} tool can read that result's page in full."
                if with_pages
                else ""
            )
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The keyword query to search for."},
                "category": {
                    "type": "string",
                    "enum": list(SEARCH_CATEGORIES),
                    "description": (
                        "Optional vertical (images for visual context, news for"
                        " current events); general when unsure."
                    ),
                },
                "time_range": {
                    "type": "string",
                    "enum": list(_TIME_RANGES),
                    "description": (
                        "Optional freshness window -- use it when the question"
                        " is about recent material (news, releases, changelogs);"
                        " omit otherwise."
                    ),
                },
                "included_sites": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Bare domains to RESTRICT the search to (at most 3),"
                        " only when the user signals a source preference:"
                        ' "search reddit", "在 GitHub 上找" -> ["github.com"];'
                        ' "official sources" -> the relevant authoritative'
                        " domains.  Prefer this over stuffing the site name"
                        " into the keywords -- the filter is enforced exactly,"
                        " the keyword is not.  Do not invent restrictions for"
                        " ordinary queries.  If the filtered search comes"
                        " back thin, run one more without it."
                    ),
                },
                "excluded_sites": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Bare domains to EXCLUDE (at most 3), only when the"
                        ' user signals an aversion: "not pinterest" ->'
                        ' ["pinterest.com"].'
                    ),
                },
            },
            "required": ["query"],
        },
    }


def _page_spec() -> dict[str, t.Any]:
    """The ``web_crawler`` tool: one URL's current full content through the
    self-hosted Browserless browser.  Registered only when
    ``zjsearch.ai.browserless`` is configured (else the model never sees
    it).  The description carries the economy policy: reads are for
    snippets that promise exactly the missing detail, never a substitute
    for a search round."""
    return {
        "name": PAGE_TOOL,
        "description": (
            "Open ONE URL and read its current full page content, rendered in"
            " a real browser and returned as compact markdown.  Reach for it"
            " when a source's snippet promises exactly the detail you still"
            " need (specs, prices, tables, documentation, exact numbers) or"
            " when a load-bearing claim must be checked against its source --"
            " never as a substitute for searching.  This is a SINGLE-page"
            " reader, not a recursive crawl: one page per call, and to follow"
            " a link you open it in another explicit call.  Very long pages"
            " arrive truncated.  Failed or empty pages are dead ends: move on"
            " to a different source instead of retrying."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The absolute http(s) URL of the page to read."},
            },
            "required": ["url"],
        },
    }


_DEPTH_RESEARCH: dict[str, str] = {
    # The RESEARCHER's round policy per tier -- output shape lives in
    # _DEPTH_SHAPE and belongs to the WRITER (the researcher never writes
    # the answer, so the two halves are prompted separately).
    "speed": "Depth: SPEED -- the user mostly wants to know WHAT this is."
    "  You get ONE round: cover the core facet with 2-3 targeted searches,"
    " make them count, and stop after it.",
    "balanced": "Depth: BALANCED -- round out the main facets: what it is,"
    " how it works or why it matters, and whatever context the reader needs"
    " not to be misled.  One search round covers it; run a second only for a"
    " real gap.",
    "quality": "Depth: QUALITY -- thorough multi-round research across the"
    " angles the question actually needs: definition, mechanics, comparisons,"
    " recent developments, use cases, limitations or critiques, expert and"
    " community reception.  Cross-verify load-bearing claims against"
    " independent sources, but run only as many searches as the question"
    " needs.",
    "goal": "Depth: GOAL -- treat the question as a TARGET the user wants"
    " reached, not a casual question.  Work toward it iteratively: first"
    " state what evidence would demonstrate the goal is met, then search for"
    " it; after each round, explicitly check what is still missing and run"
    " further rounds until the goal is demonstrably achieved (verify"
    " load-bearing claims against independent sources).",
}

_DEPTH_SHAPE: dict[str, str] = {
    # The WRITER's output shape per tier -- the half of the old depth
    # prompt that describes the ANSWER, now prompted where the answer is
    # actually written.
    "speed": "Shape: ONE short dense paragraph -- name the subject (bold on"
    " first mention), define it in a sentence or two, add at most two or"
    " three key facts -- each cited.  NO headings, lists, tables or"
    " diagrams; if the subject is ambiguous, say which sense you picked in"
    " one clause.",
    "balanced": "Shape: short paragraphs with the key terms in **bold**; a"
    " bullet list or definition list when enumerating; a table only for a"
    " genuine 2-3 way comparison.  Keep it moderate.",
    "quality": "Shape: a thorough, structured answer in \"##\" sections --"
    " definitions, mechanics, comparisons, recent developments -- citing"
    " every major claim.",
    "goal": "Shape: structure the answer around the goal with \"##\""
    " sections, and close with a GFM task list (- [x] met / - [ ] open) as"
    " the evidence ledger -- every checked item cited.  If the research"
    " could not close an item, leave it unchecked and name the evidence"
    " that would.",
}


def _examples(page_tool: bool, plan_tool: bool) -> str:
    """The few-shot block, composed from the tools THIS run registered: an
    example demonstrating an unregistered tool teaches a call that lands
    as an ``error: empty query`` row (the plan tool rides quality/goal
    only, the page reader only when browserless is configured).  The last
    example shows the LATER-round intent shape: reflection on the results
    so far, not a restatement of the question."""
    plan_suffix = ', plan(plan="对比表：定位/性能/价格/生态，结论按使用场景给出")' if plan_tool else ""
    deepseek = 'Action: web_search(query="DeepSeek-V3 context length site:huggingface.co")'
    if page_tool:
        deepseek += ', then web_crawler(url="<the model card url>")'
    lines = [
        "<examples>",
        'User: "What is Kimi K2?"',
        'You: "The user wants to know what Kimi K2 is -- definition, key specs, release status."',
        'Action: web_search(query="Kimi K2 AI model"), web_search(query="Kimi K2 specs release date")',
        "",
        'User: "DeepSeek-V3 的上下文长度是多少？"',
        'You: "I need an exact number; snippets rarely carry it, the model card does."',
        deepseek,
        "",
        'User: "A 和 B 该选哪个？"',
        'You: "A comparison needs both sides covered before any verdict."',
        f'Action: web_search(query="A 优点 缺点"), web_search(query="B 优点 缺点"){plan_suffix}',
        "",
        "User (second round, after the first round's results):",
        'You: "[4] covers the official specs, but pricing is missing everywhere'
        ' -- this round targets reseller and review pages for current prices."',
        "</examples>",
    ]
    return "\n".join(lines)


def _initial_messages(  # pylint: disable=too-many-arguments, too-many-locals
    question: str,
    lang: str,
    history: list[dict[str, str]],
    sources_base: int,
    depth: str,
    max_rounds: int = 0,
    clarifications: str = "",
    clarify_skipped: bool = False,
    register_ask: bool = False,
    page_tool: bool = False,
    plan_tool: bool = False,
) -> list[dict[str, t.Any]]:
    """The RESEARCHER's conversation opener, in the XML block organisation
    (Vane's): ``<role>`` (research only -- a separate writer writes the
    answer), ``<today>``, ``<step_notes>`` language, ``<how_to_search>``,
    ``<examples>`` (few-shot), the tool-capability blocks
    (``<page_reader>``/``<answer_planning>``/``<ambiguity_escape>``),
    ``<depth>`` (the round policy half -- output shape belongs to the
    writer), ``<research_policy>`` and the clarify round-trip blocks.
    The SHARED answer contract (citations, markdown, grounding, voice)
    is the WRITER's -- the researcher never writes the answer, so the
    fragments are not repeated here."""
    role = (
        "<role>\nYou are the research agent of the zjsearch AI Search"
        " mode: the user asks a question, YOU decide which keyword searches"
        f" answer it and run them with the {TOOL_NAME} tool.  You NEVER"
        " write the final answer yourself: when the research is complete,"
        " simply stop calling tools -- a separate writer writes the answer"
        " from the sources you gathered (their [n] numbers travel with"
        " them).\n</role>"
    )
    follow_up = ""
    if sources_base:
        follow_up = (
            "<follow_up>\nThis is a follow-up in an ongoing research session:"
            f" sources [1]..[{sources_base}] were already found in earlier"
            " turns. Your new searches continue the numbering from"
            f" [{sources_base + 1}].  Unless the earlier sources already"
            " answer THIS follow-up completely, run at least one fresh"
            f" {TOOL_NAME} for its specifics.\n</follow_up>"
        )
    how_to_search = "\n".join(
        [
            "<how_to_search>",
            "- First write ONE short sentence.  On the FIRST round state how"
            " you read the question's intent (the UI shows it as the lead of"
            " your search plan); on LATER rounds reflect on the results so"
            " far -- name the gap they leave and the facet this round"
            " covers.  Then call"
            f" {TOOL_NAME} -- several calls in the same turn are encouraged:"
            " they run in parallel.",
            "- ALWAYS run at least one search per question facet -- even for"
            " topics you already know: the user expects live, cited sources,"
            " not your memory.",
            "- Optional filters (time_range) are not supported by every"
            " engine: when a filtered search comes back EMPTY, retry the"
            " same intent once without the filter before concluding there is"
            " nothing to find.",
            "- Never repeat a query you already ran; never use !bangs unless"
            " the user explicitly names an engine (then prefix the query"
            " with its engine bang, e.g. !baidu) -- without one, the"
            " category parameter already fans out across every engine in"
            " that vertical.",
            "- When the research is done, STOP: just end your turn without"
            " tool calls.  Do not draft the answer, do not summarize your"
            " findings in prose -- the writer has your sources and your"
            " plan.",
            "</how_to_search>",
        ]
    )
    page_reader = ""
    if page_tool:
        page_reader = (
            "<page_reader>\n"
            f"The {PAGE_TOOL} tool reads ONE url's current full content in a"
            " real browser and returns it as markdown: reach for it when a"
            " source's snippet promises exactly the missing detail (specs,"
            " prices, tables, documentation, exact numbers) or when a"
            " load-bearing claim deserves a first-hand check.  If the"
            " question contains an explicit URL and asks about that page"
            " (summarize it, read it, extract from it), open the page with"
            f" {PAGE_TOOL} FIRST -- do not search for what the page itself"
            " contains.  Open"
            " sparingly: only pages whose snippet already promises what you"
            " need -- never to \"see what is there\", never in place of a"
            " search round.  A failed or empty page is a dead end: search a"
            " different source instead of retrying it.  Opened content"
            " carries the source's [n] label -- the number it already had"
            " among your sources, or a fresh one appended for a url that was"
            " not among the results.  Very long pages arrive truncated: for"
            " long documents prefer one targeted site:-search over opening"
            " page after page.\n</page_reader>"
        )
    answer_planning = ""
    if plan_tool:
        answer_planning = (
            "<answer_planning>\n"
            "When you catch yourself deliberating about the SHAPE of the"
            f" final answer -- triaging sources, weighing what belongs"
            f" where, drafting an outline -- call the {PLAN_TOOL} tool with"
            " that thinking (ALONE in its turn): the user sees the plan as a"
            " research step, and the writer builds the answer on it.  A"
            " reply that narrates its own planning is a broken research"
            " turn.\n</answer_planning>"
        )
    ambiguity_escape = ""
    if register_ask:
        ambiguity_escape = (
            "<ambiguity_escape>\n"
            f"The {ASK_TOOL} tool is your ambiguity escape hatch: the moment"
            " you realize -- in your first intent sentence or from the first"
            " round's results -- that the request is genuinely ambiguous (an"
            " acronym, code or short name matching several UNRELATED"
            " products/domains, where guessing wrong wastes the whole run),"
            " call it ONCE as the only call of that turn and stop.  Do not"
            " burn rounds researching a guess first; do not use it for broad"
            " informational topics; do not mix it with"
            f" {TOOL_NAME} calls.\n</ambiguity_escape>"
        )
    depth = _DEPTH_RESEARCH.get(depth, _DEPTH_RESEARCH["balanced"])
    lines = [
        role,
        prompts.today_line(),
        f"<step_notes>\nWrite your step notes (the narration before tool" f" calls) in {lang}.\n</step_notes>",
        how_to_search,
        _examples(page_tool, plan_tool),
    ]
    if page_reader:
        lines.append(page_reader)
    if answer_planning:
        lines.append(answer_planning)
    lines.append(f"<depth>\n{depth}\n</depth>")
    if max_rounds:
        lines.append(
            "<research_policy>\nThere is NO time limit and no cap on how"
            f" many searches you may run -- only a safety ceiling of"
            f" {max_rounds} rounds (a round = one parallel batch).  The REAL"
            " rule is progress: every round must add NEW information."
            "  Repeating a query or finding nothing new wastes the run -- if"
            " your latest round produced no new leads, stop researching; the"
            " writer answers from what you have.  Stop early, too, when the"
            " rounds converge: fresh angles returning the same facts mean"
            " the picture is complete.\n</research_policy>"
        )
    if ambiguity_escape:
        lines.append(ambiguity_escape)
    if clarifications:
        lines.append(
            "<clarified>\nThe user already confirmed the research direction"
            " before this run (honor it; do not re-ask):\n"
            f"{clarifications}\n</clarified>"
        )
    elif clarify_skipped:
        lines.append(
            "<clarified>\nThe user declined to clarify the direction:"
            " proceed with your best interpretation and cover the plausible"
            " facets.\n</clarified>"
        )
    if follow_up:
        lines.append(follow_up)
    messages: list[dict[str, t.Any]] = [{"role": "system", "content": "\n".join(lines)}]
    for turn in history:
        messages.append({"role": "user", "content": f"<q>{turn.get('q') or ''}</q>"})
        messages.append({"role": "assistant", "content": str(turn.get("a") or "")[:2000]})
    messages.append({"role": "user", "content": f"<q>{question}</q>"})
    return messages


_RESULT_TEMPLATE = (
    '{%- from "zjsearch/data/macros.html" import result_data with context -%}'
    # the separator is a block-if ON PURPOSE: inline-if string literals come
    # out autoescaped ("&#34;, &#34;") and break the JSON (the repo gotcha)
    '[{%- for result in results %}{% if not loop.first %},{% endif %}{{ result_data(result) }}{%- endfor %}]'
)


_BANG_PREFIX_RE = re.compile(r"^(?:\s*![a-z0-9_-]+)*(?:\s+|$)", re.IGNORECASE)
_TIME_RANGES = ("day", "week", "month", "year")


def _norm_query(query: str) -> str:
    """The dedup key of a search query: case- and whitespace-insensitive."""
    return " ".join(query.lower().split())


def _clean_sites(raw: t.Any) -> list[str]:
    """Bare domains out of the model's ``included_sites``/``excluded_sites``
    arguments: scheme/path/port stripped, lowercased, deduped, capped --
    anything that is not host-shaped is dropped (the operators travel in
    the query and the engine's plugin enforces them; a malformed token
    would just match nothing)."""
    out: list[str] = []
    for value in (raw if isinstance(raw, list) else [])[:6]:
        host = str(value or "").strip().lower()
        host = re.sub(r"^[a-z][a-z0-9+.-]*://", "", host)
        host = host.split("/", 1)[0].split(":", 1)[0]
        if host and "." in host and len(host) <= 100 and host not in out:
            out.append(host)
        if len(out) >= 3:
            break
    return out


def _parse_call(call: dict[str, t.Any]) -> tuple[str, str, str, list[str], list[str]]:
    """(query, category, time_range, included_sites, excluded_sites) of one
    tool call -- sanitized: a LEADING group of engine bangs (e.g. "!baidu")
    survives because the model may only use one when the user explicitly
    names the engine; every other "!" is noise, whitespace collapses, the
    category and the freshness window are whitelist-checked and the site
    filters are host-shaped bare domains."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    query = str(args.get("query") or "")
    bang_match = _BANG_PREFIX_RE.match(query)
    bang = ""
    if bang_match and bang_match.group(0).strip():
        bang = " ".join(token.lower() for token in bang_match.group(0).split())
        query = query[bang_match.end() :]
    query = query.replace("!", "")
    query = " ".join((bang + " " + query).split())[:200]
    category = str(args.get("category") or "general").strip().lower()
    if category not in SEARCH_CATEGORIES:
        category = "general"
    time_range = str(args.get("time_range") or "").strip().lower()
    if time_range not in _TIME_RANGES:
        time_range = ""
    return (
        query,
        category,
        time_range,
        _clean_sites(args.get("included_sites")),
        _clean_sites(args.get("excluded_sites")),
    )


def _parse_page_call(call: dict[str, t.Any]) -> str:
    """The url of one ``web_crawler`` tool call -- sanitized: trimmed and
    capped; the public-url guard runs in :py:mod:`searx.zjsearch.ai.browserless`."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return str(args.get("url") or "").strip()[:2000]


def _serialize(raw_results: list[t.Any], query: str) -> list[dict[str, t.Any]]:
    """Ordered results as page-data-shaped dicts -- highlighted like the
    search view does, serialized through the very ``_result_data`` macro
    the page payload uses (runs in the request thread)."""
    for result in raw_results:
        if "content" in result and result["content"]:
            result["content"] = highlight_content(escape(result["content"][:1024]), query)
        if "title" in result and result["title"]:
            result["title"] = highlight_content(escape(result["title"] or ""), query)
    rendered = None
    try:
        # the macro speaks the render context's helper functions -- pass the
        # very same callables webapp.render / the stream mirror pass
        from searx import webapp  # pylint: disable=import-outside-toplevel,cyclic-import

        rendered = flask.render_template_string(
            _RESULT_TEMPLATE,
            results=raw_results,
            favicon_url=webapp.favicons.favicon_url,
            get_pretty_url=webapp.get_pretty_url,
            image_proxify=webapp.image_proxify,
        )
        return json.loads(rendered)
    except Exception as exc:  # pylint: disable=broad-except
        # a malformed field reaching the macro raises anything from
        # ValueError to jinja2.TemplateError; one bad result degrades to no
        # serialized feed for THAT search, never a crashed round
        logger.warning(
            "zjsearch_ai_search: result serialization failed: %r -- head: %.240r",
            exc,
            rendered if isinstance(rendered, str) else "",
        )
        return []


class _Searches:  # pylint: disable=too-few-public-methods
    """The ``web_search`` executor: real instance searches in a worker
    pool.  Yields the feature events for the wire protocol and ends with
    the agent framework's ``("tool_results", ...)`` alignment."""

    def __init__(
        self,
        prefs: t.Any,
        user_plugins: list[str],
        sources_base: int = 0,
        search_language: str = "",
        max_rounds: int = 0,
    ):
        self.prefs = prefs
        self.user_plugins = user_plugins
        self.search_language = search_language
        self.max_rounds = max_rounds
        self.round_no = 0
        # follow-up runs continue the global [n] numbering after the base
        self.next_n = sources_base + 1
        # every query this run already executed, normalized -> [query, n
        # results] -- the executor-side dedup (a repeated query settles as
        # ``duplicate`` without hitting the engines)
        self.ran: dict[str, list] = {}
        # every page this run already opened (normalized) -- a re-read
        # settles as ``duplicate`` without rendering again
        self.read_urls: set[str] = set()
        # every source url of this run -> its global [n]: a re-read or a
        # repeat of a known url reuses the number instead of minting a
        # duplicate source (the FEED dedup rides the same registry)
        self.url_n: dict[str, int] = {}
        # image urls fed to the model (img=... lines) -> their global [n]:
        # the validated whitelist of the writer's ``zjs-images`` fence
        self.gallery_pool: dict[str, int] = {}
        # the accumulated source feed for the WRITER: one block per search
        # (its [n] lines) and per page read -- the writer's whole context
        self.feed: list[str] = []
        # the run's inline image galleries (validated zjs-images fences):
        # index -> items -- the answer's {{zjs-gallery:i}} placeholders
        # reference these
        self.galleries: list[list[dict[str, t.Any]]] = []
        # total feed characters (the context-pressure signal for the model)
        self.feed_chars = 0
        self.size_noted = False
        # progress bookkeeping for the stall detector: fresh queries with
        # results / fresh page reads in the CURRENT round, and the
        # consecutive-round count of rounds without any
        self.round_new_hits = 0
        self.stalled_rounds = 0

    def _search_one(
        self, query: str, category: str, time_range: str, include: list[str], exclude: list[str]
    ) -> list[t.Any]:
        """One real instance search -- the webapp path with a synthesized
        form (user preferences apply: safesearch, engines; the page's
        result language filter applies via ``search_language``).  The site
        filters travel as ``site:``/``-site:`` operators in the query: the
        advanced_search_syntax plugin strips them from the engine query and
        enforces them authoritatively on every result.  Runs in a worker
        thread inside a COPIED request context (the executor submits it
        wrapped in ``copy_current_request_context``): SearchWithPlugins
        stores the request proxy and ``search()`` copies the context again
        for each of its engine threads."""
        parts = [f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude]
        if parts:
            query = f"{query} {' '.join(parts)}"
        form = {"q": query, "categories": category}
        if time_range:
            form["time_range"] = time_range
        if self.search_language:
            form["language"] = self.search_language
        search_query, _raw, _unknown, _notoken, _locale = get_search_query_from_webapp(self.prefs, form)
        search_obj = SearchWithPlugins(search_query, sxng_request, self.user_plugins)
        return search_obj.search().get_ordered_results()

    def _finish(  # pylint: disable=too-many-locals
        self,
        rnd: int,
        idx: int,
        query: str,
        category: str,
        fut: "concurrent.futures.Future[list[t.Any]]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        ms = int((time.monotonic() - started) * 1000)
        try:
            raw = fut.result()[:RESULTS_CAP]
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: search %d/%d failed: %r", rnd, idx, exc)
            feeds[idx - 1] = "error: the search failed"
            yield ("search", {"round": rnd, "id": idx, "status": "error", "n": 0, "ms": ms})
            return
        items = _serialize(raw, query)
        if items:
            self.round_new_hits += 1
        entries: list[dict[str, t.Any]] = []
        feed_lines = [f'Search "{query}" (category: {category}) returned {len(items)} results:']
        for pos, item in enumerate(items[: FEED_DEEP + FEED_SHALLOW]):
            url = str(item.get("url") or "")
            norm = browserless.normalize_url(url) if url else ""
            known_n = self.url_n.get(norm) if norm else None
            title = str(item.get("title_text") or "")
            netloc = str(item.get("netloc") or "")
            if known_n is not None:
                # cross-search dedup: this url already holds a global [n]
                # from an earlier search -- point at it instead of minting
                # a duplicate source (the numbering stays contiguous and
                # the sources grid shows the page once)
                if pos < FEED_DEEP:
                    head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                    feed_lines.append(f"[{known_n}] {netloc}: {title} - {head} (same source as an earlier result)")
                else:
                    feed_lines.append(f"[{known_n}] {netloc}: {title} (same source as an earlier result)")
                continue
            n = self.next_n
            self.next_n += 1
            if norm:
                self.url_n[norm] = n
            img = str(item.get("img_src") or item.get("thumbnail") or item.get("thumbnail_src") or "")
            if img and len(self.gallery_pool) < _GALLERY_POOL_MAX:
                self.gallery_pool[img] = n
            entries.append(
                {
                    "n": n,
                    "round": rnd,
                    "id": idx,
                    "idx": pos,
                    "title": title[:200],
                    "url": url,
                    "netloc": netloc,
                    "favicon": str(item.get("favicon") or ""),
                    "pretty_url": str(item.get("pretty_url") or ""),
                    "published_date": str(item.get("published_date") or ""),
                }
            )
            if pos < FEED_DEEP:
                head = str(item.get("content_text") or "")[:FEED_SNIPPET_CHARS]
                img_part = f" img={img}" if img else ""
                feed_lines.append(f"[{n}] {netloc}: {title} - {head}{img_part}")
            else:
                feed_lines.append(f"[{n}] {netloc}: {title}")
        feeds[idx - 1] = "\n".join(feed_lines)
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        yield ("search", {"round": rnd, "id": idx, "status": "ok", "n": len(items), "ms": ms})
        if items:
            yield ("results", {"round": rnd, "id": idx, "results": items})
        if entries:
            yield ("sources", {"items": entries})

    def _read_one(self, url: str) -> tuple[str, str]:
        """One ``web_crawler`` read -- Browserless render + extraction over
        the instance's default network; needs no request context."""
        return browserless.read_page(url)

    def _finish_page(
        self,
        rnd: int,
        idx: int,
        url: str,
        fut: "concurrent.futures.Future[tuple[str, str]]",
        started: float,
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        ms = int((time.monotonic() - started) * 1000)
        try:
            title, text = fut.result()
        except Exception as exc:  # pylint: disable=broad-except
            # PageReadError or a worker-level surprise -- one dead-end line
            # for the model, an error row for the client
            logger.warning("zjsearch_ai_search: page %d/%d failed (%s): %r", rnd, idx, url[:120], exc)
            feeds[idx - 1] = f"error: {str(exc)[:300] or type(exc).__name__}"
            yield ("page", {"round": rnd, "id": idx, "status": "error", "url": url, "ms": ms})
            return
        norm = browserless.normalize_url(url)
        known_n = self.url_n.get(norm)
        if known_n is not None:
            n = known_n
            cite = f"source [{n}] (already among your sources -- cite it as [{n}])"
        else:
            n = self.next_n
            self.next_n += 1
            self.url_n[norm] = n
            cite = f"NEW source [{n}] -- cite it as [{n}]"
        netloc = urlsplit(url).netloc
        feeds[idx - 1] = f'Opened {url} (title: "{title}"; {cite}):\n\n{text}'
        self.feed.append(feeds[idx - 1])
        self.feed_chars += len(feeds[idx - 1])
        self.round_new_hits += 1
        yield (
            "page",
            {
                "round": rnd,
                "id": idx,
                "status": "ok",
                "url": url,
                "title": title,
                "chars": len(text),
                "ms": ms,
                # the extracted readable content rides to the client: the
                # timeline row expands into a READING PANE (what did the
                # model actually see?) -- capped like the feed copy
                "text": text,
            },
        )
        # the read page always rides a sources event: a NEW url registers its
        # card, an already-numbered one re-emits its [n] with ``crawled``
        # set -- the client upgrades the existing card in place (the
        # read-in-full badge marks what the model verified first-hand)
        yield (
            "sources",
            {
                "items": [
                    {
                        "n": n,
                        "round": rnd,
                        "id": idx,
                        "idx": 0,
                        "title": title,
                        "url": url,
                        "netloc": netloc,
                        "favicon": "",
                        "pretty_url": url,
                        "published_date": "",
                        "crawled": True,
                    }
                ]
            },
        )

    def execute(self, calls: list[dict[str, t.Any]]) -> t.Iterator[tuple[str, t.Any]]:
        """Run one round of calls in parallel -- ``web_search`` and
        ``web_crawler`` calls share the worker pool; feature events flow to
        the client while they complete.  Wire ids are the 1-based position
        of the call within this round.  Exact-duplicate queries and
        already-read pages settle instantly as ``duplicate`` -- they never
        hit the engines or the browser again; their feed tells the model
        to move on.  The round's tool results also carry the budget /
        context-pressure notes: that is how the MODEL learns it is nearing
        the ceiling (the static system prompt only states it once)."""
        self.round_no += 1
        rnd = self.round_no
        self.round_new_hits = 0
        feeds: list[str | None] = [None] * len(calls)
        search_jobs: list[tuple[int, str, str, str, list[str], list[str]]] = []
        page_jobs: list[tuple[int, str]] = []
        for wire_id, call in enumerate(calls, 1):
            if str(call.get("name") or "") == PAGE_TOOL:
                raw_url = _parse_page_call(call)
                url = browserless.normalize_url(raw_url)
                if not raw_url:
                    feeds[wire_id - 1] = "error: empty url"
                    yield ("page", {"round": rnd, "id": wire_id, "status": "error", "url": "", "ms": 0})
                elif url in self.read_urls:
                    feeds[wire_id - 1] = (
                        "duplicate: this exact page was already opened in an"
                        " earlier round and its content is already in the"
                        " conversation -- do not re-read it."
                    )
                    yield ("page", {"round": rnd, "id": wire_id, "status": "duplicate", "url": url, "ms": 0})
                else:
                    self.read_urls.add(url)
                    page_jobs.append((wire_id, url))
                continue
            query, category, time_range, include, exclude = _parse_call(call)
            if not query:
                feeds[wire_id - 1] = "error: empty query"
                yield ("search", {"round": rnd, "id": wire_id, "status": "error", "n": 0, "ms": 0})
            else:
                dedup_key = " ".join((query + " " + " ".join(f"site:{h}" for h in include + exclude)).lower().split())
                if dedup_key in self.ran:
                    feeds[wire_id - 1] = (
                        "duplicate: this exact query already ran in an earlier"
                        " round and its results are already in the conversation"
                        " -- do not repeat it; search a DIFFERENT facet or write"
                        " the answer from the sources you have."
                    )
                    yield ("search", {"round": rnd, "id": wire_id, "status": "duplicate", "n": 0, "ms": 0})
                else:
                    self.ran[dedup_key] = [query, 0]
                    search_jobs.append((wire_id, query, category, time_range, include, exclude))
        # the pool is deliberately NOT in a with-block: when the consumer
        # disappears (client disconnect / stop) the generator closes right
        # here -- a with-exit would wait for the still-running work and
        # stall the shutdown
        total = len(search_jobs) + len(page_jobs)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=min(max(1, total), MAX_PARALLEL))
        try:
            yield from self._dispatch(pool, rnd, search_jobs, page_jobs, feeds)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        # the model-facing budget note rides the round's tool results: the
        # next turn reads it with the results it describes (Vane injects
        # the iteration counter into the system prompt every turn -- this
        # is the cheap canonical-messages equivalent)
        if self.max_rounds and rnd == self.max_rounds - 1:
            self._append_note(
                feeds,
                "(budget note: ONE research round remains -- make it cover the most important remaining gaps.)",
            )
        elif self.feed_chars > _FEED_SOFT_LIMIT and not self.size_noted:
            self.size_noted = True
            self._append_note(
                feeds,
                "(note: the source context is getting large -- start converging:"
                " prefer answering from what you have over opening more pages.)",
            )
        yield (
            "tool_results",
            [(calls[idx], str(feed or "error: the call failed")) for idx, feed in enumerate(feeds)],
        )

    @staticmethod
    def _append_note(feeds: list[str | None], note: str) -> None:
        """Append a model-facing note to the LAST non-empty feed of the
        round -- one copy is enough (the model reads every tool result of
        the batch).  The rebind deliberately leaves the writer's ``feed``
        blocks untouched: notes steer the conversation, they are not
        source content."""
        for i in range(len(feeds) - 1, -1, -1):
            if feeds[i]:
                feeds[i] = f"{feeds[i]}\n\n{note}"
                return

    def _dispatch(  # pylint: disable=too-many-locals
        self,
        pool: concurrent.futures.ThreadPoolExecutor,
        rnd: int,
        search_jobs: list[tuple[int, str, str, str, list[str], list[str]]],
        page_jobs: list[tuple[int, str]],
        feeds: list[str | None],
    ) -> t.Iterator[tuple[str, t.Any]]:
        futures: dict[concurrent.futures.Future, tuple[str, int, tuple[t.Any, ...]]] = {}
        for wire_id, query, category, time_range, include, exclude in search_jobs:
            # the worker needs a request context of its own: SearchWithPlugins
            # stores the request proxy and search() copies the context again
            # for each of its engine threads (mirrors the webapp view thread)
            worker = flask.copy_current_request_context(self._search_one)
            futures[pool.submit(worker, query, category, time_range, include, exclude)] = (
                "search",
                wire_id,
                (query, category, time.monotonic()),
            )
        for wire_id, url in page_jobs:
            futures[pool.submit(self._read_one, url)] = ("page", wire_id, (url, time.monotonic()))
        pending = dict(futures)
        # no batch wall clock: every queued call gets to run and every
        # engine request / page read carries its own per-request timeout,
        # which is what bounds a batch -- the user's stop button is the
        # only control
        while pending:
            done, _not_done = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in done:
                kind, wire_id, args = pending.pop(fut)
                if kind == "search":
                    query, category, started = args
                    yield from self._finish(rnd, wire_id, query, category, fut, started, feeds)
                else:
                    url, started = args
                    yield from self._finish_page(rnd, wire_id, url, fut, started, feeds)


def _display_item(idx: int, call: dict[str, t.Any]) -> dict[str, t.Any]:
    """One ``calls`` wire item: the client's timeline row.  ``tool``
    discriminates the row kind -- a search renders its query, a page read
    its url.  Site filters display folded into the query so the row shows
    the operators the engine will enforce."""
    if str(call.get("name") or "") == PAGE_TOOL:
        return {"id": idx, "tool": PAGE_TOOL, "url": _parse_page_call(call)}
    query, category, time_range, include, exclude = _parse_call(call)
    operators = " ".join([f"site:{host}" for host in include] + [f"-site:{host}" for host in exclude])
    if operators:
        query = f"{query} {operators}"
    return {"id": idx, "tool": TOOL_NAME, "q": query, "category": category, "time_range": time_range or None}


def _json_object_of(text: str) -> dict[str, t.Any] | None:
    """The first JSON object in a completion's text (models love wrapping
    their JSON in prose or fences despite being told not to)."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _parse_fence_json(text: str) -> t.Any:
    """The outermost JSON value in a fence body (the models keep the fence
    exact per prompt, but a stray prose line or fence must not kill the
    parse).  The delimiter is whichever bracket comes FIRST: an object
    containing arrays must parse as the object, not as its inner array."""
    start_obj = text.find("{")
    start_arr = text.find("[")
    if start_obj == -1 and start_arr == -1:
        return None
    if start_arr == -1 or (start_obj != -1 and start_obj < start_arr):
        start, closer = start_obj, "}"
    else:
        start, closer = start_arr, "]"
    end = text.rfind(closer)
    if end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except ValueError:
        return None


def _parse_related_questions(text: str) -> list[str]:
    """The ```related fence body -> up to three clean question strings."""
    value = _parse_fence_json(text)
    items = value.get("questions") if isinstance(value, dict) else None
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for item in items:
        question = str(item or "").strip()
        if question and question not in out:
            out.append(question[:200])
        if len(out) >= 3:
            break
    return out


class _FenceSplitter:
    """Splits the WRITER's delta stream: prose deltas pass through (with a
    small holdback so a fence opener split across two deltas cannot flash
    on screen), while the ``related`` and ``zjs-images`` fences are
    intercepted -- held back from the client's answer text entirely and
    handed to the caller when they close.  The writer's fence is therefore
    invisible to the renderer by construction; nothing depends on the
    client recognizing raw fence text."""

    HOLD = 20
    _OPENERS = ("zjs-images", "related")

    def __init__(self) -> None:
        self.tail = ""
        self.fence_kind: str | None = None
        self.fence_body = ""

    def feed(self, delta: str) -> tuple[str, list[tuple[str, str]]]:
        """Consume one delta -> (prose to emit, fences closed by it)."""
        closed: list[tuple[str, str]] = []
        out = ""
        text = self.tail + delta
        self.tail = ""
        while text:
            if self.fence_kind is not None:
                end = text.find("```")
                if end == -1:
                    self.fence_body += text
                    break
                self.fence_body += text[:end]
                closed.append((self.fence_kind, self.fence_body))
                self.fence_kind = None
                self.fence_body = ""
                text = text[end + 3 :]
                continue
            match = None
            for opener in self._OPENERS:
                found = re.search(r"```\s*" + opener + r"\b", text)
                if found and (match is None or found.start() < match.start()):
                    match = found
            if match is None:
                # no opener in sight: emit everything except a holdback
                # that could still be the prefix of one
                if len(text) > self.HOLD:
                    out += text[: -self.HOLD]
                    self.tail = text[-self.HOLD :]
                else:
                    self.tail = text
                break
            line_end = text.find("\n", match.end())
            if line_end == -1:
                # the opener line is still streaming: re-hold ALL of it
                self.tail = text
                break
            out += text[: match.start()]
            self.fence_kind = "zjs-images" if "zjs-images" in match.group(0) else "related"
            text = text[line_end + 1 :]
        return out, closed

    def finish(self) -> tuple[str, list[tuple[str, str]]]:
        """Stream end: flush the holdback; an UNCLOSED fence still parses
        (a model that forgets the closing fence must not lose its
        suggestions)."""
        tail, self.tail = self.tail, ""
        closed: list[tuple[str, str]] = []
        if self.fence_kind is not None:
            closed.append((self.fence_kind, self.fence_body))
            self.fence_kind = None
            self.fence_body = ""
        return tail, closed


def _research_gate(cfg: dict[str, t.Any], question: str) -> bool:
    """The pre-flight gate (Vane's skipSearch, narrowed to our contract):
    False only for requests where NO answer detail can benefit from live
    web sources -- greetings and small talk, creative writing (poems,
    stories, emails), pure translation or arithmetic, rewriting of the
    user's own text.  Every factual question researches, however well
    known (the engine's contract is live, cited answers).  Fail-open: a
    broken gate must never block research."""
    messages = [
        {
            "role": "system",
            "content": (
                "You are the research gate of an AI search engine: decide"
                " whether the request needs live web research.  Answer false"
                " ONLY when nothing in a good answer could benefit from"
                " current web sources: greetings and small talk, creative"
                " writing (poems, stories, emails, essays), pure translation,"
                " arithmetic, or reworking of the user's own text."
                "  Everything else -- every factual question, however simple"
                " or well known -- needs research: this engine always answers"
                " with live, cited sources.  Output ONLY a JSON object, no"
                ' prose, no code fences: {"research": true} or {"research":'
                ' false}.'
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>"},
    ]
    value = llm.json_completion(cfg, messages, "research_gate", _RESEARCH_SCHEMA)
    if not value or not isinstance(value.get("research"), bool):
        return True
    return value["research"]


def _standalone_question(cfg: dict[str, t.Any], question: str, history: list[dict[str, str]], lang: str) -> str:
    """The follow-up rewrite (Vane's standalone follow-up): one small
    completion turns a thread-relative question into a self-contained one
    ("How do they work?" -> "How do heat pumps work?").  The REWRITTEN
    question drives the research and the writer; the thread still shows
    the user's own wording.  Empty on any failure -- fail-open."""
    convo = "\n".join(f"Q: {turn.get('q') or ''}\nA: {(turn.get('a') or '')[:400]}" for turn in history)
    messages = [
        {
            "role": "system",
            "content": (
                "Rewrite the user's follow-up question as ONE self-contained"
                " question that can be researched WITHOUT the conversation."
                "  Resolve pronouns and ellipsis using the conversation;"
                " never answer it, never add facts.  Output ONLY a JSON"
                " object, no prose, no code fences:"
                ' {"question": "<the rewritten question>"} -- or'
                ' {"question": ""} when it is already self-contained.'
                f"  Write in {lang}."
            ),
        },
        {"role": "user", "content": f"<conversation>\n{convo}\n</conversation>\n<follow_up>{question}</follow_up>"},
    ]
    value = llm.json_completion(cfg, messages, "standalone_question", _STANDALONE_SCHEMA)
    return str((value or {}).get("question") or "").strip()[:300]


def _fit_context(feed: list[str], cap: int) -> list[str]:
    """The writer's source feed under the hard cap: whole OLDEST blocks are
    evicted first (the oldest searches are the broadest; page reads and
    late refinements stay), never a mid-block slice -- a silently cut tail
    could drop exactly the source the model was about to cite.  The
    eviction notice names the drop so the writer does not cite evicted
    numbers; the renderer still fails soft on any that slip through."""
    blocks = [block for block in feed if block]
    dropped = 0
    while len(blocks) > 1 and sum(len(block) for block in blocks) > cap:
        blocks.pop(0)
        dropped += 1
    if dropped:
        blocks.insert(
            0,
            f"[... {dropped} earlier source block(s) were dropped to fit"
            " the context -- cite only the sources below ...]",
        )
    return blocks or ["The research found no usable sources."]


_FOLLOWUPS_BLOCK = (
    "<follow_ups>\n"
    "When the answer is substantive -- it compares, recommends, explains a"
    " mechanism or lays out several points -- end it with EXACTLY ONE"
    " fenced block carrying three follow-up questions:\n"
    "```related\n"
    '{"questions": ["...", "...", "..."]}\n'
    "```\n"
    "Each question is short (about a dozen words at most), self-contained,"
    " in the answer language, and grounded in THIS answer: one deepens its"
    " most interesting or surprising point, one is the practical next"
    " step, one broadens with a comparison or related angle -- never three"
    " near-duplicates.  Omit the block entirely for greetings, single"
    " facts or values, refusals and clarifying questions.  The fence is"
    " the LAST thing in the reply; never mention it in the prose.\n</follow_ups>"
)


def _answer_images_block() -> str:
    """The inline-gallery contract: the writer may embed image groups
    (Morphic's spec-image idea, our own tiny fence) -- URLs must be copied
    VERBATIM from the feed's ``img=`` entries and are validated against
    the run's registry server-side: anything else is dropped before it
    reaches the client."""
    return (
        "<answer_images>\n"
        "Some source lines below carry image URLs as img=... .  Visual"
        " context communicates faster than prose: DEFAULT TO including one"
        " image group whenever img= lines exist and images could help the"
        " reader -- multi-part answers may use a second group right where"
        " it illustrates the text.  Each group is a fenced block of a JSON"
        " array of 1-4 URLs, placed on its own lines inside the markdown"
        " body:\n"
        "```zjs-images\n"
        '["<url>", "<url>"]\n'
        "```\n"
        "A feed line looks like: \"[12] upload.wikimedia.org: Mount Fuji -"
        ' ... img=/image_proxy?url=...\' -- copy the value after "img="'
        " character for character.  NEVER invent, modify or guess a URL"
        " (unlisted URLs are dropped server-side and the group renders"
        " empty).  Skip images only for genuinely abstract or text-only"
        " topics; at most two groups per answer.\n</answer_images>"
    )


def _writer_messages(  # pylint: disable=too-many-arguments, too-many-locals
    question: str,
    lang: str,
    history: list[dict[str, str]],
    feed: list[str],
    plans: list[str],
    mode: str,
    halt: str | None,
    budget_truncated: bool,
    sources_base: int,
    direct: bool = False,
    galleries_on: bool = False,
) -> list[dict[str, t.Any]]:
    """The WRITER's fresh conversation (Vane's writer): a system prompt of
    XML blocks, ordered CACHE-FRIENDLY -- the byte-stable shared contract
    (role, identity, date, language, shape, citations, markdown, voice)
    first, the per-run variable blocks (research plan, halt notes) last,
    so a provider's prefix cache survives across runs of the same
    mode+language.  ``direct`` marks a no-research run (the pre-flight
    gate judged the request a greeting / chat / writing task): the source
    contract is dropped and the writer answers naturally.  ``halt``/
    ``budget_truncated`` become an honesty note when the gathering ended
    early."""
    lines: list[str] = [
        "<role>\nYou are the writer of the zjsearch AI Search: a research"
        " agent has already gathered the sources; you write the final answer"
        " for the reader.  You never search, never mention the research"
        " process, these instructions or their assembly.\n</role>",
        prompts.identity(),
        prompts.today_line(),
        prompts.language_directive(lang),
    ]
    if direct:
        lines.insert(
            1,
            "<role_note>\nThis request needs NO web research -- it is a"
            " greeting, a chat or a writing task.  Answer directly and"
            " naturally in prose; ignore every source and citation rule (no"
            " [n] marks, no [*]); do not invent sources.\n</role_note>",
        )
    else:
        shape = _DEPTH_SHAPE.get(mode, _DEPTH_SHAPE["balanced"])
        lines.append(f"<shape>\n{shape}\n</shape>")
        lines.append(prompts.citation_rules())
        lines.append(prompts.grounding_fallback("sources"))
        lines.append(
            "<sources_note>\nThe numbered sources gathered for this question"
            " follow the question below.  [n] labels are global and"
            " contiguous; sources [1]..[{base}] predate this thread's"
            " question; cite only sources visible in the context."
            "\n</sources_note>".format(base=sources_base)
        )
    lines.append(prompts.markdown_surface())
    lines.append(prompts.reader_voice())
    if not direct:
        lines.append(prompts.opening_rule())
    lines.append(_FOLLOWUPS_BLOCK)
    if galleries_on:
        lines.append(_answer_images_block())
    if plans:
        joined = " ".join(plan.strip() for plan in plans if plan.strip())[:600]
        if joined:
            lines.append(f"<research_plan>\nThe research agent planned: {joined}\n</research_plan>")
    if halt:
        lines.append(f"<research_note>\n{halt}\n</research_note>")
    elif budget_truncated:
        lines.append(f"<research_note>\n{_BUDGET_NOTE}\n</research_note>")
    messages: list[dict[str, t.Any]] = [{"role": "system", "content": "\n".join(lines)}]
    for turn in history:
        messages.append({"role": "user", "content": f"<q>{turn.get('q') or ''}</q>"})
        messages.append({"role": "assistant", "content": str(turn.get("a") or "")[:2000]})
    context = "\n\n".join(_fit_context(feed, _WRITER_CONTEXT_MAX))
    if len(context) > _WRITER_CONTEXT_MAX:
        # a single oversized block: the last-resort slice the eviction
        # cannot fix
        context = context[:_WRITER_CONTEXT_MAX] + "\n\n[... the feed was truncated ...]"
    messages.append(
        {
            "role": "user",
            "content": (
                f"<question>{question}</question>\n<context>\n"
                f"{context if not direct else 'No sources: this answer does not need them.'}\n</context>"
            ),
        }
    )
    return messages


def _round_progress(state: _Searches, stall_rounds: int) -> t.Callable[[int], str | None]:
    """The progress-based termination policy: called by the agent loop
    after each executed round.  A round is PRODUCTIVE when at least one
    fresh query returned results; ``stall_rounds`` consecutive
    unproductive rounds end the research (the returned message explains
    the staleness to the model).  Productive research is UNLIMITED."""

    def verdict(_round_no: int) -> str | None:
        if state.round_new_hits > 0:
            state.stalled_rounds = 0
            return None
        state.stalled_rounds += 1
        if state.stalled_rounds < stall_rounds:
            return None
        return _STALL_NOTE

    return verdict


def _clarify_gate(cfg: dict[str, t.Any], question: str, lang: str, mode: str) -> dict[str, t.Any] | None:
    """The pre-research human-in-loop gate: one small completion decides
    whether the run should ask the user for direction first (quality:
    only on a genuinely ambiguous request; goal: prefers asking when the
    goal statement lacks a target).  Answers the sanitized question set,
    or None on any failure or a ``no`` -- the run then researches
    directly (fail-open: a broken gate must never block research)."""
    posture = (
        " The request reads as a GOAL the user wants reached: prefer asking"
        " when the target, constraints or success criteria are unstated."
        if mode == "goal"
        else " Ask ONLY when the research direction genuinely depends on the"
        " user's intent and guessing wrong would waste the whole run."
    )
    messages = [
        {
            "role": "system",
            "content": (
                "You are the clarification gate of a deep-research search"
                " engine: decide whether the request needs the user's"
                " direction BEFORE any research begins." + posture + " Broad"
                " informational topics (\"searxng\", \"how do solar panels"
                " work\") do NOT need clarification -- cover their facets"
                " instead.  Ask at most 3 questions; each carries 2-4 short"
                " options (\"single\" = pick one, \"multi\" = pick any) and"
                " the user can always add free text.  Output ONLY a JSON"
                " object, no prose, no code fences: {\"ask\": true, \"intro\":"
                " \"<one sentence on why you ask>\", \"questions\": [{\"q\":"
                " \"<question>\", \"type\": \"single\", \"options\": [\"<short"
                " option>\", ...]}]}  -- or {\"ask\": false} when research can"
                f" start directly.  Write in {lang}."
            ),
        },
        {"role": "user", "content": f"<q>{question}</q>"},
    ]
    value = llm.json_completion(cfg, messages, "clarify_gate", _CLARIFY_SCHEMA)
    if not value or not value.get("ask"):
        return None
    questions = _sanitize_questions(value.get("questions"))
    if not questions:
        return None
    return {"intro": str(value.get("intro") or "").strip()[:200], "questions": questions}


def _related_questions(cfg: dict[str, t.Any], question: str, answer: str, lang: str) -> list[str]:
    """Three follow-up questions for the Related section -- one small
    structured completion after the answer settles; empty on any
    failure."""
    messages = [
        {
            "role": "system",
            "content": (
                "Suggest follow-up questions for a search session. Output ONLY a"
                " JSON object, no prose, no markdown, no code fences:"
                ' {"questions": ["<question 1>", "<question 2>",'
                ' "<question 3>"]} -- exactly 3 short question strings.'
            ),
        },
        {
            "role": "user",
            "content": (
                f"Question: {question}\n\nAnswer given:\n{answer[:1200]}\n\n" f"Language for the questions: {lang}"
            ),
        },
    ]
    value = llm.json_completion(cfg, messages, "related_questions", _RELATED_SCHEMA)
    items = (value or {}).get("questions")
    if not isinstance(items, list):
        return []
    return [str(item).strip()[:200] for item in items if isinstance(item, str) and item.strip()][:3]


def _generate(  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    first: tuple[str, t.Any],
    events: t.Iterator[tuple[str, t.Any]],
    cfg: dict[str, t.Any],
    question: str,
    lang: str,
    plans: list[str],
    state: "_Searches",
) -> t.Iterator[str]:
    """Map agent/executor events to the NDJSON wire protocol.  The WRITER's
    stream runs through a :class:`_FenceSplitter`: the ``related`` fence
    becomes a pre-``end`` related event (Morphic's in-stream follow-ups --
    no extra completion), each ``zjs-images`` fence becomes a validated
    gallery event plus a placeholder delta at its position; neither fence
    ever reaches the client's answer text.  When the writer skips the
    fence, the post-``end`` small completion still suggests follow-ups."""

    def emit(kind: str, payload: t.Any) -> str:  # pylint: disable=too-many-return-statements
        if kind == "think":
            return json.dumps({"e": "think", "t": str(payload or "")}, ensure_ascii=False) + "\n"
        if kind == "delta":
            return json.dumps({"e": "delta", "t": str(payload or "")}, ensure_ascii=False) + "\n"
        if kind == "calls":
            return (
                json.dumps(
                    {
                        "e": "calls",
                        "round": payload["round"],
                        "intent": payload["intent"],
                        "items": [_display_item(idx, call) for idx, call in enumerate(payload["calls"], 1)],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "wrapup":
            # payload-less state marker: the client flips its run state
            # (the wrap-up hint) on it
            return json.dumps({"e": kind}, ensure_ascii=False) + "\n"
        if kind == "direct":
            # the pre-flight gate skipped research: the writer answers
            # without one (the client hides the research box for the run)
            return json.dumps({"e": "direct"}, ensure_ascii=False) + "\n"
        if kind == "gallery":
            return json.dumps({"e": "gallery", "items": payload}, ensure_ascii=False) + "\n"
        if kind == "ask_user":
            # the mid-research escape hatch: the model stopped to ask for
            # direction -- shape its tool arguments into the same ask event
            # the clarify gate emits (the run ends; the client settles it
            # as awaiting)
            value = _json_object_of(str(payload or "{}")) or {}
            questions = _sanitize_questions(value.get("questions"))
            if not questions:
                # unusable questions would strand the run in awaiting with
                # an empty card -- degrade to researching on
                return (
                    json.dumps({"e": "error", "reason": "the model asked an unusable question"}, ensure_ascii=False)
                    + "\n"
                )
            return (
                json.dumps(
                    {
                        "e": "ask",
                        "intro": str(value.get("intro") or "").strip()[:200],
                        "questions": questions,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        if kind == "error":
            return json.dumps({"e": "error", "reason": llm.reason_of(payload)}, ensure_ascii=False) + "\n"
        return json.dumps({"e": kind, **payload}, ensure_ascii=False) + "\n"

    def gallery_items(body: str) -> list[dict[str, t.Any]]:
        """The zjs-images fence body -> validated gallery items: every URL
        must be verbatim from the run's image registry (the writer's
        prompt says never invent one; this is the enforcement)."""
        value = _parse_fence_json(body)
        urls = value if isinstance(value, list) else []
        items: list[dict[str, t.Any]] = []
        for url in urls[:4]:
            n = state.gallery_pool.get(str(url or ""))
            if n is not None:
                items.append({"u": str(url), "n": n})
        return items

    # reasoning-channel guard: some models (LM Studio + qwen3.6) route the
    # whole answer into the think stream and leave the content channel empty
    # -- promote the final turn's reasoning so the user always gets a
    # readable answer
    think_parts: list[str] = []
    answer_parts: list[str] = []

    last_kind = first[0]
    saw_ask = False
    splitter = _FenceSplitter()
    fence_related: list[str] = []

    def drain(pieces: list[tuple[str, str]]) -> t.Iterator[str]:
        """Handle closed fences: related queues the questions, each
        zjs-images emits its gallery event plus the placeholder delta the
        renderer expands (neither fence ever touches the answer text)."""
        nonlocal fence_related
        for kind, body in pieces:
            if kind == "related":
                fence_related = _parse_related_questions(body)
            else:
                items = gallery_items(body)
                if items:
                    mark = f"\n{{{{zjs-gallery:{len(state.galleries)}}}}}\n"
                    state.galleries.append(items)
                    answer_parts.append(mark.strip())
                    yield emit("gallery", items)

    def through(delta: str) -> t.Iterator[str]:
        prose, closed = splitter.feed(delta)
        if prose:
            answer_parts.append(prose)
            yield emit("delta", prose)
        yield from drain(closed)

    if first[0] == "delta":
        yield from through(str(first[1] or ""))
    else:
        yield emit(*first)
    for event in events:
        kind, payload = event
        last_kind = kind
        if kind == "think":
            think_parts.append(str(payload or ""))
        elif kind == "delta":
            yield from through(str(payload or ""))
        elif kind == "calls":
            # a new turn begins: its answer is judged on its own
            think_parts.clear()
            answer_parts.clear()
            yield emit(*event)
        elif kind == "plan":
            # the plan turn's prose is answer-shape deliberation, not
            # answer material -- never promote it on a late stream error;
            # it travels to the writer as guidance instead
            plans.append(str((payload or {}).get("t") or ""))
            think_parts.clear()
            answer_parts.clear()
        elif kind == "ask_user":
            # the run ends awaiting the user's direction: the streamed
            # intent prose is not an answer -- related questions on it
            # would be noise
            saw_ask = True
        elif kind == "wrapup":
            # the writer's stream follows: a fresh splitter -- the
            # researcher's holdback residue must not bleed into the answer
            splitter = _FenceSplitter()
            yield emit(*event)
        else:
            yield emit(*event)
    prose, closed = splitter.finish()
    if prose:
        answer_parts.append(prose)
        yield emit("delta", prose)
    yield from drain(closed)
    answer_text = "".join(answer_parts).strip()
    if last_kind != "error" and not answer_text and think_parts:
        # the model routed the whole answer into the reasoning channel:
        # promote it so the user always gets a readable answer
        promoted = "".join(think_parts).strip()
        yield emit("delta", promoted)
        answer_parts.append(promoted)
        answer_text = promoted
    # the writer's in-stream related fence wins: emit BEFORE end so the
    # follow-up box opens already holding its suggestions (the small
    # completion behind the fallback cannot match that -- it can think
    # for the better part of a minute on reasoning models)
    emitted_related = False
    if fence_related:
        yield emit("related", {"items": fence_related})
        emitted_related = True
    # `end` settles the run FIRST so the client's follow-up box opens
    # immediately; the fallback related questions trail as a post-end
    # event (the client accepts `related` after phase=done by design)
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"
    if answer_text and not saw_ask and not emitted_related:
        try:
            related = _related_questions(cfg, question, answer_text, lang)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_ai_search: related questions failed: %r", exc)
            related = []
    else:
        related = []
    if related:
        yield emit("related", {"items": related})


def _clarify_stream(gate: dict[str, t.Any]) -> t.Iterator[str]:
    """The clarify-gate response: the ask event then the closing end -- a
    run that settles as ``awaiting`` (the user's answers travel on the
    next request as ``clarifications``)."""
    yield json.dumps({"e": "ask", "intro": gate["intro"], "questions": gate["questions"]}, ensure_ascii=False) + "\n"
    yield json.dumps({"e": "end"}, ensure_ascii=False) + "\n"


def _search() -> flask.Response:  # pylint: disable=too-many-branches, too-many-statements, too-many-locals
    """AI Search: the researcher/writer split on the shared agent loop."""
    cfg = llm.ai_cfg()
    if not (_enabled() and llm.configured(cfg)):
        flask.abort(404)
    payload = sxng_request.get_json(silent=True) or {}
    if not llm.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    q = str(payload.get("q") or "").strip()
    if not q:
        flask.abort(422)
    # follow-up thread: prior Q&A turns + the global [n] numbering base
    raw_history = payload.get("history")
    history: list[dict[str, str]] = []
    if isinstance(raw_history, list):
        for item in raw_history[:4]:
            if isinstance(item, dict) and item.get("q") and item.get("a"):
                history.append({"q": str(item["q"])[:300], "a": str(item["a"])[:2000]})
    try:
        sources_base = min(abs(int(payload.get("sources_base"))), 200)
    except (TypeError, ValueError):
        sources_base = 0
    mode = str(payload.get("mode") or "balanced").strip().lower()
    if mode not in SEARCH_MODES:
        mode = "balanced"
    lang = str(payload.get("lang") or "").strip()
    if lang in ("", "all", "auto"):
        lang = "en"

    raw_search_language = str(payload.get("search_language") or "").strip()
    if raw_search_language.lower() in ("", "auto", "all"):
        raw_search_language = ""
    # the clarify round-trip: "ask" = the gate may fire (first run of a
    # gated mode), "answered"/"skipped" = the user responded -- the run
    # then researches with the confirmed direction (or without one)
    clarify_state = str(payload.get("clarify_state") or "ask").strip().lower()
    if clarify_state not in ("ask", "answered", "skipped"):
        clarify_state = "ask"
    clarifications = str(payload.get("clarifications") or "").strip()[:2000]
    max_rounds = _budget("max_rounds", mode, 2)
    # the pre-flight gate (Vane's skipSearch, narrowed to our contract): a
    # question carrying a URL always researches (the page read IS the
    # research); everything else passes one small completion that skips
    # research only for greetings, chat and writing tasks
    research_needed = bool(_URL_RE.search(q)) or _research_gate(cfg, q)
    # the clarify gate fires on the FIRST run of a gated mode only: a
    # follow-up's history already disambiguates the direction
    if research_needed and mode in _CLARIFY_MODES and clarify_state == "ask" and not history:
        gate = _clarify_gate(cfg, q, lang, mode)
        if gate:
            resp = flask.Response(flask.stream_with_context(_clarify_stream(gate)), mimetype="application/x-ndjson")
            resp.headers["X-Accel-Buffering"] = "no"
            resp.headers["Cache-Control"] = "no-cache"
            return resp
    # the page reader rides only when the browserless block is fully
    # configured: an unconfigured reader simply leaves the tool unregistered
    pages_on = browserless.configured()
    plans: list[str] = []
    if not research_needed:
        # the no-research run: the writer alone -- the zero-tool case of the
        # shared loop (one streamed turn whose prose IS the answer, no
        # executor, no rounds).  The `direct` marker event tells the client
        # to hide the research box for this run.
        state = _Searches(
            sxng_request.preferences, list(sxng_request.user_plugins), sources_base, search_language=raw_search_language
        )
        events: t.Iterator[tuple[str, t.Any]] = itertools.chain(
            (("direct", None),),
            agent.run_agent(
                cfg,
                _writer_messages(q, lang, history, [], [], mode, None, False, sources_base, direct=True),
            ),
        )
    else:
        # the mid-run ask_user escape hatch rides ONLY a first run of the
        # gated modes whose gate passed on asking: if the gate already asked
        # (state=answered) or the user skipped, the direction is settled
        register_ask = mode in _CLARIFY_MODES and clarify_state == "ask"
        # the answer-planning tool rides every run of the structured tiers
        register_plan = mode in _PLAN_MODES
        # the follow-up rewrite (Vane's standalone follow-up): a
        # thread-relative question becomes self-contained before it drives
        # research and writer (the thread still shows the user's own
        # wording; fail-open to the original on any gate failure)
        research_q = (_standalone_question(cfg, q, history, lang) if history else "") or q
        state = _Searches(
            sxng_request.preferences,
            list(sxng_request.user_plugins),
            sources_base,
            search_language=raw_search_language,
            max_rounds=max_rounds,
        )
        events = agent.run_agent(
            cfg,
            _initial_messages(
                research_q,
                lang,
                history,
                sources_base,
                mode,
                max_rounds=max_rounds,
                clarifications=clarifications if clarify_state == "answered" else "",
                clarify_skipped=clarify_state == "skipped",
                register_ask=register_ask,
                page_tool=pages_on,
                plan_tool=register_plan,
            ),
            tools=[_tool_spec(pages_on)]
            + ([_page_spec()] if pages_on else [])
            + ([_ask_user_spec()] if register_ask else [])
            + ([_plan_spec()] if register_plan else []),
            executor=state.execute,
            max_rounds=max_rounds,
            round_progress=_round_progress(state, _budget("stall_rounds", mode, 2)),
            ask_tool=ASK_TOOL if register_ask else None,
            plan_tool=PLAN_TOOL if register_plan else None,
            writer=lambda halt: _writer_messages(
                research_q,
                lang,
                history,
                state.feed,
                plans,
                mode,
                halt,
                state.round_no >= max_rounds,
                sources_base,
                galleries_on=bool(state.gallery_pool),
            ),
        )
    try:
        first = next(events)
    except StopIteration:
        # an upstream that answers 200 with zero events (empty gateways do)
        first = ("error", RuntimeError("upstream returned an empty stream"))
    if first[0] == "error":
        logger.warning("zjsearch_ai_search: upstream failed before the first line: %s", first[1])
        resp = flask.Response(f"AI upstream error: {llm.reason_of(first[1])}", status=502, mimetype="text/plain")
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    # the executor serializes results through Jinja -- keep the request
    # context alive while the response streams
    resp = flask.Response(
        flask.stream_with_context(_generate(first, events, cfg, q, lang, plans, state)), mimetype="application/x-ndjson"
    )
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def install(app: flask.Flask) -> None:
    """Register the AI Search route; chained from the package install.
    Stays off unless ``zjsearch.ai.search.enabled`` and the shared
    transport are fully configured."""
    cfg = llm.ai_cfg()
    if not _enabled():
        return
    if not llm.configured(cfg):
        logger.warning("zjsearch.ai.search is enabled but the transport is missing -- AI search stays off")
        return
    kind = llm.endpoint(cfg)[0]
    package = llm.SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        logger.warning(
            "zjsearch.ai.search: the %r transport needs the %r package -- AI search stays off", kind, package
        )
        return
    app.add_url_rule("/ai/search", "zjsearch_ai_search", _search, methods=["POST"])
