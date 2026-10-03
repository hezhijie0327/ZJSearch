# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the WRITER's message builders.

The writer half of the researcher/writer split (the researcher's
conversation opener lives in :py:mod:`runtime.researcher`), composed
from the SHARED fragments in :py:mod:`searx.zjsearch.ai.runtime.spine`
(the same source both AI features speak, so they cannot drift): the
byte-stable answer contract -- ordered cache-friendly, stable blocks
first, per-run notes last.  The budget honesty note (the prose the
model is told when the gathering ended early) lives here too: it is the
writer side's answer to "what do we tell the model".
"""

import typing as t

from searx.zjsearch.ai.runtime import spine as shared
from searx.zjsearch.ai.runtime.context import _fit_context, writer_context_max

_BUDGET_NOTE = "The research budget ended the gathering early -- the sources above are everything that was found."

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
    learnings: list[dict[str, t.Any]] | None = None,
    gaps: list[dict[str, t.Any]] | None = None,
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
        f"You are the writer of {shared.AGENT_PERSONA_NAME}"
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
    active = [fact for fact in learnings or [] if fact.get("status") == "active"]
    if active:
        # the researcher's own distillation (dzhng's writeFinalReport
        # pattern): a pre-digested, REVISABLE evidence trail beside the raw
        # sources -- support, never substitute (the citation contract still
        # binds every claim to its numbered source)
        findings = "\n".join(f"- {fact.get('text', '')}" for fact in active)
        lines.append(
            "<findings>\nThe research agent recorded these findings as it"
            " worked -- its distillation of what the sources below"
            " established, revised as evidence moved (superseded and"
            " retracted facts are already filtered out).  Use them as your"
            " map of the material: they carry the agent's [n] labels and"
            " every claim still cites its numbered source; when a finding"
            " and a source disagree, the source wins.\n" + findings + "\n</findings>"
        )
    open_gaps = [gap for gap in gaps or [] if gap.get("status") == "open"]
    if open_gaps:
        # the ledger's own honesty note: what the research still owes --
        # the answer names these openly instead of papering over them
        shown = "\n".join(f"- {gap.get('q', '')}" for gap in open_gaps[:5])
        lines.append(
            "<open_gaps>\nThe research ledger still carries these OPEN"
            " questions it could not settle.  If the answer cannot close"
            " one from the gathered sources, say so plainly in its own"
            " sentence (what is missing and why) instead of guessing."
            "\n" + shown + "\n</open_gaps>"
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
    cap = writer_context_max(mode)
    context = "\n\n".join(_fit_context(feed, cap, relevance))
    if len(context) > cap:
        # a single oversized block: the last-resort slice the eviction
        # cannot fix
        context = context[:cap] + "\n\n[... the feed was truncated ...]"
    user = (
        f"<question>{question}</question>\n<context>\n"
        f"{context if not direct else 'No sources: this answer does not need them.'}\n</context>"
    )
    return shared.build_messages("\n".join(lines), user, history)
