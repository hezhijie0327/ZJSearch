# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The calculator capability: exact arithmetic and statistics for the
agent, so the model never multiplies three numbers by "reasoning" about
them.  One ``calculator`` tool, ONE api (``calculate``): a single
mathematical expression evaluated through a WHITELISTED AST walk -- no
``eval``, no attribute access, no names outside the function/constant
table.  The stdlib ``math`` + ``statistics`` modules supply the
functions (trig/logs/exp, rounding, min/max/sum, mean/median/stdev),
``pi``/``e``/``tau``/``phi``/``inf`` the constants; ``List``/``Tuple``
literals feed the aggregate functions.  Symbolic algebra (solve /
differentiate -- LobeHub's nerdamer surface) would need sympy and stays
out until a deployment asks for it.

The tool is registered for EVERY research run: arithmetic is cheap, an
unsound number in a cited answer is not."""

import ast
import json
import math
import operator
import statistics
import typing as t

CALCULATOR_TOOL = "calculator"

_MAX_EXPRESSION = 500
"""Expression length cap -- the model writes one-liners, not programs."""
_MAX_NODES = 200
"""AST size cap: a pathological deep-nesting bomb dies here before it
can burn cycles."""
_MAX_PRECISION = 12

_FUNCTIONS: dict[str, t.Callable[..., t.Any]] = {
    "sqrt": math.sqrt,
    "cbrt": getattr(math, "cbrt", lambda x: math.copysign(abs(x) ** (1 / 3), x)),
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "atan2": math.atan2,
    "log": math.log,
    "log2": math.log2,
    "log10": math.log10,
    "exp": math.exp,
    "pow": pow,
    "abs": abs,
    "round": round,
    "floor": math.floor,
    "ceil": math.ceil,
    "factorial": math.factorial,
    "degrees": math.degrees,
    "radians": math.radians,
    "gcd": math.gcd,
    "lcm": math.lcm,
    "min": min,
    "max": max,
    "sum": sum,
    "mean": statistics.mean,
    "median": statistics.median,
    "mode": statistics.mode,
    "stdev": statistics.stdev,
    "pstdev": statistics.pstdev,
    "variance": statistics.variance,
    "pvariance": statistics.pvariance,
    "harmonic_mean": statistics.harmonic_mean,
}

_CONSTANTS: dict[str, float] = {
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
    "phi": (1 + math.sqrt(5)) / 2,
    "inf": math.inf,
}

_BINOPS: dict[type[ast.operator], t.Callable[[t.Any, t.Any], t.Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_ALLOWED_UNARYOPS = (ast.UAdd, ast.USub)


class CalculatorError(ValueError):
    """One rejected expression -- the message goes back to the model, so
    it can fix the call instead of guessing."""


def _value(node: ast.expr) -> t.Any:
    """The whitelisted AST walk: every node type not explicitly allowed
    raises (attribute access, subscripts, lambdas, comprehensions,
    strings -- the whole escape surface dies here)."""
    if isinstance(node, ast.Expression):
        return _value(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp):
        op = _BINOPS.get(type(node.op))
        if op is None:
            raise CalculatorError(f"unsupported operator: {type(node.op).__name__}")
        return op(_value(node.left), _value(node.right))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, _ALLOWED_UNARYOPS):
        value = _value(node.operand)
        return -value if isinstance(node.op, ast.USub) else +value
    if isinstance(node, (ast.Name, ast.Call)):
        return _named(node)
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_value(item) for item in node.elts]
    raise CalculatorError(f"unsupported syntax: {type(node).__name__}")


def _named(node: ast.Name | ast.Call) -> t.Any:
    """Name (function/constant lookup) and Call nodes -- the only place
    a callable can come from is the whitelist table."""
    if isinstance(node, ast.Name):
        if node.id in _FUNCTIONS:
            return _FUNCTIONS[node.id]
        if node.id in _CONSTANTS:
            return _CONSTANTS[node.id]
        raise CalculatorError(f"unknown name: {node.id!r}")
    func = _FUNCTIONS.get(node.func.id) if isinstance(node.func, ast.Name) else None
    if func is None:
        raise CalculatorError("only plain whitelisted functions are callable")
    if node.keywords:
        raise CalculatorError("keyword arguments are not supported")
    return func(*(_value(arg) for arg in node.args))


def calculate(expression: str, precision: int = 10) -> str:
    """One expression -> one result string (``"12"`` / ``"3.1416"`` /
    ``"4.5"``), or raise :py:class:`CalculatorError`.  Floats round to
    ``precision`` decimals (capped); ints stay exact; huge magnitudes
    keep repr so nothing silently becomes ``inf``."""
    expression = expression.strip()[:_MAX_EXPRESSION]
    if not expression:
        raise CalculatorError("empty expression")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise CalculatorError(f"syntax error: {exc.msg}") from exc
    if sum(1 for _ in ast.walk(tree)) > _MAX_NODES:
        raise CalculatorError("expression too large")
    try:
        result = _value(tree)
    except CalculatorError:
        raise
    except ZeroDivisionError as exc:
        raise CalculatorError("division by zero") from exc
    except OverflowError as exc:
        raise CalculatorError("result too large") from exc
    except (TypeError, ValueError, statistics.StatisticsError) as exc:
        raise CalculatorError(f"invalid operation: {exc}") from exc
    precision = max(0, min(int(precision), _MAX_PRECISION))
    if isinstance(result, complex):
        raise CalculatorError("complex results are not supported")
    if isinstance(result, float):
        if math.isnan(result):
            raise CalculatorError("result is not a number")
        if math.isinf(result):
            raise CalculatorError("result is infinite")
        if result.is_integer() and abs(result) < 1e15:
            return str(int(result))
        rounded = round(result, precision)
        text = f"{rounded:.{precision}f}".rstrip("0").rstrip(".")
        return text or "0"
    return str(result)


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


def evaluate_call(call: dict[str, t.Any], rnd: int, wire_id: int) -> tuple[str, dict[str, t.Any]]:
    """One tool call -> (model feed, wire event): the expression is
    evaluated HERE (instant, no pool slot) and the ``calc`` event carries
    the exact result to the client's timeline row."""
    expression, precision = parse_calculator_call(call)
    try:
        result = calculate(expression, precision)
    except CalculatorError as exc:
        return f"error: {exc}", {"round": rnd, "id": wire_id, "expression": expression, "status": "error"}
    return (
        f'{{"expression": {expression!r}, "result": "{result}"}}',
        {"round": rnd, "id": wire_id, "expression": expression, "result": result, "status": "ok"},
    )


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
        precision = max(0, min(int(args.get("precision")), _MAX_PRECISION))
    except (TypeError, ValueError):
        precision = 10
    return expression, precision
