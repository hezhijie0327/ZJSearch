# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The DECK output shape's prompts: the slide dialect the deck
synthesizer speaks.  A deck run shares the report run's ENTIRE
machinery -- the outline gate, the per-section synthesis, the section
citation gate (runs/report/synth.py takes a ``deck`` flag) -- and
differs only in the contracts: the outline speaks chapters-become-
slides, and each section's completion returns 1-4 slides of the
constrained Marpit dialect the family renderer compiles (ZJBlog
``tools/deck.ts`` == zjsearch ``lib/deck/compile.ts``, DESIGN.md
§5.2).  The dialect is a SUBSET by design: no raw HTML (the renderer
compiles model content with ``html: false`` -- an injected tag renders
as visible text, which IS the prompt-injection trust model), no
front-matter, no style directives.  Structure belongs to the outline
(template or gate); the slides inside a chapter are the model's."""

from searx.zjsearch.ai.prompts import spine

DECK_OUTLINE_SYSTEM = (
    "You are the outline editor of a research desk.  Design the SLIDE DECK's"
    " chapter skeleton for the question: 4-8 CONTENT chapters, each of which"
    " becomes 1-4 presentation slides, with a specific title (not"
    " \"Introduction\"/\"Conclusion\" -- name the subject matter), a"
    " one-sentence brief of what the chapter must establish, and 1-3"
    " key_questions its evidence must answer.  Order the chapters the way a"
    " presenter tells the story: the landscape first, mechanics/actors in the"
    " middle, implications, risks and a recommendation last.  Do NOT include"
    " an executive summary, an agenda or an appendix chapter -- the desk adds"
    " the cover slide itself.  ALSO list the deliverable_entities: up to 6"
    " named entities the FINAL deliverable depends on understanding but that"
    " NO chapter directly researches -- a counterpart, a competitor, a"
    " technology or a market the recommendations rest on.  The research desk"
    " must gather basic sourced facts about each before writing starts."
    "  Respond with ONLY:"
    ' {"title": "...", "subtitle": "...", "sections": [{"title": "...",'
    ' "brief": "...", "key_questions": ["...", ...]}, ...],'
    ' "entities": [{"name": "...", "why": "..."}, ...]}'
)

DECK_TEMPLATE_ADAPT_SYSTEM = (
    "You are the outline editor of a research desk.  The desk works from a"
    " FIXED presentation template supplied below -- its chapter structure is"
    " BINDING.  Instantiate the template for the question: keep every chapter"
    " the template marks non-optional, in the template's order (drop one ONLY"
    " when it is marked optional AND truly irrelevant to the question), write"
    " each chapter title with the question's ACTUAL entity names (a"
    " placeholder like \"公司\" / \"{company}\" becomes the concrete name),"
    " and sharpen every brief + key_questions so the chapter's evidence"
    " answers THIS question.  ALSO list the deliverable_entities: up to 6"
    " named entities the FINAL deliverable depends on understanding but that"
    " no kept chapter directly researches.  Respond with ONLY:"
    ' {"title": "...", "subtitle": "...", "sections": [{"title": "...",'
    ' "brief": "...", "key_questions": ["...", ...]}, ...],'
    ' "entities": [{"name": "...", "why": "..."}, ...]}'
)

DECK_SLIDE_DIALECT = (
    "<shape>\n"
    "You are writing ONE chapter of a SLIDE DECK (a presentation built from\n"
    "slides) -- not a chat answer and not report prose.  The renderer speaks\n"
    "the Marpit slide dialect; these rules OVERRIDE the generic markdown\n"
    "surface above where they differ.\n"
    "- Return 1-4 slides for this chapter.  Separate slides with a line\n"
    "  containing only `---` (blank lines around it).  NEVER use `---` as a\n"
    "  horizontal rule inside a slide -- in this dialect it IS the page\n"
    "  break.\n"
    "- Each slide opens with a `# ` slide title (one short line -- this is\n"
    "  the slide's headline, not a document heading), then its body: 3-6\n"
    "  bullet points, each ONE line -- a **bold** lead term, then the fact\n"
    "  with its [n] citation.  A slide is a headline plus evidence: at most\n"
    "  ~120 words per slide, never a wall of text, no long paragraphs.\n"
    "- Match the form to the content: comparisons go into COMPACT markdown\n"
    "  tables (at most ~5 rows -- keep only the load-bearing ones), a\n"
    "  numeric series reads better as a ```mermaid xychart bar/line chart,\n"
    "  the chapter's key verdict or sharpest risk becomes a [!WARNING] /\n"
    "  [!IMPORTANT] callout, ==highlights== mark the few words that must\n"
    "  not be missed.  One diagram per slide at most.\n"
    "- Speaker notes: a `<!-- ... -->` HTML comment line at a slide's end\n"
    "  becomes that slide's presenter note -- write what you would say\n"
    "  aloud beyond the slide, not what the slide already shows.\n"
    "- FORBIDDEN in this dialect: raw HTML of any kind (it renders as\n"
    "  visible escaped text -- including <hr>, <br>, <div>), markdown\n"
    "  images, front-matter blocks, `<!-- _class: ... -->` or any other\n"
    "  style directive (the renderer fixes the theme), and a document-level\n"
    "  title (the deck's cover slide is built from the outline's title).\n"
    "</shape>"
)

DECK_SECTION_SYSTEM = (
    "You write one chapter's slides of a research deck, grounded in the"
    " numbered sources of THIS run.\n"
    # composed from the SHARED spine fragments, exactly like the report's
    # SECTION_SYSTEM -- a hand-copied citation grammar here would drift
    + spine.citation_rules()
    + "\n<citation_discipline>\nEvery load-bearing number or claim carries"
    " its citation -- the deck's credibility IS the citation"
    " discipline.\n</citation_discipline>\n"
    + spine.figures_rule()
    + "\n"
    + spine.markdown_surface()
    + "\n"
    + DECK_SLIDE_DIALECT
)
