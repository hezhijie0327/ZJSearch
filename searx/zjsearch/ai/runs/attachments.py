# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The multimodal source-attachment capability.

Image results ride along as OpenAI-shaped ``image_url`` content parts
(every dialect pump converts them to its own block shape).  The
``images`` setting picks the transport: ``base64`` (the default) fetches
each picture server-side and inlines it, ``url`` hands the reference to
the endpoint, anything else disables attachments.  Every candidate --
either direction -- passes the SSRF gate: same-origin ``/image_proxy``
links resolve to their original target first.
"""

import asyncio
import base64
import functools
import logging
import typing as t
from urllib.parse import parse_qs, urljoin, urlsplit

from searx import settings
from searx.extended_types import sxng_request
from searx.network.client import get_loop
from searx.network.network import Network
from searx.utils import gen_useragent
from searx.zjsearch.ai.core import guard as core_guard
from searx.zjsearch.ai.llm import config as llm_config

logger = logging.getLogger(__name__)

_IMAGE_MAX_BYTES = 2 * 1024 * 1024
_IMAGE_FETCH_TIMEOUT = 8.0
_MAX_IMAGES = 4


@functools.lru_cache(maxsize=1)
def _image_network() -> Network:
    """Dedicated curl network for the server-side image fetches.  The default
    network is https-only (``enable_http`` False -- an engine-hardening
    choice); this one keeps the ``outgoing`` proxies / verify / Tor for
    remote endpoints and goes direct for loopback ones."""
    out = settings.get("outgoing", {})
    remote = not llm_config.endpoint_is_local(str(llm_config.llm_cfg().get("base_url") or ""))
    return Network(
        enable_http=True,
        verify=out.get("verify", True),
        enable_http2=out.get("enable_http2", True),
        max_connections=out.get("pool_connections", 10),
        proxies=out.get("proxies") if remote else None,
        using_tor_proxy=bool(out.get("using_tor_proxy", False)) and remote,
        max_redirects=out.get("max_redirects", 30),
        retries=0,
        logger_name="zjsearch_ai",
    )


def _absolute_url(url: str) -> str:
    """Same-origin relative links (``/image_proxy?url=...`` from the
    page-data) resolve against the instance; everything absolute passes
    through, non-http(s) results are dropped."""
    if url.startswith(("http://", "https://")):
        return url
    joined = urljoin(sxng_request.host_url, url)
    return joined if joined.startswith(("http://", "https://")) else ""


def _proxied_original(url: str) -> str | None:
    """The original image URL embedded in an ``/image_proxy`` link -- fetch
    it directly (the image network applies the outgoing proxies) instead of
    hopping through the instance's own proxy view."""
    parsed = urlsplit(url)
    if not parsed.path.endswith("/image_proxy"):
        return None
    return parse_qs(parsed.query).get("url", [None])[0]


def _check_url(url: str) -> bool:
    """Literal-level gate for server-fetched URLs -- the shared
    public-address gate (:py:mod:`core.guard`) as a boolean.  Same-origin
    ``/image_proxy`` links are resolved by the caller before this gate and
    stay allowed (the proxy applies searx's own upstream validation)."""
    return core_guard.public_url_rejection(url) is None


