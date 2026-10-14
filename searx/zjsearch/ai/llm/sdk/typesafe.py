# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The SystemOne typesafe SDK factory -- the FIRST decision-model family.

The decision-model registry (``infra/decision.py``) pre-embeds the SDK
selection: future decision families add a sibling module here and a line
in that registry, mirroring the chat transports' pattern.

The surface is deliberately narrow -- ONE forward pass answers NAMED
questions about a state (``choice`` classification / ``score`` graded /
``noul`` boolean, each with its probability distribution) and returns
JSON-safe answers; there is no streaming, no tools, no text generation.
The call is a single synchronous HTTP round trip (tens of milliseconds)
-- it runs on the calling thread by design.
"""

import typing as t

from ..config import extra_body, extra_headers
from .clients import sdk_timeout

KIND = "typesafe"


def _field(obj: t.Any, key: str, default: t.Any = None) -> t.Any:
    """One field off a response: the SDK hands back pydantic models and
    plain dicts interchangeably -- both read through here."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        value = obj.get(key, default)
        return default if value is None else value
    value = getattr(obj, key, default)
    return default if value is None else value


def _plain(value: t.Any) -> t.Any:
    """One typed answer model (ChoiceAnswer / ScoreAnswer / NoulAnswer)
    downgraded to a JSON-safe dict -- pydantic's own dump when the object
    speaks it, the dict when it is one, str for the rest."""
    dump = getattr(value, "model_dump", None)
    if dump is not None:
        return dump()
    return value if isinstance(value, dict) else str(value)


class TypesafeSdk:  # pylint: disable=too-few-public-methods
    """The bound typesafe family surface: one instance per (config, base)
    binding."""

    def __init__(self, cfg: dict[str, t.Any], base: str, kind: str, family: str):
        self.cfg = cfg
        self.base = base
        self.kind = kind
        self.family = family

    def system_one(
        self,
        state: t.Any,
        questions: dict[str, dict[str, t.Any]],
        timeout: float | None = None,
    ) -> dict[str, t.Any] | None:
        """One System-One judgment: ``(state, questions) -> {"answers",
        "usage", "latency_ms"}`` with JSON-safe answers.  Raw question
        dicts are accepted (the SDK coerces its own typed models); the
        client is one self-contained connection per call, closed on every
        path.  The caller's lens degrades on ``None`` (raised errors
        propagate -- the service owns the fail-open)."""
        from typesafe_sdk import TypeSafeClient  # pylint: disable=import-outside-toplevel

        client = TypeSafeClient(
            api_key=str(self.cfg.get("api_key") or ""),
            # a base ending in /v1 is always a misconfig (the SDK appends
            # /v1/systemone itself -- the SystemOne contract's
            # "{workspace}/compatible-mode" ending); strip it instead of
            # serving the workspace a doubled /v1/v1 path
            base_url=(self.base.rstrip("/").removesuffix("/v1") if self.base else None) or None,
            model=str(self.cfg.get("model")),
            timeout=timeout or sdk_timeout(),
            headers=extra_headers(self.cfg) or None,
        )
        try:
            response = client.system_one(
                state,
                questions,
                model=str(self.cfg.get("model")),
                timeout=timeout or sdk_timeout(),
                extra_body=extra_body(self.cfg) or None,
            )
        finally:
            client.close()
        answers = _field(response, "answers")
        if not isinstance(answers, dict) or not answers:
            return None
        usage = _field(response, "usage")
        return {
            "answers": {name: _plain(answer) for name, answer in answers.items()},
            "usage": _plain(usage) if usage else {},
            "latency_ms": _field(response, "latency_ms"),
        }


def factory(cfg: dict[str, t.Any], base: str, kind: str = KIND, family: str = "typesafe") -> TypesafeSdk:
    """The typesafe family factory: config + base bound into one callable
    surface (mirrors the chat families' factories)."""
    return TypesafeSdk(cfg, base, kind, family)
