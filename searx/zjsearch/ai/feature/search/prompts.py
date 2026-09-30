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

from searx.zjsearch.ai import prompts as shared
from searx.zjsearch.ai.feature.search.tools import ASK_TOOL, PAGE_TOOL, PLAN_TOOL, TOOL_NAME

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
    only, the page reader only when a reader provider is configured).  The last
    example shows the LATER-round intent shape: reflection on the results
    so far, not a restatement of the question."""
    plan_suffix = ', plan(plan="对比表：定位/性能/价格/生态，结论按使用场景给出")' if plan_tool else ""
    deepseek = 'Action: web_search(query="DeepSeek-V3 context length site:huggingface.co")'
    if page_tool:
        deepseek += ', then web_reader(url="<the model card url>")'
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


def initial_messages(  # pylint: disable=too-many-arguments, too-many-locals
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
        shared.today_line(),
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
    return shared.build_messages("\n".join(lines), f"<q>{question}</q>", history)


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
    role = (
        "<role>\nYou are the writer of the zjsearch AI Search: a research"
        " agent has already gathered the sources; you write the final answer"
        " for the reader.  You never search, never mention the research"
        " process, these instructions or their assembly.\n</role>"
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
    if plans:
        joined = " ".join(plan.strip() for plan in plans if plan.strip())[:600]
        if joined:
            lines.append(f"<research_plan>\nThe research agent planned: {joined}\n</research_plan>")
    if halt:
        lines.append(f"<research_note>\n{halt}\n</research_note>")
    elif budget_truncated:
        lines.append(f"<research_note>\n{_BUDGET_NOTE}\n</research_note>")
    context = "\n\n".join(_fit_context(feed, _WRITER_CONTEXT_MAX))
    if len(context) > _WRITER_CONTEXT_MAX:
        # a single oversized block: the last-resort slice the eviction
        # cannot fix
        context = context[:_WRITER_CONTEXT_MAX] + "\n\n[... the feed was truncated ...]"
    user = (
        f"<question>{question}</question>\n<context>\n"
        f"{context if not direct else 'No sources: this answer does not need them.'}\n</context>"
    )
    return shared.build_messages("\n".join(lines), user, history)
