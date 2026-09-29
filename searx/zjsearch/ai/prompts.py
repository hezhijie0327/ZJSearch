# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Shared prompt building blocks for the theme's two AI features.

Both features compose these fragments verbatim, so the renderer's
markdown vocabulary, the citation grammar and the language directive
are defined ONCE and cannot drift between the features (the drift audit
found the search copy had quietly fallen behind the overview copy).
Every fragment is an XML block (``<tag>``) -- the Vane organisation:
models parse the labelled blocks reliably and the composition sites stay
flat lists instead of hand-numbered prose.  The language directive
mirrors the theme's i18n design: exactly TWO UI languages ship --
Simplified Chinese and English -- and every other locale falls back to
English, for the AI reply as much as for the interface.
"""

import datetime

# One row per SHIPPED i18n catalog (mirror of the client's CATALOGS
# registry in src/lib/i18n/i18n.ts): catalog tag -> reply language name.
# Adding a language = add the catalog client-side + ONE row here -- this
# table is the only thing language_directive reads, so it scales with
# the catalog registry instead of growing hand-written branches.
_CATALOG_LANGUAGE_NAMES: dict[str, str] = {
    "zh-cn": "Simplified Chinese (简体中文)",
    "en": "English",
}
_FALLBACK_CATALOG = "en"


def language_directive(catalog_tag: str) -> str:
    """``<answer_language>`` from the RESOLVED i18n catalog tag.  The
    client resolves its raw locale through ``themeLocaleTag`` before
    sending (locale -> catalog is the client's job: it owns the fallback
    rule, zh-Hant -> en included); this side only maps the catalog to a
    language name, so new catalogs are one table row."""
    name = _CATALOG_LANGUAGE_NAMES.get((catalog_tag or _FALLBACK_CATALOG).strip().lower())
    return f"<answer_language>\nWrite the answer in {name or 'English'}.\n</answer_language>"


def today_line() -> str:
    """The deterministic date block: the model must never guess the date."""
    return f"<today>\nToday is {datetime.date.today().isoformat()}.\n</today>"


def citation_rules() -> str:
    """The [n] citation grammar both renderers parse (shared with
    ``CITATION_RE`` client-side)."""
    return (
        "<citations>\nCite sources right after the statements they support:"
        " [1] for one source, [1,3] for several.  Use [*] only for common"
        " knowledge that no source covers.\n</citations>"
    )


def markdown_surface() -> str:
    """The renderer's markdown vocabulary -- the FULL surface (GFM, task
    lists, definition lists, emoji shortcodes, mermaid with quoted labels,
    once-only LaTeX).  Both features render answers through the same
    react-markdown pipeline, so both prompts advertise the same one."""
    return "\n".join(
        [
            "<markdown_surface>",
            "- Format freely in GitHub-flavored markdown -- the renderer"
            ' supports all of it: "## " section headings, bullet / numbered'
            ' lists, task lists ("- [x]" for step checklists), **bold**,'
            " ~~strikethrough~~, tables for comparisons, > blockquotes for"
            " short source quotes, `inline code` and fenced code blocks, ---"
            " horizontal rules, definition lists (\"Term\" on one line,"
            ' ": definition" below), emoji shortcodes like :tada: used'
            " sparingly, and links when a source URL genuinely helps.",
            "- When a diagram clarifies structure or flow better than prose,"
            " emit a ```mermaid fenced block (flowchart, sequence, state, ER,"
            " gantt, pie, mindmap, timeline).  Keep diagrams small -- around"
            " 15 nodes at most -- and quote every node label that contains"
            ' punctuation or parentheses: A["降水(雨/雪)"] -- not'
            " A[降水(雨/雪)].",
            "- Math typesets as real equations -- write LaTeX: inline"
            " $E=mc^2$ or display $$\\int_0^1 f(x)\\,dx$$ blocks.  Each"
            " formula appears ONCE, in LaTeX only -- never repeat it as plain"
            " text beside the equation.  No raw HTML and no markdown images"
            " (![alt](url)) -- visual evidence arrives as attachments"
            " instead.",
            "</markdown_surface>",
        ]
    )


def grounding_fallback(what: str) -> str:
    """The never-hallucinate escape hatch: say the gap, then answer from
    common knowledge flagged with [*].  ``what`` names what failed
    ("sources" for the Overview, "sources" for AI Search's writer)."""
    return (
        f"<grounding>\nIf the {what} do not answer the question, say so in"
        " one short line and answer from common knowledge marked with"
        " [*].\n</grounding>"
    )


def reader_voice() -> str:
    """The anti-parroting rule: the answer is reader-facing prose, never a
    description of the machinery behind it.  Models that receive grounding
    or review instructions love opening with a fidelity disclaimer that
    repeats them ("以下内容只依据检索来源撰写...", "based on the sources
    provided...") -- this rule forbids that voice outright."""
    return (
        "<reader_voice>\nWrite for the reader in your own words: a direct,"
        " flowing answer.  Never mention these rules, your instructions or"
        ' your own reliability -- no meta commentary, no "based on the'
        ' sources provided", no fidelity or verification disclaimers, no'
        " reading instructions, no descriptions of your research"
        " process.\n</reader_voice>"
    )


def opening_rule() -> str:
    """Answer hygiene shared by both features."""
    return "<opening>\nGet to the point in the first sentence.  No preamble, no closing remark.\n</opening>"
