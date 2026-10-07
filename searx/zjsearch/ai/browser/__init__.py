# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The built-in render engine: ONE Camoufox (anti-detect Firefox)
browser behind the page reader's rendered-HTML seam.

This is an ENGINE package, not a tool family: it owns no tool spec and
registers nothing -- ``tools.web_reader`` delegates its render here when
the deployment enables it (``zjsearch.browser``), and a later interactive
tool will drive the same browser.  The dependency direction stays
strictly downwards (core only, plus searx's shared network loop); the
package is import-safe without the optional ``camoufox`` dependency --
availability is :func:`config.ready`, and an absent install leaves the
reader unregistered.

Modules: :py:mod:`config` -- the settings block, the availability gate
and the shared :class:`RenderError`; :py:mod:`gate` -- the REQUEST-level
SSRF fence (a local browser connects from this host, so every request
the page makes passes the public-address check); :py:mod:`engine` --
the persistent context, the shared-loop bridge and the read flow;
:py:mod:`install` -- the build-time browser installer
(``python -m searx.zjsearch.ai.browser.install``).
"""
