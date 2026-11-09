# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The CONTINUE replay contract's unit tests: the ``ctx`` wire event (the
closed set admits it), :py:func:`search_route.parse_resume` (validation,
thinking-strip, size budget, sources filter) and the loop's resume seeds
(``_Run.entry_base`` + :py:func:`loop._ctx_snapshot`)."""

import unittest

from searx.zjsearch.ai.agent import loop as engine_loop
from searx.zjsearch.ai.agent import wire
from searx.zjsearch.ai.api.search_route import RESUME_NOTE, parse_resume


class WireCtxTest(unittest.TestCase):
    """The storage-only checkpoint is a first-class wire event."""

    def test_ctx_encodes(self):
        line = wire.encode({"e": "ctx", "round": 3, "messages": [{"role": "user", "content": "q"}]})
        self.assertIn('"ctx"', line)

    def test_unknown_kind_still_refused(self):
        with self.assertRaises(ValueError):
            wire.encode({"e": "ctxx", "round": 1, "messages": []})


class ParseResumeTest(unittest.TestCase):
    """The replay payload's validation contract -- ``None`` always means
    silent fresh-conversation fallback, never a 4xx."""

    def test_round_trip_strips_thinking(self):
        raw = {
            "messages": [
                {"role": "user", "content": "q"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "secret", "signature": "sig"},
                        {"type": "text", "text": "narration"},
                    ],
                    "tool_calls": [{"name": "web_search"}],
                },
                {"role": "tool", "content": "results"},
            ],
            "sources": [{"n": 1, "url": "https://example.com/a", "title": "A"}],
            "entry_base": 7,
            "round_base": 3,
        }
        resume = parse_resume(raw, sources_base=10)
        self.assertIsNotNone(resume)
        assistant = resume["messages"][1]
        self.assertEqual([b["type"] for b in assistant["content"]], ["text"])
        # everything but the thinking block survives verbatim
        self.assertEqual(assistant["tool_calls"], [{"name": "web_search"}])
        self.assertEqual(resume["sources"], [{"n": 1, "url": "https://example.com/a", "title": "A"}])
        self.assertEqual(resume["entry_base"], 7)
        self.assertEqual(resume["round_base"], 3)

    def test_absent_and_malformed_fall_back(self):
        self.assertIsNone(parse_resume(None, 10))
        self.assertIsNone(parse_resume({}, 10))
        self.assertIsNone(parse_resume({"messages": []}, 10))
        self.assertIsNone(parse_resume({"messages": ["not a dict"]}, 10))
        self.assertIsNone(parse_resume({"messages": [{"content": "roleless"}]}, 10))

    def test_size_budget_rejects(self):
        big = {"role": "user", "content": "x" * 2_100_000}
        self.assertIsNone(parse_resume({"messages": [big]}, 10))

    def test_sources_filtered_against_base(self):
        raw = {
            "messages": [{"role": "user", "content": "q"}],
            "sources": [
                {"n": 2, "url": "https://example.com/in", "title": "in"},
                {"n": 99, "url": "https://example.com/over", "title": "over the base"},
                {"n": 0, "url": "https://example.com/zero", "title": "zero"},
                {"n": 3, "url": "", "title": "urlless"},
            ],
        }
        resume = parse_resume(raw, sources_base=10)
        self.assertEqual([item["n"] for item in resume["sources"]], [2])

    def test_note_is_model_facing_prose(self):
        # the researcher never sees machine keys: the note is sentences,
        # and the only identifiers inside are real tool names
        self.assertIn("Continue it where it stands", RESUME_NOTE)
        self.assertIn("task_write", RESUME_NOTE)
        self.assertIn("learnings", RESUME_NOTE)


class LoopSeedTest(unittest.TestCase):
    """A continued run continues the dead attempt's id spaces."""

    def test_entry_base_seeds_counter(self):
        run_state = engine_loop._Run({}, 1.0, 1.0, entry_base=41)  # noqa: SLF001
        self.assertEqual(run_state.next_entry(), 42)

    def test_ctx_snapshot_is_frozen_copy(self):
        messages = [{"role": "user", "content": "q"}]
        event = engine_loop._ctx_snapshot(messages, 4)  # noqa: SLF001
        self.assertEqual(event["e"], "ctx")
        self.assertEqual(event["round"], 4)
        # the loop keeps mutating its list -- the snapshot must not move
        messages.append({"role": "assistant", "content": "later"})
        self.assertEqual(len(event["messages"]), 1)


if __name__ == "__main__":
    unittest.main()
