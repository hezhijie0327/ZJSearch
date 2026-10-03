# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The task card's coverage tracker: which subtask did a search cover?

The quality/goal tiers decompose the request through ``task_write``;
this module maps every executed search onto that plan -- query terms
matching a subtask's title mark it ACTIVE (being researched), returned
source titles matching mark it DONE (that facet has sources, with the
matching sources' [n] numbers riding the card as provenance).

Terms match by BIDIRECTIONAL CONTAINMENT, not exact equality -- an
English query must still light up a Chinese subtask title ("Next.js" vs
"Next.js 16 发布与特性调研") and CJK phrases have no word boundaries to
intersect on; a long CJK token additionally contributes its 4-gram
windows (unspaced Chinese phrases reach the matcher as ONE token per
sentence and whole-token containment would never fire across
paraphrases).
"""

import re
import typing as t


class Coverage:
    """The living task list plus its term-matching tracker."""

    def __init__(self) -> None:
        # the goal/quality task list (the task_write tool maintains it;
        # the client renders it as the STATUS card)
        self.task_list: list[dict[str, t.Any]] = []

    @staticmethod
    def match_terms(text: str) -> list[str]:
        """Matchable tokens of one text: punctuation/space-split, lowercased
        -- CJK-bearing tokens need 2+ chars, pure-ASCII ones 3+ (a short
        ascii token like "js" substring-matches far too wide) and digit
        tokens never match (a year would attribute every query).  A long
        CJK token additionally contributes its 4-gram windows -- unspaced
        Chinese phrases reach the matcher as ONE token per sentence and
        whole-token containment would never fire across paraphrases."""
        terms: list[str] = []
        for token in re.split(r"[\s,，、.。:：;；!！?？()（）\[\]【】/'\"|<>-]+", text.lower()):
            if not token or token.isdigit():
                continue
            if len(token) >= (2 if re.search(r"[\u4e00-\u9fff]", token) else 3):
                terms.append(token)
                if len(token) >= 4 and re.search(r"[\u4e00-\u9fff]", token):
                    terms.extend(token[i : i + 4] for i in range(len(token) - 3))
        return terms

    def track(  # pylint: disable=unused-argument
        self, query: str, source_titles: list[str] | None = None, source_ns: list[int] | None = None
    ) -> None:
        """Map one search/page read against the task list for PROVENANCE
        ONLY: source titles matching a subtask merge their [n] numbers
        into the task card's per-subtask source count.  Statuses are
        NEVER written here -- the task_write TOOL is the plan's single
        writer (the model updates statuses; the round referee only
        advises via notes).  Terms match by BIDIRECTIONAL CONTAINMENT,
        not exact equality -- an English query must still light up a
        Chinese subtask title ("Next.js" vs "Next.js 16 发布与特性调研")
        and CJK phrases have no word boundaries to intersect on."""
        if not self.task_list:
            return
        source_terms: list[str] = []
        for title in source_titles or []:
            source_terms.extend(self.match_terms(title))
        for task in self.task_list:
            title_terms = self.match_terms(task["title"])
            source_hit = bool(source_terms) and any(a in b or b in a for a in source_terms for b in title_terms)
            if source_hit and source_ns:
                merged = list(dict.fromkeys([*task.get("sources", []), *source_ns]))[:12]
                task["sources"] = merged
