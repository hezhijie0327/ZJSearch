# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the RESEARCHER's message builders.

The researcher half of the researcher/writer split (the writer's
conversation contract lives in :py:mod:`runs.search.writer`), composed
from the SHARED fragments in :py:mod:`searx.zjsearch.ai.prompts.spine`:
the researcher gets the round policy and the cross-tool METHOD, never
the answer contract -- the researcher never writes the answer.

THE TWO PROMPT CHANNELS: this builder owns only what spans tools -- the
persona, the method, the tier's round policy, the few-shot recipes.
Each tool's own doctrine (how to search like a human, the reading
rhythm, the ledger semantics, the delegation rules) lives in its
package's ``INSTRUCTIONS`` constant and arrives here as ``tool_notes``
(the registered tools' entries from ``tools.TOOL_INSTRUCTIONS``, in
registration order) -- the MCP server-instructions pattern applied to
the internal tools, so a tool's doctrine exists in exactly one place
and disappears from the prompt exactly when the tool leaves the
surface.

The three research tiers are three PRODUCTS on one engine -- Search
(the AI Overview feel), Deep Search, Deep Research -- and ``_DEPTH_RESEARCH``
is where each tier's round policy speaks its identity.  Which blocks
appear is derived from the RUN'S REGISTERED TOOLSET (one ``toolset``
frozenset instead of a boolean per tool: registering a tool is what
makes its block and examples appear -- the gate can never drift from
the surface).

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
    BROWSE_TOOL,
    DELEGATE_RESEARCH_TOOL,
    RECALL_HISTORY_TOOL,
    RECORD_FINDINGS_TOOL,
    SEARCH_WEB_TOOL,
    SET_DELIVERABLE_TOOL,
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
    answer, then stop.  No plan, no gap-chasing -- do not narrate a plan;
    let the sources speak.  One LIGHT ledger write: before the round
    ends, record the round's key facts with record_findings (1-3 concept
    tags each -- they name the run's topics in the knowledge graph).
    Ask the user only to avoid a genuinely wrong high-stakes guess (see
    the ask tool); otherwise never.""",

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
    whatever the question actually needs.  Read pages, not just snippets
    (the browse tool's doctrine says when); verify load-bearing claims
    BOTH ways -- confirm against an independent source and disconfirm
    against the claim's critics (see <how_to_search>).  The research ends
    when the LEDGER closes -- every subtask covered, every gap answered
    or explicitly abandoned -- not when you feel done.""",
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


def _examples(toolset: t.AbstractSet[str], mode: str) -> str:
    """The few-shot block, composed from the tools THIS run registered
    (an example demonstrating an unregistered tool teaches a call that
    lands as an ``error: empty query`` row) and from the tier (the
    disconfirming-search recipe rides the same ``mode != "speed"`` gate
    as the method block's rule -- an example teaching a second-round
    behavior must not contradict the speed tier's one-round policy).  The
    last example shows the LATER-round intent shape: reflection on the
    results so far, not a restatement of the question.

    RECIPES, not a transcript: a ``User:/You:/Action:`` transcript teaches
    literal imitation -- qwen-family models answer such examples by
    WRITING the calls into their text (``Action: search_web(...)`` or a
    prose "Then call search_web ...") instead of making native function
    calls, which strands the round with zero executed calls (probed on a
    real workspace).  Each recipe states the situation, the one-line note
    and the calls as TOOL semantics."""
    page_tool = BROWSE_TOOL in toolset
    task_tool = UPDATE_PLAN_TOOL in toolset
    delegating = DELEGATE_RESEARCH_TOOL in toolset
    reader = ", then a browse read on the model card url" if page_tool else ""
    plan = ", and update_plan with that round's subtasks" if task_tool else ""
    reflect_reader = f", reading the two strongest hits with {BROWSE_TOOL} reads" if page_tool else ""
    disconfirm = (
        ""
        if mode == "speed"
        else """
        - A figure the answer will LEAN ON ("Company X's Q3 revenue"):
          confirm it in a second INDEPENDENT source and hunt the
          disconfirming angle in the same round -- search_web ("Company X
          Q3 revenue", "Company X Q3 revenue wrong OR corrected") --
          silence from the second call is what earns confidence.
"""
    )
    delegate = (
        ""
        if not delegating
        else f"""
        - A subtask that is its own deep dive ("compare the top three
          vector databases") while the other facets stay yours:
          delegate_research (title a 4-12 word label, objective the exact
          question with entities and constraints named, output_format the
          digest shape you need, tool_guidance where to look, boundaries
          what the other subtasks own) -- and keep researching YOUR facets
          in the same round; the digest returns as a <task_result>.
"""
    )
    deliverable = (
        ""
        if SET_DELIVERABLE_TOOL not in toolset
        else """
        - A request that names a DELIVERABLE ("write a research report
          on X", "give me a briefing deck"): set_deliverable (report /
          deck) in the FIRST round, then research exactly as usual --
          every source you gather is what a section will cite; the
          document is written at the write phase, not by the call.
"""
    )
    return shared.block(
        "examples",
        f"""\
        - "What is Kimi K3?" (definition, key specs, release status): say one
          short sentence on what the user wants, then search_web twice in the
          same round ("Kimi K3 AI model", "Kimi K3 specs release date").

        - "What is DeepSeek-V4-Flash's context length?": snippets rarely carry
          exact numbers -- say that, then search_web ("DeepSeek-V4-Flash
          context length site:huggingface.co"){reader}.
{disconfirm}
        - "Should I pick A or B?": both sides before any verdict -- search_web
          ("A pros cons", "B pros cons"){plan}.
{deliverable}
{delegate}
        - A second round opens with reflection on the results so far ("[4]
          covers the official specs, but pricing is missing -- this round
          targets reseller pages{reflect_reader}"), never a restatement of the
          question.

        Tool calls happen ONLY through your function-calling tools: a call
        written into your text output ("Action: ..." or "Then call ...")
        executes nothing -- output the one-line note, then MAKE the calls.""",
    )


