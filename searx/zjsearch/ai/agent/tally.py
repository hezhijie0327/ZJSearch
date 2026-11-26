# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""The run's consolidated transport-usage tally (the finish reason +
the per-phase token sums behind the settle's ``usage``).  Split from
the loop engine: pure accounting, zero transport knowledge."""

import typing as t

class Tally:
    """The run's consolidated transport meta: the LAST turn's finish reason
    is the answer's completion state (the writer's, when a writer phase
    ran) and the usage sums across turns -- with a PER-PHASE split
    (research vs write) so the client's account shows where the tokens
    went.  The gates' spend lives outside (the runtime collects it and
    folds it into the settle's usage under ``gates``)."""

    def __init__(self) -> None:
        self.finish: str | None = None
        self.model: str | None = None
        self.phase = "research"
        self.usage = _zero_usage()
        self.usage_research = _zero_usage()
        self.usage_write = _zero_usage()

    def absorb(self, payload: t.Any) -> dict[str, t.Any]:
        """Fold one turn's finish meta in; RETURNS the meta (the loop reads
        the per-turn echo payloads off it)."""
        meta = payload if isinstance(payload, dict) else {}
        if meta.get("finish"):
            self.finish = str(meta["finish"])
        if meta.get("model"):
            # the API-REPORTED model id of the last turn that reported one
            self.model = str(meta["model"])
        usage = meta.get("usage")
        if isinstance(usage, dict):
            _bump(self.usage, usage)
            _bump(self.usage_research if self.phase == "research" else self.usage_write, usage)
        return meta

    def settle_kwargs(self) -> dict[str, t.Any]:
        return {"finish": self.finish, "usage": self.canonical_usage(), "model": self.model}

    def canonical_usage(self) -> dict[str, t.Any] | None:
        usage = self.usage
        if not self.finish and not (usage["input"] or usage["output"]):
            return None
        return {
            "input": usage["input"],
            "output": usage["output"],
            "thoughts": usage["thoughts"] or None,
            "cached": usage["cached"],
            "cache_write": usage["cache_write"],
            "research": _sub(self.usage_research),
            "write": _sub(self.usage_write),
        }


def _zero_usage() -> dict[str, int]:
    return {"input": 0, "output": 0, "thoughts": 0, "cached": 0, "cache_write": 0}


def _bump(bucket: dict[str, int], usage: dict[str, t.Any]) -> None:
    bucket["input"] += int(usage.get("input") or 0)
    bucket["output"] += int(usage.get("output") or 0)
    thoughts = usage.get("thoughts")
    if thoughts is not None:
        bucket["thoughts"] += int(thoughts)
    bucket["cached"] += int(usage.get("cached") or 0)
    bucket["cache_write"] += int(usage.get("cache_write") or 0)


def _sub(bucket: dict[str, int]) -> dict[str, int] | None:
    if not (bucket["input"] or bucket["output"]):
        return None
    return {
        "input": bucket["input"],
        "output": bucket["output"],
        "thoughts": bucket["thoughts"] or 0,
        "cached": bucket["cached"],
        "cache_write": bucket["cache_write"],
    }
