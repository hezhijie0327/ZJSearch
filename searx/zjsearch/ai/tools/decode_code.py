# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``decode_code`` tool: 1D/2D barcode payloads from any public
image URL -- WITHOUT viewing the image.

Vision cannot read code pixels: a QR in a search result's picture, a
product's EAN in a listing photo, an invite QR in a screenshot -- the
model sees a code-shaped smudge and can only describe it.  This tool
fetches the image (the same gated fetch inspect_image rides), decodes
it locally and returns the payload as feed TEXT: a url to open, an id
to quote.  The image is never injected -- when the model needs to SEE
the picture it calls inspect_image instead; when it only needs the
payload this is the cheaper, text-only call."""

import typing as t

from searx.zjsearch.ai.core import barcodes
from searx.zjsearch.ai.core.text import raw_args
from searx.zjsearch.ai.runs import attachments as uploads_fetch

DECODE_CODE_TOOL = "decode_code"


def decode_code_spec() -> dict[str, t.Any]:
    """The ``decode_code`` tool spec."""
    return {
        "name": DECODE_CODE_TOOL,
        "description": 'Read 1D/2D barcodes (QR / EAN / DataMatrix / PDF417 / Aztec) in ANY public image URL and get the payload as text -- copy the img= URL from a source line (or any image url in the question) and the decoded content comes straight back in this call\'s result: no image injection, no viewing.  Use this when you only need the code\'s payload (a QR\'s link, a product\'s barcode id); use inspect_image when you need to SEE the picture.',
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The image URL to decode: the img= URL from a feed source line, or any public image url from the question.",
                },
            },
            "required": ["url"],
        },
    }


def parse_decode_code_call(call: dict[str, t.Any]) -> str:
    """The tool call's sanitized image URL (length + scheme gate; the
    SSRF check happens at fetch time)."""
    args = raw_args(call)
    url = str(args.get("url") or "").strip()[:2000]
    if not url.startswith(("http://", "https://")):
        return ""
    return url


def run_call(url: str) -> str:
    """One decode: fetch (the same gated fetch inspect_image rides),
    decode locally, payload as feed text."""
    if not barcodes.available():
        return "error: barcode decoding is not installed on this deployment (pip install zxing-cpp)"
    url = str(url or "").strip()
    if not url:
        return "error: decode_code needs the image URL (img= from a source line, or a public image url)."
    if not uploads_fetch.check_image_url(url):
        return f"error: refusing a non-public image URL: {url[:120]}"
    (fetched,) = uploads_fetch.fetch_image_data_urls([url])
    if not fetched:
        return "error: the image could not be fetched -- move on or re-run the search."
    found = barcodes.read_data_url(fetched)
    if not found:
        return "error: no barcode in this image (decode_code reads QR / EAN / DataMatrix / PDF417 / Aztec -- aim for pictures that actually contain one)."
    if len(found) == 1:
        return f"decoded {found[0][0]}: {found[0][1]}"
    return "decoded:\n" + "\n".join(f"- {fmt}: {text}" for fmt, text in found)
