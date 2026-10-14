# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ``view_image`` tool: the researcher's EYES on search results.

Result lines carry an ``img=`` token (an image the snippet's page
published).  Text search cannot read a chart -- this tool lets the model
fetch that one image and LOOK at it: the fetch rides the same bridge as
the overview's attachments and the picture is injected into the
conversation as a user turn (dialect-neutral: user turns accept image
parts on every provider).  Registered for every research run -- the
model calls it only when a chart/diagram actually matters."""

import typing as t
from searx.zjsearch.ai.core.text import raw_args

VIEW_IMAGE_TOOL = "view_image"


def view_image_spec() -> dict[str, t.Any]:
    """The ``view_image`` tool spec."""
    return {
        "name": VIEW_IMAGE_TOOL,
        "description": (
            "Look at ONE image from the search results -- charts, diagrams,"
            " product photos, data visuals a snippet cannot show.  Copy the"
            " img= URL from a source line in the feed.  The image becomes"
            " visible to you in the next turn: read it (axes, labels,"
            " numbers) and factor what it shows into the research.  Use it"
            " when a source's picture is the evidence -- never for decorative"
            " photos."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The img= URL from a feed source line, copied verbatim.",
                },
                "n": {
                    "type": "number",
                    "description": "Optional: the [n] of the source the image belongs to.",
                },
            },
            "required": ["url"],
        },
    }


def parse_view_image_call(call: dict[str, t.Any]) -> str:
    """The tool call's image URL -- sanitized (length + scheme gate; the
    SSRF check happens at fetch time)."""
    args = raw_args(call)
    url = str(args.get("url") or "").strip()[:2000]
    return url if url.startswith(("http://", "https://", "data:image/")) else ""
