# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run host's unit tests: the seq-stamped buffer, the subscribe /
fan-out / reattach arithmetic, the detach grace's wrap directive and the
control box's stop -- the run/reader decoupling's mechanical core."""

import json
import threading
import time
import unittest

from searx.zjsearch.ai.runs import host as run_host


class RunHandleTest(unittest.TestCase):
    """The handle's buffer, subscription and control arithmetic."""

    def test_publish_seqs(self):
        handle = run_host.RunHandle("k1")
        first = handle.publish({"e": "phase", "name": "plan"})
        second = handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
        self.assertEqual(json.loads(first)["seq"], 1)
        self.assertEqual(json.loads(second)["seq"], 2)

    def test_subscribe_fanout(self):
        handle = run_host.RunHandle("k2")
        for number in range(3):
            handle.publish({"e": "think", "id": 1, "t": str(number)})
        sub = handle.subscribe(0)
        self.assertEqual(len(sub.backlog), 3)
        handle.publish({"e": "say", "id": 1, "t": "live"})
        live = handle.pull(sub, 1.0)
        self.assertEqual([json.loads(line)["t"] for line in live], ["live"])

    def test_reattach_tail(self):
        handle = run_host.RunHandle("k3")
        for number in range(5):
            handle.publish({"e": "think", "id": 1, "t": str(number)})
        sub = handle.subscribe(3)
        self.assertEqual([json.loads(line)["seq"] for line in sub.backlog], [4, 5])
        # an overlap guard downstream dedupes by seq; the backlog itself
        # never repeats a line the subscriber already saw
        self.assertEqual(json.loads(sub.backlog[0])["t"], "3")

    def test_settle_keeps_tail(self):
        handle = run_host.RunHandle("k4")
        handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
        handle.publish({"e": "settle", "status": "done"})
        handle.publish({"e": "related", "items": ["q1"]})
        self.assertTrue(handle.settled)
        sub = handle.subscribe(0)
        self.assertEqual(json.loads(sub.backlog[-1])["e"], "related")

    def test_detach_grace(self):
        handle = run_host.RunHandle("k5", grace_seconds=0.05)
        handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
        sub = handle.subscribe(0)
        self.assertFalse(handle.grace_expired())
        handle.unsubscribe(sub)
        self.assertIsNotNone(handle._detached_at)  # pylint: disable=protected-access
        time.sleep(0.08)
        self.assertTrue(handle.grace_expired())
        self.assertEqual(handle.directives(), [{"action": "wrap"}])

    def test_attach_resets_grace(self):
        handle = run_host.RunHandle("k6", grace_seconds=0.05)
        sub = handle.subscribe(0)
        handle.unsubscribe(sub)
        time.sleep(0.08)
        # a returning subscriber resets the grace: the run is watched again
        handle.subscribe(0)
        self.assertFalse(handle.grace_expired())

    def test_stop_over_wrap(self):
        handle = run_host.RunHandle("k7", grace_seconds=0.0)
        handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
        sub = handle.subscribe(0)
        handle.unsubscribe(sub)
        time.sleep(0.02)
        handle.control.stop()
        self.assertEqual(handle.directives(), [{"action": "stop"}])

    def test_stream_full(self):
        handle = run_host.RunHandle("k8")

        def drive():
            handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
            handle.publish({"e": "settle", "status": "done"})
            handle.publish({"e": "related", "items": ["q1"]})
            handle.finish()

        lines: list[str] = []

        def consume():
            lines.extend(handle.stream(0))

        consumer = threading.Thread(target=consume)
        consumer.start()
        drive()
        consumer.join(timeout=5.0)
        self.assertFalse(consumer.is_alive())
        kinds = [json.loads(line)["e"] for line in lines]
        self.assertEqual(kinds, ["open", "settle", "related"])

    def test_finished_drains(self):
        handle = run_host.RunHandle("k9")
        handle.publish({"e": "open", "id": 1, "kind": "research", "round": 1})
        handle.finish()
        self.assertEqual([json.loads(line)["e"] for line in handle.stream(0)], ["open"])

    def test_terminal_ttl_sweep(self):
        handle = run_host.RunHandle("k10")
        run_host._HOSTS[handle.key] = handle  # pylint: disable=protected-access
        handle.publish({"e": "settle", "status": "done"})
        handle.finish()
        self.assertIsNotNone(run_host.get(handle.key))
        # force the age: a finished+settled handle past the TTL is swept
        with handle._lock:  # pylint: disable=protected-access
            handle._settled_at -= run_host.TERMINAL_TTL + 1.0  # pylint: disable=protected-access
        run_host.sweep()
        self.assertIsNone(run_host.get(handle.key))


class ControlBoxTest(unittest.TestCase):
    """The R2 control plane: the steer lane, the preempt slot, the
    interrupt priority and the handle's boundary directives."""

    def test_steer_fifo_and_cap(self):
        box = run_host.ControlBox()
        for number in range(run_host.MAX_PENDING_STEERS):
            self.assertTrue(box.steer(f"m{number}"))
        self.assertFalse(box.steer("overflow"))
        self.assertEqual(box.poll_steer(), "m0")
        # a drain frees a slot
        self.assertTrue(box.steer("m3"))

    def test_interrupt_priority(self):
        box = run_host.ControlBox()
        box.steer("steered course", preempt=True)
        # the preempt slot is a ONE-SHOT interrupt
        self.assertEqual(box.interrupt(), ("preempt", "steered course"))
        self.assertIsNone(box.interrupt())
        box.steer("second course", preempt=True)
        box.stop()
        # STOP is sticky and outranks everything -- once set, the preempt
        # slot can never surface again (the run is ending regardless)
        self.assertEqual(box.interrupt(), ("stop", ""))
        self.assertEqual(box.interrupt(), ("stop", ""))

    def test_drain_steers(self):
        box = run_host.ControlBox()
        box.steer("a")
        box.steer("b")
        self.assertEqual(box.drain_steers(), ["a", "b"])
        self.assertIsNone(box.poll_steer())

    def test_handle_directives(self):
        handle = run_host.RunHandle("kw")
        handle.wrap()
        handle.control.steer("focus domestic")
        directives = handle.directives()
        self.assertIn({"action": "wrap"}, directives)
        self.assertIn({"action": "steer", "text": "focus domestic"}, directives)
        # the steer drains ONCE
        self.assertEqual(handle.directives(), [{"action": "wrap"}])


class RegisterTest(unittest.TestCase):
    """The registry's mint-and-fetch pair."""

    def test_register_fetchable(self):
        handle = run_host.register()
        try:
            self.assertIsNotNone(run_host.get(handle.key))
            self.assertTrue(handle.key)
        finally:
            run_host._HOSTS.pop(handle.key, None)  # pylint: disable=protected-access


if __name__ == "__main__":
    unittest.main()
