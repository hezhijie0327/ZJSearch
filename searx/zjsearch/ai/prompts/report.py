# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The REPORT output shape's prompts: the outline gate, the per-section
synthesis and the executive summary.  The report mode writes the answer
DOCUMENT section by section -- each section one completion over ITS
packed context -- so the writer's single-turn contract does not apply;
these blocks are that contract instead.

The deck (:py:mod:`prompts.deck`) shares the report run's ENTIRE
machinery and composes its own systems from the fragments defined HERE
(the outline editor's role line, the deliverable-entities paragraph, the
JSON response contract, the section system's spine stack) -- one edit
lands on both documents."""

from searx.zjsearch.ai.prompts import spine

OUTLINE_EDITOR_LINE = "You are the outline editor of a research desk."
"""Both outline gates' role line -- one research desk, two deliverables."""

_OUTLINE_RESPONSE_CONTRACT = (
    'Respond with ONLY: {"title": "...", "subtitle": "...", "sections": [{"title": "...", "brief": "...", "key_questions": ["...", ...]}, ...], "entities": [{"name": "...", "why": "..."}, ...]}'
)
"""The JSON contract every outline completion answers with -- identical
for the free gate, the template adaptation, and the deck's variants."""

OUTLINE_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "subtitle": {"type": "string"},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "brief": {"type": "string"},
                    "key_questions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "brief"],
            },
        },
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "why": {"type": "string"}},
                "required": ["name"],
            },
        },
    },
    "required": ["title", "subtitle", "sections"],
}


def outline_entities_paragraph(unit: str, extra_clause: str = "") -> str:
    """The deliverable-entities paragraph both outline gates carry: the
    entities the FINAL deliverable leans on that no section studies.
    ``unit`` is "section" (report) or "chapter" (deck); ``extra_clause``
    rides inside the sentence (the report's opportunities-for-X rule)."""
    extra = f" {extra_clause}" if extra_clause else ""
    return f"""\
ALSO list the deliverable_entities: up to 6 named entities the FINAL
deliverable depends on understanding but that NO {unit} directly
researches -- a counterpart, a competitor, a technology or a market the
recommendations rest on{extra}.  The research desk must gather basic
sourced facts about each before writing starts."""


_OUTLINE_FREE = """\
Design the report's section skeleton for the question: 4-8 CONTENT
sections, each with a specific title (not "Introduction"/"Conclusion" --
name the subject matter), a one-sentence brief of what the section must
establish, and 1-3 key_questions the section's evidence must answer.
Order the sections the way a decision-maker reads: the landscape first,
mechanics/actors in the middle, implications and risks last.  Do NOT
include an executive summary, a methodology note or an appendix -- the
desk adds those itself."""

OUTLINE_SYSTEM = (
    f"{OUTLINE_EDITOR_LINE}  {_OUTLINE_FREE}"
    + "  "
    + outline_entities_paragraph(
        "section",
        extra_clause='(when the question asks for "opportunities for X", X itself belongs here unless a section studies it)',
    )
    + "  " + _OUTLINE_RESPONSE_CONTRACT
)

_OUTLINE_TEMPLATE = """\
The desk works from a FIXED report template supplied below -- its
section structure is BINDING.  Instantiate the template for the
question: keep every section the template marks non-optional, in the
template's order (drop one ONLY when it is marked optional AND truly
irrelevant to the question), write each section title with the
question's ACTUAL entity names (a placeholder like "{company}" or "the
target company" becomes the concrete name), and sharpen every brief +
key_questions so the section's evidence answers THIS question."""

TEMPLATE_ADAPT_SYSTEM = (
    f"{OUTLINE_EDITOR_LINE}  {_OUTLINE_TEMPLATE}"
    + "  " + outline_entities_paragraph("section")
    + "  " + _OUTLINE_RESPONSE_CONTRACT
)

REPORT_SHAPE = spine.block(
    "shape",
    """\
    You are writing ONE section of a research report -- not a chat answer.
    - Open the section with 1-2 lead sentences that state what the section
      establishes; then develop the substance in short paragraphs and
      markdown tables.
    - Match the form to the content: entity x metric matrices go into
      markdown tables; numeric series (quarterly figures, market share,
      capacity counts) read better as a ```mermaid xychart bar or line
      chart than as prose; the section's key verdict or sharpest risk
      becomes a [!WARNING] / [!IMPORTANT] callout when it must not be
      missed.
    - Use "###" sub-headings when the section has 2+ distinct facets.
    - Numbers DENSELY: every load-bearing figure carries its [n] citation
      right after the sentence or table row it supports.  A matrix of
      entities x metrics belongs in a markdown table, one [n] per
      load-bearing cell or row.
    - If key material is missing from the provided sources, say so in one
      clause and move on -- never pad, never invent a number.
    - NO document-level title, NO "## " section heading of your own (the
      section's heading is rendered by the document), NO preamble like
      "In this section".""",
)

_SECTION_ROLE = 'You write one section of a research report, grounded in the numbered sources of THIS run.'


def section_system(role: str, surface: str, shape: str, tz: str | None = None) -> str:
    """The per-section synthesizer's system prompt, composed from the
    SHARED spine fragments -- a hand-copied <citations> here once drifted
    away from the citation grammar (the placement examples and the [*]
    escape went missing); every document surface speaks the same
    contract, stacked in one order.  The deck's chapter system rides the
    identical stack with its own role, discipline surface and dialect."""
    return "\n".join(
        [
            role,
            spine.today_line(tz),
            spine.citation_rules(),
            spine.citation_discipline(surface),
            spine.figures_rule(),
            shape,
            spine.markdown_surface(),
        ]
    )


SECTION_SYSTEM = section_system(_SECTION_ROLE, "report", REPORT_SHAPE)

SUMMARY_SYSTEM = """\
You write the EXECUTIVE SUMMARY of a finished research report: 3-5
bold-led findings ("**Bottom line.** ..." -- a BOLD short label, a
period, then the finding), each 1-3 sentences, each carrying its [n]
citations, followed by one short synthesis paragraph that names the core
logic tying the findings together.  Synthesize -- do not retell section
by section; the reader has not read them yet.  Ground every statement in
the sections' own citations, and write every label in the report's
language."""

def summary_user(q: str, digest: str) -> str:
    """The executive summary's user turn (the tags via :func:`spine.block`)."""
    return (
        spine.block("question", q)
        + "\n"
        + spine.block("written_sections", digest)
        + "\nWrite the executive summary in the report's language."
    )

CITATION_GATE_INSTRUCTIONS = "For each numbered claim, judge whether the cited source's material actually supports it (a source that merely mentions the topic does NOT support a specific figure)."
