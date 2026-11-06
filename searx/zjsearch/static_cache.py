# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""Immutable caching for the theme's content-hashed static artifacts.

The PGLite engine payload (``pglite-*.wasm``/``.data``, ``initdb-*.wasm``,
``pg.worker-*.js``, the three extension tars) is content-hashed by vite
into its FILENAMES, and every reference (the worker's ``self.location``
resolution, the emscripten asset URLs) is baked into the built bundles --
a rebuild changes the URL, so a year-long cache can never serve a stale
artifact.  WhiteNoise's 30-second window would instead revalidate ~16MB
of binaries every session, and disk caches evict exactly the biggest
files first, forcing full re-downloads.

webapp.py stays untouched: like every theme feature this rides the theme
install chain.  ``install(app)`` wraps the WSGI stack AFTER WhiteNoise is
mounted (webapp.py calls :py:func:`searx.zjsearch.install` at its end)
and rewrites ONLY the ``Cache-Control`` response header for the hashed
URLs -- ETags, 304 revalidation, ``Vary`` and the 30-second window on the
hashless entry bundles (``zjsearch.min.js/css``, the deliberately-stable
``chunk/zjs-results.min.js`` pre-warm URL, the fonts) pass through
untouched.
"""

import flask

PREFIXES = (
    "/static/pglite-",
    "/static/initdb-",
    "/static/pg.worker-",
    "/static/vector.tar-",
    "/static/pg_trgm.tar-",
    "/static/pg_textsearch.tar-",
)
IMMUTABLE = "public, max-age=31536000, immutable"


class ImmutableStatic:
    """WSGI wrapper: Cache-Control -> immutable on the hashed artifacts."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        if not environ.get("PATH_INFO", "").startswith(PREFIXES):
            return self.wsgi_app(environ, start_response)

        def rewrite(status, headers, exc_info=None):
            headers = [
                (name, IMMUTABLE if name.lower() == "cache-control" else value)
                for name, value in headers
            ]
            return start_response(status, headers, exc_info)

        return self.wsgi_app(environ, rewrite)


def install(app: flask.Flask) -> None:
    """Wrap the WhiteNoise chain (mounted earlier in webapp.py)."""
    app.wsgi_app = ImmutableStatic(app.wsgi_app)
