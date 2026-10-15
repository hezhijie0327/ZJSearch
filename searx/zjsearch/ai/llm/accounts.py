# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run's model-spend ledger: ONE account for the non-LLM endpoints.

Every model class the run touches beyond the chat transport -- rerank,
decision, embedding, and whatever lands next -- folds its spend into one
:class:`ModelAccount` the run owns; the settle reads
:py:meth:`ModelAccount.buckets` and the subagent promote merges deltas
against per-handle snapshots.  A new model class is one new kind string
in :py:data:`BUCKETS` plus the settle/client tiles.

Per-run BY DESIGN: the side-model services are stateless module-level
functions and one process serves concurrent runs, so run attribution
rides an explicit account the run passes with every call -- an ambient
context would have to survive the gather workers, the dispatch pools
and the driver thread, and this codebase already paid that lesson for
the flask request context.  The services parse THEIR OWN wire usage
(family knowledge stays in the family) and record here; the callers
only hand the account along.
"""

BUCKETS = ("rerank", "decision", "embedding", "gates")
"""The model classes one account tracks.  A new class appends here, folds
in its service (the service parses its wire usage and calls
:py:meth:`ModelAccount.record`), and shows up in the settle's generic
bucket merge -- the client's footer tiles read whatever arrives."""


class ModelAccount:
    """One run's spend: per model class a bucket shaped by that class's
    own report (``calls`` plus whatever it bills -- ``tokens`` for the
    input-only side models, ``input``/``output`` for the LLM gates).
    Fail-open doctrine applies to the RECORDERS (a malformed usage dict
    degrades to calls-only); the account itself is bookkeeping and
    raises nothing."""

    def __init__(self) -> None:
        # each bucket's shape is its model class's own (calls + the spend
        # fields it reports) -- seeded with calls only
        self._buckets: dict[str, dict[str, int]] = {name: {"calls": 0} for name in BUCKETS}

    def record(self, kind: str, calls: int = 1, **fields: int) -> None:
        """One endpoint settlement: ``calls`` endpoints answered plus any
        numeric spend fields the model class reports (the side models are
        input-only -- ``tokens=``; the LLM gates merge ``input=`` /
        ``output=``).  Fields MERGE numerically, so a bucket's shape is
        whatever its model class reports."""
        bucket = self._buckets.setdefault(str(kind), {"calls": 0})
        bucket["calls"] = bucket.get("calls", 0) + int(calls)
        for field, value in fields.items():
            bucket[field] = bucket.get(field, 0) + int(value or 0)

    def snapshot(self) -> dict[str, dict[str, int]]:
        """A deep copy of the current totals -- the subagent handle's
        promotion mark."""
        return {kind: dict(bucket) for kind, bucket in self._buckets.items()}

    def merge_delta(self, other: "ModelAccount", snap: dict[str, dict[str, int]]) -> None:
        """Fold ANOTHER account's not-yet-folded spend (a settled
        subagent's, against ``snap`` -- the mark this account's previous
        promotion left): a resumed subagent settles repeatedly, so a
        wholesale re-fold would double the spend.  SHAPE-AGNOSTIC: every
        bucket field merges numerically (calls and whatever the model
        class reports)."""
        totals = other.snapshot()
        for kind, bucket in totals.items():
            mark = snap.get(kind) or {}
            delta = {
                field: max(0, int(bucket.get(field) or 0) - int(mark.get(field) or 0))
                for field in bucket
                if int(bucket.get(field) or 0) > int(mark.get(field) or 0)
            }
            if delta:
                self.record(kind, **delta)
        snap.clear()
        snap.update(totals)

    def buckets(self) -> dict[str, dict[str, int]]:
        """The non-empty buckets for the settle's merge (a model class
        that never answered stays out of the wire event)."""
        return {
            kind: dict(bucket) for kind, bucket in self._buckets.items() if any(int(v or 0) for v in bucket.values())
        }

    def spend(self, kind: str) -> dict[str, int]:
        """One bucket's live totals (the callers that peek mid-run)."""
        return dict(self._buckets.get(kind) or {"calls": 0})
