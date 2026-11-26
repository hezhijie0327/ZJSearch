# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The REPORT output shape's prompts: the outline gate and the
whole-document writer contract.  The document is ONE write turn on the
shared loop -- the outline (template or gate) rides the writer prompt as
the binding skeleton; there is no per-section synthesis anymore.

The deck (:py:mod:`prompts.deck`) shares the report run's outline gate
fragments defined HERE (the outline editor's role line, the
deliverable-entities paragraph, the JSON response contract) -- one edit
lands on both documents."""

from searx.zjsearch.ai.prompts import spine

OUTLINE_EDITOR_LINE = "You are the outline editor of a research desk."
"""Both outline gates' role line -- one research desk, two deliverables."""

_OUTLINE_RESPONSE_CONTRACT = 'Respond with ONLY: {"title": "...", "subtitle": "...", "sections": [{"title": "...", "brief": "...", "key_questions": ["...", ...]}, ...], "entities": [{"name": "...", "why": "..."}, ...]}'
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
include an executive summary, a methodology note or an appendix."""

OUTLINE_SYSTEM = (
    f"{OUTLINE_EDITOR_LINE}  {_OUTLINE_FREE}"
    + "  "
    + outline_entities_paragraph(
        "section",
        extra_clause='(when the question asks for "opportunities for X", X itself belongs here unless a section studies it)',
    )
    + "  "
    + _OUTLINE_RESPONSE_CONTRACT
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
    + "  "
    + outline_entities_paragraph("section")
    + "  "
    + _OUTLINE_RESPONSE_CONTRACT
)

REPORT_DOCUMENT_SHAPE = spine.block(
    "shape",
    """\
    You are writing a COMPLETE RESEARCH REPORT (a document deliverable)
    in ONE completion -- not a chat answer.
    - The <document_structure> block names the skeleton: open with the
      report's title as a "# " H1 line, then write EVERY listed section
      as a "## " heading in the given order, using the section titles as
      given and covering what each brief (and its key questions) demands.
      Never add a summary, methodology or appendix section.
    - Open the document with 1-2 lead sentences stating what the report
      establishes; each section then develops its substance in short
      paragraphs, markdown tables and lists.  Use "###" sub-headings when
      a section has 2+ distinct facets.
    - Match the form to the content: entity x metric matrices go into
      markdown tables; numeric series (quarterly figures, market share,
      capacity counts) read better as a ```mermaid xychart bar or line
      chart than as prose; a section's key verdict or sharpest risk
      becomes a [!WARNING] / [!IMPORTANT] callout when it must not be
      missed.
    - Numbers DENSELY: every load-bearing figure or claim carries its [n]
      citation right after the sentence or table row it supports.
    - If key material is missing from the provided sources, say so in one
      clause and move on -- never pad, never invent a number.""",
)
