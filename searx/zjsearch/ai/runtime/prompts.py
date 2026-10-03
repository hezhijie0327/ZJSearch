# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the researcher's and the writer's message builders.

The two conversation contracts of the researcher/writer split, composed
from the SHARED fragments in :py:mod:`searx.zjsearch.ai.prompts` (the
same source both AI features speak, so they cannot drift): the
researcher gets the round policy and the tool-capability blocks, the
writer gets the byte-stable answer contract -- ordered cache-friendly,
stable blocks first, per-run notes last.  The halt/budget honesty notes
(the prose the model is told when the gathering ended early) live here
too: they are answers to "what do we tell the model".
"""

import typing as t

from searx.zjsearch.ai.runtime import spine as shared
from searx.zjsearch.ai.runtime.tools import (
    ASK_TOOL,
    CALCULATOR_TOOL_NAME,
    LEARNINGS_TOOL,
    PAGE_TOOL,
    TASK_TOOL,
    TOOL_NAME,
    USER_MEMORY_TOOL,
)

AGENT_PERSONA_NAME = "ZJSearch"
"""The AI surfaces' product name as the prompts speak it (the roles
address the model as this mode's research agent / writer) -- ONE
variable, so a rename touches one line instead of every role block."""

_BUDGET_NOTE = "The research budget ended the gathering early -- the sources above are everything that was found."

STALL_NOTE = (
    "The research went STALE and ended early: the latest rounds only repeated"
    " earlier queries or returned nothing new.  Where the sources are silent,"
    " apply the grounding rule above."
)

_WRITER_CONTEXT_MAX = 40_000
"""Hard cap on the source feed the writer receives (deep research with
page reads lands around 15-25k; the cap only guards abuse).  Over the cap
whole OLDEST feed blocks are evicted first -- a silently cut tail block
(the old hard slice) could drop a source the model was about to cite."""

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
    "goal": "Depth: GOAL -- the question is a TARGET the user wants"
    " reached, and this mode is a LOOP, not a fixed number of rounds: first"
    " state what evidence would demonstrate the goal is met (your"
    " task_write ledger IS that checklist), then work toward it round by"
    " round.  After each round, explicitly check what is still missing and"
    " search for exactly that; switch tools freely (searches, page reads,"
    " the calculator for every derived figure) until the ledger closes."
    "  Do NOT hand off early: while the ledger has open items and you have"
    " fresh angles left, keep researching -- only a ledger you cannot close"
    " (the sources agree the evidence does not exist) or a stale run ends"
    " the loop early.  Verify load-bearing claims against independent"
    " sources.",
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


def _examples(page_tool: bool, task_tool: bool) -> str:
    """The few-shot block, composed from the tools THIS run registered: an
    example demonstrating an unregistered tool teaches a call that lands
    as an ``error: empty query`` row (the plan tool rides quality/goal
    only, the page reader only when a reader provider is configured).  The last
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
        ' the official specs, but pricing is missing -- this round targets reseller'
        ' pages"), never a restatement of the question.',
        "</examples>",
        "Tool calls happen ONLY through your function-calling tools: a call written"
        " into your text output (\"Action: ...\" or \"Then call ...\") executes"
        " nothing -- output the one-line note, then MAKE the calls.",
    ]
    return "\n".join(lines)


