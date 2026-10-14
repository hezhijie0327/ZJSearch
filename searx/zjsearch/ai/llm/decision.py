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
import typing as t

from searx.zjsearch.ai.core import config as core_config
from searx.zjsearch.ai.core import security

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
    return core_config.zj_block("decision")


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected decision SDK: ``typesafe`` (the first family; the
    registry pre-embeds the selection for the next)."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "typesafe")
    return kind if kind in SDKS else "typesafe"


def decision_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_DECISION_KEY`` environment."""
    return core_config.env_key(cfg_block, "ZJSEARCH_DECISION_KEY")


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


def capability() -> dict[str, str] | None:
    """The page-data ``decision`` payload (token + model label); ``None``
    when the feature is off or unconfigured -- the client hides the
    surface then (the browser proxies its judgments through the route
    with this token)."""
    if not enabled() or not configured():
        return None
    return {"tk": security.issue_token(), "model": str(cfg().get("model"))}


FEATURE_DEFAULTS: dict[str, dict[str, t.Any]] = {
    # the framework-side judgment gates (v5's model funnel): every gate
    # FAILS OPEN -- an unconfigured decision model, a timeout or a low
    # confidence simply leaves the previous behavior standing.  The
    # thresholds are starting points (the RAG-gate cookbook's), to be
    # tuned against real runs.
    "read_gate": {"enabled": True, "injection_max": 0.70, "relevant_min": 0.45},
    "diversity": {"enabled": True, "cosine": 0.92},
    "coverage": {"enabled": True},
    "plan_review": {"enabled": True, "max_tasks": 4},
    "depth_probe": {
        "enabled": True,
        # the round LADDERS the probe's score (0-4) scales to -- the
        # model-controlled depth made literal: an exhaustive question
        # earns a huge runway, a quick lookup a small one
        "ladder_deep": [12, 24, 48, 96, 120],
        "ladder_balanced": [4, 8, 16, 24, 32],
    },
    "evidence_check": {"enabled": True, "head": 8, "pass_min": 0.45},
    # the report SYNTHESIZE's per-section citation spot check (runs/search/
    # report/synth.py): sampled claims judged against their sources, a
    # failing claim earns one targeted rewrite BEFORE delivery
    "citation_gate": {"enabled": True, "support_min": 0.5},
    "memory_dedup": {
        "enabled": True,
        # the cosine above which a new fact "reads as" a stored one -- the
        # save gate AND the extractor's filter share the one floor
        "cosine": 0.92,
    },
    "clarify_gate": {
        "enabled": True,
        # the noul floors: BELOW either the query is genuinely ambiguous OR
        # high-stakes and the (expensive) clarify gate may ask; above both
        # the query reads clear AND safe -- skip the round-trip.  Two
        # questions on purpose: "which index fund should I buy" reads clear
        # and still must not run on a guess.
        "ambiguous_min": 0.65,
        "high_stakes_min": 0.60,
    },
}


def features(key: str) -> dict[str, t.Any]:
    """One framework gate's merged config: ``zjsearch.decision.features.
    <key>`` over :py:data:`FEATURE_DEFAULTS` -- unknown keys fall back to
    the defaults wholesale (a gate the deployment never named still
    works, still fails open)."""
    merged = dict(FEATURE_DEFAULTS.get(key, {}))
    block = cfg().get("features")
    if isinstance(block, dict) and isinstance(block.get(key), dict):
        merged.update(block[key])
    return merged


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
    ``score`` (criteria = ordered legend), ``noul`` (boolean).  The call
    itself delegates to the FAMILY surface (``llm.sdk.typesafe`` -- the
    client lifecycle, the extra_headers/extra_body escape hatches and the
    typed-answer downgrade live there), like the rerank service
    delegates to the dashscope family."""
    if not enabled() or not configured():
        return None
    block = cfg()
    family = sdk(block)
    if family != "typesafe":
        # the registry's seam: future decision families branch here
        return None
    if importlib.util.find_spec(SDK_PACKAGES["typesafe"]) is None:
        return None
    trimmed = {
        name: questions[name]
        for name in list(questions)[:MAX_QUESTIONS]
        if isinstance(questions.get(name), dict) and questions[name].get("type")
    }
    if not trimmed:
        return None
    from .sdk.typesafe import factory  # pylint: disable=import-outside-toplevel

    bound = {**block, "api_key": decision_key(block)}
    try:
        return factory(bound, str(block.get("base_url") or ""), "typesafe", "decision").system_one(
            state=str(state)[:MAX_STATE_CHARS] if isinstance(state, str) else state,
            questions=trimmed,
            timeout=timeout,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_decision: judge failed: %s", exc)
        return None
