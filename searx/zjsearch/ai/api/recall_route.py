# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``POST /zjsearch/ask/run/recall`` endpoint: the live-recall
answerer.  The client's hybrid recall over its browser-local knowledge
base lands here and fills the parked ``past_research`` call's slot (the
``recall`` wire event asked, keyed by the slot id minted for that one
call).  The slot id IS the capability: random per call, consumed on the
first answer or the timeout -- unknown/expired ids answer ``ok: false``
without existing.  The entries carry the client's ranking (its hybrid
recall ran on the model's own query); :py:func:`parse_entries`
sanitizes them into the same shape the index path consumes."""

import flask

from searx.zjsearch.ai.api import http
from searx.zjsearch.ai.llm import config as llm_config
from searx.zjsearch.ai.runs.profile import enabled
from searx.zjsearch.ai.runs.search import recall as recall_slot
from searx.zjsearch.ai.tools.past_research import parse_entries


def _gate() -> bool:
    return enabled() and llm_config.configured(llm_config.llm_cfg())


def _recall_view() -> flask.Response:
    payload = http.token_payload(gate=_gate())
    entries = parse_entries(payload.get("entries"))
    ok = recall_slot.answer(str(payload.get("id") or ""), entries)
    return flask.jsonify({"ok": ok})


def install(app: flask.Flask) -> None:
    """Register the recall answer route; chained from the ai package
    install."""
    app.add_url_rule("/zjsearch/ask/run/recall", "zjsearch_ask_run_recall", _recall_view, methods=["POST"])
