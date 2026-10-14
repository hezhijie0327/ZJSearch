# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run journal: the run host's DURABLE SHADOW.

The host's line buffer is process memory -- a deploy, a crash or the
one-hour terminal TTL each take the true ending with them, and a client
that reconnects too late falls back to a findings-handoff restart.  The
journal is the answer to "the run settled while nobody was attached":
every published wire line lands in a local SQLite table (keyed by the
run key, ordered by seq), so the late collector can fetch the exact
attach backlog -- the settle, the report, the sources -- hours later,
across restarts.

Write path: :py:meth:`searx.zjsearch.ai.runs.host.RunHandle.publish`
calls the wired ``append`` outside its lock, one row per event (the
driver thread is the only writer for a run).  Read path: the
``/zjsearch/ai/run/journal`` route replays ``seq > after_seq`` as NDJSON
-- the SAME wire format the attach endpoint serves, consumed by the
client's existing fold.  Rows expire (``JOURNAL_TTL``); a run whose
journal is gone is back to the storage question it always was.

Pure stdlib threading + one SQLiteAppl instance -- no flask, no loop.
"""

import logging
import os
import sqlite3
import tempfile
import threading
import time

from searx.sqlitedb import SQLiteAppl

logger = logging.getLogger(__name__)

JOURNAL_TTL = 60 * 60 * 72
"""How long a settled run's journal stays fetchable (72 hours) -- the
late collector's window beyond the host's one-hour terminal TTL."""

MAX_LINES_PER_RUN = 20_000
"""Per-run row cap: a pathological run must not turn the journal into an
unbounded log.  Beyond the cap the appends no-op (the host's in-memory
buffer still serves live reattach)."""

_MAX_RUNS = 512
"""Companion sweep bound: runs older than the newest ``_MAX_RUNS`` are
dropped with their rows regardless of age (an abandoned run's key never
comes back once its TTL lapses -- old keys are dead weight)."""


class RunJournal(SQLiteAppl):
    """The journal table: one wire line per row, (key, seq) primary."""

    DB_SCHEMA = 1

    DDL_CREATE_TABLES = {
        "run_journal": """\
CREATE TABLE IF NOT EXISTS run_journal (
  key      TEXT,
  seq      INTEGER,
  line     TEXT,
  created  INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (key, seq))""",  # fmt: skip
    }

    SQL_APPEND = "INSERT OR IGNORE INTO run_journal (key, seq, line) VALUES (?, ?, ?)"
    SQL_TAIL = "SELECT line FROM run_journal WHERE key = ? AND seq > ? ORDER BY seq"
    SQL_DROP = "DELETE FROM run_journal WHERE key = ?"
    SQL_SWEEP_AGE = "DELETE FROM run_journal WHERE created < ?"
    SQL_SWEEP_RANK = """\
DELETE FROM run_journal WHERE key IN (
  SELECT key FROM run_journal GROUP BY key ORDER BY max(seq) DESC LIMIT -1 OFFSET ?)"""

    def __init__(self) -> None:
        super().__init__(tempfile.gettempdir() + os.sep + "sxng_zjs_run_journal.db")
        self._lock = threading.Lock()

    def append(self, key: str, seq: int, line: str) -> None:
        with self._lock, self.DB as conn:
            conn.execute(self.SQL_APPEND, (key, seq, line))

    def tail(self, key: str, after_seq: int) -> list[str]:
        with self._lock:
            rows = self.DB.execute(self.SQL_TAIL, (key, after_seq)).fetchall()
        return [str(row[0]) for row in rows]

    def drop(self, key: str) -> None:
        with self._lock, self.DB as conn:
            conn.execute(self.SQL_DROP, (key,))

    def sweep(self) -> None:
        """The TTL + rank sweep: rows past ``JOURNAL_TTL`` go, and beyond
        the newest ``_MAX_RUNS`` runs everything goes too.  Piggybacks on
        the first append of a process (runs are infrequent; no timer)."""
        with self._lock, self.DB as conn:
            with conn:
                conn.execute(self.SQL_SWEEP_AGE, (int(time.time()) - JOURNAL_TTL,))
                conn.execute(self.SQL_SWEEP_RANK, (_MAX_RUNS,))
            leftover = conn.execute("SELECT count(*) FROM run_journal").fetchone()
        logger.debug("zjsearch run journal: swept, %s rows remain", leftover[0] if leftover else "?")


_JOURNAL: RunJournal | None = None
_JOURNAL_LOCK = threading.Lock()
_SWEPT = False


def journal() -> RunJournal:
    """The process-wide journal (lazy -- SQLiteAppl connects on first
    use).  The FIRST caller also sweeps the stale rows: one sweep per
    process is all the TTL enforcement a personal deployment needs."""
    global _JOURNAL, _SWEPT
    with _JOURNAL_LOCK:
        if _JOURNAL is None:
            _JOURNAL = RunJournal()
        if not _SWEPT:
            _SWEPT = True
            try:
                _JOURNAL.sweep()
            except sqlite3.Error:
                logger.warning("zjsearch run journal: initial sweep failed", exc_info=True)
        return _JOURNAL
