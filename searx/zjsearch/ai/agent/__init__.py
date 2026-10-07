# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The FRAMEWORK layer: the provider-agnostic agent engine.

Everything here would work against ANY model transport that satisfies
:py:class:`infra.sdk.Sdk` -- no prompt text, no task logic, no flask:

- :mod:`.timeline` -- the timeline entry model and its wire ops.
- :mod:`.loop` -- the phase machine (research turns, the ask-user
  escape hatch, the writer phase) that drives one run.
- :mod:`.wire` -- the closed NDJSON event set (timeline ops out).
- :mod:`.executor` -- the tool-executor contract the loop consumes.
- :mod:`.thinkgate` -- the reasoning/content channel state machine.
- :mod:`.echo` -- canonical-message construction with cross-dialect
  reasoning echo payloads.
- :mod:`.fences` -- the stream fence splitter (related questions and
  inline image groups never leak into answer text).

The layers: ``infra`` (providers) below, ``runtime`` (the concrete
tasks: search and overview) above.
"""
