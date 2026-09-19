# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""zjsearch theme: streaming search responses.

A full page load of ``/search`` used to stay blank until every engine had
answered: the upstream ``search()`` view renders the whole results page only
after the search completed.  This module registers a ``before_request`` hook
(Flask short-circuits the view when a before_request handler returns a
response) that answers zjsearch HTML searches with a streaming response
instead: the application shell (head + static boot skeleton) is flushed right
away, the engines run while the browser already shows the loading state, then
the page-data payload and the no-JS fallback close the document.

Everything lives in this module on purpose: ``searx/webapp.py`` only appends
the ``install(app)`` call at its end, so upstream changes to ``search()`` /
``render()`` cannot conflict with this fork.  The one price is a mirror of
the context building part of ``webapp.render`` (:py:func:`_render_context`)
-- re-sync it when upstream changes ``render``.
"""

import base64
import json

import flask
from flask_babel import gettext
from markupsafe import escape

from searx import logger, settings
from searx.extended_types import sxng_request
from searx.locales import RTL_LOCALES, match_locale
from searx.webadapter import get_search_query_from_webapp
from searx.webutils import get_translated_errors, highlight_content

logger = logger.getChild('zjsearch_stream')

THEME = 'zjsearch'

# the template streams the shell first and only blocks on the streamed search
# inside the <noscript>/page-data blocks; the shell is coalesced into one
# chunk (up to the marker comment) so the browser paints the skeleton from a
# single write
SHELL_END = '<!--zjs-shell-->'


class ZjsearchStreamedSearch:
    """Lazy zjsearch HTML search.

    The streaming response flushes the app shell before the engines run; the
    results template touches the properties below only in its second half,
    which triggers :py:meth:`_run` exactly once -- the engines run while the
    browser already shows the boot skeleton.  A failure or a redirect is
    reported as a page payload instead of a HTTP error response, because the
    HTTP status (and the shell) is already out by then.  The result
    post-processing mirrors the HTML branch of the upstream ``search()`` view.
    """

    def __init__(self, search_query, raw_text_query, selected_locale):
        self.search_query = search_query
        self.raw_text_query = raw_text_query
        self.selected_locale = selected_locale
        self._error_message = None
        self._redirect_url = None
        self._data = None

    def _run(self):
        if self._data is not None:
            return
        data = {}
        try:
            import searx.search  # pylint: disable=import-outside-toplevel

            search_obj = searx.search.SearchWithPlugins(self.search_query, sxng_request, sxng_request.user_plugins)
            result_container = search_obj.search()

            # 1. check if the result is a redirect for an external bang
            if result_container.redirect_url:
                self._redirect_url = result_container.redirect_url
                return

            results = result_container.get_ordered_results()

            if self.search_query.redirect_to_first_result and results:
                self._redirect_url = results[0]['url']
                return

            # the same result post-processing as the HTML branch of search()
            current_template = None
            previous_result = None
            for result in results:
                if 'content' in result and result['content']:
                    result['content'] = highlight_content(escape(result['content'][:1024]), self.search_query.query)
                if 'title' in result and result['title']:
                    result['title'] = highlight_content(escape(result['title'] or ''), self.search_query.query)
                if current_template != result.template:
                    result.open_group = True
                    if previous_result:
                        previous_result.close_group = True  # pylint: disable=unsupported-assignment-operation
                current_template = result.template
                previous_result = result
            if previous_result:
                previous_result.close_group = True

            # suggestions: use RawTextQuery to get the suggestion URLs with the same bang
            suggestion_urls = list(
                map(
                    lambda suggestion: {
                        'url': self.raw_text_query.changeQuery(suggestion).getFullQuery(),
                        'title': suggestion,
                    },
                    result_container.suggestions,
                )
            )

            correction_urls = list(
                map(
                    lambda correction: {
                        'url': self.raw_text_query.changeQuery(correction).getFullQuery(),
                        'title': correction,
                    },
                    result_container.corrections,
                )
            )

            # engine_timings: get engine response times sorted from slowest to fastest
            engine_timings = sorted(result_container.get_timings(), reverse=True, key=lambda e: e.total)

            data = {
                'results': results,
                'suggestions': suggestion_urls,
                'corrections': correction_urls,
                'answers': result_container.answers,
                'infoboxes': result_container.infoboxes,
                'engine_data': result_container.engine_data,
                'paging': result_container.paging,
                'unresponsive_engines': get_translated_errors(result_container.unresponsive_engines),
                'timings': [(timing.engine, timing.total) for timing in engine_timings],
                'max_response_time': engine_timings[0].total if engine_timings else None,
                'search_language': match_locale(
                    search_obj.search_query.lang,
                    settings['search']['languages'],
                    fallback=sxng_request.preferences.get_value("language"),
                ),
            }
        except Exception:  # pylint: disable=broad-except
            logger.exception('search error')
            self._error_message = gettext('search error')
        finally:
            self._data = data

    # error_message / redirect_url are properties too: the template reads
    # them in its first branch, that access must trigger the search

    @property
    def error_message(self):
        self._run()
        return self._error_message

    @property
    def redirect_url(self):
        self._run()
        return self._redirect_url

    # every property the template reads in its second half; the getters are
    # only reached when the search did not fail and did not redirect

    @property
    def results(self):
        self._run()
        return self._data.get('results', [])

    @property
    def suggestions(self):
        self._run()
        return self._data.get('suggestions', [])

    @property
    def corrections(self):
        self._run()
        return self._data.get('corrections', [])

    @property
    def answers(self):
        self._run()
        return self._data.get('answers', [])

    @property
    def infoboxes(self):
        self._run()
        return self._data.get('infoboxes', [])

    @property
    def engine_data(self):
        self._run()
        return self._data.get('engine_data', [])

    @property
    def paging(self):
        self._run()
        return self._data.get('paging', False)

    @property
    def unresponsive_engines(self):
        self._run()
        return self._data.get('unresponsive_engines', [])

    @property
    def timings(self):
        self._run()
        return self._data.get('timings', [])

    @property
    def max_response_time(self):
        self._run()
        return self._data.get('max_response_time')

    @property
    def search_language(self):
        self._run()
        return self._data.get('search_language')


def _render_context(webapp, template_name: str, **kwargs):
    # mirror of searx.webapp.render() without the final render_template()
    # call -- helpers are read from the webapp module so this stays in sync
    # by construction; re-check against webapp.render when upstream changes it
    client_settings = webapp.get_client_settings()
    kwargs['client_settings'] = base64.b64encode(json.dumps(client_settings).encode('utf-8')).decode('utf-8')
    kwargs['preferences'] = sxng_request.preferences
    kwargs.update(client_settings)

    # values from the HTTP requests
    kwargs['endpoint'] = 'results' if 'q' in kwargs else sxng_request.endpoint
    kwargs['cookies'] = sxng_request.cookies
    kwargs['errors'] = sxng_request.errors
    kwargs['link_token'] = webapp.link_token.get_token()

    kwargs['categories_as_tabs'] = list(settings['categories_as_tabs'].keys())
    kwargs['categories'] = webapp.get_enabled_categories(settings['categories_as_tabs'].keys())
    kwargs['DEFAULT_CATEGORY'] = webapp.DEFAULT_CATEGORY

    # i18n
    kwargs['sxng_locales'] = [l for l in webapp.sxng_locales if l[0] in settings['search']['languages']]

    locale = sxng_request.preferences.get_value('locale')
    kwargs['locale_rfc5646'] = webapp._get_locale_rfc5646(locale)  # pylint: disable=protected-access

    if locale in RTL_LOCALES and 'rtl' not in kwargs:
        kwargs['rtl'] = True

    if 'current_language' not in kwargs:
        kwargs['current_language'] = webapp.parse_lang(sxng_request.preferences, {}, webapp.RawTextQuery('', []))

    # values from settings
    kwargs['search_formats'] = [x for x in settings['search']['formats'] if x != 'html']
    kwargs['instance_name'] = webapp.get_setting('general.instance_name')
    kwargs['searxng_version'] = webapp.VERSION_STRING
    kwargs['searxng_git_url'] = webapp.GIT_URL
    kwargs['enable_metrics'] = webapp.get_setting('general.enable_metrics')
    kwargs['get_setting'] = webapp.get_setting
    kwargs['get_pretty_url'] = webapp.get_pretty_url

    # values from settings: donation_url
    donation_url = webapp.get_setting('general.donation_url')
    if donation_url is True:
        donation_url = webapp.custom_url_for('info', pagename='donate')
    kwargs['donation_url'] = donation_url

    # helpers to create links to other pages
    kwargs['url_for'] = webapp.custom_url_for  # override url_for function in templates
    kwargs['image_proxify'] = webapp.image_proxify
    kwargs['favicon_url'] = webapp.favicons.favicon_url
    kwargs['cache_url'] = settings['ui']['cache_url']
    kwargs['get_result_template'] = webapp.get_result_template
    kwargs['opensearch_url'] = (
        webapp.url_for('opensearch')
        + '?'
        + webapp.urlencode(
            {
                'method': sxng_request.preferences.get_value('method'),
                'autocomplete': sxng_request.preferences.get_value('autocomplete'),
            }
        )
    )
    kwargs['urlparse'] = webapp.urlparse

    return kwargs


def _search_stream_response(search_query, raw_text_query, selected_locale) -> flask.Response:
    """Build the streaming response for a zjsearch HTML search."""
    import searx.webapp as webapp  # pylint: disable=import-outside-toplevel,cyclic-import

    streamed = ZjsearchStreamedSearch(search_query, raw_text_query, selected_locale)
    context = _render_context(
        webapp,
        'results.html',
        # fmt: off
        q=sxng_request.form['q'],
        selected_categories=search_query.categories,
        pageno=search_query.pageno,
        time_range=search_query.time_range or '',
        timeout_limit=sxng_request.form.get('timeout_limit', None),
        current_language=selected_locale,
        streamed=streamed,
        # fmt: on
    )
    template = flask.current_app.jinja_env.get_template('{}/results.html'.format(context['theme']))

    def generate():
        buf = None
        for chunk in template.stream(context):
            if buf is not None:
                buf.append(chunk)
                if SHELL_END in chunk:
                    yield ''.join(buf)
                    buf = None
            else:
                yield chunk
        if buf:
            yield ''.join(buf)

    response = flask.Response(flask.stream_with_context(generate()), mimetype='text/html')
    # ask reverse proxies to pass the early shell through unbuffered
    response.headers['X-Accel-Buffering'] = 'no'
    return response


def _before_request():
    """Return the streaming response for zjsearch HTML searches, or None to
    let the upstream ``search()`` view handle the request unchanged."""

    if sxng_request.endpoint != 'search':
        return None
    if sxng_request.preferences.get_value('theme') != THEME:
        return None
    if sxng_request.form.get('format', 'html') != 'html':
        return None  # RSS / JSON / CSV: upstream view
    if 'html' not in settings['search']['formats']:
        return None  # disabled upstream: let the view answer (403)
    if not sxng_request.form.get('q'):
        return None  # no query: the view renders the index page

    # parse errors fall through to the upstream view, which answers with the
    # canonical error page for this request
    try:
        search_query, raw_text_query, _, _, selected_locale = get_search_query_from_webapp(
            sxng_request.preferences, sxng_request.form
        )
    except Exception:  # pylint: disable=broad-except
        return None

    return _search_stream_response(search_query, raw_text_query, selected_locale)


def install(app: flask.Flask) -> None:
    """Register the streaming hook; called once at the end of webapp.py.

    Registered after the upstream before_request hooks, so the preferences
    (theme) and the merged GET/POST form are already prepared.
    """
    app.before_request(_before_request)
