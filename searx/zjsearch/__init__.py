# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: the theme's server-side Python package.

Everything the theme adds to ``searx`` core lives here instead of
top-level ``searx.zjsearch_*`` modules:

- :py:mod:`searx.zjsearch.stream` -- the streamed search pages (the boot
  shell flush + late page-data chunk).
- :py:mod:`searx.zjsearch.ai` -- the AI endpoints (AI Overview, AI
  Search) on the infra/framework/runtime stack.

webapp.py keeps its single theme hook: it calls :py:func:`install` once at
the end of the module, which chains the feature installs; nothing here is
active until that call.
"""

import flask


def install(app: flask.Flask) -> None:
    """Chain the theme feature installs.  Called exactly once from the end
    of webapp.py; the lazy imports keep the package import itself free of
    any cycle with webapp."""
    from searx.zjsearch import stream  # pylint: disable=import-outside-toplevel,cyclic-import
    from searx.zjsearch.ai import install as ai_install  # pylint: disable=import-outside-toplevel,cyclic-import
    from searx.zjsearch.pwa import install as pwa_install  # pylint: disable=import-outside-toplevel,cyclic-import

    stream.install(app)
    ai_install(app)
    pwa_install(app)
