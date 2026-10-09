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
(``api.embed_route``) -- this module is the server-internal engine
(:py:func:`embed_texts`, no flask, no HMAC).
"""

import asyncio
import importlib.util
import logging
import math
import threading
import typing as t
from collections import OrderedDict

from searx.network.client import get_loop

from searx.zjsearch.ai.core import config as core_config
from searx.zjsearch.ai.core import security
from .config import dimensions
from .sdk import resolve

logger = logging.getLogger(__name__)

MAX_BATCH = 16
"""Texts per request -- a history save embeds a handful of threads, a
drawer search embeds one query; 16 is generous for both."""
MAX_TEXT_CHARS = 8000
"""Per-text truncation (the thread payloads can be large; embeddings of
8k chars are plenty for ranking)."""

SDKS = ("openai", "gemini", "dashscope")
"""The ``zjsearch.embedding.sdk`` values -- one SDK per embeddings API
family, mirroring the chat transport's family registry."""

SDK_PACKAGES = {"openai": "openai", "gemini": "google.genai", "dashscope": "dashscope"}
"""The import name of the SDK package each embedding sdk needs."""

_CACHE_MAX = 256
"""Cached (model, text) -> vector entries -- the ranking funnel re-embeds
the same snippet heads round after round (diversity pruning, the corpus
rescue, the conflict scan's established facts, the recall reranks); a
small LRU turns those repeats into dict lookups."""

_CACHE_TEXT_CHARS = 1000
"""Only texts up to this length are cached -- the feed/rank heads are
300-600 chars (everything the funnel embeds); full documents are not
worth the memory."""

_cache: "OrderedDict[tuple[str, str], list[float]]" = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(model: str, text: str) -> list[float] | None:
    """One cached vector (and an LRU touch), or ``None`` -- oversized
    texts never hit."""
    if len(text) > _CACHE_TEXT_CHARS:
        return None
    with _cache_lock:
        vector = _cache.get((model, text))
        if vector is not None:
            _cache.move_to_end((model, text))
        return vector


def _cache_put(model: str, text: str, vector: list[float]) -> None:
    """Store one vector (oversized texts skipped), evicting the LRU tail."""
    if len(text) > _CACHE_TEXT_CHARS:
        return
    with _cache_lock:
        _cache[(model, text)] = vector
        _cache.move_to_end((model, text))
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.embedding`` settings block (absent unless the
    deployment defines it)."""
    return core_config.zj_block("embedding")


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
    return core_config.env_key(cfg_block, "ZJSEARCH_EMBEDDING_KEY")


def configured() -> bool:
    """True when the embeddings route may serve: model and key present and
    a base_url -- which the gemini sdk may omit (the google-genai default
    endpoint)."""
    block = cfg()
    if not (block.get("model") and embedding_key(block)):
        return False
    return bool(block.get("base_url")) or sdk(block) in ("gemini", "dashscope")


def dimensions_of(cfg_block: dict[str, t.Any] | None = None) -> int:
    """The effective embedding width of (this module's) block -- a thin
    re-read over :py:func:`llm.config.dimensions` with the block's own
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


async def _embed(texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
    """One batch through the family's SDK surface, bound to the embedding
    key (resolved into ``api_key`` -- the factories' env fallback is the
    CHAT transport's key) and the ``embedding`` cache family.  The SDK's
    usage meta rides along when the upstream reports any (openai's
    ``prompt_tokens``; gemini's enterprise character count)."""
    block = cfg()
    bound = {**block, "api_key": embedding_key(block)}
    return await resolve(bound, family="embedding").embed(texts)


async def _embed_chunked(texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
    """``_embed`` with the :py:data:`MAX_BATCH` ceiling ENFORCED -- the
    route caps the browser's batches, but server internals legitimately
    send more (the rank cascade's 30-doc head, the ledger conflict scan's
    fact list), and some upstreams reject or silently truncate oversized
    batches.  Over-ceiling input splits into concurrent slices on the
    shared loop; the usage metas merge (their counters sum)."""
    if len(texts) <= MAX_BATCH:
        return await _embed(texts)
    slices = [texts[i : i + MAX_BATCH] for i in range(0, len(texts), MAX_BATCH)]
    parts = await asyncio.gather(*(_embed(one) for one in slices))
    vectors: list[list[float]] = []
    usage: dict[str, t.Any] = {}
    for part_vectors, part_usage in parts:
        vectors.extend(part_vectors)
        for key, value in (part_usage or {}).items():
            usage[key] = usage.get(key, 0) + value if isinstance(value, (int, float)) else value
    return vectors, usage or None


async def embed_texts(
    texts: list[str], timeout: float | None = None
) -> tuple[list[list[float]], dict[str, t.Any] | None] | None:
    """The SERVER-side embedding call (the configured SDK, the shared
    loop): ``None`` when the feature is off/unconfigured or the upstream
    fails -- every consumer (the writer's context ranking) degrades
    silently.  ``timeout`` bounds the await (``None`` waits unbounded --
    the writer phase passes its own budget).  Server-internal: no flask,
    no HMAC (the route's browser proxy is separate)."""
    if not enabled() or not configured():
        return None
    try:
        call = _embed_chunked([str(text)[:MAX_TEXT_CHARS] for text in texts])
        if timeout is not None:
            call = asyncio.wait_for(call, timeout)
        return await call
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_embedding: embed_texts failed: %s", exc)
        return None


def run_batch(
    texts: list[str], timeout: float | None = None
) -> tuple[list[list[float]], str, dict[str, t.Any] | None] | None:
    """The browser-proxy workhorse: one batch on the shared loop, ``(vectors,
    model, usage)`` out; ``None`` when the upstream fails (the route
    answers 502).
    ``timeout`` bounds the wait for latency-sensitive callers (the
    overview's context ordering) -- ``None`` waits unbounded, the proxy's
    own contract.  The route owns gating and validation -- this is
    transport only.  The cached SDK clients are loop-bound, so the batch
    rides the SAME shared network loop the chat transport built them on
    (asyncio.run per request would strand them on a dead loop from call
    two on).
    Cache-aside: texts already in the LRU (:py:data:`_CACHE_MAX`, keyed by
    model + text) never reach the upstream -- only the misses ride one
    batch call, and the result is reassembled in input order.  A
    fully-cached batch returns ``usage: None`` (no upstream spent
    anything)."""
    prepared = [str(text)[:MAX_TEXT_CHARS] for text in texts]
    model = str(cfg().get("model") or "")
    vectors: list[list[float] | None] = [_cache_get(model, text) for text in prepared]
    missing = [i for i, vector in enumerate(vectors) if vector is None]
    usage: dict[str, t.Any] | None = None
    if missing:
        try:
            fresh, usage = asyncio.run_coroutine_threadsafe(
                _embed_chunked([prepared[i] for i in missing]), get_loop()
            ).result(timeout)
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("zjsearch_embedding: upstream failed: %s", exc)
            return None
        if not isinstance(fresh, list) or len(fresh) != len(missing):
            logger.warning(
                "zjsearch_embedding: upstream returned %s vectors for %d texts",
                len(fresh) if isinstance(fresh, list) else type(fresh).__name__,
                len(missing),
            )
            return None
        for slot, index in enumerate(missing):
            vectors[index] = fresh[slot]
            _cache_put(model, prepared[index], fresh[slot])
    if any(vector is None for vector in vectors):
        logger.warning("zjsearch_embedding: upstream returned a null vector -- batch dropped")
        return None
    return [vector for vector in vectors if vector is not None], model, usage
