# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The AI stack's ONE document converter: markitdown behind a single
call.  Every byte-to-markdown path rides this module -- the page
reader's cleaned HTML, ``web_reader``'s native PDF reads, the uploaded
attachments (PDF / Word / PPT / Excel) -- so the conversion surface,
its caps and its failure shape are defined once.

The contract is RAISE: :class:`ConvertError` (or anything the upstream
throws, wrapped) travels to the caller, which owns the degradation --
the reader turns it into a :class:`~searx.zjsearch.ai.tools.web_reader.extract.PageReadError`
the model moves on from, the attachment path drops the file silently.
Nothing here retries, logs-as-errors or degrades on its own.
"""

import importlib.util
import io
import typing as t

_CONVERT_MAX_BYTES = 20 * 1024 * 1024
"""The input ceiling -- a PDF bigger than this is not a reading task;
converters can spend minutes on the tail of a huge document."""

_EXTENSIONS: dict[str, str] = {
    # extension -> the mimetype handed to markitdown's converter matching
    # (its StreamInfo routing keys off this first -- a bare file_extension
    # kwarg does NOT steer it in 0.1.8)
    "html": "text/html",
    "htm": "text/html",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "csv": "text/csv",
    "json": "application/json",
    "xml": "application/xml",
    "zip": "application/zip",
    "txt": "text/plain",
    "md": "text/markdown",
}
"""The extensions ``to_markdown`` accepts -- the file kinds the stack
actually ships; markitdown itself knows many more."""

_instance: t.Any = None


class ConvertError(Exception):
    """The document could not be converted -- the message is written for
    the caller's own error surface."""


def missing() -> str | None:
    """The missing package name for the install gate (the browser
    engine's ``engine_missing`` pattern), or ``None`` when markitdown
    imports."""
    if importlib.util.find_spec("markitdown") is None:
        return "markitdown"
    return None


def _converter() -> t.Any:
    """The process-wide MarkItDown instance, built on first use (the
    import is heavy: pdfminer, mammoth, python-pptx, pandas)."""
    global _instance  # pylint: disable=global-statement
    if _instance is None:
        try:
            from markitdown import MarkItDown  # pylint: disable=import-outside-toplevel

            _instance = MarkItDown(enable_plugins=False)
        except Exception as exc:  # pylint: disable=broad-except
            raise ConvertError(f"the markitdown converter is unavailable ({exc})") from exc
    return _instance


def supported(extension: str) -> bool:
    """Whether ``to_markdown`` accepts this extension (the attachment
    path's kind gate)."""
    return str(extension or "").strip().lstrip(".").lower() in _EXTENSIONS


def to_markdown(data: "bytes | str", extension: str) -> str:
    """One document as markdown.  ``data`` is raw bytes or (for HTML) a
    text payload; ``extension`` picks the converter (``html``, ``pdf``,
    ``docx``, ``pptx``, ``xlsx`` ...).  Raises :class:`ConvertError` on
    anything unsupported, oversized or unreadable -- the CALLER owns the
    degradation."""
    extension = str(extension or "").strip().lstrip(".").lower()
    mimetype = _EXTENSIONS.get(extension)
    if mimetype is None:
        raise ConvertError(f"unsupported document kind: {extension!r}")
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not data:
        raise ConvertError("the document is empty")
    if len(data) > _CONVERT_MAX_BYTES:
        raise ConvertError(f"the document is too large ({len(data)} bytes)")
    try:
        from markitdown import StreamInfo  # pylint: disable=import-outside-toplevel

        result = _converter().convert_stream(
            io.BytesIO(data),
            stream_info=StreamInfo(mimetype=mimetype, extension=extension),
        )
    except ConvertError:
        raise
    except Exception as exc:  # pylint: disable=broad-except
        raise ConvertError(f"the document could not be converted ({exc})") from exc
    text = str(getattr(result, "text_content", "") or "").strip()
    if not text:
        raise ConvertError("the document converted to empty markdown")
    return text
