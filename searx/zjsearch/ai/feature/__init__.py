# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The AI FEATURES group: the endpoints of the theme, each a subpackage
with its own config/tools/prompts/gates/executor/wire/route modules and
a thin ``__init__`` re-exporting ``capability`` + ``install``.

- :py:mod:`searx.zjsearch.ai.feature.overview` -- ``POST /ai/answer``,
  the zero-tool single-turn case.
- :py:mod:`searx.zjsearch.ai.feature.search` -- ``POST /ai/search``, the
  tool-calling researcher/writer split.

The grouping mirrors the ``zjsearch.feature.*`` settings keys -- the
features are consumers of the ``ai`` transport and the ``reader``
capability, never their configuration.
"""
