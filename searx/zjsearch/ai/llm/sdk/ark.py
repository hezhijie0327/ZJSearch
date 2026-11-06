# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The volcengine ark SDK factory -- the MULTIMODAL vectorization family.

The ark family serves ONE surface: ``embed(texts)`` over the ark
multimodal-vectorization API (``doubao-embedding-vision-*`` class
models -- parts fuse into ONE vector per call, so a text batch is one
call per text).  The CHAT side needs no family: ark is
OpenAI-compatible there and rides the openai family with
``base_url: https://ark.cn-beijing.volces.com/api/v3``.  A text-embedding
model on ark rides the openai family too (the plain ``/embeddings``
route is OpenAI-shaped); THIS family exists for the multimodal
endpoint's own wire.

The sync SDK call must not occupy the shared network loop (every engine
request rides it) -- the round trip goes to a thread, the dashscope
family's doctrine.  The client caches per (base_url, api_key) like the
sync surfaces before it.
"""

import asyncio
import threading
import typing as t

from ..config import embedding_passthrough, extra_body, extra_headers
from .clients import _SDK_READ_TIMEOUT

KIND = "ark"

_TIMEOUT = float(_SDK_READ_TIMEOUT)
"""The client's per-request cap -- the embed service bounds its own
batches tighter; this is only the hung-upstream backstop."""

_clients: dict[tuple[str, str], t.Any] = {}
_clients_lock = threading.Lock()
"""The sync ark clients, cached per (base_url, api_key) -- the same
pool-reuse discipline as every sync surface (a fresh client per batch
paid a new connection handshake on EVERY embed)."""


def _client(cfg: dict[str, t.Any], base: str) -> t.Any:
    from arkruntime import Ark  # pylint: disable=import-outside-toplevel

    key = (base, str(cfg.get("api_key") or ""))
    with _clients_lock:
        client = _clients.get(key)
        if client is None:
            client = Ark(
                api_key=key[1],
                base_url=base or None,
                timeout=_TIMEOUT,
                max_retries=0,
            )
            _clients[key] = client
    return client


class ArkSdk:  # pylint: disable=too-few-public-methods
    """The bound ark family surface: one instance per (config, base)
    binding.  VECTORS ONLY -- the chat side rides the openai family."""

    def __init__(self, cfg: dict[str, t.Any], base: str, kind: str, family: str, account: t.Any = None):
        self.cfg = cfg
        self.base = base
        self.kind = kind
        self.family = family
        self.account = account

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
        """One embedding batch in input order -- one multimodal call per
        text (the API fuses a parts list into ONE vector, so a batch of N
        texts is N calls; the usage ``prompt_tokens`` sums across them
        into the ``{"input": ...}`` meta the embedding service folds).
        The ``dimensions`` kwarg goes out ONLY when the block's params
        set one explicitly -- several vision models fix their width and
        reject the parameter."""

        def _call() -> tuple[list[list[float]], dict[str, t.Any] | None]:
            client = _client(self.cfg, self.base)
            model = str(self.cfg.get("model"))
            block_params = self.cfg.get("params") if isinstance(self.cfg.get("params"), dict) else {}
            width = block_params.get("dimensions")
            vectors: list[list[float]] = []
            total = 0
            for text in texts:
                call: dict[str, t.Any] = {
                    # the params passthrough carries the SDK's own typed
                    # kwargs verbatim (encoding_format / user /
                    # sparse_embedding / multi_embedding / instructions)
                    **embedding_passthrough(self.cfg),
                    "model": model,
                    "encoding_format": "float",
                    "input": [{"type": "text", "text": text[:8000]}],
                    "extra_headers": extra_headers(self.cfg) or None,
                    "extra_body": extra_body(self.cfg) or None,
                }
                # the width kwarg goes out ONLY when the params set one
                # explicitly (vision models fix their width and may reject
                # the parameter -- the dashscope multimodal doctrine)
                if width is not None:
                    call["dimensions"] = int(width)
                response = client.multimodal_embeddings.create(**call)
                vectors.append(list(response.data.embedding))
                total += int(getattr(response.usage, "prompt_tokens", 0) or 0)
            return vectors, ({"input": total} if total else None)

        # the sync SDK call must not occupy the shared network loop (every
        # engine request rides it) -- the round trip goes to a thread
        return await asyncio.to_thread(_call)


def factory(cfg: dict[str, t.Any], base: str, kind: str = KIND, family: str = "ark", account: t.Any = None) -> ArkSdk:
    """The ark family factory: config + base (+ the run's spend ledger)
    bound into one callable surface."""
    return ArkSdk(cfg, base, kind, family, account=account)