def _how_to_search(mode: str) -> str:
    """The research METHOD: what spans every tool -- the step-note
    language, the facet discipline, the verification bar, the stop
    condition.  Per-tool craft lives in the tools' own INSTRUCTIONS and
    arrives as <tool_notes>.  The verification bar is TWO-SIDED: the
    independence and recency rules bind every tier (they cost no extra
    search -- they judge the results already in hand), the disconfirming
    search binds the multi-round tiers only (the speed tier's one round
    cannot afford it)."""
    disconfirm = (
        ""
        if mode == "speed"
        else f"""\
        - Confirmation is not verification: run ONE DISCONFIRMING search
          per load-bearing claim -- the claim's negation or its controversy
          ("<entity> <figure> wrong", "<entity> criticism / debunk /
          scandal").  Not per fact: only the claims the answer will LEAN
          ON.  Silence from the disconfirming angle is what earns
          confidence; a hit means the claim needs a second look before you
          build on it.
        """
    )
    return shared.block(
        "how_to_search",
        f"""\
        - First write ONE short sentence.  On the FIRST round state how you
          read the question's intent (the UI shows it as the lead of your
          search plan); on LATER rounds reflect on the results so far -- name
          the gap they leave and the facet this round covers.  FINISH that
          sentence BEFORE the tool calls -- a call inserted mid-sentence
          shreds your step notes.  Then call {SEARCH_WEB_TOOL} -- several
          calls in the same turn are encouraged: they run in parallel.
        - ALWAYS run at least one search per question facet -- even for
          topics you already know: the user expects live, cited sources, not
          your memory.
        - A load-bearing figure or claim only ONE snippet carries is
          UNVERIFIED: confirm it in a second INDEPENDENT source (search the
          claim's own wording) or read the first source -- one source is a
          lead, two are a fact.  Independence is about lineage, not count:
          two outlets running the same press release are ONE source.  When
          the wording matches too well, search the claim in other words,
          another language or another category to break the echo.
        {disconfirm}- Volatile facts (prices, versions, rankings, anything
          "latest") age: when two dates disagree, the NEWER source wins --
          record the supersession, never average the figures.
        - When the research is done, STOP: just end your turn without tool
          calls.  Do not draft the answer -- the writer has your sources,
          your plan and your findings ledger.""",
    )


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


def _memory_block(user_memories: list[dict[str, str]] | None) -> str:
    """The memory SNAPSHOT (data, not doctrine -- the tool's own
    INSTRUCTIONS carry the when-to-consult/save rules): the user's
    stored facts, confirmed procedures, search lessons and open gaps as
    injected by the client, or the live variant's notice that the store
    must be searched."""
    rows = user_memories or []
    by_kind: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_kind.setdefault(str(row.get("kind") or "fact"), []).append(row)
    facts = by_kind.get("fact", [])
    procedures = by_kind.get("procedure", [])
    lessons = by_kind.get("lesson", [])
    gaps = by_kind.get("gap", [])

    def lines(items: list[dict[str, str]]) -> str:
        return "\n".join(f"- {m['content']}" for m in items)

    body = f"""\
    Durable facts (stored across sessions) -- use them to personalize
    the research (a home city grounds weather/local questions, stated
    preferences shape source choices; entity facts are the user's
    tracked people/companies):
    {lines(facts) or "(none stored yet -- the memory tool's search is the read path)"}"""
    if procedures:
        body += f"""

        Standing PROCEDURES -- how the user wants research done (learned
        across sessions; honor them):
        {lines(procedures)}"""
    if lessons:
        body += f"""

        SEARCH LESSONS -- what worked before on these topics; try these
        angles before brute-forcing:
        {lines(lessons)}"""
    if gaps:
        body += f"""

        OPEN QUESTIONS (the backlog -- earlier runs could not answer
        these): if THIS run resolves one, answer it and FORGET the
        memory; if it can advance one, advance it:
        {lines(gaps)}"""
    return shared.block("memory", body)


