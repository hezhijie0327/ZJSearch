# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the whole-page AI Overview.

The results meta row hosts the entry (``POST /ai/answer``): the client
assembles a numbered source list from the page payload it already has and
the model streams a cited whole-page answer.  The LLM is only called on
click, so a result page loads with zero added latency and the no-JS / RSS
faces of the theme stay untouched.

Design contract:

- This is NOT a plugin (no pre/post_search) -- it registers the route
  itself.  ``install(app)`` is chained from the ``searx.zjsearch.ai``
  package, so webapp.py keeps its single theme hook.
- Stateless across requests: the gate is an HMAC token issued into the
  page-data ``globals`` (``llm.capability()``), not a session; safe with
  multiple granian workers.
- The endpoint streams raw text (``text/plain``); errors before the first
  token answer as clean HTTP statuses (403 / 422 / 502) -- the 502 body
  carries a truncated upstream reason the client renders in the card.
- The run rides the shared agent framework
  (:py:mod:`searx.zjsearch.ai.agent`) as its zero-tool single-turn case:
  the raw-text adapter renders the ``<think>`` markers around the
  framework's ThinkGate state, so the wire contract is byte-identical to
  the pre-framework stream the client already speaks.
- Configuration lives in the ``zjsearch:`` top-level settings block
  (``zjsearch.ai.*``); everything ships disabled and a deployment opts in.
"""

import asyncio
import base64
import functools
import importlib.util
import ipaddress
import logging
import typing as t
from urllib.parse import parse_qs, urljoin, urlsplit

import flask

from searx import settings
from searx.extended_types import sxng_request
from searx.network.client import get_loop
from searx.network.network import Network
from searx.utils import gen_useragent
from searx.zjsearch.ai import agent, llm, prompts

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------- constants

_CONTEXT_MAX_CHARS = 16000
"""Hard cap on the client-assembled context (deep 5 + shallow 15 + infobox
lands around 7k; the cap only guards abuse)."""

_IMAGE_MAX_BYTES = 2 * 1024 * 1024
_IMAGE_FETCH_TIMEOUT = 8.0
_MAX_IMAGES = 4


# -------------------------------------------------------------- image results


@functools.lru_cache(maxsize=1)
def _image_network() -> Network:
    """Dedicated curl network for the server-side image fetches.  The default
    network is https-only (``enable_http`` False -- an engine-hardening
    choice); this one keeps the ``outgoing`` proxies / verify / Tor for
    remote endpoints and goes direct for loopback ones."""
    out = settings.get("outgoing", {})
    remote = not llm.endpoint_is_local(str(llm.ai_cfg().get("base_url") or ""))
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
    """Literal-level gate for server-fetched URLs: http(s) only, no
    loopback / mDNS / internal host names, no IP literals from the
    non-routable ranges.  Same-origin ``/image_proxy`` links are resolved
    by the caller before this gate and stay allowed (the proxy applies
    searx's own upstream validation)."""
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return False
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True  # a regular host name that passed the suffix gate
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast)


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


def _attached_images(payload: dict[str, t.Any], cfg: dict[str, t.Any]) -> list[dict[str, t.Any]]:
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


# --------------------------------------------------------------- answer view


def _answer_system(lang: str) -> str:
    """The AI Overview system prompt: composed from the SHARED XML fragments
    in ai/prompts.py (citation grammar, markdown surface, language
    directive) so the two AI features cannot drift apart."""
    return "\n".join(
        [
            "<role>\nYou are the \"AI Overview\" feature of a search engine:"
            " answer the user's question directly, grounded in the numbered"
            " sources provided.\n</role>",
            prompts.today_line(),
            prompts.language_directive(lang),
            prompts.citation_rules(),
            prompts.markdown_surface(),
            prompts.grounding_fallback("sources"),
            prompts.reader_voice(),
            prompts.opening_rule(),
        ]
    )


_ANSWER_USER_PROMPT = "<q>{q}</q>\n<sources>\n{context}\n</sources>"


def _build_answer_messages(
    query: str, context: str, lang: str, image_parts: list[dict[str, t.Any]]
) -> list[dict[str, t.Any]]:
    system = _answer_system(lang)
    if image_parts:
        system += (
            "\n<images>\nImages are attached after this text; they come from"
            " the numbered sources and may carry relevant visual"
            " information.\n</images>"
        )
    user_text = _ANSWER_USER_PROMPT.format(q=query, context=context)
    user: dict[str, t.Any] = (
        {"role": "user", "content": [{"type": "text", "text": user_text}, *image_parts]}
        if image_parts
        else {"role": "user", "content": user_text}
    )
    return [{"role": "system", "content": system}, user]