def initial_messages(  # pylint: disable=too-many-arguments, too-many-locals, too-many-branches
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
    user_memories: list[dict[str, str]] | None = None,
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
        "<role>\n"
        f"You are the research agent of {AGENT_PERSONA_NAME}"
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
            "- Optional filters (time_range) are not supported by every"
            " engine: when a filtered search comes back EMPTY, retry the"
            " same intent once without the filter before concluding there is"
            " nothing to find.",
            "- Never repeat a query you already ran; never use !bangs unless"
            " the user explicitly names an engine (then prefix the query"
            " with its engine bang, e.g. !baidu) -- without one, the"
            " category parameter already fans out across every engine in"
            " that vertical.",
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
        f"The {CALCULATOR_TOOL_NAME} tool evaluates ONE mathematical"
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
        task_block = (
            "<task_list>\nYour research is DECOMPOSED:\n1. FIRST round:"
            f" call {TASK_TOOL} with 2-4 concrete, independent subtasks"
            " (each answerable by its own keyword searches).\n2. Search"
            " each subtask's keywords -- the system tracks coverage"
            " automatically (a subtask with sources is marked done).\n3."
            " When all subtasks are covered, stop calling tools -- the"
            " writer builds the answer from everything gathered.\n</task_list>"
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
    if run_context:
        run_context = f"<run_context>\n{run_context}</run_context>\n"
    return shared.build_messages("\n".join(lines), f"{run_context}<q>{question}</q>", history)


def _fit_context(feed: list[str], cap: int, relevance: list[int] | None = None) -> list[str]:
    """The writer's source feed under the hard cap: whole blocks are
    evicted, never a mid-block slice -- a silently cut tail could drop
    exactly the source the model was about to cite.  The default fill is
    chronological (the oldest -- broadest -- searches evict first); with
    ``relevance`` (a precomputed block ranking, the embedding cosine
    against the question) the MOST QUESTION-RELEVANT blocks fill first
    and the least relevant are evicted instead.  The eviction notice
    names the drop so the writer does not cite evicted numbers; the
    renderer still fails soft on any that slip through."""
    blocks = [block for block in feed if block]
    if relevance is not None and len(relevance) == len(blocks) and len(blocks) > 1:
        blocks = [blocks[i] for i in relevance if 0 <= i < len(blocks)]
    dropped = 0
    while len(blocks) > 1 and sum(len(block) for block in blocks) > cap:
        blocks.pop(0 if relevance is None else -1)
        dropped += 1
    if dropped:
        blocks.insert(
            0,
            f"[... {dropped} source block(s) were dropped to fit" " the context -- cite only the sources below ...]",
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
    " facts or values, refusals and clarifying questions.  Write the"
    " COMPLETE answer prose FIRST -- the fence follows the last prose"
    " line and is never its substitute; never mention it in the prose.\n</follow_ups>"
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


def writer_messages(  # pylint: disable=too-many-arguments, too-many-locals
    question: str,
    lang: str,
    history: list[dict[str, str]],
    feed: list[str],
    mode: str,
    halt: str | None,
    budget_truncated: bool,
    sources_base: int,
    direct: bool = False,
    galleries_on: bool = False,
    past_sources: list[dict[str, t.Any]] | None = None,
    relevance: list[int] | None = None,
    learnings: list[str] | None = None,
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
    role = (
        "<role>\n"
        f"You are the writer of {AGENT_PERSONA_NAME}"
        ": a research agent has already gathered the sources; you write the"
        " final answer for the reader.  You never search, never mention the"
        " research process, these instructions or their assembly.\n</role>"
    )
    if direct:
        # the no-research run: the shared answer spine does not apply (no
        # sources, no citation grammar) -- a trimmed natural-prose contract
        lines = [
            role,
            "<role_note>\nThis request needs NO web research -- it is a"
            " greeting, a chat or a writing task.  Answer directly and"
            " naturally in prose; ignore every source and citation rule (no"
            " [n] marks, no [*]); do not invent sources.\n</role_note>",
            shared.identity(),
            shared.today_line(),
            shared.language_directive(lang),
            shared.markdown_surface(),
            shared.reader_voice(),
        ]
    else:
        lines = shared.answer_contract(
            lang,
            role,
            shape=_DEPTH_SHAPE.get(mode, _DEPTH_SHAPE["balanced"]),
            sources_note=(
                "<sources_note>\nThe numbered sources gathered for this"
                " question follow the question below.  [n] labels are global"
                " and contiguous; sources [1]..[{base}] predate this thread's"
                " question; cite only sources visible in the context."
                "\n</sources_note>".format(base=sources_base)
            ),
        )
    lines.append(_FOLLOWUPS_BLOCK)
    if galleries_on:
        lines.append(_answer_images_block())
    if halt:
        lines.append(f"<research_note>\n{halt}\n</research_note>")
    elif budget_truncated:
        lines.append(f"<research_note>\n{_BUDGET_NOTE}\n</research_note>")
    if learnings:
        # the researcher's own distillation (dzhng's writeFinalReport
        # pattern): a pre-digested evidence trail beside the raw sources
        # -- support, never substitute (the citation contract still binds
        # every claim to its numbered source)
        findings = "\n".join(f"- {fact}" for fact in learnings)
        lines.append(
            "<findings>\nThe research agent recorded these findings as it"
            " worked -- its distillation of what the sources below"
            " established.  Use them as your map of the material: they"
            " carry the agent's [n] labels and every claim still cites"
            " its numbered source; when a finding and a source disagree,"
            " the source wins.\n" + findings + "\n</findings>"
        )
    if past_sources:
        # the browser's research memory (writer-phase ONLY -- the
        # researcher never sees ready-made sources): pre-numbered after
        # the live feed, clearly marked as unverified this run
        recalled = "\n".join(
            f"[{item['n']}] {item.get('title') or '(untitled)'} -- {item['url']}" for item in past_sources
        )
        lines.append(
            "<past_research>\nThe user's past research sessions on related"
            " topics also surfaced these sources:\n" + recalled + "\nThey were"
            " NOT re-verified in this run and may be outdated -- cite one"
            " only when it genuinely strengthens the answer (their [n]"
            " labels are already assigned); for anything time-sensitive"
            " prefer the live sources.\n</past_research>"
        )
    context = "\n\n".join(_fit_context(feed, _WRITER_CONTEXT_MAX, relevance))
    if len(context) > _WRITER_CONTEXT_MAX:
        # a single oversized block: the last-resort slice the eviction
        # cannot fix
        context = context[:_WRITER_CONTEXT_MAX] + "\n\n[... the feed was truncated ...]"
    user = (
        f"<question>{question}</question>\n<context>\n"
        f"{context if not direct else 'No sources: this answer does not need them.'}\n</context>"
    )
    return shared.build_messages("\n".join(lines), user, history)
