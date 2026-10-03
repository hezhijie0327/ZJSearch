# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``zjsearch.llm`` settings surface.

Everything the deployment configures about the AI transport and its
feature flags lives here: the shared block (``zjsearch.llm``), the
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

ENDPOINT_KINDS = ("openai", "openai.chat_completions", "openai.responses", "anthropic", "gemini", "dashscope")
"""The canonical ``zjsearch.llm.sdk`` values -- ``SDK_ALIASES`` resolves
shorthand / legacy inputs into one of these before validation."""

SDK_ALIASES = {
    "openai": "openai.responses",
    "openai_chat_completions": "openai.chat_completions",
    "openai_responses": "openai.responses",
}
"""Shorthand + pre-rename sdk values -> the canonical dialect kind: bare
``openai`` is the LATEST OpenAI API (the Responses dialect); the old
dotted-less names resolve to their exact dialect, NOT to the default."""

SDK_PACKAGES = {
    "openai.responses": "openai",
    "openai.chat_completions": "openai",
    "anthropic": "anthropic",
    "gemini": "google.genai",
    "dashscope": "dashscope",
}
"""The import name of the SDK package each canonical dialect needs."""


def llm_cfg() -> dict[str, t.Any]:
    """The ``zjsearch.llm`` settings block.  Read defensively (plain dict
    access): the block is absent unless the deployment defines it."""
    cfg = settings.get("zjsearch", {}).get("llm", {})
    return cfg if isinstance(cfg, dict) else {}


