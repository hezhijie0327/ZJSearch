# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The rerank-model service: config + the provider legs.

A dedicated block (``zjsearch.rerank``) with its own SDK selection, the
same pattern as the embedding service: the chat transport and the rerank
model are independent deployments.  ``zjsearch.rerank.sdk`` picks the
wire:

- ``openai`` (default) -- the OpenAI SDK's generic ``client.post(<path>)``
  serving every HTTP-shape gateway: the dashscope compatible-api
  (``/reranks``), bigmodel (``/rerank``), Jina, real Cohere -- the path
  rides the ``path`` key.
- ``dashscope`` -- Alibaba's native TextReRank SDK (gte-rerank family),
  delegated to the family surface (``sdk.dashscope.DashscopeSdk.rerank``),
  with ``base_url`` riding verbatim (a dedicated MaaS workspace includes
  its own ``/api/v1``).

Both legs share the fail-open contract: ``(None, 0)`` on any skip, one
debug line, the caller's previous order stands.  The RANKING POLICY
(head selection, the BM25 fusion, where the order lands) lives in
``runtime/rank.py`` -- this module is the provider, not the strategy.
NOTE: the wires ride their SDKs' own HTTP stacks -- the searx network
layer (proxies / the named-network escape hatch) applies to neither; a
rerank gateway behind Tor wants the openai leg pointed at a local
forwarding proxy instead.
"""

import logging
import os
import typing as t

from searx import settings
from searx.zjsearch.ai.infra.config import extra_body, extra_headers
from searx.zjsearch.ai.infra.sdk.dashscope import factory as dashscope_factory

logger = logging.getLogger(__name__)

SDKS = ("openai", "dashscope")
"""The ``zjsearch.rerank.sdk`` values -- one wire per provider family."""

DEFAULT_PATH = "/reranks"
"""The openai leg's default request path -- the dashscope compatible-api
convention; bigmodel and friends override it with ``path: /rerank``."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.rerank`` settings block (absent unless the
    deployment defines it)."""
    zjs = settings.get("zjsearch", {})
    block = zjs.get("rerank") if isinstance(zjs, dict) else None
    return block if isinstance(block, dict) else {}


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected rerank wire: ``openai`` (default) or ``dashscope`` --
    unknown values fall back to the default, like every family
    selection."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "openai")
    return kind if kind in SDKS else "openai"


def enabled(cfg_block: dict[str, t.Any] | None = None) -> bool:
    """The rerank feature flag: ``zjsearch.rerank.enabled``."""
    block = cfg_block if cfg_block is not None else cfg()
    return block.get("enabled") is not False


def rerank_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_RERANK_KEY`` environment."""
    return str(cfg_block.get("api_key") or "") or os.environ.get("ZJSEARCH_RERANK_KEY", "")


def configured(cfg_block: dict[str, t.Any] | None = None) -> bool:
    """True when the openai leg may run: model and base_url present (the
    key rides the env)."""
    block = cfg_block if cfg_block is not None else cfg()
    return bool(block.get("model") and block.get("base_url"))


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
    return _openai(block, query, docs)


def _openai(cfg_block: dict[str, t.Any], query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The OpenAI-SDK leg: ONE generic ``client.post(<path>)`` serves every
    HTTP-shape gateway (the path rides ``zjsearch.rerank.path``).
    ``cast_to=object``: the response parses generically.  ``extra_headers``
    ride the client's default headers, ``extra_body`` merges into the
    request body 1:1 (a gateway header, a provider-private field like
    ``return_documents``)."""
    from openai import OpenAI  # pylint: disable=import-outside-toplevel

    client = OpenAI(
        api_key=rerank_key(cfg_block),
        base_url=str(cfg_block.get("base_url") or "").rstrip("/") or None,
        default_headers=extra_headers(cfg_block) or None,
    )
    path = str(cfg_block.get("path") or DEFAULT_PATH)
    body: dict[str, t.Any] = {
        "model": str(cfg_block["model"]),
        "query": query,
        "documents": docs,
        "top_n": len(docs),
        **(extra_body(cfg_block) or {}),
    }
    try:
        response = client.post(
            path,
            body=body,
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


def _dashscope(cfg_block: dict[str, t.Any], query: str, docs: list[str]) -> tuple[list[int] | None, int]:
    """The native DashScope TextReRank leg: the FAMILY surface
    (``sdk.dashscope`` -- TextReRank is a DashscopeSdk method like
    Generation / TextEmbedding), bound to this block's key / model /
    base.  The base_http_api_url override rides the factory; the whole
    block travels so its ``extra_headers`` / ``extra_body`` reach the
    family surface's ``_call_extras``."""
    bound = {
        **cfg_block,
        "api_key": rerank_key(cfg_block),
        "model": str(cfg_block["model"]),
        "base_url": str(cfg_block.get("base_url") or "").strip(),
    }
    try:
        return dashscope_factory(bound, bound["base_url"], "dashscope", "rerank").rerank(query, docs)
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch rerank: dashscope failed, keeping the previous order: %r", exc)
        return None, 0
