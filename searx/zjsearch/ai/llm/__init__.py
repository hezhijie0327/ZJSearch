# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The INFRA layer of the AI stack: everything about talking to model
providers, and nothing about what to say or when.

- :mod:`.sdk` -- ONE factory per SDK family (openai / anthropic /
  gemini), centrally registered; the factory binds config + base_url
  into an object that speaks the whole SDK surface (chat pump, JSON
  completion, embeddings where the family has them).
- :mod:`.streaming` -- the queue bridge from the shared network loop to
  the WSGI thread (cancellation included).
- :mod:`.caching` / :mod:`.usage` / :mod:`.jsongate` -- request shaping,
  the canonical finish/usage contract, tiered structured output.
- :mod:`.embed` -- the embedding service (config + server-side call).
- :mod:`.security` / :mod:`.config` / :mod:`.http` -- the HMAC gate,
  the settings surface, the shared route prologue.

The layers above this one: ``framework`` (the provider-agnostic agent
engine) and ``runtime`` (the concrete tasks -- search and overview).
"""
