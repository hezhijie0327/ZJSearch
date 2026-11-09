# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""openFDA is the FDA's public API over its drug and device databases
(drug labeling, approval records, device clearances and approvals).

The API key is optional: without one the engine rides the per-IP budget
(240 requests/minute, 1,000/day), a free key from the
`authentication docs <https://open.fda.gov/apis/authentication/>`_ raises
the daily budget to 120,000 requests (the key travels as the ``api_key``
query parameter).

.. code:: yaml

  - name: openfda
    engine: openfda
    shortcut: fda
    api_key: ""
    disabled: false

By default the drug labeling database is searched (title = brand/generic
name, snippet = indications for use, link = the DailyMed SPL document).
The other searchable databases each need their own engine entry (a distinct
``name`` / ``shortcut``) selecting the endpoint via :py:obj:`openfda_endpoint`:

.. code:: yaml

  - name: openfda approvals
    engine: openfda
    shortcut: fdaap
    openfda_endpoint: drug/drugsfda

  - name: openfda 510k
    engine: openfda
    shortcut: fdak
    openfda_endpoint: device/510k

  - name: openfda pma
    engine: openfda
    shortcut: fdap
    openfda_endpoint: device/pma
"""

import re
import typing as t
from datetime import datetime
from urllib.parse import urlencode

from dateutil import parser
from searx.exceptions import (
    SearxEngineAccessDeniedException,
    SearxEngineAPIException,
    SearxEngineTooManyRequestsException,
)
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://open.fda.gov",
    "wikidata_id": None,
    "official_api_documentation": "https://open.fda.gov/apis/",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["science"]
paging = True

base_url = "https://api.fda.gov"
api_key = ""
openfda_endpoint = "drug/label"
results_per_page = 10

_DAILYMED_URL = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={setid}"
_DRUGS_AT_FDA_URL = "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo={applno}"
_510K_URL = "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID={knumber}"
_PMA_URL = "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?ID={pmanumber}"


def _first(value) -> str:
    """First item of an openFDA field (most of them are arrays)."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value) if value else ""


def _trim(text: str, limit: int = 400) -> str:
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit].rstrip() + " …"
    return text


def _parse_date(value: str | None, fmt: str | None = None):
    if not value:
        return None
    try:
        return datetime.strptime(value[:10], fmt) if fmt else parser.parse(value)
    except (ValueError, parser.ParserError, OverflowError):
        return None


def _drug_label(r: dict) -> dict | None:
    ofda = r.get("openfda") or {}
    title = _first(ofda.get("brand_name")) or _first(ofda.get("generic_name")) or _first(ofda.get("substance_name"))
    set_id = r.get("set_id") or _first(ofda.get("spl_set_id"))
    if not (title and set_id):
        return None
    content = _first(r.get("indications_and_usage")) or _first(r.get("description")) or ""
    return {
        "title": title,
        "url": _DAILYMED_URL.format(setid=set_id),
        "content": _trim(content),
        "publishedDate": _parse_date(r.get("effective_time"), "%Y%m%d"),
    }


def _drug_approval(r: dict) -> dict | None:
    ofda = r.get("openfda") or {}
    appl = str(r.get("application_number") or "")
    # "ANDA075682" / "N021123" -> "075682" / "021123" (Drugs@FDA ApplNo)
    applno = re.sub(r"^[A-Za-z]+", "", appl).zfill(6)
    sponsor = _first(r.get("sponsor_name"))
    generic = _first(ofda.get("generic_name"))
    title = _first(ofda.get("brand_name")) or generic or sponsor
    if not (title and applno):
        return None
    content = " · ".join(filter(None, [appl, sponsor, generic]))
    return {
        "title": title,
        "url": _DRUGS_AT_FDA_URL.format(applno=applno),
        "content": _trim(content),
        "publishedDate": None,
    }


