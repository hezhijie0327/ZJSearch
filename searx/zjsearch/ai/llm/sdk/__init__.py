# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The SDK registry: ONE factory per family, centrally managed.

:py:func:`resolve` binds deployment config into the family's SDK surface
(:py:func:`infra.sdk.openai.factory` and friends).  ``family`` separates
client cache namespaces -- the chat transport and the embedding feature
can share a base_url while carrying different keys, and never share a
cached client.

The ``zjsearch.llm.sdk`` values (canonical after ``config.SDK_ALIASES``):
``openai.chat_completions`` / ``openai.responses`` / ``anthropic`` /
``gemini`` / ``dashscope``.  Adding a family means adding one module here with a
``factory(cfg, base, kind, family)`` plus one registry line in
:py:func:`resolve`.
"""

import queue
import typing as t

from .. import config
from .anthropic import AnthropicSdk, factory as anthropic_factory
from .dashscope import DashscopeSdk, factory as dashscope_factory
from .gemini import GeminiSdk, factory as gemini_factory
from .openai import OpenaiSdk, factory as openai_factory

SDK_PACKAGES = config.SDK_PACKAGES
"""Re-exported: the import name each canonical kind needs (the install
gates' ``sdk_missing`` check)."""


class Sdk:
    """The structural surface every family factory returns -- the
    framework programs against THIS, never against a concrete family.

    - ``kind`` / ``base`` -- the resolved wire kind and endpoint base.
    - ``json_tiers`` -- how many native structured-output attempts
      :py:func:`infra.jsongate.json_completion` should try.
    - ``embeds`` -- whether the family ships an embeddings API.
    - ``pump(messages, events, relay_reasoning, tools)`` (async) -- drive
      the SDK stream into the queue (the LlmStream contract).
    - ``json_completion(messages, name, schema, strict) -> str`` (async).
    - ``embed(texts) -> vectors`` (async; non-embedding families raise).
    """

    kind: str
    base: str
    json_tiers: int
    embeds: bool

    def __init__(self, impl: t.Any, kind: str, base: str):
        self._impl = impl
        self.kind = kind
        self.base = base
        self.json_tiers = int(getattr(impl, "json_tiers", 1))
        self.embeds = bool(getattr(impl, "embeds", False))

    async def pump(
        self,
        messages: list[dict[str, t.Any]],
        events: "queue.Queue[tuple[str, t.Any]]",
        relay_reasoning: bool = False,
        tools: list[dict[str, t.Any]] | None = None,
    ) -> None:
        await self._impl.pump(messages, events, relay_reasoning, tools)

    async def json_completion(
        self,
        messages: list[dict[str, t.Any]],
        name: str,
        schema: dict[str, t.Any],
        strict: bool,
    ) -> str:
        return await self._impl.json_completion(messages, name, schema, strict)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return await self._impl.embed(texts)


def resolve(cfg: dict[str, t.Any], family: str | None = None) -> Sdk:
    """The configured family's bound SDK surface.  ``family`` overrides the
    client cache namespace (the embedding service passes ``"embedding"``);
    the default namespaces per family (``openai`` / ``anthropic`` /
    ``gemini``) keep the chat transport's cache shape."""
    kind, base = config.endpoint(cfg)
    if kind in ("openai.chat_completions", "openai.responses"):
        impl = openai_factory(cfg, base, kind, family or "openai")
    elif kind == "anthropic":
        impl = anthropic_factory(cfg, base, kind, family or "anthropic")
    elif kind == "dashscope":
        impl = dashscope_factory(cfg, base, kind, family or "dashscope")
    else:
        impl = gemini_factory(cfg, base, kind, family or "gemini")
    return Sdk(impl, kind, base)


def sdk_missing(cfg: dict[str, t.Any]) -> str | None:
    """The missing SDK package for the configured family, or ``None`` when
    it imports (the install gate the routes share)."""
    return config.sdk_missing(cfg)


__all__ = [
    "SDK_PACKAGES",
    "AnthropicSdk",
    "DashscopeSdk",
    "GeminiSdk",
    "OpenaiSdk",
    "Sdk",
    "resolve",
    "sdk_missing",
]
