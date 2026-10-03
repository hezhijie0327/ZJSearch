# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The rerank-model service: config + the provider legs.

A dedicated block (``zjsearch.rerank``) with its own SDK selection, the
same pattern as the embedding service: the chat transport and the rerank
model are independent deployments.  ``zjsearch.rerank.sdk`` picks the
wire:

- ``cohere`` (default) -- ANY Cohere-shaped ``POST {base_url}/rerank``
  route (bigmodel / Jina / SiliconFlow), through the instance's network
  layer (curl_cffi; proxies + per-network settings apply).
- ``dashscope`` -- Alibaba's native TextReRank SDK (gte-rerank family),
  called synchronously on the calling thread; ``base_url`` rides verbatim
  (a dedicated MaaS workspace includes its own ``/api/v1``).

Both legs share the fail-open contract: ``(None, 0)`` on any skip, one
debug line, the caller's previous order stands.  The RANKING POLICY
(head selection, the BM25 fusion, where the order lands) lives in
``runtime/rank.py`` -- this module is the provider, not the strategy.
"""

import asyncio
import logging
import os
import typing as t

from searx import settings
from searx.network.client import get_loop
from searx.network.network import get_network
from searx.zjsearch.ai.infra.sdk.dashscope import factory

from .config import extra_body, extra_headers

logger = logging.getLogger(__name__)

SDKS = ("cohere", "dashscope", "openai")
"""The ``zjsearch.rerank.sdk`` values -- one wire per provider family:
``cohere`` = the raw Cohere-shaped POST, ``openai`` = the OpenAI SDK's
``client.post("/reranks")`` (dashscope compatible-api / OpenAI-serving
gateways), ``dashscope`` = the native TextReRank SDK."""

RERANK_NETWORK = "zjsearch-rerank"
"""The optional named network for the rerank endpoint -- a self-hosted
reranker on plain http defines it with ``enable_http: true`` (the
``zjsearch-reader`` pattern); absent, the endpoint rides the DEFAULT
network like every engine (https endpoints are unaffected)."""

RERANK_TIMEOUT = (2.0, 6.0)
"""The Cohere-shaped leg's (connect, total) curl_cffi budget: the call
sits on the research round's critical path, a dead endpoint's cost stays
at seconds."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.rerank`` settings block (absent unless the
    deployment defines it)."""
    zjs = settings.get("zjsearch", {})
    block = zjs.get("rerank") if isinstance(zjs, dict) else None
    return block if isinstance(block, dict) else {}


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected rerank wire: ``cohere`` (the default HTTP shape) or
    ``dashscope`` (the native TextReRank SDK) -- unknown values fall back
    to the default, like every family selection."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "cohere")
    return kind if kind in SDKS else "cohere"


def enabled(cfg_block: dict[str, t.Any] | None = None) -> bool:
    """The rerank feature flag: ``zjsearch.rerank.enabled``."""
    block = cfg_block if cfg_block is not None else cfg()
    return block.get("enabled") is not False


def rerank_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_RERANK_KEY`` environment."""
    return str(cfg_block.get("api_key") or "") or os.environ.get("ZJSEARCH_RERANK_KEY", "")


def configured(cfg_block: dict[str, t.Any] | None = None) -> bool:
    """True when the dashscope leg may run: model present (the key rides
    the env; the cohere HTTP leg additionally needs its base_url)."""
    block = cfg_block if cfg_block is not None else cfg()
    return bool(block.get("model"))