def _upstream_error_response(first_kind: str, first: str | None) -> flask.Response:
    """The 502 response for a stream that died before its first token: a
    plain-text body carrying the truncated upstream reason -- the client's
    fetchStream surfaces it under the card's failed label (the full detail
    is already in the server log)."""
    if first_kind == "end":
        logger.warning(
            "zjsearch_ai: upstream produced no answer content -- reasoning-style models can spend very "
            "long on their thinking; disable thinking via zjsearch.ai.extra_body "
            "(e.g. chat_template_kwargs: {'enable_thinking': False}) or set params.max_tokens"
        )
    reason = llm.reason_of(first) if first_kind == "error" else llm.reason_of(None)
    resp = flask.Response(f"AI upstream error: {reason}", status=502, mimetype="text/plain")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.ai.overview`` settings block."""
    cfg = llm.ai_cfg().get("overview")
    return cfg if isinstance(cfg, dict) else {}


def _enabled() -> bool:
    """The overview feature flag: ``zjsearch.ai.overview.enabled`` --
    ``True`` unless explicitly switched off."""
    return bool(_cfg().get("enabled", True))


def capability() -> dict[str, str] | None:
    """The page-data ``ai`` payload (token + model label); ``None`` when the
    overview feature is switched off or the transport is unconfigured -- the
    client hides its AI Overview entry point then."""
    if not _enabled():
        return None
    return llm.capability()


def _answer() -> flask.Response:
    """AI Overview: the client assembles the numbered source context from the
    page payload it already has, this view streams the answer.  Reasoning
    deltas are relayed wrapped in ``<think>...</think>`` so the client can
    fold them away."""
    cfg = llm.ai_cfg()
    if not _enabled() or not llm.configured(cfg):
        flask.abort(404)
    payload = sxng_request.get_json(silent=True) or {}
    if not llm.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    q = str(payload.get("q") or "").strip()
    context = str(payload.get("context") or "")[:_CONTEXT_MAX_CHARS]
    if not q or not context.strip():
        flask.abort(422)
    lang = str(payload.get("lang") or "").strip()
    if lang in ("", "all", "auto"):
        lang = "en"

    image_parts = _attached_images(payload, cfg)

    def open_run(with_images: bool) -> t.Iterator[tuple[str, t.Any]]:
        # the zero-tool single-turn case of the agent framework
        return agent.run_agent(cfg, _build_answer_messages(q, context, lang, image_parts if with_images else []))

    events = open_run(bool(image_parts))
    try:
        first_kind, first = next(events)
    except StopIteration:
        first_kind, first = "end", None
    if first_kind == "error" and image_parts:
        # the endpoint rejected the multimodal request (no vision support,
        # or memory pressure) -- degrade to a text-only answer
        logger.warning("zjsearch_ai: image request rejected, retrying text-only")
        events = open_run(False)
        try:
            first_kind, first = next(events)
        except StopIteration:
            first_kind, first = "end", None
    if first_kind not in ("delta", "think") or not first:
        return _upstream_error_response(first_kind, first)

    def generate():
        # the raw-text wire adapter: <think> markers rendered around the
        # framework's shared ThinkGate state
        gate = agent.ThinkGate()
        kind, text = first_kind, first
        while kind in ("delta", "think"):
            if kind == "think":
                state = gate.reasoning()
                if state == "open":
                    yield "<think>"
                if state != "drop":
                    yield text or ""
            else:
                if gate.opened and not gate.closed:
                    yield "</think>"
                gate.content()
                yield text or ""
            kind, text = next(events, ("end", None))
        if gate.opened and not gate.closed:
            yield "</think>"

    resp = flask.Response(generate(), mimetype="text/plain")
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# -------------------------------------------------------------------- install


def install(app: flask.Flask) -> None:
    """Register the answer route; chained from the ``searx.zjsearch.ai``
    package install so the theme keeps one webapp.py entry point.  An
    enabled-but-incomplete configuration or a missing SDK package logs a
    warning and the feature stays off."""
    cfg = llm.ai_cfg()
    if not cfg.get("enabled"):
        return
    if not _enabled():
        return
    if not llm.configured(cfg):
        logger.warning("zjsearch.ai is enabled but model/base_url are missing -- AI answers stay off")
        return
    kind = llm.endpoint(cfg)[0]
    if str(cfg.get("sdk") or "") and cfg.get("sdk") not in llm.ENDPOINT_KINDS:
        logger.warning("zjsearch.ai: unknown sdk %r -- treating it as openai_chat_completions", cfg.get("sdk"))
    package = llm.SDK_PACKAGES[kind]
    if importlib.util.find_spec(package) is None:
        logger.warning(
            "zjsearch.ai: the %r transport needs the %r package (see requirements.txt) -- AI answers stay off",
            kind,
            package,
        )
        return
    app.add_url_rule("/ai/answer", "zjsearch_ai_answer", _answer, methods=["POST"])
