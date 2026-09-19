# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Deterministic offline fixtures for the zjsearch Lighthouse gate
(``npm run audit``, see ``client/zjsearch/audit-settings.yml``).

Remote engines make performance and accessibility scores variance-sensitive:
engine timeouts, captchas and dead image URLs change the audited page from
run to run.  This engine answers instantly from a fixed table so the gate
measures the *theme*, not the network.

The kind of results is keyed by a token in the query so each gate URL
deterministically renders one presentation:

====================== =========================================
query token            presentation (layout.ts)
====================== =========================================
``zjaudit general``    general list + infobox rail + suggestions
``zjaudit images``     image masonry
``zjaudit videos``     video grid
``zjaudit music``      music grid
``zjaudit files``      torrent/file grid
``zjaudit science``    scholarly paper cards
``zjaudit it``         software package cards
``zjaudit apps``       application grid
====================== =========================================

Register it in ``settings.yml`` with::

  - name: zjaudit
    engine: zjsearch_fixtures
    shortcut: zja
    disabled: false

Implementations
===============

"""

import datetime
import typing as t

engine_type = "offline"
categories = ["general", "images", "videos", "music", "files", "science", "it", "apps"]
disabled = True
timeout = 2.0

about = {
    "wikidata_id": None,
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "JSON",
}

"""Small local image served by the instance itself — keeps the audited page
fully offline and its payload deterministic."""
FIXTURE_IMG = "/static/themes/zjsearch/img/512.png"

_DAYS = datetime.timedelta(days=1)
_PUBLISHED = datetime.datetime.now() - 30 * _DAYS  # noqa: DTZ005 (audit-only)


def _general() -> list[dict[str, t.Any]]:
    results: list[dict[str, t.Any]] = [
        {
            "infobox": "zjsearch audit",
            "id": "https://example.com/zjsearch-audit",
            "title": "ZJSearch audit fixture",
            "content": "Deterministic infobox rendered by the offline fixture engine.",
            "img_src": FIXTURE_IMG,
            "urls": [{"title": "Fixture source", "url": "https://example.com/zjsearch-audit"}],
        }
    ]
    for index in range(1, 13):
        results.append(
            {
                "title": f"Audit fixture result #{index} — deterministic title for the general list",
                "url": f"https://example.com/zjaudit/general/{index}",
                "content": (
                    f"Fixture snippet #{index}: offline text so the Lighthouse gate audits the "
                    "theme instead of a remote engine. Length varies a little to exercise wrapping."
                ),
                "publishedDate": _PUBLISHED - index * _DAYS,
            }
        )
    return results


def _images() -> list[dict[str, t.Any]]:
    return [
        {
            "template": "images.html",
            "title": f"Audit fixture image #{index}",
            "url": f"https://example.com/zjaudit/images/{index}",
            "img_src": FIXTURE_IMG,
            "thumbnail_src": FIXTURE_IMG,
            "content": f"Offline fixture image #{index} for the masonry grid.",
            "resolution": f"{800 + index * 10} x {600 + index * 8}",
            "img_format": "jpeg",
            "filesize": f"{index}.2 MB",
            "source": "example.com",
            "formats": [
                {"url": f"https://example.com/zjaudit/images/{index}?size=large", "label": "Large"},
                {"url": f"https://example.com/zjaudit/images/{index}?size=thumbnail", "label": "Thumbnail"},
            ],
        }
        for index in range(1, 31)
    ]


def _videos() -> list[dict[str, t.Any]]:
    return [
        {
            "title": f"Audit fixture video #{index}",
            "url": f"https://example.com/zjaudit/videos/{index}",
            "content": f"Offline fixture video #{index} for the video grid.",
            "img_src": FIXTURE_IMG,
            "length": 60 * index % 3600,
        }
        for index in range(1, 13)
    ]


def _music() -> list[dict[str, t.Any]]:
    return [
        {
            "title": f"Audit fixture track #{index}",
            "url": f"https://example.com/zjaudit/music/{index}",
            "content": f"Offline fixture track #{index} for the music grid.",
            "thumbnail": FIXTURE_IMG,
            "img_src": FIXTURE_IMG,
            "author": f"Fixture artist {index}",
        }
        for index in range(1, 9)
    ]


def _files() -> list[dict[str, t.Any]]:
    return [
        {
            "template": "torrents.html",
            "title": f"Audit fixture file #{index}",
            "url": f"https://example.com/zjaudit/files/{index}",
            "content": f"Offline fixture file #{index} for the torrent grid.",
            "magnetlink": f"magnet:?xt=urn:sha1:zjaudit{index}",
            "filesize": f"{index}.5 MB",
            "seeds": 8 + index,
            "leeches": index,
        }
        for index in range(1, 9)
    ]


def _science() -> list[dict[str, t.Any]]:
    return [
        {
            "template": "paper.html",
            "title": f"Audit fixture paper #{index}",
            "url": f"https://example.com/zjaudit/science/{index}",
            "content": f"Offline fixture paper #{index} for the scholarly card list.",
            "authors": [f"Fixture Author {index}a", f"Fixture Author {index}b"],
            "journal": "Journal of Deterministic Audits",
            "doi": f"10.1000/zjaudit.{index}",
            "publishedDate": _PUBLISHED - index * 7 * _DAYS,
        }
        for index in range(1, 7)
    ]


def _it() -> list[dict[str, t.Any]]:
    return [
        {
            "title": f"zjaudit-package-{index}",
            "url": f"https://example.com/zjaudit/it/{index}",
            "content": f"Offline fixture package #{index} for the software card list.",
            "package_name": f"zjaudit-package-{index}",
            "version": f"1.{index}.0",
            "license": "MIT",
        }
        for index in range(1, 9)
    ]


def _apps() -> list[dict[str, t.Any]]:
    return [
        {
            "title": f"Audit fixture app #{index}",
            "url": f"https://example.com/zjaudit/apps/{index}",
            "content": f"Offline fixture app #{index} for the application grid.",
            "thumbnail": FIXTURE_IMG,
            "img_src": FIXTURE_IMG,
        }
        for index in range(1, 13)
    ]


_FIXTURES = {
    "general": _general,
    "images": _images,
    "videos": _videos,
    "music": _music,
    "files": _files,
    "science": _science,
    "packages": _it,
    "apps": _apps,
}


def search(query: str, request_params: t.Any) -> list[dict[str, t.Any]]:  # noqa: ARG001
    """Return the fixture set whose token appears in the query (default:
    the general set).  Queries without the "zjaudit" token get nothing:
    dev settings register this engine next to the real ones, and ordinary
    searches must not be polluted with fixtures."""
    lowered = query.lower()
    if "zjaudit" not in lowered:
        return []
    for kind in ("images", "videos", "music", "files", "science", "apps", "packages", "general"):
        if kind in lowered:
            return _FIXTURES[kind]()
    return _FIXTURES["general"]()
