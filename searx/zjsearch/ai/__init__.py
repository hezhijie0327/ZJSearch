# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the AI endpoints of the theme.

The TOP LEVEL is the shared infrastructure; the features are
subpackages (Vane's agents/* + prompts/* layering, Morphic's tools +
streaming split):

- infrastructure: :py:mod:`searx.zjsearch.ai.llm` (the LLM transport),
  :py:mod:`searx.zjsearch.ai.agent` (the agent loop + ThinkGate both
  features run on), :py:mod:`searx.zjsearch.ai.prompts` (the shared XML
  fragments incl. the answer spine), :py:mod:`searx.zjsearch.ai.reader`
  (the page reader: render + extract), :py:mod:`searx.zjsearch.ai.http`
  (the shared streaming/502 route helpers).
- features: :py:mod:`searx.zjsearch.ai.overview` (``POST /ai/answer``,
  the zero-tool single-turn case) and :py:mod:`searx.zjsearch.ai.search`
  (``POST /ai/search``, the tool-calling researcher/writer split) --
  each with its own config/tools/prompts/gates/executor/wire/route
  modules and a thin ``__init__`` re-exporting ``capability`` +
  ``install``.

The endpoints are stateless and opt-in: nothing registers unless
``zjsearch.ai`` is enabled and fully configured in the deployment's
settings.
"""

import logging

import flask

from searx import settings
from searx.zjsearch.ai import llm

logger = logging.getLogger(__name__)


def _capabilities() -> dict[str, dict[str, str] | None]:
    """The per-page AI capability payloads for the ``globals()`` data macro
    (a Jinja environment global, so EVERY render path -- the homepage, the
    upstream render fallback, the streamed mirror -- carries them): ``ai``
    is the AI Overview entry point, ``ai_search`` the AI Search one.  Each
    is ``None`` when its feature flag is off or the transport is
    unconfigured; the macro omits the key then and the client hides the
    feature's entry point."""

    from searx.zjsearch.ai import overview, search  # pylint: disable=import-outside-toplevel

    return {"ai": overview.capability(), "ai_search": search.capability()}


def install(app: flask.Flask) -> None:
    """Chain the AI feature installs; called from the package install
    (``searx.zjsearch``).  Feature modules register their own routes and
    stay silent when not configured."""
    from searx.zjsearch.ai import overview, search  # pylint: disable=import-outside-toplevel

    if llm.ai_cfg().get("enabled") and settings.get("server", {}).get("secret_key") == "ultrasecretkey":
        logger.warning("zjsearch.ai runs with the default server.secret_key -- answer tokens are forgeable")
    overview.install(app)
    search.install(app)
    app.jinja_env.globals["zjs_ai_capabilities"] = _capabilities
