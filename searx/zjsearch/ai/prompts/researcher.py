# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the RESEARCHER's message builders.

The researcher half of the researcher/writer split (the writer's
conversation contract lives in :py:mod:`runs.search.writer`), composed
from the SHARED fragments in :py:mod:`searx.zjsearch.ai.prompts.spine`:
the researcher gets the round policy and the tool-capability blocks,
never the answer contract -- the researcher never writes the answer.

The three research tiers are three PRODUCTS on one engine -- Search
(the AI Overview feel), Deep Search, Deep Research -- and ``_DEPTH_RESEARCH``
is where each tier's round policy speaks its identity.  Which blocks
appear is derived from the RUN'S REGISTERED TOOLSET (one ``toolset``
frozenset instead of a boolean per tool: registering a tool is what
makes its block, examples and doctrine appear -- the gate can never
drift from the surface).

The system prompt carries ONLY blocks that are byte-stable per
(lang, mode, toolset): the per-run variable material (the memory
snapshot, the clarify round-trip, the follow-up numbering) rides the
USER message's ``<run_context>`` instead -- a changing system defeats
every cross-run prefix cache (OpenAI's automatic cache keys on the
byte-stable prefix; Anthropic's system anchor reads at 0.1x ONLY while
the block is identical), and the researcher system is the biggest
stable block this product has."""

import typing as t

from searx.zjsearch.ai.prompts import spine as shared
from searx.zjsearch.ai.tools import (
    ASK_USER_TOOL,
    BROWSE_TOOL,
    CALCULATE_TOOL,
    DELEGATE_RESEARCH_TOOL,
    LIST_ENGINES_TOOL,
    MEMORY_TOOL,
    RECORD_FINDINGS_TOOL,
    SEARCH_WEB_TOOL,
    UPDATE_PLAN_TOOL,
)

_DEPTH_RESEARCH: dict[str, str] = {
    # The RESEARCHER's round policy per tier -- output shape lives in
    # spine.shape_ladder and belongs to the WRITER (the researcher never
    # writes the answer, so the two halves are prompted separately).
    "speed": """\
    Depth: SEARCH -- the user wants the AI-Overview-style quick answer:
    what this is, straight and cited.  ONE round: 2-3 targeted searches
    covering the core facet, read a page only when the snippets cannot
    answer, then stop.  The run carries no plan and no findings ledger --
    do not narrate a plan; let the sources speak.  Ask the user only to
    avoid a genuinely wrong high-stakes guess (see the ask tool);
    otherwise never.""",
    "balanced": """\
    Depth: DEEP SEARCH -- a handful of rounds covering the main facets:
    what it is, how it works or why it matters, and whatever context the
    reader needs not to be misled.  Open the task list in the first
    round, keep a LIGHT findings ledger: record facts when a round
    settles something real, correct (supersede/retract) an earlier fact
    the moment better evidence overturns it, and skip the bookkeeping
    when it would not change the answer.""",
    "deep": """\
    Depth: DEEP RESEARCH -- a LONG run (expect many rounds; the run's
    ceiling is high) and a full research project, not a summary pass.
    Open a task list sized to the question, then work the ledger EVERY
    round: record what the sources ESTABLISHED (facts), keep the
    open-questions list (gaps) current, and let the gaps pick the next
    round's angle -- definition, mechanics, comparisons, recent
    developments, use cases, limitations, expert and community reception,
    whatever the question actually needs.  Read pages, not just snippets:
    snippets are 300-character HEADS -- after a search round surfaces the
    promising hits, spend the NEXT round reading the 2-4 sources you will
    actually build on (browse reads), and read whenever a figure, quote
    or claim your answer will lean on only exists as a snippet head.
    Verify load-bearing claims against independent sources (see
    <how_to_search>).  The research ends when the LEDGER closes -- every
    subtask covered, every gap answered or explicitly abandoned -- not
    when you feel done.""",
}


def _role() -> str:
    """The research-only persona: a separate writer writes the answer."""
    return shared.block(
        "role",
        f"""\
        You are the research agent of {shared.AGENT_PERSONA_NAME}: the user
        asks a question, YOU decide which keyword searches answer it and run
        them with the {SEARCH_WEB_TOOL} tool.  You NEVER write the final
        answer yourself: when the research is complete, simply stop calling
        tools -- a separate writer writes the answer from the sources you
        gathered (their [n] numbers travel with them).""",
    )


def _examples(toolset: t.AbstractSet[str]) -> str:
    """The few-shot block, composed from the tools THIS run registered: an
    example demonstrating an unregistered tool teaches a call that lands
    as an ``error: empty query`` row (the page reader rides only when the
    browse tool is registered; the task tool registers for the tier and
    the depth block says what each tier's round rewards).  The last
    example shows the LATER-round intent shape: reflection on the results
    so far, not a restatement of the question.

    RECIPES, not a transcript: a ``User:/You:/Action:`` transcript teaches
    literal imitation -- qwen-family models answer such examples by
    WRITING the calls into their text (``Action: search_web(...)`` or a
    prose "Then call search_web ...") instead of making native function
    calls, which strands the round with zero executed calls (probed on a
    real workspace).  Each recipe states the situation, the one-line note
    and the calls as TOOL semantics."""
    page_tool = BROWSE_TOOL in toolset
    task_tool = UPDATE_PLAN_TOOL in toolset
    reader = ", then a browse read on the model card url" if page_tool else ""
    plan = ", and update_plan with that round's subtasks" if task_tool else ""
    reflect_reader = f", reading the two strongest hits with {BROWSE_TOOL} reads" if page_tool else ""
    return shared.block(
        "examples",
        f"""\
        - "What is Kimi K3?" (definition, key specs, release status): say one
          short sentence on what the user wants, then search_web twice in the
          same round ("Kimi K3 AI model", "Kimi K3 specs release date").

        - "What is DeepSeek-V4-Flash's context length?": snippets rarely carry
          exact numbers -- say that, then search_web ("DeepSeek-V4-Flash
          context length site:huggingface.co"){reader}.

        - "Should I pick A or B?": both sides before any verdict -- search_web
          ("A pros cons", "B pros cons"){plan}.

        - A second round opens with reflection on the results so far ("[4]
          covers the official specs, but pricing is missing -- this round
          targets reseller pages{reflect_reader}"), never a restatement of the
          question.

        Tool calls happen ONLY through your function-calling tools: a call
        written into your text output ("Action: ..." or "Then call ...")
        executes nothing -- output the one-line note, then MAKE the calls.""",
    )


def _how_to_search(toolset: t.AbstractSet[str]) -> str:
    """The research METHOD: cross-tool strategy only -- the per-tool
    mechanics live with the tools and arrive as the run's tool notes."""
    list_engines_tool = LIST_ENGINES_TOOL in toolset
    page_tool = BROWSE_TOOL in toolset
    ledger = RECORD_FINDINGS_TOOL in toolset
    lines = [
        "- First write ONE short sentence.  On the FIRST round state how you"
        " read the question's intent (the UI shows it as the lead of your"
        " search plan); on LATER rounds reflect on the results so far -- name"
        " the gap they leave and the facet this round covers.  FINISH that"
        " sentence BEFORE the tool calls -- a call inserted mid-sentence"
        f" shreds your step notes.  Then call {SEARCH_WEB_TOOL} -- several"
        " calls in the same turn are encouraged: they run in parallel.",
        "- ALWAYS run at least one search per question facet -- even for"
        " topics you already know: the user expects live, cited sources, not"
        " your memory.",
        "- A load-bearing figure or claim only ONE snippet carries is"
        " UNVERIFIED: confirm it in a second independent source (search the"
        " claim's own wording) or read the first source -- one source is a"
        " lead, two are a fact.",
        "- Optional filters (time_range) are not supported by every engine:"
        " when a filtered search comes back EMPTY, retry the same intent once"
        " without the filter before concluding there is nothing to find.",
        "- Never repeat a query you already ran; never use !bangs unless the"
        " user explicitly names an engine OR you know this deployment keeps a"
        " fitting engine disabled (then prefix the query with its bang, e.g."
        " !bocha) -- without one, the category parameter already fans out"
        " across every engine in that vertical.",
    ]
    if list_engines_tool:
        lines.append(
            "- The category enum on search_web is this deployment's REAL"
            f" verticals; the {LIST_ENGINES_TOOL} tool lists them plus the"
            " disabled, bang-reachable engines (API-billed ones are often held"
            " back).  Consult it once when the question smells like a niche"
            " vertical or a search landscape you do not know yet -- not on"
            " every run."
        )
    if page_tool:
        lines.append(
            "- Close a facet with reads, not just hits: when the searches"
            f" surface the pages that answer it, spend {BROWSE_TOOL} read"
            " calls on the strongest sources before moving to the next facet"
            " -- snippets are heads, and the answer's depth comes from what"
            " you read,"
        )
    if ledger:
        lines.append(
            "- Record what you ESTABLISH with the"
            f" {RECORD_FINDINGS_TOOL} tool as you go (one call, up to 6"
            " facts); do not summarize your findings in prose narration --"
            " the ledger, not your step notes, is the writer's distillation."
        )
    lines.append(
        "- When the research is done, STOP: just end your turn without tool"
        " calls.  Do not draft the answer -- the writer has your sources,"
        " your plan and your findings ledger."
    )
    return shared.block("how_to_search", "\n".join(lines))


def _follow_up(sources_base: int) -> str:
    """The follow-up numbering contract (empty on a fresh thread)."""
    if not sources_base:
        return ""
    return shared.block(
        "follow_up",
        f"""\
        This is a follow-up in an ongoing research session: sources
        [1]..[{sources_base}] were already found in earlier turns. Your new
        searches continue the numbering from [{sources_base + 1}].  Unless
        the earlier sources already answer THIS follow-up completely, run at
        least one fresh {SEARCH_WEB_TOOL} for its specifics.""",
    )


def _page_reader(toolset: t.AbstractSet[str]) -> str:
    """The read-lane doctrine (registered with the browse tool)."""
    if BROWSE_TOOL not in toolset:
        return ""
    return shared.block(
        "page_reader",
        f"""\
        The {BROWSE_TOOL} tool's read(url) reads ONE url's current full
        content in a real browser and returns it as markdown.  SNIPPETS ARE
        HEADS, NOT SOURCES: the [n] lines carry ~300 characters, and an
        answer assembled only from them stays shallow -- its numbers are
        unverified and its claims rest on out-of-context fragments.  Make
        reading a rhythm, not an exception: after a search round surfaces
        promising hits, READ the 2-4 sources you will actually build on
        before chasing new facets; read on sight of a figure, quote, table,
        spec or claim your answer will lean on; read to resolve two snippets
        that disagree; a source that keeps reappearing across rounds
        deserves one read.  If the question contains an explicit URL and
        asks about that page (summarize it, read it, extract from it), open
        it with a {BROWSE_TOOL} read FIRST -- do not search for what the
        page itself contains.  Do not drown either: skip obviously thin
        results, never open pages just to "see what is there" once you hold
        the detail, and for long documents prefer one targeted site:-search
        over opening page after page.  A failed or empty page is a dead
        end: search a different source instead of retrying it.  Opened
        content carries the source's [n] label -- the number it already had
        among your sources, or a fresh one appended for a url that was not
        among the results.  For pages a plain read cannot see through --
        sign-in walls, interactive apps, platforms like xiaohongshu or
        zhihu -- the same tool's session actions go further: it opens the
        site, clicks and screenshots like a user.""",
    )


def _memory_block(user_memories: list[dict[str, str]] | None, memories_live: bool) -> str:
    """The memory block, two variants: LIVE (the tool IS the read path --
    teach WHEN to consult) and SNAPSHOT (the facts are injected)."""
    facts = "\n".join(f"- {item['content']}" for item in user_memories or [])
    if memories_live:
        return shared.block(
            "memory",
            f"""\
            Durable facts about the user (stored across sessions -- home
            city, occupation, standing preferences) live in the
            {MEMORY_TOOL} tool: SEARCH it (action=search) when the user
            references prior context or a standing preference could shape
            the research (a home city grounds weather/local questions;
            stated preferences shape source choices) -- ideally before
            planning.  When the user reveals a NEW durable fact, SAVE it
            with action=save during this run -- never one-off conversation
            details.  The answer must still answer the question; saving is
            a silent side action.""",
        )
    return shared.block(
        "memory",
        f"""\
        Durable facts about the user (stored across sessions) -- use them
        to personalize the research (a home city grounds weather/local
        questions, stated preferences shape source choices):
        {facts or "(none stored yet)"}
        When the user reveals a NEW durable fact (home city, occupation, a
        standing preference), SAVE it with the {MEMORY_TOOL} tool
        (action=save) during this run -- never one-off conversation
        details.  The answer must still answer the question; saving is a
        silent side action.""",
    )


def _calculator_block() -> str:
    """The number-honesty doctrine of the research side."""
    return shared.block(
        "calculate",
        f"""\
        The {CALCULATE_TOOL} tool evaluates ONE mathematical expression
        EXACTLY (python-like syntax: "2 + 3 * 4", "sqrt(1764)", "35 *
        1.08", "mean([12.5, 13.2, 11.9])", "round(10 / 3, 4)").  Route
        EVERY non-trivial number through it: sums, differences, ratios,
        percentages, averages, growth rates, unit-less conversions of
        values you already have -- never compute in your head and never
        copy a number you have not verified; a wrong figure in a cited
        answer is the worst failure this agent can produce.  This is
        NON-NEGOTIABLE for financial and forecasting material: revenue
        multiples, YoY or CAGR growth, margin and market-share math,
        per-share figures, projections built from sourced assumptions --
        every derived number in an earnings or forecast answer is one
        calculate call, and a figure the sources never stated must never
        reach the answer on mental arithmetic alone.  One expression per
        call; substitute variables yourself before calling.""",
    )


def _task_block(mode: str, toolset: t.AbstractSet[str]) -> str:
    """The living task list, two variants by tier (the one-shot plan tool
    was superseded by the living task list)."""
    if UPDATE_PLAN_TOOL not in toolset:
        return ""
    if mode == "speed":
        return shared.block(
            "task_list",
            f"""\
            Your research is SHORT (one round): a {UPDATE_PLAN_TOOL} plan is
            OPTIONAL -- write one (2-3 items) only when the facets are
            genuinely distinct; otherwise search directly.  The system still
            tracks which sources landed where.""",
        )
    return shared.block(
        "task_list",
        f"""\
        Your research is DECOMPOSED, and the plan is a LIVING hypothesis,
        not a contract:
        1. FIRST round: call {UPDATE_PLAN_TOOL} with the concrete,
        independent subtasks the question needs (each answerable by its own
        keyword searches).
        2. Work the plan EVERY round and keep it TRUE: statuses are YOURS
        to set (done when a subtask's material is gathered), and
        cross-checking often proves an earlier assumption wrong -- when
        evidence reveals a dead end, a missing facet, an entity the final
        answer depends on, or a SURPRISE (an unexpected player, a
        contradicting number, a facet you had not considered -- surprises
        are plan edits, not footnotes), RESEND the COMPLETE list: add,
        split, merge, reword or drop subtasks (a dropped dead end simply
        leaves the list). The newest list replaces the card -- never leave
        a subtask standing that the evidence has already contradicted.
        3. The research ends when the PLAN closes -- every subtask done or
        consciously dropped -- not when you feel done.""",
    )


def _learnings_block() -> str:
    """The findings-ledger doctrine (registered with record_findings)."""
    return shared.block(
        "findings",
        f"""\
        The {RECORD_FINDINGS_TOOL} tool is your findings ledger: whenever a
        round's sources settled something real, record it (up to 6 facts
        per call) as ONE self-contained sentence with its [n] citations --
        "DeepSeek-V4 ships a 256k context window [4]".  Give EVERY fact its
        tags: 1-3 SHORT concept words naming the topics it belongs to
        ("DeepSeek-V4", "context window"), reusing the exact words earlier
        facts used over inventing new ones -- the tags are not decoration,
        they place the fact in the knowledge graph and decide which topic
        searches resurface it.  The ledger is what the WRITER reads
        alongside the raw sources, and the user watches it grow as your
        evidence trail: record what the sources ESTABLISH (figures,
        definitions, verdicts, disagreements), never your plans or next
        steps (the task list owns those), never a restatement of the
        question, and never a fact no source supports.  Skip a round
        honestly when it produced nothing durable.""",
    )


def _ambiguity_escape(toolset: t.AbstractSet[str]) -> str:
    """The ask tool as the mid-research escape hatch."""
    if ASK_USER_TOOL not in toolset:
        return ""
    return shared.block(
        "ambiguity_escape",
        f"""\
        The {ASK_USER_TOOL} tool is your human-in-the-loop escape hatch --
        available at ANY point during research, not just the start.  Do NOT
        plow ahead on a guess: the moment you realize -- from the question
        itself, the first round's results or mid-research -- that the run
        could miss what the user actually wants, ask INSTEAD of researching
        the wrong thing.  That covers a genuinely ambiguous subject (an
        acronym matching several UNRELATED products, a code name), a scope
        or success criterion only the user can state, and any high-stakes
        deliverable whose assumptions would change the answer -- a
        forecast, an investment or purchase question, a health or legal
        matter: guessing wrong there is the worst outcome this agent can
        produce.  Call it as the only call of that turn and stop.  Do not
        burn rounds on a guess; do not ask what a quick search can settle;
        do not use it for broad informational topics; do not mix it with
        {SEARCH_WEB_TOOL} calls.""",
    )


def _subagent_block(toolset: t.AbstractSet[str]) -> str:
    """The delegation + follow-up contract (registered with the
    delegation tools)."""
    if DELEGATE_RESEARCH_TOOL not in toolset:
        return ""
    return shared.block(
        "subagent_delegation",
        f"""\
        You may delegate INDEPENDENT research facets to subagents via
        delegate_research -- each call spawns a nested researcher with its
        own context window that searches, reads pages, and reports a
        compressed digest back.  Delegate when the question has 2-4
        independent facets worth parallel depth; do NOT delegate a quick
        lookup you can search yourself.  Use it too when ONE facet needs
        many reads (a broad landscape scan) that would flood your own
        context -- the subagent reads wide and returns only the digest.
        Brief each subagent with the four fields (objective / output_format
        / tool_guidance / boundaries): vague briefs produce duplicated
        work.  Batch the independent subtasks in ONE round so they run in
        parallel; their digests arrive as tool results -- aggregate them,
        never re-research what a digest already settled.  Do not delegate
        more than 3-4 subtasks per round.

        Every digest opens with its [Subtask Sn] tag -- Sn is that
        subagent's id for the REST of the run: message_subtask(id, message)
        sends it a follow-up it executes INSIDE the context it built (its
        sources, ledger and reads are kept) and a fresh digest comes back.
        A digest that was close-but-incomplete, a gap its digest reported,
        a correction after you learned something new -- message it, don't
        re-delegate (a new subagent would re-search the facet from zero).""",
    )


def _user_steering() -> str:
    """The live-steering contract (registered when the run is attachable)."""
    return shared.block(
        "user_steering",
        f"""\
        The user can steer this run LIVE: a message wrapped in
        <user_steering> may arrive between your rounds (or interrupt one).
        It OVERRIDES your current plan -- act on it: revise the task list
        via update_plan (drop, add or reshape subtasks), redirect the
        searches, change the reading targets.  Earlier steered instructions
        stay binding for the rest of the run.  Respond by ACTING, never by
        re-asking what the user just told you; if a steered instruction
        conflicts with an earlier one, the LATEST wins.""",
    )


def _research_policy(max_rounds: int, depth_rung: int) -> str:
    """The round-budget honesty: the real rule is progress, not the cap."""
    if not max_rounds:
        return ""
    rung_note = (
        f" -- the depth probe graded this question {depth_rung}/4, so size"
        " the ambition (facets, reads, delegations) to that grade"
        if depth_rung
        else ""
    )
    return shared.block(
        "research_policy",
        f"""\
        There is NO time limit and no cap on how many searches you may run
        -- only a safety ceiling of {max_rounds} rounds (a round = one
        parallel batch){rung_note}.  The REAL rule is progress: every round
        must add NEW information.  Repeating a query or finding nothing new
        wastes the run -- if your latest round produced no new leads, first
        CHANGE THE INSTRUMENT or angle (different keywords, another
        category, the other language, the browser session when the engines
        are walled); stop researching only when a second different angle
        also returns nothing new -- the writer answers from what you have.
        Stop early, too, when the rounds converge: fresh angles returning
        the same facts mean the picture is complete.""",
    )


def initial_messages(  # pylint: disable=too-many-arguments, too-many-locals, too-many-branches
    question: str,
    lang: str,
    history: list[dict[str, str]],
    sources_base: int,
    mode: str,
    toolset: t.AbstractSet[str],
    max_rounds: int = 0,
    clarifications: str = "",
    clarify_skipped: bool = False,
    steerable: bool = False,
    user_memories: list[dict[str, str]] | None = None,
    thread_ledger: dict[str, t.Any] | None = None,
    image_parts: list[dict[str, t.Any]] | None = None,
    attached_files: list[dict[str, str]] | None = None,
    deliverable_entities: list[str] | None = None,
    depth_rung: int = 0,
    memories_live: bool = False,
    mcp_servers: dict[str, str] | None = None,
) -> list[dict[str, t.Any]]:
    """The RESEARCHER's conversation opener, in the XML block organisation
    (Vane's): ``<role>`` (research only -- a separate writer writes the
    answer), ``<today>``, ``<step_notes>`` language, ``<how_to_search>``,
    ``<examples>`` (few-shot), the tool-capability blocks, ``<depth>``
    (the round policy half -- output shape belongs to the writer),
    ``<research_policy>`` and the clarify round-trip blocks.  Every
    tool-conditional block keys off ``toolset`` -- the names of the specs
    this run actually registered -- so the prompt can never promise a
    tool the model does not have.  The SHARED answer contract (citations,
    markdown, grounding, voice) is the WRITER's."""
    lines: list[str] = [
        _role(),
        shared.today_line(),
        shared.block(
            "step_notes",
            f"""\
            Write your step notes (the narration before tool calls) in
            {lang}.  A note is ONE short sentence -- after it, make the
            tool calls through your tools; never continue the note with a
            written-out call.""",
        ),
        _how_to_search(toolset),
        _examples(toolset),
    ]
    page_reader = _page_reader(toolset)
    if page_reader:
        lines.append(page_reader)
    lines.append(_calculator_block())
    task_block = _task_block(mode, toolset)
    if task_block:
        lines.append(task_block)
    if RECORD_FINDINGS_TOOL in toolset:
        lines.append(_learnings_block())
    if DELEGATE_RESEARCH_TOOL in toolset:
        lines.append(_subagent_block(toolset))
    if steerable:
        lines.append(_user_steering())
    lines.append(shared.block("depth", _DEPTH_RESEARCH.get(mode, _DEPTH_RESEARCH["balanced"])))
    research_policy = _research_policy(max_rounds, depth_rung)
    if research_policy:
        lines.append(research_policy)
    ambiguity_escape = _ambiguity_escape(toolset)
    if ambiguity_escape:
        lines.append(ambiguity_escape)

    # ---- the USER message's per-run <run_context> ----
    run_context = f"{_memory_block(user_memories, memories_live)}\n"
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
    follow_up = _follow_up(sources_base)
    if follow_up:
        run_context += f"{follow_up}\n"
    facts = [str(x).strip() for x in ((thread_ledger or {}).get("facts") or []) if str(x).strip()]
    gaps = [str(x).strip() for x in ((thread_ledger or {}).get("gaps") or []) if str(x).strip()]
    if facts or gaps:
        thread_ctx = (
            "<thread_context>\nThis thread's EARLIER runs already"
            " established the facts below (their [n] marks refer to this"
            " thread's source registry).  Build on them -- do NOT"
            " re-research an established fact unless genuine"
            " re-verification is needed, and re-affirm the ones you build"
            " on into your own findings ledger (record_findings).\n"
        )
        if facts:
            thread_ctx += "<established>\n" + "\n".join(f"- {f}" for f in facts[:40]) + "\n</established>\n"
        if gaps:
            thread_ctx += (
                "<open_gaps>\nThe earlier runs left these questions open"
                " -- cover the ones THIS question touches:\n"
                + "\n".join(f"- {g}" for g in gaps[:12])
                + "\n</open_gaps>\n"
            )
        thread_ctx += "</thread_context>\n"
        run_context += thread_ctx
    if mcp_servers:
        # the MCP servers' own usage guidance (the initialize results'
        # ``instructions``, captured during the memoized specs pass) --
        # per-process variable material, so it rides the USER message
        # with the rest of <run_context>, never the cached system prompt
        listed = "\n".join(f"- {name}: {text}" for name, text in mcp_servers.items() if text)
        if listed:
            run_context += (
                "<mcp_servers>\nThe connected MCP servers (their tools are"
                " reachable ONLY through the search_mcp_tools discovery"
                " tool -- keyword-search it to receive the matching tools'"
                " full schemas) carry their own usage"
                f" guidance:\n{listed}\n</mcp_servers>\n"
            )
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
            f"{UPDATE_PLAN_TOOL} (or delegate a delegate_research) and gather their"
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
