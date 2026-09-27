# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the AI endpoints of the theme.

- :py:mod:`searx.zjsearch.ai.overview` -- the whole-page AI Overview
  (``POST /ai/answer``).
- :py:mod:`searx.zjsearch.ai.search` -- AI Search, the model-driven
  keyword searches (``POST /ai/search``).
- :py:mod:`searx.zjsearch.ai.llm` -- the shared LLM transport layer and
  :py:mod:`searx.zjsearch.ai.agent` -- the agent loop both features run
  on.

The endpoints are stateless and opt-in: nothing registers unless
``zjsearch.ai`` is enabled and fully configured in the deployment's
settings.
"""

import logging

import flask

from searx import settings
from searx.zjsearch.ai import llm

logger = logging.getLogger(__name__)


def install(app: flask.Flask) -> None:
    """Chain the AI feature installs; called from the package install
    (``searx.zjsearch``).  Feature modules register their own routes and
    stay silent when not configured."""
    from searx.zjsearch.ai import overview, search  # pylint: disable=import-outside-toplevel

    if llm.ai_cfg().get("enabled") and settings.get("server", {}).get("secret_key") == "ultrasecretkey":
        logger.warning("zjsearch.ai runs with the default server.secret_key -- answer tokens are forgeable")
    overview.install(app)
    search.install(app)
