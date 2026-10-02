# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search -- the research task preset on the shared agent framework.

The tool-calling task in Vane's RESEARCHER/WRITER shape, running on
:py:mod:`searx.zjsearch.ai.framework.loop`: a research agent analyses
the question, writes a one-line intent, then issues ``web_search`` calls
that run as REAL instance searches -- the same ``SearchWithPlugins``
path the results page uses, plugins included -- in parallel worker
threads.  A second tool, ``web_reader``, reads one result's page in
full through the self-hosted Browserless browser when a snippet
promises exactly the missing detail.  When the research ends, a FRESH
WRITER completion -- never the researcher -- writes the cited answer
from the accumulated source feed (the researcher's prose is
structurally unable to leak into the answer).  Each search's results
are serialized through the very ``_result_data`` macro the page-data
uses, so the client renders sub-results with its standard components.

Modules (one-way dependencies):

- :py:mod:`runtime.search.profile` -- modes, budgets, the
  ``zjsearch.feature.ai_search`` settings block and the capability;
- :py:mod:`runtime.search.tools` -- the tool specs and their argument
  sanitizers;
- :py:mod:`runtime.search.prompts` -- the researcher's and the writer's
  message builders (on :py:mod:`runtime.spine`'s shared blocks);
- :py:mod:`runtime.search.gates` -- the small fail-open structured
  completions;
- :py:mod:`runtime.search.executor` -- the worker pool, the ``[n]``
  registries, the feed and the stall detector;
- :py:mod:`runtime.search.route` -- the ``POST /zjsearch/ai/search``
  view over :py:mod:`framework.loop` (the timeline ops ARE the wire) and
  the install hook;
- :py:mod:`runtime.search.page` -- the standalone thread page
  (``GET /zjsearch/ai/thread/<uuid>``).

Wire protocol v2 (NDJSON; the closed event set lives in
:py:mod:`framework.wire`): every event is a timeline operation -- the
client never reconstructs state.  A stream that dies before its first
content answers 502 with a truncated upstream reason.
"""

from searx.zjsearch.ai.runtime.knowledge_page import install as knowledge_page_install
from searx.zjsearch.ai.runtime.page import install as page_install
from searx.zjsearch.ai.runtime.profile import capability
from searx.zjsearch.ai.runtime.route import install as route_install
from searx.zjsearch.ai.runtime.tag_route import install as tag_route_install


def install(app) -> None:  # pylint: disable=missing-function-docstring
    page_install(app)
    knowledge_page_install(app)
    route_install(app)
    tag_route_install(app)


__all__ = ["capability", "install"]
