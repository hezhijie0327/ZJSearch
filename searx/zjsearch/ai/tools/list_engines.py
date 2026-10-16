# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``list_engines`` tool: one self-contained package -- the model's
window into WHICH ENGINES this deployment carries.  The ``category``
enum on ``search_web`` is deployment-derived, but the engines BEHIND the
verticals (and the deliberately disabled, API-billed ones an explicit
bang still reaches) stay invisible until a search comes back thin -- so
the model guesses.  ONE read-only inventory call answers it: the usable
categories with their engine counts, plus every default-disabled engine
with the bang shortcut that reaches it.  The text rides the tool-result
feed (the model's copy) AND the settlement's ``preview`` (the timeline
row's expanded body) -- one builder, two readers."""

import typing as t

from searx.zjsearch.ai.tools.search_web import available_categories

LIST_ENGINES_TOOL = "list_engines"

_MAX_DISABLED = 80
"""The bangable-engines cap -- a deployment listing more disabled engines
than this gets a tail note instead of the rest (the inventory is a map,
not an audit)."""


def list_engines_spec() -> dict[str, t.Any]:
    """The ``list_engines`` tool spec."""
    return {
        "name": LIST_ENGINES_TOOL,
        "description": (
            "List the search ENGINES this deployment carries: the enabled"
            " ones grouped by category (a category search on search_web"
            " fans out across every enabled engine in that vertical), and"
            " the engines kept disabled by default -- those are still"
            " reachable by prefixing a query with their bang"
            ' (e.g. "!bocha gpu prices"); useful for API-billed engines the'
            " deployment deliberately holds back.  Call it when unsure"
            " which vertical fits the question, when searches keep coming"
            " back thin or empty (the right engine may be disabled), or"
            " before relying on a niche vertical.  Read-only and instant;"
            " once per run is usually enough."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
        },
    }


def _disabled_engines() -> list[tuple[str, str, list[str], bool]]:
    """The default-disabled engines that a bang still reaches: (name,
    shortcut, categories, paid), alphabetically.  ``paid`` = the
    deployment configured an ``api_key`` for it (every call costs
    money -- the executor holds such bangs until the user approves).
    Engines ``inactive`` in the settings are excluded -- no bang
    unregisters them."""
    from searx.engines import engines as engine_map, is_engine_active  # pylint: disable=import-outside-toplevel

    out: list[tuple[str, str, list[str], bool]] = []
    for name in sorted(engine_map):
        engine = engine_map[name]
        if engine.disabled and is_engine_active(engine):
            paid = bool(str(getattr(engine, "api_key", "") or "").strip())
            out.append((name, str(engine.shortcut or name), sorted(set(engine.categories)), paid))
    return out


def build_inventory() -> tuple[str, int, int, dict[str, t.Any]]:
    """The inventory TEXT (the model's feed copy) plus the STRUCTURED
    ``(enabled_engine_count, category_count, inventory)`` -- the inventory
    dict rides the settlement's ``inventory`` key and renders as the
    timeline row's structured body (category chips + bang rows); the text
    stays feed-only."""
    from searx.engines import engines as engine_map, is_engine_active  # pylint: disable=import-outside-toplevel

    enabled = sum(1 for engine in engine_map.values() if is_engine_active(engine) and not engine.disabled)
    categories = available_categories()
    per_category = {name: 0 for name in categories}
    for engine in engine_map.values():
        if not is_engine_active(engine) or engine.disabled:
            continue
        for name in engine.categories:
            if name in per_category:
                per_category[name] += 1
    lines: list[str] = [
        f"This deployment searches {enabled} enabled engines"
        f" across {len(categories)} categories:",
        "  " + " · ".join(f"{name} ({per_category[name]})" for name in categories),
    ]
    disabled = _disabled_engines()
    if disabled:
        lines.append(
            f"Disabled engines ({len(disabled)}) -- a bang prefix still"
            " reaches them, e.g. \"!shortcut keywords\".  Engines marked"
            " PAID are API-billed: one ask_user confirmation is required"
            " before the first paid bang of a run (the executor holds"
            " it otherwise):"
        )
        shown = disabled[:_MAX_DISABLED]
        lines.extend(
            f"  {name} (bang: {shortcut}{' , PAID' if paid else ''}) -- {', '.join(cats) if cats else 'no category'}"
            for name, shortcut, cats, paid in shown
        )
        if len(disabled) > len(shown):
            lines.append(f"  … and {len(disabled) - len(shown)} more")
        lines.append(
            "Bangs are for these held-back engines (or an engine the user"
            " names) -- a category search already fans out across every"
            " enabled engine in that vertical."
        )
    inventory = {
        "total": enabled,
        "categories": [{"name": name, "count": per_category[name]} for name in categories],
        "disabled": [
            {"name": name, "bang": shortcut, "cats": cats, "paid": paid}
            for name, shortcut, cats, paid in disabled[:_MAX_DISABLED]
        ],
    }
    return "\n".join(lines), enabled, len(categories), inventory


def run_call() -> tuple[str, dict[str, t.Any]]:
    """One tool call -> (model feed, settlement extras).  The extras carry
    ``inventory`` (the STRUCTURED listing -- the timeline row's expanded
    body renders it as category chips + bang rows) and ``n`` (the
    enabled-engine count for the row's metric).  The feed text is the
    model's copy; the debug pane shows its head as the receipt."""
    text, enabled, _category_count, inventory = build_inventory()
    return text, {"inventory": inventory, "n": enabled}
