# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

"""The browser-tool dispatch family of the search run handler
(_browser_*): one mixin of the DispatchMixin composition."""

# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""AI Search executor: the TOOL DISPATCH.

:class:`DispatchMixin` owns :py:meth:`execute` -- one round of model
calls turned into tool executions and wire events -- plus the per-call
plan builder (``_search_plan``: the dedup key, the pool job and the
receipt scaffolding) and the decision-model verdict formatting.  Meta
tools (calculate, ledger writes, MCP, memory) run INLINE; the network
jobs (``search_web``) defer to :py:mod:`.gather`'s pool -- the browse
tool is the serialized session lane (open -> read, tabs, viewport)."""

import logging
import typing as t
import time
from urllib.parse import urlsplit
from searx.zjsearch.ai.tools import browse as browse_tool
from searx.zjsearch.ai.tools.browse import read as reader

logger = logging.getLogger(__name__)




_MAX_MODEL_SHOTS = 8
"""The per-run budget for browser screenshots injected into the model's
conversation (viewport + element close-ups share it) -- a captcha retry
loop must not turn the context into an image carousel."""


class BrowserDispatchMixin:
    """The per-tool execution branches and the round's job planning
    (the composed Searches state's members -- registry, ledger, feed --
    are inherent to the mixin pattern)."""

    def _browser_source(
        self,
        rnd: int,
        wire_id: int,
        url: str,
        title: str,
        crawled: bool,
        text: str,
    ) -> t.Iterator[tuple[str, t.Any]]:
        """The session's current page joins the [n] registry exactly like a
        ``browse`` settlement: a fresh url mints its number (the
        writer can cite what the model drove), a known one re-emits its
        [n] -- with ``crawled`` set when the page's full text was
        actually read (read action / the post-wait snapshot), which also
        feeds the corpus and the writer's compact [n] block.  Non-web
        pages (about:blank after a close/crash) mint
        nothing -- a junk source would also mute the stall detector.  The
        task card's coverage and the writer's entry index ride along like
        every reader settlement.  Yields the sources event; returns the
        cite line for the model's feed (the ``yield from`` expression's
        value, empty when nothing was minted)."""
        if not url.lower().startswith(("http://", "https://")):
            return ""
        norm = reader.normalize_url(url)
        known_n = self.reg.known(norm)
        if known_n is not None:
            n = known_n
            cite = f"already your source [{n}] -- cite it as [{n}]"
        else:
            n = self.reg.mint()
            self.reg.note_url(norm, n)
            cite = f"NEW source [{n}] -- cite it as [{n}]"
            self.round_new_hits += 1
        if text:
            self.corpus.add(text, ref_n=n, title=title[:160], url=url, kind="page")
            self.feed.append(f'Opened {url} (title: "{title}"; {cite}):\n\n{text}')
            self.feed_chars += len(text)
        self.entries[n] = {"title": title[:160], "snippet": (text or "")[:500]}
        if self.coverage.task_list:
            try:
                self.coverage.track(url, [title] if title else None, [n])
            except Exception as exc:  # pylint: disable=broad-except
                # coverage bookkeeping must never kill the settlement
                logger.warning(
                    "zjsearch_ask_search: browser source coverage tracking failed: %r",
                    exc,
                )
        netloc = urlsplit(url).netloc
        yield (
            "sources",
            {
                "items": [
                    {
                        "n": n,
                        "round": rnd,
                        "id": wire_id,
                        "idx": 0,
                        "agent": getattr(self, "agent_key", "lead"),
                        "title": title,
                        "url": url,
                        "netloc": netloc,
                        "favicon": "",
                        # the browser MINT: the client's source card shows
                        # the agent mark instead of the favicon-glyph
                        # fallback -- the reader sees this [n] was driven,
                        # not searched
                        "browser": True,
                        "pretty_url": url,
                        "published_date": "",
                        "crawled": crawled,
                    }
                ]
            },
        )
        return cite

    def _browser_wait(self, args, rnd, wire_id, settle) -> t.Iterator[tuple[str, t.Any]]:
        """The wait_user branch: the human's operation window -- the
        mirror frames stream while it blocks, then the post-window page
        is numbered (read-in-full when its text was extracted) so the
        writer can cite what the user's hands produced.  The window-end
        frame (no ``wait_left``) streams as a browser event: the mirror's
        countdown retires and the mobile wait bar stands down at the
        window's end, not at the next model action.  The settlement's
        ``text`` is the page's READABLE TEXT (the client archives it as
        the document); the composite feed (header + outline + text) stays
        the model's receipt.  Yields the wire events; returns whether the
        window gathered material."""
        for frame in browse_tool.wait_user_frames(int(args.get("seconds") or 180), self.browser_session_id):
            yield ("browser", frame)
        outcome = browse_tool.wait_user_snapshot(reader.max_chars(), self.browser_session_id)
        feed = str(outcome["feed"])
        # the window's own downloads join the post-window feed: a file the
        # USER saved during their operation window used to hold until the
        # NEXT mutating action spoke it
        for entry in browse_tool.drain_downloads(self.browser_session_id):
            state = str(entry.get("state") or "")
            name = str(entry.get("name") or "file")
            if state == "saved":
                feed += f"\ndownload saved: {name} -- read it with read + download=\"{name}\""
            else:
                feed += f"\ndownload {state}: {name} ({entry.get('reason', '')})"
        page = {"url": str(outcome["url"]), "title": str(outcome["title"])}
        text = str(outcome.get("text") or "")
        cite = ""
        if page["url"]:
            cite = yield from self._browser_source(rnd, wire_id, page["url"], page["title"], bool(text), text)
        if cite and text:
            feed += f"\n\n(the page is {cite})"
        extra: dict[str, t.Any] = {"page": page, "url": page["url"] if cite else ""}
        if cite and text:
            # the ARCHIVED document is the pure readable text -- the
            # outline header is feed material, not recall content
            extra["text"] = text
            extra["chars"] = len(text)
        frame = browse_tool.final_frame(self.browser_session_id)
        if frame:
            yield ("browser", frame)
            extra["img"] = f"data:image/jpeg;base64,{frame['img']}"
        yield settle("ok", feed, extra)
        return bool(text or cite)

    def _browser_finish(self, action, result, rnd, wire_id) -> t.Iterator[tuple[str, t.Any]]:
        """A completed action's settlement assembly: the last mirror frame
        becomes the row's volatile image, the fresh outline (open /
        snapshot / a click-through navigation) rides ``snapshot``/``n``,
        and the session page joins the source registry when the action
        put MATERIAL on the table (open mints its identity -- the outline
        is what the model saw; read registers the full text).  Yields the
        sources event; returns ``(feed, extra, gathered)``."""
        feed = result.feed
        extra: dict[str, t.Any] = {"page": result.page}
        if result.steps:
            # the multi batch's per-step summaries -- the timeline row's
            # step list renders DETAIL (url / chars), not bare first lines
            extra["steps"] = list(result.steps)
        if result.tabs:
            extra["tabs"] = list(result.tabs)
        if result.frames:
            extra["img"] = f"data:image/jpeg;base64,{result.frames[-1]['img']}"
        if result.snapshot is not None:
            extra["snapshot"] = result.snapshot
            extra["n"] = result.elements
        gathered = False
        cite = ""
        for entry in result.reads or ():
            # every read INSIDE a multi batch registers its OWN page --
            # crawled=True + corpus + writer feed (the batch's single
            # settlement covers only the last step; without this the
            # intermediate reads' texts never reach the writer and their
            # source cards never light the read badge).  A re-registered
            # known url rides the same [n] -- no duplicate numbering.
            url_e = str(entry.get("url") or "")
            text_e = str(entry.get("text") or "")
            if not url_e.lower().startswith(("http://", "https://")) or not text_e:
                continue
            entry_cite = yield from self._browser_source(
                rnd, wire_id, url_e, str(entry.get("title") or ""), True, text_e
            )
            gathered = gathered or bool(entry_cite)
        if result.snapshot is not None and result.page and result.page["url"]:
            # ANY action that landed a fresh outline registers the page --
            # the explicit open, the click-through navigation, the tab
            # strip's new/switch and a click-spawned popup alike: the
            # outline is the identity material, and an EXPLORED page must
            # be citable even when the model never ran an open on it (the
            # old open-only gate left click-explored sources invisible to
            # the writer)
            cite = yield from self._browser_source(rnd, wire_id, result.page["url"], result.page["title"], False, "")
            gathered = bool(cite)
            if cite:
                feed += f"\n\n(this page is {cite})"
                extra["url"] = result.page["url"]
        elif action == "read" and result.page and result.page["url"]:
            # the multi-index read's last section rides last_read (its
            # clean text) -- splitting the multi-section feed at the first
            # blank line archived every PREVIOUS tab's body under this
            # tab's identity; the plain single read keeps the split
            text = str((result.last_read or {}).get("text") or "") or feed.split("\n\n", 1)[-1]
            cite = yield from self._browser_source(rnd, wire_id, result.page["url"], result.page["title"], True, text)
            gathered = bool(cite)
            if cite:
                feed = feed.replace("\n\n", f"\n\n({cite})\n\n", 1)
                extra["url"] = result.page["url"]
        if cite and action == "read":
            # the reading pane + the client's document archive ride the
            # settlement only when the page actually JOINED the registry --
            # an error feed as `text` would archive junk under an empty
            # url; the ARCHIVED text is the clean content (title + body),
            # the cite line stays the feed's alone
            clean = f"{result.page['title']}\n\n{text}"
            extra["text"] = clean
            extra["chars"] = len(clean)
        elif action == "read":
            # a CAPTURED download's read: the text has no page url (the
            # origin page is the citable source) -- the reading pane still
            # renders it, nothing is archived
            body = feed.split("\n\n", 1)[-1]
            extra["text"] = body
            extra["chars"] = len(body)
        return feed, extra, gathered

    def _site_note(self, url: str, kind: str) -> dict[str, t.Any] | None:
        """The saved SITE note (host-bound memory row) this url answers
        to -- host match with the www prefix folded, a suffix relation
        covers subdomains; ``kind`` picks the lane (procedure = site
        recipe for the browse lane, fact = source note)."""
        try:
            host = urlsplit(url).netloc.lower().removeprefix("www.")
        except (ValueError, AttributeError):
            return None
        if not host:
            return None
        for row in self.site_notes:
            row_host = str(row.get("host") or "").lower().removeprefix("www.")
            if (
                row_host
                and row.get("kind") == kind
                and (row_host == host or host.endswith("." + row_host) or row_host.endswith("." + host))
            ):
                return row
        return None

    def _source_notes_feed(self, items: list[dict[str, t.Any]]) -> str:
        """The matched SOURCE NOTES for one search's result set -- one
        line per note, once per run per note (the search lane's half of
        the host-bound replay; the browse lane's recipe note is the
        other half)."""
        seen: dict[str, str] = {}
        for item in items:
            url = str(item.get("url") or "")
            try:
                host = urlsplit(url).netloc.lower().removeprefix("www.")
            except (ValueError, AttributeError):
                continue
            if not host:
                continue
            for row in self.site_notes:
                row_id = str(row.get("id") or "")
                row_host = str(row.get("host") or "").lower().removeprefix("www.")
                if (
                    not row_host
                    or row_id in self.notes_used
                    or row.get("kind") != "fact"
                    or not (row_host == host or host.endswith("." + row_host) or row_host.endswith("." + host))
                ):
                    continue
                seen.setdefault(row_id, f"{row_host}: {str(row.get('content') or '')[:200]}")
        if not seen:
            return ""
        self.notes_used.update(seen)
        lines = "\n".join(f"- {text}" for text in seen.values())
        return "YOUR SOURCE NOTES (durable judgments you saved about these sources):\n" + lines + "\n"

    def _browser_call(self, call, wire_id, feeds):
        """The interactive browser session: ONE action per call, inline
        (the session is a serialized lane -- no parallel pool).  The
        wait_user window streams mirror frames as wire events while it
        blocks; the screenshot action rides the image-injection channel
        (the model sees it next turn) and every settlement carries the
        action's page state + a volatile frame image so the timeline row
        renders WHAT HAPPENED (the mirror card is the live view, the row
        is the record).  Returns True when the action gathered material
        (a page opened or read) -- the round's progress machinery counts
        the session lane like the pooled jobs."""
        started = time.monotonic()
        rnd = self.round_no
        args = browse_tool.parse_browse_call(call)
        action = str(args.get("action") or "")

        def settle(status: str, feed: str, extra: dict | None = None):
            feeds[wire_id - 1] = feed
            payload = {
                "call": wire_id,
                "status": status,
                "ms": int((time.monotonic() - started) * 1000),
                "feed": feed[:800],
                "raw": feed[:50_000],
            }
            if extra:
                payload.update(extra)
            return ("call", payload)

        if not action:
            yield settle("error", "error: the browse action is required")
            return False
        try:
            if action == "wait_user":
                return (yield from self._browser_wait(args, rnd, wire_id, settle))
            result = browse_tool.run_action(args, self.browser_session_id)
        except Exception as exc:  # pylint: disable=broad-except
            yield settle("error", f"error: {type(exc).__name__}: {str(exc)[:200]}")
            return False
        for frame in result.frames:
            if self.browser_session_id != "lead":
                frame = {**frame, "agent": self.browser_session_id}
            yield ("browser", frame)
        recipe = self._site_note(str((result.page or {}).get("url") or ""), "procedure")
        recipe_note = ""
        if recipe:
            recipe_id = str(recipe.get("id") or "")
            recipe_content = str(recipe.get("content") or "")
            if recipe_id and recipe_id not in self.notes_used:
                # one shot per row per run: the recipe rides the feed (the
                # conversation keeps it from here) and its USE reinforces
                # the stored row client-side
                self.notes_used.add(recipe_id)
                yield ("memory", {"op": "reinforce", "kind": "procedure", "id": recipe_id, "content": recipe_content})
                recipe_note = (
                    f"SAVED SITE RECIPE for {recipe.get('host')}: {recipe_content}"
                    " -- it worked before; follow it when it fits.\n\n"
                )
        if result.image:
            if self.model_shots >= _MAX_MODEL_SHOTS:
                yield settle(
                    "error",
                    "error: the per-run screenshot budget is spent -- the"
                    " images already captured are in the conversation;"
                    " work from what you have or move on.",
                )
                return False
            self.model_shots += 1
            aimed_ref = str(args.get("ref") or "")
            if aimed_ref:
                shot_note = f"""\
