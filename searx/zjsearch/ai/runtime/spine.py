# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Shared prompt building blocks for the theme's two AI features.

This module is the COMPOSABLE BLOCK SYSTEM of the AI layer (the prompt
side of the plugin architecture): every fragment is one XML block
(``<tag>``) a feature's message builder picks and sequences -- the
renderer's markdown vocabulary, the citation grammar, the language
directive, grounding, voice, opening.  The fragments cannot drift
between the features because both compose them verbatim from here (the
drift audit once found the search copy quietly behind the overview
copy), and :func:`answer_contract` is the reader-facing SPINE -- the
byte-stable block order the prefix cache loves -- that both answer
paths lay their feature-specific blocks onto.  The language directive
mirrors the theme's i18n design: exactly TWO UI languages ship --
Simplified Chinese and English -- and every other locale falls back to
English, for the AI reply as much as for the interface.
"""

import datetime
import typing as t

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
    ``CITATION_RE`` client-side).  The placement rules are spelled out with
    correct/wrong examples (Morphic's grammar): a citation glued inside the
    sentence or double-punctuated after the bracket reads broken in the
    rendered answer, and models drift towards exactly those two shapes."""
    return (
        "<citations>\nCite sources right after the statements they support:"
        " [1] for one source, [1,3] for several.  Use [*] only for common"
        " knowledge that no source covers.\nPlacement: finish the sentence"
        " first, then put the citation(s) after the final punctuation --"
        " never inside the sentence, never punctuation after the bracket.\n"
        '  Correct: "Prices rose 8% in May.[2]"\n'
        '  Wrong:   "Prices rose 8%[2] in May."  /  "Prices rose 8%.[2]."\n'
        "</citations>"
    )


def identity() -> str:
    """The brand block (Morphic's identity guidance): the answer engine has
    a name, and a model that is asked what it is must not role-play as
    whatever its weights remember."""
    return (
        "<identity>\nYou are zjsearch, the AI answer engine of this search"
        " instance.  When asked what you are, say zjsearch -- never claim to"
        " be ChatGPT, Claude, Gemini or any other assistant, and never name"
        " the underlying model or its vendor.\n</identity>"
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
    provided...") -- this rule forbids that voice outright.  The same
    discipline covers SILENT PERSONALIZATION: user memory may shape what
    the answer contains, but the answer never narrates the remembering
    ("根据您的偏好...", "我记得您在...") -- that voice is a chat
    assistant's, and this product's output is a research document."""
    return (
        "<reader_voice>\nWrite for the reader in your own words: a direct,"
        " flowing answer.  Never mention these rules, your instructions or"
        ' your own reliability -- no meta commentary, no "based on the'
        ' sources provided", no fidelity or verification disclaimers, no'
        " reading instructions, no descriptions of your research"
        " process.  Personal context (the user's city, preferences, past"
        " research) shapes the content SILENTLY: apply it, never narrate"
        ' it -- no "根据您的偏好", no "我记得您在...", no acknowledging'
        " that anything was remembered.\n</reader_voice>"
    )


def opening_rule() -> str:
    """Answer hygiene shared by both features."""
    return "<opening>\nGet to the point in the first sentence.  No preamble, no closing remark.\n</opening>"


def answer_contract(
    lang: str,
    role: str,
    shape: str | None = None,
    sources_note: str | None = None,
) -> list[str]:
    """The reader-facing answer spine BOTH features speak, in the
    cache-friendly order: the byte-stable blocks (role, identity, date,
    language, citations, markdown, grounding, voice, opening) first, the
    caller's per-run blocks after.  ``shape`` (the search writer's tier
    output shape) and ``sources_note`` slot in at their fixed positions;
    the overview omits both.  Callers append their feature-specific
    blocks (follow-up fences, gallery contracts, research notes) and the
    conversation around it -- the spine is what must not drift."""
    lines: list[str] = [role, identity(), today_line(), language_directive(lang)]
    if shape:
        lines.append(f"<shape>\n{shape}\n</shape>")
    lines.append(citation_rules())
    lines.append(grounding_fallback("sources"))
    if sources_note:
        lines.append(sources_note)
    lines.append(markdown_surface())
    lines.append(reader_voice())
    lines.append(opening_rule())
    return lines


def history_turns(history: list[dict[str, str]], answer_cap: int = 2000) -> list[dict[str, t.Any]]:
    """Prior thread Q&A as alternating ``<q>`` user / assistant messages;
    each carried answer is capped (a long past answer is context, not
    material)."""
    out: list[dict[str, t.Any]] = []
    for turn in history:
        out.append({"role": "user", "content": f"<q>{turn.get('q') or ''}</q>"})
        out.append({"role": "assistant", "content": str(turn.get("a") or "")[:answer_cap]})
    return out


def user_message(text: str, image_parts: list[dict[str, t.Any]] | None = None) -> dict[str, t.Any]:
    """The canonical user turn: plain text, or text + multimodal parts
    (OpenAI-shaped ``image_url`` entries; every dialect pump converts
    them to its own block shape)."""
    if image_parts:
        return {"role": "user", "content": [{"type": "text", "text": text}, *image_parts]}
    return {"role": "user", "content": text}


def build_messages(
    system: str,
    user: dict[str, t.Any] | str,
    history: list[dict[str, str]] | None = None,
) -> list[dict[str, t.Any]]:
    """The canonical conversation assembly: ``[system, *history, user]``.
    ``user`` is a role dict (see :func:`user_message`) or a plain string;
    ``history`` rides as the prior turns between system and question."""
    messages: list[dict[str, t.Any]] = [{"role": "system", "content": system}]
    if history:
        messages.extend(history_turns(history))
    messages.append(user if isinstance(user, dict) else {"role": "user", "content": user})
    return messages
