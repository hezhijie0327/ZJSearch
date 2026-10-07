# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``extract_table`` tool: the report mode's structured-extraction
surface.  While reading, the researcher solidifies scattered figures
into ONE table artifact -- columns, rows, and the per-row ``refs`` (the
registry [n]s) -- instead of leaving the numbers in prose for the
writer to reassemble from memory.  The artifact rides the wire to the
client (a real table with per-row citation chips) and enters the
corresponding section's context as VERIFIED material: the writer cites
and explains the table, it never rebuilds one.  ``refs`` are validated
against the run's registry -- a number the researcher has not minted is
rejected, same trust model as the gallery whitelist."""

import typing as t

from searx.zjsearch.ai.core.text import raw_args

EXTRACT_TOOL = "extract_table"

MAX_COLUMNS = 8
"""A report table wider than this does not render; the spec steers to
the essential columns instead."""
MAX_ROWS = 30
MAX_CELL = 160
"""Per-cell cap -- a cell is a figure or a short phrase, never prose."""


def extract_spec() -> dict[str, t.Any]:
    """The ``extract_table`` tool spec."""
    return {
        "name": EXTRACT_TOOL,
        "description": (
            "Record ONE data table you have assembled from the sources you"
            " read -- the report's structured-evidence channel.  Use it"
            " whenever a section's material forms a matrix (companies x"
            " metrics, options x tradeoffs, region x figures): each row"
            " lists its values and the [n] sources that back them.  The"
            " table reaches the reader as a real table with per-row"
            " citations and reaches the writer as verified material -- do"
            " NOT re-type the same numbers in prose afterwards, cite and"
            " interpret the table instead.  Every row's refs must be [n]"
            " sources from THIS run."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "The table's caption, specific (e.g. 头部企业肽原料药产能对比).",
                },
                "columns": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The column headers, 2-8 of them, first column the row identity.",
                },
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "cells": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "The row's values, same order as columns.",
                            },
                            "refs": {
                                "type": "array",
                                "items": {"type": "number"},
                                "description": "The [n] source numbers backing this row.",
                            },
                        },
                        "required": ["cells"],
                    },
                    "description": "The table's rows, most important first.",
                },
                "note": {
                    "type": "string",
                    "description": "Optional one-line reading note (units, window, caveat).",
                },
            },
            "required": ["title", "columns", "rows"],
        },
    }


def parse_extract_call(call: dict[str, t.Any]) -> dict[str, t.Any] | None:
    """One ``extract_table`` call -> the sanitized artifact dict, or
    ``None`` when the call is unusable (title/columns/rows missing)."""
    args = raw_args(call)
    title = str(args.get("title") or "").strip()[:120]
    columns_raw = args.get("columns")
    rows_raw = args.get("rows")
    if not title or not isinstance(columns_raw, list) or not isinstance(rows_raw, list):
        return None
    columns = [str(col or "").strip()[:40] for col in columns_raw if str(col or "").strip()][:MAX_COLUMNS]
    if len(columns) < 2:
        return None
    rows: list[dict[str, t.Any]] = []
    for row_raw in rows_raw[:MAX_ROWS]:
        if not isinstance(row_raw, dict):
            continue
        cells = [str(cell or "").strip()[:MAX_CELL] for cell in (row_raw.get("cells") or [])[:MAX_COLUMNS]]
        if not cells:
            continue
        refs_raw = row_raw.get("refs")
        refs = (
            [int(ref) for ref in refs_raw if isinstance(ref, (int, float)) and int(ref) > 0][:8]
            if isinstance(refs_raw, list)
            else []
        )
        rows.append({"cells": cells, "refs": refs})
    if not rows:
        return None
    return {
        "title": title,
        "columns": columns,
        "rows": rows,
        "note": str(args.get("note") or "").strip()[:200],
    }
