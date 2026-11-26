# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The DECK output shape's prompts: the outline gate (chapters-become-
slides) and the whole-deck slide dialect the single writer speaks -- the
constrained Marpit subset the family renderer compiles (ZJBlog
``tools/deck.ts`` == zjsearch ``lib/deck/compile.ts``, DESIGN.md §5.2).
The dialect is a SUBSET by design: no raw HTML (the renderer compiles
model content with ``html: false`` -- an injected tag renders as visible
text, which IS the prompt-injection trust model), no front-matter, no
style directives.  Structure belongs to the outline (template or gate);
the slides inside a chapter are the model's.

The shared fragments (the editor role line, the deliverable-entities
paragraph, the JSON response contract) live in :py:mod:`prompts.report`
-- one edit lands on both documents."""

from searx.zjsearch.ai.prompts import report
from searx.zjsearch.ai.prompts import spine

_OUTLINE_FREE = """\
Design the SLIDE DECK's chapter skeleton for the question: 4-8 CONTENT
chapters, each of which becomes 1-4 presentation slides, with a specific
title (not "Introduction"/"Conclusion" -- name the subject matter), a
one-sentence brief of what the chapter must establish, and 1-3
key_questions its evidence must answer.  Order the chapters the way a
presenter tells the story: the landscape first, mechanics/actors in the
middle, implications, risks and a recommendation last.  Do NOT include
an executive summary, an agenda or an appendix chapter -- the desk adds
the cover slide itself."""

DECK_OUTLINE_SYSTEM = (
    f"{report.OUTLINE_EDITOR_LINE}  {_OUTLINE_FREE}"
    f"  {report.outline_entities_paragraph('chapter')}  "
    + report._OUTLINE_RESPONSE_CONTRACT  # pylint: disable=protected-access
)

_OUTLINE_TEMPLATE = """\
The desk works from a FIXED presentation template supplied below -- its
chapter structure is BINDING.  Instantiate the template for the
question: keep every chapter the template marks non-optional, in the
template's order (drop one ONLY when it is marked optional AND truly
irrelevant to the question), write each chapter title with the
question's ACTUAL entity names (a placeholder like "{company}" or "the
target company" becomes the concrete name), and sharpen every brief +
key_questions so the chapter's evidence answers THIS question."""

DECK_TEMPLATE_ADAPT_SYSTEM = (
    f"{report.OUTLINE_EDITOR_LINE}  {_OUTLINE_TEMPLATE}"
    f"  {report.outline_entities_paragraph('chapter')}  "
    + report._OUTLINE_RESPONSE_CONTRACT  # pylint: disable=protected-access
)

DECK_DOCUMENT_DIALECT = spine.block(
    "shape",
    """\
    You are writing a COMPLETE SLIDE DECK (a presentation built from
    slides) in ONE completion -- not a chat answer and not report prose.
    The renderer speaks the Marpit slide dialect; these rules OVERRIDE
    the generic markdown surface where they differ.
    - Slide 1 is the COVER: a "# " line with the deck's title, then the
      subtitle and a one-line byline -- nothing else on the cover.
    - Then the <document_structure> chapters, each as 1-4 slides.
      Separate slides with a line containing only `---` (blank lines
      around it).  NEVER use `---` as a horizontal rule inside a slide --
      in this dialect it IS the page break.
    - Each slide opens with a `# ` slide title (one short line -- this is
      the slide's headline, not a document heading), then its body: 3-6
      bullet points, each ONE line -- a **bold** lead term, then the fact
      with its [n] citation.  A slide is a headline plus evidence: at most
      ~120 words per slide, never a wall of text, no long paragraphs.
    - Match the form to the content: comparisons go into COMPACT markdown
      tables (at most ~5 rows -- keep only the load-bearing ones), a
      numeric series reads better as a ```mermaid xychart bar/line chart,
      a chapter's key verdict or sharpest risk becomes a [!WARNING] /
      [!IMPORTANT] callout, ==highlights== mark the few words that must
      not be missed.  One diagram per slide at most.
    - Speaker notes: a `<!-- ... -->` HTML comment line at a slide's end
      becomes that slide's presenter note -- write what you would say
      aloud beyond the slide, not what the slide already shows.
    - FORBIDDEN in this dialect: raw HTML of any kind (it renders as
      visible escaped text -- including <hr>, <br>, <div>), markdown
      images, footnotes (the slide pipeline has no footnote renderer --
      an aside rides the speaker note instead), front-matter blocks, and
      `<!-- _class: ... -->` or any other style directive (the renderer
      fixes the theme).""",
)
