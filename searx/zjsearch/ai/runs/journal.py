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

_DB_NAME = "sxng_zjs_run_journal.db"
"""The journal file in the temp dir; rebuild generation ``N > 0`` lives at
the ``.N``-suffixed sibling (see ``_open_or_rebuild``)."""

_GEN = 0
"""The journal file's generation: bumped by every stale-schema rebuild."""


def _db_path(gen: int) -> str:
    name = _DB_NAME if gen == 0 else _DB_NAME.replace(".db", f".{gen}.db")
    return tempfile.gettempdir() + os.sep + name


class RunJournal(SQLiteAppl):
    """The journal table: one wire line per row, (key, seq) primary."""

    DB_SCHEMA = 2

    DDL_CREATE_TABLES = {
        "run_journal": """\
CREATE TABLE IF NOT EXISTS run_journal (
  key      TEXT,
  seq      INTEGER,
  line     TEXT,
  created  INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (key, seq))""",  # fmt: skip
        "run_index": """CREATE TABLE IF NOT EXISTS run_index (
  thread_id TEXT,
  run_key   TEXT,
  q         TEXT,
  mode      TEXT,
  created   INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (run_key))""",  # fmt: skip
    }

    SQL_INDEX = """INSERT INTO run_index (thread_id, run_key, q, mode) VALUES (?, ?, ?, ?)
ON CONFLICT (run_key) DO UPDATE SET q = excluded.q, mode = excluded.mode"""
    SQL_LATEST_FOR_THREAD = """SELECT run_key, q, mode FROM run_index WHERE thread_id = ? ORDER BY created DESC, rowid DESC LIMIT 1"""
    SQL_APPEND = "INSERT OR IGNORE INTO run_journal (key, seq, line) VALUES (?, ?, ?)"
    SQL_TAIL = "SELECT line FROM run_journal WHERE key = ? AND seq > ? ORDER BY seq"
    SQL_DROP = "DELETE FROM run_journal WHERE key = ?"
    SQL_SWEEP_AGE = "DELETE FROM run_journal WHERE created < ?"
    SQL_SWEEP_RANK = """\
DELETE FROM run_journal WHERE key IN (
  SELECT key FROM run_journal GROUP BY key ORDER BY max(seq) DESC LIMIT -1 OFFSET ?)"""

    def __init__(self) -> None:
        super().__init__(_db_path(_GEN))
        self._lock = threading.Lock()

    def index_run(self, thread_id: str, run_key: str, q: str, mode: str) -> None:
        """Match a run to its thread uuid (the reload matcher): called
        once per run at handle registration."""
        with self._lock, self.DB as conn:
            conn.execute(self.SQL_INDEX, (thread_id[:64], run_key, q[:300], mode[:16]))

    def latest_for_thread(self, thread_id: str) -> tuple[str, str, str] | None:
        """The thread's newest journaled run: ``(run_key, q, mode)``, or
        ``None`` when this thread has no journaled run."""
        with self._lock:
            row = self.DB.execute(self.SQL_LATEST_FOR_THREAD, (thread_id[:64],)).fetchone()
        return (str(row[0]), str(row[1]), str(row[2])) if row else None

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


def _unlink_db(path: str) -> None:
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(path + suffix)
        except OSError:
            pass


def _open_or_rebuild() -> RunJournal:
    """Open the journal; a pre-bump schema file (SQLiteAppl raises on the
    version mismatch) is deleted and the journal REOPENS AT THE NEXT
    GENERATION -- the journal is a durable SHADOW (the source of truth
    lives in the client's store), so losing the old rows beats wedging
    every run registration on a stale file.  The GENERATION MOVE (not a
    same-path delete) is load-bearing: SQLiteAppl hands out THREAD-LOCAL
    connections cached by db url, so after the delete every thread that
    already touched the journal holds a live session on the ORPHANED
    inode -- a rebuilt instance on the same path would answer through
    exactly such a session (stale properties re-read, ``init`` poisoned
    by its set-first-then-verify flag, ``no such table: run_index``
    forever).  A new path forces every thread to reconnect; the fresh
    file's first connect creates the full schema."""
    global _GEN
    candidate = RunJournal()
    try:
        candidate.DB.execute("SELECT 1 FROM run_index LIMIT 1").fetchone()
        return candidate
    except sqlite3.DatabaseError:
        logger.warning("zjsearch run journal: stale schema -- rebuilding at generation %s", _GEN + 1)
        _unlink_db(_db_path(_GEN))
        _GEN += 1
        return RunJournal()


def journal() -> RunJournal:
    """The process-wide journal (lazy -- SQLiteAppl connects on first
    use).  The FIRST caller also sweeps the stale rows: one sweep per
    process is all the TTL enforcement a personal deployment needs."""
    global _JOURNAL, _SWEPT
    with _JOURNAL_LOCK:
        if _JOURNAL is None:
            _JOURNAL = _open_or_rebuild()
        if not _SWEPT:
            _SWEPT = True
            try:
                _JOURNAL.sweep()
            except sqlite3.Error:
                logger.warning("zjsearch run journal: initial sweep failed", exc_info=True)
        return _JOURNAL
