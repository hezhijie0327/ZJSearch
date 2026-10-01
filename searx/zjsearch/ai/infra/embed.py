# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The embedding service: config + the server-side call.

A dedicated block (``zjsearch.embedding``) with its own SDK selection:
the chat transport and the embedding model are independent deployments.
``zjsearch.embedding.sdk``: ``openai`` (default) drives ANY
OpenAI-compatible ``/embeddings`` route; ``gemini`` drives google-genai's
``embed_content`` -- the two official SDK families that ship an
embeddings API (anthropic has none).  Both ride the shared client
factories (proxy mounts, timeouts) under the ``embedding`` cache family,
so a shared base_url with a different key never collides with the chat
client.

The Flask proxy the BROWSER calls is a runtime route
(``runtime.embed_route``) -- this module is the server-internal engine
(:py:func:`embed_texts`, no flask, no HMAC).
"""

import asyncio
import importlib.util
import logging
import math
import os
import typing as t

from searx import settings
from searx.network.client import get_loop

from . import security
from .config import dimensions
from .sdk import resolve

logger = logging.getLogger(__name__)

MAX_BATCH = 16
"""Texts per request -- a history save embeds a handful of threads, a
drawer search embeds one query; 16 is generous for both."""
MAX_TEXT_CHARS = 8000
"""Per-text truncation (the thread payloads can be large; embeddings of
8k chars are plenty for ranking)."""

SDKS = ("openai", "gemini")
"""The ``zjsearch.embedding.sdk`` values -- one SDK per embeddings API
family, mirroring the chat transport's family registry."""

SDK_PACKAGES = {"openai": "openai", "gemini": "google.genai"}
"""The import name of the SDK package each embedding sdk needs."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.embedding`` settings block (absent unless the
    deployment defines it)."""
    zjs = settings.get("zjsearch", {})
    block = zjs.get("embedding") if isinstance(zjs, dict) else None
    return block if isinstance(block, dict) else {}


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected embeddings SDK (``zjsearch.embedding.sdk``): ``openai``
    (default) or ``gemini`` -- an unknown value falls back to the default,
    like the chat transport's family selection."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "openai")
    return kind if kind in SDKS else "openai"


def enabled() -> bool:
    """The embedding feature flag: ``zjsearch.embedding.enabled`` -- True
    unless explicitly switched off."""
    return cfg().get("enabled") is not False


def embedding_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_EMBEDDING_KEY`` environment."""
    return str(cfg_block.get("api_key") or "") or os.environ.get("ZJSEARCH_EMBEDDING_KEY", "")


def configured() -> bool:
    """True when the embeddings route may serve: model and key present and
    a base_url -- which the gemini sdk may omit (the google-genai default
    endpoint)."""
    block = cfg()
    if not (block.get("model") and embedding_key(block)):
        return False
    return bool(block.get("base_url")) or sdk(block) == "gemini"


def dimensions_of(cfg_block: dict[str, t.Any] | None = None) -> int:
    """The effective embedding width of (this module's) block -- a thin
    re-read over :py:func:`infra.config.dimensions` with the block's own
    family.  MUST match the browser's pgvector column, which is created
    from THIS value (the capability payload carries it)."""
    block = cfg_block if cfg_block is not None else cfg()
    return dimensions(block, sdk(block))


def capability() -> dict[str, t.Any] | None:
    """The page-data ``embedding`` payload (token + model label + column
    width); ``None`` when the feature is off or unconfigured -- the client
    hides the history search then."""
    if not enabled() or not configured():
        return None
    block = cfg()
    return {
        "tk": security.issue_token(),
        "model": str(block.get("model")),
        "dimensions": dimensions_of(block),
    }


def sdk_missing() -> str | None:
    """The missing SDK package for the configured embedding sdk, or
    ``None`` when it imports (the install gate)."""
    package = SDK_PACKAGES.get(sdk(), "openai")
    if importlib.util.find_spec(package) is None:
        return package
    return None


def cosine(vec_a: list[float], vec_b: list[float]) -> float:
    """Cosine similarity of two equal-width vectors -- the relevance
    metric of every server-side embedding consumer (the writer's feed
    ranking, the overview's context ordering)."""
    dot = sum(x * y for x, y in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(x * x for x in vec_a)) or 1.0
    norm_b = math.sqrt(sum(x * x for x in vec_b)) or 1.0
    return dot / (norm_a * norm_b)


async def _embed(texts: list[str]) -> list[list[float]]:
    """One batch through the family's SDK surface, bound to the embedding
    key (resolved into ``api_key`` -- the factories' env fallback is the
    CHAT transport's key) and the ``embedding`` cache family."""
    block = cfg()
    bound = {**block, "api_key": embedding_key(block)}
    return await resolve(bound, family="embedding").embed(texts)


async def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """The SERVER-side embedding call (the configured SDK, the shared
    loop): ``None`` when the feature is off/unconfigured or the upstream
    fails -- every consumer (the writer's context ranking) degrades
    silently.  Server-internal: no flask, no HMAC (the route's browser
    proxy is separate)."""
    if not enabled() or not configured():
        return None
    try:
        return await _embed([str(text)[:MAX_TEXT_CHARS] for text in texts])
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_embedding: embed_texts failed: %s", exc)
        return None


def run_batch(texts: list[str], timeout: float | None = None) -> tuple[list[list[float]], str] | None:
    """The browser-proxy workhorse: one batch on the shared loop, ``(vectors,
    model)`` out; ``None`` when the upstream fails (the route answers 502).
    ``timeout`` bounds the wait for latency-sensitive callers (the
    overview's context ordering) -- ``None`` waits unbounded, the proxy's
    own contract.  The route owns gating and validation -- this is
    transport only.  The cached SDK clients are loop-bound, so the batch
    rides the SAME shared network loop the chat transport built them on
    (asyncio.run per request would strand them on a dead loop from call
    two on)."""
    try:
        vectors = asyncio.run_coroutine_threadsafe(
            _embed([str(text)[:MAX_TEXT_CHARS] for text in texts]), get_loop()
        ).result(timeout)
        return vectors, str(cfg().get("model"))
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_embedding: upstream failed: %s", exc)
        return None
