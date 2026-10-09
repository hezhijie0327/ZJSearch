# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The report synthesizer's closure contract: every nested helper resolves
its names at CALL time.  The first real report died with NameError
(``gap_text`` lived one scope too deep -- a synthesizer-local read by the
sibling ``stream`` closure); this smoke test runs the whole synthesis
over a fake transport so the closure family can never regress silently."""

import types
import unittest
from unittest.mock import patch

from searx.zjsearch.ai.runs.report import synth


class _FakeStream:
    """A transport that produces nothing: every section degrades to the
    gap note (the exact path the NameError fired on)."""

    def __init__(self, *_args, **_kwargs):
        pass

    def next_event(self, _wait):
        return "end", None

    def cancel(self):
        pass


class SynthesizerClosureTest(unittest.TestCase):
    def test_sections_stream_without_nameerror(self):
        outline = {
            "title": "T",
            "subtitle": "",
            "sections": [
                {"id": "s1", "title": "A", "brief": "b", "key_questions": [], "status": "pending"},
                {"id": "s2", "title": "B", "brief": "c", "key_questions": [], "status": "pending"},
            ],
        }
        state = types.SimpleNamespace(
            corpus=types.SimpleNamespace(pack=lambda query, **kwargs: []),
            artifacts={},
            entries={},
            judgments=[],
        )
        synthesizer = synth.make_synthesizer({}, state, outline, "q", "zh-CN", [])
        events = []
        with patch.object(synth, "LlmStream", _FakeStream):
            tally = types.SimpleNamespace(
                phase="research",
                absorb=lambda payload: {},
                settle_kwargs=lambda: {"usage": None, "finish": None, "model": None},
            )
            events = list(synthesizer(tally))
        kinds = [event["e"] for event in events]
        self.assertEqual(kinds[0], "outline")
        self.assertEqual(kinds[-1], "settle")
        self.assertEqual(kinds[-1] and events[-1]["status"], "done")
        section_ids = {event["id"] for event in events if event["e"] == "section"}
        self.assertEqual(section_ids, {"s1", "s2", "summary"})
        # every degraded section carries the run-language gap note
        gap_notes = [event for event in events if event["e"] == "section" and "本节生成失败" in str(event.get("t"))]
        self.assertGreaterEqual(len(gap_notes), 2)
        # the citation gate's judgment sink stayed untouched (decision off)
        self.assertEqual(state.judgments, [])


if __name__ == "__main__":
    unittest.main()