def chat_key(cfg: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_AI_KEY`` environment."""
    return str(cfg.get("api_key") or "") or os.environ.get("ZJSEARCH_AI_KEY", "")


def extra_headers(cfg: dict[str, t.Any]) -> dict[str, str] | None:
    """The ``zjsearch.ai.extra_headers`` block -- HTTP headers merged onto
    EVERY LLM request (per-request ``extra_headers=`` on the openai /
    anthropic SDKs, the client's ``HttpOptions.headers`` on gemini where
    the SDK merges them over its defaults with these winning).  The
    provider-specific header escape hatch (discount / attribution
    headers, a gateway's ``Authorization``)."""
    extra = cfg.get("extra_headers")
    return {str(name): str(value) for name, value in extra.items()} if isinstance(extra, dict) else None


def extra_body(cfg: dict[str, t.Any]) -> dict[str, t.Any] | None:
    """The ``zjsearch.ai.extra_body`` block -- raw JSON body fields the
    chosen SDK has no typed kwarg for (server extensions such as LM
    Studio's ``chat_template_kwargs``), merged into the request body 1:1
    on every dialect."""
    return cfg.get("extra_body") if isinstance(cfg.get("extra_body"), dict) else None


def params(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    """The ``zjsearch.ai.params`` block -- the chosen SDK's ``create()``
    kwargs VERBATIM under their SDK names (no translation; see
    ``caching.model_kwargs`` for the two transport-level additions)."""
    raw = cfg.get("params")
    return raw if isinstance(raw, dict) else {}


def endpoint(cfg: dict[str, t.Any]) -> tuple[str, str]:
    """The wire dialect (the ``zjsearch.llm.sdk`` input, resolved to its
    canonical kind) and the ``base_url`` exactly as configured --
    no rewriting.  Each SDK appends its own method paths to the base, so
    the value is per dialect (see the README): the openai dialects take
    ``https://api.openai.com/v1``, anthropic the bare origin
    (``https://api.anthropic.com``), gemini the origin or a gateway prefix
    that already includes the API name (``https://gw.example.com/gemini``).
    An unknown value falls back to ``openai`` (the Responses dialect).
    RETURNS the canonical dialect kind (an alias/shorthand input resolves
    through ``SDK_ALIASES``) -- everything downstream (the DIALECTS
    registry, ``SDK_PACKAGES``) keys on those."""
    kind = str(cfg.get("sdk") or "openai")
    kind = SDK_ALIASES.get(kind, kind)
    if kind not in ENDPOINT_KINDS:
        kind = SDK_ALIASES["openai"]  # the default's canonical form
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
    # the native-SDK families may ride their official default endpoint:
    # gemini via google-genai, dashscope via the SDK's own base
    return bool(base) or kind in ("gemini", "dashscope")


def capability() -> dict[str, str] | None:
    """The ``ai`` payload of the page-data globals (token + model label);
    ``None`` when the feature is off or not fully configured."""
    cfg = llm_cfg()
    if not configured(cfg):
        return None
    return {"tk": security.issue_token(), "model": str(cfg.get("model"))}


def feature_cfg(feature: str) -> dict[str, t.Any]:
    """The ``zjsearch.feature.<feature>`` settings block (absent unless
    the deployment defines it) -- the AI features live grouped under the
    ``feature`` key, a sibling of ``llm`` (the transport) and ``reader``
    (the page-reader provider)."""
    zjs = settings.get("zjsearch", {})
    features = zjs.get("feature") if isinstance(zjs, dict) else None
    cfg = features.get(feature) if isinstance(features, dict) else None
    return cfg if isinstance(cfg, dict) else {}


def feature_enabled(feature: str) -> bool:
    """The per-feature flag: ``zjsearch.feature.<feature>.enabled`` --
    ``True`` unless explicitly switched off."""
    return bool(feature_cfg(feature).get("enabled", True))


def feature_capability(feature: str) -> dict[str, str] | None:
    """The page-data capability payload for ONE feature (token + model
    label); ``None`` when the feature flag is off or the transport is
    unconfigured -- the client hides the feature's entry point then."""
    if not feature_enabled(feature) or not configured(llm_cfg()):
        return None
    return capability()


def reasoning_passback(cfg: dict[str, t.Any]) -> bool:
    """The ``zjsearch.llm.reasoning_passback`` setting: whether a model's
    reasoning echoes back on replayed history (the openai chat dialect's
    tool-call loops -- several families REJECT the request without the
    echo, Moonshot's kimi among them).  The transport configures ONE
    model, so the flag is simply global for the endpoint: ``true``
    enables the echo, absent or ``false`` keeps the history clean (the
    safe default -- endpoints that forbid echoed reasoning would error
    on it)."""
    return cfg.get("reasoning_passback") is True


def sdk_missing(cfg: dict[str, t.Any]) -> str | None:
    """The missing transport SDK package for the configured dialect, or
    ``None`` when it imports -- the install gate the feature routes
    share (each logs its own wording)."""
    kind = endpoint(cfg)[0]
    package = SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        return package
    return None


def rerank_cfg() -> dict[str, t.Any]:
    """The ``zjsearch.rerank`` settings block (absent unless the deployment
    defines it) -- the rerank-model provider behind the AI search feed's
    ranking cascade.  Same shape as the embedding block: ``base_url`` with
    the method path appended client-side (``{base_url}/rerank`` -- the
    Cohere-shaped endpoint bigmodel / Jina / SiliconFlow all speak),
    ``enabled`` / ``api_key`` (empty = the ``ZJSEARCH_RERANK_KEY`` env) /
    ``model``, plus the shared ``extra_headers`` / ``extra_body`` escape
    hatches."""
    cfg = settings.get("zjsearch", {}).get("rerank", {})
    return cfg if isinstance(cfg, dict) else {}


def rerank_key(cfg: dict[str, t.Any]) -> str:
    """The rerank endpoint's effective API key: the ``api_key`` setting
    first, then the ``ZJSEARCH_RERANK_KEY`` environment (the key stays out
    of the repository either way)."""
    return str(cfg.get("api_key") or "") or os.environ.get("ZJSEARCH_RERANK_KEY", "")


EMBED_DEFAULT_WIDTH = 1024
"""The pgvector column width when the embedding block carries no explicit
override -- the browser creates its column from THIS value (the capability
payload carries it)."""


def embedding_passthrough(cfg: dict[str, t.Any]) -> dict[str, t.Any]:
    """The ``zjsearch.embedding.params`` block -- typed kwargs of the chosen
    SDK verbatim under their SDK names (openai: ``embeddings.create`` kwargs
    -- ``encoding_format``, ``user``, a ``dimensions`` override; gemini:
    ``EmbedContentConfig`` fields -- ``task_type``, ``title``,
    ``auto_truncate``, an ``output_dimensionality`` override), the same
    passthrough pattern as the chat transport's ``params``.  The structural
    keys (model / input / the column width) are server-set and can not be
    overridden through it."""
    raw = cfg.get("params")
    raw = raw if isinstance(raw, dict) else {}
    return {str(k): v for k, v in raw.items() if v is not None}


def dimensions(cfg: dict[str, t.Any], family: str) -> int:
    """The effective embedding width for ONE embedding block: the sdk's own
    ``params`` key (openai ``params.dimensions`` / gemini
    ``params.output_dimensionality``), default :data:`EMBED_DEFAULT_WIDTH`.
    MUST match the browser's pgvector column, which is created from THIS
    value (the capability payload carries it)."""
    block_params = cfg.get("params") if isinstance(cfg.get("params"), dict) else {}
    override = "dimensions" if family in ("openai", "dashscope") else "output_dimensionality"
    try:
        return int(block_params.get(override))
    except (TypeError, ValueError):
        return EMBED_DEFAULT_WIDTH
