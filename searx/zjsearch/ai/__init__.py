# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the AI endpoints of the theme, on a THREE-LAYER stack:

- :py:mod:`searx.zjsearch.ai.infra` -- the providers: ONE factory per SDK
  family (openai / anthropic / gemini) centrally registered, the stream
  queue-bridge, prompt-cache shaping, tiered structured output, the
  embedding service, the HMAC gate and the shared route prologue.
- :py:mod:`searx.zjsearch.ai.framework` -- the provider-agnostic agent
  engine: the timeline-op wire protocol, the phase-machine loop
  (research turns, the ask-user escape hatch, the writer phase), the
  tool-executor contract, the channel doctrine's state machine, the
  cross-dialect reasoning echo, the fence splitter.
- :py:mod:`searx.zjsearch.ai.runtime` -- the concrete tasks on the
  engine: AI Search (four depth modes over the researcher/writer split)
  and the AI Overview (the fixed quick task: one write turn over the
  client-assembled context), plus the embedding browser proxy and the
  thread page.  Tool implementations live in
  :py:mod:`searx.zjsearch.ai.capabilities`.

The endpoints are stateless and opt-in: nothing registers unless
``zjsearch.ai`` is enabled and fully configured in the deployment's
settings.
"""

import logging

import flask

from searx import settings
from searx.zjsearch.ai.infra import config as llm_config

logger = logging.getLogger(__name__)


def _capabilities() -> dict[str, dict[str, str] | None]:
    """The per-page AI capability payloads for the ``globals()`` data macro
    (a Jinja environment global, so EVERY render path -- the homepage, the
    upstream render fallback, the streamed mirror -- carries them): ``ai``
    is the AI Overview entry point, ``ai_search`` the AI Search one,
    ``embedding`` the history-search one.  Each is ``None`` when its
    feature flag is off or the transport is unconfigured; the macro omits
    the key then and the client hides the feature's entry point."""

    from searx.zjsearch.ai import runtime  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.runtime import embed_route, overview  # pylint: disable=import-outside-toplevel

    return {
        "ai": overview.capability(),
        "ai_search": runtime.capability(),
        "embedding": embed_route.capability(),
    }


def install(app: flask.Flask) -> None:
    """Chain the task installs; called from the package install
    (``searx.zjsearch``).  Task modules register their own routes and
    stay silent when not configured."""
    from searx.zjsearch.ai import runtime  # pylint: disable=import-outside-toplevel
    from searx.zjsearch.ai.runtime import embed_route, overview  # pylint: disable=import-outside-toplevel

    if llm_config.llm_cfg().get("enabled") and settings.get("server", {}).get("secret_key") == "ultrasecretkey":
        logger.warning("zjsearch.ai runs with the default server.secret_key -- answer tokens are forgeable")
    overview.install(app)
    runtime.install(app)
    embed_route.install(app)
    app.jinja_env.globals["zjs_ai_capabilities"] = _capabilities
