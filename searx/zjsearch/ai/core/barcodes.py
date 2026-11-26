# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The ONE barcode reader: 1D/2D codes (QR / EAN / DataMatrix / ...)
over zxing-cpp, consumed by the browse session's ``decode`` action, the
upload parser and the inspect_image lane.  Vision cannot read code
pixels -- this is how a QR's payload becomes text anywhere an image
enters the run.

OPTIONAL like the calendar engines: an absent zxing-cpp install reads
as ``[]`` and every caller degrades honestly."""

import base64
import io


def available() -> bool:
    """Whether the zxing-cpp backend is importable -- callers that need
    to distinguish "not installed" from "no code in the image" ask here
    first."""
    try:
        import zxingcpp  # noqa: F401  # pylint: disable=import-outside-toplevel,unused-import

        return True
    except ImportError:
        return False


def read_barcodes(data: bytes) -> list[tuple[str, str]]:
    """Decode barcodes in one image's bytes -- ``(format, payload)``
    pairs, ``[]`` when zxing-cpp is absent or nothing decodes.
    ``try_invert`` covers dark-theme codes, ``try_downscale`` small
    renders."""
    try:
        import zxingcpp  # pylint: disable=import-outside-toplevel

        from PIL import Image  # pylint: disable=import-outside-toplevel
    except ImportError:
        return []
    found = zxingcpp.read_barcodes(
        Image.open(io.BytesIO(data)),
        try_invert=True,
        try_downscale=True,
    )
    return [(b.format.name, b.text) for b in found]


def read_data_url(url: str) -> list[tuple[str, str]]:
    """The data-URL variant of :func:`read_barcodes` -- the shape every
    in-run image already travels in (``[]`` on a non-data url)."""
    _, _, b64 = url.partition("base64,")
    if not b64:
        return []
    try:
        return read_barcodes(base64.b64decode(b64))
    except (ValueError, TypeError):
        return []
