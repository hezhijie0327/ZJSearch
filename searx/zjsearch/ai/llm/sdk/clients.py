# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The cached SDK HTTP clients of the three transport families.

One httpx2 client per remote-ness carries the proxy mounts; one SDK
client per (family, base_url) is constructed lazily ON the shared
network event loop (httpx2 / anyio bind lazily) and reused across
requests for the pool.  The dialect modules call these factories; the
client objects themselves never leak past this package.
"""

import functools
import typing as t

from searx import settings

from .. import config

_SDK_CONNECT_TIMEOUT = 10.0
_SDK_READ_TIMEOUT = 120.0
"""Per-request SDK timeouts (``httpx2.Timeout(120, connect=10)``): on a
streaming request the read value is a stall guard between chunks, not a
total-duration cap."""

_sdk_http_clients: dict[bool, t.Any] = {}
"""Shared httpx2 clients for the SDK transports, one per remote-ness.  The
openai / anthropic SDKs speak the httpx2 dialect of httpx; the client is
created (and cached) on the shared network loop where the pumps run.
``using_tor_proxy`` is a curl_cffi mechanism -- SDK transports rely on
``outgoing.proxies`` for proxying."""


def proxy_mounts(httpx_module: t.Any = None) -> t.Any:
    """``outgoing.proxies`` -> proxy mounts, one transport per pattern:
    proxy values are URLs or LISTS of fallback URLs (the curl engines
    round-robin the list) -- the first URL serves.  ``httpx_module`` picks
    the client family the mounts are FOR: the searx fork (httpx2) for the
    openai / anthropic SDKs, the ORIGINAL httpx for google-genai (its
    AsyncByteStream assert rejects foreign transports -- mixing the two
    surfaced as a bare AssertionError at request time)."""
    import httpx2  # pylint: disable=import-outside-toplevel

    httpx_module = httpx_module or httpx2

    mounts: dict[str, t.Any] = {}
    out = settings.get("outgoing", {})
    for pattern, value in dict(out.get("proxies") or {}).items():
        urls = [str(u) for u in (value if isinstance(value, list) else [value]) if u]
        if urls:
            mounts[str(pattern)] = httpx_module.AsyncHTTPTransport(proxy=httpx_module.Proxy(urls[0]))
    return mounts


def httpx_client(remote: bool) -> t.Any:
    import httpx2  # pylint: disable=import-outside-toplevel

    client = _sdk_http_clients.get(remote)
    if client is None:
        out = settings.get("outgoing", {})
        client = httpx2.AsyncClient(mounts=proxy_mounts() or None, verify=out.get("verify", True))
        _sdk_http_clients[remote] = client
    return client


@functools.lru_cache(maxsize=1)
def sdk_timeout() -> t.Any:
    import httpx2  # pylint: disable=import-outside-toplevel

    return httpx2.Timeout(_SDK_READ_TIMEOUT, connect=_SDK_CONNECT_TIMEOUT)


_sdk_clients: dict[tuple[str, str], t.Any] = {}
"""SDK clients cached per family + base -- constructed on the shared network
loop (httpx2 / anyio bind lazily) and reused across requests for the pool."""


def openai_client(cfg: dict[str, t.Any], base: str, family: str = "openai") -> t.Any:
    """``family`` separates the cache namespaces: the chat transport and
    the embedding feature can share a base_url while carrying DIFFERENT
    keys -- one cached client per (family, base), never a shared one."""
    from openai import AsyncOpenAI  # pylint: disable=import-outside-toplevel

    key = (family, base)
    client = _sdk_clients.get(key)
    if client is None:
        client = AsyncOpenAI(
            base_url=base or None,
            # the SDKs refuse an empty key at construction -- auth-free local
            # servers (ollama, LM Studio without auth) get a placeholder
            api_key=config.chat_key(cfg) or ("none" if config.endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=httpx_client(not config.endpoint_is_local(base)),
        )
        _sdk_clients[key] = client
    return client


def anthropic_client(cfg: dict[str, t.Any], base: str, family: str = "anthropic") -> t.Any:
    from anthropic import AsyncAnthropic  # pylint: disable=import-outside-toplevel

    key = (family, base)
    client = _sdk_clients.get(key)
    if client is None:
        client = AsyncAnthropic(
            base_url=base or None,
            api_key=config.chat_key(cfg) or ("none" if config.endpoint_is_local(base) else ""),
            max_retries=0,
            http_client=httpx_client(not config.endpoint_is_local(base)),
        )
        _sdk_clients[key] = client
    return client


def gemini_client(cfg: dict[str, t.Any], base: str, family: str = "gemini") -> t.Any:
    # google-genai rides the ORIGINAL httpx (its AsyncByteStream assert
    # rejects httpx2 transports) -- hence the family-specific import here
    import httpx  # pylint: disable=import-outside-toplevel
    from google.genai import types  # pylint: disable=import-outside-toplevel
    from google import genai  # pylint: disable=import-outside-toplevel

    key = (family, base)
    client = _sdk_clients.get(key)
    if client is None:
        api_key = config.chat_key(cfg)
        # google-genai has no per-call headers -- the client's HttpOptions
        # are its designed place, and the SDK MERGES these over its own
        # defaults (Content-Type / x-goog-api-key) with these winning: the
        # same extra_headers-overrides-defaults semantics as the openai /
        # anthropic per-request kwargs (a gateway that wants Authorization
        # over the x-goog-api-key just sets it here)
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers.update(config.extra_headers(cfg) or {})
        client = genai.Client(
            api_key=api_key or None,
            http_options=types.HttpOptions(
                base_url=base or None,
                headers=headers or None,
                extra_body=config.extra_body(cfg),
                async_client_args={
                    "verify": settings.get("outgoing", {}).get("verify", True),
                    "mounts": proxy_mounts(httpx) or None,
                },
            ),
        )
        _sdk_clients[key] = client
    return client