def _device_510k(r: dict) -> dict | None:
    knumber = r.get("k_number")
    title = r.get("device_name") or _first((r.get("openfda") or {}).get("device_name"))
    if not (knumber and title):
        return None
    content = " · ".join(filter(None, [knumber, _first(r.get("applicant")), _first(r.get("decision_description"))]))
    return {
        "title": title,
        "url": _510K_URL.format(knumber=knumber),
        "content": _trim(content),
        "publishedDate": _parse_date(r.get("decision_date")),
    }


def _device_pma(r: dict) -> dict | None:
    ofda = r.get("openfda") or {}
    pma_number = r.get("pma_number")
    title = r.get("trade_name") or r.get("generic_name") or _first(ofda.get("device_name"))
    if not (pma_number and title):
        return None
    content = " · ".join(filter(None, [pma_number, _first(r.get("applicant")), _first(r.get("decision_code"))]))
    return {
        "title": title,
        "url": _PMA_URL.format(pmanumber=pma_number),
        "content": _trim(content),
        "publishedDate": _parse_date(r.get("decision_date")),
    }


_EXTRACTORS = {
    "drug/label": _drug_label,
    "drug/drugsfda": _drug_approval,
    "device/510k": _device_510k,
    "device/pma": _device_pma,
}


def setup(engine_data: dict[str, t.Any]):
    if openfda_endpoint not in _EXTRACTORS:
        raise ValueError(
            f"openfda_endpoint '{openfda_endpoint}' is not supported"
            f" (one of: {', '.join(sorted(_EXTRACTORS))})"
        )


def request(query: str, params: "OnlineParams"):
    args: dict[str, str | int] = {"search": query, "limit": results_per_page, "skip": (params["pageno"] - 1) * results_per_page}
    if api_key:
        args = {"api_key": api_key, **args}
    params["url"] = f"{base_url}/{openfda_endpoint}.json?{urlencode(args)}"
    # openFDA answers "no matches found!" with a 404 and an unparseable
    # search expression with a 400 -- both must reach response() as a
    # response, not die in the network layer's raise-for-status gate.
    params["raise_for_httperror"] = False


def response(resp: "SXNG_Response") -> EngineResults:
    res = EngineResults()

    if resp.status_code in (400, 404):
        # 404 NOT_FOUND ("No matches found!") is a NORMAL metasearch outcome --
        # openFDA's data is English-only and the query may match no record at
        # all, and a 400 is already a query openFDA rejects outright.
        return res

    try:
        json_resp: dict[str, t.Any] = resp.json()
    except ValueError as exc:
        raise SearxEngineAPIException(f"openFDA: non-JSON response (HTTP {resp.status_code})") from exc

    error = json_resp.get("error")
    if isinstance(error, dict) and error.get("code") == "SERVER_ERROR":
        # openFDA answers a query its Lucene gate cannot tokenize (a stray
        # quote, a bare field: syntax) with HTTP 500 + the SERVER_ERROR
        # envelope -- the API's own parse failure, not an outage.  This
        # engine's page ends silently, the other engines carry the search.
        logger.debug("openFDA: unparseable query -> %s", error.get("details", ""))
        return res

    if error or resp.status_code != 200:
        # the suspension-worthy gates ride searx's own exception ladder (a
        # 429 SUSPENDS the engine for the cooldown so the rate limit is not
        # hammered by every following query); everything else is a plain
        # API error
        if resp.status_code == 429:
            raise SearxEngineTooManyRequestsException()
        if resp.status_code in (402, 403):
            raise SearxEngineAccessDeniedException(message=f"openFDA: HTTP {resp.status_code}")
        code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
        message = error.get("message", "") if isinstance(error, dict) else ""
        raise SearxEngineAPIException(f"openFDA: HTTP {resp.status_code} {code} {message}".rstrip())

    extract = _EXTRACTORS[openfda_endpoint]
    for record in json_resp.get("results") or []:
        result = extract(record)
        if result:
            res.add(res.types.MainResult(**result))

    return res
