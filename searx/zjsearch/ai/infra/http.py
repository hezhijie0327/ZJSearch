# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: shared HTTP plumbing for the AI routes.

The two AI features stream their answers over flask Responses with the
same no-proxy/no-cache header set, and both answer a stream that died
before its first token with the same plain-text 502 (the truncated
upstream reason rides in the body; the full detail is in the server
log).  This module is that contract -- one definition, both consumers.
"""

import logging
import typing as t

import flask

from searx.extended_types import sxng_request
from searx.zjsearch.ai.infra import jsongate, security

logger = logging.getLogger(__name__)


def authorize(gate: bool, *, context: bool = False) -> tuple[dict[str, t.Any], str, str]:
    """The shared route prologue of the AI endpoints: the feature gate
    (404), the HMAC token (403) and the request's question -- plus, for
    the features that take one, the client-assembled context (422 when
    either is missing).  Returns ``(payload, question, context)``;
    ``context`` is ``""`` when not requested."""
    if not gate:
        flask.abort(404)
    payload = sxng_request.get_json(silent=True) or {}
    if not security.check_token(str(payload.get("tk") or "")):
        flask.abort(403)
    q = str(payload.get("q") or "").strip()
    ctx = str(payload.get("context") or "") if context else ""
    if not q or (context and not ctx.strip()):
        flask.abort(422)
    return payload, q, ctx


def answer_lang(payload: dict[str, t.Any]) -> str:
    """The resolved reply language of a request: the page's language
    filter verbatim, empty/auto/all falling back to English (the two
    catalog languages rule lives in the prompts' language directive)."""
    lang = str(payload.get("lang") or "").strip()
    return "en" if lang in ("", "all", "auto") else lang


def streaming_response(iterator: t.Iterator[str], mimetype: str) -> flask.Response:
    """A streamed response with the proxy/cache headers the AI endpoints
    need: ``X-Accel-Buffering: no`` keeps nginx from coalescing the
    stream, ``Cache-Control: no-cache`` keeps whiteNoise / browsers out."""
    resp = flask.Response(flask.stream_with_context(iterator), mimetype=mimetype)
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def upstream_error_response(kind: str, payload: t.Any) -> flask.Response:
    """The 502 response for a stream that died before its first token: a
    plain-text body carrying the truncated upstream reason -- the client
    surfaces it under the card's failed label.  An upstream that answered
    200 with zero events (``kind == "end"``, reasoning-style models can
    spend very long on their thinking) gets its own operator hint."""
    if kind == "end":
        logger.warning(
            "zjsearch_ai: upstream produced no answer content -- reasoning-style models can spend very "
            "long on their thinking; disable thinking via zjsearch.ai.extra_body "
            "(e.g. chat_template_kwargs: {'enable_thinking': False}) or set params.max_tokens"
        )
    reason = jsongate.reason_of(payload if kind == "error" else None)
    resp = flask.Response(f"AI upstream error: {reason}", status=502, mimetype="text/plain")
    resp.headers["Cache-Control"] = "no-cache"
    return resp