def _episodes_block(episodes: list[dict[str, str]] | None) -> str:
    """The EPISODIC lane (data, not doctrine): the user's recent
    cross-thread research -- a returning question continues instead of
    restarts.  Same-thread continuity rides <thread_context> instead."""
    rows = [e for e in (episodes or []) if str(e.get("title") or "").strip()]
    if not rows:
        return ""
    lines = "\n".join(
        f"- {e['title']}" + (f" -- {str(e.get('preview') or '').strip()}" if str(e.get("preview") or "").strip() else "")
        for e in rows
    )
    return shared.block(
        "episodes",
        f"""\
        The user's RECENT research (other threads, roughly the last two
        weeks) -- if THIS question continues one of these, build on it
        instead of starting over ({RECALL_HISTORY_TOOL} retrieves their
        sources; do not re-derive what the user already has):
        {lines}""",
    )


def _user_steering() -> str:
    """The live-steering contract (registered when the run is attachable)."""
    return shared.block(
        "user_steering",
        """\
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


def _tool_notes(notes: list[tuple[str, str]] | None) -> str:
    """The registered tools' own doctrine (the MCP server-instructions
    pattern for internal tools) -- the shared renderer in
    :func:`spine.tool_notes`.  Byte-stable per toolset, so it lives in
    the cached system prompt."""
    return shared.tool_notes(notes or [])


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
    episodes: list[dict[str, str]] | None = None,
    image_parts: list[dict[str, t.Any]] | None = None,
    attached_files: list[dict[str, str]] | None = None,
    deliverable_entities: list[str] | None = None,
    depth_rung: int = 0,
    memories_live: bool = False,
    mcp_servers: dict[str, str] | None = None,
    tool_notes: list[tuple[str, str]] | None = None,
    tz: str | None = None,
    overview_context: str | None = None,
) -> list[dict[str, t.Any]]:
    """The RESEARCHER's conversation opener, in the XML block organisation
    (Vane's): ``<role>`` (research only -- a separate writer writes the
    answer), ``<today>``, ``<step_notes>`` language, ``<how_to_search>``,
    ``<examples>`` (few-shot), ``<tool_notes>`` (the registered tools'
    own doctrine), ``<depth>`` (the round policy half -- output shape
    belongs to the writer), ``<research_policy>`` and the clarify
    round-trip blocks.  Every tool-conditional block keys off
    ``toolset`` -- the names of the specs this run actually registered
    -- so the prompt can never promise a tool the model does not have.
    The SHARED answer contract (citations, markdown, grounding, voice)
    is the WRITER's."""
    lines: list[str] = [
        _role(),
        shared.today_line(tz),
        shared.block(
            "step_notes",
            f"Write your step notes (the narration before tool calls) in {lang}.  A note is ONE short sentence -- after it, make the tool calls through your tools; never continue the note with a written-out call.",
        ),
        _how_to_search(mode),
        _examples(toolset, mode),
    ]
    tool_notes_block = _tool_notes(tool_notes)
    if tool_notes_block:
        lines.append(tool_notes_block)
    lines.append(shared.block("depth", _DEPTH_RESEARCH.get(mode, _DEPTH_RESEARCH["balanced"])))
    research_policy = _research_policy(max_rounds, depth_rung)
    if research_policy:
        lines.append(research_policy)
    if steerable:
        lines.append(_user_steering())

    # ---- the USER message's per-run <run_context> ----
    # init FIRST, then append-only: the clarified blocks used to `+=` on
    # an unassigned name (an UnboundLocalError on every clarify run) and
    # the memory block's plain assignment below them silently DISCARDED
    # what they had built
    run_context = ""
    if clarifications:
        run_context += (
            shared.block(
                "clarified",
                f"The user already confirmed the research direction before this run (honor it; do not re-ask):\n{clarifications}",
            )
            + "\n"
        )
    elif clarify_skipped:
        run_context += (
            shared.block(
                "clarified",
                'The user declined to clarify the direction: proceed with your best interpretation and cover the plausible facets.',
            )
            + "\n"
        )
    run_context += f"{_memory_block(None if memories_live else user_memories)}\n"
    episodes_block = _episodes_block(episodes)
    if episodes_block:
        run_context += f"{episodes_block}\n"
    if overview_context:
        # THE OVERVIEW TIER's first turn: the classic results page's own
        # sources ride in as the seeded registry -- the answer cites them
        # positionally; no search tool exists on this tier to re-find them
        run_context += (
            shared.block(
                "sources",
                f"""\
                The results page ALREADY shows the user these sources --
                the answer must build on them and cite them by their [n]
                marks (the browse read may open one in full when the
                answer needs more than the snippet):
                {overview_context}""",
            )
            + "\n"
        )
    follow_up = _follow_up(sources_base)
    if follow_up:
        run_context += f"{follow_up}\n"
    facts = [str(x).strip() for x in ((thread_ledger or {}).get("facts") or []) if str(x).strip()]
    gaps = [str(x).strip() for x in ((thread_ledger or {}).get("gaps") or []) if str(x).strip()]
    if facts or gaps:
        ledger_note = (
            " Re-affirm the ones you build on into your own findings ledger"
            f" ({RECORD_FINDINGS_TOOL})."
            if RECORD_FINDINGS_TOOL in toolset
            else ""
        )
        established = "\n".join(f"- {f}" for f in facts[:40])
        gap_lines = "\n".join(f"- {g}" for g in gaps[:12])
        body = f"""\
        This thread's EARLIER runs already established the facts below
        (their [n] marks refer to this thread's source registry).  Build on
        them -- do NOT re-research an established fact unless genuine
        re-verification is needed.{ledger_note}"""
        if facts:
            body += "\n" + shared.block("established", established)
        if gaps:
            body += "\n" + shared.block(
                "open_gaps",
                f"""\
                The earlier runs left these questions open -- cover the
                ones THIS question touches:
                {gap_lines}""",
            )
        run_context += shared.block("thread_context", body) + "\n"
    if mcp_servers:
        # the MCP servers' own usage guidance (the initialize results'
        # ``instructions``, captured during the memoized specs pass) --
        # per-process variable material, so it rides the USER message
        # with the rest of <run_context>, never the cached system prompt.
        # (The internal tools' instructions are registry constants --
        # they live in the system prompt's <tool_notes> instead.)
        listed = "\n".join(f"- {name}: {text}" for name, text in mcp_servers.items() if text)
        if listed:
            run_context += (
                shared.block(
                    "mcp_servers",
                    f"""\
                    The connected MCP servers (their tools are reachable
                    ONLY through the search_tools discovery tool --
                    keyword-search it to receive the matching tools' full
                    schemas) carry their own usage guidance:
                    {listed}""",
                )
                + "\n"
            )
    if image_parts:
        run_context += (
            shared.block(
                "attached_images",
                """\
                The user attached image(s) to this question.  READ them --
                text, charts, products, screenshots -- and factor what they
                show into your research plan: search for the entities,
                figures and context they reveal.  They are question
                material, not search results: never treat them as
                sources.""",
            )
            + "\n"
        )
    deliverable = [str(x) for x in (deliverable_entities or []) if str(x)]
    if deliverable:
        entity_lines = "\n".join(f"- {name}" for name in deliverable[:5])
        run_context += (
            shared.block(
                "deliverable_entities",
                f"""\
                The final answer will make claims or recommendations ABOUT
                these entities, but the current plan has NO subtask
                researching them -- the reader cannot use such
                recommendations without knowing what each entity is:
                {entity_lines}
                Add a subtask for each via {UPDATE_PLAN_TOOL} (or delegate
                a delegate_research) and gather their basic sourced facts
                before the research ends.""",
            )
            + "\n"
        )
    for file in attached_files or []:
        # 60K = the uploads layer's per-file cap (a framework contract must
        # arrive WHOLE -- the old 30K re-cap cut the 57KB BP framework in
        # half and the run could never cite the rules it never saw)
        text = str(file.get("text") or "")[:60_000]
        trunc = "\n[... the file was truncated ...]" if len(str(file.get("text") or "")) > 60_000 else ""
        name = file.get("name") or "attachment.md"
        run_context += (
            shared.block(
                "attached_file",
                f"""\
                The user attached this file -- its FULL text follows.
                Factor it into the plan; it is user-provided material, not
                a web source.
                <file name="{name}">
                {text}{trunc}
                </file>""",
            )
            + "\n"
        )
    if run_context:
        run_context = f"<run_context>\n{run_context}</run_context>\n"
    user_text = f"{run_context}{shared.block('q', question)}"
    return shared.build_messages("\n".join(lines), shared.user_message(user_text, image_parts), history)
