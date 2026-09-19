# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
# pylint: disable=too-many-return-statements, too-many-branches
"""Advanced search syntax plugin for ZJSearch.

Supports site filtering, filetype filtering, date range filtering,
+word/+/regex/ inclusion, word exclusion, exact phrase matching,
and positive/negative positional search with /regex/ support.
"""

import typing
import re
import functools
from datetime import datetime, timezone
from urllib.parse import urlparse

from flask_babel import gettext
from werkzeug.datastructures import ImmutableMultiDict

from searx.extended_types import SXNG_Request
from searx.plugins import Plugin, PluginInfo
from searx.result_types import Result

if typing.TYPE_CHECKING:
    from searx.plugins import PluginCfg
    from searx.search import SearchWithPlugins


# Pre-compiled patterns used across instances (class-level for sharing)
# Combined pattern for fast pre-check of any advanced syntax
_COMBINED_SYNTAX_CHECK = re.compile(
    r'(?:^|\s)(?:'
    r'[+-]?site:|'
    r'[+-]?(?:intitle|inurl|intext):|'
    r'\+/|'
    r'\+[^\s/]+|'
    r'(?<!\w)-/|'
    r'(?<!\w)-(?:site:|intitle:|inurl:|intext:)?[^\s/]+|'
    r'filetype:|'
    r'before:|after:|'
    r'"'
    r')',
    re.IGNORECASE,
)

# Patterns for cleaning the query before sending to engines
# Note: /regex/flags support (e.g., /pattern/i) — flags after closing / are included in the match
_CLEAN_PATTERNS = [
    re.compile(r'(?:^|\s)[+-]?site:[^\s]+', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]?intitle:(?:/[^/]+/[a-z]*|[^\s/]+)', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]?inurl:(?:/[^/]+/[a-z]*|[^\s/]+)', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]?intext:(?:/[^/]+/[a-z]*|[^\s/]+)', re.IGNORECASE),
    re.compile(r'(?:^|\s)\+/[^/]+/[a-z]*', re.IGNORECASE),
    re.compile(r'(?:^|\s)\+[^\s/]+', re.IGNORECASE),
    re.compile(r'(?:^|\s)-/[^/]+/[a-z]*', re.IGNORECASE),
    # -word: only match when followed by whitespace or end-of-string (not /, avoids file paths)
    re.compile(r'(?:^|\s)-(?:site:|intitle:|inurl:|intext:|filetype:|before:|after:)?[^\s/]+(?=\s|$)', re.IGNORECASE),
    re.compile(r'(?:^|\s)filetype:[^\s]+', re.IGNORECASE),
    re.compile(r'(?:^|\s)(?:before|after):\d{4}-\d{2}-\d{2}', re.IGNORECASE),
    # exact phrases: only the quote marks are stripped further down (the
    # phrase terms themselves stay in the engine query -- the exact-match
    # constraint is enforced client-side in on_result)
]

# Pre-compiled patterns for final cleanup verification
_VERIFY_PATTERNS = [
    re.compile(r'(?:^|\s)site:', re.IGNORECASE),
    re.compile(r'(?:^|\s)intitle:', re.IGNORECASE),
    re.compile(r'(?:^|\s)inurl:', re.IGNORECASE),
    re.compile(r'(?:^|\s)intext:', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]site:', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]intitle:', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]inurl:', re.IGNORECASE),
    re.compile(r'(?:^|\s)[+-]intext:', re.IGNORECASE),
    re.compile(r'(?:^|\s)\+/', re.IGNORECASE),
    re.compile(r'(?:^|\s)-/', re.IGNORECASE),
    re.compile(r'(?:intitle|inurl|intext):/[^/]+/', re.IGNORECASE),
    re.compile(r'(?:^|\s)\+\w', re.IGNORECASE),
    re.compile(r'(?:^|\s)filetype:', re.IGNORECASE),
    re.compile(r'(?:^|\s)(?:before|after):', re.IGNORECASE),
]

# Date pattern for before:/after: filters
_DATE_PATTERN = re.compile(r'(\d{4})-(\d{2})-(\d{2})')

