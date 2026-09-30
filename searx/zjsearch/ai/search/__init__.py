# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
# pylint: disable=too-many-lines
"""zjsearch theme: AI Search -- the model drives the keyword searches.

The tool-calling feature on the shared agent framework
(:py:mod:`searx.zjsearch.ai.agent`), in Vane's RESEARCHER/WRITER shape:
a research agent analyses the question, writes a one-line intent, then
issues ``web_search`` calls that run as REAL instance searches -- the
same ``SearchWithPlugins`` path the results page uses, plugins included
-- in parallel worker threads.  A second tool, ``web_crawler``, reads
one result's page in full through the self-hosted Browserless browser
(:py:mod:`searx.zjsearch.ai.reader`) when a snippet promises
exactly the missing detail.  When the research ends, a FRESH WRITER
completion -- never the researcher -- writes the cited answer from the
accumulated source feed, so the answer's shape and voice are the same
no matter how the research went (the researcher's prose is structurally
unable to leak into the answer).  Each search's
results are serialized through the very ``_result_data`` macro the
page-data uses, so the client renders sub-results with its standard
components; both sides consume a compacted, globally numbered ``[n]``
feed of the same sources; the writer emits the cited answer (the AI
Overview renderer contract: ``[n]`` chips, GFM, think block).

The package is split by responsibility (Vane's api/actions/prompts
layering, Morphic's tools/streaming split); the dependency direction is
one-way -- config <- tools/prompts/gates <- executor/wire <- route:

- :py:mod:`searx.zjsearch.ai.search.config` -- modes, budgets, the
  ``zjsearch.ai.search`` settings block and the page-data capability;
- :py:mod:`searx.zjsearch.ai.search.tools` -- the tool specs and their
  argument sanitizers;
- :py:mod:`searx.zjsearch.ai.search.prompts` -- the researcher's and
  the writer's message builders (and the honesty notes);
- :py:mod:`searx.zjsearch.ai.search.gates` -- the small fail-open
  structured completions (research gate, clarify, standalone rewrite,
  related fallback);
- :py:mod:`searx.zjsearch.ai.search.executor` -- the worker pool, the
  ``[n]`` registries, the feed and the stall detector;
- :py:mod:`searx.zjsearch.ai.search.wire` -- the fence splitter and the
  events-to-NDJSON adapter;
- :py:mod:`searx.zjsearch.ai.search.route` -- the ``POST /ai/search``
  view and the install hook;
- :py:mod:`searx.zjsearch.ai.search.page` -- the standalone thread page
  (``GET /ai/thread/<uuid>``): a slim shell carrying the conversation
  identity + fresh capability tokens -- the thread itself lives in the
  browser's storage (LobeHub's conversation shape; the endpoint stays
  stateless).

Wire protocol (NDJSON, one JSON object per line; the stream never ends
silently):

- ``{"e": "think", "t"}`` / ``{"e": "delta", "t"}`` -- reasoning and prose
  deltas of the current phase (research turns' prose becomes the next
  event's intent; the writer's deltas are the answer);
- ``{"e": "calls", "round", "intent", "items": [{id, tool, q/url, ...}]}``
  -- a parallel batch announced (the model decides the batch size;
  ``tool`` discriminates ``web_search`` rows from ``web_crawler`` rows);
- ``{"e": "search", "round", "id", "status", "n", "ms"}`` -- one search
  finished (ok / error / duplicate);
- ``{"e": "page", "round", "id", "status", "url", "title", "chars",
  "ms", "text"}`` -- one ``web_crawler`` read finished (ok / error /
  duplicate); a successful read carries the extracted content, and the
  client's row expands into a reading pane of it;
- ``{"e": "sources", "items": [{n, round, id, idx, ...}]}`` -- the global
  ``[n]`` registry entries (citation chips jump to ``round``/``id``/``idx``);
- ``{"e": "direct"}`` -- the pre-flight gate judged the request a
  no-research task (greeting, writing task): the writer answers directly,
  no research follows;
- ``{"e": "gallery", "items": [{u, n}]}`` -- the writer embedded an inline
  image group (the ``zjs-images`` fence, URLs validated against the run's
  image registry); the answer text carries a ``{{zjs-gallery:i}}``
  placeholder at the position;
- ``{"e": "wrapup"}`` -- the research phase ended: the WRITER completion
  takes over (the client drops any streamed research prose and shows the
  synthesizing state; the writer's deltas are the answer);
- ``{"e": "ask", "intro", "questions": [{q, type, options}]}`` -- the
  clarify gate wants the user's direction BEFORE researching; the run
  settles as ``awaiting`` (``{"e": "end"}`` follows; the answers travel
  on the next request as ``clarifications``);
- ``{"e": "related", "items": [...]}`` -- follow-up suggestions.  The
  writer emits them IN-STREAM as a `` ```related `` fence at the end of
  the answer (Morphic's in-stream related: zero extra completions) -- the
  fence is intercepted server-side and never reaches the client's answer
  text; when the fence is missing, the post-``end`` small completion
  generates them as before;
- ``{"e": "error", "reason"}`` mid-stream, ``{"e": "end"}`` closes.

A stream that dies before its first line answers 502 with a truncated
upstream reason (same contract as the AI Overview).  Configuration: the
transport is the shared ``zjsearch.ai`` block; this feature ships
enabled and opts out via ``zjsearch.ai.search.enabled: false`` (the AI
Overview mirrors that under ``zjsearch.ai.overview.enabled``).
"""

from searx.zjsearch.ai.search.config import capability
from searx.zjsearch.ai.search.page import install as page_install
from searx.zjsearch.ai.search.route import install as route_install


def install(app) -> None:  # pylint: disable=missing-function-docstring
    page_install(app)
    route_install(app)


__all__ = ["capability", "install"]
