# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The REPORT output shape's prompts: the outline gate, the per-section
synthesis and the executive summary.  The report mode writes the answer
DOCUMENT section by section -- each section one completion over ITS
packed context -- so the writer's single-turn contract does not apply;
these blocks are that contract instead."""

from searx.zjsearch.ai.prompts import spine

OUTLINE_SYSTEM = (
    "You are the outline editor of a research desk.  Design the report's"
    " section skeleton for the question: 4-8 CONTENT sections, each with a"
    " specific title (not \"Introduction\"/\"Conclusion\" -- name the"
    " subject matter), a one-sentence brief of what the section must"
    " establish, and 1-3 key_questions the section's evidence must answer."
    "  Order the sections the way a decision-maker reads: the landscape"
    " first, mechanics/actors in the middle, implications and risks last."
    "  Do NOT include an executive summary, a methodology note or an"
    " appendix -- the desk adds those itself.  ALSO list the"
    " deliverable_entities: up to 6 named entities the FINAL deliverable"
    " depends on understanding but that NO section directly researches --"
    " a counterpart, a competitor, a technology or a market the"
    " recommendations rest on (when the question asks for \"opportunities"
    " for X\", X itself belongs here unless a section studies it).  The"
    " research desk must gather basic sourced facts about each before"
    " writing starts.  Respond with ONLY:"
    ' {"title": "...", "subtitle": "...", "sections": [{"title": "...",'
    ' "brief": "...", "key_questions": ["...", ...]}, ...],'
    ' "entities": [{"name": "...", "why": "..."}, ...]}'
)

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

REPORT_SHAPE = (
    "<shape>\n"
    "You are writing ONE section of a research report -- not a chat answer.\n"
    "- Open the section with 1-2 lead sentences that state what the section\n"
    "  establishes; then develop the substance in short paragraphs and\n"
    "  markdown tables.\n"
    "- Match the form to the content: entity x metric matrices go into\n"
    "  markdown tables; numeric series (quarterly figures, market share,\n"
    "  capacity counts) read better as a ```mermaid xychart bar or line\n"
    "  chart than as prose; the section's key verdict or sharpest risk\n"
    "  becomes a [!WARNING] / [!IMPORTANT] callout when it must not be\n"
    "  missed.\n"
    "- Use \"###\" sub-headings when the section has 2+ distinct facets.\n"
    "- Numbers DENSELY: every load-bearing figure carries its [n] citation\n"
    "  right after the sentence or table row it supports.  A matrix of\n"
    "  entities x metrics belongs in a markdown table, one [n] per\n"
    "  load-bearing cell or row.\n"
    "- If key material is missing from the provided sources, say so in one\n"
    "  clause and move on -- never pad, never invent a number.\n"
    "- NO document-level title, NO \"## \" section heading of your own (the\n"
    "  section's heading is rendered by the document), NO preamble like\n"
    "  \"In this section\".\n"
    "</shape>"
)

SECTION_SYSTEM = (
    "You write one section of a research report, grounded in the numbered"
    " sources of THIS run.\n"
    "<citations>\nCite sources right after the statements they support: [1]"
    " for one source, [1,3] for several.  Every load-bearing number or claim"
    " carries its citation -- the report's credibility IS the citation"
    " discipline.\n</citations>\n"
    "<figures>\nEvery figure in the section comes from the material you were"
    " given.  When a number the sources only imply is worth showing (a"
    " difference, a share, a growth rate), derive it from the cited inputs"
    " and keep the derivation visible in one clause -- never present a"
    " computed number as if a source stated it.\n</figures>\n"
    + REPORT_SHAPE
    + "\n"
    + spine.markdown_surface()
)

SUMMARY_SYSTEM = (
    "You write the EXECUTIVE SUMMARY of a finished research report: 3-5"
    " bold-led findings (\"**基线判断.** ...\"), each 1-3 sentences, each"
    " carrying its [n] citations, followed by a short 核心逻辑 paragraph"
    " that ties them together.  Synthesize -- do not retell section by"
    " section; the reader has not read them yet.  Ground every statement in"
    " the sections' own citations."
)

SUMMARY_USER = (
    "<question>{q}</question>\n<written_sections>\n{digest}\n</written_sections>\n"
    "Write the executive summary in the report's language."
)

CITATION_GATE_INSTRUCTIONS = (
    "For each numbered claim, judge whether the cited source's material"
    " actually supports it (a source that merely mentions the topic does"
    " NOT support a specific figure)."
)
