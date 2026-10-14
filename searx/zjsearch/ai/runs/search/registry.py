# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The run's source registries: the global [n] numbering, the two dedup
sets and the gallery whitelist.

One object per run -- every ``web_search`` / ``web_reader`` result and
every repeat of a known url passes through here, so the numbering stays
contiguous, exact repeats settle as ``duplicate`` without hitting the
engines again, and the writer's ``zjs-images`` fence can only cite urls
the model actually saw.
"""

import threading

_GALLERY_POOL_MAX = 40
"""Image URLs the writer may embed (the validated whitelist of the
``zjs-images`` fence): image-bearing results enter the pool as they are
fed, first come first kept."""


_FED_VECTORS_MAX = 64
"""Stored embeddings of the sources ALREADY FED -- the cross-search dup
gate compares each new candidate against these (the oldest fall off; a
run's feed window never reaches this many)."""


class SourcesRegistry:
    """[n] numbering + query/page dedup + the gallery whitelist + the fed
    sources' embedding memory (the cross-search dup gate).

    Thread-safe BY LOCK: parallel subagents (v2.1 R3) share ONE registry
    -- every mutation takes the lock, so the [n] numbering stays
    contiguous and the dedup sets stay consistent across workers."""

    def __init__(self, sources_base: int = 0) -> None:
        self._lock = threading.Lock()
        # follow-up runs continue the global [n] numbering after the base
        self.next_n = sources_base + 1
        # every query this run already executed, normalized -> [query, n
        # results] -- a repeated query settles as ``duplicate`` without
        # hitting the engines
        self.ran: dict[str, list] = {}
        # every page this run already opened (normalized) -- a re-read
        # settles as ``duplicate`` without rendering again
        self.read_urls: set[str] = set()
        # every source url of this run -> its global [n]: a re-read or a
        # repeat of a known url reuses the number instead of minting a
        # duplicate source (the FEED dedup rides the same registry)
        self.url_n: dict[str, int] = {}
        # the url's feed metadata (title + snippet head) -- the read
        # gate's judgment material (what the model knows about the page
        # BEFORE spending the reader round trip)
        self.url_meta: dict[str, dict[str, str]] = {}
        # image urls fed to the model (img=... lines) -> their global [n]:
        # the validated whitelist of the writer's ``zjs-images`` fence
        self.gallery_pool: dict[str, int] = {}
        # (global [n], embedding) of every source whose line entered the
        # feed -- the cross-search semantic dup gate's comparison set
        # (reused diverse_order vectors; zero extra embed calls)
        self.fed_vectors: list[tuple[int, list[float]]] = []

    def mint(self) -> int:
        """The next global [n]."""
        with self._lock:
            n = self.next_n
            self.next_n += 1
            return n

    def known(self, norm_url: str) -> int | None:
        """The [n] a normalized url already holds, or ``None``."""
        if not norm_url:
            return None
        with self._lock:
            return self.url_n.get(norm_url)

    def note_url(self, norm_url: str, n: int) -> None:  # pylint: disable=invalid-name
        if norm_url:
            with self._lock:
                self.url_n[norm_url] = n

    def note_gallery(self, img: str, n: int) -> None:  # pylint: disable=invalid-name
        """An image url joins the whitelist under its [n] (first come
        first kept -- the pool is capped)."""
        if not img:
            return
        with self._lock:
            if len(self.gallery_pool) < _GALLERY_POOL_MAX:
                self.gallery_pool.setdefault(img, n)

    def note_meta(self, norm_url: str, title: str, snippet: str) -> None:
        if norm_url:
            with self._lock:
                self.url_meta.setdefault(norm_url, {"title": title[:300], "snippet": snippet[:400]})

    def note_vector(self, n: int, vector: list[float]) -> None:  # pylint: disable=invalid-name
        """A fed source's embedding joins the dup gate's comparison set
        (LRU-capped -- the oldest fall off, the feed window never gets
        that long)."""
        with self._lock:
            self.fed_vectors.append((n, vector))
            if len(self.fed_vectors) > _FED_VECTORS_MAX:
                del self.fed_vectors[: len(self.fed_vectors) - _FED_VECTORS_MAX]

    def note_query(self, dedup_key: str, query: str) -> None:
        with self._lock:
            self.ran[dedup_key] = [query, 0]

    def note_read(self, url: str) -> None:
        with self._lock:
            self.read_urls.add(url)
