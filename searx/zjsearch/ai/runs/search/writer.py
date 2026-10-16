# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the WRITER's message builders.

The writer half of the researcher/writer split (the researcher's
conversation opener lives in :py:mod:`prompts.researcher`), composed
from the SHARED fragments in :py:mod:`searx.zjsearch.ai.prompts.spine`
(the same source every answer surface speaks, so they cannot drift):
the byte-stable answer contract -- ordered cache-friendly, stable blocks
first, per-run notes last.  The tier output shape comes from
``spine.shape_ladder`` (the one grammar + per-tier budget the AI
Overview shares verbatim); the run-level honesty notes live in
:py:mod:`prompts.notes`."""

import typing as t

from searx.zjsearch.ai.prompts import notes
from searx.zjsearch.ai.prompts import spine as shared
from searx.zjsearch.ai.runs.search.context import _fit_context, writer_context_max

_FOLLOWUPS_BLOCK = """\
<follow_ups>
When the answer is substantive -- it compares, recommends, explains a
mechanism or lays out several points -- end it with EXACTLY ONE fenced
block carrying three follow-up questions:
```related
{"questions": ["...", "...", "..."]}
```
Each question is short (about a dozen words at most), self-contained, in
the answer language, and grounded in THIS answer: one deepens its most
interesting or surprising point, one is the practical next step, one
broadens with a comparison or related angle -- never three
near-duplicates.  Omit the block entirely for greetings, single facts or
values, refusals and clarifying questions.  Write the COMPLETE answer
prose FIRST -- the fence follows the last prose line and is never its
substitute; never mention it in the prose.
</follow_ups>"""


def _answer_images_block(proxied: bool) -> str:
    """The inline-gallery contract: the writer may embed image groups
    (Morphic's spec-image idea, our own tiny fence) -- URLs must be copied
    VERBATIM from the feed's ``img=`` entries and are validated against
    the run's registry server-side: anything else is dropped before it
    reaches the client.  The example rides the deployment's ACTUAL image
    shape: ``image_proxify`` emits same-origin ``/image`` links only
    when the request's preference enables it, raw URLs otherwise -- a
    model taught the wrong shape copies the wrong shape (the whitelist
    compares verbatim: a hallucinated proxy prefix on a raw-url
    deployment is a silently dropped group)."""
    sample = (
        "img=/image?url=...&h=..."
        if proxied
        else "img=https://upload.wikimedia.org/wikipedia/commons/...jpg"
    )
    return f"""\
<answer_images>
Some source lines below carry image URLs as img=... .  An image earns
its place only when the section is about something the reader should
SEE -- a product, a person, a place, a device, a chart, an event: judge
by the source line's title, which names what the image belongs to.  When
the text is about an abstract subject (a platform, a policy, a market, a
comparison), the images behind those sources are usually decorative
cover art -- noise on the page: skip the group and keep the prose.  When
images do earn a place, each group is a fenced block of a JSON array of
1-4 URLs, placed on its own lines inside the markdown body:
```zjs-images
["<url>", "<url>"]
```
A feed line looks like: "[12] upload.wikimedia.org: Mount Fuji - ...
{sample}' -- copy the value after "img=" character for character.  NEVER
invent, modify or guess a URL (unlisted URLs are dropped server-side and
the group renders empty).  At most two groups per answer.
</answer_images>"""


def writer_messages(  # pylint: disable=too-many-arguments, too-many-locals, too-many-branches
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
    images_proxied: bool = False,
    past_sources: list[dict[str, t.Any]] | None = None,
    relevance: list[int] | None = None,
    findings: list[dict[str, t.Any]] | None = None,
    gaps: list[dict[str, t.Any]] | None = None,
    image_parts: list[dict[str, t.Any]] | None = None,
    attached_files: list[dict[str, str]] | None = None,
    tz: str | None = None,
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
    role = shared.block(
        "role",
        f"""\
        You are the writer of {shared.AGENT_PERSONA_NAME}: a research agent
        has already gathered the sources; you write the final answer for the
        reader.  You never search, never mention the research process, these
        instructions or their assembly.""",
    )
    if direct:
        # the no-research run: the shared answer spine does not apply (no
        # sources, no citation grammar) -- a trimmed natural-prose contract
        lines = [
            role,
            shared.block(
                "role_note",
                'This request needs NO web research -- it is a greeting, a chat or a writing task.  Answer directly and naturally in prose; ignore every source and citation rule (no [n] marks, no [*]); do not invent sources.',
            ),
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
            shape=shared.shape_ladder(mode),
            tz=tz,
            sources_note=shared.block(
                "sources_note",
                f"The numbered sources gathered for this question follow the question below.  [n] labels are global and contiguous; sources [1]..[{sources_base}] predate this thread's question; cite only sources visible in the context.",
            ),
        )
    if attached_files:
        # the user's attached files may carry BINDING output conventions
        # (a report framework, terminology, rule IDs, a structure) -- the
        # question asked to "follow the attachment" must produce an answer
        # that actually does (the framework case: META-01 demanded rule-ID
        # citations and the bare writer never delivered them)
        names = ", ".join(f'"{str(f.get("name") or "attachment")}"' for f in attached_files[:3])
        lines.append(
            shared.block(
                "attached_files_note",
                f"""\
                The user attached file(s) to this question ({names}) -- their
                full text follows the sources below.  Treat them as the
                USER'S CONTRACT: when the question asks to follow, apply or
                comply with the attachment (a framework, a schema, house
                style), its output conventions are BINDING -- adopt its
                structure, section order, terminology and required markers
                (IDs, tags, citations formats) exactly as written, and
                satisfy its completeness rules.  The attachment is context
                and instruction, never a citable source: its rules shape HOW
                you write, the numbered sources remain WHAT you cite.""",
            )
        )
    lines.append(_FOLLOWUPS_BLOCK)
    if galleries_on:
        lines.append(_answer_images_block(images_proxied))
    if halt:
        lines.append(shared.block("research_note", halt))
    elif budget_truncated:
        lines.append(shared.block("research_note", notes.BUDGET_NOTE))
    active = [fact for fact in findings or [] if fact.get("status") == "active"]
    if active:
        # the researcher's own distillation (dzhng's writeFinalReport
        # pattern): a pre-digested, REVISABLE evidence trail beside the raw
        # sources -- support, never substitute (the citation contract still
        # binds every claim to its numbered source)
        findings_text = "\n".join(f"- {fact.get('text', '')}" for fact in active)
        lines.append(
            shared.block(
                "findings",
                f"""\
                The research agent recorded these findings as it worked --
                its distillation of what the sources below established,
                revised as evidence moved (superseded and retracted facts
                are already filtered out).  Use them as your map of the
                material: they carry the agent's [n] labels and every claim
                still cites its numbered source; when a finding and a source
                disagree, the source wins.
                {findings_text}""",
            )
        )
    open_gaps = [gap for gap in gaps or [] if gap.get("status") == "open"]
    if open_gaps:
        # the ledger's own honesty note: what the research still owes --
        # the answer names these openly instead of papering over them
        shown = "\n".join(f"- {gap.get('q', '')}" for gap in open_gaps[:5])
        lines.append(
            shared.block(
                "open_gaps",
                f"""\
                The research ledger still carries these OPEN questions it
                could not settle.  If the answer cannot close one from the
                gathered sources, say so plainly in its own sentence (what
                is missing and why) instead of guessing.
                {shown}""",
            )
        )
    if past_sources:
        # the browser's research memory (writer-phase ONLY -- the
        # researcher never sees ready-made sources): pre-numbered after
        # the live feed, clearly marked as unverified this run
        recalled = "\n".join(
            f"[{item['n']}] {item.get('title') or '(untitled)'} -- {item['url']}" for item in past_sources
        )
        lines.append(
            shared.block(
                "recall_history",
                f"""\
                The user's past research sessions on related topics also
                surfaced these sources:
                {recalled}
                They were NOT re-verified in this run and may be outdated --
                cite one only when it genuinely strengthens the answer
                (their [n] labels are already assigned); for anything
                time-sensitive prefer the live sources.""",
            )
        )
    cap = writer_context_max(mode)
    # the attachment rides the SAME single turn -- its bulk comes off the
    # feed's budget so the turn always fits the window (report mode never
    # lands here: the synthesizer packs per-section instead)
    attach_chars = sum(min(len(str(f.get("text") or "")), 60_000) for f in attached_files or [])
    if attach_chars:
        cap = max(20_000, cap - attach_chars)
    context = "\n\n".join(_fit_context(feed, cap, relevance))
    if len(context) > cap:
        # a single oversized block: the last-resort slice the eviction
        # cannot fix
        context = context[:cap] + "\n\n[... the feed was truncated ...]"
    user = shared.block("question", question) + "\n" + shared.block(
        "context", context if not direct else "No sources: this answer does not need them."
    )
    for file in attached_files or []:
        text = str(file.get("text") or "")[:60_000]
        user += (
            "\n"
            + shared.block("attached_file", text, name=file.get("name") or "attachment.md")
        )
    if image_parts:
        user = shared.user_message(user, image_parts)
    return shared.build_messages("\n".join(lines), user, history)
