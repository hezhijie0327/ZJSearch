# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the whole-page AI Overview (``POST /ai/answer``).

The results meta row hosts the entry: the client assembles a numbered
source list from the page payload it already has and the model streams a
cited whole-page answer.  The LLM is only called on click, so a result
page loads with zero added latency and the no-JS / RSS faces of the
theme stay untouched.

Design contract:

- This is NOT a plugin (no pre/post_search) -- the route registers
  itself; ``install(app)`` is chained from the ``searx.zjsearch.ai``
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

Modules (mirroring the ``search`` package's layering):
:py:mod:`searx.zjsearch.ai.capabilities.images` -- the multimodal source
attachments; :py:mod:`searx.zjsearch.ai.overview.prompts` -- the
answer conversation built from the shared fragments;
:py:mod:`searx.zjsearch.ai.overview.route` -- the endpoint.
"""

from searx.zjsearch.ai.overview.route import capability, install

__all__ = ["capability", "install"]
