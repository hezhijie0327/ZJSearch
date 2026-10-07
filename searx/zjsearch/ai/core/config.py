# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``zjsearch.*`` settings-block readers every service shares.

One defensive walk instead of seven hand copies: a block is absent
unless the deployment defines it, and every reader answers ``{}`` (or
the fallback) rather than raising.  The env fallback for API keys is
here too -- the setting first, the ``ZJSEARCH_*_KEY`` environment
second, so real keys never enter a tracked file."""

import os
import typing as t

from searx import settings


def zj_block(*path: str) -> dict[str, t.Any]:
    """The ``zjsearch.<path...>`` settings block (e.g. ``zj_block("llm")``,
    ``zj_block("feature", "ai_search")``) -- ``{}`` when any level is
    absent or not a mapping."""
    node: t.Any = settings.get("zjsearch", {}) if isinstance(settings.get("zjsearch", {}), dict) else {}
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return node if isinstance(node, dict) else {}


def env_key(block: dict[str, t.Any], env: str, setting: str = "api_key") -> str:
    """The effective API key of one service block: the ``api_key`` setting
    first, then the service's ``ZJSEARCH_*_KEY`` environment."""
    return str(block.get(setting) or "") or os.environ.get(env, "")
