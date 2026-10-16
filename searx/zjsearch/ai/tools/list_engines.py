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

INSTRUCTIONS = """\
Consult it ONCE, and only when it can change a decision: when unsure
which vertical fits the question, when searches keep coming back thin
or empty (the right engine may be held back behind its bang), or before
relying on a niche vertical -- not on every run.  The thin-search case
drills down: pass category to see exactly which engines serve THAT
vertical (enabled by name, held-back by bang) instead of the whole map.
A held-back API-billed engine costs money per call: its bang is HELD
until the user approves the ask_user confirmation -- paid: true lists
exactly those."""

_MAX_DISABLED = 80
"""The bangable-engines cap -- a deployment listing more disabled engines
than this gets a tail note instead of the rest (the inventory is a map,
not an audit)."""


def list_engines_spec() -> dict[str, t.Any]:
    """The ``list_engines`` tool spec."""
    return {
        "name": LIST_ENGINES_TOOL,
        "description": """\
List the search ENGINES this deployment carries: the enabled ones
grouped by category (a category search on search_web fans out across
every enabled engine in that vertical), and the engines kept disabled
by default -- those are still reachable by prefixing a query with their
bang (e.g. "!bocha gpu prices"); API-billed engines the deployment
deliberately holds back carry their paid marker.  Read-only and
instant.  Without arguments it lists the WHOLE inventory; drill into
ONE vertical with category, and filter the held-back list with paid.""",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": list(available_categories()),
                    "description": (
                        "Optional: drill into ONE vertical -- the listing"
                        " becomes that category's enabled engines (by"
                        " name) plus the held-back ones whose bang serves"
                        " it.  The enum is the same deployment-derived"
                        " set search_web's category accepts."
                    ),
                },
                "paid": {
                    "type": "boolean",
                    "description": (
                        "Optional filter on the held-back engines: true ="
                        " only the API-billed ones (which bangs cost"
                        " money), false = only the free ones.  Omit for"
                        " all."
                    ),
                },
            },
            "required": [],
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


def build_inventory(
    category: str | None = None,
    paid: bool | None = None,
) -> tuple[str, int, int, dict[str, t.Any]]:
    """The inventory TEXT (the model's feed copy) plus the STRUCTURED
    ``(enabled_engine_count, category_count, inventory)`` -- the inventory
    dict rides the settlement's ``inventory`` key and renders as the
    timeline row's structured body (category chips + bang rows); the text
    stays feed-only.  ``category`` drills into ONE vertical (its enabled
    engines by NAME, and only the held-back engines whose bang serves
    it); ``paid`` filters the held-back list to API-billed (true) or
    free (false).  Both unset = the whole map."""
    from searx.engines import engines as engine_map, is_engine_active  # pylint: disable=import-outside-toplevel

    enabled = sum(1 for engine in engine_map.values() if is_engine_active(engine) and not engine.disabled)
    categories = available_categories()
    if category is not None and category not in categories:
        category = None
    shown_categories = [category] if category else categories
    per_category = {name: 0 for name in categories}
    enabled_names: dict[str, list[str]] = {name: [] for name in categories}
    for engine in engine_map.values():
        if not is_engine_active(engine) or engine.disabled:
            continue
        for name in engine.categories:
            if name in per_category:
                per_category[name] += 1
                if category is None or name == category:
                    enabled_names[name].append(str(engine.name))
    if category:
        lines: list[str] = [
            f"The '{category}' vertical: {per_category[category]} enabled"
            " engines"
            + (
                " -- " + ", ".join(enabled_names[category])
                if enabled_names[category]
                else " (none enabled)"
            )
            + ".",
        ]
    else:
        lines = [
            f"This deployment searches {enabled} enabled engines"
            f" across {len(categories)} categories:",
            "  " + " · ".join(f"{name} ({per_category[name]})" for name in categories),
        ]
    disabled = [
        row
        for row in _disabled_engines()
        if (category is None or category in row[2]) and (paid is None or row[3] == paid)
    ]
    if paid is not None and category is None:
        lines.insert(
            0,
            "Held-back engines, " + ("API-billed only" if paid else "free only") + ":",
        )
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
        "categories": [{"name": name, "count": per_category[name]} for name in shown_categories],
        "disabled": [
            {"name": name, "bang": shortcut, "cats": cats, "paid": paid}
            for name, shortcut, cats, paid in disabled[:_MAX_DISABLED]
        ],
    }
    return "\n".join(lines), enabled, len(categories), inventory


def run_call(args: dict[str, t.Any] | None = None) -> tuple[str, dict[str, t.Any]]:
    """One tool call -> (model feed, settlement extras).  The optional
    arguments drill the listing: ``category`` (validated against the
    deployment's usable set -- an unknown value silently falls back to
    the whole map, like search_web's sanitizer) and ``paid`` (tri-state
    filter on the held-back engines).  The extras carry ``inventory``
    (the STRUCTURED listing -- the timeline row's expanded body renders
    it as category chips + bang rows) and ``n`` (the enabled-engine
    count for the row's metric).  The feed text is the model's copy;
    the debug pane shows its head as the receipt."""
    call_args = args if isinstance(args, dict) else {}
    category = str(call_args.get("category") or "").strip().lower()
    paid = call_args.get("paid")
    text, enabled, _category_count, inventory = build_inventory(
        category or None,
        bool(paid) if isinstance(paid, bool) else None,
    )
    return text, {"inventory": inventory, "n": enabled}
