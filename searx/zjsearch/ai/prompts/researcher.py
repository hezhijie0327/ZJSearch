# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the RESEARCHER's message builders.

The researcher half of the researcher/writer split (the writer's
conversation contract lives in :py:mod:`runs.search.writer`), composed from
the SHARED fragments in :py:mod:`searx.zjsearch.ai.prompts.spine` (the
same source both AI features speak, so they cannot drift): the
researcher gets the round policy and the tool-capability blocks, never
the answer contract -- the researcher never writes the answer.  The
stale-run honesty note (the prose the model is told when the gathering
ended early) lives here too: it is the research side's answer to "what
do we tell the model", handed back verbatim by the progress machinery's
stall detector.
"""

import typing as t

from searx.zjsearch.ai.prompts import spine as shared
from searx.zjsearch.ai.tools import (
    ASK_TOOL,
    CALCULATOR_TOOL,
    LEARNINGS_TOOL,
    PAGE_TOOL,
    TASK_TOOL,
    TOOL_NAME,
    WEB_BROWSER_TOOL,
    USER_MEMORY_TOOL,
)

STALL_NOTE = (
    "The research went STALE and ended early: the latest rounds only repeated"
    " earlier queries or returned nothing new.  Where the sources are silent,"
    " apply the grounding rule above."
)

_DEPTH_RESEARCH: dict[str, str] = {
    # The RESEARCHER's round policy per tier -- output shape lives in
    # _DEPTH_SHAPE and belongs to the WRITER (the researcher never writes
    # the answer, so the two halves are prompted separately).
    "speed": "Depth: SPEED -- the user mostly wants to know WHAT this is."
    "  You get ONE round: cover the core facet with 2-3 targeted searches,"
    " read the one or two pages that carry the answer when the snippets"
    " are thin, and stop after it.  task_write is optional here -- a"
    " light 2-3 item plan only when the facets are genuinely distinct"
    " (most speed runs search directly) -- and keep learnings to ONE"
    " final call with the facts that survive.  Ask the user only to"
    " avoid a genuinely wrong high-stakes guess (see the ask tool);"
    " otherwise never.",
    "balanced": "Depth: BALANCED -- a handful of rounds covering the main"
    " facets: what it is, how it works or why it matters, and whatever"
    " context the reader needs not to be misled.  Keep a LIGHT findings"
    " ledger: record facts when a round settles something real, correct"
    " (supersede/retract) an earlier fact the moment better evidence"
    " overturns it, and skip the bookkeeping when it would not change the"
    " answer.",
    "deep": "Depth: DEEP -- a LONG run (expect many rounds; the run's"
    " ceiling is high) and a full research project, not a summary pass."
    "  Open a task list of"
    " up to 8 subtasks, then work the ledger EVERY round: record what the"
    " sources ESTABLISHED (facts), keep the open-questions list (gaps)"
    " current, and let the gaps pick the next round's angle -- definition,"
    " mechanics, comparisons, recent developments, use cases, limitations,"
    " expert and community reception, whatever the question actually needs."
    "  Read pages, not just snippets: snippets are 300-character HEADS --"
    " after a search round surfaces the promising hits, spend the NEXT"
    " round reading the 2-4 sources you will actually build on"
    " (web_reader), and read whenever a figure, quote or claim your"
    " answer will lean on only exists as a snippet head.  Verify"
    " load-bearing claims against independent sources (see"
    " <how_to_search>).  The research ends when the LEDGER"
    " closes -- every subtask covered, every gap answered or explicitly"
    " abandoned -- not when you feel done.",
}


def _examples(page_tool: bool, task_tool: bool) -> str:
    """The few-shot block, composed from the tools THIS run registered: an
    example demonstrating an unregistered tool teaches a call that lands
    as an ``error: empty query`` row (the page reader rides only when a
    reader provider is configured; the task tool registers for every mode
    and the depth block says what each mode's shape rewards).  The last
    example shows the LATER-round intent shape: reflection on the results
    so far, not a restatement of the question.

    RECIPES, not a transcript: a ``User:/You:/Action:`` transcript teaches
    literal imitation -- qwen-family models answer such examples by
    WRITING the calls into their text (``Action: web_search(...)`` or a
    prose "Then call web_search ...") instead of making native function
    calls, which strands the round with zero executed calls (probed on a
    real workspace).  Each recipe states the situation, the one-line note
    and the calls as TOOL semantics."""
    reader = ", then web_reader on the model card url" if page_tool else ""
    plan = ", and task_write with that round's subtasks" if task_tool else ""
    reflect_reader = f", reading the two strongest hits with {PAGE_TOOL}" if page_tool else ""
    lines = [
        "<examples>",
        '- "What is Kimi K3?" (definition, key specs, release status): say one short'
        " sentence on what the user wants, then web_search twice in the same round"
        ' ("Kimi K3 AI model", "Kimi K3 specs release date").',
        "",
        '- "DeepSeek-V4-Flash 的上下文长度是多少？": snippets rarely carry exact'
        ' numbers -- say that, then web_search ("DeepSeek-V4-Flash context length'
        f' site:huggingface.co"){reader}.',
        "",
        f'- "A 和 B 该选哪个？": both sides before any verdict -- web_search ("A 优点 缺点", "B 优点 缺点"){plan}.',
        "",
        "- A second round opens with reflection on the results so far (\"[4] covers"
        " the official specs, but pricing is missing -- this round targets"
        f' reseller pages{reflect_reader}'
        '"), never a restatement of the question.',
        "</examples>",
        "Tool calls happen ONLY through your function-calling tools: a call written"
        " into your text output (\"Action: ...\" or \"Then call ...\") executes"
        " nothing -- output the one-line note, then MAKE the calls.",
    ]
    return "\n".join(lines)


def initial_messages(  # pylint: disable=too-many-arguments, too-many-locals, too-many-branches, too-many-positional-arguments, too-many-statements
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
    task_tool: bool = False,
    browser_tool: bool = False,
    steerable: bool = False,
    subagent_tool: bool = False,
    user_memories: list[dict[str, str]] | None = None,
    image_parts: list[dict[str, t.Any]] | None = None,
    attached_files: list[dict[str, str]] | None = None,
    deliverable_entities: list[str] | None = None,
    depth_rung: int = 0,
) -> list[dict[str, t.Any]]:
    """The RESEARCHER's conversation opener, in the XML block organisation
    (Vane's): ``<role>`` (research only -- a separate writer writes the
    answer), ``<today>``, ``<step_notes>`` language, ``<how_to_search>``,
    ``<examples>`` (few-shot), the tool-capability blocks
    (``<page_reader>``/``<ambiguity_escape>``),
    ``<depth>`` (the round policy half -- output shape belongs to the
    writer), ``<research_policy>`` and the clarify round-trip blocks.
    The SHARED answer contract (citations, markdown, grounding, voice)
    is the WRITER's -- the researcher never writes the answer, so the
    fragments are not repeated here."""
    role = (
        "<role>\n"
        f"You are the research agent of {shared.AGENT_PERSONA_NAME}"
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
            " covers.  FINISH that sentence BEFORE the tool calls -- a call"
            " inserted mid-sentence shreds your step notes.  Then call"
            f" {TOOL_NAME} -- several calls in the same turn are encouraged:"
            " they run in parallel.",
            "- ALWAYS run at least one search per question facet -- even for"
            " topics you already know: the user expects live, cited sources,"
            " not your memory.",
            "- A load-bearing figure or claim only ONE snippet carries is"
            " UNVERIFIED: confirm it in a second independent source (search"
            " the claim's own wording) or read the first source -- one"
            " source is a lead, two are a fact.",
            "- Optional filters (time_range) are not supported by every"
            " engine: when a filtered search comes back EMPTY, retry the"
            " same intent once without the filter before concluding there is"
            " nothing to find.",
            "- Never repeat a query you already ran; never use !bangs unless"
            " the user explicitly names an engine (then prefix the query"
            " with its engine bang, e.g. !baidu) -- without one, the"
            " category parameter already fans out across every engine in"
            " that vertical.",
            (
                "- Close a facet with reads, not just hits: when the searches"
                f" surface the pages that answer it, spend {PAGE_TOOL} calls on"
                " the strongest sources before moving to the next facet --"
                " snippets are heads, and the answer's depth comes from what"
                " you read,"
                if page_tool
                else ""
            ),
            "- Record what you ESTABLISH with the"
            f" {LEARNINGS_TOOL} tool as you go (one call, up to 6 facts);"
            " do not summarize your findings in prose narration -- the"
            " ledger, not your step notes, is the writer's distillation.",
            "- When the research is done, STOP: just end your turn without"
            " tool calls.  Do not draft the answer -- the writer has your"
            " sources, your plan and your findings ledger.",
            "</how_to_search>",
        ]
    )
    # a gated line drops to "" -- keep the bullet list tight
    how_to_search = "\n".join(line for line in how_to_search.split("\n") if line.strip())
    page_reader = ""
    if page_tool:
        browser_note = ""
        if browser_tool:
            browser_note = (
                "  For pages a plain read cannot see through -- sign-in"
                " walls, interactive apps, platforms like xiaohongshu or"
                f" zhihu -- the {WEB_BROWSER_TOOL} session goes further:"
                " it opens the site, clicks and screenshots like a user."
            )
        page_reader = (
            "<page_reader>\n"
            f"The {PAGE_TOOL} tool reads ONE url's current full content in a"
            " real browser and returns it as markdown.  SNIPPETS ARE HEADS,"
            " NOT SOURCES: the [n] lines carry ~300 characters, and an"
            " answer assembled only from them stays shallow -- its numbers"
            " are unverified and its claims rest on out-of-context"
            " fragments.  Make reading a rhythm, not an exception:"
            " after a search round surfaces promising hits, READ the 2-4"
            " sources you will actually build on before chasing new"
            " facets; read on sight of a figure, quote, table, spec or"
            " claim your answer will lean on; read to resolve two"
            " snippets that disagree; a source that keeps reappearing"
            " across rounds deserves one read.  If the question contains"
            " an explicit URL and asks about that page (summarize it,"
            " read it, extract from it), open it with"
            f" {PAGE_TOOL} FIRST -- do not search for what the page itself"
            " contains.  Do not drown either: skip obviously thin"
            " results, never open pages just to \"see what is there\""
            " once you hold the detail, and for long documents prefer"
            " one targeted site:-search over opening page after page."
            "  A failed or empty page is a dead end: search a different"
            " source instead of retrying it.  Opened content carries the"
            " source's [n] label -- the number it already had among your"
            " sources, or a fresh one appended for a url that was not"
            " among the results." + browser_note + "\n</page_reader>"
        )
    facts = "\n".join(f"- {item['content']}" for item in user_memories or [])
    memory_block = (
        "<user_memory>\nDurable facts about the user (stored across"
        " sessions) -- use them to personalize the research (a home city"
        " grounds weather/local questions, stated preferences shape"
        " source choices):\n"
        + (facts or "(none stored yet)")
        + "\nWhen the user reveals a NEW durable fact (home city,"
        " occupation, a standing preference), SAVE it with the"
        f" {USER_MEMORY_TOOL} tool (action=save) during this run -- never"
        " one-off conversation details.  The answer must still answer the"
        " question; saving is a silent side action.\n</user_memory>"
    )
    calculator_block = (
        "<calculator>\n"
        f"The {CALCULATOR_TOOL} tool evaluates ONE mathematical"
        " expression EXACTLY (python-like syntax: \"2 + 3 * 4\","
        ' \"sqrt(1764)\", \"35 * 1.08\", \"mean([12.5, 13.2, 11.9])\",'
        ' \"round(10 / 3, 4)\").  Route EVERY non-trivial number through'
        " it: sums, differences, ratios, percentages, averages, growth"
        " rates, unit-less conversions of values you already have --"
        " never compute in your head and never copy a number you have"
        " not verified; a wrong figure in a cited answer is the worst"
        " failure this agent can produce.  This is NON-NEGOTIABLE for"
        " financial and forecasting material: revenue multiples, YoY or"
        " CAGR growth, margin and market-share math, per-share figures,"
        " projections built from sourced assumptions -- every derived"
        " number in an earnings or forecast answer is one calculator"
        " call, and the answer may state an input the sources never"
        " gave.  One expression per call; substitute variables yourself"
        " before calling.\n</calculator>"
    )
    task_block = ""
    if task_tool:
        if depth == "speed":
            task_block = (
                "<task_list>\nYour research is SHORT (one round): a"
                f" {TASK_TOOL} plan is OPTIONAL -- write one (2-3 items)"
                " only when the facets are genuinely distinct; otherwise"
                " search directly.  The system still tracks which sources"
                " landed where.\n</task_list>"
            )
        else:
            task_block = (
                "<task_list>\nYour research is DECOMPOSED, and the plan is a LIVING"
                " hypothesis, not a contract:\n1. FIRST round: call"
                f" {TASK_TOOL} with 2-4 concrete, independent subtasks (each"
                " answerable by its own keyword searches).\n2. Work the plan"
                " EVERY round and keep it TRUE: statuses are YOURS to set"
                " (done when a subtask's material is gathered), and"
                " cross-checking often proves an earlier assumption wrong --"
                " when evidence reveals a dead end, a missing facet, an"
                " entity the final answer depends on, or a SURPRISE (an"
                " unexpected player, a contradicting number, a facet you"
                " had not considered -- surprises are plan edits, not"
                " footnotes), RESEND the COMPLETE"
                " list: add, split, merge, reword or drop subtasks (a dropped"
                " dead end simply leaves the list). The newest list replaces"
                " the card -- never leave a subtask standing that the"
                " evidence has already contradicted.\n"
                "3. The research ends when the PLAN closes -- every subtask"
                " done or consciously dropped -- not when you feel done.\n</task_list>"
            )
    learnings_block = (
        "<learnings>\n"
        f"The {LEARNINGS_TOOL} tool is your findings ledger: whenever a"
        " round's sources settled something real, record it (up to 6"
        " facts per call) as ONE self-contained sentence with its [n]"
        " citations -- \"DeepSeek-V4 ships a 256k context window [4]\"."
        "  The ledger is what the WRITER reads alongside the raw sources,"
        " and the user watches it grow as your evidence trail: record"
        " what the sources ESTABLISH (figures, definitions, verdicts,"
        " disagreements), never your plans or next steps (the task list"
        " owns those), never a restatement of the question, and never a"
        " fact no source supports.  Skip a round honestly when it"
        " produced nothing durable.\n</learnings>"
    )
    # (the one-shot plan tool was superseded by the living task list -- the
    # task_block carries decomposition + progress for quality/goal)
    ambiguity_escape = ""
    if register_ask:
        ambiguity_escape = (
            "<ambiguity_escape>\n"
            f"The {ASK_TOOL} tool is your human-in-the-loop escape hatch --"
            " available at ANY point during research, not just the start."
            "  Do NOT plow ahead on a guess: the moment you realize -- from"
            " the question itself, the first round's results or"
            " mid-research -- that the run could miss what the user"
            " actually wants, ask INSTEAD of researching the wrong thing."
            "  That covers a genuinely ambiguous subject (an acronym"
            " matching several UNRELATED products, a code name), a scope"
            " or success criterion only the user can state, and any"
            " high-stakes deliverable whose assumptions would change the"
            " answer -- a forecast, an investment or purchase question, a"
            " health or legal matter: guessing wrong there is the worst"
            " outcome this agent can produce.  Call it as the only call of"
            " that turn and stop.  Do not burn rounds on a guess; do not"
            " ask what a quick search can settle; do not use it for broad"
            " informational topics; do not mix it with"
            f" {TOOL_NAME} calls.\n</ambiguity_escape>"
        )
    depth = _DEPTH_RESEARCH.get(depth, _DEPTH_RESEARCH["balanced"])
    # the SYSTEM prompt carries ONLY blocks that are byte-stable per
    # (lang, depth, toolset): the per-run variable material (the memory
    # snapshot, the clarify round-trip, the follow-up numbering) rides the
    # USER message's <run_context> instead -- a changing system defeats
    # every cross-run prefix cache (OpenAI's automatic cache keys on the
    # byte-stable prefix; Anthropic's system anchor reads at 0.1x ONLY
    # while the block is identical), and the researcher system is the
    # biggest stable block this product has
    lines = [
        role,
        shared.today_line(),
        "<step_notes>\nWrite your step notes (the narration before tool"
        f" calls) in {lang}.  A note is ONE short sentence -- after it,"
        " make the tool calls through your tools; never continue the note"
        " with a written-out call.\n</step_notes>",
        how_to_search,
        _examples(page_tool, task_tool),
    ]
    if page_reader:
        lines.append(page_reader)
    lines.append(calculator_block)
    if task_block:
        lines.append(task_block)
    lines.append(learnings_block)

    if subagent_tool:
        lines.append(
            "<subagent_delegation>\nYou may delegate INDEPENDENT research"
            " facets to subagents via research_subtask -- each call spawns a"
            " nested researcher with its own context window that searches,"
            " reads pages, and reports a compressed digest back.  Delegate"
            " when the question has 2-4 independent facets worth parallel"
            " depth; do NOT delegate a quick lookup you can search"
            " yourself.  Use it too when ONE facet needs many reads (a"
            " broad landscape scan) that would flood your own context --"
            " the subagent reads wide and returns only the digest.  Brief"
            " each subagent with the four fields (objective"
            " / output_format / tool_guidance / boundaries): vague briefs"
            " produce duplicated work.  Batch the independent subtasks in"
            " ONE round so they run in parallel; their digests arrive as"
            " tool results -- aggregate them, never re-research what a"
            " digest already settled.  Do not delegate more than 3-4"
            " subtasks per round.\n\nEvery digest opens with its 【子任务 Sn】"
            " tag -- Sn is that subagent's id for the REST of the run:"
            " message_subtask(id, message) sends it a follow-up it executes"
            " INSIDE the context it built (its sources, ledger and reads"
            " are kept) and a fresh digest comes back.  A digest that was"
            " close-but-incomplete, a gap its digest reported, a correction"
            " after you learned something new -- message it, don't"
            " re-delegate (a new subagent would re-search the facet from"
            " zero).\n</subagent_delegation>"
        )

    if steerable:
        lines.append(
            "<user_steering>\nThe user can steer this run LIVE: a message"
            " wrapped in <user_steering> may arrive between your rounds"
            " (or interrupt one).  It OVERRIDES your current plan -- act on"
            " it: revise the task list via task_write (drop, add or reshape"
            " subtasks), redirect the searches, change the reading"
            " targets.  Earlier steered instructions stay binding for the"
            " rest of the run.  Respond by ACTING, never by re-asking what"
            " the user just told you; if a steered instruction conflicts"
            " with an earlier one, the LATEST wins.\n</user_steering>"
        )

    lines.append(f"<depth>\n{depth}\n</depth>")
    if max_rounds:
        lines.append(
            "<research_policy>\nThere is NO time limit and no cap on how"
            f" many searches you may run -- only a safety ceiling of"
            f" {max_rounds} rounds (a round = one parallel batch)"
            + (
                f" -- the depth probe graded this question {depth_rung}/4, so"
                " size the ambition (facets, reads, delegations) to that grade"
                if depth_rung
                else ""
            )
            + ".  The REAL"
            " rule is progress: every round must add NEW information."
            "  Repeating a query or finding nothing new wastes the run -- if"
            " your latest round produced no new leads, first CHANGE THE"
            " INSTRUMENT or angle (different keywords, another category, the"
            " other language, a live SERP through the browser session when"
            " the engines are walled); stop researching only when a second"
            " different angle also returns nothing new -- the writer"
            " answers from what you have.  Stop early, too, when the"
            " rounds converge: fresh angles returning the same facts mean"
            " the picture is complete.\n</research_policy>"
        )
    if ambiguity_escape:
        lines.append(ambiguity_escape)
    run_context = ""
    run_context += f"{memory_block}\n"
    if clarifications:
        run_context += (
            "<clarified>\nThe user already confirmed the research direction"
            " before this run (honor it; do not re-ask):\n"
            f"{clarifications}\n</clarified>\n"
        )
    elif clarify_skipped:
        run_context += (
            "<clarified>\nThe user declined to clarify the direction:"
            " proceed with your best interpretation and cover the plausible"
            " facets.\n</clarified>\n"
        )
    if follow_up:
        run_context += f"{follow_up}\n"
    if image_parts:
        run_context += (
            "<attached_images>\nThe user attached image(s) to this"
            " question.  READ them -- text, charts, products, screenshots --"
            " and factor what they show into your research plan: search for"
            " the entities, figures and context they reveal.  They are"
            " question material, not search results: never treat them as"
            " sources.\n</attached_images>\n"
        )
    deliverable = [str(x) for x in (deliverable_entities or []) if str(x)]
    if deliverable:
        run_context += (
            "<deliverable_entities>\nThe final answer will make claims or"
            " recommendations ABOUT these entities, but the current plan has"
            " NO subtask researching them -- the reader cannot use such"
            " recommendations without knowing what each entity is:\n"
            + "\n".join(f"- {name}" for name in deliverable[:5])
            + "\nAdd a subtask for each via "
            f"{TASK_TOOL} (or delegate a research_subtask) and gather their"
            " basic sourced facts before the research ends.\n</deliverable_entities>\n"
        )
    for file in attached_files or []:
        # 60K = the uploads layer's per-file cap (a framework contract must
        # arrive WHOLE -- the old 30K re-cap cut the 57KB BP framework in
        # half and the run could never cite the rules it never saw)
        text = str(file.get("text") or "")[:60_000]
        trunc = "\n[... the file was truncated ...]" if len(str(file.get("text") or "")) > 60_000 else ""
        run_context += (
            "<attached_file>\nThe user attached this file -- its FULL text"
            " follows.  Factor it into the plan; it is user-provided"
            " material, not a web source.\n"
            f'<file name="{file.get("name") or "attachment.md"}">\n{text}{trunc}\n</file>\n'
            "</attached_file>\n"
        )
    if run_context:
        run_context = f"<run_context>\n{run_context}</run_context>\n"
    user_text = f"{run_context}<q>{question}</q>"
    return shared.build_messages("\n".join(lines), shared.user_message(user_text, image_parts), history)
