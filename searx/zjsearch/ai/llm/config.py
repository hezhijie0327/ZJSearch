# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``zjsearch.ai`` settings surface.

Everything the deployment configures about the AI transport and its
feature flags lives here: the shared block (``zjsearch.ai``), the
per-feature blocks and flags, the wire-dialect selection and the
page-data capability payloads.  Read defensively throughout -- the
blocks are absent unless the deployment defines them.
"""

import importlib.util
import ipaddress
import os
import typing as t
from urllib.parse import urlsplit

from searx import settings

from . import security

ENDPOINT_KINDS = ("openai_chat_completions", "anthropic", "openai_responses", "gemini")
"""The ``zjsearch.ai.sdk`` values -- one official SDK per family: AsyncOpenAI
drives both OpenAI dialects, AsyncAnthropic the Messages API, google-genai
the Gemini API."""

SDK_PACKAGES = {
    "openai_chat_completions": "openai",
    "openai_responses": "openai",
    "anthropic": "anthropic",
    "gemini": "google.genai",
}
"""The import name of the SDK package each dialect needs."""


def ai_cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai`` settings block.  Read defensively (plain dict
    access): the block is absent unless the deployment defines it."""
    cfg = settings.get("zjsearch", {}).get("ai", {})
    return cfg if isinstance(cfg, dict) else {}


def chat_key(cfg: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_AI_KEY`` environment."""
    return str(cfg.get("api_key") or "") or os.environ.get("ZJSEARCH_AI_KEY", "")


def extra_headers(cfg: dict[str, t.Any]) -> dict[str, str] | None:
    extra = cfg.get("extra_headers")
    return {str(name): str(value) for name, value in extra.items()} if isinstance(extra, dict) else None


def extra_body(cfg: dict[str, t.Any]) -> dict[str, t.Any] | None:
    return cfg.get("extra_body") if isinstance(cfg.get("extra_body"), dict) else None


def params(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    raw = cfg.get("params")
    return raw if isinstance(raw, dict) else {}


def endpoint(cfg: dict[str, t.Any]) -> tuple[str, str]:
    """The wire dialect (``zjsearch.ai.sdk``) and the ``base_url`` exactly as
    configured -- no rewriting.  Each SDK appends its own method paths to
    the base, so the value is per dialect (see the README): the openai
    dialects take ``https://api.openai.com/v1``, anthropic the bare origin
    (``https://api.anthropic.com``), gemini the origin or a gateway prefix
    that already includes the API name (``https://gw.example.com/gemini``)."""
    kind = str(cfg.get("sdk") or "openai_chat_completions")
    if kind not in ENDPOINT_KINDS:
        kind = "openai_chat_completions"
    return kind, str(cfg.get("base_url") or "")


def endpoint_is_local(url: str) -> bool:
    """True for loopback / internal LLM endpoints (LM Studio, ollama, a
    self-hosted gateway on an ``.internal`` name): those must not go
    through the outgoing proxy / Tor."""
    host = (urlsplit(url).hostname or "").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def configured(cfg: dict[str, t.Any]) -> bool:
    """True when the feature is on and its transport is fully specified: a
    model and a dialect -- the base_url may stay empty only for the gemini
    dialect (the google-genai default endpoint)."""
    if not cfg.get("enabled") or not cfg.get("model"):
        return False
    kind, base = endpoint(cfg)
    return bool(base) or kind == "gemini"


def capability() -> dict[str, str] | None:
    """The ``ai`` payload of the page-data globals (token + model label);
    ``None`` when the feature is off or not fully configured."""
    cfg = ai_cfg()
    if not configured(cfg):
        return None
    return {"tk": security.issue_token(), "model": str(cfg.get("model"))}


def feature_cfg(feature: str) -> dict[str, t.Any]:
    """The ``zjsearch.ai.<feature>`` settings block (absent unless the
    deployment defines it)."""
    cfg = ai_cfg().get(feature)
    return cfg if isinstance(cfg, dict) else {}


def feature_enabled(feature: str) -> bool:
    """The per-feature flag: ``zjsearch.ai.<feature>.enabled`` -- ``True``
    unless explicitly switched off."""
    return bool(feature_cfg(feature).get("enabled", True))


def feature_capability(feature: str) -> dict[str, str] | None:
    """The page-data capability payload for ONE feature (token + model
    label); ``None`` when the feature flag is off or the transport is
    unconfigured -- the client hides the feature's entry point then."""
    if not feature_enabled(feature) or not configured(ai_cfg()):
        return None
    return capability()


def sdk_missing(cfg: dict[str, t.Any]) -> str | None:
    """The missing transport SDK package for the configured dialect, or
    ``None`` when it imports -- the install gate the feature routes
    share (each logs its own wording)."""
    kind = endpoint(cfg)[0]
    package = SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        return package
    return None
