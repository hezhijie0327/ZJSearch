# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search: the ``calculator`` tool's model-facing surface.

The name, the spec and the call parser live here beside the other
tools; the EVALUATOR (the whitelisted-AST walk) is a capability --
:py:mod:`searx.zjsearch.ai.capabilities.calculator` -- a tool answers
"what does the model see and say", a capability answers "what actually
happens".  The researcher prompt's ``<calculator>`` block and the
timeline rows speak the registered string, never a literal.
"""

import json
import typing as t

CALCULATOR_TOOL = "calculator"

_MAX_EXPRESSION = 500
"""Expression length cap -- the model writes one-liners, not programs."""


def calculator_spec() -> dict[str, t.Any]:
    """The ``calculator`` tool spec -- one api, the model writes ONE
    expression per call (substituting variables itself; no variable
    binding surface)."""
    return {
        "name": CALCULATOR_TOOL,
        "description": (
            "Evaluate ONE mathematical expression exactly -- arithmetic,"
            " powers, roots, logs, trig (radians), factorials, min/max/sum"
            " over lists, and statistics (mean, median, mode, stdev,"
            " variance, harmonic_mean).  Use it for EVERY non-trivial"
            " number the answer reports: sums, differences, ratios,"
            " percentages, averages, growth rates -- never compute in your"
            " head, the result comes back exact.  Syntax: python-like"
            ' ("2 + 3 * 4", "sqrt(2)**2", "round(10/3, 2)",'
            ' "mean([1, 2, 3, 4])", "35 * 1.08").'
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": (
                        "One mathematical expression, python-like syntax:"
                        ' "2 + 3 * 4", "sqrt(1764)", "35 * 1.08",'
                        ' "mean([12.5, 13.2, 11.9])", "round(10 / 3, 4)".'
                    ),
                },
                "precision": {
                    "type": "number",
                    "description": "Optional decimal places (0-12, default 10).",
                },
            },
            "required": ["expression"],
        },
    }


def parse_calculator_call(call: dict[str, t.Any]) -> tuple[str, int]:
    """(expression, precision) of one ``calculator`` call -- sanitized:
    the expression is capped, the precision clamped to the legal range."""
    try:
        args = json.loads(str(call.get("arguments") or "") or "{}")
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    expression = str(args.get("expression") or "").strip()[:_MAX_EXPRESSION]
    try:
        precision = max(0, min(int(args.get("precision")), 12))
    except (TypeError, ValueError):
        precision = 10
    return expression, precision
