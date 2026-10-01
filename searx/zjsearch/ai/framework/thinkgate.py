# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The reasoning/content channel state machine."""


class ThinkGate:
    """The ``<think>`` block state machine shared by every wire adapter."""

    def __init__(self) -> None:
        self.opened = False
        self.closed = False

    def reasoning(self) -> str:
        """Feed a reasoning delta: ``"open"`` when it opens the block,
        ``"relay"`` while it streams, ``"drop"`` for stray reasoning after
        content (the answer started; late thoughts are not prose)."""
        if self.closed:
            return "drop"
        if not self.opened:
            self.opened = True
            return "open"
        return "relay"

    def content(self) -> None:
        """Feed a content delta: the think block closes for good."""
        self.closed = True