Attached: the close-up screenshot you requested of element {aimed_ref}
on the page you opened.  Read it now and decide your next action from
what is visible."""
            elif all(args.get(k) is not None for k in ("x", "y", "w", "h")):
                region_note = " ".join(str(args.get(k)) for k in ("x", "y", "w", "h"))
                shot_note = f"""\
Attached: the region crop you requested of the page you opened
(viewport rectangle {region_note}).  Read it now and decide your next
action from what is visible."""
            else:
                shot_note = 'Attached: the screenshot you requested of the page you opened.  Read it now and decide your next action from what is visible.'
            self.record_image_injection(
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": shot_note},
                        {"type": "image_url", "image_url": {"url": result.image}},
                    ],
                }
            )
            extra = {"img": result.image, "page": result.page, "shot": True}
            if result.steps:
                # a multi batch's step summaries must survive this early
                # exit too -- the attachment receipt replaced the numbered
                # feed lines, so without them the row's step list collapses
                # at the settle
                extra["steps"] = list(result.steps)
            yield settle("ok", "screenshot attached -- it is visible to you in the next turn.", extra)
            return False
        try:
            feed, extra, gathered = yield from self._browser_finish(action, result, rnd, wire_id)
        except Exception as exc:  # pylint: disable=broad-except
            # the settlement assembly (source minting, corpus, feed) failed:
            # the row degrades honestly instead of taking the round down
            # (a [n] may already be on the wire -- the sources card still renders)
            logger.warning("zjsearch_ask_search: browser settlement assembly failed: %r", exc)
            feed = f"error: the browse action ran but its settlement failed ({type(exc).__name__})"
            yield settle("error", feed)
            return False
        status = "error" if feed.startswith("error") else "ok"
        yield settle(status, recipe_note + feed if recipe_note and status == "ok" else feed, extra)
        return gathered
