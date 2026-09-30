# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Overview: the feature settings (the search/config.py shape).

The overview is the ZERO-TOOL single-turn case of the shared agent
framework, so its config module is deliberately small: the feature
block and the flag -- the capability payload comes from the shared
:py:func:`searx.zjsearch.ai.llm.feature_capability` helper.
"""

import typing as t

from searx.zjsearch.ai import llm


def _cfg() -> dict[str, t.Any]:
    """The ``zjsearch.feature.ai_overview`` settings block."""
    return llm.feature_cfg("ai_overview")


def enabled() -> bool:
    """The overview feature flag: ``zjsearch.feature.ai_overview.enabled`` --
    ``True`` unless explicitly switched off."""
    return llm.feature_enabled("ai_overview")
