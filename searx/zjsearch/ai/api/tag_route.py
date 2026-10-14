# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ai/tags`` endpoint: LLM tag normalization for the
browser's knowledge base (the tag graph's semantic layer).

The client derives RAW tags at write time (query tokens, hosts, mode,
the model's own task titles) and the extractor adds concept tags at
settle.  This endpoint is the upgrade pass: ONE small structured
completion folds a batch of raw tag sets into normalized CONCEPT tags --
language-merged, noise dropped, synonyms collapsed -- so the graph's
nodes stay canonical.  Same shape as the embed proxy: HMAC token gate
(the AI Search token -- this is an AI feature), strict input
validation, the shared transport.  Stateless like every AI route.
"""

import logging
import typing as t

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.runs.profile import enabled

logger = logging.getLogger(__name__)

MAX_ITEMS = 32
"""One batch normalizes at most this many tag sets (the client sends the
whole un-normalized backlog; 32 rows x ~6 tags is one small completion)."""

MAX_TAGS = 12
"""Per row: a raw tag set larger than this is truncated client-side
already -- the limit here is the abuse guard."""

_NORMALIZE_SCHEMA: dict[str, t.Any] = {
    "type": "object",
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["tags"],
                "properties": {
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
            },
        },
    },
}


def _prompt(items: list[dict[str, t.Any]]) -> str:
    import json  # pylint: disable=import-outside-toplevel

    return "<items>\n" + json.dumps(items, ensure_ascii=False) + "\n</items>"


def _tags_view() -> flask.Response:
    payload = http.token_payload(gate=enabled() and llm_config.configured(llm_config.llm_cfg()))
    items = payload.get("items")
    if not isinstance(items, list) or not items or len(items) > MAX_ITEMS:
        return (
            flask.jsonify({"error": f"items must be a non-empty list of at most {MAX_ITEMS} tag sets"}),
            422,
        )
    clean: list[list[str]] = []
    for item in items:
        tags = item.get("tags") if isinstance(item, dict) else None
        if not isinstance(tags, list):
            return flask.jsonify({"error": "every item carries a tags list"}), 422
        clean.append([str(tag)[:60] for tag in tags if str(tag).strip()][:MAX_TAGS])

    from searx.zjsearch.ai.llm import jsongate  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.prompts import extractor  # pylint: disable=import-outside-toplevel

    value, _usage = jsongate.json_completion(
        llm_config.llm_cfg(),
        [
            {
                "role": "system",
                "content": extractor.TAGS_NORMALIZE_SYSTEM,
            },
            {"role": "user", "content": _prompt(clean)},
        ],
        "tag_normalize",
        _NORMALIZE_SCHEMA,
    )
    value = value or {}
    out_items = value.get("items")
    if not isinstance(out_items, list) or len(out_items) != len(clean):
        # fail open: a malformed model answer keeps the raw tags (the
        # client only marks rows normalized on a well-formed response)
        return flask.jsonify({"error": "tag normalization upstream failed"}), 502
    normalized: list[list[str]] = []
    for item in out_items:
        tags = item.get("tags") if isinstance(item, dict) else None
        normalized.append(
            [str(tag).strip()[:40] for tag in tags if str(tag).strip()][:6] if isinstance(tags, list) else []
        )
    return flask.jsonify({"items": [{"tags": tags} for tags in normalized]})


def install(app: flask.Flask) -> None:
    """Register the tag-normalization route (the AI Search feature's gate:
    its capability token is the entry ticket).  Silent when not
    configured."""
    if not enabled() or not llm_config.configured(llm_config.llm_cfg()):
        return
    app.add_url_rule("/zjsearch/ai/tags", "zjsearch_ai_tags", _tags_view, methods=["POST"])
