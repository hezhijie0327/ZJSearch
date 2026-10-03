# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The decision-model service: config + the server-side call.

A dedicated block (``zjsearch.decision``) for the SYSTEM-ONE class of
decision models: one forward pass answers NAMED QUESTIONS about a state
-- choice (classification), score (graded), noul (boolean) -- each with
its probability distribution / confidence, WITHOUT generating prose.
The high-frequency structured-judgment primitive (ticket triage, content
review, agent routing, result verification).

``zjsearch.decision.sdk``: ``typesafe`` (the typesafe-sdk
``TypeSafeClient.system_one`` surface; the registry dict + package gate
are the pre-embedded SDK-selection seam -- future decision families slot
in beside it).  The call is a single synchronous HTTP round trip (tens of
milliseconds) -- it runs on the calling thread by design, no loop
bridging.
"""

import importlib.util
import logging
import os
import typing as t

from searx import settings

logger = logging.getLogger(__name__)

SDKS = ("typesafe",)
"""The ``zjsearch.decision.sdk`` values -- one SDK per decision API
family.  ``typesafe`` is the first; the registry is the seam for the
next (the selection pre-embeds the shape, not just the name)."""

SDK_PACKAGES = {"typesafe": "typesafe_sdk"}
"""The import name of the SDK package each decision sdk needs."""

MAX_QUESTIONS = 12
"""Questions per judgment call -- a triage routes a handful of named
questions, not a questionnaire."""

MAX_STATE_CHARS = 24_000
"""The state payload's truncation point (the decision model reads the
state in one forward pass; a novel is not what it is for)."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.decision`` settings block (absent unless the
    deployment defines it): ``enabled`` / ``base_url`` / ``api_key`` /
    ``model`` / ``sdk``."""
    zjs = settings.get("zjsearch", {})
    block = zjs.get("decision") if isinstance(zjs, dict) else None
    return block if isinstance(block, dict) else {}


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected decision SDK: ``typesafe`` (the first family; the
    registry pre-embeds the selection for the next)."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "typesafe")
    return kind if kind in SDKS else "typesafe"


def decision_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_DECISION_KEY`` environment."""
    return str(cfg_block.get("api_key") or "") or os.environ.get("ZJSEARCH_DECISION_KEY", "")


def enabled() -> bool:
    """The decision feature flag: ``zjsearch.decision.enabled`` -- True
    unless explicitly switched off."""
    return cfg().get("enabled") is not False


def configured() -> bool:
    """True when the decision route may serve: model and key present
    (``base_url`` for a dedicated workspace, absent for the public
    endpoint)."""
    block = cfg()
    return bool(block.get("model") and decision_key(block))


def sdk_missing() -> str | None:
    """The missing SDK package for the configured decision sdk, or
    ``None`` when it imports (the install gate)."""
    package = SDK_PACKAGES.get(sdk(), "typesafe_sdk")
    if importlib.util.find_spec(package) is None:
        return package
    return None


def judge(  # pylint: disable=too-many-return-statements
    state: t.Any,
    questions: dict[str, dict[str, t.Any]],
    timeout: float | None = None,
) -> dict[str, t.Any] | None:
    """One System-One judgment: ``state`` (text or a JSON object) +
    ``questions`` (the wire question dict: type/criteria/instructions
    per name) -> ``{"answers": {...}, "usage": {...}, "latency_ms": ...}``
    verbatim from the model; ``None`` when the feature is off/unconfigured
    or the upstream fails -- every consumer degrades silently (a decision
    is a lens, not a dependency).  The question shapes follow the SDK's
    own vocabulary: ``choice`` (criteria = label -> description),
    ``score`` (criteria = ordered legend), ``noul`` (boolean)."""
    if not enabled() or not configured():
        return None
    block = cfg()
    family = sdk(block)
    if family != "typesafe":
        # the registry's seam: future decision families branch here
        return None
    if importlib.util.find_spec(SDK_PACKAGES["typesafe"]) is None:
        return None
    from typesafe_sdk import TypeSafeClient  # pylint: disable=import-outside-toplevel

    trimmed = {
        name: questions[name]
        for name in list(questions)[:MAX_QUESTIONS]
        if isinstance(questions.get(name), dict) and questions[name].get("type")
    }
    if not trimmed:
        return None
    try:
        client = TypeSafeClient(
            api_key=decision_key(block),
            base_url=(str(block.get("base_url")).rstrip("/") if block.get("base_url") else None) or None,
            timeout=timeout or 30.0,
        )
        response = client.system_one(
            state=str(state)[:MAX_STATE_CHARS] if isinstance(state, str) else state,
            questions=trimmed,
            model=str(block.get("model")),
            timeout=timeout or 30.0,
        )
        client.close()
        answers = getattr(response, "answers", None)
        if answers is None:
            return None

        def _plain(value: t.Any) -> t.Any:
            """The SDK's typed answer models (ChoiceAnswer / ScoreAnswer /
            NoulAnswer) downgrade to plain dicts -- pydantic's own dump when
            the object speaks it, the dict when it is one, str for the
            rest."""
            dump = getattr(value, "model_dump", None)
            if dump is not None:
                return dump()
            return value if isinstance(value, dict) else str(value)

        plain_answers = {name: _plain(answer) for name, answer in answers.items()}
        usage = getattr(response, "usage", None)
        plain_usage = (
            usage.model_dump()
            if hasattr(usage, "model_dump")
            else (dict(usage) if isinstance(usage, dict) else {"input_tokens": getattr(usage, "input_tokens", 0) or 0})
        )
        return {
            "answers": plain_answers,
            "usage": plain_usage,
            "latency_ms": getattr(response, "latency_ms", None),
        }
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_decision: judge failed: %s", exc)
        return None
