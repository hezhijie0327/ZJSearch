# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The shared LLM transport layer of the theme's AI endpoints.

This package is the INFRA layer everything AI rides on.  The facade
below re-exports the whole cross-package surface -- consumers keep
``from searx.zjsearch.ai import llm`` and read ``llm.<name>``:

- :py:mod:`.config` -- the ``zjsearch.ai`` settings surface, wire-dialect
  selection and page-data capability payloads.
- :py:mod:`.security` -- the stateless HMAC page-data token gate.
- :py:mod:`.clients` -- the cached SDK HTTP clients per transport family.
- :py:mod:`.caching` -- per-dialect request shaping: SDK kwargs and the
  prompt-cache strategies (OpenAI cache-key bucket, Anthropic anchors).
- :py:mod:`.usage` -- the canonical finish/usage meta contract the
  dialect pumps report.
- :py:mod:`.dialects` -- ONE MODULE PER SDK behind one interface
  (``KIND`` / ``JSON_TIERS`` / ``pump`` / ``json_completion``); adding a
  transport is one module + one registry line.
- :py:mod:`.streaming` -- :py:class:`LlmStream`, the queue bridge from
  the shared network event loop to the WSGI thread.
- :py:mod:`.json_gate` -- the tiered structured-object completion the
  gates ride, plus the upstream error-text helper.

Layering (everything imports strictly downwards)::

    dialects -> caching/usage/clients/config
    streaming -> dialects, config
    json_gate -> dialects, streaming, config
    __init__ (facade) -> all of the above
"""

from .config import (
    ENDPOINT_KINDS,
    SDK_PACKAGES,
    ai_cfg,
    capability,
    configured,
    endpoint,
    endpoint_is_local,
    feature_capability,
    feature_cfg,
    feature_enabled,
    sdk_missing,
)
from .json_gate import json_completion, json_object_of, reason_of
from .security import TOKEN_TTL, check_token, issue_token
from .streaming import LlmStream

__all__ = [
    "ENDPOINT_KINDS",
    "SDK_PACKAGES",
    "LlmStream",
    "TOKEN_TTL",
    "ai_cfg",
    "capability",
    "check_token",
    "configured",
    "endpoint",
    "endpoint_is_local",
    "feature_capability",
    "feature_cfg",
    "feature_enabled",
    "issue_token",
    "json_completion",
    "json_object_of",
    "reason_of",
    "sdk_missing",
]