def rerank(query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The provider dispatch: one rerank call on the configured wire.
    RETURNS ``(order, tokens)`` -- ``order`` maps rank position -> doc
    index (a full permutation) and ``tokens`` is the billed prompt-token
    count; ``(None, 0)`` on any skip, fail-open."""
    block = cfg()
    if not enabled(block) or not block.get("model"):
        return None, 0
    family = sdk(block)
    if family == "dashscope":
        return _dashscope(block, query, docs)
    if family == "openai":
        return _openai(block, query, docs)
    return _cohere(block, query, docs)


def _dashscope(cfg_block: dict[str, t.Any], query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The native DashScope TextReRank leg: the FAMILY surface
    (``sdk.dashscope`` -- TextReRank is a DashscopeSdk method like
    Generation / TextEmbedding), bound to this block's key / model /
    base.  The base_http_api_url override rides the factory."""

    bound = {
        "api_key": rerank_key(cfg_block),
        "model": str(cfg_block["model"]),
        "base_url": str(cfg_block.get("base_url") or "").strip(),
    }
    try:
        return factory(bound, bound["base_url"], "dashscope", "rerank").rerank(query, docs)
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch rerank: dashscope failed, keeping the previous order: %r", exc)
        return None, 0


def _cohere(cfg_block: dict[str, t.Any], query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The Cohere-shaped HTTP leg (bigmodel / Jina / SiliconFlow gateways
    speak it): one POST through the instance's network layer."""
    if not cfg_block.get("base_url"):
        return None, 0
    key = rerank_key(cfg_block)
    url = str(cfg_block["base_url"]).rstrip("/") + "/rerank"
    body: dict[str, t.Any] = {
        "model": str(cfg_block["model"]),
        "query": query,
        "documents": docs,
        "top_n": len(docs),
    }
    if extra_body(cfg_block):
        body.update(extra_body(cfg_block))
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if extra_headers(cfg_block):
        headers.update(extra_headers(cfg_block))
    # the instance's own network layer (curl_cffi under the hood): proxies
    # and per-network settings apply, the shared asyncio loop bridges the
    # sync request thread (the page reader's pattern)
    future = asyncio.run_coroutine_threadsafe(
        (get_network(RERANK_NETWORK) or get_network()).request(
            "POST",
            url,
            json=body,
            headers=headers,
            timeout=RERANK_TIMEOUT,
            # status codes are THIS module's fail-open signal -- no
            # network-layer raise
            raise_for_httperror=False,
        ),
        get_loop(),
    )
    try:
        response = future.result(timeout=RERANK_TIMEOUT[1] + 2.0)
        if response.status_code != 200:
            logger.debug(
                "zjsearch rerank: HTTP %d, keeping the previous order: %.120s",
                response.status_code,
                response.text,
            )
            return None, 0
        payload = response.json()
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch rerank: endpoint failed, keeping the previous order: %r", exc)
        return None, 0
    return _parse_cohere(payload, docs)


def _openai(cfg_block: dict[str, t.Any], query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The OpenAI-SDK leg (the dashscope compatible-api and OpenAI-serving
    gateways expose the rerank as ``POST {base}/reranks``): the SDK's
    generic ``client.post`` with ``cast_to=object`` -- the official
    pattern, path convention owned by the SDK."""
    from openai import OpenAI  # pylint: disable=import-outside-toplevel

    client = OpenAI(
        api_key=rerank_key(cfg_block),
        base_url=str(cfg_block.get("base_url") or "").rstrip("/") or None,
    )
    try:
        response = client.post(
            "/reranks",
            body={
                "model": str(cfg_block["model"]),
                "query": query,
                "documents": docs,
                "top_n": len(docs),
            },
            cast_to=object,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch rerank: openai leg failed, keeping the previous order: %r", exc)
        return None, 0
    results = response.get("results") if isinstance(response, dict) else None
    if not isinstance(results, list) or not results:
        logger.debug("zjsearch rerank: no usable results, keeping the previous order")
        return None, 0
    order: list[int] = []
    for item in results:
        try:
            index = int(item.get("index", -1))
        except (TypeError, ValueError, AttributeError):
            continue
        if 0 <= index < len(docs) and index not in order:
            order.append(index)
    if not order:
        return None, 0
    order += [i for i in range(len(docs)) if i not in set(order)]
    usage = response.get("usage") if isinstance(response, dict) else None
    try:
        tokens = int(usage.get("prompt_tokens") or 0) if isinstance(usage, dict) else 0
    except (TypeError, ValueError):
        tokens = 0
    return order, tokens


def _parse_cohere(payload: dict[str, t.Any], docs: list[str]) -> tuple[list[int] | None, int]:
    """One Cohere-shaped response body -> ``(order, tokens)``; the token
    count parses BEFORE the results bail-outs: a billed call with a
    malformed body still lands in the run's account."""
    tokens = 0
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if isinstance(usage, dict):
        try:
            tokens = int(usage.get("prompt_tokens") or 0)
        except (TypeError, ValueError):
            tokens = 0
    ranked = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(ranked, list) or not ranked:
        logger.debug("zjsearch rerank: malformed response, keeping the previous order")
        return None, tokens
    order: list[int] = []
    for item in ranked:
        try:
            index = int(item["index"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= index < len(docs) and index not in order:
            order.append(index)
    if not order:
        logger.debug("zjsearch rerank: no usable indices, keeping the previous order")
        return None, tokens
    order += [i for i in range(len(docs)) if i not in set(order)]
    return order, tokens