async def _fetch_image(url: str) -> str:
    """One image as a ``data:`` URL -- ``""`` when the fetch fails, the body
    is too large or the content is not an image.  Runs on the network loop
    (see :py:func:`_fetch_images_b64`)."""
    try:
        resp = await _image_network().request(
            "GET", url, timeout=_IMAGE_FETCH_TIMEOUT, headers={"User-Agent": gen_useragent()}
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: image fetch failed for %r: %r", url, exc)
        return ""
    content = resp.content
    if not content or len(content) > _IMAGE_MAX_BYTES:
        return ""
    mime = str(resp.headers.get("content-type") or "image/jpeg").split(";", maxsplit=1)[0].strip()
    if not mime.startswith("image/"):
        return ""
    return f"data:{mime};base64,{base64.b64encode(content).decode()}"


def _fetch_images_b64(urls: list[str]) -> list[str]:
    """The images as ``data:`` URLs, fetched in parallel -- one round-trip to
    the network loop instead of one per picture (the fetches used to run
    sequentially: up to ``_MAX_IMAGES`` timeouts serialised before the LLM
    call could even start).  Failed slots come back ``""``; each fetch
    carries its own timeout, so the gather never hangs past it."""
    if not urls:
        return []

    async def fetch_all() -> list[str]:
        return list(await asyncio.gather(*(_fetch_image(url) for url in urls)))

    future = asyncio.run_coroutine_threadsafe(fetch_all(), get_loop())
    try:
        return future.result(_IMAGE_FETCH_TIMEOUT * 2)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_ai: image fetch round failed: %r", exc)
        return [""] * len(urls)


def _image_fetch_candidate(url: str, absolute: str) -> str | None:
    """The server-fetch URL for one client image reference -- ``None`` drops
    it (a rejection is logged).  Same-origin ``/image_proxy`` links carry
    the original URL as their target: fetch it directly through the image
    network (the outgoing proxies apply) instead of hopping through the
    instance's own proxy view.  "Same-origin" means the RESOLVED absolute
    keeps the request's host -- a protocol-relative ``//internal.host/x``
    must not masquerade as a relative link -- and every non-same-origin
    candidate passes the SSRF gate."""
    ref_host = (urlsplit(absolute).hostname or "").lower()
    own_host = (urlsplit(sxng_request.host_url).hostname or "").lower()
    if url.startswith("/") and ref_host == own_host:
        original = _proxied_original(absolute)
        if original is not None:
            if _check_url(original):
                return original
            logger.warning("zjsearch_ai: image URL rejected by the SSRF gate: %r", original)
            return None
        return absolute
    if _check_url(absolute):
        return absolute
    logger.warning("zjsearch_ai: image URL rejected by the SSRF gate: %r", absolute)
    return None


def attach_images(payload: dict[str, t.Any], cfg: dict[str, t.Any]) -> list[dict[str, t.Any]]:
    """OpenAI-shaped ``image_url`` content parts for the attached image
    results -- every dialect pump converts them to its own block shape.  The
    ``images`` setting picks the transport: ``base64`` (the default) fetches
    each picture server-side and inlines it, ``url`` hands the reference to
    the endpoint, anything else disables attachments."""
    mode = str(cfg.get("images", "base64")).lower()
    if mode not in ("base64", "url"):
        return []
    refs = payload.get("images")
    if not isinstance(refs, list):
        return []
    parts: list[dict[str, t.Any]] = []
    fetch_urls: list[str] = []
    for ref in refs:
        if len(parts) + len(fetch_urls) >= _MAX_IMAGES:
            break
        url = str(ref or "").strip()
        absolute = _absolute_url(url)
        if not absolute:
            continue
        if mode == "url":
            # the endpoint does the fetching, but the reference passes the
            # same gate -- an unchecked internal URL must not ride out
            candidate = _image_fetch_candidate(url, absolute)
            if candidate is not None:
                parts.append({"type": "image_url", "image_url": {"url": candidate}})
            continue
        candidate = _image_fetch_candidate(url, absolute)
        if candidate is not None:
            fetch_urls.append(candidate)
    if not fetch_urls:
        return parts
    # result lists repeat a host's images -- dedupe, order preserved
    for data in _fetch_images_b64(list(dict.fromkeys(fetch_urls))):
        if data:
            parts.append({"type": "image_url", "image_url": {"url": data}})
    return parts


MAX_UPLOADS = 4
"""Client-uploaded images per question -- four is what a vision model can
meaningfully consider and what keeps a request body sane."""
_UPLOAD_MIMES = ("image/jpeg", "image/png", "image/webp")
_MAX_UPLOAD_B64 = 4 * 1024 * 1024
"""Base64 length cap per image (~3 MB decoded) -- the client compresses to
well under this; the cap only guards abuse."""


def parse_uploads(raw):
    """Client-UPLOADED attachments -> validated image parts for the first
    user turn.  The bytes travel as data URLs in the request body and are
    FORWARDED VERBATIM -- the server stores nothing (the browser's own
    knowledge base is the only storage; see the client's attachment table).
    Anything wrong-kind, wrong-mime or oversized is dropped silently: an
    attachment is a bonus to the question, never a gate on it."""
    if not isinstance(raw, list):
        return []
    parts = []
    for item in raw[:MAX_UPLOADS]:
        if not isinstance(item, dict) or item.get("kind") != "image":
            continue
        mime = str(item.get("mime") or "").lower()
        data = str(item.get("data") or "")
        if mime not in _UPLOAD_MIMES or not data.startswith("data:" + mime + ";base64,"):
            continue
        if len(data) - len("data:" + mime + ";base64,") > _MAX_UPLOAD_B64:
            continue
        parts.append({"type": "image_url", "image_url": {"url": data}})
    return parts