# Regex to detect advanced syntax context (for distinguishing /regex/ in syntax vs file paths)
_ADVANCED_REGEX_CONTEXT = re.compile(
    r'(?:^|\s)(?:\+|-)?(?:intitle|inurl|intext):/[^/]+/[a-z]*|'
    r'(?:^|\s)\+/[^/]+/[a-z]*|'
    r'(?:^|\s)-/[^/]+/[a-z]*',
    re.IGNORECASE,
)

# File extension at the end of a URL path (filetype: filter)
_EXT_PATTERN = re.compile(r'\.([a-z0-9]+)$', re.IGNORECASE)

# Kana + CJK ideographs (unified, extension A, compatibility) -- scripts
# written without word separators; see `_word_matcher` (hangul is spaced and
# keeps word boundaries)
_CJK_TERM_RE = re.compile(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')

# syntax-key groups of the positional filters: (pos_words, pos_regexes,
# neg_words, neg_regexes) per searched field (title, content, url)
_POSITIONAL_KEYS = (
    ('intitle_words', 'intitle_regexes', 'neg_intitle_words', 'neg_intitle_regexes'),
    ('intext_words', 'intext_regexes', 'neg_intext_words', 'neg_intext_regexes'),
    ('inurl_words', 'inurl_regexes', 'neg_inurl_words', 'neg_inurl_regexes'),
)

# Aggressive fallback removals for the (rare) case that cleaning left
# advanced syntax behind; pre-compiled once instead of re-built per query.
_AGGRESSIVE_PATTERNS = [
    re.compile(p.pattern + r'[^\s]*', re.IGNORECASE) for p in _VERIFY_PATTERNS
]


class SXNGPlugin(Plugin):
    """Plugin that enhances search with advanced syntax support.

    Supported syntax:
    - site:domain / -site:domain — include/exclude sites
    - filetype:ext — filter by file extension in URL
    - before:YYYY-MM-DD / after:YYYY-MM-DD — date range filter
    - intitle:word / intitle:/regex/ — positive title filters
    - inurl:word / inurl:/regex/ — positive URL filters
    - intext:word / intext:/regex/ — positive content filters
    - -intitle:word / -intitle:/regex/ — negative title filters
    - -inurl:word / -inurl:/regex/ — negative URL filters
    - -intext:word / -intext:/regex/ — negative content filters
    - +word / +/regex/ — mandatory inclusion
    - -word / -/regex/ — exclusion
    - "exact phrase" — exact phrase matching
    """

    id = "advanced_search_syntax"

    def __init__(self, plg_cfg: "PluginCfg") -> None:
        super().__init__(plg_cfg)
        self.info = PluginInfo(
            id=self.id,
            name=gettext("Advanced Search Syntax"),
            description=gettext(
                "Enhanced search with site, filetype, date filtering, "
                "+word/+/regex/ inclusion, word exclusion, exact phrase matching, "
                "and positive/negative positional search with /regex/ support"
            ),
            preference_section="general",
        )

        # Pre-compile regex patterns for extracting syntax values
        # Note: /regex/flags patterns capture only the regex body, not the flags.
        # The flags (e.g., /pattern/i) are consumed during matching but discarded.
        self._patterns = {
            'site_include': re.compile(r'(?:^|\s)site:([^\s]+)', re.IGNORECASE),
            'site_exclude': re.compile(r'(?:^|\s)-site:([^\s]+)', re.IGNORECASE),
            'filetype': re.compile(r'(?:^|\s)filetype:([^\s]+)', re.IGNORECASE),
            'before': re.compile(r'(?:^|\s)before:(\d{4}-\d{2}-\d{2})', re.IGNORECASE),
            'after': re.compile(r'(?:^|\s)after:(\d{4}-\d{2}-\d{2})', re.IGNORECASE),
            'exact_phrase': re.compile(r'"([^"]+)"', re.IGNORECASE),
            # Positive positional patterns (with /regex/flags support)
            'intitle_regex': re.compile(r'(?:^|\s)intitle:/([^/]+)/[a-z]*', re.IGNORECASE),
            'intitle_word': re.compile(r'(?:^|\s)intitle:([^\s/]+)', re.IGNORECASE),
            'inurl_regex': re.compile(r'(?:^|\s)inurl:/([^/]+)/[a-z]*', re.IGNORECASE),
            'inurl_word': re.compile(r'(?:^|\s)inurl:([^\s/]+)', re.IGNORECASE),
            'intext_regex': re.compile(r'(?:^|\s)intext:/([^/]+)/[a-z]*', re.IGNORECASE),
            'intext_word': re.compile(r'(?:^|\s)intext:([^\s/]+)', re.IGNORECASE),
            # Negative positional patterns (with /regex/flags support)
            'neg_intitle_regex': re.compile(r'(?:^|\s)-intitle:/([^/]+)/[a-z]*', re.IGNORECASE),
            'neg_intitle_word': re.compile(r'(?:^|\s)-intitle:([^\s/]+)', re.IGNORECASE),
            'neg_inurl_regex': re.compile(r'(?:^|\s)-inurl:/([^/]+)/[a-z]*', re.IGNORECASE),
            'neg_inurl_word': re.compile(r'(?:^|\s)-inurl:([^\s/]+)', re.IGNORECASE),
            'neg_intext_regex': re.compile(r'(?:^|\s)-intext:/([^/]+)/[a-z]*', re.IGNORECASE),
            'neg_intext_word': re.compile(r'(?:^|\s)-intext:([^\s/]+)', re.IGNORECASE),
            # Include/exclude patterns (with /regex/flags support)
            'include_regex': re.compile(r'(?:^|\s)\+/([^/]+)/[a-z]*', re.IGNORECASE),
            'include_word': re.compile(r'(?:^|\s)\+([^\s/]+)', re.IGNORECASE),
            'exclude_regex': re.compile(r'(?:^|\s)-/([^/]+)/[a-z]*', re.IGNORECASE),
            # -word: (?=\s|$) ensures we only match complete tokens, not file paths like -path/to/file
            'exclude_word': re.compile(
                r'(?:^|\s)-((?!site:|intitle:|inurl:|intext:|filetype:|before:|after:)[^\s/]+)(?=\s|$)',
                re.IGNORECASE,
            ),
        }

        # Single combined regex for faster pre-check than iterating all patterns
        self._syntax_check_re = _COMBINED_SYNTAX_CHECK

    @staticmethod
    @functools.lru_cache(maxsize=128)
    def _compile_user_regex(pattern: str) -> re.Pattern:
        """Safely compile user-provided regex patterns with LRU caching."""
        try:
            return re.compile(pattern, re.IGNORECASE | re.MULTILINE)
        except re.error:
            return re.compile(re.escape(pattern), re.IGNORECASE)

    @staticmethod
    def _word_matcher(word: str) -> tuple[str, str | re.Pattern]:
        """Precompute a word match for the result hot path.

        Returns a ``('sub', word_lower)`` tuple for plain substring checks or
        a ``('wb', compiled)`` tuple with a pre-compiled word-boundary
        pattern -- decided once per word at parse time.

        Word boundaries only exist in scripts that separate words with
        spaces/punctuation.  Inside continuous CJK text every character is a
        word character, so ``\\b教程\\b`` can never match and a ``+教程`` /
        ``intitle:教程`` filter would drop every result while ``-教程``
        would never exclude one -- terms containing such characters fall
        back to a substring match.
        """
        w = word.lower()
        if not _CJK_TERM_RE.search(w) and not re.search(r'[^\w\s]', w):
            return ('wb', re.compile(r'\b' + re.escape(w) + r'\b'))
        return ('sub', w)

    @staticmethod
    def _matcher_matches(matcher: tuple, text_lower: str) -> bool:
        """Apply a precomputed word matcher (see `_word_matcher`) to
        already-lowercased text."""
        kind, payload = matcher
        if kind == 'sub':
            return payload in text_lower
        return bool(payload.search(text_lower))

    @staticmethod
    def _regex_list_matches(compiled_list: list, text: str) -> bool:
        """True if any pre-compiled user regex matches (checked against the
        original text, they carry their own IGNORECASE flag)."""
        return any(c.search(text) for c in compiled_list)

    def _has_advanced_syntax(self, query: str) -> bool:
        """Check if the query contains any advanced search syntax.

        Uses a single combined regex for O(n) check instead of iterating
        all individual patterns.
        """
        return bool(self._syntax_check_re.search(query))

    @staticmethod
    def _is_regex_in_advanced_context(text: str) -> bool:
        """Check if text contains /regex/ patterns within advanced syntax context.

        This distinguishes between /regex/ used as search syntax vs.
        file paths that happen to contain slashes.
        """
        return bool(_ADVANCED_REGEX_CONTEXT.search(text))

    def _clean_query_for_engines(self, query: str) -> str:
        """Clean query by removing ALL advanced syntax patterns for external engines.

        Uses pre-compiled class-level patterns for efficiency.
        """
        cleaned = query

        # Single pass: remove all advanced syntax patterns
        for pattern in _CLEAN_PATTERNS:
            cleaned = pattern.sub(' ', cleaned)

        # Normalize whitespace
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()

        # Remove exact phrase quotes that are now orphaned
        cleaned = cleaned.replace('"', '')

        # Final verification pass — ensure no advanced syntax remains
        remaining = [p for p in _VERIFY_PATTERNS if p.search(cleaned)]
        if remaining:
            self.log.warning(
                "Advanced syntax still present after cleaning: %s in query '%s'",
                [p.pattern for p in remaining],
                cleaned,
            )
            # Aggressive removal for any remaining patterns
            for pattern in _AGGRESSIVE_PATTERNS:
                cleaned = pattern.sub(' ', cleaned)
            cleaned = re.sub(r'\s+', ' ', cleaned).strip()

        return cleaned

    def _extract_remaining_terms(self, original_query: str, syntax: dict) -> list:
        """Extract remaining search terms from original query after removing all advanced syntax.

        Remaining terms are matched with OR logic: a result passes if it contains
        ANY of the remaining terms (not necessarily all).
        """
        all_words = re.findall(r'[^\s"]+', original_query)

        # Collect words that are part of advanced syntax patterns
        excluded_words = set()

        # Words from site/filetype patterns
        for site in syntax['site_include'] + syntax['site_exclude']:
            excluded_words.update(re.findall(r'\w+', site.lower()))
        for ft in syntax['filetypes']:
            excluded_words.update(re.findall(r'\w+', ft.lower()))

        # Words from regex patterns (cautious extraction)
        regex_lists = [
            syntax['include_regexes'], syntax['exclude_regexes'],
            syntax['intitle_regexes'], syntax['intext_regexes'], syntax['inurl_regexes'],
            syntax['neg_intitle_regexes'], syntax['neg_intext_regexes'], syntax['neg_inurl_regexes'],
        ]
        for pattern_list in regex_lists:
            for pat in pattern_list:
                excluded_words.update(re.findall(r'\b[a-zA-Z]{3,}\b', pat.lower()))

        # Words from word patterns
        word_lists = [
            syntax['include_words'], syntax['exclude_words'],
            syntax['intitle_words'], syntax['inurl_words'], syntax['intext_words'],
            syntax['neg_intitle_words'], syntax['neg_inurl_words'], syntax['neg_intext_words'],
        ]
        for word_list in word_lists:
            for word in word_list:
                excluded_words.update(re.findall(r'\w+', word.lower()))

        # Filter remaining words
        remaining = []
        for word in all_words:
            if word.startswith('"') and word.endswith('"'):
                continue  # Exact phrases are handled separately
            # bang / language tokens (!wp, !!g, :fr) route the search -- they
            # are not content terms, a result title never contains them
            if word.startswith(("!", ":")):
                continue
            if self._is_advanced_syntax_word(word):
                continue
            if self._is_regex_in_advanced_context(f" {word} "):
                continue

            word_parts = re.findall(r'\w+', word.lower())
            if word_parts and not any(p in excluded_words for p in word_parts):
                remaining.append(word)

        return self._remove_duplicates_preserve_order(remaining)

    def _is_advanced_syntax_word(self, word: str) -> bool:
        """Check if a word starts with advanced syntax indicators."""
        # Check prefixed operators
        prefixes = [
            'site:', '-site:',
            'intitle:', '-intitle:',
            'inurl:', '-inurl:',
            'intext:', '-intext:',
            'filetype:', 'before:', 'after:',
        ]
        if any(word.startswith(prefix) for prefix in prefixes):
            return True

        # +word or +/regex/ format
        if word.startswith('+'):
            return True

        # -word format (but not file paths)
        if word.startswith('-'):
            # -/regex/ format (must end with /)
            if len(word) > 1 and word[1] == '/':
                return word.endswith('/') and len(word) > 3
            # -word format: ensure it's not part of a hyphenated compound
            # and not a file path
            return not any(word.startswith(p) for p in prefixes)

        return False

    @staticmethod
    def _remove_duplicates_preserve_order(items: list) -> list:
        """Remove duplicates while preserving insertion order."""
        seen = set()
        unique_items = []
        for item in items:
            item_lower = item.lower()
            if item_lower not in seen:
                seen.add(item_lower)
                unique_items.append(item)
        return unique_items

    def _parse_advanced_syntax(self, query: str) -> tuple[str, dict]:
        """Parse and extract all advanced syntax patterns from query.

        Returns:
            tuple of (cleaned_query_for_engines, syntax_dict)
        """
        syntax = {
            'site_include': [],
            'site_exclude': [],
            'filetypes': [],
            'before_date': None,
            'after_date': None,
            'exact_phrases': [],
            'include_regexes': [],
            'include_words': [],
            'exclude_regexes': [],
            'exclude_words': [],
            # Positive positional
            'intitle_words': [],
            'intitle_regexes': [],
            'inurl_words': [],
            'inurl_regexes': [],
            'intext_words': [],
            'intext_regexes': [],
            # Negative positional
            'neg_intitle_words': [],
            'neg_intitle_regexes': [],
            'neg_inurl_words': [],
            'neg_inurl_regexes': [],
            'neg_intext_words': [],
            'neg_intext_regexes': [],
            'remaining_terms': [],
            # Pre-computed for performance
            '_site_include_set': set(),
            '_site_exclude_set': set(),
        }

        p = self._patterns

        # 1. Site patterns
        syntax['site_include'] = [m.lower().strip() for m in p['site_include'].findall(query)]
        syntax['site_exclude'] = [m.lower().strip() for m in p['site_exclude'].findall(query)]

        # Pre-compute normalized domain sets for fast lookup
        syntax['_site_include_set'] = {self._normalize_domain(d) for d in syntax['site_include']}
        syntax['_site_exclude_set'] = {self._normalize_domain(d) for d in syntax['site_exclude']}

        # 2. Filetype patterns
        syntax['filetypes'] = [m.lower().strip().lstrip('.') for m in p['filetype'].findall(query)]

        # 3. Date range patterns
        before_matches = p['before'].findall(query)
        if before_matches:
            syntax['before_date'] = self._parse_date(before_matches[0])
        after_matches = p['after'].findall(query)
        if after_matches:
            syntax['after_date'] = self._parse_date(after_matches[0])

        # 4. Exact phrase patterns
        syntax['exact_phrases'] = [m.strip() for m in p['exact_phrase'].findall(query)]

        # 5. Positive positional patterns
        for key_prefix, regex_key, word_key in [
            ('intitle', 'intitle_regex', 'intitle_word'),
            ('intext', 'intext_regex', 'intext_word'),
            ('inurl', 'inurl_regex', 'inurl_word'),
        ]:
            regexes = [m.strip() for m in p[regex_key].findall(query)]
            syntax[f'{key_prefix}_regexes'] = regexes
            words = p[word_key].findall(query)
            syntax[f'{key_prefix}_words'] = [
                w.strip() for w in words if not any(w in r for r in regexes)
            ]

        # 6. Negative positional patterns
        for key_prefix, regex_key, word_key in [
            ('neg_intitle', 'neg_intitle_regex', 'neg_intitle_word'),
            ('neg_intext', 'neg_intext_regex', 'neg_intext_word'),
            ('neg_inurl', 'neg_inurl_regex', 'neg_inurl_word'),
        ]:
            regexes = [m.strip() for m in p[regex_key].findall(query)]
            syntax[f'{key_prefix}_regexes'] = regexes
            words = p[word_key].findall(query)
            syntax[f'{key_prefix}_words'] = [
                w.strip() for w in words if not any(w in r for r in regexes)
            ]

        # 7. Include/Exclude patterns
        syntax['include_regexes'] = [m.strip() for m in p['include_regex'].findall(query)]
        syntax['include_words'] = [m.strip() for m in p['include_word'].findall(query)]
        syntax['exclude_regexes'] = [m.strip() for m in p['exclude_regex'].findall(query)]
        syntax['exclude_words'] = [m.strip() for m in p['exclude_word'].findall(query)]

        # 8. Clean query for engines
        cleaned_query = self._clean_query_for_engines(query)

        # 9. Extract remaining terms from original query
        syntax['remaining_terms'] = self._extract_remaining_terms(query, syntax)

        # 10. Precompute everything the per-result hot path needs: compiled
        # user regexes, word matchers, lowercased phrases and the filetype
        # set -- on_result never compiles, branches or re-lowercases.
        syntax['_regex_compiled'] = {
            key: [self._compile_user_regex(p) for p in syntax[key]]
            for key in (
                'include_regexes', 'exclude_regexes',
                'intitle_regexes', 'inurl_regexes', 'intext_regexes',
                'neg_intitle_regexes', 'neg_inurl_regexes', 'neg_intext_regexes',
            )
        }
        for key in (
            'include_words', 'exclude_words', 'remaining_terms',
            'intitle_words', 'inurl_words', 'intext_words',
            'neg_intitle_words', 'neg_inurl_words', 'neg_intext_words',
        ):
            syntax[key] = [self._word_matcher(w) for w in syntax[key]]
        syntax['_phrases_lower'] = [p.lower() for p in syntax['exact_phrases']]
        syntax['_filetype_set'] = set(syntax['filetypes'])

        return cleaned_query, syntax

    @staticmethod
    def _parse_date(date_str: str) -> datetime | None:
        """Parse a YYYY-MM-DD date string to a UTC datetime."""
        match = _DATE_PATTERN.match(date_str)
        if not match:
            return None
        try:
            return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)),
                          tzinfo=timezone.utc)
        except ValueError:
            return None

    def _update_form_query(self, form, new_query: str) -> None:
        """Safely update form query value."""
        try:
            if hasattr(form, 'q'):
                form.q = new_query
                return
        except (AttributeError, TypeError):
            pass

        try:
            form['q'] = new_query
            return
        except (TypeError, KeyError):
            pass

        raise TypeError("Form object is immutable and cannot be modified")

    @staticmethod
    def _create_new_form_with_query(original_form, new_query: str):
        """Create a new form object with updated query."""
        form_dict = dict(original_form.items()) if hasattr(original_form, 'items') else dict(original_form)
        form_dict['q'] = new_query
        return ImmutableMultiDict(form_dict)

    def pre_search(self, request: SXNG_Request, search: "SearchWithPlugins") -> bool:
        """Parse the search query for advanced syntax patterns and modify the query sent to engines."""
        original_query = request.form.get('q', '')

        if not self._has_advanced_syntax(original_query):
            request.search_syntax = {'has_advanced_syntax': False, 'original_query': original_query}
            return True

        cleaned_query, syntax = self._parse_advanced_syntax(original_query)
        syntax.update({
            'has_advanced_syntax': True,
            'original_query': original_query,
            'cleaned_query': cleaned_query,
        })

        request.original_query = original_query
        request.search_syntax = syntax

        # Bang / language tokens (!wp, !!g, :fr) were already resolved into the
        # search context before plugins run -- they must not leak back into the
        # query the engines receive, or e.g. "!photon paris site:…" would make
        # the engines geocode the literal string "!photon paris" (zero hits).
        engine_query = " ".join(
            part for part in (cleaned_query or "").split() if not part.startswith(("!", ":"))
        ).strip()

        # Update the query in form
        if hasattr(request, 'form') and 'q' in request.form:
            try:
                self._update_form_query(request.form, cleaned_query or original_query)
            except TypeError:
                request.form = self._create_new_form_with_query(request.form, cleaned_query or original_query)

        if hasattr(request, 'args') and 'q' in request.args:
            try:
                self._update_form_query(request.args, cleaned_query or original_query)
            except TypeError:
                pass

        if hasattr(search, 'search_query'):
            # A query that cleans to nothing (a bare "site:example.com",
            # "-word", "filetype:pdf") would make the engines search the
            # literal operator string.  The include-domains are the closest
            # real search term, DDG-style site lookup.
            if not engine_query and syntax['site_include']:
                engine_query = " ".join(syntax['site_include'])
            search.search_query.query = engine_query or original_query

        return True

    @staticmethod
    def _normalize_domain(domain: str) -> str:
        """Normalize domain by removing protocol, path, and port."""
        if not domain:
            return ""
        domain = re.sub(r'^https?://', '', domain).split('/')[0].split(':')[0]
        return domain.lower().strip()

    @staticmethod
    def _domain_matches(result_domain: str, target_domain: str) -> bool:
        """Check if result domain matches target domain (exact or subdomain)."""
        if not result_domain or not target_domain:
            return False
        return result_domain == target_domain or result_domain.endswith('.' + target_domain)

    def _check_site_filters(self, result_url: str, syntax: dict) -> bool:
        """Check if result passes site include/exclude filters.

        Uses pre-computed domain sets for O(1) lookup on exact matches,
        with fallback to subdomain matching.
        """
        if not result_url:
            return not syntax['site_include']

        try:
            result_domain = urlparse(result_url).hostname
            if not result_domain:
                return not syntax['site_include']

            result_domain = result_domain.lower()

            # Check exclude filters using pre-computed set
            if syntax['_site_exclude_set']:
                if result_domain in syntax['_site_exclude_set']:
                    return False
                # Check subdomain match for excluded domains
                if any(result_domain.endswith('.' + d) for d in syntax['_site_exclude_set']):
                    return False

            # Check include filters
            if not syntax['_site_include_set']:
                return True

            if result_domain in syntax['_site_include_set']:
                return True
            # Check subdomain match for included domains
            return any(result_domain.endswith('.' + d) for d in syntax['_site_include_set'])

        except (ValueError, AttributeError):
            return not syntax['site_include']

    def _check_filetype_filter(self, result_url: str, syntax: dict) -> bool:
        """Check if result passes filetype filter."""
        if not syntax['_filetype_set'] or not result_url:
            return True

        try:
            path = urlparse(result_url).path
            # Extract file extension from URL path
            ext_match = _EXT_PATTERN.search(path)
            if not ext_match:
                # No extension — fail if filetype is specified
                return False
            return ext_match.group(1).lower() in syntax['_filetype_set']
        except (ValueError, AttributeError):
            return True

    def _check_date_filters(self, result, syntax: dict) -> bool:
        """Check if result passes date range filters."""
        if not syntax['before_date'] and not syntax['after_date']:
            return True

        pub_date = getattr(result, 'publishedDate', None)
        if not pub_date:
            # No date available — pass through (don't filter out results without dates)
            return True

        if pub_date.tzinfo is None:
            # naive datetimes can't be compared to aware ones (TypeError)
            pub_date = pub_date.replace(tzinfo=timezone.utc)

        if syntax['before_date'] and pub_date >= syntax['before_date']:
            return False
        if syntax['after_date'] and pub_date <= syntax['after_date']:
            return False

        return True

    def _check_positional_filters(self, title: str, content: str, url: str, syntax: dict) -> bool:
        """Check positive and negative positional filters.

        Returns False if any positive filter fails to match, or any negative filter matches.
        Word matchers run against the lowercased field, user regexes against
        the original field; each field is lowercased at most once and only
        when the group actually has filters.
        """
        for keys, field in zip(_POSITIONAL_KEYS, (title, content, url)):
            pos_words = syntax[keys[0]]
            pos_regexes = syntax['_regex_compiled'][keys[1]]
            neg_words = syntax[keys[2]]
            neg_regexes = syntax['_regex_compiled'][keys[3]]
            if not (pos_words or pos_regexes or neg_words or neg_regexes):
                continue
            field_lower = field.lower()

            # Positive filters — all must match
            for matcher in pos_words:
                if not self._matcher_matches(matcher, field_lower):
                    return False
            if not all(c.search(field) for c in pos_regexes):
                return False

            # Negative filters — none should match
            for matcher in neg_words:
                if self._matcher_matches(matcher, field_lower):
                    return False
            if any(c.search(field) for c in neg_regexes):
                return False

        return True

    def _check_exclusion_filters(self, search_text: str, search_text_lower: str, syntax: dict) -> bool:
        """Check exclusion filters (-regexes, -words, exact phrases).

        Returns False if any exclusion pattern matches the search text.
        """
        if any(c.search(search_text) for c in syntax['_regex_compiled']['exclude_regexes']):
            return False

        for matcher in syntax['exclude_words']:
            if self._matcher_matches(matcher, search_text_lower):
                return False

        return True

    def _check_inclusion_filters(self, search_text: str, search_text_lower: str, syntax: dict) -> bool:
        """Check inclusion filters (+regexes, +words, exact phrases, remaining terms).

        Returns False if any required inclusion pattern does NOT match.
        Remaining terms use OR logic: any single term matching is sufficient.
        """
        # +regexes — all must match
        for compiled in syntax['_regex_compiled']['include_regexes']:
            if not compiled.search(search_text):
                return False

        # +words — all must match
        for matcher in syntax['include_words']:
            if not self._matcher_matches(matcher, search_text_lower):
                return False

        # Exact phrases — all must match
        for phrase in syntax['_phrases_lower']:
            if phrase not in search_text_lower:
                return False

        # Remaining terms — OR logic: at least one must match
        remaining = syntax['remaining_terms']
        if remaining and not any(self._matcher_matches(m, search_text_lower) for m in remaining):
            return False

        return True

    def _apply_filters(self, result: Result, syntax: dict) -> bool:
        """Apply all filters to a result.

        Filters are applied in optimal order with short-circuit evaluation:
        1. Site filters (fast domain check)
        2. Filetype filter (URL extension check)
        3. Date filters (temporal check)
        4. Positional filters (title/content/URL)
        5. Exclusion filters
        6. Inclusion filters
        """
        title = getattr(result, 'title', '') or ''
        content = getattr(result, 'content', '') or ''
        url = getattr(result, 'url', '') or ''

        # Short-circuit: apply filters in order of cost/selectivity
        # 1. Site filters (uses pre-computed sets, very fast)
        if (syntax['site_include'] or syntax['site_exclude']):
            if not self._check_site_filters(url, syntax):
                return False

        # 2. Filetype filter
        if syntax['filetypes']:
            if not self._check_filetype_filter(url, syntax):
                return False

        # 3. Date filters
        if syntax['before_date'] or syntax['after_date']:
            if not self._check_date_filters(result, syntax):
                return False

        # 4. Positional filters
        if not self._check_positional_filters(title, content, url, syntax):
            return False

        # 5-6. Build the search text once (only when there is anything to
        # check) -- lowercased once, shared by word matchers and phrases
        has_excl = syntax['exclude_words'] or syntax['_regex_compiled']['exclude_regexes']
        has_incl = (
            syntax['include_words'] or syntax['_regex_compiled']['include_regexes']
            or syntax['_phrases_lower'] or syntax['remaining_terms']
        )
        if has_excl or has_incl:
            search_text = f"{title} {content}"
            search_text_lower = search_text.lower()

            # 5. Exclusion filters
            if has_excl and not self._check_exclusion_filters(search_text, search_text_lower, syntax):
                return False

            # 6. Inclusion filters
            if has_incl and not self._check_inclusion_filters(search_text, search_text_lower, syntax):
                return False

        return True

    def on_result(self, request: SXNG_Request, search: "SearchWithPlugins", result: Result) -> bool:
        """Filter results based on advanced search syntax."""
        if not hasattr(request, 'search_syntax'):
            return True

        syntax = request.search_syntax
        if not syntax.get('has_advanced_syntax', False):
            return True

        return self._apply_filters(result, syntax)

    def post_search(self, request: SXNG_Request, search: "SearchWithPlugins") -> None:
        """Restore original query for UI display after search completion."""
        if hasattr(request, 'original_query') and hasattr(request, 'form'):
            try:
                self._update_form_query(request.form, request.original_query)
            except TypeError:
                request.form = self._create_new_form_with_query(request.form, request.original_query)
