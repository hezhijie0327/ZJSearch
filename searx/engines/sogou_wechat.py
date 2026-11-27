# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sogou-WeChat search engine for retrieving WeChat Article from Sogou

The dedicated ``weixin.sogou.com/weixin`` endpoint was retired (it answers
with an empty 200 body); WeChat article search now lives on the main domain
at ``/iweixin?tab=weixin_vertical`` -- a single, unpaginated page whose
results are semantic ``<article>`` elements with direct ``mp.weixin.qq.com``
links.
"""

from datetime import datetime
from urllib.parse import urlencode

from lxml import html as lxml_html

from searx.utils import extract_text

# Metadata
about = {
    "website": "https://weixin.sogou.com/",
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}
language = "zh"

# Engine Configuration
categories = ["news"]
paging = False

# Base URL
base_url = "https://www.sogou.com"


def request(query, params):
    query_params = {
        "query": query,
        "tab": "weixin_vertical",
    }

    params["url"] = f"{base_url}/iweixin?{urlencode(query_params)}"
    return params


def response(resp):
    dom = lxml_html.fromstring(resp.text)
    results = []

    for item in dom.xpath('//article'):
        title = extract_text(item.xpath('.//a[1]'))
        url = extract_text(item.xpath('.//a[1]/@href'))

        content = extract_text(item.xpath('.//p[1]'))

        # meta captions: [account name, publish date "YYYY-MM-DD"]
        captions = [c.strip() for c in item.xpath('.//span[contains(@class, "text-yb-caption")]//text()') if c.strip()]
        author = captions[0] if captions else None
        published_date = None
        if len(captions) > 1:
            try:
                published_date = datetime.strptime(captions[1], "%Y-%m-%d")
            except ValueError:
                published_date = None

        if title and url:
            results.append(
                {
                    "title": title,
                    "url": url,
                    "content": content,
                    "author": author,
                    "publishedDate": published_date,
                }
            )

    return results
