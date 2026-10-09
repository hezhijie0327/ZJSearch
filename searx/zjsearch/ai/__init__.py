# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the AI stack, on a EIGHT-package layout:

- :py:mod:`searx.zjsearch.ai.core` -- cross-cutting foundations with
  zero AI semantics (settings-block readers, the HMAC token gate, the
  shared text guards, the SSRF gate, the NDJSON stream wrapper);
- :py:mod:`searx.zjsearch.ai.llm` -- the providers: ONE factory per SDK
  family centrally registered, the stream queue-bridge, prompt-cache
  shaping, tiered structured output, the embedding/rerank/decision
  services;
- :py:mod:`searx.zjsearch.ai.agent` -- the provider-agnostic agent
  engine: the timeline-op wire protocol, the phase-machine loop, the
  tool-executor contract, the channel doctrine, the reasoning echo, the
  fence splitter;
- :py:mod:`searx.zjsearch.ai.prompts` -- the prompt library (the
  byte-stable text blocks; a wording change is a prompts commit);
- :py:mod:`searx.zjsearch.ai.tools` -- the tool registry: ONE package
  per tool family (spec, sanitizers, service);
- :py:mod:`searx.zjsearch.ai.runs` -- the concrete tasks: AI Search
  (depth modes over the researcher/writer split) with the Report output
  shape (:py:mod:`runs.report`), and the AI Overview;
- :py:mod:`searx.zjsearch.ai.api` -- the thin HTTP surface.

Dependencies point strictly downwards: api -> runs -> tools -> agent
-> llm -> core; prompts is material consumed by runs/tools.  The
endpoints are stateless and opt-in: nothing registers unless
``zjsearch`` is enabled and fully configured in the deployment's
settings.
"""

import logging

import flask

from searx import settings
from searx.zjsearch.ai.llm import config as llm_config

logger = logging.getLogger(__name__)


def _capabilities() -> dict[str, dict[str, str] | None]:
    """The per-page AI capability payloads for the ``globals()`` data macro
    (a Jinja environment global, so EVERY render path -- the homepage, the
    upstream render fallback, the streamed mirror -- carries them): ``ai``
    is the AI Overview entry point, ``ai_search`` the AI Search one,
    ``embedding`` the history-search one, ``decision`` the browser's
    judgment proxy, ``rerank`` the recall's cross-encoder proxy.  Each is
    ``None`` when its feature flag is off or the transport is
    unconfigured; the macro omits the key then and the client hides the
    feature's entry point."""

    from searx.zjsearch.ai import runs  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.api import (  # pylint: disable=import-outside-toplevel
        decision_route,
        embed_route,
        rerank_route,
    )
    from searx.zjsearch.ai.runs import overview  # pylint: disable=import-outside-toplevel

    return {
        "ai": overview.capability(),
        "ai_search": runs.capability(),
        "embedding": embed_route.capability(),
        "decision": decision_route.capability(),
        "rerank": rerank_route.capability(),
    }


def install(app: flask.Flask) -> None:
    """Chain the installs; called from the package install
    (``searx.zjsearch``).  Route modules register their own endpoints and
    stay silent when not configured."""
    from searx.zjsearch.ai import runs  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.api import browser_input  # pylint: disable=import-outside-toplevel

    if llm_config.llm_cfg().get("enabled") and settings.get("server", {}).get("secret_key") == "ultrasecretkey":
        logger.warning("zjsearch.ai runs with the default server.secret_key -- answer tokens are forgeable")
    runs.install(app)
    browser_input.install(app)
    app.jinja_env.globals["zjs_ai_capabilities"] = _capabilities
